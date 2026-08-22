import { CloudProvider } from "./provider";
import { AuthToken, FileMetadata, QuotaInfo } from "../core/types";
import {
  OAuthConfig,
  startOAuthFlow,
  storeTokens,
  loadTokens,
  removeTokens,
} from "./oauth-helper";
import { log } from "../utils/logger";

/**
 * pCloud provider.
 * Uses pCloud REST API with OAuth 2.0.
 * Dual datacenter: api.pcloud.com (US) / eapi.pcloud.com (EU).
 * The correct endpoint is determined at authentication time.
 */

export class PCloudProvider implements CloudProvider {
  private token: AuthToken | null = null;
  private apiBase: string = "https://api.pcloud.com";

  private readonly oauthConfig: OAuthConfig = {
    providerName: "pCloud",
    authUrl: "https://my.pcloud.com/oauth2/authorize",
    tokenUrl: "https://api.pcloud.com/oauth2_token",
    clientId: "",
    clientSecret: "",
    scopes: [],
    redirectPort: 23122,
    usePKCE: false,
  };

  setCredentials(clientId: string, clientSecret: string) {
    this.oauthConfig.clientId = clientId;
    this.oauthConfig.clientSecret = clientSecret;
    Zotero.Prefs.set("extensions.zotcloud.pcloud.clientId", clientId);
    Zotero.Prefs.set("extensions.zotcloud.pcloud.clientSecret", clientSecret);
  }

  async authenticate(): Promise<AuthToken> {
    this.oauthConfig.clientId =
      (Zotero.Prefs.get("extensions.zotcloud.pcloud.clientId") as string) || "";
    this.oauthConfig.clientSecret =
      (Zotero.Prefs.get("extensions.zotcloud.pcloud.clientSecret") as string) || "";

    if (!this.oauthConfig.clientId) {
      throw new Error("pCloud app key not configured. Create an app at docs.pcloud.com");
    }

    const stored = loadTokens("pCloud");
    if (stored && stored.expiresAt > Date.now() + 60000) {
      this.token = stored;
      await this.detectDatacenter();
      return stored;
    }

    this.token = await startOAuthFlow(this.oauthConfig);
    storeTokens("pCloud", this.token);
    await this.detectDatacenter();
    log("pCloud: authenticated");
    return this.token;
  }

  async refreshToken(): Promise<AuthToken> {
    // pCloud tokens don't expire (lifetime), but reconnect if needed
    return this.authenticate();
  }

  async disconnect(): Promise<void> {
    removeTokens("pCloud");
    this.token = null;
  }

  isAuthenticated(): boolean {
    return this.token !== null;
  }

  async upload(remotePath: string, data: ArrayBuffer | string): Promise<FileMetadata> {
    await this.ensureAuth();

    const parentPath = remotePath.substring(0, remotePath.lastIndexOf("/"));
    const fileName = remotePath.split("/").pop() || "";

    // Ensure parent folder exists
    await this.mkdir(parentPath);

    const body = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);

    const formData = new FormData();
    formData.append("file", new Blob([body]), fileName);

    const response = await fetch(
      `${this.apiBase}/uploadfile?path=${encodeURIComponent(parentPath)}&filename=${encodeURIComponent(fileName)}&nopartial=1`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token!.accessToken}` },
        body: formData,
      },
    );

    const result = await response.json();
    if (result.error) {
      throw new Error(`pCloud upload failed: ${result.error}`);
    }

    const meta = result.metadata?.[0] || {};
    return {
      name: meta.name || fileName,
      path: remotePath,
      size: meta.size || 0,
      lastModified: meta.modified || new Date().toISOString(),
      isDirectory: meta.isfolder || false,
    };
  }

  async download(remotePath: string): Promise<ArrayBuffer> {
    await this.ensureAuth();

    // Get file link first
    const linkResp = await this.api("getfilelink", { path: remotePath });
    const linkData = await linkResp.json();

    if (linkData.error) {
      throw new Error(`pCloud download failed: ${linkData.error}`);
    }

    const downloadUrl = `https://${linkData.hosts[0]}${linkData.path}`;
    const response = await fetch(downloadUrl);
    return response.arrayBuffer();
  }

  async delete(remotePath: string): Promise<void> {
    await this.ensureAuth();
    try {
      // Try file delete first, then folder
      const resp = await this.api("deletefile", { path: remotePath });
      const data = await resp.json();
      if (data.error === 2005) {
        // It's a folder
        await this.api("deletefolderrecursive", { path: remotePath });
      }
    } catch { /* may not exist */ }
  }

  async list(remotePath: string): Promise<FileMetadata[]> {
    await this.ensureAuth();
    const response = await this.api("listfolder", { path: remotePath });
    const data = await response.json();

    if (data.error) {
      throw new Error(`pCloud list failed: ${data.error}`);
    }

    return (data.metadata?.contents || []).map((item: any) => ({
      name: item.name,
      path: `${remotePath}/${item.name}`,
      size: item.size || 0,
      lastModified: item.modified || new Date().toISOString(),
      isDirectory: item.isfolder || false,
    }));
  }

  async move(fromPath: string, toPath: string): Promise<boolean> {
    await this.ensureAuth();

    // Ensure destination folder exists
    const parentPath = toPath.substring(0, toPath.lastIndexOf("/"));
    await this.mkdir(parentPath);

    const newName = toPath.split("/").pop() || "";
    const resp = await this.api("renamefile", {
      path: fromPath,
      topath: toPath,
      toname: newName,
    });
    const data = await resp.json();
    return !data.error;
  }

  async mkdir(remotePath: string): Promise<void> {
    await this.ensureAuth();
    try {
      await this.api("createfolderifnotexists", { path: remotePath });
    } catch { /* may already exist */ }
  }

  async getFileInfo(remotePath: string): Promise<FileMetadata> {
    await this.ensureAuth();
    const response = await this.api("stat", { path: remotePath });
    const data = await response.json();

    if (data.error) throw new Error(`Not found: ${remotePath}`);

    return {
      name: data.metadata?.name || "",
      path: remotePath,
      size: data.metadata?.size || 0,
      lastModified: data.metadata?.modified || new Date().toISOString(),
      isDirectory: data.metadata?.isfolder || false,
    };
  }

  async exists(remotePath: string): Promise<boolean> {
    try {
      await this.getFileInfo(remotePath);
      return true;
    } catch {
      return false;
    }
  }

  async getQuota(): Promise<QuotaInfo> {
    await this.ensureAuth();
    const response = await this.api("userinfo", {});
    const data = await response.json();
    return {
      used: data.usedquota || 0,
      total: data.quota || 0,
    };
  }

  getName(): string { return "pCloud"; }
  getIcon(): string { return "chrome://zotcloud/content/icons/pcloud.svg"; }

  private async ensureAuth(): Promise<void> {
    if (!this.token) await this.authenticate();
  }

  /** Detect US vs EU datacenter */
  private async detectDatacenter(): Promise<void> {
    try {
      const response = await fetch(
        `https://api.pcloud.com/userinfo?access_token=${this.token!.accessToken}`,
      );
      const data = await response.json();

      if (data.error === 2000) {
        // Token is for EU datacenter
        this.apiBase = "https://eapi.pcloud.com";
        log("pCloud: using EU datacenter");
      } else {
        this.apiBase = "https://api.pcloud.com";
        log("pCloud: using US datacenter");
      }
    } catch {
      this.apiBase = "https://api.pcloud.com";
    }
  }

  private async api(
    method: string,
    params: Record<string, string>,
  ): Promise<Response> {
    const query = new URLSearchParams(params).toString();
    return fetch(`${this.apiBase}/${method}?${query}`, {
      headers: { Authorization: `Bearer ${this.token!.accessToken}` },
    });
  }
}
