const PREFIX = "[ZotCloud]";

export function log(message: string, ...args: any[]) {
  Zotero.log(`${PREFIX} ${message}`, "warning");
  if (args.length > 0) {
    Zotero.log(`${PREFIX} ${JSON.stringify(args)}`, "warning");
  }
}

export function logError(message: string, error?: unknown) {
  Zotero.log(`${PREFIX} ERROR: ${message}`, "error");
  if (error instanceof Error) {
    Zotero.log(`${PREFIX} ${error.stack || error.message}`, "error");
  }
}
