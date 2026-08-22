import { SyncEngine, ProviderConnection } from "../core/sync-engine";
import { StateManager } from "../core/state-manager";
import { AttachmentSync, ItemMetadata } from "../core/attachment-sync";
import {
  createProvider,
  getAvailableProviders,
  getProviderLabel,
  getWebDAVPreset,
  isWebDAVProvider,
  ProviderType,
} from "../providers/factory";
import { WebDAVProvider } from "../providers/webdav";
import { log, logError } from "../utils/logger";

/**
 * Preference pane controller.
 * Builds the settings UI dynamically using pure DOM API (no innerHTML —
 * innerHTML fails silently in XHTML documents).
 */
export function initPreferences(doc: Document): void {
  const root = doc.getElementById("zotcloud-settings-root");
  if (!root) return;

  const syncEngine = (Zotero.ZotCloud as any).syncEngine as SyncEngine;
  const stateManager = (Zotero.ZotCloud as any).stateManager as StateManager;

  // Clear
  while (root.firstChild) root.removeChild(root.firstChild);

  appendSection(root, doc, "Cloud providers", buildProviderSection(doc, syncEngine));
  appendSection(root, doc, "Sync options", buildSyncOptions(doc));
  appendSection(root, doc, "File organization", buildFileOrganizationSection(doc));
  appendSection(root, doc, "This device", buildDeviceSection(doc, stateManager));
  appendSection(root, doc, "Connected devices", buildDeviceList(doc, syncEngine));
  appendDangerSection(root, doc, syncEngine, stateManager);
}

// --- Helpers ---

function el(doc: Document, tag: string, style?: string, text?: string): HTMLElement {
  const e = doc.createElement(tag);
  if (style) e.style.cssText = style;
  if (text) e.textContent = text;
  return e;
}

function fieldLabel(doc: Document, text: string): HTMLElement {
  return el(doc, "div", "font-size:11px;color:#6b6b6b;margin-bottom:4px;", text);
}

function textInput(doc: Document, value: string, style?: string): HTMLInputElement {
  const input = doc.createElement("input") as HTMLInputElement;
  input.type = "text";
  input.value = value;
  input.style.cssText = style || "width:100%;font-size:12px;height:32px;padding:5px 10px;border:1px solid #e0e0d8;border-radius:4px;background-color:#ffffff;color:#1a1a1a;box-sizing:border-box;box-sizing:border-box;";
  return input;
}

/**
 * Custom dropdown component (replaces native <select> which renders transparent
 * in Zotero 8's chrome:// privileged context).
 */
function createCustomDropdown(
  doc: Document,
  options: Array<{ value: string; label: string }>,
  selectedValue: string,
  onChange: (value: string) => void,
  style?: string,
): HTMLElement {
  const wrapper = el(doc, "div", "position:relative;display:inline-block;" + (style || "width:100%;"));
  wrapper.className = "zotcloud-dropdown";

  const toggle = el(doc, "div",
    "font-size:12px;padding:5px 28px 5px 10px;height:32px;border:1px solid #e0e0d8;border-radius:4px;" +
    "background:#ffffff;color:#1a1a1a;cursor:pointer;user-select:none;white-space:nowrap;overflow:hidden;" +
    "text-overflow:ellipsis;display:flex;align-items:center;box-sizing:border-box;position:relative;",
  );

  // Chevron
  const chevron = el(doc, "span", "position:absolute;right:10px;top:50%;transform:translateY(-50%);font-size:8px;color:#999;pointer-events:none;", "\u25BC");
  toggle.appendChild(chevron);

  const menu = el(doc, "div",
    "display:none;position:absolute;top:100%;left:0;right:0;z-index:9999;background:#ffffff;border:1px solid #e0e0d8;" +
    "border-radius:4px;box-shadow:0 4px 12px rgba(0,0,0,0.15);max-height:240px;overflow-y:auto;margin-top:2px;",
  );

  let currentValue = selectedValue;

  function updateLabel(): void {
    const sel = options.find(o => o.value === currentValue) || options[0];
    // Keep chevron, update text
    while (toggle.firstChild !== chevron && toggle.firstChild) toggle.removeChild(toggle.firstChild);
    toggle.insertBefore(doc.createTextNode(sel ? sel.label : ""), chevron);
  }
  updateLabel();

  for (const opt of options) {
    const item = el(doc, "div",
      "padding:6px 10px;font-size:12px;cursor:pointer;color:#1a1a1a;background:#ffffff;white-space:nowrap;" +
      "overflow:hidden;text-overflow:ellipsis;" +
      (opt.value === currentValue ? "background:#e6f1fb;color:#185fa5;font-weight:500;" : ""),
      opt.label,
    );
    item.addEventListener("mouseenter", () => { item.style.background = "#e6f1fb"; item.style.color = "#185fa5"; });
    item.addEventListener("mouseleave", () => {
      if (opt.value === currentValue) { item.style.background = "#e6f1fb"; item.style.color = "#185fa5"; }
      else { item.style.background = "#ffffff"; item.style.color = "#1a1a1a"; }
    });
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      currentValue = opt.value;
      updateLabel();
      menu.style.display = "none";
      // Reset all item styles
      for (let i = 0; i < menu.children.length; i++) {
        const child = menu.children[i] as HTMLElement;
        child.style.background = "#ffffff";
        child.style.color = "#1a1a1a";
        child.style.fontWeight = "";
      }
      item.style.background = "#e6f1fb";
      item.style.color = "#185fa5";
      item.style.fontWeight = "500";
      onChange(opt.value);
    });
    menu.appendChild(item);
  }

  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    // Close all other open dropdowns
    doc.querySelectorAll(".zotcloud-dropdown > div:last-child").forEach((m) => {
      if (m !== menu) (m as HTMLElement).style.display = "none";
    });
    menu.style.display = menu.style.display === "block" ? "none" : "block";
  });

  // Close on outside click
  doc.addEventListener("click", () => { menu.style.display = "none"; });

  wrapper.appendChild(toggle);
  wrapper.appendChild(menu);
  return wrapper;
}

function styledButton(doc: Document, text: string, primary: boolean): HTMLButtonElement {
  const btn = doc.createElement("button") as HTMLButtonElement;
  btn.textContent = text;
  btn.style.cssText = primary
    ? "font-size:11px;padding:5px 12px;border:1px solid #378add;border-radius:4px;background:#e6f1fb;color:#185fa5;cursor:pointer;"
    : "font-size:11px;padding:5px 12px;border:1px solid #c0c0b8;border-radius:4px;background:transparent;cursor:pointer;";
  return btn;
}

function appendSection(root: HTMLElement, doc: Document, title: string, content: HTMLElement): void {
  const section = el(doc, "div");
  section.className = "zotcloud-section";
  const h2 = el(doc, "h2", undefined, title);
  section.appendChild(h2);
  section.appendChild(content);
  root.appendChild(section);
}

// --- Sections ---

function buildProviderSection(doc: Document, syncEngine: SyncEngine): HTMLElement {
  const container = el(doc, "div");
  container.className = "zotcloud-provider-list";

  // Show ALL connected providers (multi-provider support)
  const connections = syncEngine.getConnections();

  for (const conn of connections) {
    const card = el(doc, "div", "display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:6px;border:1px solid #378add;background:#e6f1fb;margin-bottom:8px;");

    const info = el(doc, "div", "flex:1;");
    const label = getProviderLabel(conn.key as ProviderType) || conn.provider.getName();
    info.appendChild(el(doc, "div", "font-weight:500;", label));
    const statusText = conn.enabled ? "Connected" : "Disabled";
    const lastSync = conn.lastSyncedTimestamp > 0
      ? ` · Last sync: ${new Date(conn.lastSyncedTimestamp).toLocaleTimeString()}`
      : "";
    info.appendChild(el(doc, "div", "font-size:11px;color:#185fa5;", statusText + lastSync));
    info.appendChild(el(doc, "div", "font-size:10px;color:#999;", conn.cloudFolder));

    const disconnectBtn = doc.createElement("button") as HTMLButtonElement;
    disconnectBtn.textContent = "Disconnect";
    disconnectBtn.style.cssText = "color:#a32d2d;border:1px solid #a32d2d;font-size:11px;padding:3px 8px;border-radius:4px;background:transparent;cursor:pointer;";
    disconnectBtn.addEventListener("click", async () => {
      await conn.provider.disconnect();
      syncEngine.removeProvider(conn.key);
      // Stop periodic sync if no providers remain
      if (syncEngine.getConnections().length === 0) {
        syncEngine.stop();
        Zotero.Prefs.set("extensions.zotcloud.provider", "");
      }
      initPreferences(doc);
    });

    card.appendChild(info);
    card.appendChild(disconnectBtn);
    container.appendChild(card);
  }

  // "Add provider" dropdown — always shown so user can add more
  const addRow = el(doc, "div", "display:flex;align-items:center;gap:8px;margin-top:8px;");

  // Filter out already-connected provider types
  const connectedKeys = new Set(connections.map(c => c.key));
  const availableProviders = getAvailableProviders().filter(t => !connectedKeys.has(t));

  let selectedProvider = "";
  const providerOptions = [
    { value: "", label: connections.length > 0 ? "Add another provider..." : "Select provider..." },
    ...availableProviders.map(t => ({ value: t, label: getProviderLabel(t) })),
  ];
  const providerDropdown = createCustomDropdown(doc, providerOptions, "", (val) => { selectedProvider = val; }, "flex:1;");

  const connectBtn = styledButton(doc, "Connect", true);
  connectBtn.addEventListener("click", async () => {
    const type = selectedProvider as ProviderType;
    if (!type) return;

    if (isWebDAVProvider(type)) {
      showWebDAVConfig(doc, container, syncEngine, type);
      return;
    }

    showOAuthConfig(doc, container, syncEngine, type);
  });

  addRow.appendChild(providerDropdown);
  addRow.appendChild(connectBtn);
  container.appendChild(addRow);

  return container;
}

/** Fix mangled WebDAV URLs from previous bugs (e.g. https://http:/host → http://host) */
function cleanWebDAVUrl(url: string): string {
  let cleaned = url.replace(/^https?:\/\/(https?:)/i, "$1");
  cleaned = cleaned.replace(/^(https?):\/([^/])/i, "$1://$2");
  return cleaned;
}

/** Load saved WebDAV password from nsILoginManager or prefs fallback */
function loadSavedPassword(): string {
  try {
    const loginManager = Components.classes[
      "@mozilla.org/login-manager;1"
    ].getService(Components.interfaces.nsILoginManager);
    const logins = loginManager.findLogins(
      "chrome://zotcloud", null, "ZotCloud WebDAV",
    );
    if (logins.length > 0) return logins[0].password;
  } catch { /* nsILoginManager not available */ }

  // Fallback to prefs
  try {
    const pwd = Zotero.Prefs.get("extensions.zotcloud.webdav._password") as string;
    if (pwd) return pwd;
  } catch { /* pref not found */ }

  return "";
}

/**
 * Load WebDAV credentials from Zotero's built-in sync settings.
 * Tries multiple pref key patterns and password storage locations.
 */
function loadZoteroWebDAVCredentials(): { url: string; username: string; password: string } | null {
  try {
    // Try reading Zotero's WebDAV prefs — try multiple key patterns
    let scheme = "";
    let urlPart = "";
    let username = "";

    // Pattern 1: direct pref keys (Zotero.Prefs.get may auto-prefix extensions.zotero.)
    const prefPatterns = [
      { scheme: "sync.storage.scheme", url: "sync.storage.url", user: "sync.storage.username" },
      { scheme: "extensions.zotero.sync.storage.scheme", url: "extensions.zotero.sync.storage.url", user: "extensions.zotero.sync.storage.username" },
    ];

    for (const pattern of prefPatterns) {
      try {
        const s = (Zotero.Prefs.get(pattern.scheme) as string) || "";
        const u = (Zotero.Prefs.get(pattern.url) as string) || "";
        const n = (Zotero.Prefs.get(pattern.user) as string) || "";
        log(`Zotero prefs [${pattern.scheme}]: scheme=${s}, url=${u}, user=${n}`);
        if (s && u && n) {
          scheme = s;
          urlPart = u;
          username = n;
          break;
        }
      } catch { /* pref doesn't exist */ }
    }

    if (!scheme || !urlPart || !username) {
      log("Zotero WebDAV prefs not found with any pattern");
      return null;
    }

    const fullUrl = scheme + "://" + urlPart.replace(/\/+$/, "");

    // Try multiple password storage locations
    let password = "";
    const loginManager = Components.classes[
      "@mozilla.org/login-manager;1"
    ].getService(Components.interfaces.nsILoginManager);

    // Locations Zotero might store WebDAV passwords
    const searchLocations = [
      { hostname: "chrome://zotero", realm: "Zotero Storage Server" },
      { hostname: scheme + "://" + urlPart.split("/")[0], realm: "Zotero Storage Server" },
      { hostname: fullUrl, realm: null as string | null },
      { hostname: "chrome://zotero", realm: null as string | null },
    ];

    for (const loc of searchLocations) {
      try {
        const logins = loginManager.findLogins(loc.hostname, null, loc.realm);
        log(`LoginManager search: hostname=${loc.hostname}, realm=${loc.realm} → ${logins.length} login(s)`);
        if (logins.length > 0) {
          password = logins[0].password;
          log(`Found password (len=${password.length}) at hostname=${loc.hostname}, realm=${loc.realm}`);
          break;
        }
      } catch (err) {
        log(`LoginManager search failed for ${loc.hostname}: ${err}`);
      }
    }

    if (!password) {
      log("Zotero WebDAV password not found in any credential store location");
      return null;
    }

    log("Imported Zotero WebDAV credentials: url=" + fullUrl + " user=" + username + " pass-len=" + password.length);
    return { url: fullUrl, username, password };
  } catch (err) {
    log("Failed to load Zotero WebDAV credentials: " + String(err));
    return null;
  }
}

function showWebDAVConfig(doc: Document, container: HTMLElement, syncEngine: SyncEngine, providerType: ProviderType = "webdav"): void {
  const existing = doc.getElementById("zotcloud-webdav-config");
  if (existing) existing.remove();
  // Also remove OAuth config if visible
  const existingOAuth = doc.getElementById("zotcloud-oauth-config");
  if (existingOAuth) existingOAuth.remove();

  const preset = getWebDAVPreset(providerType);
  const form = el(doc, "div", "margin-top:12px;padding:12px;border:1px solid #e0e0d8;border-radius:6px;");
  form.id = "zotcloud-webdav-config";

  const title = preset ? `${preset.label} Configuration` : "WebDAV Configuration";
  form.appendChild(el(doc, "div", "font-weight:500;margin-bottom:8px;", title));

  if (preset) {
    form.appendChild(el(doc, "div", "font-size:11px;color:#0f6e56;margin-bottom:8px;line-height:1.4;",
      "Uses your regular account credentials — no API keys needed."));
  }

  // URL — use dropdown if preset has multiple servers, otherwise text input
  form.appendChild(fieldLabel(doc, "Server URL"));
  let urlInput: HTMLInputElement;
  let urlValue = preset?.url || cleanWebDAVUrl((Zotero.Prefs.get("extensions.zotcloud.webdav.url") as string) || "");

  if (preset?.servers && preset.servers.length > 1) {
    // Dropdown for server selection (e.g. pCloud EU/US)
    const savedUrl = cleanWebDAVUrl((Zotero.Prefs.get("extensions.zotcloud.webdav.url") as string) || "");
    const matchedServer = preset.servers.find(s => s.url === savedUrl);
    const initialValue = matchedServer ? matchedServer.url : preset.servers[0].url;
    urlValue = initialValue;

    const serverDropdown = createCustomDropdown(
      doc,
      preset.servers.map(s => ({ value: s.url, label: s.label })),
      initialValue,
      (val) => { urlValue = val; urlInput.value = val; },
      "width:100%;margin-bottom:8px;",
    );
    form.appendChild(serverDropdown);

    // Hidden input to carry the value for connect logic
    urlInput = textInput(doc, initialValue, "display:none;");
    form.appendChild(urlInput);
  } else {
    const defaultUrl = preset?.url || cleanWebDAVUrl((Zotero.Prefs.get("extensions.zotcloud.webdav.url") as string) || "");
    urlInput = textInput(doc, defaultUrl, "width:100%;font-size:12px;height:32px;padding:5px 10px;border:1px solid #e0e0d8;border-radius:4px;background-color:#ffffff;color:#1a1a1a;box-sizing:border-box;box-sizing:border-box;margin-bottom:8px;");
    urlInput.placeholder = preset?.placeholder || "https://nas.local:5006/webdav";
    if (preset) urlInput.setAttribute("readonly", "true");
    form.appendChild(urlInput);
  }

  // Credentials
  const credRow = el(doc, "div", "display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;");

  const userDiv = el(doc, "div");
  userDiv.appendChild(fieldLabel(doc, "Username"));
  const userInput = textInput(doc, (Zotero.Prefs.get("extensions.zotcloud.webdav.username") as string) || "");
  userDiv.appendChild(userInput);

  const passDiv = el(doc, "div");
  passDiv.appendChild(fieldLabel(doc, "Password"));
  const passInput = doc.createElement("input") as HTMLInputElement;
  passInput.type = "password";
  passInput.value = loadSavedPassword();
  passInput.style.cssText = "width:100%;font-size:12px;height:32px;padding:5px 10px;border:1px solid #e0e0d8;border-radius:4px;background-color:#ffffff;color:#1a1a1a;box-sizing:border-box;box-sizing:border-box;";
  passDiv.appendChild(passInput);

  credRow.appendChild(userDiv);
  credRow.appendChild(passDiv);
  form.appendChild(credRow);

  // Cloud folder path
  form.appendChild(fieldLabel(doc, "Cloud folder path"));
  const folderInput = textInput(doc, (Zotero.Prefs.get("extensions.zotcloud.cloudFolderPath") as string) || "/ZotCloud", "width:100%;font-size:12px;height:32px;padding:5px 10px;border:1px solid #e0e0d8;border-radius:4px;background-color:#ffffff;color:#1a1a1a;box-sizing:border-box;box-sizing:border-box;margin-bottom:8px;");
  folderInput.placeholder = "/ZotCloud";
  form.appendChild(folderInput);

  // Import from Zotero button (only for plain WebDAV, not presets)
  if (!preset) {
    const importBtn = styledButton(doc, "Import from Zotero", false);
    importBtn.style.marginBottom = "8px";
    form.appendChild(importBtn);
    importBtn.addEventListener("click", () => {
      const zotCreds = loadZoteroWebDAVCredentials();
      if (zotCreds) {
        urlInput.value = zotCreds.url;
        urlValue = zotCreds.url;
        userInput.value = zotCreds.username;
        passInput.value = zotCreds.password;
        statusDiv.textContent = "Imported credentials from Zotero sync settings.";
        statusDiv.style.color = "#0f6e56";
      } else {
        statusDiv.textContent = "No WebDAV sync configured in Zotero, or password not found.";
        statusDiv.style.color = "#a32d2d";
      }
    });
  }

  // Buttons
  const btnRow = el(doc, "div", "display:flex;gap:8px;");
  const connectBtn = styledButton(doc, "Connect", true);
  const testBtn = styledButton(doc, "Test Connection", false);
  btnRow.appendChild(connectBtn);
  btnRow.appendChild(testBtn);
  form.appendChild(btnRow);

  const statusDiv = el(doc, "div", "margin-top:8px;font-size:11px;");
  form.appendChild(statusDiv);

  container.appendChild(form);

  /** Read the current URL from the input — covers both preset dropdown and manual text entry */
  function getCurrentUrl(): string {
    return urlInput.value || urlValue;
  }

  testBtn.addEventListener("click", async () => {
    const currentUrl = getCurrentUrl();
    if (!currentUrl) {
      statusDiv.textContent = "Please enter a WebDAV URL.";
      statusDiv.style.color = "#a32d2d";
      return;
    }
    const provider = new WebDAVProvider();
    provider.configure(currentUrl, userInput.value, passInput.value);
    try {
      statusDiv.textContent = "Testing...";
      statusDiv.style.color = "#6b6b6b";
      await provider.authenticate();
      statusDiv.textContent = "Connection successful!";
      statusDiv.style.color = "#0f6e56";
    } catch (err) {
      statusDiv.textContent = "Failed: " + (err instanceof Error ? err.message : String(err));
      statusDiv.style.color = "#a32d2d";
    }
  });

  connectBtn.addEventListener("click", async () => {
    const currentUrl = getCurrentUrl();
    if (!currentUrl) {
      statusDiv.textContent = "Please enter a WebDAV URL.";
      statusDiv.style.color = "#a32d2d";
      return;
    }
    const provider = new WebDAVProvider();
    provider.configure(currentUrl, userInput.value, passInput.value);
    try {
      statusDiv.textContent = "Connecting...";
      statusDiv.style.color = "#6b6b6b";
      await provider.authenticate();
      // configure() already saved normalized URL + username + password to prefs
      const cloudFolder = folderInput.value || "/ZotCloud";
      Zotero.Prefs.set("extensions.zotcloud.cloudFolderPath", cloudFolder);
      // Multi-provider: add connection (doesn't remove existing providers)
      syncEngine.addProvider(providerType, provider, cloudFolder);
      Zotero.Prefs.set("extensions.zotcloud.provider", providerType);
      statusDiv.textContent = "Running initial sync...";
      await syncEngine.initialSyncForConnection(providerType);
      syncEngine.startPeriodicSync();
      initPreferences(doc);
    } catch (err) {
      statusDiv.textContent = "Failed: " + (err instanceof Error ? err.message : String(err));
      statusDiv.style.color = "#a32d2d";
    }
  });
}

/** OAuth provider credential configuration with step-by-step instructions */
const OAUTH_CONFIG: Record<string, { prefPrefix: string; needsSecret: boolean; helpUrl: string; helpText: string; steps: string[] }> = {
  "google-drive": {
    prefPrefix: "gdrive",
    needsSecret: true,
    helpUrl: "https://console.cloud.google.com/apis/credentials",
    helpText: "Requires a Google Cloud project with Drive API enabled.",
    steps: [
      "1. Go to console.cloud.google.com → create a project (or select existing)",
      "2. APIs & Services → Library → search \"Google Drive API\" → Enable",
      "3. OAuth consent screen → User Type: External → fill app name + your email → Save",
      "4. OAuth consent screen → Test users → Add your Google email address",
      "5. APIs & Services → Credentials → + Create Credentials → OAuth client ID",
      "6. Application type: Web application (NOT Desktop!), Name: ZotCloud",
      "7. Authorized redirect URIs → Add: http://localhost:23119/oauth/callback",
      "8. Copy the Client ID and Client Secret below",
    ],
  },
  dropbox: {
    prefPrefix: "dropbox",
    needsSecret: false,
    helpUrl: "https://www.dropbox.com/developers/apps",
    helpText: "Requires a Dropbox app (free to create).",
    steps: [
      "1. Go to dropbox.com/developers → click App Console (top right)",
      "2. Create app → Choose: Scoped access → Full Dropbox",
      "3. Name: ZotCloud → Create app",
      "4. Settings tab → OAuth 2 → Redirect URIs → Add: http://localhost:23121/oauth/callback",
      "5. Settings tab → copy the App key (this is your Client ID) below",
      "6. Permissions tab → check these 3 permissions:",
      "   • files.metadata.read — read file/folder metadata",
      "   • files.content.read — download files",
      "   • files.content.write — upload/delete files",
      "7. Click Submit (bottom of Permissions tab) to save",
      "8. No App Secret needed (uses PKCE)",
    ],
  },
  pcloud: {
    prefPrefix: "pcloud",
    needsSecret: true,
    helpUrl: "https://docs.pcloud.com/my_apps/",
    helpText: "Requires a pCloud developer app. Tip: use \"pCloud (WebDAV)\" instead — no API keys needed!",
    steps: [
      "1. Go to docs.pcloud.com/my_apps/ → log in with your pCloud account",
      "2. Click \"New app\" → App name: ZotCloud",
      "3. Folder access: All folders, Write access: Yes",
      "4. Redirect URI: http://localhost:23122/oauth/callback",
      "5. Copy the Client ID and Client Secret from the app page",
      "6. Note: pCloud app creation may be temporarily unavailable — use \"pCloud (WebDAV)\" instead",
    ],
  },
};

function showOAuthConfig(doc: Document, container: HTMLElement, syncEngine: SyncEngine, type: ProviderType): void {
  const existing = doc.getElementById("zotcloud-oauth-config");
  if (existing) existing.remove();
  // Also remove WebDAV config if visible
  const existingWebDAV = doc.getElementById("zotcloud-webdav-config");
  if (existingWebDAV) existingWebDAV.remove();

  const config = OAUTH_CONFIG[type];
  if (!config) return;

  const form = el(doc, "div", "margin-top:12px;padding:12px;border:1px solid #e0e0d8;border-radius:6px;");
  form.id = "zotcloud-oauth-config";

  form.appendChild(el(doc, "div", "font-weight:500;margin-bottom:8px;", `${getProviderLabel(type)} Configuration`));
  form.appendChild(el(doc, "div", "font-size:11px;color:#6b6b6b;margin-bottom:4px;line-height:1.4;", config.helpText));

  // Step-by-step instructions (collapsible)
  const stepsToggle = el(doc, "div", "font-size:11px;color:#185fa5;cursor:pointer;margin-bottom:8px;user-select:none;", "▶ Show setup instructions");
  const stepsDiv = el(doc, "div", "display:none;margin-bottom:10px;padding:8px 10px;background:#f5f5f0;border-radius:4px;font-size:11px;line-height:1.8;color:#333;");
  for (const step of config.steps) {
    stepsDiv.appendChild(el(doc, "div", undefined, step));
  }
  stepsToggle.addEventListener("click", () => {
    if (stepsDiv.style.display === "none") {
      stepsDiv.style.display = "block";
      stepsToggle.textContent = "▼ Hide setup instructions";
    } else {
      stepsDiv.style.display = "none";
      stepsToggle.textContent = "▶ Show setup instructions";
    }
  });
  form.appendChild(stepsToggle);
  form.appendChild(stepsDiv);

  // Client ID
  form.appendChild(fieldLabel(doc, "Client ID / App Key"));
  const clientIdInput = textInput(
    doc,
    (Zotero.Prefs.get(`extensions.zotcloud.${config.prefPrefix}.clientId`) as string) || "",
    "width:100%;font-size:12px;height:32px;padding:5px 10px;border:1px solid #e0e0d8;border-radius:4px;background-color:#ffffff;color:#1a1a1a;box-sizing:border-box;box-sizing:border-box;margin-bottom:8px;",
  );
  clientIdInput.placeholder = "Paste your Client ID here";
  form.appendChild(clientIdInput);

  // Client Secret (if needed)
  let clientSecretInput: HTMLInputElement | null = null;
  if (config.needsSecret) {
    form.appendChild(fieldLabel(doc, "Client Secret"));
    clientSecretInput = textInput(
      doc,
      (Zotero.Prefs.get(`extensions.zotcloud.${config.prefPrefix}.clientSecret`) as string) || "",
      "width:100%;font-size:12px;height:32px;padding:5px 10px;border:1px solid #e0e0d8;border-radius:4px;background-color:#ffffff;color:#1a1a1a;box-sizing:border-box;box-sizing:border-box;margin-bottom:8px;",
    );
    clientSecretInput.placeholder = "Paste your Client Secret here";
    form.appendChild(clientSecretInput);
  }

  // Buttons
  const btnRow = el(doc, "div", "display:flex;gap:8px;align-items:center;");
  const connectBtn = styledButton(doc, "Authenticate & Connect", true);
  const helpLink = el(doc, "a", "font-size:11px;color:#185fa5;cursor:pointer;text-decoration:underline;", "Open developer console");
  (helpLink as HTMLAnchorElement).href = "#";
  helpLink.addEventListener("click", (e) => {
    e.preventDefault();
    Zotero.launchURL(config.helpUrl);
  });
  btnRow.appendChild(connectBtn);
  btnRow.appendChild(helpLink);
  form.appendChild(btnRow);

  const statusDiv = el(doc, "div", "margin-top:8px;font-size:11px;");
  form.appendChild(statusDiv);

  container.appendChild(form);

  connectBtn.addEventListener("click", async () => {
    const clientId = clientIdInput.value.trim();
    if (!clientId) {
      statusDiv.textContent = "Client ID is required.";
      statusDiv.style.color = "#a32d2d";
      return;
    }

    // Save credentials to prefs
    Zotero.Prefs.set(`extensions.zotcloud.${config.prefPrefix}.clientId`, clientId);
    if (config.needsSecret && clientSecretInput) {
      Zotero.Prefs.set(`extensions.zotcloud.${config.prefPrefix}.clientSecret`, clientSecretInput.value.trim());
    }

    try {
      connectBtn.textContent = "Connecting...";
      connectBtn.setAttribute("disabled", "true");
      statusDiv.textContent = "Opening browser for authorization...";
      statusDiv.style.color = "#6b6b6b";

      const provider = createProvider(type);
      await provider.authenticate();
      // Multi-provider: add connection (doesn't remove existing providers)
      const cloudFolder =
        (Zotero.Prefs.get("extensions.zotcloud.cloudFolderPath") as string) || "/ZotCloud";
      syncEngine.addProvider(type, provider, cloudFolder);
      Zotero.Prefs.set("extensions.zotcloud.provider", type);

      statusDiv.textContent = "Running initial sync...";
      await syncEngine.initialSyncForConnection(type);
      syncEngine.startPeriodicSync();
      initPreferences(doc);
    } catch (err) {
      connectBtn.textContent = "Authenticate & Connect";
      connectBtn.removeAttribute("disabled");
      statusDiv.textContent = "Failed: " + (err instanceof Error ? err.message : String(err));
      statusDiv.style.color = "#a32d2d";
    }
  });
}

function buildSyncOptions(doc: Document): HTMLElement {
  const container = el(doc, "div");
  const grid = el(doc, "div");
  grid.className = "zotcloud-grid";

  // Sync interval
  const intervalDiv = el(doc, "div");
  intervalDiv.appendChild(fieldLabel(doc, "Sync interval"));
  const intervals = [
    { label: "1 minute", value: "60000" },
    { label: "5 minutes", value: "300000" },
    { label: "15 minutes", value: "900000" },
    { label: "30 minutes", value: "1800000" },
    { label: "1 hour", value: "3600000" },
    { label: "Manual only", value: "0" },
  ];
  const currentInterval = String(Zotero.Prefs.get("extensions.zotcloud.syncInterval") || "300000");
  intervalDiv.appendChild(createCustomDropdown(doc, intervals, currentInterval, (val) => {
    Zotero.Prefs.set("extensions.zotcloud.syncInterval", parseInt(val, 10));
  }));

  // Max attachment size
  const maxSizeDiv = el(doc, "div");
  maxSizeDiv.appendChild(fieldLabel(doc, "Max attachment size"));
  const sizes = [
    { label: "10 MB", value: "10485760" },
    { label: "50 MB", value: "52428800" },
    { label: "100 MB", value: "104857600" },
    { label: "500 MB", value: "524288000" },
    { label: "No limit", value: "0" },
  ];
  const currentSize = String(Zotero.Prefs.get("extensions.zotcloud.maxAttachmentSize") || "104857600");
  maxSizeDiv.appendChild(createCustomDropdown(doc, sizes, currentSize, (val) => {
    Zotero.Prefs.set("extensions.zotcloud.maxAttachmentSize", parseInt(val, 10));
  }));

  grid.appendChild(intervalDiv);
  grid.appendChild(maxSizeDiv);
  container.appendChild(grid);

  // Checkboxes
  const checkboxes = [
    { pref: "syncAttachments", label: "Sync attachments (PDFs, snapshots)" },
    { pref: "syncStandaloneNotes", label: "Sync standalone notes" },
    { pref: "syncChildNotes", label: "Sync child notes (attached to items)" },
    { pref: "syncAnnotations", label: "Sync PDF annotations (highlights, comments)" },
    { pref: "syncOnStartup", label: "Sync on startup" },
    { pref: "syncOnChange", label: "Sync on item change (debounced, 30s)" },
    { pref: "encryptData", label: "Encrypt data before upload (AES-256)" },
  ];

  const cbGroup = el(doc, "div");
  cbGroup.className = "zotcloud-checkbox-group";

  for (const cb of checkboxes) {
    const label = doc.createElement("label");
    const input = doc.createElement("input") as HTMLInputElement;
    input.type = "checkbox";
    input.checked = !!Zotero.Prefs.get(`extensions.zotcloud.${cb.pref}`);
    input.addEventListener("change", () => {
      Zotero.Prefs.set(`extensions.zotcloud.${cb.pref}`, input.checked);
    });
    label.appendChild(input);
    label.appendChild(doc.createTextNode(" " + cb.label));
    cbGroup.appendChild(label);
  }

  container.appendChild(cbGroup);
  return container;
}

function buildFileOrganizationSection(doc: Document): HTMLElement {
  const container = el(doc, "div");

  // --- Row 1: Folder organization dropdown + filename separator ---
  const topRow = el(doc, "div");
  topRow.className = "zotcloud-grid";

  // Folder organization
  const orgDiv = el(doc, "div");
  orgDiv.appendChild(fieldLabel(doc, "Organize files by"));
  const orgOptions = [
    { label: "None (flat folder)", value: "none" },
    { label: "Author", value: "author" },
    { label: "Year", value: "year" },
    { label: "Item Type", value: "itemtype" },
    { label: "Journal", value: "journal" },
    { label: "Author / Year", value: "author-year" },
    { label: "Year / Author", value: "year-author" },
  ];
  const currentOrg = (Zotero.Prefs.get("extensions.zotcloud.folderOrganization") as string) || "none";
  let orgValue = currentOrg;
  const orgDropdown = createCustomDropdown(doc, orgOptions, currentOrg, (val) => { orgValue = val; saveAndPreview(); });
  orgDiv.appendChild(orgDropdown);

  // Separator dropdown
  const sepDiv = el(doc, "div");
  sepDiv.appendChild(fieldLabel(doc, "Separator between tags"));
  const sepOptions = [
    { label: "Space ( )", value: " " },
    { label: "Underscore (_)", value: "_" },
    { label: "Hyphen (-)", value: "-" },
    { label: "Dot (.)", value: "." },
  ];
  const currentSep = (Zotero.Prefs.get("extensions.zotcloud.filenameSeparator") as string) || " ";
  let sepValue = currentSep;
  const sepDropdown = createCustomDropdown(doc, sepOptions, currentSep, (val) => { sepValue = val; saveAndPreview(); });
  sepDiv.appendChild(sepDropdown);

  topRow.appendChild(orgDiv);
  topRow.appendChild(sepDiv);
  container.appendChild(topRow);

  // --- Row 2: Filename pattern ---
  const patternDiv = el(doc, "div", "margin-top:8px;");
  patternDiv.appendChild(fieldLabel(doc, "Filename pattern"));
  const patternInput = textInput(
    doc,
    (Zotero.Prefs.get("extensions.zotcloud.filenamePattern") as string) || "{firstauthor} {year} - {title}",
    "width:100%;font-size:12px;height:32px;padding:5px 10px;border:1px solid #e0e0d8;border-radius:4px;background-color:#ffffff;color:#1a1a1a;box-sizing:border-box;box-sizing:border-box;font-family:monospace;",
  );
  patternDiv.appendChild(patternInput);

  // Tag reference
  const tagRef = el(doc, "div", "font-size:10px;color:#999;margin-top:4px;line-height:1.5;",
    "Tags: {authors} {firstauthor} {lastauthor} {year} {title} {titleshort} {journal} {filename} {itemtype}");
  patternDiv.appendChild(tagRef);
  container.appendChild(patternDiv);

  // --- Row 3: Special folders ---
  const specialRow = el(doc, "div", "margin-top:8px;");
  specialRow.className = "zotcloud-grid";

  const starDiv = el(doc, "div");
  starDiv.appendChild(fieldLabel(doc, "Starred papers folder (empty = disabled)"));
  const starInput = textInput(
    doc,
    (Zotero.Prefs.get("extensions.zotcloud.starredFolder") as string) || "",
  );
  starInput.placeholder = "Starred";
  starDiv.appendChild(starInput);

  const trashDiv = el(doc, "div");
  trashDiv.appendChild(fieldLabel(doc, "Trashed items folder (empty = disabled)"));
  const trashInput = textInput(
    doc,
    (Zotero.Prefs.get("extensions.zotcloud.trashedFolder") as string) || "",
  );
  trashInput.placeholder = "Trash";
  trashDiv.appendChild(trashInput);

  specialRow.appendChild(starDiv);
  specialRow.appendChild(trashDiv);
  container.appendChild(specialRow);

  // --- Reorganize button ---
  const reorgRow = el(doc, "div", "margin-top:10px;display:flex;align-items:center;gap:8px;");
  const reorgBtn = styledButton(doc, "Reorganize existing files", true);
  const reorgStatus = el(doc, "span", "font-size:11px;color:#6b6b6b;");
  reorgRow.appendChild(reorgBtn);
  reorgRow.appendChild(reorgStatus);
  container.appendChild(reorgRow);

  reorgBtn.addEventListener("click", async () => {
    const syncEngine = (Zotero.ZotCloud as any).syncEngine as SyncEngine;
    const attachSync = syncEngine.getAttachmentSync();
    if (!attachSync) {
      reorgStatus.textContent = "No cloud provider connected.";
      reorgStatus.style.color = "#a32d2d";
      return;
    }

    reorgBtn.setAttribute("disabled", "true");
    reorgBtn.textContent = "Reorganizing...";
    reorgStatus.textContent = "";
    reorgStatus.style.color = "#6b6b6b";

    try {
      const count = await attachSync.reorganizeAttachments();
      reorgStatus.textContent = count > 0
        ? `Done! ${count} file${count > 1 ? "s" : ""} moved.`
        : "All files already in the correct location.";
      reorgStatus.style.color = "#0f6e56";
    } catch (err) {
      reorgStatus.textContent = "Failed: " + (err instanceof Error ? err.message : String(err));
      reorgStatus.style.color = "#a32d2d";
    } finally {
      reorgBtn.removeAttribute("disabled");
      reorgBtn.textContent = "Reorganize existing files";
    }
  });

  // --- Preview area ---
  const previewDiv = el(doc, "div", "margin-top:12px;padding:10px 12px;background:#f5f5f0;border-radius:6px;font-family:monospace;font-size:11px;line-height:1.6;white-space:pre-wrap;color:#333;");
  previewDiv.id = "zotcloud-file-org-preview";
  container.appendChild(previewDiv);

  // --- Update preview function ---
  const updatePreview = () => {
    const org = orgValue;
    const sep = sepValue;
    const pattern = patternInput.value;
    const starred = starInput.value;
    const trashed = trashInput.value;

    // Use sample data for preview (try real items first)
    const sampleItems = getSampleItems();
    const lines: string[] = [];
    const cloudFolder = (Zotero.Prefs.get("extensions.zotcloud.cloudFolderPath") as string) || "/ZotCloud";

    for (const sample of sampleItems) {
      const path = AttachmentSync.resolveCloudPathFromMetadata(
        sample.meta,
        sample.ext,
        org as any,
        pattern,
        sep,
        starred,
        trashed,
        sample.starred,
        sample.trashed,
      );
      lines.push(cloudFolder + "/" + path);
    }

    // Clear and rebuild preview
    while (previewDiv.firstChild) previewDiv.removeChild(previewDiv.firstChild);
    const previewLabel = el(doc, "div", "font-weight:500;margin-bottom:4px;font-family:sans-serif;", "Preview:");
    previewDiv.appendChild(previewLabel);
    for (const line of lines) {
      previewDiv.appendChild(el(doc, "div", "color:#185fa5;", line));
    }
  };

  // Wire up change handlers
  const saveAndPreview = () => {
    Zotero.Prefs.set("extensions.zotcloud.folderOrganization", orgValue);
    Zotero.Prefs.set("extensions.zotcloud.filenameSeparator", sepValue);
    Zotero.Prefs.set("extensions.zotcloud.filenamePattern", patternInput.value);
    Zotero.Prefs.set("extensions.zotcloud.starredFolder", starInput.value);
    Zotero.Prefs.set("extensions.zotcloud.trashedFolder", trashInput.value);
    updatePreview();
  };

  // orgDropdown and sepDropdown call saveAndPreview via their onChange callbacks
  patternInput.addEventListener("input", saveAndPreview);
  starInput.addEventListener("input", saveAndPreview);
  trashInput.addEventListener("input", saveAndPreview);

  // Initial preview
  updatePreview();

  return container;
}

/** Get sample items from the Zotero library for preview, with fallback to synthetic data */
function getSampleItems(): Array<{ meta: ItemMetadata; ext: string; starred: boolean; trashed: boolean }> {
  const samples: Array<{ meta: ItemMetadata; ext: string; starred: boolean; trashed: boolean }> = [];

  try {
    const libraryID = Zotero.Libraries.userLibraryID;
    const allItems = Zotero.Items.getAll(libraryID, true);
    // Pick up to 3 regular items (non-attachment, non-note)
    let count = 0;
    for (const item of allItems) {
      if (count >= 3) break;
      if (item.isNote?.() || item.isFeedItem) continue;
      if (item.isAttachment?.()) continue;

      const creators = item.getCreators?.() || [];
      const lastNames = creators.map((c: any) => c.lastName || c.firstName || "");

      let title = "";
      try { title = item.getField?.("title") || ""; } catch { /* */ }

      let year = "";
      try {
        const date = item.getField?.("date") || "";
        const m = date.match(/\d{4}/);
        if (m) year = m[0];
      } catch { /* */ }

      let journal = "";
      try { journal = item.getField?.("publicationTitle") || ""; } catch { /* */ }

      let itemType = "";
      try { itemType = Zotero.ItemTypes.getName(item.itemTypeID) || ""; } catch { /* */ }

      const FUNC_WORDS = new Set(["a","an","the","and","or","but","in","on","at","to","for","of","with","by","from","is","are","was","were"]);
      const titleShort = title.split(/\s+/).filter((w: string) => !FUNC_WORDS.has(w.toLowerCase())).join(" ");

      const tags = item.getTags?.() || [];
      const starred = tags.some((t: any) => t.tag === "⭐" || t.tag === "starred" || t.tag === "favorite");

      samples.push({
        meta: {
          authors: lastNames.join(", ") || "Unknown",
          firstAuthor: lastNames[0] || "Unknown",
          lastAuthor: lastNames[lastNames.length - 1] || "Unknown",
          year: year || "Unknown",
          title: title || "Untitled",
          titleShort: titleShort || "Untitled",
          journal: journal || "Unknown",
          itemType: itemType || "Unknown",
          originalFilename: "document.pdf",
        },
        ext: ".pdf",
        starred,
        trashed: !!item.deleted,
      });
      count++;
    }
  } catch {
    // Zotero API not available (e.g., in tests)
  }

  // Fallback: always provide at least 2 synthetic samples
  if (samples.length < 2) {
    samples.push(
      {
        meta: {
          authors: "Smith, Jones",
          firstAuthor: "Smith",
          lastAuthor: "Jones",
          year: "2024",
          title: "Finding Genes by Computational Analysis",
          titleShort: "Finding Genes Computational Analysis",
          journal: "Nature",
          itemType: "Journal Article",
          originalFilename: "document.pdf",
        },
        ext: ".pdf",
        starred: false,
        trashed: false,
      },
      {
        meta: {
          authors: "Chen, Li, Wang",
          firstAuthor: "Chen",
          lastAuthor: "Wang",
          year: "2023",
          title: "Deep Learning for Medical Image Segmentation",
          titleShort: "Deep Learning Medical Image Segmentation",
          journal: "IEEE TMI",
          itemType: "Conference Paper",
          originalFilename: "manuscript.pdf",
        },
        ext: ".pdf",
        starred: true,
        trashed: false,
      },
    );
  }

  return samples.slice(0, 3);
}

function buildDeviceSection(doc: Document, stateManager: StateManager): HTMLElement {
  const container = el(doc, "div");
  const grid = el(doc, "div");
  grid.className = "zotcloud-grid";

  // Device name
  const nameDiv = el(doc, "div");
  nameDiv.appendChild(fieldLabel(doc, "Device name"));
  const nameInput = textInput(doc, stateManager.getDeviceName());
  nameInput.addEventListener("change", () => {
    Zotero.Prefs.set("extensions.zotcloud.deviceName", nameInput.value);
  });
  nameDiv.appendChild(nameInput);

  // Cloud folder
  const folderDiv = el(doc, "div");
  folderDiv.appendChild(fieldLabel(doc, "Cloud folder path"));
  const folderInput = textInput(doc, (Zotero.Prefs.get("extensions.zotcloud.cloudFolderPath") as string) || "/ZotCloud");
  folderInput.addEventListener("change", () => {
    Zotero.Prefs.set("extensions.zotcloud.cloudFolderPath", folderInput.value);
  });
  folderDiv.appendChild(folderInput);

  grid.appendChild(nameDiv);
  grid.appendChild(folderDiv);
  container.appendChild(grid);

  container.appendChild(el(doc, "div", "font-size:11px;color:#999;margin-top:4px;", "Device ID: " + stateManager.deviceId));

  return container;
}

function buildDeviceList(doc: Document, syncEngine: SyncEngine): HTMLElement {
  const container = el(doc, "div");
  container.className = "zotcloud-device-list";

  const stateManager = (Zotero.ZotCloud as any).stateManager as StateManager;

  // This device
  const thisDevice = el(doc, "div", "display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;background:#f5f5f0;");

  thisDevice.appendChild(el(doc, "span", "width:8px;height:8px;border-radius:50%;background:#1d9e75;display:inline-block;"));

  const nameSpan = el(doc, "span", "font-size:12px;font-weight:500;flex:1;", stateManager.getDeviceName() + " ");
  const badge = el(doc, "span", "font-size:10px;padding:2px 8px;border-radius:4px;background:#e6f1fb;color:#185fa5;", "this device");
  nameSpan.appendChild(badge);
  thisDevice.appendChild(nameSpan);

  thisDevice.appendChild(el(doc, "span", "font-size:11px;color:#999;", "Online now"));
  container.appendChild(thisDevice);

  if (syncEngine.getProvider()) {
    loadRemoteDevices(doc, container, syncEngine);
  }

  return container;
}

async function loadRemoteDevices(doc: Document, container: HTMLElement, syncEngine: SyncEngine): Promise<void> {
  try {
    const cloudFolder = (Zotero.Prefs.get("extensions.zotcloud.cloudFolderPath") as string) || "/ZotCloud";
    const data = await syncEngine.getProvider()!.download(`${cloudFolder}/manifest.json`);
    const manifest = JSON.parse(new TextDecoder().decode(data));
    const stateManager = (Zotero.ZotCloud as any).stateManager as StateManager;

    for (const [deviceId, info] of Object.entries(manifest.devices || {})) {
      if (deviceId === stateManager.deviceId) continue;
      const deviceInfo = info as any;

      const row = el(doc, "div", "display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;background:#f5f5f0;margin-top:6px;");
      row.appendChild(el(doc, "span", "width:8px;height:8px;border-radius:50%;background:#999;display:inline-block;"));
      row.appendChild(el(doc, "span", "font-size:12px;font-weight:500;flex:1;", deviceInfo.name));
      row.appendChild(el(doc, "span", "font-size:11px;color:#999;", "Last seen: " + new Date(deviceInfo.lastSeen).toLocaleString()));
      container.appendChild(row);
    }
  } catch {
    // No manifest available yet
  }
}

function appendDangerSection(root: HTMLElement, doc: Document, syncEngine: SyncEngine, stateManager: StateManager): void {
  const section = el(doc, "div", "border-top:1px solid #e0e0d8;padding-top:16px;margin-top:16px;");

  // --- Directional sync ---
  const syncTitle = el(doc, "h2", "color:#1a1a1a;margin-bottom:8px;", "Sync actions");
  section.appendChild(syncTitle);

  const syncDesc = el(doc, "div", "font-size:11px;color:#6b6b6b;margin-bottom:12px;",
    "Use these when sync gets out of sync. Push overwrites cloud with your local library. Pull overwrites local with cloud data.");
  section.appendChild(syncDesc);

  const syncActions = el(doc, "div", "display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;");

  // Inline status line \u2014 reports the REAL outcome (success summary or the actual
  // error message) instead of a meaningless "Done!" on the button.
  const syncStatus = el(doc, "div",
    "font-size:11px;margin-bottom:16px;min-height:15px;line-height:1.4;white-space:pre-wrap;", "");

  const runSyncAction = async (
    btn: HTMLButtonElement,
    label: string,
    busyLabel: string,
    action: () => Promise<string>,
  ): Promise<void> => {
    btn.disabled = true;
    btn.textContent = busyLabel;
    syncStatus.style.color = "#6b6b6b";
    syncStatus.textContent = busyLabel;
    try {
      const summary = await action();
      btn.textContent = "Done!";
      syncStatus.style.color = "#1d9e75";
      syncStatus.textContent = "\u2713 " + (summary || "Done");
    } catch (err) {
      btn.textContent = "Failed";
      syncStatus.style.color = "#a32d2d";
      syncStatus.textContent = "\u2717 " + ((err as { message?: string })?.message || String(err));
      logError(label + " failed", err);
    } finally {
      setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 2000);
    }
  };

  // Push to cloud button
  const pushBtn = styledButton(doc, "Push local \u2192 Cloud", true);
  pushBtn.addEventListener("click", () =>
    runSyncAction(pushBtn, "Push local \u2192 Cloud", "Pushing...", () => syncEngine.pushToCloud()));

  // Pull from cloud button
  const pullBtn = styledButton(doc, "Pull Cloud \u2192 Local", true);
  pullBtn.addEventListener("click", () =>
    runSyncAction(pullBtn, "Pull Cloud \u2192 Local", "Pulling...", () => syncEngine.pullFromCloud()));

  // Force full sync (bidirectional)
  const forceBtn = styledButton(doc, "Force full sync (bidirectional)", false);
  forceBtn.addEventListener("click", () =>
    runSyncAction(forceBtn, "Force full sync (bidirectional)", "Syncing...", () => syncEngine.forceFullSync()));

  syncActions.appendChild(pushBtn);
  syncActions.appendChild(pullBtn);
  syncActions.appendChild(forceBtn);
  section.appendChild(syncActions);
  section.appendChild(syncStatus);

  // --- Danger zone ---
  const dangerTitle = el(doc, "h2", "color:#a32d2d;margin-bottom:8px;", "Danger zone");
  section.appendChild(dangerTitle);

  const dangerActions = el(doc, "div", "display:flex;gap:8px;flex-wrap:wrap;");

  const deleteBtn = dangerButton(doc, "Delete cloud data", async () => {
    deleteBtn.disabled = true;
    deleteBtn.textContent = "Deleting...";
    try {
      await syncEngine.deleteAllCloudData();
      deleteBtn.textContent = "Deleted!";
      setTimeout(() => { deleteBtn.textContent = "Delete cloud data"; deleteBtn.disabled = false; }, 2000);
    } catch (err) {
      deleteBtn.textContent = "Failed";
      deleteBtn.disabled = false;
      logError("Delete cloud data failed", err);
    }
  });

  const exportBtn = styledButton(doc, "Export debug log", false);
  exportBtn.style.marginLeft = "auto";
  exportBtn.addEventListener("click", async () => {
    const debugInfo = {
      deviceId: stateManager.deviceId,
      deviceName: stateManager.getDeviceName(),
      syncState: stateManager.getSyncState(),
      connections: syncEngine.getConnections().map(c => ({
        key: c.key,
        cloudFolder: c.cloudFolder,
        lastSynced: c.lastSyncedTimestamp,
        enabled: c.enabled,
      })),
      provider: Zotero.Prefs.get("extensions.zotcloud.provider"),
      version: "0.1.0",
      zoteroVersion: Zotero.version,
      timestamp: new Date().toISOString(),
    };
    const content = JSON.stringify(debugInfo, null, 2);

    // Save to file via FilePicker
    try {
      const fp = Components.classes["@mozilla.org/filepicker;1"]
        .createInstance(Components.interfaces.nsIFilePicker);
      fp.init(doc.defaultView, "Save Debug Log", Components.interfaces.nsIFilePicker.modeSave);
      fp.defaultString = `zotcloud-debug-${Date.now()}.json`;
      fp.appendFilter("JSON Files", "*.json");
      const result = await new Promise<number>((resolve) => fp.open(resolve));
      if (result === Components.interfaces.nsIFilePicker.returnOK ||
          result === Components.interfaces.nsIFilePicker.returnReplace) {
        const path = fp.file.path;
        await IOUtils.writeUTF8(path, content);
        log("Debug log saved to " + path);
      }
    } catch (err) {
      // Fallback: copy to clipboard
      try {
        const clipboard = Components.classes["@mozilla.org/widget/clipboardhelper;1"]
          ?.getService(Components.interfaces.nsIClipboardHelper);
        clipboard?.copyString(content);
        log("Debug log copied to clipboard (file save failed)");
      } catch {
        logError("Export debug log failed", err);
      }
    }
  });

  dangerActions.appendChild(deleteBtn);
  dangerActions.appendChild(exportBtn);
  section.appendChild(dangerActions);
  root.appendChild(section);
}

function dangerButton(doc: Document, text: string, onClick: () => void): HTMLButtonElement {
  const btn = doc.createElement("button") as HTMLButtonElement;
  btn.textContent = text;
  btn.style.cssText = "font-size:11px;padding:5px 12px;border:1px solid #a32d2d;border-radius:4px;color:#a32d2d;background:transparent;cursor:pointer;";
  btn.addEventListener("click", onClick);
  return btn;
}
