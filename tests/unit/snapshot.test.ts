import { expect, it } from "vitest";
import { activeLibraryItems } from "../../src/modules/core/snapshot";

it("excludes attachments and annotations belonging to a trashed or missing parent", () => {
  const regular = { key: "regular" };
  const note = { key: "note", parentKey: "regular" };
  const items = [regular, note, { key: "trash", deleted: true },
    { key: "pdf", parentKey: "trash" }, { key: "annotation", parentKey: "pdf" },
    { key: "orphan", parentKey: "missing" }];
  expect(activeLibraryItems(items)).toEqual([regular, note]);
  expect(items).toHaveLength(6); // Does not change or delete source library entries.
});
