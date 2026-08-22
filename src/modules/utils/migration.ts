import { log } from "./logger";

/**
 * Schema version migrations for ChangeLog and cloud data format.
 * Each migration is a function that upgrades the local schema by one version.
 * Runs on startup to apply any pending migrations.
 */

const CURRENT_SCHEMA_VERSION = 2;
const PREF_KEY = "extensions.zotcloud.schemaVersion";

type Migration = () => Promise<void>;

/** Ordered list of migrations. Index 0 = migration from v0 → v1, etc. */
const migrations: Migration[] = [
  // v0 → v1: initial schema, create changeLog table
  async () => {
    await Zotero.DB.queryAsync(`
      CREATE TABLE IF NOT EXISTS zotcloudChangeLog (
        id TEXT PRIMARY KEY,
        deviceId TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        vectorClock TEXT NOT NULL,
        type TEXT NOT NULL,
        entityType TEXT NOT NULL,
        entityKey TEXT NOT NULL,
        libraryID INTEGER NOT NULL,
        data TEXT NOT NULL,
        synced INTEGER DEFAULT 0
      )
    `);
    await Zotero.DB.queryAsync(`
      CREATE INDEX IF NOT EXISTS idx_zotcloud_synced
      ON zotcloudChangeLog (synced)
    `);
    await Zotero.DB.queryAsync(`
      CREATE INDEX IF NOT EXISTS idx_zotcloud_timestamp
      ON zotcloudChangeLog (timestamp)
    `);
  },
  // v1 → v2: add previousData column
  async () => {
    await Zotero.DB.queryAsync(`
      ALTER TABLE zotcloudChangeLog ADD COLUMN previousData TEXT
    `);
  },
];

/**
 * Run any pending migrations to bring local schema up to date.
 * Safe to call multiple times — only runs migrations not yet applied.
 */
export async function runMigrations(): Promise<void> {
  const currentVersion =
    (Zotero.Prefs.get(PREF_KEY) as number) || 0;

  if (currentVersion >= CURRENT_SCHEMA_VERSION) {
    return;
  }

  log(
    `Running migrations: v${currentVersion} → v${CURRENT_SCHEMA_VERSION}`,
  );

  for (let v = currentVersion; v < CURRENT_SCHEMA_VERSION; v++) {
    const migration = migrations[v];
    if (!migration) {
      throw new Error(`Missing migration for v${v} → v${v + 1}`);
    }

    log(`Applying migration v${v} → v${v + 1}`);
    await migration();
  }

  Zotero.Prefs.set(PREF_KEY, CURRENT_SCHEMA_VERSION);
  log(`Migrations complete, now at v${CURRENT_SCHEMA_VERSION}`);
}
