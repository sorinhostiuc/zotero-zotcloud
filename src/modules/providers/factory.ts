import { CloudProvider } from "./provider";
import { WebDAVProvider } from "./webdav";
import { GoogleDriveProvider } from "./google-drive";

import { DropboxProvider } from "./dropbox";
import { PCloudProvider } from "./pcloud";

export type ProviderType =
  | "webdav"
  | "pcloud-webdav"
  | "google-drive"
  | "dropbox"
  | "pcloud";

const PROVIDER_LABELS: Record<ProviderType, string> = {
  webdav: "WebDAV (custom server)",
  "pcloud-webdav": "pCloud (WebDAV — user/password)",
  "google-drive": "Google Drive (OAuth)",
  dropbox: "Dropbox (OAuth)",
  pcloud: "pCloud (OAuth)",
};

/** Create a cloud provider instance by type */
export function createProvider(type: ProviderType): CloudProvider {
  switch (type) {
    case "webdav":
    case "pcloud-webdav":
      return new WebDAVProvider();
    case "google-drive":
      return new GoogleDriveProvider();
    case "dropbox":
      return new DropboxProvider();
    case "pcloud":
      return new PCloudProvider();
    default:
      throw new Error(`Unknown provider type: ${type}`);
  }
}

/** Get display label for a provider type */
export function getProviderLabel(type: ProviderType): string {
  return PROVIDER_LABELS[type] || type;
}

/** Get all available provider types */
export function getAvailableProviders(): ProviderType[] {
  return ["pcloud-webdav", "webdav", "google-drive", "dropbox", "pcloud"];
}

/** Check if provider type is a WebDAV-based provider */
export function isWebDAVProvider(type: ProviderType): boolean {
  return type === "webdav" || type === "pcloud-webdav";
}

/** WebDAV preset configuration */
export interface WebDAVPreset {
  url: string;
  placeholder: string;
  label: string;
  /** Multiple server URLs for region selection */
  servers?: Array<{ url: string; label: string }>;
}

/** Get WebDAV preset for known providers */
export function getWebDAVPreset(type: ProviderType): WebDAVPreset | null {
  switch (type) {
    case "pcloud-webdav":
      return {
        url: "https://webdav.pcloud.com",
        placeholder: "https://webdav.pcloud.com",
        label: "pCloud WebDAV",
        servers: [
          { url: "https://webdav.pcloud.com", label: "US (webdav.pcloud.com)" },
          { url: "https://ewebdav.pcloud.com", label: "EU (ewebdav.pcloud.com)" },
        ],
      };
    default:
      return null;
  }
}
