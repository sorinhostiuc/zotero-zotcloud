import { CloudProvider } from "../providers/provider";
import { StateManager } from "./state-manager";
import { computeFileHash } from "../crypto/hashing";
import { showProgress, hideProgress } from "../ui/progress";
import { log, logError } from "../utils/logger";

/**
 * AttachmentSync handles upload/download of attachment files (PDFs, snapshots, etc.)
 * to/from cloud storage.
 *
 * Strategy:
 * - Files stored on cloud as /ZotCloud/attachments/{sha256hash}.{ext}
 * - Hash manifest at /ZotCloud/attachments/_manifest.json tracks all known hashes
 * - Before uploading, check if hash exists in manifest → skip if so (dedup)
 * - When pulling, download only files not already present locally
 * - Max attachment size preference enforced before upload
 */

/** Hash manifest: maps sha256 hash → cloud file info */
interface AttachmentManifest {
  /** hash → file entry */
  files: Record<
    string,
    {
      originalName: string;
      size: number;
      uploadedBy: string;
      uploadedAt: string;
      extension: string;
      /** Human-readable cloud path (relative to cloudFolder) when file organization is enabled */
      cloudPath?: string;
      /** Zotero item key that owns this attachment (primary; kept for back-compat) */
      itemKey?: string;
      /** ALL item keys that reference this file. The cloud file is only deleted
       *  once every owner is gone — deleting one owner must not orphan the rest. */
      itemKeys?: string[];
      /** Parent item key (the reference this attachment belongs to) */
      parentItemKey?: string;
    }
  >;
}

/** Folder organization strategies */
type FolderOrganization = "none" | "author" | "year" | "itemtype" | "journal" | "author-year" | "year-author";

/** Characters forbidden in file/folder names on most OSes */
const SANITIZE_RE = /[/\\:*?"<>|]/g;

/** Function words to strip for {titleshort} */
const FUNCTION_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "can", "not", "no",
]);

/** Metadata extracted from a Zotero item for path template resolution */
export interface ItemMetadata {
  authors: string;
  firstAuthor: string;
  lastAuthor: string;
  year: string;
  title: string;
  titleShort: string;
  journal: string;
  itemType: string;
  originalFilename: string;
}

/** Sanitize a string for use in file/folder names */
function sanitize(s: string): string {
  return s.replace(SANITIZE_RE, "").trim() || "Unknown";
}

/** Truncate a string to maxLen characters */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen).trimEnd();
}

export class AttachmentSync {
  private provider: CloudProvider;
  private stateManager: StateManager;
  private cloudFolder: string;
  private manifest: AttachmentManifest | null = null;

  constructor(
    provider: CloudProvider,
    stateManager: StateManager,
    cloudFolder: string,
  ) {
    this.provider = provider;
    this.stateManager = stateManager;
    this.cloudFolder = cloudFolder;
  }

  /** Load the attachment manifest from cloud */
  async loadManifest(): Promise<void> {
    const manifestPath = `${this.cloudFolder}/attachments/_manifest.json`;
    try {
      const data = await this.provider.download(manifestPath);
      this.manifest = JSON.parse(new TextDecoder().decode(data));
      return;
    } catch (err) {
      // Only treat a genuinely-absent manifest (404 / not found) as empty. A
      // transient/server error must NOT reset it — otherwise the next
      // saveManifest() would overwrite the cloud copy and wipe every hash→file
      // mapping. We key off the download error message (providers throw a
      // "not found"/404 error on absence) rather than a second, correlated
      // exists() request that also fails during the same outage.
      const msg = err instanceof Error ? err.message : String(err);
      const absent = /\bnot found\b|(^|[^0-9])404([^0-9]|$)/i.test(msg);
      if (absent) {
        this.manifest = { files: {} };
      } else if (!this.manifest) {
        // Unknown error and nothing cached → fail loudly so callers skip rather
        // than persist an empty manifest over the real one.
        throw err instanceof Error ? err : new Error(msg);
      }
      // else: keep the previously-loaded manifest.
    }
  }

  /** Merge the current hash's owners with a new owner key (deduplicated). */
  private static addOwner(entry: { itemKey?: string; itemKeys?: string[] }, key: string): void {
    const owners = new Set<string>(entry.itemKeys ?? (entry.itemKey ? [entry.itemKey] : []));
    owners.add(key);
    entry.itemKeys = Array.from(owners);
    if (!entry.itemKey) entry.itemKey = key;
  }

  /** If a DIFFERENT hash already occupies cloudPath, disambiguate with a short hash. */
  private disambiguateCloudPath(cloudPath: string, hash: string): string {
    if (!this.manifest) return cloudPath;
    const collision = Object.entries(this.manifest.files).some(
      ([h, e]) => h !== hash && e.cloudPath === cloudPath,
    );
    if (!collision) return cloudPath;
    const slash = cloudPath.lastIndexOf("/");
    const dot = cloudPath.lastIndexOf(".");
    const short = hash.slice(0, 8);
    return dot > slash
      ? `${cloudPath.slice(0, dot)}-${short}${cloudPath.slice(dot)}`
      : `${cloudPath}-${short}`;
  }

  /** Save the attachment manifest to cloud */
  private async saveManifest(): Promise<void> {
    if (!this.manifest) return;
    const manifestPath = `${this.cloudFolder}/attachments/_manifest.json`;
    await this.provider.upload(
      manifestPath,
      JSON.stringify(this.manifest, null, 2),
    );
  }

  /**
   * Upload an attachment to cloud if not already present (dedup by hash).
   * Returns the hash if uploaded/exists, or null if skipped (too large, no file, etc.)
   */
  async uploadAttachment(item: any): Promise<string | null> {
    if (!item.isAttachment()) return null;

    const syncAttachments = Zotero.Prefs.get(
      "extensions.zotcloud.syncAttachments",
    );
    if (!syncAttachments) return null;

    const filePath = await this.getAttachmentPath(item);
    if (!filePath) return null;

    // Check file exists
    const exists = await IOUtils.exists(filePath);
    if (!exists) {
      log(`Attachment file not found: ${filePath}`);
      return null;
    }

    // Check file size against max
    const stat = await IOUtils.stat(filePath);
    const maxSize =
      (Zotero.Prefs.get("extensions.zotcloud.maxAttachmentSize") as number) ||
      0;
    if (maxSize > 0 && stat.size > maxSize) {
      log(
        `Skipping attachment ${item.key}: ${stat.size} bytes exceeds max ${maxSize}`,
      );
      return null;
    }

    // Compute hash
    const hash = await computeFileHash(filePath);

    // Check manifest for dedup
    if (!this.manifest) await this.loadManifest();

    // Build the desired cloud path based on current settings
    let cloudPath: string;
    try {
      cloudPath = this.resolveCloudPath(item);
    } catch (err) {
      // Fallback to flat hash-based path if metadata extraction fails
      const ext = this.getFileExtension(filePath);
      cloudPath = `attachments/${hash}${ext}`;
      log(`resolveCloudPath failed for ${item.key}, using hash fallback: ${err}`);
    }

    // Never let two different files land on the same cloud path.
    cloudPath = this.disambiguateCloudPath(cloudPath, hash);

    const existing = this.manifest!.files[hash];
    if (existing) {
      // Same content already uploaded — record this item as an owner too, so
      // deleting a different owner later won't orphan this one.
      AttachmentSync.addOwner(existing, item.key);

      if (existing.cloudPath && existing.cloudPath !== cloudPath) {
        // Path changed — move the file on cloud.
        const from = existing.cloudPath;
        const moved = await this.moveAttachment(from, cloudPath);
        if (moved) {
          existing.cloudPath = cloudPath;
          log(`Attachment ${item.key} reorganized: ${from} → ${cloudPath}`);
        }
      } else if (!existing.cloudPath) {
        existing.cloudPath = cloudPath; // legacy entry without a stored path
      }
      await this.saveManifest();
      log(`Attachment ${item.key} already in cloud (hash dedup)`);
      return hash;
    }

    const remotePath = `${this.cloudFolder}/${cloudPath}`;
    const ext = this.getFileExtension(filePath);

    log(`Uploading attachment ${item.key} → ${cloudPath} (${this.formatSize(stat.size)})`);
    showProgress(
      `Uploading ${item.getDisplayTitle() || item.key}...`,
      0,
    );

    try {
      const fileData = await IOUtils.read(filePath);
      await this.provider.upload(remotePath, fileData.buffer as ArrayBuffer);

      // Update manifest with cloud path and item key
      this.manifest!.files[hash] = {
        originalName: this.getFileName(filePath),
        size: stat.size,
        uploadedBy: this.stateManager.deviceId,
        uploadedAt: new Date().toISOString(),
        extension: ext,
        cloudPath,
        itemKey: item.key,
        itemKeys: [item.key],
        parentItemKey: item.parentKey || undefined,
      };
      await this.saveManifest();

      showProgress(`Uploaded ${item.getDisplayTitle() || item.key}`, 100);
      log(`Uploaded attachment ${item.key}: ${hash}${ext}`);
      return hash;
    } catch (err) {
      logError(`Failed to upload attachment ${item.key}`, err);
      hideProgress();
      return null;
    }
  }

  /**
   * Download an attachment from cloud by hash and link it to a Zotero item.
   */
  async downloadAttachment(
    item: any,
    hash: string,
  ): Promise<boolean> {
    const syncAttachments = Zotero.Prefs.get(
      "extensions.zotcloud.syncAttachments",
    );
    if (!syncAttachments) return false;
    if (!hash) return false;

    if (!this.manifest) await this.loadManifest();
    const entry = this.manifest!.files[hash];
    if (!entry) {
      log(`Hash ${hash.slice(0, 12)}... not found in attachment manifest`);
      return false;
    }

    // Check if file already exists locally
    const localPath = await this.getAttachmentPath(item);
    if (localPath) {
      const exists = await IOUtils.exists(localPath);
      if (exists) {
        const localHash = await computeFileHash(localPath);
        if (localHash === hash) {
          log(`Attachment ${item.key} already exists locally with matching hash`);
          return true;
        }
        // Local file diverged from cloud (e.g. annotated locally). Do NOT
        // overwrite/repoint it — that silently discards local changes.
        log(`Attachment ${item.key} differs locally (local ${localHash.slice(0, 8)} vs cloud ${hash.slice(0, 8)}); keeping local copy`);
        return false;
      }
    }

    // Download from cloud — use cloudPath if available, fall back to hash-based path
    const remotePath = entry.cloudPath
      ? `${this.cloudFolder}/${entry.cloudPath}`
      : `${this.cloudFolder}/attachments/${hash}${entry.extension}`;

    log(
      `Downloading attachment ${item.key} (${this.formatSize(entry.size)})`,
    );
    showProgress(
      `Downloading ${item.getDisplayTitle() || item.key}...`,
      0,
    );

    try {
      const data = await this.provider.download(remotePath);

      // Determine local storage path
      const storageDir = this.getStorageDir(item.key);
      await IOUtils.makeDirectory(storageDir, { ignoreExisting: true });

      const targetPath = PathUtils.join(storageDir, entry.originalName);
      await IOUtils.write(targetPath, new Uint8Array(data));

      // Integrity check: what we wrote MUST match the requested hash. A cloud
      // path collision could otherwise hand this item a different item's file.
      try {
        const gotHash = await computeFileHash(targetPath);
        if (gotHash !== hash) {
          try { await IOUtils.remove(targetPath); } catch { /* ignore */ }
          logError(
            `Attachment ${item.key} hash mismatch (got ${gotHash.slice(0, 8)}, want ${hash.slice(0, 8)}) — discarded`,
            new Error("attachment hash mismatch"),
          );
          hideProgress();
          return false;
        }
      } catch { /* hashing failed — keep the file (best effort) */ }

      // Update item's attachment path if needed
      if (item.attachmentLinkMode !== Zotero.Attachments.LINK_MODE_LINKED_URL) {
        item.attachmentPath = `storage:${entry.originalName}`;
        await item.saveTx({ skipNotifier: true });
      }

      showProgress(
        `Downloaded ${item.getDisplayTitle() || item.key}`,
        100,
      );
      log(`Downloaded attachment ${item.key} to ${targetPath}`);
      return true;
    } catch (err) {
      logError(`Failed to download attachment ${item.key}`, err);
      hideProgress();
      return false;
    }
  }

  /**
   * Sync all attachments for a batch of items.
   * Used during push: uploads any attachments with changes.
   */
  async uploadBatch(items: any[]): Promise<Map<string, string>> {
    const hashMap = new Map<string, string>(); // itemKey → hash
    const attachments = items.filter((i) => i.isAttachment());
    if (attachments.length === 0) return hashMap;

    if (!this.manifest) await this.loadManifest();

    let completed = 0;
    for (const item of attachments) {
      const hash = await this.uploadAttachment(item);
      if (hash) {
        hashMap.set(item.key, hash);
      }
      completed++;
      showProgress(
        `Uploading attachments (${completed}/${attachments.length})`,
        Math.round((completed / attachments.length) * 100),
      );
    }

    return hashMap;
  }

  /**
   * Download all missing attachments from cloud.
   * Used during pull: downloads attachments referenced in remote events.
   */
  async downloadMissing(
    attachmentEvents: Array<{ item: any; hash: string }>,
  ): Promise<void> {
    if (attachmentEvents.length === 0) return;

    if (!this.manifest) await this.loadManifest();

    let completed = 0;
    let failed = 0;
    for (const { item, hash } of attachmentEvents) {
      const ok = await this.downloadAttachment(item, hash);
      if (!ok) failed++;
      completed++;
      showProgress(
        `Downloading attachments (${completed}/${attachmentEvents.length})`,
        Math.round((completed / attachmentEvents.length) * 100),
      );
    }
    if (failed > 0) {
      log(`downloadMissing: ${failed}/${attachmentEvents.length} attachment(s) failed or were skipped`);
    }
  }

  // --- Delete ---

  /**
   * Delete cloud attachment(s) associated with a Zotero item key.
   * Removes the file from cloud storage and the entry from the manifest.
   * Returns the number of files deleted.
   */
  async deleteAttachmentByItemKey(itemKey: string): Promise<number> {
    if (!this.manifest) await this.loadManifest();
    if (!this.manifest) return 0;

    let deletedCount = 0;
    let changed = false;

    for (const [hash, entry] of Object.entries(this.manifest.files)) {
      const owners = new Set<string>(entry.itemKeys ?? (entry.itemKey ? [entry.itemKey] : []));
      if (!owners.has(itemKey)) continue;

      owners.delete(itemKey);
      changed = true;

      if (owners.size > 0) {
        // Other items still reference this exact file — keep it, just drop this
        // owner. Deleting the shared file would break the remaining owners.
        entry.itemKeys = Array.from(owners);
        if (entry.itemKey === itemKey) entry.itemKey = entry.itemKeys[0];
        log(`Attachment ${hash.slice(0, 8)}... still has ${owners.size} owner(s); keeping cloud file`);
        continue;
      }

      // Last owner removed — delete the cloud file and drop the manifest entry.
      const remotePath = entry.cloudPath
        ? `${this.cloudFolder}/${entry.cloudPath}`
        : `${this.cloudFolder}/attachments/${hash}${entry.extension}`;
      try {
        await this.provider.delete(remotePath);
        log(`Deleted cloud attachment for item ${itemKey}: ${remotePath}`);
        deletedCount++;
      } catch (err) {
        logError(`Failed to delete cloud attachment ${remotePath}`, err);
      }
      delete this.manifest.files[hash];
    }

    if (changed) {
      await this.saveManifest();
    }

    return deletedCount;
  }

  // --- Move / Reorganize ---

  /** Move a single attachment from oldPath to newPath on cloud */
  private async moveAttachment(oldCloudPath: string, newCloudPath: string): Promise<boolean> {
    const fromPath = `${this.cloudFolder}/${oldCloudPath}`;
    const toPath = `${this.cloudFolder}/${newCloudPath}`;

    // Try provider MOVE first (efficient, no re-upload)
    if (this.provider.move) {
      try {
        const ok = await this.provider.move(fromPath, toPath);
        if (ok) return true;
      } catch (err) {
        log(`MOVE not supported or failed, falling back to download+upload: ${err}`);
      }
    }

    // Fallback: download, upload to new path, delete old
    try {
      const data = await this.provider.download(fromPath);
      await this.provider.upload(toPath, data);
      await this.provider.delete(fromPath);
      return true;
    } catch (err) {
      logError(`Failed to move attachment ${oldCloudPath} → ${newCloudPath}`, err);
      return false;
    }
  }

  /**
   * Reorganize ALL existing attachments on cloud based on current settings.
   * Goes through every entry in the manifest, resolves the new cloud path,
   * and moves files whose path has changed.
   * Returns the count of files moved.
   */
  async reorganizeAttachments(): Promise<number> {
    if (!this.manifest) await this.loadManifest();
    if (!this.manifest) return 0;

    const libraryID = Zotero.Libraries.userLibraryID;
    let movedCount = 0;
    let total = Object.keys(this.manifest.files).length;
    let processed = 0;

    for (const [hash, entry] of Object.entries(this.manifest.files)) {
      processed++;
      showProgress(`Reorganizing attachments (${processed}/${total})`, Math.round((processed / total) * 100));

      // Find the Zotero item associated with this hash
      const item = await this.findItemByHash(hash, libraryID);
      if (!item) {
        log(`No Zotero item found for hash ${hash.slice(0, 12)}..., skipping`);
        continue;
      }

      let newCloudPath: string;
      try {
        newCloudPath = this.resolveCloudPath(item);
      } catch {
        continue;
      }

      const oldCloudPath = entry.cloudPath;
      if (!oldCloudPath || oldCloudPath === newCloudPath) continue;

      const moved = await this.moveAttachment(oldCloudPath, newCloudPath);
      if (moved) {
        entry.cloudPath = newCloudPath;
        movedCount++;
        log(`Reorganized: ${oldCloudPath} → ${newCloudPath}`);
      }
    }

    if (movedCount > 0) {
      await this.saveManifest();
    }

    hideProgress();
    log(`Reorganization complete: ${movedCount} files moved`);
    return movedCount;
  }

  /** Find a Zotero attachment item that matches a given file hash */
  private async findItemByHash(hash: string, libraryID: number): Promise<any | null> {
    try {
      const items = await Zotero.Items.getAll(libraryID);
      for (const item of items) {
        if (!item.isAttachment()) continue;
        try {
          const path = await item.getFilePathAsync();
          if (!path) continue;
          const exists = await IOUtils.exists(path);
          if (!exists) continue;
          const itemHash = await computeFileHash(path);
          if (itemHash === hash) return item;
        } catch {
          continue;
        }
      }
    } catch {
      // Library access failed
    }
    return null;
  }

  // --- Cloud path resolution ---

  /**
   * Build a human-readable cloud path for an attachment based on user settings.
   * Returns a path relative to the cloudFolder, e.g. "attachments/Smith/2024/Smith 2024 - Title.pdf"
   */
  resolveCloudPath(item: any): string {
    const ext = this.getAttachmentExtension(item);
    const organization = (Zotero.Prefs.get("extensions.zotcloud.folderOrganization") as string || "none") as FolderOrganization;
    const pattern = (Zotero.Prefs.get("extensions.zotcloud.filenamePattern") as string) || "{firstauthor} {year} - {title}";
    const separator = (Zotero.Prefs.get("extensions.zotcloud.filenameSeparator") as string) || " ";
    const starredFolder = (Zotero.Prefs.get("extensions.zotcloud.starredFolder") as string) || "";
    const trashedFolder = (Zotero.Prefs.get("extensions.zotcloud.trashedFolder") as string) || "";

    // Get the parent item (attachment's parent holds the metadata)
    const parentItem = this.getParentItem(item);
    const meta = this.extractItemMetadata(parentItem || item);

    // Check special folders first
    if (trashedFolder && this.isItemTrashed(item, parentItem)) {
      const filename = this.buildFilename(pattern, separator, meta) + ext;
      return `attachments/${sanitize(trashedFolder)}/${sanitize(filename)}`;
    }

    if (starredFolder && this.isItemStarred(parentItem || item)) {
      const filename = this.buildFilename(pattern, separator, meta) + ext;
      return `attachments/${sanitize(starredFolder)}/${sanitize(filename)}`;
    }

    // Build folder path based on organization strategy
    const folderParts = this.buildFolderParts(organization, meta);
    const filename = this.buildFilename(pattern, separator, meta) + ext;

    const parts = ["attachments", ...folderParts, sanitize(filename)];
    return parts.join("/");
  }

  /**
   * Resolve cloud path for an item - public static helper for UI preview.
   * Takes raw metadata instead of a Zotero item.
   */
  static resolveCloudPathFromMetadata(
    meta: ItemMetadata,
    ext: string,
    organization: FolderOrganization,
    pattern: string,
    separator: string,
    starredFolder: string,
    trashedFolder: string,
    isStarred: boolean,
    isTrashed: boolean,
  ): string {
    if (trashedFolder && isTrashed) {
      const filename = AttachmentSync.buildFilenameStatic(pattern, separator, meta) + ext;
      return `attachments/${sanitize(trashedFolder)}/${sanitize(filename)}`;
    }

    if (starredFolder && isStarred) {
      const filename = AttachmentSync.buildFilenameStatic(pattern, separator, meta) + ext;
      return `attachments/${sanitize(starredFolder)}/${sanitize(filename)}`;
    }

    const folderParts = AttachmentSync.buildFolderPartsStatic(organization, meta);
    const filename = AttachmentSync.buildFilenameStatic(pattern, separator, meta) + ext;
    const parts = ["attachments", ...folderParts, sanitize(filename)];
    return parts.join("/");
  }

  private buildFolderParts(organization: FolderOrganization, meta: ItemMetadata): string[] {
    return AttachmentSync.buildFolderPartsStatic(organization, meta);
  }

  private static buildFolderPartsStatic(organization: FolderOrganization, meta: ItemMetadata): string[] {
    switch (organization) {
      case "author":
        return [sanitize(meta.firstAuthor || "Unknown")];
      case "year":
        return [sanitize(meta.year || "Unknown")];
      case "itemtype":
        return [sanitize(meta.itemType || "Unknown")];
      case "journal":
        return [sanitize(meta.journal || "Unknown")];
      case "author-year":
        return [sanitize(meta.firstAuthor || "Unknown"), sanitize(meta.year || "Unknown")];
      case "year-author":
        return [sanitize(meta.year || "Unknown"), sanitize(meta.firstAuthor || "Unknown")];
      case "none":
      default:
        return [];
    }
  }

  private buildFilename(pattern: string, separator: string, meta: ItemMetadata): string {
    return AttachmentSync.buildFilenameStatic(pattern, separator, meta);
  }

  private static buildFilenameStatic(pattern: string, separator: string, meta: ItemMetadata): string {
    // Replace separator between tags — the separator is used instead of spaces between tag values
    let result = pattern;

    result = result.replace(/\{authors\}/g, meta.authors || "Unknown");
    result = result.replace(/\{firstauthor\}/g, meta.firstAuthor || "Unknown");
    result = result.replace(/\{lastauthor\}/g, meta.lastAuthor || "Unknown");
    result = result.replace(/\{year\}/g, meta.year || "Unknown");
    result = result.replace(/\{title\}/g, truncate(meta.title || "Untitled", 100));
    result = result.replace(/\{titleshort\}/g, truncate(meta.titleShort || "Untitled", 50));
    result = result.replace(/\{journal\}/g, meta.journal || "Unknown");
    result = result.replace(/\{filename\}/g, meta.originalFilename || "file");
    result = result.replace(/\{itemtype\}/g, meta.itemType || "Unknown");

    // Apply separator — replace spaces between resolved tag values
    if (separator !== " ") {
      result = result.replace(/ /g, separator);
    }

    return sanitize(result);
  }

  private getAttachmentExtension(item: any): string {
    try {
      const contentType = item.attachmentContentType || "";
      const path = item.attachmentFilename || "";
      const dot = path.lastIndexOf(".");
      if (dot >= 0) return path.slice(dot);
      // Fallback from content type
      if (contentType.includes("pdf")) return ".pdf";
      if (contentType.includes("html")) return ".html";
      return "";
    } catch {
      return "";
    }
  }

  private getParentItem(item: any): any | null {
    try {
      if (item.parentItemID) {
        return Zotero.Items.get(item.parentItemID);
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Extract metadata from a Zotero item for path building */
  extractItemMetadata(item: any): ItemMetadata {
    const creators = item.getCreators?.() || [];
    const lastNames = creators
      .filter((c: any) => c.creatorTypeID === Zotero.CreatorTypes.getID("author") || creators.length <= 1)
      .map((c: any) => c.lastName || c.firstName || "");

    let title = "";
    try { title = item.getField?.("title") || ""; } catch { /* */ }

    let year = "";
    try {
      const date = item.getField?.("date") || "";
      const match = date.match(/\d{4}/);
      if (match) year = match[0];
    } catch { /* */ }

    let journal = "";
    try {
      journal = item.getField?.("publicationTitle") || item.getField?.("journalAbbreviation") || "";
    } catch { /* */ }

    let itemType = "";
    try { itemType = Zotero.ItemTypes.getName(item.itemTypeID) || ""; } catch { /* */ }

    let originalFilename = "";
    try { originalFilename = item.attachmentFilename || ""; } catch { /* */ }

    // Build titleShort: remove function words, cap at 50 chars
    const titleWords = title.split(/\s+/).filter((w: string) => !FUNCTION_WORDS.has(w.toLowerCase()));
    const titleShort = titleWords.join(" ");

    return {
      authors: lastNames.join(", ") || "Unknown",
      firstAuthor: lastNames[0] || "Unknown",
      lastAuthor: lastNames[lastNames.length - 1] || "Unknown",
      year: year || "Unknown",
      title: title || "Untitled",
      titleShort: titleShort || "Untitled",
      journal: journal || "Unknown",
      itemType: itemType || "Unknown",
      originalFilename,
    };
  }

  private isItemTrashed(item: any, parentItem: any | null): boolean {
    try {
      return item.deleted || (parentItem && parentItem.deleted) || false;
    } catch {
      return false;
    }
  }

  private isItemStarred(item: any): boolean {
    try {
      const tags = item.getTags?.() || [];
      return tags.some((t: any) => t.tag === "⭐" || t.tag === "starred" || t.tag === "favorite");
    } catch {
      return false;
    }
  }

  // --- Helpers ---

  private async getAttachmentPath(item: any): Promise<string | null> {
    try {
      return await item.getFilePathAsync();
    } catch {
      return null;
    }
  }

  /** Get Zotero's storage directory for an item key */
  private getStorageDir(itemKey: string): string {
    const dataDir = Zotero.DataDirectory.dir;
    return PathUtils.join(dataDir, "storage", itemKey);
  }

  private getFileExtension(path: string): string {
    const dot = path.lastIndexOf(".");
    return dot >= 0 ? path.slice(dot) : "";
  }

  private getFileName(path: string): string {
    const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return sep >= 0 ? path.slice(sep + 1) : path;
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }
}
