import { beforeEach, describe, expect, it, vi } from "vitest";
import { SyncEngine } from "../../src/modules/core/sync-engine";
import { StateManager } from "../../src/modules/core/state-manager";
import { Snapshot } from "../../src/modules/core/snapshot";
import { ChangeLog } from "../../src/modules/core/change-log";
import { orderDependencies } from "../../src/modules/core/event-order";

const event = (key: string, entityType = "item", data: any = {}) => ({
  id: key, deviceId: "peer", timestamp: 10, vectorClock: { peer: 10 },
  type: "add", entityType, entityKey: key, libraryID: 1, data,
} as any);

function provider(files: Record<string, any>) {
  const store = new Map(Object.entries(files));
  return {
    store,
    getName: () => "test",
    download: vi.fn(async (path: string) => {
      if (!store.has(path)) throw new Error(`Read failed: ${path}`);
      return new TextEncoder().encode(JSON.stringify(store.get(path))).buffer;
    }),
    upload: vi.fn(async (path: string, data: any) => {
      store.set(path, JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)));
    }),
    list: vi.fn(async (path: string) => Array.from(store.keys())
      .filter(p => p.startsWith(path + "/") && !p.slice(path.length + 1).includes("/"))
      .map(p => ({ name: p.split("/").pop(), path: p, isDirectory: false }))),
    delete: vi.fn(async (path: string) => { store.delete(path); }),
    mkdir: vi.fn(),
  } as any;
}

async function engineFor(p: any) {
  const state = new StateManager();
  await state.init();
  state.lastSuccessfulSync = 123;
  const engine = new SyncEngine(state, { drainEvents: () => [] } as any) as any;
  engine.addProvider("test", p, "/ZotCloud");
  // Outgoing uploads are separate from these recovery/error tests.
  vi.spyOn(engine, "pushSince").mockResolvedValue(50);
  return { engine, state };
}

beforeEach(() => {
  vi.restoreAllMocks();
  const prefs = new Map<string, any>([["extensions.zotcloud.deviceId", "local"]]);
  (Zotero.Prefs.get as any).mockImplementation((k: string) => prefs.get(k));
  (Zotero.Prefs.set as any).mockImplementation((k: string, v: any) => prefs.set(k, v));
  (Zotero as any).Libraries = { userLibraryID: 1 };
  vi.spyOn(ChangeLog, "init").mockResolvedValue();
  vi.spyOn(ChangeLog, "getUnsynced").mockResolvedValue([]);
  vi.spyOn(ChangeLog, "unsyncedCount").mockResolvedValue(0);
  vi.spyOn(ChangeLog, "deletedEntityKeys").mockResolvedValue(new Set());
  vi.spyOn(ChangeLog, "deleteOlderThan").mockResolvedValue(0);
  vi.spyOn(ChangeLog, "markSyncedBefore").mockResolvedValue();
  (Zotero.Items.getByLibraryAndKey as any).mockReturnValue(false);
  (Zotero.Collections.getByLibraryAndKey as any).mockReturnValue(false);
});

const manifest = { vectorClock: { peer: 10 }, devices: { peer: {} } };
const remote = (events: any[]) => provider({
  "/ZotCloud/manifest.json": manifest,
  "/ZotCloud/snapshots/100.json": events,
  "/ZotCloud/snapshots/100.meta.json": { deviceId: "peer" },
});

describe("snapshot recovery", () => {
  it("recovers snapshot-only data even with an already acknowledged clock", async () => {
    const p = remote([event("child", "item", { parentKey: "parent" }),
      event("parent", "item", { collections: ["nested"] }),
      event("nested", "collection", { fields: { parentKey: "root" } }),
      event("root", "collection")]);
    const { engine, state } = await engineFor(p);
    state.mergeClock({ peer: 10 });
    const applied: string[] = [];
    vi.spyOn(engine, "applyRemoteEvent").mockImplementation(async (e: any) => {
      if (e.entityKey === "parent") expect(applied).toContain("nested");
      if (e.entityKey === "child") expect(applied).toContain("parent");
      applied.push(e.entityKey); return true;
    });
    await engine.syncNow();
    expect(applied).toEqual(["root", "nested", "parent", "child"]);
    expect(state.getAppliedSnapshot("peer")).toBe(100);
    expect(state.status).toBe("idle");
    await engine.syncNow();
    expect(applied).toHaveLength(4);
  });

  it("keeps existing edits and local deletions when filling gaps", async () => {
    const { engine } = await engineFor(remote([event("edited"), event("deleted"), event("new")]));
    (Zotero.Items.getByLibraryAndKey as any).mockImplementation((_l: number, key: string) => key === "edited");
    vi.mocked(ChangeLog.deletedEntityKeys).mockResolvedValue(new Set(["item:deleted"]));
    const apply = vi.spyOn(engine, "applyRemoteEvent").mockResolvedValue(true);
    await engine.syncNow();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0]).toMatchObject({ entityKey: "new" });
  });

  it("does not acknowledge a failed snapshot and retries it next cycle", async () => {
    const { engine, state } = await engineFor(remote([event("new")]));
    const apply = vi.spyOn(engine, "applyRemoteEvent").mockResolvedValue(false);
    await engine.syncNow();
    expect(state.status).toBe("error");
    expect(state.lastSuccessfulSync).toBe(123);
    expect(state.getAppliedSnapshot("peer")).toBe(0);
    expect(state.getClock().peer).toBeUndefined();
    expect(engine.getConnection("test").lastSyncedTimestamp).toBe(0);
    apply.mockResolvedValue(true);
    await engine.syncNow();
    expect(state.status).toBe("idle");
    expect(state.getAppliedSnapshot("peer")).toBe(100);
  });

  it("reports manifest/network failures instead of claiming success", async () => {
    const { engine, state } = await engineFor(provider({}));
    await engine.syncNow();
    expect(state.status).toBe("error");
    expect(state.lastSuccessfulSync).toBe(123);
    expect(ChangeLog.markSyncedBefore).not.toHaveBeenCalled();
  });

  it("does not advance the clock after a changelog apply failure", async () => {
    const p = provider({ "/ZotCloud/manifest.json": manifest,
      "/ZotCloud/changelog/peer/200.json": [event("new")] });
    const { engine, state } = await engineFor(p);
    vi.spyOn(engine, "applyRemoteEvent").mockResolvedValue(false);
    await engine.syncNow();
    expect(state.status).toBe("error");
    expect(state.getClock().peer).toBeUndefined();
    expect(state.lastSuccessfulSync).toBe(123);
  });

  it("keeps the overall status failed when one of two providers fails", async () => {
    const { engine, state } = await engineFor(remote([]));
    engine.addProvider("unreachable", provider({}), "/ZotCloud");
    await engine.syncNow();
    expect(state.status).toBe("error");
    expect(state.lastSuccessfulSync).toBe(123);
    expect(engine.getConnection("test").lastSyncedTimestamp).toBe(50);
    expect(engine.getConnection("unreachable").lastSyncedTimestamp).toBe(0);
  });
});

it("an empty device never deletes another device's baseline or changelog", async () => {
  const p = provider({
    "/ZotCloud/snapshots/100.json": [event("preserved")],
    "/ZotCloud/snapshots/100.meta.json": { deviceId: "peer" },
    "/ZotCloud/snapshots/101.json": [],
    "/ZotCloud/snapshots/101.meta.json": { deviceId: "local" },
    "/ZotCloud/snapshots/102.json": [event("unknown-owner")],
    "/ZotCloud/changelog/peer/100.json": [event("preserved")],
    "/ZotCloud/changelog/local/100.json": [],
  });
  const { engine } = await engineFor(p);
  vi.spyOn(Snapshot, "generate").mockResolvedValue({
    data: new TextEncoder().encode("[]").buffer,
    meta: { timestamp: 200, deviceId: "local", itemCount: 0, collectionCount: 0, schemaVersion: 1 },
  });
  await engine.createSnapshot();
  expect(p.store.has("/ZotCloud/snapshots/100.json")).toBe(true);
  expect(p.store.has("/ZotCloud/snapshots/100.meta.json")).toBe(true);
  expect(p.store.has("/ZotCloud/snapshots/102.json")).toBe(true);
  expect(p.store.has("/ZotCloud/changelog/peer/100.json")).toBe(true);
  expect(p.store.has("/ZotCloud/snapshots/101.json")).toBe(false);
  expect(p.store.has("/ZotCloud/changelog/local/100.json")).toBe(false);
  expect(p.store.has("/ZotCloud/snapshots/200.json")).toBe(true);
});

it("rejects dependency cycles before applying a snapshot", () => {
  expect(() => orderDependencies([event("A", "collection", { fields: { parentKey: "B" } }),
    event("B", "collection", { fields: { parentKey: "A" } })])).toThrow("Cyclic sync dependency");
});

it("does not report a partial forced recovery as successful", async () => {
  const p = remote([event("ok"), event("bad")]);
  p.store.set("/ZotCloud/attachments/_manifest.json", { files: {} });
  const { engine, state } = await engineFor(p);
  vi.spyOn(engine, "applyRemoteEventForced").mockImplementation(async (e: any) => e.entityKey === "ok");
  await expect(engine.pullFromCloud()).rejects.toThrow("entities could not be applied");
  expect(state.status).toBe("error");
  expect(state.lastSuccessfulSync).toBe(123);
  expect(state.getClock().peer).toBeUndefined();
});

it("does not mark snapshots applied when their directory cannot be read", async () => {
  const p = remote([event("new")]);
  p.list.mockRejectedValue(new Error("503"));
  const { engine, state } = await engineFor(p);
  await engine.syncNow();
  expect(state.status).toBe("error");
  expect(state.getAppliedSnapshot("peer")).toBe(0);
  expect(state.lastSuccessfulSync).toBe(123);
});

it("retains the final state when a batch changes the same item twice", () => {
  const first = event("A", "item", { fields: { title: "before" } });
  const last = event("A", "item", { fields: { title: "after" } });
  expect(orderDependencies([first, last])).toEqual([last]);
});

it("retries a failed changelog download without advancing the remote clock", async () => {
  const path = "/ZotCloud/changelog/peer/200.json";
  const p = provider({ "/ZotCloud/manifest.json": manifest, [path]: [event("new")] });
  const download = p.download.getMockImplementation();
  p.download.mockImplementation(async (name: string) => {
    if (name === path) throw new Error("503");
    return download(name);
  });
  const { engine, state } = await engineFor(p);
  await engine.syncNow();
  expect(state.status).toBe("error");
  expect(state.getClock().peer).toBeUndefined();
  expect(state.lastSuccessfulSync).toBe(123);
});
