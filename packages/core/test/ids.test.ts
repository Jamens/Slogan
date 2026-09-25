import { describe, expect, it } from 'vitest';
import { isEntityId, timeFromUuid, uuidv7 } from '@dajia/core';

const V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv7', () => {
  it('符合 RFC 9562 v7 的格式、版本位与变体位', () => {
    for (let i = 0; i < 200; i++) {
      expect(uuidv7()).toMatch(V7_RE);
    }
  });

  it('时间戳前 48 位可还原', () => {
    const t = 1_760_000_000_123;
    expect(timeFromUuid(uuidv7(t))).toBe(t);
  });

  it('跨毫秒字典序递增', () => {
    const a = uuidv7(1_760_000_000_000);
    const b = uuidv7(1_760_000_000_001);
    expect(a < b).toBe(true);
  });

  it('同毫秒不保证有序（已知边界，排序靠命令序列）', () => {
    const same = Array.from({ length: 500 }, () => uuidv7(1_760_000_000_000));
    expect(new Set(same).size).toBeGreaterThan(1);
  });

  it('48 位以外的时间戳高位会被拒绝，不产生静默错序', () => {
    expect(() => uuidv7(2 ** 48)).toThrow(RangeError);
    expect(() => uuidv7(-1)).toThrow(RangeError);
    expect(() => uuidv7(1.5)).toThrow(RangeError);
  });
});

describe('isEntityId', () => {
  it('认 v7，不认 v4 与手搓字符串', () => {
    expect(isEntityId(uuidv7())).toBe(true);
    expect(isEntityId(crypto.randomUUID())).toBe(false);
    expect(isEntityId('wall-1')).toBe(false);
    expect(isEntityId(undefined)).toBe(false);
    expect(isEntityId(42)).toBe(false);
  });
});
