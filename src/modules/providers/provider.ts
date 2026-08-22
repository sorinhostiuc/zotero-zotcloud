import { AuthToken, FileMetadata, QuotaInfo } from "../core/types";

/**
 * CloudProvider is the abstract interface that all cloud storage providers implement.
 * The SyncEngine interacts ONLY through this interface — never directly with provider APIs.
 *
 * Each provider (Google Drive, Dropbox, pCloud, WebDAV) implements this
 * interface, handling authentication, file operations, and provider-specific quirks
 * behind a uniform API.
 */
export interface CloudProvider {
  // --- Lifecycle ---

  /** Authenticate with the cloud provider (OAuth flow or credentials) */
  authenticate(): Promise<AuthToken>;

  /** Refresh an expired access token */
  refreshToken(): Promise<AuthToken>;

  /** Disconnect and revoke tokens */
  disconnect(): Promise<void>;

  /** Check if currently authenticated */
  isAuthenticated(): boolean;

  // --- File Operations ---

  /** Upload a file or string data to a remote path */
  upload(remotePath: string, data: ArrayBuffer | string): Promise<FileMetadata>;

  /** Download a file from a remote path */
  download(remotePath: string): Promise<ArrayBuffer>;

  /** Delete a file at a remote path */
  delete(remotePath: string): Promise<void>;

  /** List files in a remote directory */
  list(remotePath: string): Promise<FileMetadata[]>;

  /** Create a remote directory (and parent directories if needed) */
  mkdir(remotePath: string): Promise<void>;

  /** Move/rename a file or directory. Optional — returns false if unsupported. */
  move?(fromPath: string, toPath: string): Promise<boolean>;

  // --- Metadata ---

  /** Get metadata for a specific file */
  getFileInfo(remotePath: string): Promise<FileMetadata>;

  /** Check if a file or directory exists */
  exists(remotePath: string): Promise<boolean>;

  // --- Provider Info ---

  /** Get storage quota usage */
  getQuota(): Promise<QuotaInfo>;

  /** Get provider display name (e.g., "Google Drive") */
  getName(): string;

  /** Get provider icon path for UI */
  getIcon(): string;
}
