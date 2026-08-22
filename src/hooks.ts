import { ChangeTracker } from "./modules/core/change-tracker";
import { StateManager } from "./modules/core/state-manager";
import { SyncEngine, ProviderConnectionConfig } from "./modules/core/sync-engine";
import { initToolbar, destroyToolbar } from "./modules/ui/toolbar";
import { initPreferences } from "./modules/ui/preferences";
import { showError, showSuccess } from "./modules/ui/progress";
import { runMigrations } from "./modules/utils/migration";
import { WebDAVProvider } from "./modules/providers/webdav";
import { createProvider, isWebDAVProvider, ProviderType } from "./modules/providers/factory";
import { log, logError } from "./modules/utils/logger";

let changeTracker: ChangeTracker | null = null;
let stateManager: StateManager | null = null;
let syncEngine: SyncEngine | null = null;
let mainWindowReady = false;

async function onStartup() {
  try {
    await Promise.all([
      Zotero.initializationPromise,
      Zotero.unlockPromise,
      Zotero.uiReadyPromise,
    ]);

    log("Zotero ready, initializing ZotCloud...");

    // Run schema migrations
    try {
      await runMigrations();
    } catch (err) {
      Zotero.log("[ZotCloud] Migration failed: " + String(err), "error");
    }

    // Initialize state manager (device ID, vector clocks)
    stateManager = new StateManager();
    await stateManager.init();

    // Initialize change tracker (Notifier listener)
    changeTracker = new ChangeTracker(stateManager);
    changeTracker.register();

    // Initialize sync engine
    syncEngine = new SyncEngine(stateManager, changeTracker);

    // Expose for UI access
    (Zotero.ZotCloud as any).stateManager = stateManager;
    (Zotero.ZotCloud as any).changeTracker = changeTracker;
    (Zotero.ZotCloud as any).syncEngine = syncEngine;
    (Zotero.ZotCloud as any).initPreferences = initPreferences;

    // Auto-restore provider from saved prefs
    await restoreProvider(syncEngine);

    log("Plugin started, device: " + stateManager.deviceId);

    // If the main window is already open (common in Zotero 8),
    // manually initialize UI since onMainWindowLoad may have already fired
    if (!mainWindowReady) {
      try {
        const win = Zotero.getMainWindow();
        if (win && win.document && win.document.readyState === "complete") {
          log("Main window already open, initializing UI manually");
          setupUI(win);
        }
      } catch {
        // No main window yet — onMainWindowLoad will handle it
      }
    }
  } catch (err) {
    Zotero.log("[ZotCloud] STARTUP FAILED: " + String(err), "error");
  }
}

/**
 * Restore all saved provider connections from preferences.
 * Supports multiple simultaneous providers.
 * Migrates from legacy single-provider pref if needed.
 */
async function restoreProvider(engine: SyncEngine) {
  const configs = SyncEngine.loadConnectionConfigs();

  if (configs.length === 0) {
    log("No saved providers, skipping auto-restore");
    return;
  }

  log(`Restoring ${configs.length} provider connection(s)...`);
  let restoredCount = 0;

  for (const config of configs) {
    if (!config.enabled) continue;

    try {
      await restoreSingleProvider(engine, config);
      restoredCount++;
    } catch (err) {
      logError(`Failed to restore provider ${config.key}`, err);
      // Don't clear the saved provider — user can reconnect manually
    }
  }

  if (restoredCount > 0) {
    const syncOnStartup = Zotero.Prefs.get("extensions.zotcloud.syncOnStartup");
    if (syncOnStartup) {
      engine.scheduleSync();
    }
    engine.startPeriodicSync();
    log(`Restored ${restoredCount}/${configs.length} provider(s)`);
  }
}

/** Restore a single provider connection */
async function restoreSingleProvider(
  engine: SyncEngine,
  config: ProviderConnectionConfig,
): Promise<void> {
  const providerType = config.type as ProviderType;

  if (isWebDAVProvider(providerType)) {
    const url = Zotero.Prefs.get("extensions.zotcloud.webdav.url") as string;
    const username = Zotero.Prefs.get("extensions.zotcloud.webdav.username") as string;
    log(`WebDAV restore (${config.key}): url=${url ? "set" : "empty"}, username=${username ? "set" : "empty"}`);
    if (!url || !username) {
      log(`WebDAV config incomplete for ${config.key}, skipping`);
      return;
    }
    const provider = new WebDAVProvider();
    log(`WebDAV restore: authenticating to ${url}...`);
    await provider.authenticate();
    engine.addProvider(config.key, provider, config.cloudFolder);
    log(`WebDAV provider restored: ${config.key}`);
  } else {
    // OAuth providers (google-drive, dropbox, pcloud)
    const provider = createProvider(providerType);
    await provider.authenticate();
    engine.addProvider(config.key, provider, config.cloudFolder);
    log(`${config.key} provider restored from saved config`);
  }
}

function onShutdown() {
  syncEngine?.stop();
  changeTracker?.unregister();
  destroyToolbar();

  // Remove our menu items
  try {
    const win = Zotero.getMainWindow();
    if (win) {
      const ids = [
        "zotcloud-menu-sync",
        "zotcloud-menu-browser",
        "zotcloud-menu-settings",
        "zotcloud-toolbar-container",
      ];
      for (const id of ids) {
        win.document.getElementById(id)?.remove();
      }
    }
  } catch { /* ok */ }

  changeTracker = null;
  stateManager = null;
  syncEngine = null;

  log("Plugin shutdown");
}

function onMainWindowLoad(win: { window: Window }) {
  try {
    log("onMainWindowLoad called");
    setupUI(win.window);
  } catch (err) {
    Zotero.log("[ZotCloud] onMainWindowLoad FAILED: " + String(err), "error");
  }
}

function onMainWindowUnload(_win: { window: Window }) {
  mainWindowReady = false;
  destroyToolbar();
}

/** Set up all UI elements in the main window — called from onMainWindowLoad or manually */
function setupUI(win: Window) {
  if (mainWindowReady) return; // already set up
  mainWindowReady = true;

  const doc = win.document;

  // --- Menu items (raw DOM, no toolkit dependency) ---
  const menuTools = doc.getElementById("menu_ToolsPopup");
  if (!menuTools) {
    log("menu_ToolsPopup not found");
  } else {
    // Sync Now
    const syncItem = doc.createElementNS(
      "http://www.mozilla.org/keymaster/gatekeeper/there.is" +
        ".only.xul",
      "menuitem",
    );
    syncItem.id = "zotcloud-menu-sync";
    syncItem.setAttribute("label", "ZotCloud - Sync Now");
    syncItem.addEventListener("command", () => syncEngine?.syncNow());
    menuTools.appendChild(syncItem);

    // Force Full Sync
    const forceSyncItem = doc.createElementNS(
      "http://www.mozilla.org/keymaster/gatekeeper/there.is" +
        ".only.xul",
      "menuitem",
    );
    forceSyncItem.id = "zotcloud-menu-force-sync";
    forceSyncItem.setAttribute("label", "ZotCloud - Force Full Sync");
    forceSyncItem.addEventListener("command", () => {
      syncEngine?.forceFullSync()
        .then((summary) => showSuccess(summary || "Force full sync completed"))
        .catch((err) => {
          logError("Force full sync failed", err);
          showError("Force full sync failed: " + (err?.message || String(err)));
        });
    });
    menuTools.appendChild(forceSyncItem);

    // Cloud Browser
    const browserItem = doc.createElementNS(
      "http://www.mozilla.org/keymaster/gatekeeper/there.is" +
        ".only.xul",
      "menuitem",
    );
    browserItem.id = "zotcloud-menu-browser";
    browserItem.setAttribute("label", "ZotCloud - Cloud Browser");
    browserItem.addEventListener("command", () => {
      const win = Zotero.getMainWindow();
      let browserUrl = "chrome://zotcloud/content/browser.html";
      const params = new URLSearchParams();

      // Check active connections in sync engine
      const connections = syncEngine?.getConnections() || [];
      if (connections.length > 0) {
        const first = connections[0];
        const isWebDAV = first.key.startsWith("webdav") || first.key.startsWith("pcloud-webdav");
        if (isWebDAV) {
          // WebDAV: pass credentials directly for auto-connect
          const url = Zotero.Prefs.get("extensions.zotcloud.webdav.url") as string;
          const user = Zotero.Prefs.get("extensions.zotcloud.webdav.username") as string;
          const folder = first.cloudFolder;
          if (url) params.set("url", url);
          if (user) params.set("user", user);
          if (folder && folder !== "/ZotCloud") params.set("folder", folder);
          try {
            const loginManager = Components.classes[
              "@mozilla.org/login-manager;1"
            ].getService(Components.interfaces.nsILoginManager);
            const logins = loginManager.findLogins(
              "chrome://zotcloud", null, "ZotCloud WebDAV",
            );
            if (logins.length > 0) {
              params.set("pass", logins[0].password);
            }
          } catch { /* ignore */ }
        } else {
          // OAuth provider: pass provider key — browser uses syncEngine API
          params.set("provider", first.key);
        }
      }

      const qs = params.toString();
      if (qs) browserUrl += "?" + qs;
      win.open(
        browserUrl,
        "zotcloud-browser",
        "chrome,centerscreen,resizable,width=1200,height=800",
      );
    });
    menuTools.appendChild(browserItem);

    // Settings
    const settingsItem = doc.createElementNS(
      "http://www.mozilla.org/keymaster/gatekeeper/there.is" +
        ".only.xul",
      "menuitem",
    );
    settingsItem.id = "zotcloud-menu-settings";
    settingsItem.setAttribute("label", "ZotCloud Settings...");
    settingsItem.addEventListener("command", () => {
      Zotero.getMainWindow().openDialog(
        "chrome://zotcloud/content/preferences.xhtml",
        "zotcloud-settings",
        "chrome,centerscreen,resizable,width=620,height=600",
        { Zotero, ZotCloud: Zotero.ZotCloud },
      );
    });
    menuTools.appendChild(settingsItem);

    log("Menu items registered");
  }

  // Register preference pane
  try {
    Zotero.PreferencePanes.register({
      pluginID: "zotcloud@sorin.hostiuc",
      src: "chrome://zotcloud/content/preferences.xhtml",
      label: "ZotCloud",
    });
    log("Preference pane registered");
  } catch (err) {
    Zotero.log("[ZotCloud] PreferencePanes.register failed: " + String(err), "error");
  }

  // --- Toolbar badge ---
  try {
    initToolbar(doc);
  } catch (err) {
    Zotero.log("[ZotCloud] initToolbar failed: " + String(err), "error");
  }

  log("UI setup complete");
}

export { onStartup, onShutdown, onMainWindowLoad, onMainWindowUnload };
