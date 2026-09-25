import { describe, expect, it } from 'vitest';
import { IPC, isIpcChannel } from '@dajia/protocol';

describe('IPC 通道表', () => {
  it('通道名一律带 dajia: 前缀，不与三方库撞名', () => {
    for (const channel of Object.values(IPC)) {
      expect(channel.startsWith('dajia:')).toBe(true);
    }
  });

  it('无重复通道名', () => {
    const values = Object.values(IPC);
    expect(new Set(values).size).toBe(values.length);
  });

  it('isIpcChannel 只认表内通道', () => {
    expect(isIpcChannel(IPC.ping)).toBe(true);
    expect(isIpcChannel('dajia:nope')).toBe(false);
    expect(isIpcChannel(undefined)).toBe(false);
  });
});
