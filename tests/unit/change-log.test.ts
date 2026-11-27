import { describe, it, expect, vi } from "vitest";
import { ChangeLog } from "../../src/modules/core/change-log";

describe("ChangeLog.getSince boundary", () => {
  it("also matches same-millisecond events still marked unsynced", async () => {
    const calls: Array<{ sql: string; params: any }> = [];
    (globalThis as any).Zotero.DB = {
      queryAsync: vi.fn(async (sql: string, params: any) => {
        calls.push({ sql, params });
        return [];
      }),
      executeTransaction: async (fn: any) => fn(),
    };

    await ChangeLog.getSince(1000);

    const select = calls.find((c) => /SELECT \* FROM/.test(c.sql));
    expect(select).toBeTruthy();
    expect(select!.sql).toMatch(/timestamp > \?/);
    expect(select!.sql).toMatch(/timestamp = \? AND synced = 0/);
    expect(select!.params).toEqual([1000, 1000]);
  });
});
