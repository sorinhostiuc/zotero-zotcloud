import Addon from "./addon";
import * as hooks from "./hooks";

if (!Zotero.ZotCloud) {
  const addon = new Addon();
  Zotero.ZotCloud = addon;
  (Zotero.ZotCloud as any).hooks = hooks;
}
