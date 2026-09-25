function normalize(value: unknown): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) throw new TypeError(`无法序列化非有限数：${n}`);
    return n;
  }
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'undefined') return undefined;
  if (t === 'bigint') throw new TypeError('不支持 bigint：真源长度一律整数毫米 number');
  if (value instanceof Map) {
    throw new TypeError('stableStringify 不支持 Map，请先转成有序数组以保证序确定');
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (t === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      const v = normalize(src[key]);
      if (v !== undefined) out[key] = v;
    }
    return out;
  }
  throw new TypeError(`stableStringify 不支持的类型：${t}`);
}

/** 键递归排序 + 数组保序。canonical() 的地基，别改它的行为。 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}
