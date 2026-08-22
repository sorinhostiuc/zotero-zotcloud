import { ChangeEvent, CloudManifest, FileMetadata } from "./types";
import { StateManager } from "./state-manager";
import { ChangeTracker } from "./change-tracker";
import { ChangeLog } from "./change-log";
import { ConflictResolver } from "./conflict-resolver";
import { QueueManager } from "./queue-manager";
import { AttachmentSync } from "./attachment-sync";
import { Snapshot } from "./snapshot";
import { CloudProvider } from "../providers/provider";
import { Encryption } from "../crypto/encryption";
import { debounce } from "../utils/debounce";
import { log, logError } from "../utils/logger";
import { generateUUID } from "../utils/uuid";

/**
 * A single provider connection with its own cloud folder and sync state.
 * Multiple connections can be active simultaneously.
 */
export interface ProviderConnection {
  key: string;
  provider: CloudProvider;
  cloudFolder: string;
  attachmentSync: AttachmentSync;
  lastSyncedTimestamp: number;
  enabled: boolean;
}

/** Serializable config for saving/restoring provider connections */
export interface ProviderConnectionConfig {
  key: string;
  type: string;
  cloudFolder: string;
  lastSyncedTimestamp: number;
  enabled: boolean;
}

/**
 * SyncEngine orchestrates the full sync cycle: push local changes, pull remote
 * changes, merge via ConflictResolver, and apply to Zotero.
 *
 * Supports multiple simultaneous cloud providers. Each provider has its own
 * cloud folder, manifest, and sync tracking. Changes are pushed to ALL
 * connected providers and pulled from ALL providers.
 *
 * Sync protocol (per spec section 4.2):
 * PUSH: collect local ChangeEvents → batch JSON → upload to /changelog/{deviceId}/
 * PULL: read manifest → compare vector clocks → download new batches → apply
 */
export class SyncEngine {
  private stateManager: StateManager;
  private changeTracker: ChangeTracker;
  private conflictResolver: ConflictResolver;
  private queueManager: QueueManager;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private debouncedSync: () => void;
  private _isSyncing = false;

  // Multi-provider: array of active connections
  private connections: ProviderConnection[] = [];

  // Active provider/cloudFolder/attachmentSync — swapped during sync iteration.
  // Also serves as backward-compatible single-provider access.
  private provider: CloudProvider | null = null;
  private attachmentSync: AttachmentSync | null = null;
  private _activeCloudFolder: string = "";

  constructor(stateManager: StateManager, changeTracker: ChangeTracker) {
    this.stateManager = stateManager;
    this.changeTracker = changeTracker;
    this.conflictResolver = new ConflictResolver();
    this.queueManager = new QueueManager();

    const debounceMs =
      (Zotero.Prefs.get("extensions.zotcloud.syncDebounceMs") as number) ||
      30000;
    this.debouncedSync = debounce(() => this.syncNow(), debounceMs);
  }

  // --- Provider management ---

  /** Add a provider connection. If key already exists, replaces it. */
  addProvider(key: string, provider: CloudProvider, cloudFolder?: string): void {
    const folder = cloudFolder ||
      (Zotero.Prefs.get("extensions.zotcloud.cloudFolderPath") as string) ||
      "/ZotCloud";

    // Remove existing connection with same key
    this.connections = this.connections.filter(c => c.key !== key);

    const conn: ProviderConnection = {
      key,
      provider,
      cloudFolder: folder,
      attachmentSync: new AttachmentSync(provider, this.stateManager, folder),
      lastSyncedTimestamp: 0,
      enabled: true,
    };

    // Restore lastSyncedTimestamp from saved config if available
    try {
      const savedConfigs = JSON.parse(
        (Zotero.Prefs.get("extensions.zotcloud.providers") as string) || "[]",
      ) as ProviderConnectionConfig[];
      const saved = savedConfigs.find(c => c.key === key);
      if (saved) {
        conn.lastSyncedTimestamp = saved.lastSyncedTimestamp || 0;
      }
    } catch { /* parse error, ignore */ }

    this.connections.push(conn);

    // Set as active provider (backward compat)
    this.provider = provider;
    this.attachmentSync = conn.attachmentSync;
    this._activeCloudFolder = folder;

    log(`Provider added: ${key} (${provider.getName()}) → ${folder}`);
    this.saveConnectionState();
  }

  /** Remove a provider connection by key */
  removeProvider(key: string): void {
    this.connections = this.connections.filter(c => c.key !== key);

    // Update active provider to first remaining connection
    if (this.connections.length > 0) {
      const first = this.connections[0];
      this.provider = first.provider;
      this.attachmentSync = first.attachmentSync;
      this._activeCloudFolder = first.cloudFolder;
    } else {
      this.provider = null;
      this.attachmentSync = null;
      this._activeCloudFolder = "";
    }

    log(`Provider removed: ${key}`);
    this.saveConnectionState();
  }

  /**
   * Set the active cloud provider (backward compat).
   * Adds or replaces the connection using the provider type from prefs as key.
   */
  setProvider(provider: CloudProvider) {
    const key = (Zotero.Prefs.get("extensions.zotcloud.provider") as string) || "default";
    this.addProvider(key, provider);
  }

  /** Get the first active provider (backward compat) */
  getProvider(): CloudProvider | null {
    if (this.connections.length > 0) return this.connections[0].provider;
    return this.provider;
  }

  /** Get a specific connection by key */
  getConnection(key: string): ProviderConnection | undefined {
    return this.connections.find(c => c.key === key);
  }

  /** Get all active connections */
  getConnections(): ProviderConnection[] {
    return [...this.connections];
  }

  /** Get the attachment sync module (from first connection or active) */
  getAttachmentSync(): AttachmentSync | null {
    if (this.connections.length > 0) return this.connections[0].attachmentSync;
    return this.attachmentSync;
  }

  /** Get conflict resolver for UI */
  getConflictResolver(): ConflictResolver {
    return this.conflictResolver;
  }

  /** Schedule a debounced sync (called after item changes) */
  scheduleSync() {
    this.debouncedSync();
  }

  /** Start periodic sync timer */
  startPeriodicSync() {
    this.stopPeriodicSync();
    const interval =
      (Zotero.Prefs.get("extensions.zotcloud.syncInterval") as number) ||
      300000;
    this.syncTimer = setInterval(() => this.syncNow(), interval);
    log(`Periodic sync started (every ${interval / 1000}s)`);
  }

  /** Stop periodic sync timer */
  stopPeriodicSync() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  /** Stop everything */
  stop() {
    this.stopPeriodicSync();
    this.queueManager.stop();
  }

  // --- Initial sync ---

  /**
   * Initial sync for a specific connection (adds provider to an already-syncing library).
   * If connKey is not provided, uses the current active provider.
   */
  async initialSyncForConnection(connKey: string): Promise<void> {
    const conn = this.connections.find(c => c.key === connKey);
    if (!conn) throw new Error(`Connection ${connKey} not found`);

    // Swap active provider to this connection
    this.provider = conn.provider;
    this._activeCloudFolder = conn.cloudFolder;
    this.attachmentSync = conn.attachmentSync;

    await this.initialSync();

    // Update connection sync state
    conn.lastSyncedTimestamp = Date.now();
    this.saveConnectionState();
  }

  /**
   * Initial sync — called when connecting a provider for the first time.
   * Per spec section 4.1:
   * - If no manifest exists on cloud: export full library as initial snapshot
   * - If manifest exists: download snapshot, apply changelogs, register device
   */
  async initialSync(): Promise<void> {
    if (!this.provider) throw new Error("No provider configured");

    this.stateManager.status = "syncing";
    log("Starting initial sync...");

    try {
      await ChangeLog.init();

      const cloudFolder = this.getCloudFolder();
      const manifestPath = `${cloudFolder}/manifest.json`;
      let existingManifest: CloudManifest | null = null;

      try {
        const data = await this.provider.download(manifestPath);
        existingManifest = JSON.parse(this.decodeBuffer(data));
      } catch {
        // No manifest = first device
      }

      if (!existingManifest) {
        await this.firstDeviceSetup();
      } else if (this.isOurOwnManifest(existingManifest)) {
        log("Found our own manifest from a previous session, running full re-sync");
        await this.firstDeviceSetup();
      } else {
        await this.joinExistingSync(existingManifest);
      }

      this.stateManager.status = "idle";
      this.stateManager.lastSyncTimestamp = Date.now();
      this.stateManager.lastSuccessfulSync = Date.now();
      log("Initial sync completed");
    } catch (err) {
      this.stateManager.status = "error";
      logError("Initial sync failed", err);
      throw err;
    }
  }

  // --- Incremental sync ---

  /**
   * Execute a full incremental sync cycle now.
   * Syncs with ALL connected providers sequentially.
   */
  async syncNow(): Promise<void> {
    log(`syncNow called (connections: ${this.connections.length}, provider: ${!!this.provider}, isSyncing: ${this._isSyncing})`);

    if (this.connections.length === 0 && !this.provider) {
      log("No provider configured, skipping sync");
      return;
    }

    if (this._isSyncing) {
      log("Sync already in progress, skipping");
      return;
    }

    this._isSyncing = true;
    this.stateManager.status = "syncing";
    log("Sync started");

    try {
      await ChangeLog.init();

      // 1. Persist pending in-memory events to SQLite
      const pendingEvents = this.changeTracker.drainEvents();
      if (pendingEvents.length > 0) {
        await ChangeLog.appendBatch(pendingEvents);
        log(`Persisted ${pendingEvents.length} events to change log`);
      }

      if (this.connections.length > 0) {
        // Multi-provider: sync each connection
        for (const conn of this.connections) {
          if (!conn.enabled) continue;

          // Swap active provider to this connection
          this.provider = conn.provider;
          this._activeCloudFolder = conn.cloudFolder;
          this.attachmentSync = conn.attachmentSync;

          try {
            log(`Syncing with ${conn.key}...`);
            const latestTimestamp = await this.pushSince(conn.lastSyncedTimestamp);
            if (latestTimestamp > 0) {
              conn.lastSyncedTimestamp = latestTimestamp;
            }
            await this.pull();
          } catch (err) {
            logError(`Sync failed for ${conn.key}`, err);
          }
        }

        // Mark events as synced when ALL providers have them
        this.markFullySyncedEvents();
        this.saveConnectionState();
      } else {
        // Single-provider backward compat (no connections array)
        await this.pushSince(0);
        await this.pull();
      }

      // Update state
      const unresolved = this.conflictResolver.getUnresolved();
      this.stateManager.status =
        unresolved.length > 0 ? "conflict" : "idle";
      this.stateManager.lastSyncTimestamp = Date.now();
      this.stateManager.lastSuccessfulSync = Date.now();
      this.stateManager.pendingChanges = await ChangeLog.unsyncedCount();

      log("Sync completed successfully");
    } catch (err) {
      this.stateManager.status = "error";
      logError("Sync failed", err);
    } finally {
      this._isSyncing = false;
    }
  }

  /**
   * Force a full bidirectional sync: compare local library with cloud and reconcile.
   * 1. Export entire local library → push missing items to cloud
   * 2. Download cloud snapshot → apply missing items locally
   * 3. Update manifest and create fresh snapshot
   */
  async forceFullSync(): Promise<string> {
    if (this.connections.length === 0 && !this.provider) {
      throw new Error("No cloud provider connected. Connect a provider in Settings first.");
    }

    if (this._isSyncing) {
      throw new Error("A sync is already in progress — wait for it to finish.");
    }

    this._isSyncing = true;
    this.stateManager.status = "syncing";
    log("Force full sync started — comparing local library with cloud...");

    const em = (e: unknown) => (e instanceof Error ? e.message : String(e));
    const errors: string[] = [];
    let reconciled = 0;

    try {
      await ChangeLog.init();

      // Reset state so everything is re-evaluated
      this.stateManager.resetClock();
      this.stateManager.lastSyncTimestamp = 0;

      // Clear local changelog
      try {
        await Zotero.DB.queryAsync("DELETE FROM zotcloudChangeLog");
      } catch { /* table may not exist */ }

      // Reset per-connection timestamps
      for (const conn of this.connections) {
        conn.lastSyncedTimestamp = 0;
      }

      if (this.connections.length > 0) {
        for (const conn of this.connections) {
          if (!conn.enabled) continue;
          this.provider = conn.provider;
          this._activeCloudFolder = conn.cloudFolder;
          this.attachmentSync = conn.attachmentSync;

          try {
            log(`Force syncing with ${conn.key}...`);
            await this.reconcileWithCloud();
            reconciled++;
            conn.lastSyncedTimestamp = Date.now();
          } catch (err) {
            errors.push(`${conn.key}: ${em(err)}`);
            logError(`Force sync failed for ${conn.key}`, err);
          }
        }
        this.saveConnectionState();
      } else {
        try {
          await this.reconcileWithCloud();
          reconciled++;
        } catch (err) {
          errors.push(em(err));
          logError("Force sync failed", err);
        }
      }

      this.stateManager.lastSyncTimestamp = Date.now();
      this.stateManager.pendingChanges = 0;

      if (reconciled === 0) {
        this.stateManager.status = "error";
        throw new Error(errors.length ? errors.join(" | ") : "force sync did not reach any provider");
      }

      this.stateManager.status = "idle";
      this.stateManager.lastSuccessfulSync = Date.now();
      const summary = `Force-synced ${reconciled} provider(s)`;
      log("Force full sync completed — " + summary);
      if (errors.length) log("Force sync completed with errors: " + errors.join(" | "));
      return errors.length ? `${summary} (errors: ${errors.join("; ")})` : summary;
    } catch (err) {
      this.stateManager.status = "error";
      logError("Force full sync failed", err);
      throw err;
    } finally {
      this._isSyncing = false;
    }
  }

  /**
   * Full reconciliation with cloud for the active provider:
   * - Download cloud snapshot to find what cloud has
   * - Compare with local library
   * - Push local-only items to cloud
   * - Apply cloud-only items locally
   * - Create fresh snapshot
   */
  private async reconcileWithCloud(): Promise<void> {
    if (!this.provider) return;

    const cloudFolder = this.getCloudFolder();
    const libraryID = Zotero.Libraries.userLibraryID;

    // 1. Collect ALL local items and collections by key
    const localItemKeys = new Set<string>();
    const localItems = await Zotero.Items.getAll(libraryID);
    for (const item of localItems) {
      if (item.isFeedItem) continue;
      localItemKeys.add(item.key);
    }
    const localCollectionKeys = new Set<string>();
    const localCollections = Zotero.Collections.getByLibrary(libraryID);
    for (const col of localCollections) {
      localCollectionKeys.add(col.key);
    }
    log(`Local library: ${localItemKeys.size} items, ${localCollectionKeys.size} collections`);

    // 2. Download cloud snapshot to see what cloud has
    const cloudItemKeys = new Set<string>();
    const cloudCollectionKeys = new Set<string>();
    let cloudEvents: ChangeEvent[] = [];

    try {
      const snapshots = await this.provider.list(`${cloudFolder}/snapshots`);
      const snapshotFiles = snapshots
        .filter((f) => f.name.endsWith(".json") && !f.name.endsWith(".meta.json") && !f.isDirectory)
        .sort((a, b) => b.name.localeCompare(a.name));

      if (snapshotFiles.length > 0) {
        log(`Reading cloud snapshot: ${snapshotFiles[0].name}`);
        const snapshotData = await this.provider.download(snapshotFiles[0].path);
        const json = new TextDecoder().decode(snapshotData);
        cloudEvents = JSON.parse(json);

        for (const event of cloudEvents) {
          if (event.entityType === "item") cloudItemKeys.add(event.entityKey);
          if (event.entityType === "collection") cloudCollectionKeys.add(event.entityKey);
        }
        log(`Cloud snapshot: ${cloudItemKeys.size} items, ${cloudCollectionKeys.size} collections`);
      } else {
        log("No cloud snapshot found — will push entire local library");
      }
    } catch (err) {
      log("Could not read cloud snapshots — will push entire local library: " + String(err));
    }

    // 3. Apply cloud-only items locally (items on cloud but not local)
    let appliedFromCloud = 0;
    for (const event of cloudEvents) {
      const key = event.entityKey;
      if (event.entityType === "item" && !localItemKeys.has(key)) {
        try {
          await this.applyRemoteEvent(event);
          appliedFromCloud++;
        } catch (err) {
          logError(`Failed to apply cloud item ${key}`, err);
        }
      }
      if (event.entityType === "collection" && !localCollectionKeys.has(key)) {
        try {
          await this.applyRemoteEvent(event);
          appliedFromCloud++;
        } catch (err) {
          logError(`Failed to apply cloud collection ${key}`, err);
        }
      }
    }
    if (appliedFromCloud > 0) {
      log(`Applied ${appliedFromCloud} items/collections from cloud to local`);
    }

    // 4. Download attachments for items that came from cloud
    if (this.attachmentSync && appliedFromCloud > 0) {
      try {
        const attachManifestPath = `${cloudFolder}/attachments/_manifest.json`;
        const attachManifestData = await this.provider.download(attachManifestPath);
        const attachManifest = JSON.parse(this.decodeBuffer(attachManifestData));
        const files = attachManifest.files || {};

        const toDownload: Array<{ item: any; hash: string }> = [];
        for (const hash of Object.keys(files)) {
          const entry = files[hash];
          if (!entry.itemKey) continue;
          const item = Zotero.Items.getByLibraryAndKey(libraryID, entry.itemKey);
          if (!item || !item.isAttachment()) continue;
          try {
            const filePath = await item.getFilePathAsync();
            if (filePath && await IOUtils.exists(filePath)) continue;
          } catch { /* no local file */ }
          toDownload.push({ item, hash });
        }

        if (toDownload.length > 0) {
          log(`Downloading ${toDownload.length} missing attachments...`);
          await this.attachmentSync.downloadMissing(toDownload);
        }
      } catch (err) {
        logError("Attachment download during reconciliation failed (non-fatal)", err);
      }
    }

    // 5. Push entire local library to cloud (re-export + new snapshot)
    log("Re-exporting local library to cloud...");
    await this.provider.mkdir(cloudFolder);
    await this.provider.mkdir(`${cloudFolder}/changelog`);
    await this.provider.mkdir(`${cloudFolder}/changelog/${this.stateManager.deviceId}`);
    await this.provider.mkdir(`${cloudFolder}/attachments`);
    await this.provider.mkdir(`${cloudFolder}/snapshots`);

    const events = await this.exportFullLibrary();
    log(`Exported ${events.length} events from local library`);

    if (events.length > 0) {
      // Upload attachments
      if (this.attachmentSync) {
        const attachmentEvents = events.filter(
          (e) => e.entityType === "item" && e.data.attachmentPath,
        );
        if (attachmentEvents.length > 0) {
          log(`Uploading ${attachmentEvents.length} attachments...`);
          let uploaded = 0;
          for (const event of attachmentEvents) {
            try {
              const item = Zotero.Items.getByLibraryAndKey(event.libraryID, event.entityKey);
              if (item) {
                const hash = await this.attachmentSync.uploadAttachment(item);
                if (hash) {
                  event.data.attachmentHash = hash;
                  uploaded++;
                }
              }
            } catch (err) {
              logError(`Attachment upload failed for ${event.entityKey}`, err);
            }
          }
          log(`Attachment upload: ${uploaded}/${attachmentEvents.length}`);
        }
      }

      // Upload changelog
      const batchSize = 1000;
      for (let i = 0; i < events.length; i += batchSize) {
        const batch = events.slice(i, i + batchSize);
        const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const remotePath = `${cloudFolder}/changelog/${this.stateManager.deviceId}/${batchId}.json`;
        await this.provider.upload(remotePath, JSON.stringify(batch));
      }
    }

    // 6. Create fresh snapshot and update manifest
    await this.createSnapshot();
    await this.updateManifest(events.length);
    log("Reconciliation complete");
  }

  /**
   * Push local Zotero library to cloud, overwriting cloud data.
   * Wipes cloud changelogs/snapshots and re-uploads everything from local.
   */
  async pushToCloud(): Promise<string> {
    if (this.connections.length === 0 && !this.provider) {
      throw new Error("No cloud provider connected. Connect a provider in Settings first.");
    }
    if (this._isSyncing) {
      throw new Error("A sync is already in progress — wait for it to finish.");
    }

    // SAFETY GUARD: "Push local → Cloud" deletes the entire cloud folder and
    // replaces it with the local library. Pushing an EMPTY local library would
    // wipe all cloud data (attachments included). Refuse it and point the user
    // to the safe alternatives. (To intentionally clear the cloud, use
    // "Delete cloud data".)
    const guardLibraryID = Zotero.Libraries.userLibraryID;
    const guardItems = await Zotero.Items.getAll(guardLibraryID);
    const guardItemCount = guardItems.filter((i: any) => !i.isFeedItem).length;
    const guardCollectionCount = Zotero.Collections.getByLibrary(guardLibraryID).length;
    if (guardItemCount === 0 && guardCollectionCount === 0) {
      throw new Error(
        "Refusing to push: your local library is EMPTY. 'Push local → Cloud' " +
        "would delete everything on the cloud and replace it with nothing. " +
        "Use 'Pull Cloud → Local' to restore from cloud, or 'Force full sync' to merge.",
      );
    }

    this._isSyncing = true;
    this.stateManager.status = "syncing";
    log(`Push to cloud: overwriting cloud with local library (${guardItemCount} items, ${guardCollectionCount} collections)...`);

    const em = (e: unknown) => (e instanceof Error ? e.message : String(e));
    const errors: string[] = [];
    let pushedTo = 0;

    try {
      await ChangeLog.init();
      this.stateManager.resetClock();
      try { await Zotero.DB.queryAsync("DELETE FROM zotcloudChangeLog"); } catch {}

      const runOnProvider = async (conn?: ProviderConnection) => {
        const label = conn ? conn.key : (this.provider?.getName?.() ?? "provider");
        if (conn) {
          this.provider = conn.provider;
          this._activeCloudFolder = conn.cloudFolder;
          this.attachmentSync = conn.attachmentSync;
        }
        if (!this.provider) throw new Error(`${label}: no provider instance`);

        const cloudFolder = this.getCloudFolder();

        // Delete existing cloud data
        await this.deleteCloudFolder(cloudFolder);

        // Re-create and push
        await this.firstDeviceSetup();

        pushedTo++;
        if (conn) conn.lastSyncedTimestamp = Date.now();
      };

      if (this.connections.length > 0) {
        for (const conn of this.connections) {
          if (!conn.enabled) continue;
          try {
            await runOnProvider(conn);
          } catch (err) {
            errors.push(`${conn.key}: ${em(err)}`);
            logError(`Push to cloud failed for ${conn.key}`, err);
          }
        }
        this.saveConnectionState();
      } else {
        try {
          await runOnProvider();
        } catch (err) {
          errors.push(em(err));
          logError("Push to cloud failed", err);
        }
      }

      this.stateManager.lastSyncTimestamp = Date.now();
      this.stateManager.pendingChanges = 0;

      // No provider accepted the push → surface why.
      if (pushedTo === 0) {
        this.stateManager.status = "error";
        throw new Error(errors.length ? errors.join(" | ") : "push did not reach any provider");
      }

      this.stateManager.status = "idle";
      this.stateManager.lastSuccessfulSync = Date.now();
      const summary = `Pushed local library to ${pushedTo} provider(s)`;
      log("Push to cloud completed — " + summary);
      if (errors.length) log("Push completed with errors: " + errors.join(" | "));
      return errors.length ? `${summary} (errors: ${errors.join("; ")})` : summary;
    } catch (err) {
      this.stateManager.status = "error";
      logError("Push to cloud failed", err);
      throw err;
    } finally {
      this._isSyncing = false;
    }
  }

  /**
   * Pull from cloud to local Zotero, overwriting local data with cloud state.
   * Downloads snapshot and applies all items from cloud. Does NOT delete local items
   * that aren't on cloud — only adds/updates from cloud.
   */
  async pullFromCloud(): Promise<string> {
    if (this.connections.length === 0 && !this.provider) {
      throw new Error("No cloud provider connected. Connect a provider in Settings first.");
    }
    // pullFromCloud force-resets the syncing flag — it can get stuck after an
    // earlier sync errored in a way that bypassed its finally block.
    if (this._isSyncing) {
      log("Sync flag was set — forcing reset to allow pull");
    }

    this._isSyncing = true;
    this.stateManager.status = "syncing";
    log("Pull from cloud: applying cloud state to local library...");

    const em = (e: unknown) => (e instanceof Error ? e.message : String(e));
    const errors: string[] = [];     // hard failures (surface to user)
    const warnings: string[] = [];   // non-fatal (e.g. attachments)
    const summaries: string[] = [];
    let totalApplied = 0;

    try {
      await ChangeLog.init();
      this.stateManager.resetClock();
      try { await Zotero.DB.queryAsync("DELETE FROM zotcloudChangeLog"); } catch {}

      const runOnProvider = async (conn?: ProviderConnection): Promise<void> => {
        const label = conn ? conn.key : (this.provider?.getName?.() ?? "provider");
        if (conn) {
          this.provider = conn.provider;
          this._activeCloudFolder = conn.cloudFolder;
          this.attachmentSync = conn.attachmentSync;
        }
        if (!this.provider) throw new Error(`${label}: no provider instance`);

        const cloudFolder = this.getCloudFolder();

        // Download manifest (proves the folder is reachable + authenticated)
        let manifest: CloudManifest;
        try {
          const data = await this.provider.download(`${cloudFolder}/manifest.json`);
          manifest = JSON.parse(this.decodeBuffer(data));
        } catch (err) {
          throw new Error(`${label}: cannot read ${cloudFolder}/manifest.json — ${em(err)}`);
        }

        const libraryID = Zotero.Libraries.userLibraryID;

        // Apply a list of ChangeEvents in dependency order (collections →
        // parent items → child items). Returns counts for reporting.
        const applyEvents = async (evts: ChangeEvent[]) => {
          let applied = 0, failed = 0, firstErr = "";
          const ordered = async (match: (e: ChangeEvent) => boolean) => {
            for (const event of evts.filter(match)) {
              try {
                await this.applyRemoteEventForced(event);
                applied++;
              } catch (err) {
                failed++;
                if (!firstErr) firstErr = em(err);
                logError(`Failed to apply ${event.entityType} ${event.entityKey}`, err);
              }
            }
          };
          await ordered((e) => e.entityType === "collection");
          await ordered((e) => e.entityType === "item" && !e.data.parentKey);
          await ordered((e) => e.entityType === "item" && !!e.data.parentKey);
          return { applied, failed, firstErr };
        };

        let providerApplied = 0;

        // 1) Apply the newest NON-EMPTY snapshot. Older snapshots are tried if
        //    the newest is empty (a prior bad push can leave an empty snapshot).
        let snapshotFiles: FileMetadata[] = [];
        try {
          const snapshots = await this.provider.list(`${cloudFolder}/snapshots`);
          snapshotFiles = snapshots
            .filter((f) => f.name.endsWith(".json") && !f.name.endsWith(".meta.json") && !f.isDirectory)
            .sort((a, b) => b.name.localeCompare(a.name));
        } catch (err) {
          warnings.push(`${label}: cannot list snapshots — ${em(err)}`);
        }
        let snapshotApplied = false;
        for (const snap of snapshotFiles) {
          let events: ChangeEvent[];
          try {
            const snapshotData = await this.provider.download(snap.path);
            events = JSON.parse(this.decodeBuffer(snapshotData));
          } catch (err) {
            warnings.push(`${label}: failed to read snapshot ${snap.name} — ${em(err)}`);
            continue;
          }
          if (!Array.isArray(events) || events.length === 0) {
            log(`Snapshot ${snap.name} is empty — trying older snapshot`);
            continue;
          }
          log(`Applying snapshot ${snap.name} (${events.length} events)`);
          const r = await applyEvents(events);
          providerApplied += r.applied;
          snapshotApplied = true;
          summaries.push(`${label}: snapshot ${snap.name} → ${r.applied}/${events.length}` + (r.failed ? ` (${r.failed} failed: ${r.firstErr})` : ""));
          break;
        }
        if (!snapshotApplied) {
          summaries.push(`${label}: no usable snapshot (${snapshotFiles.length} file(s), all empty/unreadable)`);
        }

        // 2) Replay ALL changelog batches from ALL devices (forced). This is how
        //    incrementally-synced libraries store their data; a directional pull
        //    must replay them too, otherwise data that never made it into a
        //    snapshot is lost.
        let changelogApplied = 0;
        let changelogBatches = 0;
        try {
          const deviceDirs = await this.provider.list(`${cloudFolder}/changelog`);
          for (const dir of deviceDirs) {
            if (!dir.isDirectory) continue;
            let batchFiles: FileMetadata[];
            try {
              batchFiles = await this.provider.list(dir.path);
            } catch { continue; }
            batchFiles = batchFiles
              .filter((f) => f.name.endsWith(".json") && !f.isDirectory)
              .sort((a, b) => a.name.localeCompare(b.name));
            for (const bf of batchFiles) {
              let events: ChangeEvent[];
              try {
                const data = await this.provider.download(bf.path);
                events = JSON.parse(this.decodeBuffer(data));
              } catch (err) {
                warnings.push(`${label}: failed to read changelog ${bf.name} — ${em(err)}`);
                continue;
              }
              if (!Array.isArray(events) || events.length === 0) continue;
              changelogBatches++;
              const r = await applyEvents(events);
              changelogApplied += r.applied;
            }
          }
        } catch (err) {
          log(`No changelog folder for ${label} (or unreadable): ${em(err)}`);
        }
        if (changelogBatches > 0) {
          summaries.push(`${label}: changelog ${changelogBatches} batch(es) → ${changelogApplied} events`);
        }

        providerApplied += changelogApplied;
        totalApplied += providerApplied;

        if (providerApplied === 0) {
          throw new Error(`${label}: cloud has no recoverable data (snapshots: ${snapshotFiles.length}, changelog batches: ${changelogBatches})`);
        }

        // Download attachments (non-fatal — reported as a warning if it fails)
        if (this.attachmentSync) {
          try {
            // Read the attachment manifest. Try the constructed path first; if the
            // server 404s on it (some WebDAV servers reject constructed deep paths),
            // fall back to listing the attachments folder and using the exact href
            // it returns for _manifest.json — same approach that works for snapshots.
            const attachManifestPath = `${cloudFolder}/attachments/_manifest.json`;
            let attachManifestData: ArrayBuffer;
            try {
              attachManifestData = await this.provider.download(attachManifestPath);
            } catch (firstErr) {
              const entries = await this.provider.list(`${cloudFolder}/attachments`);
              const manifestEntry = entries.find((f) => f.name === "_manifest.json" && !f.isDirectory);
              if (!manifestEntry) throw firstErr;
              log(`Attachment manifest via listing href: ${manifestEntry.path}`);
              attachManifestData = await this.provider.download(manifestEntry.path);
            }
            const attachManifest = JSON.parse(this.decodeBuffer(attachManifestData));
            const files = attachManifest.files || {};

            const toDownload: Array<{ item: any; hash: string }> = [];
            for (const hash of Object.keys(files)) {
              const entry = files[hash];
              if (!entry.itemKey) continue;
              const item = Zotero.Items.getByLibraryAndKey(libraryID, entry.itemKey);
              if (!item || !item.isAttachment()) continue;
              try {
                const filePath = await item.getFilePathAsync();
                if (filePath && await IOUtils.exists(filePath)) continue;
              } catch {}
              toDownload.push({ item, hash });
            }

            if (toDownload.length > 0) {
              log(`Downloading ${toDownload.length} attachments from cloud...`);
              await this.attachmentSync.downloadMissing(toDownload);
            }
          } catch (err) {
            warnings.push(`${label}: attachment download skipped — ${em(err)}`);
            log(`Attachment download skipped for ${label} (non-fatal): ${em(err)}`);
          }
        }

        this.stateManager.mergeClock(manifest.vectorClock);
        if (conn) conn.lastSyncedTimestamp = Date.now();
      };

      if (this.connections.length > 0) {
        for (const conn of this.connections) {
          if (!conn.enabled) continue;
          try {
            await runOnProvider(conn);
          } catch (err) {
            errors.push(em(err));
            logError(`Pull from cloud failed for ${conn.key}`, err);
          }
        }
        this.saveConnectionState();
      } else {
        try {
          await runOnProvider();
        } catch (err) {
          errors.push(em(err));
          logError("Pull from cloud failed", err);
        }
      }

      this.stateManager.lastSyncTimestamp = Date.now();
      this.stateManager.pendingChanges = 0;

      // Nothing applied → the pull genuinely failed; tell the caller exactly why.
      if (totalApplied === 0) {
        this.stateManager.status = "error";
        throw new Error(errors.length ? errors.join(" | ") : "nothing found on cloud to pull");
      }

      this.stateManager.status = "idle";
      this.stateManager.lastSuccessfulSync = Date.now();
      const summary = `Pulled ${totalApplied} items — ${summaries.join("; ")}`;
      log("Pull from cloud completed — " + summary);
      const allWarnings = [...errors, ...warnings];
      if (allWarnings.length) log("Pull completed with warnings: " + allWarnings.join(" | "));
      return allWarnings.length ? `${summary} (warnings: ${allWarnings.join("; ")})` : summary;
    } catch (err) {
      this.stateManager.status = "error";
      logError("Pull from cloud failed", err);
      throw err;
    } finally {
      this._isSyncing = false;
    }
  }

  /**
   * Apply a remote event, ignoring the deviceId check (used by directional sync).
   */
  private async applyRemoteEventForced(event: ChangeEvent): Promise<void> {
    this.changeTracker.isSyncing = true;
    try {
      if (event.entityType === "item") {
        await this.applyItemEvent(event);
      } else if (event.entityType === "collection") {
        await this.applyCollectionEvent(event);
      }
    } catch (err) {
      logError(`Failed to apply ${event.type} for ${event.entityKey}`, err);
    } finally {
      this.changeTracker.isSyncing = false;
    }
  }

  /**
   * Delete all cloud data for all connected providers.
   * Recursively deletes the ZotCloud folder and resets local state.
   */
  async deleteAllCloudData(): Promise<void> {
    if (this._isSyncing) {
      log("Sync in progress, cannot delete");
      return;
    }

    this._isSyncing = true;
    log("Deleting all cloud data...");

    try {
      this.stop();

      const runOnProvider = async (conn?: ProviderConnection) => {
        if (conn) {
          this.provider = conn.provider;
          this._activeCloudFolder = conn.cloudFolder;
        }
        if (!this.provider) return;

        const cloudFolder = this.getCloudFolder();
        await this.deleteCloudFolder(cloudFolder);
        log(`Deleted cloud data from ${cloudFolder}`);
      };

      if (this.connections.length > 0) {
        for (const conn of this.connections) {
          try {
            await runOnProvider(conn);
          } catch (err) {
            logError(`Delete failed for ${conn.key}`, err);
          }
        }
      } else {
        await runOnProvider();
      }

      // Reset local state
      this.stateManager.resetClock();
      this.stateManager.status = "idle";
      this.stateManager.lastSyncTimestamp = 0;
      this.stateManager.lastSuccessfulSync = 0;
      this.stateManager.pendingChanges = 0;
      try { await Zotero.DB.queryAsync("DELETE FROM zotcloudChangeLog"); } catch {}

      log("All cloud data deleted and local state reset");
    } catch (err) {
      logError("Delete cloud data failed", err);
    } finally {
      this._isSyncing = false;
    }
  }

  /**
   * Recursively delete a cloud folder.
   * Lists contents depth-first, deletes files then directories.
   */
  private async deleteCloudFolder(folderPath: string): Promise<void> {
    if (!this.provider) return;

    try {
      const items = await this.provider.list(folderPath);
      for (const item of items) {
        if (item.isDirectory) {
          await this.deleteCloudFolder(item.path);
        } else {
          try {
            await this.provider.delete(item.path);
          } catch (err) {
            logError(`Failed to delete file ${item.path}`, err);
          }
        }
      }
    } catch {
      // Folder may not exist or is empty
    }

    // Delete the folder itself
    try {
      await this.provider.delete(folderPath);
    } catch {
      // May already be gone
    }
  }

  // --- Initial sync helpers ---

  /** First device: create cloud structure and export full library */
  private async firstDeviceSetup(): Promise<void> {
    if (!this.provider) return;

    const cloudFolder = this.getCloudFolder();
    log("First device setup — creating cloud structure");

    // Create directory structure
    await this.provider.mkdir(cloudFolder);
    await this.provider.mkdir(`${cloudFolder}/changelog`);
    await this.provider.mkdir(
      `${cloudFolder}/changelog/${this.stateManager.deviceId}`,
    );
    await this.provider.mkdir(`${cloudFolder}/attachments`);
    await this.provider.mkdir(`${cloudFolder}/snapshots`);

    // Export entire library as a batch of add events
    const events = await this.exportFullLibrary();
    const regularItems = events.filter(e => e.entityType === "item" && e.data.fields?.itemType !== "attachment" && e.data.fields?.itemType !== "note" && !e.data.annotationData);
    const noteItems = events.filter(e => e.entityType === "item" && (e.data.fields?.itemType === "note" || e.data.annotationData));
    const attachItems = events.filter(e => e.entityType === "item" && e.data.attachmentPath);
    const collectionItems = events.filter(e => e.entityType === "collection");
    log(`Exported ${events.length} total events: ${regularItems.length} references, ${attachItems.length} attachments, ${collectionItems.length} collections`);

    if (events.length > 0) {
      // Upload attachments first (populates attachmentHash in events)
      if (this.attachmentSync) {
        const attachmentEvents = events.filter(
          (e) => e.entityType === "item" && e.data.attachmentPath,
        );
        log(`Found ${attachmentEvents.length} attachment events to upload`);
        let uploadedCount = 0;
        let failedCount = 0;
        for (let i = 0; i < attachmentEvents.length; i++) {
          const event = attachmentEvents[i];
          try {
            const item = Zotero.Items.getByLibraryAndKey(
              event.libraryID,
              event.entityKey,
            );
            if (item) {
              const hash = await this.attachmentSync.uploadAttachment(item);
              if (hash) {
                event.data.attachmentHash = hash;
                uploadedCount++;
              } else {
                failedCount++;
              }
            }
          } catch (err) {
            failedCount++;
            logError(`Attachment upload failed for ${event.entityKey}`, err);
          }
          if ((i + 1) % 50 === 0 || i === attachmentEvents.length - 1) {
            log(`Attachment upload progress: ${i + 1}/${attachmentEvents.length} (${uploadedCount} uploaded, ${failedCount} skipped)`);
          }
        }
        log(`Attachment upload complete: ${uploadedCount} uploaded, ${failedCount} skipped/failed`);
      }

      // Save to changelog and upload
      await ChangeLog.appendBatch(events);
      log(`Uploading ${events.length} changelog events...`);

      const batchSize = 1000;
      for (let i = 0; i < events.length; i += batchSize) {
        const batch = events.slice(i, i + batchSize);
        const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const remotePath = `${cloudFolder}/changelog/${this.stateManager.deviceId}/${batchId}.json`;
        await this.provider.upload(remotePath, JSON.stringify(batch));
        log(`Uploaded changelog batch ${i / batchSize + 1}: ${batch.length} events`);
      }
    }

    // Create initial snapshot
    log("Creating snapshot with all references and collections...");
    await this.createSnapshot();

    // Create manifest
    await this.updateManifest(events.length);
    log(`First device setup complete: ${regularItems.length} references + ${noteItems.length} notes/annotations + ${attachItems.length} attachments synced to cloud`);
  }

  /** Join existing sync: download and apply remote changes */
  private async joinExistingSync(manifest: CloudManifest): Promise<void> {
    if (!this.provider) return;

    const cloudFolder = this.getCloudFolder();
    log(
      `Joining existing sync (${Object.keys(manifest.devices).length} devices)`,
    );

    await this.provider.mkdir(
      `${cloudFolder}/changelog/${this.stateManager.deviceId}`,
    );

    // Try to restore from latest snapshot first
    let snapshotTimestamp = 0;
    try {
      const snapshots = await this.provider.list(`${cloudFolder}/snapshots`);
      const snapshotFiles = snapshots
        .filter((f) => f.name.endsWith(".json") && !f.name.endsWith(".meta.json") && !f.isDirectory)
        .sort((a, b) => b.name.localeCompare(a.name));

      if (snapshotFiles.length > 0) {
        log(`Restoring from snapshot: ${snapshotFiles[0].name}`);
        const snapshotData = await this.provider.download(snapshotFiles[0].path);
        const libraryID = Zotero.Libraries.userLibraryID;
        await Snapshot.restore(snapshotData, libraryID);

        const tsMatch = snapshotFiles[0].name.match(/^(\d+)\./);
        if (tsMatch) snapshotTimestamp = parseInt(tsMatch[1], 10);

        log(`Snapshot restored, will apply changelogs after ${new Date(snapshotTimestamp).toISOString()}`);
      }
    } catch (err) {
      logError("Snapshot restore failed, falling back to full changelog replay", err);
    }

    // Download and apply changelogs
    for (const remoteDeviceId of Object.keys(manifest.devices)) {
      if (remoteDeviceId === this.stateManager.deviceId) continue;

      const changelogDir = `${cloudFolder}/changelog/${remoteDeviceId}`;
      let files;
      try {
        files = await this.provider.list(changelogDir);
      } catch {
        log(`No changelogs found for device ${remoteDeviceId}`);
        continue;
      }

      files.sort((a, b) => a.name.localeCompare(b.name));

      for (const file of files) {
        if (!file.name.endsWith(".json") || file.isDirectory) continue;

        if (snapshotTimestamp > 0) {
          const tsMatch = file.name.match(/^(\d+)/);
          if (tsMatch) {
            const fileTs = parseInt(tsMatch[1], 10);
            if (fileTs <= snapshotTimestamp) continue;
          }
        }

        try {
          const data = await this.provider.download(file.path);
          const events: ChangeEvent[] = JSON.parse(this.decodeBuffer(data));

          log(`Applying ${events.length} events from ${file.name}`);
          for (const event of events) {
            await this.applyRemoteEvent(event);
          }
        } catch (err) {
          logError(`Failed to process changelog ${file.path}`, err);
        }
      }
    }

    // Download missing attachments from cloud
    if (this.attachmentSync) {
      try {
        log("Downloading attachments from cloud...");
        const attachManifestPath = `${cloudFolder}/attachments/_manifest.json`;
        const attachManifestData = await this.provider.download(attachManifestPath);
        const attachManifest = JSON.parse(this.decodeBuffer(attachManifestData));
        const files = attachManifest.files || {};
        const hashes = Object.keys(files);
        log(`Attachment manifest has ${hashes.length} files`);

        if (hashes.length > 0) {
          const libraryID = Zotero.Libraries.userLibraryID;
          const attachmentEvents: Array<{ item: any; hash: string }> = [];

          for (const hash of hashes) {
            const entry = files[hash];
            // Find the Zotero item by key
            const itemKey = entry.itemKey;
            if (!itemKey) continue;

            const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
            if (!item || !item.isAttachment()) continue;

            // Check if file already exists locally
            try {
              const filePath = await item.getFilePathAsync();
              if (filePath && await IOUtils.exists(filePath)) continue;
            } catch { /* no local file */ }

            attachmentEvents.push({ item, hash });
          }

          log(`${attachmentEvents.length} attachments need downloading`);
          if (attachmentEvents.length > 0) {
            await this.attachmentSync.downloadMissing(attachmentEvents);
          }
        }
      } catch (err) {
        logError("Attachment download during join failed (non-fatal)", err);
      }
    }

    this.stateManager.mergeClock(manifest.vectorClock);
    await this.updateManifest();
    log("Joined existing sync successfully");
  }

  /** Export entire Zotero library as ChangeEvent[] */
  private async exportFullLibrary(): Promise<ChangeEvent[]> {
    const events: ChangeEvent[] = [];
    const libraryID = Zotero.Libraries.userLibraryID;

    const syncStandaloneNotes = Zotero.Prefs.get("extensions.zotcloud.syncStandaloneNotes");
    const syncChildNotes = Zotero.Prefs.get("extensions.zotcloud.syncChildNotes");
    const syncAnnotations = Zotero.Prefs.get("extensions.zotcloud.syncAnnotations");

    const items = await Zotero.Items.getAll(libraryID);
    for (const item of items) {
      if (item.isFeedItem) continue;
      if ((item as any).isAnnotation?.() && !syncAnnotations) continue;
      if (item.isNote?.()) {
        if (item.parentKey && !syncChildNotes) continue;
        if (!item.parentKey && !syncStandaloneNotes) continue;
      }

      const data = await this.serializeItem(item);
      events.push({
        id: generateUUID(),
        deviceId: this.stateManager.deviceId,
        timestamp: Date.now(),
        vectorClock: this.stateManager.incrementClock(),
        type: "add",
        entityType: "item",
        entityKey: item.key,
        libraryID: item.libraryID,
        data,
      });
    }

    const collections = Zotero.Collections.getByLibrary(libraryID);
    for (const collection of collections) {
      events.push({
        id: generateUUID(),
        deviceId: this.stateManager.deviceId,
        timestamp: Date.now(),
        vectorClock: this.stateManager.incrementClock(),
        type: "add",
        entityType: "collection",
        entityKey: collection.key,
        libraryID: collection.libraryID,
        data: {
          fields: {
            name: collection.name,
            parentKey: collection.parentKey || null,
          },
        },
      });
    }

    return events;
  }

  /** Serialize a Zotero item into ChangeEventData */
  private async serializeItem(item: any): Promise<ChangeEvent["data"]> {
    const data: ChangeEvent["data"] = {
      fields: {},
      creators: [],
      tags: [],
      collections: [],
    };

    data.fields!.itemType = Zotero.ItemTypes.getName(item.itemTypeID);

    const fieldIDs = Zotero.ItemFields.getItemTypeFields(item.itemTypeID);
    for (const fieldID of fieldIDs) {
      const fieldName = Zotero.ItemFields.getName(fieldID);
      try {
        const value = item.getField(fieldName);
        if (value !== undefined && value !== null && value !== "") {
          data.fields![fieldName] = value;
        }
      } catch {
        // Some fields may not be readable
      }
    }

    data.creators = item.getCreators().map((c: any) => ({
      firstName: c.firstName || "",
      lastName: c.lastName || "",
      creatorType: Zotero.CreatorTypes.getName(c.creatorTypeID),
    }));

    data.tags = item.getTags();

    data.collections = item
      .getCollections()
      .map((colID: number) => Zotero.Collections.get(colID)?.key)
      .filter(Boolean);

    // Parent key for child items
    if (item.parentKey) {
      data.parentKey = item.parentKey;
    }

    if (item.isAttachment()) {
      try {
        const path = await item.getFilePathAsync();
        if (path) {
          data.attachmentPath = path;

          try {
            const { computeFileHash } = await import("../crypto/hashing");
            const fileExists = await IOUtils.exists(path);
            if (fileExists) {
              data.attachmentHash = await computeFileHash(path);
            }
          } catch {
            // Hash computation may fail for missing/locked files
          }
        }
      } catch {
        // File may not exist
      }
    }

    // Note content
    if (item.isNote?.()) {
      try { data.noteContent = item.getNote(); } catch { /* skip */ }
    }

    // Annotation data
    if ((item as any).isAnnotation?.()) {
      try {
        data.annotationData = {
          type: item.annotationType || "",
          pageLabel: item.annotationPageLabel || "",
          position: item.annotationPosition || "{}",
          color: item.annotationColor || "",
          comment: item.annotationComment || "",
          text: item.annotationText || "",
          sortIndex: item.annotationSortIndex || "",
          tags: item.getTags(),
        };
      } catch { /* skip */ }
    }

    return data;
  }

  // --- Incremental sync helpers ---

  /**
   * Push local changes to the active provider since a given timestamp.
   * Returns the latest event timestamp that was pushed, or 0 if nothing pushed.
   */
  private async pushSince(sinceTimestamp: number): Promise<number> {
    if (!this.provider) return 0;

    const events = await ChangeLog.getSince(sinceTimestamp);
    if (events.length === 0) {
      log("No local changes to push");
      return 0;
    }

    const cloudFolder = this.getCloudFolder();
    const deviceId = this.stateManager.deviceId;

    // Ensure our changelog directory exists
    await this.provider.mkdir(`${cloudFolder}/changelog/${deviceId}`);

    // Handle attachments: upload for add/modify, delete for delete
    if (this.attachmentSync) {
      const attachmentEvents = events.filter(
        (e) =>
          e.entityType === "item" &&
          (e.type === "add" || e.type === "modify") &&
          e.data.attachmentPath,
      );
      if (attachmentEvents.length > 0) {
        log(`Uploading ${attachmentEvents.length} attachments...`);
        for (const event of attachmentEvents) {
          const item = Zotero.Items.getByLibraryAndKey(
            event.libraryID,
            event.entityKey,
          );
          if (item) {
            const hash = await this.attachmentSync.uploadAttachment(item);
            if (hash) {
              event.data.attachmentHash = hash;
            }
          }
        }
      }

      const deleteEvents = events.filter(
        (e) => e.entityType === "item" && e.type === "delete",
      );
      if (deleteEvents.length > 0) {
        log(`Processing ${deleteEvents.length} delete events for cloud attachments...`);
        for (const event of deleteEvents) {
          try {
            const count = await this.attachmentSync.deleteAttachmentByItemKey(event.entityKey);
            if (count > 0) {
              log(`Deleted ${count} cloud attachment(s) for item ${event.entityKey}`);
            }
          } catch (err) {
            logError(`Failed to delete cloud attachment for ${event.entityKey}`, err);
          }
        }
      }
    }

    // Batch events (max 1000 per batch per spec)
    const batchSize = 1000;
    for (let i = 0; i < events.length; i += batchSize) {
      const batch = events.slice(i, i + batchSize);
      const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const remotePath = `${cloudFolder}/changelog/${deviceId}/${batchId}.json`;

      await this.provider.upload(remotePath, JSON.stringify(batch));
      log(`Pushed batch ${batchId} (${batch.length} events)`);
    }

    await this.updateManifest();

    return events[events.length - 1].timestamp;
  }

  /** Pull remote changes from cloud */
  private async pull(): Promise<void> {
    if (!this.provider) return;

    const cloudFolder = this.getCloudFolder();

    // Read remote manifest
    let manifest: CloudManifest;
    try {
      const data = await this.provider.download(
        `${cloudFolder}/manifest.json`,
      );
      manifest = JSON.parse(this.decodeBuffer(data));
    } catch {
      log("No remote manifest found, nothing to pull");
      return;
    }

    // Check if there are remote changes
    if (!this.stateManager.hasRemoteChanges(manifest.vectorClock)) {
      log("No remote changes detected");
      return;
    }

    // Collect all unsynced local events for conflict detection
    const localEvents = await ChangeLog.getUnsynced();
    const localEventsByKey = new Map<string, ChangeEvent>();
    for (const event of localEvents) {
      localEventsByKey.set(
        `${event.entityType}:${event.entityKey}`,
        event,
      );
    }

    // Process each remote device's changelog
    for (const [remoteDeviceId, counter] of Object.entries(
      manifest.vectorClock,
    )) {
      if (remoteDeviceId === this.stateManager.deviceId) continue;

      const ourCounter =
        this.stateManager.getClock()[remoteDeviceId] || 0;
      if (counter <= ourCounter) continue;

      const changelogDir = `${cloudFolder}/changelog/${remoteDeviceId}`;
      let files;
      try {
        files = await this.provider.list(changelogDir);
      } catch {
        continue;
      }

      files.sort((a, b) => a.name.localeCompare(b.name));

      for (const file of files) {
        if (!file.name.endsWith(".json") || file.isDirectory) continue;

        try {
          const data = await this.provider.download(file.path);
          const events: ChangeEvent[] = JSON.parse(this.decodeBuffer(data));

          for (const remoteEvent of events) {
            const key = `${remoteEvent.entityType}:${remoteEvent.entityKey}`;
            const localEvent = localEventsByKey.get(key);

            if (localEvent) {
              const conflict = this.conflictResolver.detectConflict(
                localEvent,
                remoteEvent,
              );

              if (conflict) {
                const winner = this.conflictResolver.autoResolve(
                  localEvent,
                  remoteEvent,
                  conflict,
                );

                if (winner === null) {
                  log(
                    `Unresolvable conflict on ${key}, field: ${conflict.fieldName}`,
                  );
                  continue;
                }

                if (winner === remoteEvent) {
                  await this.applyRemoteEvent(remoteEvent);
                }
              } else {
                const merged = this.conflictResolver.mergeEvents(
                  localEvent,
                  remoteEvent,
                );
                await this.applyRemoteEvent(merged);
              }
            } else {
              await this.applyRemoteEvent(remoteEvent);
            }
          }
        } catch (err) {
          logError(`Failed to process changelog ${file.path}`, err);
        }
      }
    }

    this.stateManager.mergeClock(manifest.vectorClock);
  }

  /** Apply a single remote change event to the local Zotero library */
  private async applyRemoteEvent(event: ChangeEvent): Promise<void> {
    if (event.deviceId === this.stateManager.deviceId) return;

    this.changeTracker.isSyncing = true;

    try {
      if (event.entityType === "item") {
        await this.applyItemEvent(event);
      } else if (event.entityType === "collection") {
        await this.applyCollectionEvent(event);
      }
    } catch (err) {
      logError(`Failed to apply ${event.type} for ${event.entityKey}`, err);
    } finally {
      this.changeTracker.isSyncing = false;
    }
  }

  private async applyItemEvent(event: ChangeEvent): Promise<void> {
    switch (event.type) {
      case "add":
      case "modify": {
        let item = Zotero.Items.getByLibraryAndKey(
          event.libraryID,
          event.entityKey,
        );

        if (!item && event.type === "modify") {
          log(`Item ${event.entityKey} not found locally, treating modify as add`);
        }

        if (!item) {
          item = new Zotero.Item();
          item.libraryID = event.libraryID;
          item.key = event.entityKey;
        }

        if (event.data.fields?.itemType) {
          const typeID = Zotero.ItemTypes.getID(event.data.fields.itemType);
          if (typeID) item.setType(typeID);
        }

        for (const [field, value] of Object.entries(
          event.data.fields || {},
        )) {
          if (field === "itemType") continue;
          try {
            item.setField(field, value);
          } catch {
            // Skip invalid fields silently
          }
        }

        if (event.data.creators?.length) {
          item.setCreators(
            event.data.creators.map((c) => ({
              firstName: c.firstName,
              lastName: c.lastName,
              creatorTypeID: Zotero.CreatorTypes.getID(c.creatorType),
            })),
          );
        }

        if (event.data.tags) {
          item.setTags(event.data.tags);
        }

        // Parent key for child notes, annotations, attachments
        if (event.data.parentKey) {
          item.parentKey = event.data.parentKey;
        }

        // Note content
        if (event.data.noteContent !== undefined) {
          try { item.setNote(event.data.noteContent); } catch { /* skip */ }
        }

        // Annotation data
        if (event.data.annotationData) {
          const ann = event.data.annotationData;
          try {
            item.annotationType = ann.type;
            if (ann.pageLabel) item.annotationPageLabel = ann.pageLabel;
            if (ann.position) item.annotationPosition = ann.position;
            if (ann.color) item.annotationColor = ann.color;
            if (ann.comment !== undefined) item.annotationComment = ann.comment;
            if (ann.text !== undefined) item.annotationText = ann.text;
            if (ann.sortIndex) item.annotationSortIndex = ann.sortIndex;
          } catch { /* some annotation props may not be settable */ }
        }

        await item.saveTx({ skipNotifier: true });

        if (event.data.attachmentHash && this.attachmentSync && item.isAttachment()) {
          await this.attachmentSync.downloadAttachment(
            item,
            event.data.attachmentHash,
          );
        }
        break;
      }

      case "delete": {
        if (this.attachmentSync) {
          try {
            await this.attachmentSync.deleteAttachmentByItemKey(event.entityKey);
          } catch {
            // Best-effort cloud cleanup
          }
        }

        const item = Zotero.Items.getByLibraryAndKey(
          event.libraryID,
          event.entityKey,
        );
        if (item) {
          await item.eraseTx({ skipNotifier: true });
        }
        break;
      }
    }
  }

  private async applyCollectionEvent(event: ChangeEvent): Promise<void> {
    switch (event.type) {
      case "add":
      case "modify": {
        let collection = Zotero.Collections.getByLibraryAndKey(
          event.libraryID,
          event.entityKey,
        );

        if (!collection) {
          collection = new Zotero.Collection();
          collection.libraryID = event.libraryID;
          collection.key = event.entityKey;
        }

        if (event.data.fields?.name) {
          collection.name = event.data.fields.name;
        }

        await collection.saveTx({ skipNotifier: true });
        break;
      }

      case "delete": {
        const collection = Zotero.Collections.getByLibraryAndKey(
          event.libraryID,
          event.entityKey,
        );
        if (collection) {
          await collection.eraseTx({ skipNotifier: true });
        }
        break;
      }
    }
  }

  /** Update the remote manifest with our device info and vector clock */
  private async updateManifest(itemCount?: number): Promise<void> {
    if (!this.provider) return;

    const cloudFolder = this.getCloudFolder();
    const manifestPath = `${cloudFolder}/manifest.json`;

    let manifest: CloudManifest;

    try {
      const data = await this.provider.download(manifestPath);
      manifest = JSON.parse(this.decodeBuffer(data));
    } catch {
      manifest = {
        version: "1.0",
        schemaVersion: 1,
        libraryName: "My Zotero Library",
        libraryID: Zotero.Libraries.userLibraryID || 1,
        createdAt: new Date().toISOString(),
        lastModified: new Date().toISOString(),
        devices: {},
        vectorClock: {},
        totalItems: 0,
        totalAttachments: 0,
        snapshotInterval:
          (Zotero.Prefs.get(
            "extensions.zotcloud.snapshotInterval",
          ) as number) || 86400,
      };
    }

    manifest.devices[this.stateManager.deviceId] = {
      name: this.stateManager.getDeviceName(),
      lastSeen: new Date().toISOString(),
      zoteroVersion: Zotero.version || "unknown",
      pluginVersion: "0.1.0",
    };

    const ourClock = this.stateManager.getClock();
    for (const [deviceId, counter] of Object.entries(ourClock)) {
      manifest.vectorClock[deviceId] = Math.max(
        manifest.vectorClock[deviceId] || 0,
        counter,
      );
    }

    if (itemCount !== undefined) {
      manifest.totalItems = itemCount;
    }

    manifest.lastModified = new Date().toISOString();

    await this.provider.upload(
      manifestPath,
      JSON.stringify(manifest, null, 2),
    );
  }

  // --- Multi-provider state management ---

  /** Save connection state to prefs (for restore on restart) */
  saveConnectionState(): void {
    const configs: ProviderConnectionConfig[] = this.connections.map(c => ({
      key: c.key,
      type: c.key, // key matches provider type
      cloudFolder: c.cloudFolder,
      lastSyncedTimestamp: c.lastSyncedTimestamp,
      enabled: c.enabled,
    }));
    Zotero.Prefs.set("extensions.zotcloud.providers", JSON.stringify(configs));

    // Also update legacy single-provider pref for backward compat
    if (configs.length > 0) {
      Zotero.Prefs.set("extensions.zotcloud.provider", configs[0].key);
    }
  }

  /** Load saved connection configs (used by hooks.ts to restore providers) */
  static loadConnectionConfigs(): ProviderConnectionConfig[] {
    try {
      const json = Zotero.Prefs.get("extensions.zotcloud.providers") as string;
      if (json) {
        const configs = JSON.parse(json) as ProviderConnectionConfig[];
        if (Array.isArray(configs) && configs.length > 0) {
          return configs;
        }
      }
    } catch { /* parse error */ }

    // Migrate from legacy single-provider pref
    const legacy = Zotero.Prefs.get("extensions.zotcloud.provider") as string;
    if (legacy) {
      const cloudFolder =
        (Zotero.Prefs.get("extensions.zotcloud.cloudFolderPath") as string) || "/ZotCloud";
      return [{
        key: legacy,
        type: legacy,
        cloudFolder,
        lastSyncedTimestamp: 0,
        enabled: true,
      }];
    }

    return [];
  }

  /**
   * Mark events as synced in the ChangeLog when ALL providers have them.
   * Uses the minimum lastSyncedTimestamp across all connections.
   */
  private markFullySyncedEvents(): void {
    if (this.connections.length === 0) return;

    const minTimestamp = Math.min(
      ...this.connections.filter(c => c.enabled).map(c => c.lastSyncedTimestamp),
    );

    if (minTimestamp > 0) {
      ChangeLog.markSyncedBefore(minTimestamp).catch(err => {
        logError("Failed to mark fully synced events", err);
      });
    }
  }

  // --- Utilities ---

  /** Check if a manifest was created solely by this device (no other devices) */
  private isOurOwnManifest(manifest: CloudManifest): boolean {
    const devices = Object.keys(manifest.devices);
    return devices.length === 1 && devices[0] === this.stateManager.deviceId;
  }

  private getCloudFolder(): string {
    // Multi-provider: use the active connection's cloud folder
    if (this._activeCloudFolder) return this._activeCloudFolder;
    return (
      (Zotero.Prefs.get("extensions.zotcloud.cloudFolderPath") as string) ||
      "/ZotCloud"
    );
  }

  private decodeBuffer(data: ArrayBuffer): string {
    return new TextDecoder().decode(data);
  }

  /** Create a snapshot and upload to cloud. Optionally prune old changelogs. */
  async createSnapshot(): Promise<void> {
    if (!this.provider) return;

    const cloudFolder = this.getCloudFolder();
    const libraryID = Zotero.Libraries.userLibraryID;

    const { data, meta } = await Snapshot.generate(
      libraryID,
      this.stateManager.deviceId,
    );

    const snapshotPath = `${cloudFolder}/snapshots/${meta.timestamp}.json`;
    await this.provider.upload(snapshotPath, data);

    const metaPath = `${cloudFolder}/snapshots/${meta.timestamp}.meta.json`;
    await this.provider.upload(metaPath, JSON.stringify(meta, null, 2));

    log(`Snapshot uploaded: ${snapshotPath}`);

    await this.garbageCollect(meta.timestamp);
  }

  /** Delete changelogs older than the given timestamp to save cloud space */
  private async garbageCollect(beforeTimestamp: number): Promise<void> {
    if (!this.provider) return;

    const cloudFolder = this.getCloudFolder();
    let deletedCount = 0;

    try {
      const changelogDir = `${cloudFolder}/changelog`;
      const deviceDirs = await this.provider.list(changelogDir);

      for (const dir of deviceDirs) {
        if (!dir.isDirectory) continue;

        const files = await this.provider.list(dir.path);
        for (const file of files) {
          if (!file.name.endsWith(".json") || file.isDirectory) continue;

          const tsMatch = file.name.match(/^(\d+)/);
          if (tsMatch) {
            const fileTs = parseInt(tsMatch[1], 10);
            if (fileTs < beforeTimestamp) {
              await this.provider.delete(file.path);
              deletedCount++;
            }
          }
        }
      }

      if (deletedCount > 0) {
        log(`Garbage collected ${deletedCount} old changelog files`);
      }

      const snapshots = await this.provider.list(`${cloudFolder}/snapshots`);
      const snapshotFiles = snapshots
        .filter((f) => f.name.endsWith(".json") && !f.name.endsWith(".meta.json"))
        .sort((a, b) => b.name.localeCompare(a.name));

      for (let i = 2; i < snapshotFiles.length; i++) {
        await this.provider.delete(snapshotFiles[i].path);
        const metaName = snapshotFiles[i].name.replace(".json", ".meta.json");
        try {
          await this.provider.delete(
            `${cloudFolder}/snapshots/${metaName}`,
          );
        } catch { /* ignore */ }
      }

      await ChangeLog.deleteOlderThan(beforeTimestamp);
    } catch (err) {
      logError("Garbage collection failed", err);
    }
  }

  /** Upload data, encrypting if the preference is enabled */
  private async encryptedUpload(
    remotePath: string,
    jsonData: string,
  ): Promise<void> {
    if (!this.provider) return;

    const encrypt = !!Zotero.Prefs.get("extensions.zotcloud.encryptData");
    if (encrypt) {
      const password = this.getEncryptionPassword();
      const encrypted = await Encryption.encryptString(jsonData, password);
      await this.provider.upload(remotePath + ".enc", encrypted);
    } else {
      await this.provider.upload(remotePath, jsonData);
    }
  }

  /** Download data, decrypting if encrypted */
  private async encryptedDownload(remotePath: string): Promise<string> {
    if (!this.provider) throw new Error("No provider");

    const encrypt = !!Zotero.Prefs.get("extensions.zotcloud.encryptData");
    if (encrypt) {
      try {
        const data = await this.provider.download(remotePath + ".enc");
        const password = this.getEncryptionPassword();
        return await Encryption.decryptString(data, password);
      } catch {
        // Fall through to unencrypted
      }
    }

    const data = await this.provider.download(remotePath);
    return this.decodeBuffer(data);
  }

  private getEncryptionPassword(): string {
    const password =
      (Zotero.Prefs.get("extensions.zotcloud.encryptionPassword") as string) ||
      this.stateManager.deviceId;
    return password;
  }
}
