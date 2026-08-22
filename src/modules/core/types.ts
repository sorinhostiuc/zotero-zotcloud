/**
 * Core data types for ZotCloud sync protocol.
 * See ZotCloud_Architecture_Spec.md sections 3.x for full documentation.
 */

/** Vector clock: maps deviceId to a monotonically increasing counter */
export type VectorClock = Record<string, number>;

/** Creator as stored in a ChangeEvent */
export interface Creator {
  firstName: string;
  lastName: string;
  creatorType: string;
}

/** Tag as stored in a ChangeEvent */
export interface Tag {
  tag: string;
  type?: number;
}

/** PDF annotation data */
export interface AnnotationData {
  type: string;           // highlight, note, underline, strikethrough, image, ink, text
  pageLabel?: string;
  position: string;       // JSON-encoded position data
  color?: string;
  comment?: string;
  text?: string;          // selected/highlighted text
  sortIndex?: string;
  tags?: Tag[];
}

/** Data payload for a ChangeEvent */
export interface ChangeEventData {
  fields?: Record<string, any>;
  creators?: Creator[];
  tags?: Tag[];
  collections?: string[];
  relations?: Record<string, string>;
  attachmentPath?: string;
  attachmentHash?: string;
  /** Parent item key (for attachment items linking to their parent reference) */
  parentKey?: string;
  /** HTML content for note items */
  noteContent?: string;
  /** Annotation data for PDF annotation items */
  annotationData?: AnnotationData;
}

/** A single change event in the sync changelog */
export interface ChangeEvent {
  id: string;
  deviceId: string;
  timestamp: number;
  vectorClock: VectorClock;
  type: "add" | "modify" | "delete";
  entityType: "item" | "collection" | "collection-item" | "tag";
  entityKey: string;
  libraryID: number;
  data: ChangeEventData;
  previousData?: {
    fields?: Record<string, any>;
  };
}

/** Sync state persisted per device */
export interface SyncState {
  deviceId: string;
  lastSyncTimestamp: number;
  vectorClock: VectorClock;
  provider: string;
  lastSuccessfulSync: number;
  pendingChanges: number;
  status: "idle" | "syncing" | "error" | "conflict";
}

/** Cloud manifest stored at /ZotCloud/manifest.json */
export interface CloudManifest {
  version: string;
  schemaVersion: number;
  libraryName: string;
  libraryID: number;
  createdAt: string;
  lastModified: string;
  devices: Record<
    string,
    {
      name: string;
      lastSeen: string;
      zoteroVersion: string;
      pluginVersion: string;
    }
  >;
  vectorClock: VectorClock;
  totalItems: number;
  totalAttachments: number;
  snapshotInterval: number;
}

/** File metadata returned by cloud providers */
export interface FileMetadata {
  name: string;
  path: string;
  size: number;
  lastModified: string;
  isDirectory: boolean;
  etag?: string;
}

/** Auth token returned by providers */
export interface AuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  tokenType: string;
}

/** Cloud provider quota info */
export interface QuotaInfo {
  used: number;
  total: number;
}

/** Conflict between local and remote changes */
export interface SyncConflict {
  entityKey: string;
  entityType: string;
  fieldName: string;
  localValue: any;
  remoteValue: any;
  localDeviceId: string;
  remoteDeviceId: string;
  localTimestamp: number;
  remoteTimestamp: number;
}

/** Resolution for a conflict */
export type ConflictResolution = "keep-local" | "keep-remote" | "keep-both";
