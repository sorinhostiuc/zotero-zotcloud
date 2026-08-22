import { describe, it, expect, beforeEach } from "vitest";
import { ConflictResolver } from "../../src/modules/core/conflict-resolver";
import { ChangeEvent } from "../../src/modules/core/types";

function makeEvent(overrides: Partial<ChangeEvent> = {}): ChangeEvent {
  return {
    id: "test-" + Math.random().toString(36).slice(2),
    deviceId: "device-1",
    timestamp: Date.now(),
    vectorClock: { "device-1": 1 },
    type: "modify",
    entityType: "item",
    entityKey: "ABCDEFGH",
    libraryID: 1,
    data: { fields: {} },
    ...overrides,
  };
}

describe("ConflictResolver", () => {
  let resolver: ConflictResolver;

  beforeEach(() => {
    resolver = new ConflictResolver();
  });

  it("returns null for events on different entities", () => {
    const local = makeEvent({ entityKey: "AAA" });
    const remote = makeEvent({ entityKey: "BBB" });
    expect(resolver.detectConflict(local, remote)).toBeNull();
  });

  it("detects add vs delete conflict", () => {
    const local = makeEvent({ type: "add" });
    const remote = makeEvent({ type: "delete", deviceId: "device-2" });
    const conflict = resolver.detectConflict(local, remote);
    expect(conflict).not.toBeNull();
    expect(conflict!.fieldName).toBe("*");
  });

  it("detects field-level conflict on same field", () => {
    const local = makeEvent({
      data: { fields: { title: "Local Title" } },
      timestamp: 1000,
    });
    const remote = makeEvent({
      data: { fields: { title: "Remote Title" } },
      deviceId: "device-2",
      timestamp: 2000,
    });
    const conflict = resolver.detectConflict(local, remote);
    expect(conflict).not.toBeNull();
    expect(conflict!.fieldName).toBe("title");
    expect(conflict!.localValue).toBe("Local Title");
    expect(conflict!.remoteValue).toBe("Remote Title");
  });

  it("returns null when different fields are modified", () => {
    const local = makeEvent({
      data: { fields: { title: "New Title" } },
    });
    const remote = makeEvent({
      data: { fields: { date: "2026" } },
      deviceId: "device-2",
    });
    const conflict = resolver.detectConflict(local, remote);
    expect(conflict).toBeNull();
  });

  it("auto-resolves field conflict with last-timestamp-wins", () => {
    const local = makeEvent({
      data: { fields: { title: "Local" } },
      timestamp: 2000,
    });
    const remote = makeEvent({
      data: { fields: { title: "Remote" } },
      deviceId: "device-2",
      timestamp: 1000,
    });
    const conflict = resolver.detectConflict(local, remote)!;
    const winner = resolver.autoResolve(local, remote, conflict);
    expect(winner).toBe(local); // local is newer
  });

  it("cannot auto-resolve add vs delete", () => {
    const local = makeEvent({ type: "add" });
    const remote = makeEvent({ type: "delete", deviceId: "device-2" });
    const conflict = resolver.detectConflict(local, remote)!;
    const winner = resolver.autoResolve(local, remote, conflict);
    expect(winner).toBeNull();
    expect(resolver.getUnresolved()).toHaveLength(1);
  });

  it("merges events with different fields", () => {
    const local = makeEvent({
      data: { fields: { title: "My Title" }, tags: [{ tag: "test" }] },
      timestamp: 1000,
    });
    const remote = makeEvent({
      data: { fields: { date: "2026" }, tags: [{ tag: "review" }] },
      deviceId: "device-2",
      timestamp: 2000,
    });

    const merged = resolver.mergeEvents(local, remote);
    expect(merged.data.fields!.title).toBe("My Title");
    expect(merged.data.fields!.date).toBe("2026");
    // Tags: both kept (conservation bias)
    const tagNames = merged.data.tags!.map((t) => t.tag).sort();
    expect(tagNames).toEqual(["review", "test"]);
  });

  it("clears unresolved conflicts", () => {
    const local = makeEvent({ type: "add" });
    const remote = makeEvent({ type: "delete", deviceId: "device-2" });
    const conflict = resolver.detectConflict(local, remote)!;
    resolver.autoResolve(local, remote, conflict);
    expect(resolver.getUnresolved()).toHaveLength(1);

    resolver.clearUnresolved();
    expect(resolver.getUnresolved()).toHaveLength(0);
  });
});
