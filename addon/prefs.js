// Cloud provider (empty = not configured)
pref("extensions.zotcloud.provider", "");

// Sync behavior
pref("extensions.zotcloud.syncInterval", 300000);
pref("extensions.zotcloud.syncAttachments", true);
pref("extensions.zotcloud.maxAttachmentSize", 104857600);
pref("extensions.zotcloud.syncOnStartup", true);
pref("extensions.zotcloud.syncOnChange", true);
pref("extensions.zotcloud.syncDebounceMs", 30000);

// Notes & annotations
pref("extensions.zotcloud.syncStandaloneNotes", true);
pref("extensions.zotcloud.syncChildNotes", true);
pref("extensions.zotcloud.syncAnnotations", true);

// Encryption
pref("extensions.zotcloud.encryptData", false);

// Cloud folder
pref("extensions.zotcloud.cloudFolderPath", "/ZotCloud");

// Device
pref("extensions.zotcloud.deviceId", "");
pref("extensions.zotcloud.deviceName", "");

// Snapshot
pref("extensions.zotcloud.snapshotInterval", 86400);

// File organization
pref("extensions.zotcloud.folderOrganization", "none");
pref("extensions.zotcloud.filenamePattern", "{firstauthor} {year} - {title}");
pref("extensions.zotcloud.filenameSeparator", " ");
pref("extensions.zotcloud.starredFolder", "");
pref("extensions.zotcloud.trashedFolder", "");

// Multi-provider configuration (JSON array of ProviderConnectionConfig)
pref("extensions.zotcloud.providers", "[]");

// WebDAV specific
pref("extensions.zotcloud.webdav.url", "");
pref("extensions.zotcloud.webdav.username", "");
pref("extensions.zotcloud.webdav._password", "");
