import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Document, uuidv7, type EntityId } from '@dajia/core';
import {
  EMERGENCY_DIR_NAME,
  EMERGENCY_KEEP,
  emergencyFileName,
  pruneEmergency,
  writeEmergencySnapshot,
} from '../../src/main/persist/emergency';

const PID_A = uuidv7() as EntityId;
const PID_B = uuidv7() as EntityId;

// 三个 describe 共用两个临时目录（`dir` 反复写、`dirB` 只给覆盖那一格），
// 目录由本文件 mkdtempSync 造 ⇒ afterAll 敢整棵删；绝不用仓库里的路径。
let dir = '';
let dirB = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dajia-emergency-'));
  dirB = mkdtempSync(join(tmpdir(), 'dajia-emergency-b-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

describe('文件名的两条尺', () => {
  it('正形状是 `${projectId}-turn-${turn}.json`；两个守卫各挡一刀', () => {
    expect(emergencyFileName(PID_A, 7)).toBe(`${PID_A}-turn-7.json`);
    // 词干直接进路径：放 `../` 过去等于让调用方指定写到哪一层。
    expect(() => emergencyFileName('../evil' as EntityId, 1)).toThrow(/UUIDv7/);
    expect(() => emergencyFileName(PID_A, 0)).toThrow(/安全整数/);
    expect(() => emergencyFileName(PID_A, 1.5)).toThrow(/安全整数/);
    expect(() => emergencyFileName(PID_A, Number.MAX_SAFE_INTEGER + 1)).toThrow(/安全整数/);
  });
});

describe('写一份抢救件', () => {
  it('ok:true 且 envelope 七个键逐个对得上，canonical 是字符串且与 doc.canonical() 逐字节相同', () => {
    const doc = Document.create(PID_A);
    const write = writeEmergencySnapshot(dir, { projectId: PID_A, turn: 3, error: '连接被掐断', doc });
    expect(write.ok).toBe(true);
    if (!write.ok) throw new TypeError('夹具塌了：上一句已经保证 ok');
    expect(write.path).toBe(join(dir, EMERGENCY_DIR_NAME, `${PID_A}-turn-3.json`));
    const env = JSON.parse(readFileSync(write.path, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(env).sort()).toEqual(
      ['canonical', 'error', 'kind', 'projectId', 'schemaVersion', 'turn', 'writtenAtMs'].sort(),
    );
    expect(env.kind).toBe('dajia.emergency.v1');
    expect(env.projectId).toBe(PID_A);
    expect(env.turn).toBe(3);
    // schemaVersion 的产地是文档本身，不是本文件里的常量：写侧不许自己发明版本号。
    expect(env.schemaVersion).toBe(doc.schemaVersion);
    expect(env.error).toBe('连接被掐断');
    // 存字符串而不是存对象：展开成对象就得在 fs 侧再写一份解码，而 core 已经有一份
    // canonical 规则 —— 一份规则两个读者才是不漂的写法（T3/T5 同一条口径）。
    expect(typeof env.canonical).toBe('string');
    expect(env.canonical).toBe(doc.canonical());
    expect(typeof env.writtenAtMs).toBe('number');
    expect(env.writtenAtMs).toBeGreaterThan(0);
  });

  it('同一 turn 再写一份是覆盖，不是第二份（目录里始终一个文件）', () => {
    const first = writeEmergencySnapshot(dirB, {
      projectId: PID_A,
      turn: 9,
      error: '第一次的错',
      doc: Document.create(PID_A),
    });
    const second = writeEmergencySnapshot(dirB, {
      projectId: PID_A,
      turn: 9,
      error: '第二次的错',
      doc: Document.create(PID_A),
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new TypeError('夹具塌了');
    expect(readdirSync(join(dirB, EMERGENCY_DIR_NAME))).toEqual([`${PID_A}-turn-9.json`]);
    const env = JSON.parse(readFileSync(second.path, 'utf8')) as { error: string };
    expect(env.error).toBe('第二次的错');
  });

  it('文档与工程对不上、id 非法、userDataDir 底下不是目录 ⇒ 一律 ok:false，一个都不抛', () => {
    // ① 文档签在别的工程上
    const mismatch = writeEmergencySnapshot(dir, {
      projectId: PID_A,
      turn: 4,
      error: 'x',
      doc: Document.create(PID_B),
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error).toMatch(/工程/);
    // ② 非法 id：守卫在算路径之前，所以这里连 path 都给不出
    const bad = writeEmergencySnapshot(dir, {
      projectId: '../../etc/passwd' as EntityId,
      turn: 4,
      error: 'x',
      doc: Document.create(PID_A),
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.path).toBeNull();
      expect(bad.error).toMatch(/UUIDv7/);
    }
    // ③ userDataDir 指向一个普通文件 ⇒ 底下建不出目录
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, '我不是目录\n', 'utf8');
    const blocked = writeEmergencySnapshot(blocker, {
      projectId: PID_A,
      turn: 5,
      error: 'x',
      doc: Document.create(PID_A),
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error.length).toBeGreaterThan(0);
      // path 已经算出来了（守卫已过、失败在 mkdir），这一格把它留着给 T9 的诊断用。
      expect(blocked.path).toBe(join(blocker, EMERGENCY_DIR_NAME, `${PID_A}-turn-5.json`));
    }
    // 三条落点各不同（RangeError / guardName / mkdirSync），分开写是因为它们红法不同：
    // 前两条红在"抛出了 ok:false 之外的东西"，第三条红在"路径算错了一位"。
  });
  // 实测回填待办：第 ③ 条在本机 `err.code` 的具体值（ENOTDIR / EPERM / EACCES 之一）跑完抄进执行回填。
  // 判据**不加** `/ENOTDIR/` —— 三条或的判据等于没有判据，而这一格盯的是"返回而不抛"。
});

describe('裁剪（按工程分桶，认不出的不动）', () => {
  it('keep=2 时每个工程各留两份最新的，别人的文件一个都不许少', () => {
    const mixed = mkdtempSync(join(tmpdir(), 'dajia-emergency-mixed-'));
    const target = join(mixed, EMERGENCY_DIR_NAME);
    mkdirSync(target, { recursive: true });
    for (const turn of [1, 2, 3, 4, 5]) {
      const w = writeEmergencySnapshot(mixed, {
        projectId: PID_A,
        turn,
        error: `A 的第 ${turn} 发`,
        doc: Document.create(PID_A),
      });
      expect(w.ok).toBe(true);
    }
    for (const turn of [1, 2, 3]) {
      const w = writeEmergencySnapshot(mixed, {
        projectId: PID_B,
        turn,
        error: `B 的第 ${turn} 发`,
        doc: Document.create(PID_B),
      });
      expect(w.ok).toBe(true);
    }
    // 两样野文件：一个连形状都不像，一个像但词干不是 UUIDv7。
    writeFileSync(join(target, 'notes.txt'), '谁扔的\n', 'utf8');
    writeFileSync(join(target, 'bogus-turn-9999.json'), '{}\n', 'utf8');

    const removed = pruneEmergency(mixed, 2);
    expect(removed.sort()).toEqual(
      [
        `${PID_A}-turn-1.json`,
        `${PID_A}-turn-2.json`,
        `${PID_A}-turn-3.json`,
        `${PID_B}-turn-1.json`,
      ].sort(),
    );
    expect(readdirSync(target).sort()).toEqual(
      [
        'notes.txt',
        'bogus-turn-9999.json',
        `${PID_A}-turn-4.json`,
        `${PID_A}-turn-5.json`,
        `${PID_B}-turn-2.json`,
        `${PID_B}-turn-3.json`,
      ].sort(),
    );
    // T7 ⑩ 段的分桶主张：A 有 5 份、B 有 3 份，keep=2 ⇒ B 只少 1 份，
    // 而那一份不是被 A 的大 turn 挤下来的（全局排序会删掉 B 的两份并留下 A 的两份 + B 的一份）。
    rmSync(mixed, { recursive: true, force: true });
  });

  it('keep 必须是 >=1 的安全整数：0 就是关掉抢救，该由调用方不装钩子来表述', () => {
    expect(() => pruneEmergency(dir, 0)).toThrow(/keep/);
    expect(() => pruneEmergency(dir, -1)).toThrow(/keep/);
    expect(() => pruneEmergency(dir, 1.5)).toThrow(/keep/);
    expect(() => pruneEmergency(dir, Number.NaN)).toThrow(/keep/);
    // 默认值本身要过得了这一尺：EMERGENCY_KEEP 写成 0 就是"抢救完再删光"，比不抢救更坏。
    expect(EMERGENCY_KEEP).toBeGreaterThanOrEqual(1);
    expect(Number.isSafeInteger(EMERGENCY_KEEP)).toBe(true);
  });
});
