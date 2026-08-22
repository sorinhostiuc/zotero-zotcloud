import { ZoteroToolkit } from "zotero-plugin-toolkit";

let _ztoolkit: ZoteroToolkit | null = null;

export function createZToolkit() {
  _ztoolkit = new ZoteroToolkit();
  return _ztoolkit;
}

/** Lazy-initialized toolkit — must be accessed after Zotero is ready */
export const ztoolkit: ZoteroToolkit = new Proxy({} as ZoteroToolkit, {
  get(_target, prop, receiver) {
    if (!_ztoolkit) {
      _ztoolkit = new ZoteroToolkit();
    }
    return Reflect.get(_ztoolkit, prop, receiver);
  },
});
