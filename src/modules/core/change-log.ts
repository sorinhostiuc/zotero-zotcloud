import { ChangeEvent } from "./types";
import { log, logError } from "../utils/logger";

/**
 * ChangeLog provides persistent storage for ChangeEvents using Zotero's
 * built-in SQLite database via a dedicated table.
 *
 * Events are stored in JSON format and batch-read for sync operations.
 * The log supports append, read-since-timestamp, and garbage collection
 * (clearing events older than the latest snapshot).
 */
export class ChangeLog {
  private static TABLE = "zotcloudChangeLog";
  private static initialized = false;

  /** Create the changelog table if it doesn't exist */
  static async init() {
    if (this.initialized) return;

    await Zotero.DB.queryAsync(`
      CREATE TABLE IF NOT EXISTS ${this.TABLE} (
        id TEXT PRIMARY KEY,
        deviceId TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        vectorClock TEXT NOT NULL,
        type TEXT NOT NULL,
        entityType TEXT NOT NULL,
        entityKey TEXT NOT NULL,
        libraryID INTEGER NOT NULL,
        data TEXT NOT NULL,
        previousData TEXT,
        synced INTEGER DEFAULT 0
      )
    `);

    await Zotero.DB.queryAsync(`
      CREATE INDEX IF NOT EXISTS idx_${this.TABLE}_timestamp
      ON ${this.TABLE} (timestamp)
    `);

    await Zotero.DB.queryAsync(`
      CREATE INDEX IF NOT EXISTS idx_${this.TABLE}_synced
      ON ${this.TABLE} (synced)
    `);

    this.initialized = true;
    log("ChangeLog table initialized");
  }

  /** Append a change event to the log */
  static async append(event: ChangeEvent): Promise<void> {
    await this.init();

    await Zotero.DB.queryAsync(
      `INSERT OR REPLACE INTO ${this.TABLE}
       (id, deviceId, timestamp, vectorClock, type, entityType, entityKey, libraryID, data, previousData, synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        event.id,
        event.deviceId,
        event.timestamp,
        JSON.stringify(event.vectorClock),
        event.type,
        event.entityType,
        event.entityKey,
        event.libraryID,
        JSON.stringify(event.data),
        event.previousData ? JSON.stringify(event.previousData) : null,
      ],
    );
  }

  /** Append multiple events in a transaction */
  static async appendBatch(events: ChangeEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.init();

    await Zotero.DB.executeTransaction(async () => {
      for (const event of events) {
        await Zotero.DB.queryAsync(
          `INSERT OR REPLACE INTO ${this.TABLE}
           (id, deviceId, timestamp, vectorClock, type, entityType, entityKey, libraryID, data, previousData, synced)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          [
            event.id,
            event.deviceId,
            event.timestamp,
            JSON.stringify(event.vectorClock),
            event.type,
            event.entityType,
            event.entityKey,
            event.libraryID,
            JSON.stringify(event.data),
            event.previousData ? JSON.stringify(event.previousData) : null,
          ],
        );
      }
    });
  }

  /** Get all unsynced events for this device */
  static async getUnsynced(): Promise<ChangeEvent[]> {
    await this.init();

    const rows = await Zotero.DB.queryAsync(
      `SELECT * FROM ${this.TABLE} WHERE synced = 0 ORDER BY timestamp ASC`,
    );
    return this.rowsToEvents(rows);
  }

  /** Get events since a given timestamp */
  static async getSince(timestamp: number): Promise<ChangeEvent[]> {
    await this.init();

    const rows = await Zotero.DB.queryAsync(
      `SELECT * FROM ${this.TABLE} WHERE timestamp > ? ORDER BY timestamp ASC`,
      [timestamp],
    );
    return this.rowsToEvents(rows);
  }

  /** Mark events as synced */
  static async markSynced(eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) return;
    await this.init();

    const placeholders = eventIds.map(() => "?").join(",");
    await Zotero.DB.queryAsync(
      `UPDATE ${this.TABLE} SET synced = 1 WHERE id IN (${placeholders})`,
      eventIds,
    );
  }

  /** Mark all events with timestamp <= the given value as synced (multi-provider GC) */
  static async markSyncedBefore(timestamp: number): Promise<void> {
    await this.init();
    await Zotero.DB.queryAsync(
      `UPDATE ${this.TABLE} SET synced = 1 WHERE timestamp <= ? AND synced = 0`,
      [timestamp],
    );
  }

  /** Delete events older than a given timestamp (garbage collection) */
  static async deleteOlderThan(timestamp: number): Promise<number> {
    await this.init();

    const result = await Zotero.DB.queryAsync(
      `DELETE FROM ${this.TABLE} WHERE timestamp < ? AND synced = 1`,
      [timestamp],
    );
    return result?.changes || 0;
  }

  /** Get total count of events */
  static async count(): Promise<number> {
    await this.init();

    const rows = await Zotero.DB.queryAsync(
      `SELECT COUNT(*) as cnt FROM ${this.TABLE}`,
    );
    return rows?.[0]?.cnt || 0;
  }

  /** Get count of unsynced events */
  static async unsyncedCount(): Promise<number> {
    await this.init();

    const rows = await Zotero.DB.queryAsync(
      `SELECT COUNT(*) as cnt FROM ${this.TABLE} WHERE synced = 0`,
    );
    return rows?.[0]?.cnt || 0;
  }

  private static rowsToEvents(rows: any[]): ChangeEvent[] {
    if (!rows) return [];
    return rows.map((row: any) => ({
      id: row.id,
      deviceId: row.deviceId,
      timestamp: row.timestamp,
      vectorClock: JSON.parse(row.vectorClock),
      type: row.type,
      entityType: row.entityType,
      entityKey: row.entityKey,
      libraryID: row.libraryID,
      data: JSON.parse(row.data),
      previousData: row.previousData ? JSON.parse(row.previousData) : undefined,
    }));
  }
}
