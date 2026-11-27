import { describe, it, expect, vi } from "vitest";
import { runMigrations } from "../../src/modules/utils/migration";

function installDB(columns: string[]) {
  const store: Record<string, any> = { "extensions.zotcloud.schemaVersion": 1 };
  const queries: string[] = [];
  (globalThis as any).Zotero.Prefs = {
    get: (k: string) => store[k],
    set: (k: string, v: any) => { store[k] = v; },
  };
  (globalThis as any).Zotero.DB = {
    queryAsync: vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("PRAGMA table_info")) return columns.map((name) => ({ name }));
      // Real SQLite throws only when the column is actually already there.
      if (sql.includes("ALTER TABLE") && columns.includes("previousData")) {
        throw new Error("duplicate column name: previousData");
      }
      return [];
    }),
    executeTransaction: async (fn: any) => fn(),
  };
  return { store, queries };
}

describe("schema migration v1 -> v2", () => {
  it("does NOT ALTER when previousData already exists (no wedge on restart)", async () => {
    const { store, queries } = installDB(["id", "deviceId", "previousData"]);
    await expect(runMigrations()).resolves.toBeUndefined();
    expect(queries.some((q) => q.includes("ALTER TABLE"))).toBe(false);
    expect(store["extensions.zotcloud.schemaVersion"]).toBe(2);
  });

  it("ALTERs to add previousData when the column is missing", async () => {
    const { store, queries } = installDB(["id", "deviceId"]);
    await runMigrations();
    expect(queries.some((q) => q.includes("ALTER TABLE"))).toBe(true);
    expect(store["extensions.zotcloud.schemaVersion"]).toBe(2);
  });
});
