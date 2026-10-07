import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IPC } from '../src/ipc';
import {
  FailureReplySchema,
  INVOKE_CHANNELS,
  OpenRequestSchema,
  OpenValueSchema,
  PERSIST_ERROR_CODES,
  SAVE_STATUS_EVENT,
  SaveStatusSchema,
  SubmitRequestSchema,
  CloseRequestSchema,
  parseOpenRequest,
  parseOpenValue,
  type SaveStatusWire,
} from '../src/persist-schema';

const ID = '01932f6a-7c1e-7000-8000-000000000001';
const HERE = fileURLToPath(new URL('.', import.meta.url));
const SCHEMA_SRC = readFileSync(`${HERE}../src/persist-schema.ts`, 'utf8');
const AUTOSAVE_SRC = readFileSync(`${HERE}../../../apps/desktop/src/main/persist/autosave.ts`, 'utf8');

/** 一份**完整合法**的 `OpenValue`，多个用例在它身上只改一处。 */
function openValue(): Record<string, unknown> {
  return {
    decision: 'edit',
    header: { projectId: ID, name: '样例房', schemaVersion: 1, journalTurn: 7, wasCleanShutdown: true },
    doc: { projectId: ID, schemaVersion: 1, entities: [] },
    snapshot: { seq: 12, turn: 5 },
    replayed: { rows: 2, fromSeq: 11, toSeq: 12 },
    emergency: [],
  };
}

describe('persist-schema：请求方向一律 strictObject', () => {
  it('打开工程的请求只认 projectId 一个键：缺、多、非 UUIDv7 三型都拒', () => {
    expect(OpenRequestSchema.safeParse({ projectId: ID }).success).toBe(true);
    expect(OpenRequestSchema.safeParse({}).success).toBe(false);
    // 多一个 `name` 就红：这是"谁都能顺手往请求里塞一格"的常驻证人。
    expect(OpenRequestSchema.safeParse({ projectId: ID, name: 'x' }).success).toBe(false);
    expect(OpenRequestSchema.safeParse({ projectId: 1 }).success).toBe(false);
    expect(OpenRequestSchema.safeParse({ projectId: '00000000-0000-4000-8000-000000000000' })
      .success).toBe(false);
  });

  it('带 password 键的请求一律拒（口令不进 IPC 的那道牙，第 ④ 段）', () => {
    const doc = { projectId: ID, schemaVersion: 1, entities: [] };
    const cases = [
      OpenRequestSchema.safeParse({ projectId: ID, password: 'hunter2' }),
      SubmitRequestSchema.safeParse({
        projectId: ID, patch: { upsert: [], remove: [] }, doc, password: 'hunter2',
      }),
      CloseRequestSchema.safeParse({ projectId: ID, doc, mode: 'graceful', password: 'hunter2' }),
    ];
    // 三条都补齐了必填项 ⇒ 拒的只能是多出来的那一格，不是缺必填。
    for (const r of cases) expect(r.success).toBe(false);
  });

  it('收尾请求的 mode 只认两值；缺 mode 与第三种拼法都拒', () => {
    const doc = { projectId: ID, schemaVersion: 1, entities: [] };
    expect(CloseRequestSchema.safeParse({ projectId: ID, doc, mode: 'graceful' }).success).toBe(true);
    expect(CloseRequestSchema.safeParse({ projectId: ID, doc, mode: 'abandon' }).success).toBe(true);
    expect(CloseRequestSchema.safeParse({ projectId: ID, doc, mode: 'force' }).success).toBe(false);
    expect(CloseRequestSchema.safeParse({ projectId: ID, doc }).success).toBe(false);
  });
});

describe('persist-schema：回包值与错误码', () => {
  it('SaveStatus 的键集合与 phase 取值 == autosave.ts 里那一份（源码对账）', () => {
    const KEYS = [
      'phase', 'queuedTurns', 'lastTurn', 'snapshotTurn', 'rowsSinceSnapshot',
      'lastError', 'pauseReason',
    ] as const;
    const block = /interface SaveStatus \{([\s\S]*?)\n\}/.exec(AUTOSAVE_SRC);
    if (!block) throw new Error('没在 autosave.ts 里找到 interface SaveStatus —— 它被改名或搬走了');
    const found = [...block[1]!.matchAll(/readonly (\w+):/g)].map((m) => m[1]!);
    expect(found.sort()).toEqual([...KEYS].sort());

    const phases = /type AutosavePhase = ([^;]+);/.exec(AUTOSAVE_SRC);
    if (!phases) throw new Error('没在 autosave.ts 里找到 type AutosavePhase');
    expect([...phases[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort())
      .toEqual(['failed', 'idle', 'paused', 'saving', 'stopped']);

    const full: SaveStatusWire = {
      phase: 'idle', queuedTurns: 0, lastTurn: null, snapshotTurn: null,
      rowsSinceSnapshot: 0, lastError: null, pauseReason: null,
    };
    expect(SaveStatusSchema.safeParse(full).success).toBe(true);
    // 多一格 ⇒ 拒（否则"autosave 加了字段、UI 永远看不见"静默通过）；
    // 少任意一格 ⇒ 也拒（否则 T7 新加的格子在过界那一刻被悄悄丢掉）。
    expect(SaveStatusSchema.safeParse({ ...full, extra: 1 }).success).toBe(false);
    for (const key of KEYS) {
      const missing = { ...full } as Record<string, unknown>;
      delete missing[key];
      expect(SaveStatusSchema.safeParse(missing).success).toBe(false);
    }
  });

  it('seq / queuedTurns 不接受负数、小数、字符串、超安全整数（BIGINT 回到 string 时在过界那一发就红，P-17 的下游）', () => {
    const base: SaveStatusWire = {
      phase: 'idle', queuedTurns: 0, lastTurn: null, snapshotTurn: null,
      rowsSinceSnapshot: 0, lastError: null, pauseReason: null,
    };
    for (const bad of [-1, 1.5, '12', null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(SaveStatusSchema.safeParse({ ...base, queuedTurns: bad }).success).toBe(false);
      const v = openValue();
      v.snapshot = bad === null ? null : { seq: bad, turn: 5 };
      expect(OpenValueSchema.safeParse(v).success).toBe(bad === null);
    }
  });

  it('doc 载荷里的浮点毫米在过界那一发就红，且文案给到点号路径（整数毫米纪律的第二道）', () => {
    const v = openValue();
    v.doc = {
      projectId: ID,
      schemaVersion: 1,
      entities: [{
        kind: 'wall', id: ID, projectId: ID, storeyId: ID,
        startPointId: ID, endPointId: ID,
        thicknessMm: 240.5, heightMm: 3000, elevationOffsetMm: 0,
        loadBearing: true, material: '砖',
      }],
    };
    expect(OpenValueSchema.safeParse(v).success).toBe(false);
    // 这一格同时钉住第 ③ 段那条口径：**不许拿 union 当回包判据**，否则路径塌成 `(根)`，
    // 谁也不知道是哪一格的毫米漂了。
    expect(() => parseOpenValue(IPC.projectOpen, v)).toThrow(/doc\.entities\.0\.thicknessMm/);
  });

  it('错误码是闭集：七个各过，`unknown` 与大小写不同都整包拒', () => {
    expect([...PERSIST_ERROR_CODES]).toEqual([
      'not-configured', 'no-project', 'bad-request', 'session', 'db', 'reconcile', 'internal',
    ]);
    for (const code of PERSIST_ERROR_CODES) {
      expect(FailureReplySchema.safeParse({ ok: false, code, message: 'x' }).success).toBe(true);
    }
    expect(FailureReplySchema.safeParse({ ok: false, code: 'unknown', message: 'x' }).success).toBe(false);
    expect(FailureReplySchema.safeParse({ ok: false, code: 'DB', message: 'x' }).success).toBe(false);
    expect(FailureReplySchema.safeParse({ ok: false, code: 'db' }).success).toBe(false);
  });
});

describe('persist-schema：名册与出口纪律', () => {
  it('名册三条 + 事件那一条 == IPC 里除 ping 的全部（漏登记即红）', () => {
    expect([...INVOKE_CHANNELS].sort()).toEqual(
      [IPC.journalSubmit, IPC.projectClose, IPC.projectOpen].sort(),
    );
    const covered = [...INVOKE_CHANNELS, SAVE_STATUS_EVENT].sort();
    // 裁决 t8-arbitration ②：`exportPlan` 的 handler 注册在 `main/ipc/export-plan.ts`，
    // 不在 `ipc-persist.ts` 的 switch 里 —— 把它收进 `INVOKE_CHANNELS` 会让
    // `ipc-channels.test.ts` 扫 `case IPC.${key}:` 那一格必红。漏登记即红的性质保留。
    expect(covered).toEqual(
      Object.values(IPC).filter((c) => c !== IPC.ping && c !== IPC.exportPlan).sort(),
    );
    // 事件通道不许混进名册（它没有请求方向，被注册成 handler 是自己调自己）。
    expect(INVOKE_CHANNELS.includes(SAVE_STATUS_EVENT)).toBe(false);
  });

  it('persist-schema.ts 的源码里没有口令，也没有连接参数的影子（第 ④ 段）', () => {
    // 三条 `\b` 前缀的尺为什么打得开却不误红：`import` / `export` 里的 "port" 前面是字母，
    // 没有词边界 ⇒ 不匹配；这个文件里真正的连接参数一个都不许出现。
    for (const re of [/password/i, /\bhost\s*:/, /\bport\s*:/, /(^|[^\w])user[^\w]/]) {
      expect(SCHEMA_SRC).not.toMatch(re);
    }
  });

  it('parse 出口的文案 = `<通道名> 解不开<那一句>：<点号路径>: …`', () => {
    expect(() => parseOpenRequest(IPC.projectOpen, { projectId: 42 })).toThrow(
      /^dajia:project:open 解不开打开工程的请求：projectId: /,
    );
    // 整个 value 不是对象时路径落在根那一格：`(根)` 是 T4 给 issueText 定的口径。
    expect(() => parseOpenValue(IPC.projectOpen, 42)).toThrow(/解不开打开工程的回包：\(根\)/);
  });
});
