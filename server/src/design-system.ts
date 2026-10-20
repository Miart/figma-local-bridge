/**
 * The server-side half of design-system sync: compare two inventories, not two
 * names. A style can keep its name while its colour changes, and a component
 * can keep its name while its variants change; both must show up as a change.
 *
 * Identity is the Figma stable `key` when present. A node that was recreated
 * may have a new id, but the key is what the file meant. Value comparison drops
 * `id` so a save/reload does not report every item as changed.
 */

export type Section = "styles" | "variables" | "components";
export const SECTIONS: Section[] = ["styles", "variables", "components"];

export interface Inventory {
  schema?: string;
  file?: { name?: string | null; key?: string | null };
  styles?: any[];
  variables?: any[];
  components?: any[];
  [key: string]: any;
}

export interface DiffResult {
  schema: "design-system-diff-v1";
  counts: { added: number; removed: number; changed: number; unchanged: number };
  sections: Record<Section, { added: any[]; removed: any[]; changed: any[] }>;
  truncated: boolean;
  warnings: string[];
}

function stable(v: any): any {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) {
      if (v[k] === undefined) continue;
      out[k] = stable(v[k]);
    }
    return out;
  }
  return v;
}

export function identity(section: Section, item: any, duplicates = new Map<string, number>()): string {
  const base = item && (item.key || item.id || `${item.type || section}:${item.name || "?"}`);
  let key = `${section}:${String(base)}`;
  const seen = duplicates.get(key) || 0;
  duplicates.set(key, seen + 1);
  return seen ? `${key}#${seen + 1}` : key;
}

export function snapshotKey(item: any): string {
  // Only the item's own identity is volatile; a nested VARIABLE_ALIAS.id is a
  // value, not a node id, and dropping it would hide a repointed variable.
  const { id: _id, exportedAt: _exportedAt, ...rest } = item || {};
  return JSON.stringify(stable(rest));
}

export function diffInventory(
  previous: Inventory,
  current: Inventory,
  maxDiff = 200,
): DiffResult {
  const sections = {
    styles: { added: [] as any[], removed: [] as any[], changed: [] as any[] },
    variables: { added: [] as any[], removed: [] as any[], changed: [] as any[] },
    components: { added: [] as any[], removed: [] as any[], changed: [] as any[] },
  };
  const counts = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  let truncated = false;
  const warnings: string[] = [];
  const push = (bucket: any[], value: any) => {
    if (bucket.length < maxDiff) bucket.push(value);
    else truncated = true;
  };

  for (const section of SECTIONS) {
    const before = Array.isArray(previous[section]) ? previous[section] : [];
    const after = Array.isArray(current[section]) ? current[section] : [];
    const beforeMap = new Map<string, any>();
    const afterMap = new Map<string, any>();
    const d1 = new Map<string, number>();
    const d2 = new Map<string, number>();
    for (const item of before) beforeMap.set(identity(section, item, d1), item);
    for (const item of after) afterMap.set(identity(section, item, d2), item);
    for (const [key, item] of afterMap) {
      if (!beforeMap.has(key)) {
        counts.added++;
        push(sections[section].added, { key, name: item.name, type: item.type, item });
        continue;
      }
      const old = beforeMap.get(key);
      if (snapshotKey(old) === snapshotKey(item)) {
        counts.unchanged++;
        continue;
      }
      counts.changed++;
      push(sections[section].changed, { key, name: item.name, type: item.type, before: stable(old), after: stable(item) });
    }
    for (const [key, item] of beforeMap) {
      if (!afterMap.has(key)) {
        counts.removed++;
        push(sections[section].removed, { key, name: item.name, type: item.type, item });
      }
    }
  }

  if (truncated) warnings.push(`more than ${maxDiff} entries per section were found; the diff lists the first ${maxDiff} of each kind`);
  return { schema: "design-system-diff-v1", counts, sections, truncated, warnings };
}
