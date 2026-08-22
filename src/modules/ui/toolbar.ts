import { StateManager } from "../core/state-manager";
import { SyncEngine } from "../core/sync-engine";

/**
 * Toolbar sync status badge.
 * Shows sync state (green/blue/amber/red) in Zotero's toolbar,
 * following ZotCloud_Mockup_MainWindow.html design.
 */

let updateInterval: ReturnType<typeof setInterval> | null = null;

export function initToolbar(doc: Document): void {
  const stateManager = (Zotero.ZotCloud as any).stateManager as StateManager;
  const syncEngine = (Zotero.ZotCloud as any).syncEngine as SyncEngine;

  const toolbar = doc.getElementById("zotero-items-toolbar") ||
    doc.getElementById("zotero-toolbar");
  if (!toolbar) return;

  // Create sync badge container
  const badge = doc.createElement("div");
  badge.id = "zotcloud-sync-badge";
  badge.style.cssText =
    "display:flex;align-items:center;gap:6px;padding:4px 10px;" +
    "border-radius:6px;cursor:pointer;margin-left:8px;font-size:12px;font-weight:500;";

  // Status indicator dot
  const dot = doc.createElement("span");
  dot.id = "zotcloud-status-dot";
  dot.style.cssText = "width:8px;height:8px;border-radius:50%;flex-shrink:0;";

  // Status text
  const text = doc.createElement("span");
  text.id = "zotcloud-status-text";
  text.style.cssText = "font-size:12px;";

  // Sync time
  const meta = doc.createElement("span");
  meta.id = "zotcloud-sync-meta";
  meta.style.cssText = "font-size:11px;color:#999;margin-left:4px;";

  badge.appendChild(dot);
  badge.appendChild(text);
  badge.appendChild(meta);

  // Click to sync
  badge.addEventListener("click", () => {
    syncEngine.syncNow();
  });

  // Create container and append to toolbar
  const container = doc.createElement("div");
  container.id = "zotcloud-toolbar-container";
  container.appendChild(badge);
  toolbar.appendChild(container);

  // Start periodic status updates
  updateToolbarStatus(doc, stateManager);
  updateInterval = setInterval(
    () => updateToolbarStatus(doc, stateManager),
    5000,
  );
}

export function destroyToolbar(): void {
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }
}

function updateToolbarStatus(doc: Document, stateManager: StateManager): void {
  const dot = doc.getElementById("zotcloud-status-dot");
  const text = doc.getElementById("zotcloud-status-text");
  const meta = doc.getElementById("zotcloud-sync-meta");
  const badge = doc.getElementById("zotcloud-sync-badge");

  if (!dot || !text || !meta || !badge) return;

  const state = stateManager.getSyncState();
  const providerName = state.provider
    ? state.provider.charAt(0).toUpperCase() + state.provider.slice(1)
    : "";

  switch (state.status) {
    case "idle":
      dot.style.background = "#1d9e75";
      text.textContent = "ZotCloud synced";
      text.style.color = "#0f6e56";
      badge.style.background = "#e1f5ee";
      badge.style.border = "1px solid #0f6e56";
      break;
    case "syncing":
      dot.style.background = "#378add";
      text.textContent = "Syncing...";
      text.style.color = "#185fa5";
      badge.style.background = "#e6f1fb";
      badge.style.border = "1px solid #378add";
      break;
    case "conflict":
      dot.style.background = "#ba7517";
      text.textContent = `${stateManager.pendingChanges} conflicts`;
      text.style.color = "#854f0b";
      badge.style.background = "#faeeda";
      badge.style.border = "1px solid #ba7517";
      break;
    case "error":
      dot.style.background = "#a32d2d";
      text.textContent = "Sync error";
      text.style.color = "#a32d2d";
      badge.style.background = "#fcebeb";
      badge.style.border = "1px solid #a32d2d";
      break;
  }

  // Time since last sync
  if (state.lastSuccessfulSync > 0) {
    const ago = formatTimeAgo(state.lastSuccessfulSync);
    meta.textContent = `${ago}${providerName ? " via " + providerName : ""}`;
  } else {
    meta.textContent = providerName ? `via ${providerName}` : "Not synced yet";
  }
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
