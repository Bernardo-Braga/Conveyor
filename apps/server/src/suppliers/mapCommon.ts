/**
 * Defensive access helpers for the DataHub payloads. There is no published schema, so the
 * mappers read several candidate paths and the fixture tests pin what a real response holds.
 */
export type Json = Record<string, unknown>;

export function obj(v: unknown): Json | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}
export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
export function str(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}
export function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v.replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
export function int(v: unknown): number | null {
  const n = num(v);
  return n == null ? null : Math.trunc(n);
}
/** "12.34" or 12.34 → 1234 minor units. */
export function minor(v: unknown): number | null {
  const n = num(v);
  return n == null ? null : Math.round(n * 100);
}
/** First non-null value among paths like "sku.def.promotionPrice". */
export function pick(root: unknown, ...paths: string[]): unknown {
  for (const p of paths) {
    let cur: unknown = root;
    for (const key of p.split('.')) {
      const o = obj(cur);
      if (!o) {
        cur = undefined;
        break;
      }
      cur = o[key];
    }
    if (cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return undefined;
}
/** "-" in a price range: "1.20-3.40" → 1.20 (single-unit or lowest). */
export function lowestPrice(v: unknown): number | null {
  const s = str(v);
  if (!s) return num(v);
  const parts = s.split(/\s*[-~–]\s*/).map((x) => num(x)).filter((x): x is number => x != null);
  return parts.length ? Math.min(...parts) : null;
}

export interface RawProp {
  pid: string;
  name: string;
  values: { vid: string; label: string; image?: string }[];
}

/** DataHub's `sku.props` list, shared by both platforms. */
export function readProps(props: unknown): RawProp[] {
  return arr(props)
    .map((p) => {
      const o = obj(p);
      if (!o) return null;
      const name = str(o.name) ?? str(o.propName) ?? '';
      const values = arr(o.values).map((v) => {
        const vo = obj(v) ?? {};
        const image = str(vo.image) ?? str(vo.imageUrl) ?? str(vo.img) ?? undefined;
        return { vid: str(vo.vid) ?? str(vo.id) ?? '', label: str(vo.name) ?? str(vo.value) ?? '', ...(image ? { image } : {}) };
      });
      return { pid: str(o.pid) ?? str(o.id) ?? '', name, values };
    })
    .filter((p): p is RawProp => !!p && !!p.name);
}

/** "14:29#Red;5:100014064" or "14:29;5:100014064" → [["14","29"],["5","100014064"]] */
export function parseSkuAttr(attr: unknown): [string, string][] {
  const s = str(attr);
  if (!s) return [];
  return s
    .split(';')
    .map((pair) => pair.split('#')[0]!.split(':'))
    .filter((kv) => kv.length === 2)
    .map((kv) => [kv[0]!.trim(), kv[1]!.trim()]);
}

/** Resolve a variant's option labels in option order from its pid:vid pairs. */
export function optionValuesFor(props: RawProp[], attr: unknown, fallbackLabels?: unknown): string[] {
  const pairs = new Map(parseSkuAttr(attr));
  const labels = props.map((p) => p.values.find((v) => v.vid === pairs.get(p.pid))?.label ?? '');
  if (labels.some((l) => l)) return labels;
  const fb = str(fallbackLabels);
  return fb ? fb.split(/\s*[;,]\s*/) : [];
}

/** `properties.list: [{ name, value }]` (AliExpress) or `[{ attrName, attrValue }]` (1688). */
export function readAttributes(list: unknown): { name: string; value: string }[] {
  return arr(list)
    .map((p) => {
      const o = obj(p);
      if (!o) return null;
      const name = str(o.name) ?? str(o.attrName) ?? str(o.key);
      const value = str(o.value) ?? str(o.attrValue) ?? str(o.values);
      return name && value ? { name, value } : null;
    })
    .filter((a): a is { name: string; value: string } => !!a)
    .slice(0, 60);
}
