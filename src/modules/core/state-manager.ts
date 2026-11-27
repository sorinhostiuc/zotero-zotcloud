import { VectorClock, SyncState } from "./types";
import { generateUUID } from "../utils/uuid";
import { log } from "../utils/logger";

/**
 * StateManager handles device identity and vector clock state.
 *
 * Each Zotero installation gets a unique deviceId (UUID v4) stored in prefs.
 * The vector clock tracks the latest known counter per device, enabling
 * causal ordering of change events across multiple machines.
 */
export class StateManager {
  public deviceId: string = "";
  private vectorClock: VectorClock = {};
  private _status: SyncState["status"] = "idle";
  private _lastSyncTimestamp: number = 0;
  private _lastSuccessfulSync: number = 0;
  private _pendingChanges: number = 0;

  private static CLOCK_PREF = "extensions.zotcloud.vectorClock";
  private static APPLIED_SNAPSHOTS_PREF = "extensions.zotcloud.appliedSnapshots";

  async init() {
    // Load or generate device ID
    let storedId = Zotero.Prefs.get("extensions.zotcloud.deviceId") as string;
    if (!storedId) {
      storedId = generateUUID();
      Zotero.Prefs.set("extensions.zotcloud.deviceId", storedId);
      log("Generated new device ID: " + storedId);
    }
    this.deviceId = storedId;

    // Set default device name if empty
    let deviceName = Zotero.Prefs.get("extensions.zotcloud.deviceName") as string;
    if (!deviceName) {
      deviceName = this.getDefaultDeviceName();
      Zotero.Prefs.set("extensions.zotcloud.deviceName", deviceName);
    }

    // Load the PERSISTED vector clock. Previously this was hard-reset to
    // { [deviceId]: 0 } on every launch, so the device forgot which remote
    // changes it had already applied — forcing a full re-export each session
    // (which in turn triggered the destructive snapshot/GC path).
    this.vectorClock = this.loadClock();
    if (this.vectorClock[this.deviceId] === undefined) {
      this.vectorClock[this.deviceId] = 0;
    }

    log("StateManager initialized");
  }

  /** Load the persisted vector clock from prefs (empty if none/invalid). */
  private loadClock(): VectorClock {
    try {
      const raw = Zotero.Prefs.get(StateManager.CLOCK_PREF) as string;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") return parsed as VectorClock;
      }
    } catch { /* ignore malformed pref */ }
    return {};
  }

  /** Persist the vector clock so it survives restarts. */
  private persistClock() {
    try {
      Zotero.Prefs.set(StateManager.CLOCK_PREF, JSON.stringify(this.vectorClock));
    } catch { /* ignore */ }
  }

  /**
   * Highest snapshot timestamp already applied from a given device, so
   * incremental pulls can restore a compacted snapshot exactly once and then
   * replay only the changelog batches newer than it.
   */
  getAppliedSnapshot(deviceId: string): number {
    try {
      const raw = Zotero.Prefs.get(StateManager.APPLIED_SNAPSHOTS_PREF) as string;
      if (raw) {
        const map = JSON.parse(raw);
        if (map && typeof map === "object") return Number(map[deviceId]) || 0;
      }
    } catch { /* ignore */ }
    return 0;
  }

  setAppliedSnapshot(deviceId: string, timestamp: number) {
    try {
      const raw = Zotero.Prefs.get(StateManager.APPLIED_SNAPSHOTS_PREF) as string;
      const map = raw ? (JSON.parse(raw) || {}) : {};
      map[deviceId] = Math.max(Number(map[deviceId]) || 0, timestamp);
      Zotero.Prefs.set(StateManager.APPLIED_SNAPSHOTS_PREF, JSON.stringify(map));
    } catch { /* ignore */ }
  }

  /** Increment this device's counter in the vector clock and return a copy */
  incrementClock(): VectorClock {
    this.vectorClock[this.deviceId] =
      (this.vectorClock[this.deviceId] || 0) + 1;
    this.persistClock();
    return { ...this.vectorClock };
  }

  /** Get current vector clock (copy) */
  getClock(): VectorClock {
    return { ...this.vectorClock };
  }

  /** Reset the vector clock to zero (force full re-pull on next sync) */
  resetClock() {
    this.vectorClock = { [this.deviceId]: 0 };
    this.persistClock();
  }

  /** Merge a remote vector clock into ours (take max per device) */
  mergeClock(remote: VectorClock) {
    for (const [deviceId, counter] of Object.entries(remote)) {
      this.vectorClock[deviceId] = Math.max(
        this.vectorClock[deviceId] || 0,
        counter,
      );
    }
    this.persistClock();
  }

  /**
   * Check if remote clock has changes we haven't seen.
   * Returns true if any device counter in `remote` is greater than ours.
   */
  hasRemoteChanges(remote: VectorClock): boolean {
    for (const [deviceId, counter] of Object.entries(remote)) {
      if (deviceId === this.deviceId) continue;
      if (counter > (this.vectorClock[deviceId] || 0)) {
        return true;
      }
    }
    return false;
  }

  /** Get the device name */
  getDeviceName(): string {
    return (Zotero.Prefs.get("extensions.zotcloud.deviceName") as string) || "Unknown";
  }

  get status(): SyncState["status"] {
    return this._status;
  }

  set status(value: SyncState["status"]) {
    this._status = value;
  }

  get lastSyncTimestamp(): number {
    return this._lastSyncTimestamp;
  }

  set lastSyncTimestamp(value: number) {
    this._lastSyncTimestamp = value;
  }

  get lastSuccessfulSync(): number {
    return this._lastSuccessfulSync;
  }

  set lastSuccessfulSync(value: number) {
    this._lastSuccessfulSync = value;
  }

  get pendingChanges(): number {
    return this._pendingChanges;
  }

  set pendingChanges(value: number) {
    this._pendingChanges = value;
  }

  /** Get a SyncState snapshot */
  getSyncState(): SyncState {
    const provider = Zotero.Prefs.get("extensions.zotcloud.provider") as string;
    return {
      deviceId: this.deviceId,
      lastSyncTimestamp: this._lastSyncTimestamp,
      vectorClock: this.getClock(),
      provider: provider || "",
      lastSuccessfulSync: this._lastSuccessfulSync,
      pendingChanges: this._pendingChanges,
      status: this._status,
    };
  }

  private getDefaultDeviceName(): string {
    // Try to get a reasonable device name
    try {
      const appInfo = Components.classes["@mozilla.org/xre/app-info;1"]?.getService(
        Components.interfaces.nsIXULAppInfo,
      );
      return `Zotero ${appInfo?.version || ""}`.trim();
    } catch {
      return "Zotero Device";
    }
  }
}
