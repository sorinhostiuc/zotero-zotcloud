import { SyncConflict, ConflictResolution } from "../core/types";
import { log } from "../utils/logger";

/**
 * Conflict resolution dialog.
 * Shows side-by-side local vs remote values for conflicting fields,
 * following ZotCloud_Mockup_MainWindow.html conflict panel design.
 */
export function openConflictDialog(
  conflicts: SyncConflict[],
): Promise<Map<SyncConflict, ConflictResolution>> {
  return new Promise((resolve) => {
    if (conflicts.length === 0) {
      resolve(new Map());
      return;
    }

    const resolutions = new Map<SyncConflict, ConflictResolution>();
    let currentIndex = 0;

    const win = Zotero.getMainWindow();
    const dialog = win.openDialog(
      "chrome://zotcloud/content/conflict-dialog.xhtml",
      "zotcloud-conflict",
      "chrome,centerscreen,resizable,width=500,height=400",
      { Zotero, conflicts },
    );

    dialog.addEventListener("load", () => {
      const doc = dialog.document;
      const root = doc.getElementById("zotcloud-conflict-root");
      if (!root) return;

      function renderConflict(index: number) {
        const conflict = conflicts[index];
        root!.innerHTML = "";

        // Header
        const header = doc.createElement("div");
        header.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:12px;";
        header.innerHTML = `
          <span style="font-weight:500;font-size:14px;">Conflict ${index + 1} of ${conflicts.length}</span>
        `;
        root!.appendChild(header);

        // Conflict details
        const box = doc.createElement("div");
        box.style.cssText = "background:#faeeda;border-radius:6px;padding:10px 12px;margin-bottom:12px;";
        box.innerHTML = `
          <div style="font-size:11px;color:#854f0b;font-weight:500;margin-bottom:6px;">
            ${conflict.entityType}: ${conflict.entityKey}
          </div>
          <div style="font-size:12px;font-weight:500;margin-bottom:8px;">Field: ${conflict.fieldName}</div>
          <div style="font-size:11px;margin-bottom:4px;">
            <span style="color:#6b6b6b;">Local (${conflict.localDeviceId.slice(0, 8)}):</span>
            <span style="font-weight:500;">${String(conflict.localValue)}</span>
          </div>
          <div style="font-size:11px;">
            <span style="color:#6b6b6b;">Remote (${conflict.remoteDeviceId.slice(0, 8)}):</span>
            <span style="font-weight:500;">${String(conflict.remoteValue)}</span>
          </div>
        `;
        root!.appendChild(box);

        // Action buttons
        const actions = doc.createElement("div");
        actions.style.cssText = "display:flex;gap:8px;margin-bottom:16px;";

        const keepLocal = createButton(doc, "Keep local", true);
        keepLocal.addEventListener("click", () => {
          resolutions.set(conflict, "keep-local");
          next();
        });

        const keepRemote = createButton(doc, "Keep remote", false);
        keepRemote.addEventListener("click", () => {
          resolutions.set(conflict, "keep-remote");
          next();
        });

        const keepBoth = createButton(doc, "Keep both", false);
        keepBoth.addEventListener("click", () => {
          resolutions.set(conflict, "keep-both");
          next();
        });

        actions.appendChild(keepLocal);
        actions.appendChild(keepRemote);
        actions.appendChild(keepBoth);
        root!.appendChild(actions);

        // Skip / Resolve All
        const footer = doc.createElement("div");
        footer.style.cssText = "display:flex;gap:8px;border-top:1px solid #e0e0d8;padding-top:12px;";

        const skipBtn = createButton(doc, "Skip", false);
        skipBtn.addEventListener("click", () => next());

        const resolveAll = createButton(doc, "Keep all local", false);
        resolveAll.addEventListener("click", () => {
          for (let i = currentIndex; i < conflicts.length; i++) {
            resolutions.set(conflicts[i], "keep-local");
          }
          dialog.close();
          resolve(resolutions);
        });

        footer.appendChild(skipBtn);
        footer.appendChild(resolveAll);
        root!.appendChild(footer);
      }

      function next() {
        currentIndex++;
        if (currentIndex >= conflicts.length) {
          dialog.close();
          resolve(resolutions);
        } else {
          renderConflict(currentIndex);
        }
      }

      renderConflict(0);
    });

    dialog.addEventListener("unload", () => {
      resolve(resolutions);
    });
  });
}

function createButton(
  doc: Document,
  text: string,
  primary: boolean,
): HTMLButtonElement {
  const btn = doc.createElement("button") as HTMLButtonElement;
  btn.textContent = text;
  btn.style.cssText = primary
    ? "flex:1;font-size:11px;padding:5px 8px;border:1px solid #378add;border-radius:4px;background:#e6f1fb;color:#185fa5;cursor:pointer;"
    : "flex:1;font-size:11px;padding:5px 8px;border:1px solid #c0c0b8;border-radius:4px;background:transparent;cursor:pointer;";
  return btn;
}
