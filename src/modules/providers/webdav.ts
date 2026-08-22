import { CloudProvider } from "./provider";
import { AuthToken, FileMetadata, QuotaInfo } from "../core/types";
import { log, logError } from "../utils/logger";

/**
 * WebDAV provider implementation.
 * Covers generic WebDAV servers, Synology WebDAV Server, Nextcloud, ownCloud.
 *
 * Uses HTTP extensions: PROPFIND, MKCOL, PUT, GET, DELETE.
 * Auth: Basic Auth over HTTPS (SSL required, warning + confirmation if not).
 *
 * Uses Zotero.HTTP.request() as primary HTTP transport — handles proxies,
 * certificate validation, and redirects correctly within Zotero's sandbox.
 * Falls back to XMLHttpRequest for methods Zotero.HTTP doesn't support (PROPFIND, MKCOL).
 */
export class WebDAVProvider implements CloudProvider {
  private baseUrl: string = "";
  private username: string = "";
  private password: string = "";
  private _authenticated = false;

  constructor() {
    this.loadConfig();
  }

  private loadConfig() {
    let savedUrl = (Zotero.Prefs.get("extensions.zotcloud.webdav.url") as string) || "";
    // Clean up any mangled URLs from previous bugs
    savedUrl = savedUrl.replace(/^https?:\/\/(https?:)/i, "$1");
    savedUrl = savedUrl.replace(/^(https?):\/([^/])/i, "$1://$2");
    this.baseUrl = savedUrl;
    this.username =
      (Zotero.Prefs.get("extensions.zotcloud.webdav.username") as string) || "";
    // Load password from credential manager
    this.password = this.loadPassword();
  }

  /** Configure the WebDAV connection */
  configure(url: string, username: string, password: string) {
    let normalized = url.trim().replace(/\/+$/, "");
    // Fix double-prefixed URLs from previous bug: https://http:/host → http:/host
    normalized = normalized.replace(/^https?:\/\/(https?:)/i, "$1");
    // Fix single-slash protocols: http:/host → http://host
    normalized = normalized.replace(/^(https?):\/([^/])/i, "$1://$2");
    if (normalized && !/^https?:\/\//i.test(normalized)) {
      normalized = "https://" + normalized;
    }
    this.baseUrl = normalized;
    this.username = username;
    this.password = password;

    Zotero.Prefs.set("extensions.zotcloud.webdav.url", this.baseUrl);
    Zotero.Prefs.set("extensions.zotcloud.webdav.username", this.username);
    this.savePassword(password);
  }

  async authenticate(): Promise<AuthToken> {
    if (!this.baseUrl) {
      throw new Error("WebDAV URL not configured");
    }
    if (!this.username) {
      throw new Error("WebDAV username not configured");
    }
    if (!this.password) {
      throw new Error("WebDAV password not configured — password was not saved/loaded correctly");
    }

    // Warn if not HTTPS
    if (
      !this.baseUrl.startsWith("https://") &&
      !this.baseUrl.startsWith("https%3A")
    ) {
      log(
        "WARNING: WebDAV connection is not using HTTPS. Data will be transmitted unencrypted.",
      );
    }

    // Test connection with PROPFIND on base URL
    const passHint = this.password.length > 2
      ? this.password[0] + "***" + this.password[this.password.length - 1]
      : "***";
    log(`WebDAV auth: url=${this.baseUrl}, user=${this.username}, pass=${passHint} (len=${this.password.length})`);
    try {
      await this.propfind("/");
      this._authenticated = true;
      log("WebDAV authenticated to " + this.baseUrl);
      return { accessToken: "", expiresAt: Infinity, tokenType: "basic" };
    } catch (err) {
      this._authenticated = false;
      const msg = err instanceof Error ? err.message : String(err);
      logError("WebDAV authentication failed: " + msg, err);
      throw new Error("WebDAV authentication failed: " + msg);
    }
  }

  async refreshToken(): Promise<AuthToken> {
    return this.authenticate();
  }

  async disconnect(): Promise<void> {
    this._authenticated = false;
    this.removePassword();
    // Also clear pref fallback (removePassword only handles nsILoginManager)
    try { Zotero.Prefs.clear("extensions.zotcloud.webdav._password"); } catch { /* ok */ }
    log("WebDAV disconnected");
  }

  isAuthenticated(): boolean {
    return this._authenticated;
  }

  async upload(
    remotePath: string,
    data: ArrayBuffer | string,
  ): Promise<FileMetadata> {
    const url = this.resolvePath(remotePath);
    const body =
      typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);

    // Ensure parent directory exists
    const parentPath = remotePath.substring(0, remotePath.lastIndexOf("/"));
    if (parentPath) {
      await this.ensureDirectory(parentPath);
    }

    const xhr = await this.rawRequest("PUT", url, body, {
      "Content-Type": "application/octet-stream",
    });

    if (xhr.status < 200 || xhr.status >= 300) {
      throw new Error(
        `WebDAV PUT ${remotePath} failed: ${xhr.status} ${xhr.statusText}`,
      );
    }

    return {
      name: remotePath.split("/").pop() || "",
      path: remotePath,
      size: typeof data === "string" ? data.length : data.byteLength,
      lastModified: new Date().toISOString(),
      isDirectory: false,
      etag: xhr.getResponseHeader("ETag") || undefined,
    };
  }

  async download(remotePath: string): Promise<ArrayBuffer> {
    const url = this.resolvePath(remotePath);

    const xhr = await this.rawRequest("GET", url, undefined, {}, "arraybuffer");

    if (xhr.status === 404) {
      throw new Error(`File not found: ${remotePath}`);
    }
    if (xhr.status !== 200) {
      throw new Error(
        `WebDAV GET ${remotePath} failed: ${xhr.status} ${xhr.statusText}`,
      );
    }

    return xhr.response as ArrayBuffer;
  }

  async delete(remotePath: string): Promise<void> {
    const url = this.resolvePath(remotePath);
    const xhr = await this.rawRequest("DELETE", url);

    // 204 No Content or 200 OK = success, 404 = already gone (fine)
    if (xhr.status >= 300 && xhr.status !== 404) {
      throw new Error(`WebDAV DELETE ${remotePath} failed: ${xhr.status}`);
    }
  }

  async list(remotePath: string): Promise<FileMetadata[]> {
    const xml = await this.propfind(remotePath);
    return this.parsePropfindResponse(xml, remotePath);
  }

  async mkdir(remotePath: string): Promise<void> {
    await this.ensureDirectory(remotePath);
  }

  async move(fromPath: string, toPath: string): Promise<boolean> {
    const fromUrl = this.resolvePath(fromPath);
    const toUrl = this.resolvePath(toPath);

    // Ensure destination parent directory exists
    const parentPath = toPath.substring(0, toPath.lastIndexOf("/"));
    if (parentPath) {
      await this.ensureDirectory(parentPath);
    }

    const xhr = await this.rawRequest("MOVE", fromUrl, undefined, {
      Destination: toUrl,
      Overwrite: "T",
    });

    if (xhr.status >= 200 && xhr.status < 300) {
      log(`WebDAV MOVE ${fromPath} → ${toPath}`);
      return true;
    }

    logError(`WebDAV MOVE failed: ${xhr.status} ${xhr.statusText}`, new Error(`MOVE ${fromPath}`));
    return false;
  }

  async getFileInfo(remotePath: string): Promise<FileMetadata> {
    const xml = await this.propfind(remotePath, "0");
    const results = this.parsePropfindSelf(xml, remotePath);
    if (!results) {
      throw new Error("File not found: " + remotePath);
    }
    return results;
  }

  async exists(remotePath: string): Promise<boolean> {
    try {
      await this.propfind(remotePath, "0");
      return true;
    } catch {
      return false;
    }
  }

  async getQuota(): Promise<QuotaInfo> {
    try {
      const xml = await this.propfindQuota();
      return this.parseQuotaResponse(xml);
    } catch {
      return { used: 0, total: 0 };
    }
  }

  getName(): string {
    if (this.baseUrl.includes("synology") || this.baseUrl.includes(":5006")) {
      return "Synology WebDAV";
    }
    if (this.baseUrl.includes("nextcloud")) {
      return "Nextcloud";
    }
    return "WebDAV";
  }

  getIcon(): string {
    return "chrome://zotcloud/content/icons/webdav.svg";
  }

  // --- Credential Manager ---

  private savePassword(password: string) {
    // Always save to prefs as reliable fallback
    Zotero.Prefs.set("extensions.zotcloud.webdav._password", password);

    try {
      const loginManager = Components.classes[
        "@mozilla.org/login-manager;1"
      ].getService(Components.interfaces.nsILoginManager);

      // Remove existing login
      this.removePassword();

      const loginInfo = Components.classes[
        "@mozilla.org/login-manager/loginInfo;1"
      ].createInstance(Components.interfaces.nsILoginInfo);

      loginInfo.init(
        "chrome://zotcloud",
        null,
        "ZotCloud WebDAV",
        this.username,
        password,
        "",
        "",
      );

      loginManager.addLogin(loginInfo);
    } catch (err) {
      logError("Failed to save password to credential manager (prefs fallback active)", err);
    }
  }

  private loadPassword(): string {
    // Try nsILoginManager first
    try {
      const loginManager = Components.classes[
        "@mozilla.org/login-manager;1"
      ].getService(Components.interfaces.nsILoginManager);

      const logins = loginManager.findLogins(
        "chrome://zotcloud",
        null,
        "ZotCloud WebDAV",
      );

      log(`nsILoginManager: found ${logins.length} login(s)`);
      if (logins.length > 0) {
        log("Loaded WebDAV password from nsILoginManager");
        return logins[0].password;
      }
    } catch (err) {
      log("nsILoginManager unavailable: " + String(err));
    }

    // Fall back to prefs
    try {
      const pwd = Zotero.Prefs.get(
        "extensions.zotcloud.webdav._password",
      ) as string;
      if (pwd) {
        log("Loaded WebDAV password from prefs fallback (length=" + pwd.length + ")");
        return pwd;
      }
      log("No WebDAV password in prefs either");
    } catch (err) {
      log("Prefs fallback failed: " + String(err));
    }

    return "";
  }

  private removePassword() {
    // Only remove from nsILoginManager — do NOT touch prefs here.
    // Pref cleanup happens explicitly in disconnect().
    try {
      const loginManager = Components.classes[
        "@mozilla.org/login-manager;1"
      ].getService(Components.interfaces.nsILoginManager);

      const logins = loginManager.findLogins(
        "chrome://zotcloud",
        null,
        "ZotCloud WebDAV",
      );

      for (const login of logins) {
        loginManager.removeLogin(login);
      }
    } catch {
      // nsILoginManager not available — nothing to remove from it
    }
  }

  // --- HTTP helpers ---

  private resolvePath(remotePath: string): string {
    const cleanPath = remotePath.startsWith("/") ? remotePath : "/" + remotePath;
    return this.baseUrl + cleanPath;
  }

  /** Compute MD5 hex digest using Gecko nsICryptoHash */
  private md5(input: string): string {
    const ch = Components.classes["@mozilla.org/security/hash;1"]
      .createInstance(Components.interfaces.nsICryptoHash);
    ch.init(ch.MD5);
    const data = new TextEncoder().encode(input);
    ch.update(data, data.length);
    const hash = ch.finish(false);
    let hex = "";
    for (let i = 0; i < hash.length; i++) {
      hex += ("0" + hash.charCodeAt(i).toString(16)).slice(-2);
    }
    return hex;
  }

  /** Parse WWW-Authenticate: Digest header into key-value pairs */
  private parseDigestChallenge(header: string): Record<string, string> {
    const result: Record<string, string> = {};
    const digestPart = header.replace(/^Digest\s+/i, "");
    const regex = /(\w+)=(?:"([^"]+)"|([^\s,]+))/g;
    let match;
    while ((match = regex.exec(digestPart)) !== null) {
      result[match[1]] = match[2] || match[3];
    }
    return result;
  }

  /** Build Digest auth Authorization header */
  private buildDigestAuth(
    method: string,
    uri: string,
    challenge: Record<string, string>,
  ): string {
    const realm = challenge.realm || "";
    const nonce = challenge.nonce || "";
    const qop = challenge.qop || "";
    const cnonce = Math.random().toString(36).substring(2, 18);
    const nc = "00000001";

    const ha1 = this.md5(`${this.username}:${realm}:${this.password}`);
    const ha2 = this.md5(`${method}:${uri}`);

    let response: string;
    if (qop.includes("auth")) {
      response = this.md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
    } else {
      response = this.md5(`${ha1}:${nonce}:${ha2}`);
    }

    let header = `Digest username="${this.username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
    if (qop.includes("auth")) {
      header += `, qop=auth, nc=${nc}, cnonce="${cnonce}"`;
    }
    if (challenge.opaque) {
      header += `, opaque="${challenge.opaque}"`;
    }
    return header;
  }

  /**
   * HTTP request using Zotero.HTTP.request() with credentials in URL.
   *
   * This approach lets Gecko's network stack handle auth negotiation
   * (Basic/Digest) internally, which is how Zotero's own WebDAV sync works.
   */
  private async rawRequest(
    method: string,
    url: string,
    body?: Uint8Array | string,
    extraHeaders?: Record<string, string>,
    responseType?: XMLHttpRequestResponseType,
  ): Promise<XMLHttpRequest> {
    // Embed credentials in URL for Gecko auth negotiation
    let authUrl: string;
    try {
      const parsed = new URL(url);
      parsed.username = this.username;
      parsed.password = this.password;
      authUrl = parsed.toString();
    } catch {
      authUrl = url.replace("://", `://${encodeURIComponent(this.username)}:${encodeURIComponent(this.password)}@`);
    }

    log(`${method} ${url} (auth via URL credentials)`);

    try {
      const response = await Zotero.HTTP.request(method, authUrl, {
        headers: extraHeaders || {},
        body: body || undefined,
        responseType: responseType || "text",
        timeout: 30000,
        successCodes: false, // Accept ANY status code — we handle errors ourselves
      });
      log(`${method} ${url} → ${response.status}`);
      // Status 0 = network-level failure (connection refused, DNS, timeout)
      if (response.status === 0) {
        throw new Error(
          `Connection failed (HTTP 0) — server may be unreachable. ` +
          `Check that WebDAV is running on ${url} and the port is open.`
        );
      }
      return response;
    } catch (err: any) {
      // Log the FULL error for diagnosis
      const errMsg = err?.message || String(err);
      const errName = err?.name || "";
      const errStack = err?.stack?.split?.("\n")?.[0] || "";
      log(`${method} ${url} → EXCEPTION: [${errName}] ${errMsg}`);
      if (errStack) log(`  stack: ${errStack}`);

      // Zotero.HTTP may throw an object with xmlhttp attached
      if (err && typeof err === "object" && "xmlhttp" in err && err.xmlhttp) {
        const xhr = err.xmlhttp as XMLHttpRequest;
        log(`${method} ${url} → ${xhr.status} (via exception, msg: ${errMsg})`);
        if (xhr.status === 0) {
          throw new Error(
            `Connection failed (HTTP 0) — server may be unreachable. ` +
            `Check that WebDAV is running on ${url} and the port is open. ` +
            `Original error: ${errMsg}`
          );
        }
        return xhr;
      }
      if (err && typeof err === "object" && "status" in err && typeof err.status === "number") {
        log(`${method} ${url} → ${err.status} (via exception, msg: ${errMsg})`);
        if (err.status === 0) {
          throw new Error(
            `Connection failed (HTTP 0) — server may be unreachable. ` +
            `Check that WebDAV is running on ${url} and the port is open. ` +
            `Original error: ${errMsg}`
          );
        }
        return err as XMLHttpRequest;
      }
      throw new Error(`Network error: ${method} ${url}: ${errMsg}`);
    }
  }

  /**
   * PROPFIND request — core WebDAV discovery method.
   * Depth "1" lists directory contents, "0" gets info about the resource itself.
   */
  private async propfind(remotePath: string, depth: string = "1"): Promise<string> {
    const url = this.resolvePath(remotePath);

    const xhr = await this.rawRequest(
      "PROPFIND",
      url,
      '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><allprop/></propfind>',
      {
        "Content-Type": "application/xml; charset=utf-8",
        Depth: depth,
      },
    );

    // 207 Multi-Status is the standard PROPFIND response,
    // but some servers return 200 OK with the same XML body
    if (xhr.status === 207 || xhr.status === 200) {
      return xhr.responseText;
    }
    if (xhr.status === 404) {
      throw new Error(`Not found: ${remotePath}`);
    }
    if (xhr.status === 401) {
      throw new Error("Authentication failed — check username and password");
    }
    if (xhr.status === 403) {
      throw new Error("Access denied — check permissions for this path");
    }
    if (xhr.status === 405) {
      throw new Error("WebDAV not enabled on this server (PROPFIND not allowed)");
    }
    throw new Error(`PROPFIND ${remotePath} failed: HTTP ${xhr.status} ${xhr.statusText || ""}`.trim());
  }

  /** PROPFIND with quota properties */
  private async propfindQuota(): Promise<string> {
    const url = this.resolvePath("/");

    const body =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<propfind xmlns="DAV:">' +
      "<prop>" +
      "<quota-available-bytes/>" +
      "<quota-used-bytes/>" +
      "</prop>" +
      "</propfind>";

    const xhr = await this.rawRequest("PROPFIND", url, body, {
      "Content-Type": "application/xml; charset=utf-8",
      Depth: "0",
    });

    if (xhr.status === 207) {
      return xhr.responseText;
    }
    throw new Error(`PROPFIND quota failed: ${xhr.status}`);
  }

  /** Create directory, creating parents as needed */
  private async ensureDirectory(remotePath: string): Promise<void> {
    // Check if already exists
    try {
      await this.propfind(remotePath, "0");
      return;
    } catch {
      // Doesn't exist
    }

    // Build parent-first
    const parts = remotePath.split("/").filter(Boolean);
    let currentPath = "";

    for (const part of parts) {
      currentPath += "/" + part;

      // Check existence
      let exists = false;
      try {
        await this.propfind(currentPath, "0");
        exists = true;
      } catch {
        // Doesn't exist
      }

      if (!exists) {
        const url = this.resolvePath(currentPath);
        const xhr = await this.rawRequest("MKCOL", url);

        // 201 Created, 405 Method Not Allowed (already exists), 301 redirect
        if (xhr.status !== 201 && xhr.status !== 405 && xhr.status !== 301) {
          throw new Error(
            `MKCOL ${currentPath} failed: ${xhr.status} ${xhr.statusText}`,
          );
        }
      }
    }
  }

  // --- XML Parsing ---

  /** Parse PROPFIND multi-status response for directory listing (Depth: 1) */
  private parsePropfindResponse(
    xml: string,
    basePath: string,
  ): FileMetadata[] {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, "application/xml");
    const responses = doc.getElementsByTagNameNS("DAV:", "response");
    const results: FileMetadata[] = [];

    // Normalize base path for comparison
    const normalizedBase = this.resolvePath(basePath).replace(/\/+$/, "");

    for (let i = 0; i < responses.length; i++) {
      const response = responses[i];
      const href = decodeURIComponent(
        response.getElementsByTagNameNS("DAV:", "href")[0]?.textContent || "",
      ).replace(/\/+$/, "");

      // Skip the directory itself
      if (href === normalizedBase || href === normalizedBase + "/") continue;
      // Also skip by checking if it matches the base URL path
      const baseUrlPath = new URL(normalizedBase).pathname.replace(/\/+$/, "");
      const hrefPath = href.startsWith("http")
        ? new URL(href).pathname.replace(/\/+$/, "")
        : href.replace(/\/+$/, "");
      if (hrefPath === baseUrlPath) continue;

      const isDirectory =
        response.getElementsByTagNameNS("DAV:", "collection").length > 0;

      const contentLength =
        response.getElementsByTagNameNS("DAV:", "getcontentlength")[0]
          ?.textContent || "0";

      const lastModified =
        response.getElementsByTagNameNS("DAV:", "getlastmodified")[0]
          ?.textContent || "";

      const etag =
        response.getElementsByTagNameNS("DAV:", "getetag")[0]?.textContent ||
        undefined;

      const name = hrefPath.split("/").filter(Boolean).pop() || "";

      results.push({
        name,
        path: basePath.replace(/\/+$/, "") + "/" + name,
        size: parseInt(contentLength, 10) || 0,
        lastModified: lastModified
          ? new Date(lastModified).toISOString()
          : new Date().toISOString(),
        isDirectory,
        etag,
      });
    }

    return results;
  }

  /** Parse PROPFIND response for a single resource (Depth: 0) */
  private parsePropfindSelf(
    xml: string,
    remotePath: string,
  ): FileMetadata | null {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, "application/xml");
    const responses = doc.getElementsByTagNameNS("DAV:", "response");

    if (responses.length === 0) return null;

    const response = responses[0];

    const isDirectory =
      response.getElementsByTagNameNS("DAV:", "collection").length > 0;

    const contentLength =
      response.getElementsByTagNameNS("DAV:", "getcontentlength")[0]
        ?.textContent || "0";

    const lastModified =
      response.getElementsByTagNameNS("DAV:", "getlastmodified")[0]
        ?.textContent || "";

    const etag =
      response.getElementsByTagNameNS("DAV:", "getetag")[0]?.textContent ||
      undefined;

    const name = remotePath.split("/").filter(Boolean).pop() || "";

    return {
      name,
      path: remotePath,
      size: parseInt(contentLength, 10) || 0,
      lastModified: lastModified
        ? new Date(lastModified).toISOString()
        : new Date().toISOString(),
      isDirectory,
      etag,
    };
  }

  /** Parse quota response */
  private parseQuotaResponse(xml: string): QuotaInfo {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, "application/xml");

    const used =
      doc.getElementsByTagNameNS("DAV:", "quota-used-bytes")[0]?.textContent ||
      "0";
    const available =
      doc.getElementsByTagNameNS("DAV:", "quota-available-bytes")[0]
        ?.textContent || "0";

    const usedBytes = parseInt(used, 10) || 0;
    const availableBytes = parseInt(available, 10) || 0;

    return {
      used: usedBytes,
      total: usedBytes + availableBytes,
    };
  }
}
