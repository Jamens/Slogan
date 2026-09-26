import { describe, expect, it } from 'vitest';
import { MM_PER_M, assertMm, mmToMeters, quantizeMm } from '@dajia/core';

describe('quantizeMm', () => {
  it('四舍五入到整数毫米', () => {
    expect(quantizeMm(3600.4)).toBe(3600);
    expect(quantizeMm(3600.6)).toBe(3601);
    expect(quantizeMm(-3600.6)).toBe(-3601);
  });

  it('幂等：量化两次与一次相同（spec 第 10 节不变式）', () => {
    for (const v of [0, 0.2, 3600.5, -120.49, 1e6 + 0.9]) {
      expect(quantizeMm(quantizeMm(v))).toBe(quantizeMm(v));
    }
  });

  it('非有限数直接抛，不返回 NaN', () => {
    expect(() => quantizeMm(Number.NaN)).toThrow(RangeError);
    expect(() => quantizeMm(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => quantizeMm(Number.NEGATIVE_INFINITY)).toThrow(RangeError);
  });

  it('真源不接受带符号的零：Math.round 的 -0 被归一为 +0', () => {
    // Math.round(-0.4) 是 -0，而 JSON.stringify(-0) 是 "0"：字节比对看不见它，
    // 只有内存里的 Object.is / vitest toEqual 会炸，所以断言必须用 Object.is。
    expect(Object.is(quantizeMm(-0.4), -0)).toBe(false);
    expect(Object.is(quantizeMm(-0.4), 0)).toBe(true);
    expect(Object.is(quantizeMm(-0), 0)).toBe(true);
    expect(Object.is(quantizeMm(0.4), 0)).toBe(true);
    expect(Object.is(quantizeMm(1e6 + 0.9), 1e6 + 1)).toBe(true);
  });
});

describe('assertMm', () => {
  it('接受整数毫米', () => {
    expect(assertMm(240, '墙厚')).toBe(240);
    expect(assertMm(0, '偏移')).toBe(0);
  });

  it('拒绝浮点：未量化的值写进真源必须炸', () => {
    expect(() => assertMm(240.5, '墙厚')).toThrow(TypeError);
    expect(() => assertMm(240.5, '墙厚')).toThrow(/墙厚/);
  });

  it('拒绝超出安全整数：超过后加减不再准确', () => {
    expect(() => assertMm(Number.MAX_SAFE_INTEGER + 2, '坐标')).toThrow(RangeError);
    expect(assertMm(Number.MAX_SAFE_INTEGER, '坐标')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('校验放行 -0（Number.isInteger(-0) 为真）但返回 +0', () => {
    expect(Object.is(assertMm(-0, '偏移'), -0)).toBe(false);
    expect(Object.is(assertMm(-0, '偏移'), 0)).toBe(true);
    expect(Object.is(assertMm(0, '偏移'), 0)).toBe(true);
    expect(Object.is(assertMm(-240, '墙厚'), -240)).toBe(true);
  });
});

describe('换算', () => {
  it('毫米到米是纯除法，不引入浮点误差累积', () => {
    expect(MM_PER_M).toBe(1000);
    expect(mmToMeters(3600)).toBe(3.6);
    expect(mmToMeters(1)).toBe(0.001);
    expect(mmToMeters(-240)).toBe(-0.24);
  });
});
