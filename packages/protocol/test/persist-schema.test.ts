import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IPC, type IpcChannel } from '../src/ipc';
import {
  FailureReplySchema,
  INVOKE_CHANNELS,
  OpenRequestSchema,
  OpenValueSchema,
  PERSIST_ERROR_CODES,
  SAVE_STATUS_EVENT,
  SaveStatusSchema,
  UI_COMMAND_EVENT,
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
  it('名册三条 + 两条事件 + 五个待登记的通道 == IPC 里除 ping 与 exportPlan 的全部（漏登记即红）', () => {
    expect([...INVOKE_CHANNELS].sort()).toEqual(
      [IPC.journalSubmit, IPC.projectClose, IPC.projectOpen].sort(),
    );
    // 【接线那一发要整段删掉】T9 这一发只落五个新请求通道的**契约**（表 + parse 出口），
    // 它们的 main 侧 `case` 与 preload 侧 `invoke` 还没落，那时才进 `INVOKE_CHANNELS` ——
    // 名册是"注册与扫描的同一份名单"（`apps/desktop/test/unit/ipc-channels.test.ts`
    // 按它去扫 `ipc-persist.ts` 与 preload），先进名册会让那一格在 main 还没有 case 的时候红。
    // 把"还没登记"写成五个显式的名字而不是一句含糊的 filter，是为了让它两头都红得起来：
    // 接线那一发把 `configRead` 收进名册 ⇒ 下面那句 `toBe(false)` 红（⇒ 必须把这一行删掉）；
    // 而删掉这一整段却不扩名册 ⇒ 那条等式红。于是唯一能绿的形状是"五条都进了名册"。
    const NOT_YET_REGISTERED: readonly IpcChannel[] = [
      IPC.configRead,
      IPC.configSave,
      IPC.configTest,
      IPC.projectList,
      IPC.projectCreate,
    ];
    for (const channel of NOT_YET_REGISTERED) {
      expect(INVOKE_CHANNELS.includes(channel)).toBe(false);
    }
    const covered = [
      ...INVOKE_CHANNELS,
      SAVE_STATUS_EVENT,
      UI_COMMAND_EVENT,
      ...NOT_YET_REGISTERED,
    ].sort();
    // 裁决 t8-arbitration ②：`exportPlan` 的 handler 注册在 `main/ipc/export-plan.ts`，
    // 不在 `ipc-persist.ts` 的 switch 里 —— 把它收进 `INVOKE_CHANNELS` 会让
    // `ipc-channels.test.ts` 扫 `case IPC.${key}:` 那一格必红。漏登记即红的性质保留。
    expect(covered).toEqual(
      Object.values(IPC).filter((c) => c !== IPC.ping && c !== IPC.exportPlan).sort(),
    );
    // 两条事件都不许混进名册（它们没有请求方向，被注册成 handler 是自己调自己）。
    expect(INVOKE_CHANNELS.includes(SAVE_STATUS_EVENT)).toBe(false);
    expect(INVOKE_CHANNELS.includes(UI_COMMAND_EVENT)).toBe(false);
  });

  it('`password` 只许出现在两张进方向的表里；任何回包表都不许有它（第 ④ 段）', () => {
    // 按 `const XSchema =` 切块，一块一张尺（`export` 可选：四把私有字段尺 `Host` / `Port` /
    // `User` / `Password` 必须各自成块，否则它们会被上一张表的块吸收 —— 那会把 SaveStatus
    // 那一块标成"含 password"，因为 `PasswordSchema` 这个标识符本身就含这个词。这一刀是实测出来的。）
    // 为什么不再拿整文件一把尺判：T8 那一版判的是"这个文件里一个连接参数都不许出现"，
    // 而向导把这句话作废了（第 ④ 段），剩下的判据必须能回答"口令有没有从回包方向漏出去"。
    const parts = SCHEMA_SRC.split(/\n(?=(?:export )?const \w+Schema\b)/);
    const nameOf = (block: string): string | null =>
      /^(?:export )?const (\w+)Schema\b/.exec(block)?.[1] ?? null;
    const named = parts
      .map((p) => [nameOf(p), p] as const)
      .filter((e): e is [string, string] => e[0] !== null);

    // 先证扫描器自己会响（这一族判据最怕的形状是"名单为空所以全绿"）：
    const fake = 'export const FooValueSchema = z.strictObject({ password: z.string() });\n';
    expect(nameOf(fake)).toBe('FooValue');
    expect(/password/i.test(fake)).toBe(true);
    expect(named.length).toBeGreaterThanOrEqual(28); // 表少了就是切块切错了，别让改动悄悄通过

    const withPassword = named
      .filter(([, block]) => /password/i.test(block))
      .map(([n]) => n)
      .sort();
    // `Password` 是那把私有字段尺自己：它的名字含这个词，命中是名字的自指，不是形状。
    // 点名它而不是过滤掉它，是为了别让下一个人以为扫描器漏了一张表。
    expect(withPassword).toEqual(['ConfigRecord', 'ConnectionInput', 'Password']);

    const values = named.filter(([n]) => n.endsWith('Value'));
    expect(values.length).toBeGreaterThanOrEqual(7); // Open/Submit/Close/Config/ConnectionTest/List/Create
    for (const [name, block] of values) {
      expect(/password/i.test(block)).toBe(false);
      expect(name).toBeTruthy(); // 逐格都真判过，不是空循环
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
