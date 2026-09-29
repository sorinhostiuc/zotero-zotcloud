import { describe, it, expect, beforeEach, vi } from "vitest";
import { StateManager } from "../../src/modules/core/state-manager";

/** Install an in-memory Zotero.Prefs so persistence actually round-trips. */
function installPrefStore(initial: Record<string, any> = {}): Record<string, any> {
  const store: Record<string, any> = { ...initial };
  (globalThis as any).Zotero.Prefs = {
    get: vi.fn((k: string) => store[k]),
    set: vi.fn((k: string, v: any) => { store[k] = v; }),
  };
  return store;
}

describe("StateManager vector clock persistence", () => {
  beforeEach(() => {
    installPrefStore({ "extensions.zotcloud.deviceId": "dev-A" });
  });

  it("persists the clock across restarts instead of resetting to 0", async () => {
    const sm1 = new StateManager();
    await sm1.init();
    sm1.incrementClock();
    sm1.incrementClock();              // dev-A -> 2
    sm1.mergeClock({ "dev-B": 20307 }); // remember what we saw from dev-B

    // Simulate a Zotero restart: a fresh instance reads the same pref store.
    const sm2 = new StateManager();
    await sm2.init();

    const clock = sm2.getClock();
    expect(clock["dev-A"]).toBe(2);
    expect(clock["dev-B"]).toBe(20307);
  });

  it("hasRemoteChanges honors a persisted remote counter", async () => {
    const sm = new StateManager();
    await sm.init();
    sm.mergeClock({ "dev-B": 5 });
    expect(sm.hasRemoteChanges({ "dev-B": 5 })).toBe(false); // already applied
    expect(sm.hasRemoteChanges({ "dev-B": 6 })).toBe(true);
  });

  it("tracks applied snapshot timestamps per device, monotonically", async () => {
    const sm = new StateManager();
    await sm.init();
    expect(sm.getAppliedSnapshot("dev-B")).toBe(0);
    sm.setAppliedSnapshot("dev-B", 1000);
    expect(sm.getAppliedSnapshot("dev-B")).toBe(1000);
    sm.setAppliedSnapshot("dev-B", 500); // older must not regress
    expect(sm.getAppliedSnapshot("dev-B")).toBe(1000);
  });

  it("resetClock clears remote counters and persists the reset", async () => {
    const sm = new StateManager();
    await sm.init();
    sm.mergeClock({ "dev-B": 9 });
    sm.resetClock();
    expect(sm.getClock()).toEqual({ "dev-A": 0 });

    const sm2 = new StateManager();
    await sm2.init();
    expect(sm2.getClock()["dev-B"]).toBeUndefined();
  });
});
