import { ChangeEvent, SyncConflict, ConflictResolution } from "./types";
import { log } from "../utils/logger";

/**
 * ConflictResolver detects and resolves conflicts between local and remote changes.
 *
 * Resolution strategy (per spec section 4.3):
 * - Different fields modified on same item → auto-merge (both kept)
 * - Same field modified, different values → last-timestamp-wins
 * - Item added on one device, deleted on another → user dialog
 * - Attachment modified on both → keep both versions (rename older)
 * - Tag added + tag deleted → bias toward keeping (conservation)
 */
export class ConflictResolver {
  private unresolvedConflicts: SyncConflict[] = [];

  /**
   * Check if two change events conflict on the same entity.
   * Returns null if no conflict, or a SyncConflict if they do.
   */
  detectConflict(
    local: ChangeEvent,
    remote: ChangeEvent,
  ): SyncConflict | null {
    // Only conflicts on the same entity
    if (
      local.entityKey !== remote.entityKey ||
      local.entityType !== remote.entityType
    ) {
      return null;
    }

    // Add vs delete = conflict (needs user input)
    if (
      (local.type === "add" && remote.type === "delete") ||
      (local.type === "delete" && remote.type === "add")
    ) {
      return {
        entityKey: local.entityKey,
        entityType: local.entityType,
        fieldName: "*",
        localValue: local.type,
        remoteValue: remote.type,
        localDeviceId: local.deviceId,
        remoteDeviceId: remote.deviceId,
        localTimestamp: local.timestamp,
        remoteTimestamp: remote.timestamp,
      };
    }

    // Both modify the same entity: check field-level conflicts
    if (local.type === "modify" && remote.type === "modify") {
      return this.detectFieldConflict(local, remote);
    }

    return null;
  }

  /**
   * Resolve a conflict automatically where possible.
   * Returns the winning ChangeEvent, or null if user intervention is needed.
   */
  autoResolve(
    local: ChangeEvent,
    remote: ChangeEvent,
    conflict: SyncConflict,
  ): ChangeEvent | null {
    // Add vs delete: cannot auto-resolve
    if (conflict.fieldName === "*") {
      this.unresolvedConflicts.push(conflict);
      return null;
    }

    // Same field modified: last-timestamp-wins
    if (conflict.localTimestamp >= conflict.remoteTimestamp) {
      log(
        `Auto-resolved conflict on ${conflict.entityKey}.${conflict.fieldName}: kept local (newer)`,
      );
      return local;
    } else {
      log(
        `Auto-resolved conflict on ${conflict.entityKey}.${conflict.fieldName}: kept remote (newer)`,
      );
      return remote;
    }
  }

  /**
   * Merge two modify events on the same entity at field level.
   * Fields changed only in one event are kept; fields changed in both → conflict.
   */
  mergeEvents(local: ChangeEvent, remote: ChangeEvent): ChangeEvent {
    const merged: ChangeEvent = {
      ...remote,
      data: { ...remote.data },
    };

    const localFields = local.data.fields || {};
    const remoteFields = remote.data.fields || {};

    // Merge fields: local fields that remote doesn't have
    merged.data.fields = { ...remoteFields };
    for (const [key, value] of Object.entries(localFields)) {
      if (!(key in remoteFields)) {
        merged.data.fields![key] = value;
      }
      // If both have the field with same value, no conflict
      // If different value, the conflict was already handled by autoResolve
    }

    // Tags: bias toward conservation (keep additions)
    if (local.data.tags && remote.data.tags) {
      const tagSet = new Set(
        [...local.data.tags, ...remote.data.tags].map((t) => t.tag),
      );
      merged.data.tags = Array.from(tagSet).map((tag) => ({ tag }));
    }

    // Creators: take the more recent version
    if (local.data.creators && remote.data.creators) {
      merged.data.creators =
        local.timestamp > remote.timestamp
          ? local.data.creators
          : remote.data.creators;
    }

    return merged;
  }

  /** Get unresolved conflicts that need user interaction */
  getUnresolved(): SyncConflict[] {
    return [...this.unresolvedConflicts];
  }

  /** Resolve a specific conflict with user's choice */
  resolveManually(
    conflict: SyncConflict,
    resolution: ConflictResolution,
  ): void {
    this.unresolvedConflicts = this.unresolvedConflicts.filter(
      (c) =>
        c.entityKey !== conflict.entityKey ||
        c.fieldName !== conflict.fieldName,
    );
    log(
      `Manually resolved conflict on ${conflict.entityKey}.${conflict.fieldName}: ${resolution}`,
    );
  }

  /** Clear all unresolved conflicts */
  clearUnresolved(): void {
    this.unresolvedConflicts = [];
  }

  private detectFieldConflict(
    local: ChangeEvent,
    remote: ChangeEvent,
  ): SyncConflict | null {
    const localFields = local.data.fields || {};
    const remoteFields = remote.data.fields || {};

    // Find fields modified in both events with different values
    for (const field of Object.keys(localFields)) {
      if (
        field in remoteFields &&
        JSON.stringify(localFields[field]) !==
          JSON.stringify(remoteFields[field])
      ) {
        return {
          entityKey: local.entityKey,
          entityType: local.entityType,
          fieldName: field,
          localValue: localFields[field],
          remoteValue: remoteFields[field],
          localDeviceId: local.deviceId,
          remoteDeviceId: remote.deviceId,
          localTimestamp: local.timestamp,
          remoteTimestamp: remote.timestamp,
        };
      }
    }

    // No conflicting fields — these can be merged automatically
    return null;
  }
}
