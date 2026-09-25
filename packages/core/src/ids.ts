export type EntityId = string;

const HEX = '0123456789abcdef';
const MAX_TS_48 = 2 ** 48;

/**
 * 48 位大端毫秒时间戳 + 12 位 rand_a + 62 位 rand_b。
 * 同毫秒内不保证单调：创建顺序由命令序列表达，不靠 ID。
 */
export function uuidv7(now: number = Date.now()): EntityId {
  if (!Number.isInteger(now) || now < 0 || now >= MAX_TS_48) {
    throw new RangeError(`uuidv7 需要 [0, 2^48) 内的整数毫秒，收到 ${now}`);
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 6; i++) {
    bytes[i] = Math.floor(now / 2 ** (40 - 8 * i)) & 0xff;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f];
    if (i === 3 || i === 5 || i === 7 || i === 9) out += '-';
  }
  return out;
}

/** 取回前 48 位毫秒时间戳。不做输入校验，调用方先过 isEntityId。 */
export function timeFromUuid(id: EntityId): number {
  const hex = id.replace(/-/g, '').slice(0, 12);
  return Number.parseInt(hex, 16);
}

const V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isEntityId(value: unknown): value is EntityId {
  return typeof value === 'string' && V7_RE.test(value);
}
