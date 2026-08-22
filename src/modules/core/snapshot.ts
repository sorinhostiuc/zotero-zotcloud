import { ChangeEvent } from "./types";
import { log, logError } from "../utils/logger";
import { generateUUID } from "../utils/uuid";

/**
 * Snapshot: full library export for fast bootstrap of new devices.
 *
 * A snapshot is a JSON array of ChangeEvent[] representing every item and
 * collection in the library at a point in time. When a new device joins,
 * it downloads the latest snapshot + only changelogs created after the
 * snapshot timestamp, instead of replaying the entire history.
 *
 * Cloud layout: /ZotCloud/snapshots/{timestamp}.json
 */

export interface SnapshotMeta {
  timestamp: number;
  deviceId: string;
  itemCount: number;
  collectionCount: number;
  schemaVersion: number;
}

export class Snapshot {
  /**
   * Generate a full library snapshot as JSON.
   * Returns { data, meta } where data is the JSON string as ArrayBuffer.
   */
  static async generate(
    libraryID: number,
    deviceId: string,
  ): Promise<{ data: ArrayBuffer; meta: SnapshotMeta }> {
    log("Generating library snapshot...");

    const events: ChangeEvent[] = [];

    // Export all items
    const items = await Zotero.Items.getAll(libraryID);
    let itemCount = 0;
    const syncStandaloneNotes = Zotero.Prefs.get("extensions.zotcloud.syncStandaloneNotes");
    const syncChildNotes = Zotero.Prefs.get("extensions.zotcloud.syncChildNotes");
    const syncAnnotations = Zotero.Prefs.get("extensions.zotcloud.syncAnnotations");

    for (const item of items) {
      if (item.isFeedItem) continue;

      // Conditionally skip notes and annotations
      if ((item as any).isAnnotation?.()) {
        if (!syncAnnotations) continue;
      } else if (item.isNote?.()) {
        if (item.parentKey) {
          if (!syncChildNotes) continue;
        } else {
          if (!syncStandaloneNotes) continue;
        }
      }

      const data: ChangeEvent["data"] = { fields: {}, creators: [], tags: [], collections: [] };

      data.fields!.itemType = Zotero.ItemTypes.getName(item.itemTypeID);

      const fieldIDs = Zotero.ItemFields.getItemTypeFields(item.itemTypeID);
      for (const fieldID of fieldIDs) {
        const fieldName = Zotero.ItemFields.getName(fieldID);
        try {
          const value = item.getField(fieldName);
          if (value !== undefined && value !== null && value !== "") {
            data.fields![fieldName] = value;
          }
        } catch { /* skip */ }
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
          if (path) data.attachmentPath = path;
        } catch { /* skip */ }
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

      events.push({
        id: generateUUID(),
        deviceId,
        timestamp: Date.now(),
        vectorClock: {},
        type: "add",
        entityType: "item",
        entityKey: item.key,
        libraryID,
        data,
      });
      itemCount++;
    }

    // Export all collections
    const collections = Zotero.Collections.getByLibrary(libraryID);
    let collectionCount = 0;
    for (const collection of collections) {
      events.push({
        id: generateUUID(),
        deviceId,
        timestamp: Date.now(),
        vectorClock: {},
        type: "add",
        entityType: "collection",
        entityKey: collection.key,
        libraryID,
        data: {
          fields: {
            name: collection.name,
            parentKey: collection.parentKey || null,
          },
        },
      });
      collectionCount++;
    }

    const json = JSON.stringify(events);
    const encoded = new TextEncoder().encode(json);

    const meta: SnapshotMeta = {
      timestamp: Date.now(),
      deviceId,
      itemCount,
      collectionCount,
      schemaVersion: 1,
    };

    log(
      `Snapshot generated: ${itemCount} items, ${collectionCount} collections, ` +
        `${(encoded.byteLength / 1024).toFixed(1)} KB`,
    );

    return { data: encoded.buffer, meta };
  }

  /**
   * Restore a library from a snapshot.
   * Parses the JSON and applies all events to the local Zotero library.
   */
  static async restore(
    data: ArrayBuffer,
    libraryID: number,
  ): Promise<number> {
    log("Restoring library from snapshot...");

    const json = new TextDecoder().decode(data);
    const events: ChangeEvent[] = JSON.parse(json);

    let applied = 0;
    const deferred: ChangeEvent[] = []; // child items whose parent isn't created yet
    for (const event of events) {
      try {
        if (event.entityType === "collection") {
          let collection = Zotero.Collections.getByLibraryAndKey(
            libraryID,
            event.entityKey,
          );
          if (!collection) {
            collection = new Zotero.Collection();
            collection.libraryID = libraryID;
            collection.key = event.entityKey;
          }
          if (event.data.fields?.name) {
            collection.name = event.data.fields.name;
          }
          await collection.saveTx({ skipNotifier: true });
          applied++;
        } else if (event.entityType === "item") {
          let item = Zotero.Items.getByLibraryAndKey(
            libraryID,
            event.entityKey,
          );
          if (!item) {
            item = new Zotero.Item();
            item.libraryID = libraryID;
            item.key = event.entityKey;
          }
          if (event.data.fields?.itemType) {
            const typeID = Zotero.ItemTypes.getID(event.data.fields.itemType);
            if (typeID) item.setType(typeID);
          }

          // Set parent key before fields (required for child notes/annotations)
          if (event.data.parentKey) {
            const parentItem = Zotero.Items.getByLibraryAndKey(libraryID, event.data.parentKey);
            if (parentItem) {
              item.parentKey = event.data.parentKey;
            } else {
              // Parent not yet created — defer to second pass
              deferred.push(event);
              continue;
            }
          }

          for (const [field, value] of Object.entries(event.data.fields || {})) {
            if (field === "itemType") continue;
            try {
              item.setField(field, value);
            } catch { /* skip */ }
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

          // Note content
          if (event.data.noteContent) {
            item.setNote(event.data.noteContent);
          }

          // Annotation data
          if (event.data.annotationData) {
            const ann = event.data.annotationData;
            try {
              item.annotationType = ann.type;
              if (ann.pageLabel) item.annotationPageLabel = ann.pageLabel;
              if (ann.position) item.annotationPosition = ann.position;
              if (ann.color) item.annotationColor = ann.color;
              if (ann.comment) item.annotationComment = ann.comment;
              if (ann.text) item.annotationText = ann.text;
              if (ann.sortIndex) item.annotationSortIndex = ann.sortIndex;
            } catch { /* some annotation props may not be settable */ }
          }

          await item.saveTx({ skipNotifier: true });
          applied++;
        }
      } catch (err) {
        logError(`Snapshot restore failed for ${event.entityKey}`, err);
      }
    }

    // Second pass: apply deferred child items (parent was created in first pass)
    if (deferred.length > 0) {
      log(`Processing ${deferred.length} deferred child items...`);
      for (const event of deferred) {
        try {
          let item = Zotero.Items.getByLibraryAndKey(libraryID, event.entityKey);
          if (!item) {
            item = new Zotero.Item();
            item.libraryID = libraryID;
            item.key = event.entityKey;
          }
          if (event.data.fields?.itemType) {
            const typeID = Zotero.ItemTypes.getID(event.data.fields.itemType);
            if (typeID) item.setType(typeID);
          }
          if (event.data.parentKey) {
            item.parentKey = event.data.parentKey;
          }
          for (const [field, value] of Object.entries(event.data.fields || {})) {
            if (field === "itemType") continue;
            try { item.setField(field, value); } catch { /* skip */ }
          }
          if (event.data.tags) item.setTags(event.data.tags);
          if (event.data.noteContent) item.setNote(event.data.noteContent);
          if (event.data.annotationData) {
            const ann = event.data.annotationData;
            try {
              item.annotationType = ann.type;
              if (ann.pageLabel) item.annotationPageLabel = ann.pageLabel;
              if (ann.position) item.annotationPosition = ann.position;
              if (ann.color) item.annotationColor = ann.color;
              if (ann.comment) item.annotationComment = ann.comment;
              if (ann.text) item.annotationText = ann.text;
              if (ann.sortIndex) item.annotationSortIndex = ann.sortIndex;
            } catch { /* skip */ }
          }
          await item.saveTx({ skipNotifier: true });
          applied++;
        } catch (err) {
          logError(`Deferred restore failed for ${event.entityKey}`, err);
        }
      }
    }

    log(`Snapshot restored: ${applied}/${events.length} entities applied`);
    return applied;
  }
}
