import { vi } from "vitest";

// Mock Zotero global for test environment
(globalThis as any).Zotero = {
  log: vi.fn(),
  Prefs: {
    get: vi.fn().mockReturnValue(""),
    set: vi.fn(),
  },
  Notifier: {
    registerObserver: vi.fn().mockReturnValue("mock-notifier-id"),
    unregisterObserver: vi.fn(),
  },
  Items: {
    get: vi.fn(),
    getByLibraryAndKey: vi.fn(),
  },
  Collections: {
    get: vi.fn(),
    getByLibraryAndKey: vi.fn(),
  },
  ItemTypes: {
    getName: vi.fn().mockReturnValue("journalArticle"),
    getID: vi.fn().mockReturnValue(1),
  },
  ItemFields: {
    getItemTypeFields: vi.fn().mockReturnValue([]),
    getName: vi.fn().mockReturnValue("title"),
  },
  CreatorTypes: {
    getName: vi.fn().mockReturnValue("author"),
    getID: vi.fn().mockReturnValue(1),
  },
  DB: {
    queryAsync: vi.fn().mockResolvedValue([]),
    executeTransaction: vi.fn().mockImplementation(async (fn: any) => fn()),
  },
  version: "7.0.0",
  initializationPromise: Promise.resolve(),
  unlockPromise: Promise.resolve(),
  uiReadyPromise: Promise.resolve(),
  getMainWindow: vi.fn().mockReturnValue({ openDialog: vi.fn() }),
  PreferencePanes: {
    register: vi.fn(),
  },
};

(globalThis as any).Components = {
  classes: {},
  interfaces: {},
};

(globalThis as any).Services = {
  io: { newURI: vi.fn() },
  scriptloader: { loadSubScript: vi.fn() },
  prefs: {
    getDefaultBranch: vi.fn().mockReturnValue({
      setCharPref: vi.fn(),
      setBoolPref: vi.fn(),
      setIntPref: vi.fn(),
    }),
  },
};

(globalThis as any).IOUtils = {
  read: vi.fn().mockResolvedValue(new Uint8Array()),
};
