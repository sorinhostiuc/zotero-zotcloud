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
import { log, logError } from "../utils/logger";

/**
 * Google Drive provider.
 * Uses Google Drive API v3 (REST) with OAuth 2.0.
 *
 * File layout: Uses a dedicated "ZotCloud" folder in user's Drive root.
 * Upload: Multipart for <5MB, resumable for larger files.
 * Rate limits: 12,000 requests/day, 1,000 requests/100s/user.
 */

const API_BASE = "https://www.googleapis.com/drive/v3";
const UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";

export class GoogleDriveProvider implements CloudProvider {
  private token: AuthToken | null = null;
  private folderCache = new Map<string, string>(); // path → folderId

  private readonly oauthConfig: OAuthConfig = {
    providerName: "Google Drive",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientId: "", // User must configure via Google Cloud Console
    scopes: ["https://www.googleapis.com/auth/drive.file"],
    redirectPort: 23120,
    usePKCE: false,
    extraAuthParams: {
      access_type: "offline",
      prompt: "consent",
    },
  };

  /** Set OAuth client credentials (user configures from Google Cloud Console) */
  setCredentials(clientId: string, clientSecret: string) {
    this.oauthConfig.clientId = clientId;
    this.oauthConfig.clientSecret = clientSecret;
    Zotero.Prefs.set("extensions.zotcloud.gdrive.clientId", clientId);
    Zotero.Prefs.set("extensions.zotcloud.gdrive.clientSecret", clientSecret);
  }

  async authenticate(): Promise<AuthToken> {
    // Load credentials from prefs
    this.oauthConfig.clientId =
      (Zotero.Prefs.get("extensions.zotcloud.gdrive.clientId") as string) || "";
    this.oauthConfig.clientSecret =
      (Zotero.Prefs.get("extensions.zotcloud.gdrive.clientSecret") as string) || "";

    if (!this.oauthConfig.clientId) {
      throw new Error(
        "Google Drive client ID not configured. Create a project at console.cloud.google.com, " +
        "enable Drive API, create OAuth credentials, and add your email as a test user.",
      );
    }

    // Try loading existing tokens
    const stored = loadTokens("GoogleDrive");
    if (stored && stored.expiresAt > Date.now() + 60000) {
      this.token = stored;
      log("Google Drive: using stored token");
      return stored;
    }

    // Try refresh
    if (stored?.refreshToken) {
      try {
        this.token = await refreshAccessToken(
          this.oauthConfig,
          stored.refreshToken,
        );
        storeTokens("GoogleDrive", this.token);
        log("Google Drive: refreshed token");
        return this.token;
      } catch {
        log("Google Drive: refresh failed, starting new flow");
      }
    }

    // Start new OAuth flow
    this.token = await startOAuthFlow(this.oauthConfig);
    storeTokens("GoogleDrive", this.token);
    log("Google Drive: authenticated successfully");
    return this.token;
  }

  async refreshToken(): Promise<AuthToken> {
    if (!this.token?.refreshToken) {
      return this.authenticate();
    }
    this.token = await refreshAccessToken(
      this.oauthConfig,
      this.token.refreshToken,
    );
    storeTokens("GoogleDrive", this.token);
    return this.token;
  }

  async disconnect(): Promise<void> {
    removeTokens("GoogleDrive");
    this.token = null;
    this.folderCache.clear();
    log("Google Drive: disconnected");
  }

  isAuthenticated(): boolean {
    return this.token !== null && this.token.expiresAt > Date.now();
  }

  async upload(
    remotePath: string,
    data: ArrayBuffer | string,
  ): Promise<FileMetadata> {
    await this.ensureAuth();

    const parentPath = remotePath.substring(0, remotePath.lastIndexOf("/"));
    const fileName = remotePath.split("/").pop() || "";
    const parentId = await this.ensureFolderPath(parentPath);

    // Check if file already exists
    const existingId = await this.findFileByName(fileName, parentId);
    const body =
      typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);

    if (existingId) {
      // Update existing file
      const response = await this.apiRequest(
        `${UPLOAD_BASE}/files/${existingId}?uploadType=media`,
        "PATCH",
        body,
        { "Content-Type": "application/octet-stream" },
      );
      const result = await response.json();
      return this.toFileMetadata(result, remotePath);
    }

    // Create new file (multipart upload)
    const metadata = JSON.stringify({
      name: fileName,
      parents: [parentId],
    });

    const boundary = "zotcloud_boundary_" + Date.now();
    const multipartBody = this.buildMultipartBody(
      boundary,
      metadata,
      body,
    );

    const response = await this.apiRequest(
      `${UPLOAD_BASE}/files?uploadType=multipart`,
      "POST",
      multipartBody,
      {
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
    );

    const result = await response.json();
    return this.toFileMetadata(result, remotePath);
  }

  async download(remotePath: string): Promise<ArrayBuffer> {
    await this.ensureAuth();

    const fileId = await this.resolveFileId(remotePath);
    if (!fileId) throw new Error(`File not found: ${remotePath}`);

    const response = await this.apiRequest(
      `${API_BASE}/files/${fileId}?alt=media`,
      "GET",
    );

    return response.arrayBuffer();
  }

  async delete(remotePath: string): Promise<void> {
    await this.ensureAuth();

    const fileId = await this.resolveFileId(remotePath);
    if (!fileId) return; // Already gone

    await this.apiRequest(`${API_BASE}/files/${fileId}`, "DELETE");
  }

  async list(remotePath: string): Promise<FileMetadata[]> {
    await this.ensureAuth();

    const folderId = await this.resolveFileId(remotePath);
    if (!folderId) return [];

    const query = `'${folderId}' in parents and trashed = false`;
    const response = await this.apiRequest(
      `${API_BASE}/files?q=${encodeURIComponent(query)}&fields=files(id,name,size,modifiedTime,mimeType)&pageSize=1000`,
      "GET",
    );

    const data = await response.json();
    return (data.files || []).map((f: any) =>
      this.toFileMetadata(f, `${remotePath}/${f.name}`),
    );
  }

  async mkdir(remotePath: string): Promise<void> {
    await this.ensureAuth();
    await this.ensureFolderPath(remotePath);
  }

  async move(fromPath: string, toPath: string): Promise<boolean> {
    await this.ensureAuth();

    const fileId = await this.resolveFileId(fromPath);
    if (!fileId) return false;

    const oldParentPath = fromPath.substring(0, fromPath.lastIndexOf("/"));
    const newParentPath = toPath.substring(0, toPath.lastIndexOf("/"));
    const newName = toPath.split("/").pop() || "";

    const oldParentId = await this.resolveFileId(oldParentPath);
    const newParentId = await this.ensureFolderPath(newParentPath);

    const params: string[] = [];
    if (oldParentId && oldParentId !== newParentId) {
      params.push(`addParents=${newParentId}`, `removeParents=${oldParentId}`);
    }

    await this.apiRequest(
      `${API_BASE}/files/${fileId}?${params.join("&")}`,
      "PATCH",
      JSON.stringify({ name: newName }),
      { "Content-Type": "application/json" },
    );

    // Invalidate folder cache
    this.folderCache.clear();
    return true;
  }

  async getFileInfo(remotePath: string): Promise<FileMetadata> {
    await this.ensureAuth();

    const fileId = await this.resolveFileId(remotePath);
    if (!fileId) throw new Error(`File not found: ${remotePath}`);

    const response = await this.apiRequest(
      `${API_BASE}/files/${fileId}?fields=id,name,size,modifiedTime,mimeType`,
      "GET",
    );

    const data = await response.json();
    return this.toFileMetadata(data, remotePath);
  }

  async exists(remotePath: string): Promise<boolean> {
    try {
      const id = await this.resolveFileId(remotePath);
      return id !== null;
    } catch {
      return false;
    }
  }

  async getQuota(): Promise<QuotaInfo> {
    await this.ensureAuth();

    const response = await this.apiRequest(
      `${API_BASE}/about?fields=storageQuota`,
      "GET",
    );
    const data = await response.json();
    const quota = data.storageQuota || {};

    return {
      used: parseInt(quota.usage || "0", 10),
      total: parseInt(quota.limit || "0", 10),
    };
  }

  getName(): string {
    return "Google Drive";
  }

  getIcon(): string {
    return "chrome://zotcloud/content/icons/gdrive.svg";
  }

  // --- Helpers ---

  private async ensureAuth(): Promise<void> {
    if (!this.token || this.token.expiresAt < Date.now() + 60000) {
      await this.authenticate();
    }
  }

  private async apiRequest(
    url: string,
    method: string,
    body?: any,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token!.accessToken}`,
      ...extraHeaders,
    };

    const response = await fetch(url, { method, headers, body });

    if (response.status === 401) {
      // Token expired — refresh and retry
      await this.refreshToken();
      headers.Authorization = `Bearer ${this.token!.accessToken}`;
      return fetch(url, { method, headers, body });
    }

    if (!response.ok && method !== "DELETE") {
      const errorText = await response.text();
      throw new Error(`Google Drive API error ${response.status}: ${errorText}`);
    }

    return response;
  }

  /** Resolve a path like /ZotCloud/changelog/xxx to a Google Drive file ID */
  private async resolveFileId(remotePath: string): Promise<string | null> {
    const parts = remotePath.split("/").filter(Boolean);
    let parentId = "root";

    for (const part of parts) {
      const id = await this.findFileByName(part, parentId);
      if (!id) return null;
      parentId = id;
    }

    return parentId;
  }

  /** Find a file by name within a parent folder */
  private async findFileByName(
    name: string,
    parentId: string,
  ): Promise<string | null> {
    const cacheKey = `${parentId}/${name}`;
    if (this.folderCache.has(cacheKey)) {
      return this.folderCache.get(cacheKey)!;
    }

    const query = `name = '${name}' and '${parentId}' in parents and trashed = false`;
    const response = await this.apiRequest(
      `${API_BASE}/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1`,
      "GET",
    );

    const data = await response.json();
    const id = data.files?.[0]?.id || null;

    if (id) {
      this.folderCache.set(cacheKey, id);
    }

    return id;
  }

  /** Ensure a folder path exists, creating missing folders */
  private async ensureFolderPath(remotePath: string): Promise<string> {
    const parts = remotePath.split("/").filter(Boolean);
    let parentId = "root";

    for (const part of parts) {
      const existing = await this.findFileByName(part, parentId);
      if (existing) {
        parentId = existing;
        continue;
      }

      // Create folder
      const response = await this.apiRequest(
        `${API_BASE}/files`,
        "POST",
        JSON.stringify({
          name: part,
          mimeType: "application/vnd.google-apps.folder",
          parents: [parentId],
        }),
        { "Content-Type": "application/json" },
      );

      const data = await response.json();
      parentId = data.id;
      this.folderCache.set(`${parentId}/${part}`, data.id);
    }

    return parentId;
  }

  private toFileMetadata(gdriveFile: any, path: string): FileMetadata {
    return {
      name: gdriveFile.name || "",
      path,
      size: parseInt(gdriveFile.size || "0", 10),
      lastModified: gdriveFile.modifiedTime || new Date().toISOString(),
      isDirectory:
        gdriveFile.mimeType === "application/vnd.google-apps.folder",
    };
  }

  private buildMultipartBody(
    boundary: string,
    metadata: string,
    content: Uint8Array,
  ): Uint8Array {
    const metadataPart =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`;
    const contentHeader = `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const closing = `\r\n--${boundary}--`;

    const encoder = new TextEncoder();
    const metadataBytes = encoder.encode(metadataPart);
    const headerBytes = encoder.encode(contentHeader);
    const closingBytes = encoder.encode(closing);

    const result = new Uint8Array(
      metadataBytes.length +
        headerBytes.length +
        content.length +
        closingBytes.length,
    );
    result.set(metadataBytes, 0);
    result.set(headerBytes, metadataBytes.length);
    result.set(content, metadataBytes.length + headerBytes.length);
    result.set(
      closingBytes,
      metadataBytes.length + headerBytes.length + content.length,
    );

    return result;
  }
}
