import { ChangeEvent } from "./types";

/** Apply collections and parents before the items that refer to them. */
export function orderDependencies(events: ChangeEvent[]): ChangeEvent[] {
  const byKey = new Map(events.map(e => [`${e.entityType}:${e.entityKey}`, e]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: ChangeEvent[] = [];
  const visit = (event: ChangeEvent) => {
    const key = `${event.entityType}:${event.entityKey}`;
    if (visited.has(key)) return;
    if (visiting.has(key)) throw new Error(`Cyclic sync dependency: ${key}`);
    visiting.add(key);
    const dependency = (type: string, parent: unknown) => {
      if (typeof parent !== "string" || !parent) return;
      const found = byKey.get(`${type}:${parent}`);
      if (found) visit(found);
    };
    if (event.entityType === "collection") {
      dependency("collection", event.data.fields?.parentKey);
    } else {
      dependency("item", event.data.parentKey);
      for (const collection of event.data.collections || []) dependency("collection", collection);
    }
    visiting.delete(key);
    visited.add(key);
    ordered.push(event);
  };
  const latest = Array.from(byKey.values());
  for (const event of latest.filter(e => e.entityType === "collection")) visit(event);
  for (const event of latest) visit(event);
  return ordered;
}
