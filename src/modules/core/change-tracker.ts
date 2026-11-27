import { ChangeEvent, ChangeEventData, Creator, Tag } from "./types";
import { StateManager } from "./state-manager";
import { ChangeLog } from "./change-log";
import { generateUUID } from "../utils/uuid";
import { log, logError } from "../utils/logger";

/**
 * ChangeTracker listens to Zotero Notifier events and builds ChangeEvent objects.
 *
 * It registers as a Zotero Notifier observer for item, collection, collection-item,
 * and item-tag events. Each event is transformed into a ChangeEvent with full
 * serialized item data (for add/modify) or just the key (for delete).
 *
 * The `skipZotCloudSync` flag in extraData prevents re-triggering when we apply
 * remote changes locally.
 */
export class ChangeTracker {
  private notifierID: string | null = null;
  private stateManager: StateManager;
  private pendingEvents: ChangeEvent[] = [];
  private _isSyncing = false;
  private onChange: (() => void) | null = null;

  constructor(stateManager: StateManager) {
    this.stateManager = stateManager;
  }

  /** Register a callback fired after new local changes are captured+persisted. */
  setOnChange(cb: () => void) {
    this.onChange = cb;
  }

  /** Whether we are currently applying remote changes (skip local tracking) */
  get isSyncing(): boolean {
    return this._isSyncing;
  }

  set isSyncing(value: boolean) {
    this._isSyncing = value;
  }

  /** Register Notifier observer */
  register() {
    const callback = {
      notify: async (
        event: string,
        type: string,
        ids: number[],
        extraData: Record<string, any>,
      ) => {
        try {
          await this.handleNotification(event, type, ids, extraData);
        } catch (err) {
          logError("Notifier handler error", err);
        }
      },
    };

    this.notifierID = Zotero.Notifier.registerObserver(
      callback,
      ["item", "collection", "collection-item", "item-tag"],
      "ZotCloud",
    );

    log("Change tracker registered, notifier ID: " + this.notifierID);
  }

  /** Unregister Notifier observer */
  unregister() {
    if (this.notifierID) {
      Zotero.Notifier.unregisterObserver(this.notifierID);
      this.notifierID = null;
      log("Change tracker unregistered");
    }
  }

  /** Get and clear pending change events */
  drainEvents(): ChangeEvent[] {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }

  /** Get count of pending events without draining */
  get pendingCount(): number {
    return this.pendingEvents.length;
  }

  private async handleNotification(
    event: string,
    type: string,
    ids: number[],
    extraData: Record<string, any>,
  ) {
    // Skip events triggered by our own sync operations
    if (extraData?.skipZotCloudSync) return;

    // Skip events while we're applying remote changes
    if (this._isSyncing) return;

    const built: ChangeEvent[] = [];
    for (const id of ids) {
      const changeEvent = await this.buildChangeEvent(
        event,
        type,
        id,
        extraData,
      );
      if (changeEvent) {
        this.pendingEvents.push(changeEvent);
        built.push(changeEvent);
      }
    }
    if (built.length === 0) return;
    this.stateManager.pendingChanges = this.pendingEvents.length;

    // Persist to the change log IMMEDIATELY. Previously events lived only in the
    // in-memory pendingEvents array until the next syncNow drained them, so an
    // edit followed by a quit/crash before a sync was lost entirely. Also nudge
    // the engine to schedule a (debounced) sync instead of waiting for the
    // 5-minute periodic timer.
    try {
      await ChangeLog.appendBatch(built);
    } catch (err) {
      logError("Failed to persist change events", err);
    }
    try {
      this.onChange?.();
    } catch { /* scheduling is best-effort */ }
  }

  private async buildChangeEvent(
    event: string,
    type: string,
    id: number,
    extraData: Record<string, any>,
  ): Promise<ChangeEvent | null> {
    if (type === "item") {
      return this.buildItemEvent(event, id, extraData);
    }
    if (type === "collection") {
      return this.buildCollectionEvent(event, id, extraData);
    }
    if (type === "collection-item") {
      return this.buildCollectionItemEvent(id, extraData);
    }
    // item-tag changes also fire an item "modify" event, so they're captured there.
    return null;
  }

  /**
   * A collection-item notification fires when an item is added to / removed from
   * a collection. Zotero does NOT also fire an item "modify" for this, so we
   * re-serialize the affected item as a modify — its data.collections then
   * reflects the new membership. IDs look like "<collectionID>-<itemID>".
   */
  private async buildCollectionItemEvent(
    id: number | string,
    extraData: Record<string, any>,
  ): Promise<ChangeEvent | null> {
    const parts = String(id).split("-");
    const itemID = parseInt(parts[parts.length - 1], 10);
    if (!Number.isFinite(itemID)) return null;
    return this.buildItemEvent("modify", itemID, extraData);
  }

  private async buildItemEvent(
    event: string,
    id: number,
    extraData: Record<string, any>,
  ): Promise<ChangeEvent | null> {
    if (event === "add" || event === "modify") {
      const item = Zotero.Items.get(id);
      if (!item) return null;

      // Skip feed items
      if (item.isFeedItem) return null;

      // Conditionally skip notes and annotations based on user preferences
      if ((item as any).isAnnotation?.()) {
        if (!Zotero.Prefs.get("extensions.zotcloud.syncAnnotations")) return null;
      } else if (item.isNote?.()) {
        if (item.parentKey) {
          if (!Zotero.Prefs.get("extensions.zotcloud.syncChildNotes")) return null;
        } else {
          if (!Zotero.Prefs.get("extensions.zotcloud.syncStandaloneNotes")) return null;
        }
      }

      const data = await this.serializeItem(item);

      return {
        id: generateUUID(),
        deviceId: this.stateManager.deviceId,
        timestamp: Date.now(),
        vectorClock: this.stateManager.incrementClock(),
        type: event === "add" ? "add" : "modify",
        entityType: "item",
        entityKey: item.key,
        libraryID: item.libraryID,
        data,
      };
    }

    if (event === "delete") {
      return {
        id: generateUUID(),
        deviceId: this.stateManager.deviceId,
        timestamp: Date.now(),
        vectorClock: this.stateManager.incrementClock(),
        type: "delete",
        entityType: "item",
        entityKey: extraData?.[id]?.key || String(id),
        libraryID: extraData?.[id]?.libraryID || 1,
        data: {},
      };
    }

    // Moving an item to Trash fires a "trash" event, not "delete". Propagate it
    // so other devices remove the item too; a restore (untrash) re-adds it.
    if (event === "trash") {
      const item = Zotero.Items.get(id);
      if (!item || item.deleted) {
        return {
          id: generateUUID(),
          deviceId: this.stateManager.deviceId,
          timestamp: Date.now(),
          vectorClock: this.stateManager.incrementClock(),
          type: "delete",
          entityType: "item",
          entityKey: item?.key || extraData?.[id]?.key || String(id),
          libraryID: item?.libraryID || extraData?.[id]?.libraryID || 1,
          data: {},
        };
      }
      // Restored from Trash → re-add/modify.
      return this.buildItemEvent("modify", id, extraData);
    }

    return null;
  }

  private async buildCollectionEvent(
    event: string,
    id: number,
    extraData: Record<string, any>,
  ): Promise<ChangeEvent | null> {
    if (event === "add" || event === "modify") {
      const collection = Zotero.Collections.get(id);
      if (!collection) return null;

      return {
        id: generateUUID(),
        deviceId: this.stateManager.deviceId,
        timestamp: Date.now(),
        vectorClock: this.stateManager.incrementClock(),
        type: event === "add" ? "add" : "modify",
        entityType: "collection",
        entityKey: collection.key,
        libraryID: collection.libraryID,
        data: {
          fields: {
            name: collection.name,
            parentKey: collection.parentKey || null,
          },
        },
      };
    }

    if (event === "delete") {
      return {
        id: generateUUID(),
        deviceId: this.stateManager.deviceId,
        timestamp: Date.now(),
        vectorClock: this.stateManager.incrementClock(),
        type: "delete",
        entityType: "collection",
        entityKey: extraData?.[id]?.key || String(id),
        libraryID: extraData?.[id]?.libraryID || 1,
        data: {},
      };
    }

    return null;
  }

  /** Serialize a Zotero item into ChangeEventData */
  private async serializeItem(item: any): Promise<ChangeEventData> {
    const data: ChangeEventData = {
      fields: {},
      creators: [],
      tags: [],
      collections: [],
    };

    // Item type
    data.fields!.itemType = Zotero.ItemTypes.getName(item.itemTypeID);

    // Get all fields for this item type
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

    // Creators
    const creators = item.getCreators();
    data.creators = creators.map((c: any): Creator => ({
      firstName: c.firstName || "",
      lastName: c.lastName || "",
      creatorType: Zotero.CreatorTypes.getName(c.creatorTypeID),
    }));

    // Tags
    data.tags = item.getTags() as Tag[];

    // Collections
    const collectionIDs = item.getCollections();
    data.collections = collectionIDs
      .map((colID: number) => {
        const col = Zotero.Collections.get(colID);
        return col?.key;
      })
      .filter(Boolean) as string[];

    // Attachment info
    if (item.isAttachment()) {
      try {
        const path = await item.getFilePathAsync();
        if (path) {
          data.attachmentPath = path;
        }
      } catch {
        // File may not exist
      }
    }

    // Parent key (for child notes, annotations, and attachments)
    if (item.parentKey) {
      data.parentKey = item.parentKey;
    }

    // Note content
    if (item.isNote?.()) {
      try {
        data.noteContent = item.getNote();
      } catch { /* skip */ }
    }

    // Annotation data
    if ((item as any).isAnnotation?.()) {
      try {
        data.parentKey = item.parentKey;
        data.annotationData = {
          type: item.annotationType || "",
          pageLabel: item.annotationPageLabel || "",
          position: item.annotationPosition || "{}",
          color: item.annotationColor || "",
          comment: item.annotationComment || "",
          text: item.annotationText || "",
          sortIndex: item.annotationSortIndex || "",
          tags: item.getTags() as Tag[],
        };
      } catch { /* skip */ }
    }

    return data;
  }
}
