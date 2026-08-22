import { CloudProvider } from "./provider";
import { AuthToken, FileMetadata, QuotaInfo } from "../core/types";
import {
  OAuthConfig,
  startOAuthFlow,
  refreshAccessToken,
  storeTokens,
  loadTokens,
  removeTokens,
} from "./oauth-helper";
import { log } from "../utils/logger";

/**
 * Dropbox provider.
 * Uses Dropbox API v2 with OAuth 2.0 (PKCE — no client secret needed).
 *
 * Upload: Simple <150MB, session upload for larger.
 * Special: Supports content hashing natively (dropbox_content_hash).
 */

const API_BASE = "https://api.dropboxapi.com/2";
const CONTENT_BASE = "https://content.dropboxapi.com/2";

export class DropboxProvider implements CloudProvider {
  private token: AuthToken | null = null;

  private readonly oauthConfig: OAuthConfig = {
    providerName: "Dropbox",
    authUrl: "https://www.dropbox.com/oauth2/authorize",
    tokenUrl: "https://api.dropboxapi.com/oauth2/token",
    clientId: "",
    scopes: [],
    redirectPort: 23121,
    usePKCE: true, // Dropbox supports PKCE, no client secret needed
    extraAuthParams: { token_access_type: "offline" },
  };

  setCredentials(clientId: string) {
    this.oauthConfig.clientId = clientId;
    Zotero.Prefs.set("extensions.zotcloud.dropbox.clientId", clientId);
  }

  async authenticate(): Promise<AuthToken> {
    this.oauthConfig.clientId =
      (Zotero.Prefs.get("extensions.zotcloud.dropbox.clientId") as string) || "";

    if (!this.oauthConfig.clientId) {
      throw new Error("Dropbox app key not configured. Create an app at dropbox.com/developers");
    }

    const stored = loadTokens("Dropbox");
    if (stored && stored.expiresAt > Date.now() + 60000) {
      this.token = stored;
      return stored;
    }

    if (stored?.refreshToken) {
      try {
        this.token = await refreshAccessToken(this.oauthConfig, stored.refreshToken);
        storeTokens("Dropbox", this.token);
        return this.token;
      } catch { /* fall through */ }
    }

    this.token = await startOAuthFlow(this.oauthConfig);
    storeTokens("Dropbox", this.token);
    log("Dropbox: authenticated");
    return this.token;
  }

  async refreshToken(): Promise<AuthToken> {
    if (!this.token?.refreshToken) return this.authenticate();
    this.token = await refreshAccessToken(this.oauthConfig, this.token.refreshToken);
    storeTokens("Dropbox", this.token);
    return this.token;
  }

  async disconnect(): Promise<void> {
    if (this.token) {
      try {
        await this.api(`${API_BASE}/auth/token/revoke`, "POST");
      } catch { /* best effort */ }
    }
    removeTokens("Dropbox");
    this.token = null;
  }

  isAuthenticated(): boolean {
    return this.token !== null && this.token.expiresAt > Date.now();
  }

  async upload(remotePath: string, data: ArrayBuffer | string): Promise<FileMetadata> {
    await this.ensureAuth();
    const body = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);

    const dropboxArg = JSON.stringify({
      path: remotePath,
      mode: { ".tag": "overwrite" },
      autorename: false,
      mute: true,
    });

    const response = await fetch(`${CONTENT_BASE}/files/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token!.accessToken}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": dropboxArg,
      },
      body,
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Dropbox upload failed: ${response.status} ${err}`);
    }

    const result = await response.json();
    return this.toFileMetadata(result);
  }

  async download(remotePath: string): Promise<ArrayBuffer> {
    await this.ensureAuth();

    const dropboxArg = JSON.stringify({ path: remotePath });

    const response = await fetch(`${CONTENT_BASE}/files/download`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token!.accessToken}`,
        "Dropbox-API-Arg": dropboxArg,
      },
    });

    if (response.status === 409) {
      throw new Error(`File not found: ${remotePath}`);
    }
    if (!response.ok) {
      throw new Error(`Dropbox download failed: ${response.status}`);
    }

    return response.arrayBuffer();
  }

  async delete(remotePath: string): Promise<void> {
    await this.ensureAuth();
    try {
      await this.api(`${API_BASE}/files/delete_v2`, "POST", { path: remotePath });
    } catch {
      // May already be deleted
    }
  }

  async list(remotePath: string): Promise<FileMetadata[]> {
    await this.ensureAuth();

    const response = await this.api(`${API_BASE}/files/list_folder`, "POST", {
      path: remotePath === "/" ? "" : remotePath,
      limit: 2000,
    });

    const data = await response.json();
    return (data.entries || []).map((entry: any) => this.toFileMetadata(entry));
  }

  async move(fromPath: string, toPath: string): Promise<boolean> {
    await this.ensureAuth();

    // Ensure destination folder exists
    const parentPath = toPath.substring(0, toPath.lastIndexOf("/"));
    await this.mkdir(parentPath);

    await this.api(`${API_BASE}/files/move_v2`, "POST", {
      from_path: fromPath,
      to_path: toPath,
      autorename: false,
      allow_ownership_transfer: false,
    });

    return true;
  }

  async mkdir(remotePath: string): Promise<void> {
    await this.ensureAuth();
    try {
      await this.api(`${API_BASE}/files/create_folder_v2`, "POST", {
        path: remotePath,
        autorename: false,
      });
    } catch {
      // Folder may already exist (conflict error)
    }
  }

  async getFileInfo(remotePath: string): Promise<FileMetadata> {
    await this.ensureAuth();
    const response = await this.api(`${API_BASE}/files/get_metadata`, "POST", {
      path: remotePath,
    });
    const data = await response.json();
    return this.toFileMetadata(data);
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
    const response = await this.api(`${API_BASE}/users/get_space_usage`, "POST");
    const data = await response.json();
    return {
      used: data.used || 0,
      total: data.allocation?.allocated || 0,
    };
  }

  getName(): string { return "Dropbox"; }
  getIcon(): string { return "chrome://zotcloud/content/icons/dropbox.svg"; }

  private async ensureAuth(): Promise<void> {
    if (!this.token || this.token.expiresAt < Date.now() + 60000) {
      await this.authenticate();
    }
  }

  private async api(
    url: string, method: string, body?: any,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token!.accessToken}`,
      "Content-Type": "application/json",
    };

    let response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.status === 401) {
      await this.refreshToken();
      headers.Authorization = `Bearer ${this.token!.accessToken}`;
      response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    }

    if (!response.ok) {
      throw new Error(`Dropbox API ${response.status}: ${await response.text()}`);
    }

    return response;
  }

  private toFileMetadata(entry: any): FileMetadata {
    return {
      name: entry.name || "",
      path: entry.path_display || entry.path_lower || "",
      size: entry.size || 0,
      lastModified: entry.server_modified || entry.client_modified || new Date().toISOString(),
      isDirectory: entry[".tag"] === "folder",
    };
  }
}
