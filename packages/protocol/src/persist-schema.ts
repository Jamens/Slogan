import { z } from 'zod';
import { IPC, type IpcChannel } from './ipc';
import {
  DocumentPayloadSchema,
  EntityIdSchema,
  JournalTurnSchema,
  PatchSchema,
  issueText,
} from './entity-schema';

/**
 * IPC 侧的"非负安全整数"尺。为什么**不**复用 `JournalTurnSchema`：那把尺的名字就是它的语义
 * （落库那一发的编号），拿它去量 `snapshot.seq` 与 `replayed.rows` 会让读代码的人以为
 * "这三者是同一个量"，而 seq 是 AUTO_INCREMENT 的游标（**可以带洞**，P-6），turn 不可以。
 * 规则相同、语义不同 ⇒ 两个 schema 各自存在，正是为了让"把它们混成一个"这件事有名字可红。
 */
const SafeCountSchema = z
  .number()
  .refine((v) => Number.isSafeInteger(v) && v >= 0, '必须为非负安全整数');

/** 结构化错误码（spec §9）。闭集，**没有** `'unknown'`：理由见计划第 ③ 段。 */
export const PERSIST_ERROR_CODES = [
  'not-configured',
  'no-project',
  'bad-request',
  'session',
  'db',
  'reconcile',
  'internal',
] as const;
export const PersistErrorCodeSchema = z.enum(PERSIST_ERROR_CODES);
export type PersistErrorCode = z.output<typeof PersistErrorCodeSchema>;

export const FailureReplySchema = z.strictObject({
  ok: z.literal(false),
  code: PersistErrorCodeSchema,
  message: z.string(),
});
export type PersistFail = z.output<typeof FailureReplySchema>;

/**
 * 过界的回包形状。它是**类型**，不是 zod schema：成功那一支的 `value` 由各通道的
 * `XValueSchema` 单独验（用 union 会让嵌套字段的错误文案塌成 `(根)`，第 ③ 段），
 * 失败那一支由 `ipc-persist.ts` 自己拼，只有 `code` 需要闭集保证 —— 那一条走
 * `PersistErrorCodeSchema`，见 `fail()`。
 */
export type IpcResult<T> = { readonly ok: true; readonly value: T } | PersistFail;

// —— 打开工程 ——————————————————————————————————————————————

/** 只有 `projectId`。没有名字、没有口令、没有建库参数（第 ④ 段：T8 的配置源是环境变量）。 */
export const OpenRequestSchema = z.strictObject({ projectId: EntityIdSchema });
export type OpenRequest = z.output<typeof OpenRequestSchema>;

/** `decision` 与 T5 的 `OpenIntent` 不是一张表：那边是"我想怎么开"，这边是"库里那一行让我怎么开"。 */
export const OpenDecisionSchema = z.enum(['edit', 'read-only']);
export type OpenDecision = z.output<typeof OpenDecisionSchema>;

/**
 * 带 `Wire` 后缀的两张表（`ProjectHeaderWire` / `SaveStatusWire`）是因为
 * `session.ts` 同一文件里会同时出现 T5 的 `ProjectHeader` 与 T7 的 `SaveStatus`：
 * 两份类型必须分得开，否则读的人以为校验的是自己那份（这正是"过界再验一次"最容易被
 * 顺手写成 `as` 的地方）。其余 schema 没有对手，不带后缀。
 */
export const ProjectHeaderWireSchema = z.strictObject({
  projectId: EntityIdSchema,
  name: z.string().min(1),
  schemaVersion: SafeCountSchema,
  journalTurn: JournalTurnSchema,
  wasCleanShutdown: z.boolean(),
});
export type ProjectHeaderWire = z.output<typeof ProjectHeaderWireSchema>;

export const EmergencyRefSchema = z.strictObject({
  turn: JournalTurnSchema,
  /** 绝对路径，只给人看：renderer 一行 fs 都不许碰（spec §4.3），所以它只是横幅上的那串字。 */
  path: z.string().min(1),
});
export type EmergencyRef = z.output<typeof EmergencyRefSchema>;

export const OpenValueSchema = z.strictObject({
  decision: OpenDecisionSchema,
  header: ProjectHeaderWireSchema,
  doc: DocumentPayloadSchema,
  snapshot: z.strictObject({ seq: SafeCountSchema, turn: JournalTurnSchema }).nullable(),
  replayed: z.strictObject({
    rows: SafeCountSchema,
    fromSeq: SafeCountSchema.nullable(),
    toSeq: SafeCountSchema.nullable(),
  }),
  emergency: z.array(EmergencyRefSchema),
});
export type OpenValue = z.output<typeof OpenValueSchema>;

// —— 每发提交 ——————————————————————————————————————————————

export const SubmitRequestSchema = z.strictObject({
  projectId: EntityIdSchema,
  patch: PatchSchema,
  doc: DocumentPayloadSchema,
});
export type SubmitRequest = z.output<typeof SubmitRequestSchema>;

export const SubmitValueSchema = z.strictObject({
  /** T7 `Autosave.submit` 的两个返回值，原样搬过界（`'ignored-duplicate'` = 引擎认为这发已经排过了）。 */
  outcome: z.enum(['queued', 'ignored-duplicate']),
  acceptedTurn: JournalTurnSchema,
});
export type SubmitValue = z.output<typeof SubmitValueSchema>;

// —— 收尾（T5 的 flush + closeProject + 解锁），第 ⑤/⑦ 段 ——————

export const CloseRequestSchema = z.strictObject({
  projectId: EntityIdSchema,
  doc: DocumentPayloadSchema,
  /** `abandon` = 停写、解锁、关池，**不** flush、**不**对账（丢锁之后重开前那一发）。 */
  mode: z.enum(['graceful', 'abandon']),
});
export type CloseRequest = z.output<typeof CloseRequestSchema>;

export const CloseValueSchema = z.strictObject({
  /** `abandon` 那一支不跑对账 ⇒ 两格读数都是 `null`。用 `null` 而不是 `0`：0 是"平账"的答案。 */
  elementRows: SafeCountSchema.nullable(),
  storeyRows: SafeCountSchema.nullable(),
});
export type CloseValue = z.output<typeof CloseValueSchema>;

// —— 事件：main → renderer，只带 T7 那一个形状 ————————————————

/**
 * 与 `apps/desktop/src/main/persist/autosave.ts` 的 `SaveStatus` 一字对齐，
 * 由 `persist-schema.test.ts` 第 4 格做源码级对账（同一族判据的先例：T6 的
 * 「`locks.ts` 里不许出现客户机时钟」与 T7 的「心跳标识符还在」）。
 */
export const SaveStatusSchema = z.strictObject({
  phase: z.enum(['idle', 'saving', 'failed', 'paused', 'stopped']),
  queuedTurns: SafeCountSchema,
  lastTurn: JournalTurnSchema.nullable(),
  snapshotTurn: JournalTurnSchema.nullable(),
  rowsSinceSnapshot: SafeCountSchema,
  lastError: z.string().nullable(),
  pauseReason: z.string().nullable(),
});
export type SaveStatusWire = z.output<typeof SaveStatusSchema>;

// —— 解析出口：每通道各一个具名函数，不做泛型 ——————————————————
//
// 为什么不用一个泛型 `parsePersist(where, schema, value)`：zod v4 的 `z.ZodType<T>` 单参数
// 写法在 4.6.5 上未经实测（本计划只主张 T1 装得上 `zod@4.6.5` 这件事），而泛型一旦要写第二份
// 就得先证明它解析得到。十一个具名出口啰嗦 20 行，换来的是每条通道的错误文案里有一句人话
// （"解不开打开工程的请求"），T9 的分型诊断要读它。

function fail(where: string, what: string, err: z.ZodError): never {
  throw new TypeError(`${where} 解不开${what}：${issueText(err)}`);
}

export function parseOpenRequest(where: string, value: unknown): OpenRequest {
  const r = OpenRequestSchema.safeParse(value);
  if (!r.success) fail(where, '打开工程的请求', r.error);
  return r.data;
}

export function parseOpenValue(where: string, value: unknown): OpenValue {
  const r = OpenValueSchema.safeParse(value);
  if (!r.success) fail(where, '打开工程的回包', r.error);
  return r.data;
}

export function parseSubmitRequest(where: string, value: unknown): SubmitRequest {
  const r = SubmitRequestSchema.safeParse(value);
  if (!r.success) fail(where, '每发提交的请求', r.error);
  return r.data;
}

export function parseSubmitValue(where: string, value: unknown): SubmitValue {
  const r = SubmitValueSchema.safeParse(value);
  if (!r.success) fail(where, '每发提交的回包', r.error);
  return r.data;
}

export function parseCloseRequest(where: string, value: unknown): CloseRequest {
  const r = CloseRequestSchema.safeParse(value);
  if (!r.success) fail(where, '收尾的请求', r.error);
  return r.data;
}

export function parseCloseValue(where: string, value: unknown): CloseValue {
  const r = CloseValueSchema.safeParse(value);
  if (!r.success) fail(where, '收尾的回包', r.error);
  return r.data;
}

export function parseSaveStatus(where: string, value: unknown): SaveStatusWire {
  const r = SaveStatusSchema.safeParse(value);
  if (!r.success) fail(where, '保存状态', r.error);
  return r.data;
}

// —— 通道名册：注册与扫描的同一份名单 ————————————————

/**
 * 需要注册 handler 的那三条（请求方向，renderer 发起）。`ipc-persist.ts` 按这张名单
 * **循环注册**（`removeHandler` + `handle` 成对，形状照盘上现物那条 `ping`），
 * `ipc-channels.test.ts` 按同一张名单去扫 `ipc-persist.ts` 的 `dispatch`：名单上有一条没写 `case` ⇒ 当场红。
 *
 * 这里故意**不带** parse 函数（一版草稿写过 `ChannelSpec { channel, parseRequest }`，删了）：
 * 外壳只能把 parse 的结果当 `unknown` 交下去，那条 `as` 会把 zod 已经建起来的类型牙拆掉 ——
 * `submit(req: SubmitRequest)` 会失去编译期检查。解析留在 `dispatch` 的 `case` 里用各通道具名 parse，
 * 于是这张名单唯一的职责就是"哪些通道要注册"，一个字段都不多。
 */
export const INVOKE_CHANNELS: readonly IpcChannel[] = [
  IPC.projectOpen,
  IPC.journalSubmit,
  IPC.projectClose,
];

/** 事件方向只有一条（main → renderer，没有请求方向），所以它不进上面的名册。 */
export const SAVE_STATUS_EVENT: IpcChannel = IPC.saveStatus;
