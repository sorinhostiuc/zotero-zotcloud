import { describe, it, expect } from "vitest";
import { AttachmentSync } from "../../src/modules/core/attachment-sync";

/** Minimal in-memory CloudProvider stub for the delete/manifest paths. */
function makeProvider(manifestObj: any) {
  const provider: any = {
    deleted: [] as string[],
    savedManifest: null as any,
    async download(path: string) {
      if (path.endsWith("_manifest.json")) {
        return new TextEncoder().encode(JSON.stringify(manifestObj)).buffer;
      }
      throw new Error("not found: " + path);
    },
    async upload(path: string, data: any) {
      if (path.endsWith("_manifest.json")) {
        provider.savedManifest = JSON.parse(
          typeof data === "string" ? data : new TextDecoder().decode(data),
        );
      }
      return {};
    },
    async delete(path: string) { provider.deleted.push(path); },
    async exists() { return true; },
    async list() { return []; },
    getName() { return "fake"; },
  };
  return provider;
}

function entry(overrides: any) {
  return {
    originalName: "f.pdf", size: 1, uploadedBy: "d", uploadedAt: "",
    extension: ".pdf", cloudPath: "attachments/f.pdf", ...overrides,
  };
}

describe("attachment delete is owner-aware", () => {
  it("keeps the cloud file while another item still owns the same content", async () => {
    const provider = makeProvider({ files: { h1: entry({ itemKey: "A", itemKeys: ["A", "B"] }) } });
    const as = new AttachmentSync(provider, { deviceId: "d" } as any, "/ZotCloud");

    const deleted = await as.deleteAttachmentByItemKey("A");

    expect(deleted).toBe(0);
    expect(provider.deleted).toHaveLength(0);
    expect(provider.savedManifest.files.h1.itemKeys).toEqual(["B"]);
  });

  it("deletes the cloud file only when the last owner is removed", async () => {
    const provider = makeProvider({ files: { h1: entry({ itemKey: "B", itemKeys: ["B"] }) } });
    const as = new AttachmentSync(provider, { deviceId: "d" } as any, "/ZotCloud");

    const deleted = await as.deleteAttachmentByItemKey("B");

    expect(deleted).toBe(1);
    expect(provider.deleted).toEqual(["/ZotCloud/attachments/f.pdf"]);
    expect(provider.savedManifest.files.h1).toBeUndefined();
  });

  it("handles a legacy single-owner entry (itemKey only, no itemKeys)", async () => {
    const provider = makeProvider({ files: { h1: entry({ itemKey: "A" }) } });
    const as = new AttachmentSync(provider, { deviceId: "d" } as any, "/ZotCloud");

    const deleted = await as.deleteAttachmentByItemKey("A");

    expect(deleted).toBe(1);
    expect(provider.deleted).toEqual(["/ZotCloud/attachments/f.pdf"]);
  });
});

describe("attachment manifest is not wiped on transient load errors", () => {
  it("keeps an existing manifest when reload fails and the file still exists", async () => {
    const provider = makeProvider({ files: { h1: entry({ itemKey: "A", itemKeys: ["A"] }) } });
    const as = new AttachmentSync(provider, { deviceId: "d" } as any, "/ZotCloud");
    await as.loadManifest(); // first load succeeds

    // Now make download fail but the manifest still "exists" on the server.
    provider.download = async () => { throw new Error("503"); };
    provider.exists = async () => true;

    await as.loadManifest(); // must NOT reset to empty
    // Deleting a non-existent owner leaves the retained entry untouched.
    await as.deleteAttachmentByItemKey("does-not-exist");
    // The retained manifest still has h1 (would be gone if reset to {files:{}}).
    const deleted = await as.deleteAttachmentByItemKey("A");
    expect(deleted).toBe(1);
  });
});
