import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isEntityId, type EntityId } from '@dajia/core';
import {
  LOCK_HEARTBEAT_INTERVAL_MS,
  LOCK_TTL_MS,
  newLockTicket,
  ttlToMicroseconds,
} from '../../src/main/db/locks';

const PROJECT_ID = '0193aa00-0000-7000-8000-00000000000a' as EntityId;

/** 恰好 200 个字符（MySQL 的 VARCHAR(200) 数的是**字符**不是字节，见 Step 1 的 F 档）。 */
const OWNER_MAX = 'a'.repeat(200);

describe('锁票：形状与那两条尺', () => {
  it('token 由 uuidv7 现调：过 isEntityId，两张票不一样', () => {
    const a = newLockTicket({ projectId: PROJECT_ID, owner: '机器A:1001' });
    const b = newLockTicket({ projectId: PROJECT_ID, owner: '机器A:1001' });
    expect(isEntityId(a.token)).toBe(true);
    expect(a.token).not.toBe(b.token);
    // owner 相同也必须是两张票：锁的身份靠 token，不靠"谁报的名"。
    expect(a.owner).toBe(b.owner);
  });

  it('projectId 形状不对 ⇒ 抛，不发给 MySQL', () => {
    expect(() => newLockTicket({ projectId: 'nope' as EntityId, owner: 'A' })).toThrow(/projectId/);
  });

  it('owner 空串 / 纯空白 / 带首尾空白 ⇒ 抛', () => {
    for (const owner of ['', '   ', ' 机器A ', '机器A ']) {
      expect(() => newLockTicket({ projectId: PROJECT_ID, owner })).toThrow(/owner/);
    }
  });

  it('owner 201 个字符 ⇒ 抛，且文案带着那把尺（200）', () => {
    expect(() => newLockTicket({ projectId: PROJECT_ID, owner: 'a'.repeat(201) })).toThrow(/200/);
  });

  it('owner 恰好 200 个字符（含中文）⇒ 放行：尺是 <=200，不是 <200', () => {
    expect(newLockTicket({ projectId: PROJECT_ID, owner: OWNER_MAX }).owner).toBe(OWNER_MAX);
    expect(newLockTicket({ projectId: PROJECT_ID, owner: '搭家-机器-A-'.repeat(14) }).owner.length).toBeLessThanOrEqual(200);
  });

  it('TTL 与心跳间隔那对常量：漏两次心跳才丢锁', () => {
    // 这一格钉的是口径而不是数字本身：TTL 至少容得下三次心跳的抖动。
    // 把 LOCK_TTL_MS 改成 6000（小于 3 × 间隔）⇒ 这里红，比线上一到抖动就丢锁好查。
    expect(LOCK_TTL_MS).toBeGreaterThanOrEqual(3 * LOCK_HEARTBEAT_INTERVAL_MS);
    expect(LOCK_TTL_MS).toBeGreaterThan(0);
    expect(LOCK_HEARTBEAT_INTERVAL_MS).toBeGreaterThan(0);
  });

  it('ttlToMicroseconds：0 合法、15000 换算对、越界四型抛', () => {
    expect(ttlToMicroseconds(0)).toBe(0);
    expect(ttlToMicroseconds(15000)).toBe(15000000);
    for (const bad of [-1, 1.5, Number.NaN, 3_600_001, Number.POSITIVE_INFINITY]) {
      expect(() => ttlToMicroseconds(bad)).toThrow(/ttlMs/);
    }
  });

  it('locks.ts 里不许出现客户机时钟（P-4 唯一的常驻证人）', () => {
    const src = readFileSync(new URL('../../src/main/db/locks.ts', import.meta.url), 'utf8');
    for (const forbidden of ['Date.now(', 'new Date(', 'performance.now(']) {
      expect(src, forbidden).not.toContain(forbidden);
    }
    // 所有时间判定都挂在服务端 NOW(3) 上；少一处就说明有一处改成了客户机算的。
    expect((src.match(/NOW\(3\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('三发 CAS 都按 id 收口：全文件不许出现不带 `id` 约束的 UPDATE', () => {
    const src = readFileSync(new URL('../../src/main/db/locks.ts', import.meta.url), 'utf8');
    const updates = src.match(/UPDATE `project`/g) ?? [];
    expect(updates.length).toBe(3);
    // 每一条 UPDATE 后面（到下一条语句之前）都必须出现 `id` = ?，否则就是全库一把锁（T6-M14）。
    const withoutId = src
      .split(/(?=UPDATE `project`)/)
      .filter((chunk) => chunk.startsWith('UPDATE `project`'))
      .filter((chunk) => !chunk.includes('`id` = ?'));
    expect(withoutId).toEqual([]);
  });
});
