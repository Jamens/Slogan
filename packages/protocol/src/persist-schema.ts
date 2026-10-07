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

// —— T9：连接配置、工程列表、新建、试连（第 ④ 段：口令只出现在下面两张表里）——
//
// 这一行原本写着那个四字段尺的名字，结果被切块扫描器**抓了一次**：块前的注释属于上一张表，
// 于是它把 T8 的 `SaveStatus` 那一块标成了"含口令"（第 8 格当场红）。这条陷阱留在注释里，
// 因为下一个人在这个文件里加注释时一定会再踩一次。

/**
 * 主机名：1–253 字符且不含空白。为什么 `max(253)`：那是 DNS 全名的长度上限（RFC 1035），
 * 而 MySQL 的 `host` 也可能是 IP —— 253 对 IPv4 与 IPv6 都够。
 * 不校验"是不是合法 DNS 名"：那会把 `localhost`、`127.0.0.1`、`db.internal` 之外
 * 一切合法写法（`HOST\\INSTANCE` 那种 Windows 写法）挡在外面，而拒绝合法输入比接受一次
 * 连不上更糟。**IPv6 方括号写法未验证**，登记进限度。
 */
const HostSchema = z
  .string()
  .min(1, '主机名不能为空')
  .max(253, '主机名太长')
  .refine((v) => !/\s/.test(v), '主机名不许含空白');

/** 1–65535 的整数端口。请求与回包共用这一把尺（回包方向是 `PortSchema.nullable()`）。 */
const PortSchema = z
  .number()
  .int('端口必须是整数')
  .min(1, '端口必须大于 0')
  .max(65_535, '端口不能超过 65535');

/** MySQL 的用户名上限是 32（`mysql.user` 的 `User` 列）。空串不合法：没有匿名登录这回事。 */
const UserSchema = z.string().min(1, '用户名不能为空').max(32, '用户名太长');

/**
 * 口令**允许空串**：本机 `root` 无口令是 MySQL 在 Windows 上的常见装完形状，
 * 拒空串等于把人挡在自己机器外面。`max(255)` 抄的是服务端 `authentication_string` 的尺，
 * 不是我们的规则。
 * 三条 message 全是**固定字符串**：zod 的默认 `too_big` 文案会带上收到的长度（不是值），
 * 而自定义 refine 常手滑把值抄进文案 —— 第 ④ 段那条防线判的就是这件事，别在这里破。
 */
const PasswordSchema = z.string().max(255, '口令太长');

/** 向导填的四个字段。它是**唯一**带口令键的请求形状（第 ④ 段第 1 条牙；注释里别说出那个字段名，见上面那段陷阱）。 */
export const ConnectionInputSchema = z.strictObject({
  host: HostSchema,
  port: PortSchema,
  user: UserSchema,
  password: PasswordSchema,
});
export type ConnectionInput = z.output<typeof ConnectionInputSchema>;

/**
 * 库名只有 `dajia` 一个合法值（第 ⑧ 段）。写进 schema 而不是代码常量，是为了让
 * "哪天放开它"必须过三格：这一张的 `options.length === 1`、`config-store` 落盘那一份、
 * 以及 `test/db/projects.test.ts` 里那条"建出来的行在 `dajia` 库"。
 */
export const ConfigDatabaseSchema = z.enum(['dajia']);
export type ConfigDatabase = z.output<typeof ConfigDatabaseSchema>;

/**
 * 盘上那份密文的**明文形状**（第 ④ 段的两块牙之一）。它等于 `ConnectionInput` + `database`，
 * 这里手写五格而不用 `ConnectionInputSchema.extend(...)`：`.extend` 之后还严不严（catchall
 * 是不是仍为 `never`）在 zod 4.6.5 上没实测过，而多带一键过界这件事恰是要判的。
 * 四把尺仍然只有一个产地（上面那四个 `const`），所以这不是复制规则。
 */
export const ConfigRecordSchema = z.strictObject({
  host: HostSchema,
  port: PortSchema,
  user: UserSchema,
  password: PasswordSchema,
  database: ConfigDatabaseSchema,
});
export type ConfigRecord = z.output<typeof ConfigRecordSchema>;

export const ConfigSaveRequestSchema = z.strictObject({ connection: ConnectionInputSchema });
export type ConfigSaveRequest = z.output<typeof ConfigSaveRequestSchema>;

/** 试连吃的形状与保存**完全相同**，但是另一张表：两者不同步是刻意的（见下面那段注释）。 */
export const ConfigTestRequestSchema = z.strictObject({ connection: ConnectionInputSchema });
export type ConfigTestRequest = z.output<typeof ConfigTestRequestSchema>;

/**
 * 读配置请求是一张**空表**，与 `ProjectListRequestSchema` 同一条理由（下面那段）：
 * `ipc-persist.ts` 的 `dispatch` 对每条通道都先 `parseXRequest(channel, args)`，
 * 省掉它就得给 `configRead` 开一个特例，而"每条通道都过自己的请求表"这句话就不再是全称命题。
 * 它同时是"哪天要加参数（比如强制重读）必须先过这张表"的那道门（`{ force: true }` ⇒ 拒）。
 */
export const ConfigReadRequestSchema = z.strictObject({});
export type ConfigReadRequest = z.output<typeof ConfigReadRequestSchema>;

/** 首屏与保存之后回的那一份。`state` 三值，口令不在里面（一个能装它的格子都没有）。 */
export const ConfigStateSchema = z.enum(['unset', 'ready', 'unreadable']);
export type ConfigState = z.output<typeof ConfigStateSchema>;

export const ConfigValueSchema = z
  .strictObject({
    state: ConfigStateSchema,
    /** `safeStorage.isEncryptionAvailable()` 的读数。false ⇒ 向导要把"这台机器存不了口令"说出来。 */
    encryptionAvailable: z.boolean(),
    host: z.string().nullable(),
    port: PortSchema.nullable(),
    user: z.string().nullable(),
    database: ConfigDatabaseSchema.nullable(),
  })
  .refine(
    (v) => (v.state === 'ready') === (v.host !== null),
    'state 与回显读数必须同向：ready 才有一套参数，unset/unreadable 一个都不许留',
  );
export type ConfigValue = z.output<typeof ConfigValueSchema>;

/**
 * 七型名单（`'ok'` + 六个错误型）**分两张表**写死而不是 `CONNECTION_TEST_KINDS.slice(1)`：
 * `z.enum` 收一个 spread 出来的 `string[]` 在 4.6.5 上是没实测过的形状，而 T8 已经为
 * `z.enum(PERSIST_ERROR_CODES)` 留了同一条 `<待实测>`。两份字面量一致由新文件第 8 格钉住。
 * 它与 `PERSIST_ERROR_CODES` **不是一张表**，也不该是：`kind` 说"连不上是因为什么"（给向导看），
 * `code` 说"这一发失败之后该做什么"（给横幅看）。拿 `code` 当 `kind` 会把 `'db'` 说成
 * "服务未启动"，而那正是 spec §9 要求分开来的东西。
 */
export const CONNECTION_TEST_KINDS = [
  'ok',
  'not-running',
  'denied',
  'no-database',
  'dropped',
  'timeout',
  'unknown',
] as const;
export const CONNECTION_ERROR_KINDS = [
  'not-running',
  'denied',
  'no-database',
  'dropped',
  'timeout',
  'unknown',
] as const;
export const ConnectionTestKindSchema = z.enum([
  'ok',
  'not-running',
  'denied',
  'no-database',
  'dropped',
  'timeout',
  'unknown',
]);
export type ConnectionTestKind = z.output<typeof ConnectionTestKindSchema>;

export const ConnectionTestValueSchema = z
  .strictObject({
    connected: z.boolean(),
    kind: ConnectionTestKindSchema,
    /** 只有连上才有。它是 `SELECT VERSION()` 的原样读数，也是"这台机器的 MySQL 是 8.0.45"这件事的证人。 */
    serverVersion: z.string().nullable(),
    /** `DIAGNOSTIC_TEXT[kind].detail` +（失败时）过 `redact` 的原文。见第 ④ 段三条防线。 */
    detail: z.string(),
  })
  .refine((v) => v.connected === (v.kind === 'ok'), 'connected 与 kind 必须同向');
export type ConnectionTestValue = z.output<typeof ConnectionTestValueSchema>;

/** 工程列表的一行。六格每格都有读者，一格外挂都不许有。 */
export const ProjectSummarySchema = z.strictObject({
  projectId: EntityIdSchema,
  name: z.string().min(1),
  /** 面板按它给"这份工程不是这个程序能读的"那句预警（S1 没有迁移路径，点开只会得到 T5 的拒开）。 */
  schemaVersion: SafeCountSchema,
  journalTurn: JournalTurnSchema,
  /** `DATETIME(3)` 按 `dateStrings: true` 原样读回的字符串。不做任何客户端换算（P-4 同一条口径）。 */
  updatedAt: z.string(),
  /** `lock_owner IS NOT NULL` 的读数。它**不等于**"还活着"，见第 ⑨ 段。 */
  locked: z.boolean(),
});
export type ProjectSummary = z.output<typeof ProjectSummarySchema>;

/**
 * 列表请求是一张**空表**。为什么不省：`ipc-persist.ts` 的 `dispatch` 对每条通道都先
 * `parseXRequest(channel, args)`，空表让 `projectList` 走同一条路而不需要特例；
 * 而它同时是"谁哪天想给列表加个过滤参数，必须先过这张表"的那道门（`{ filter: 'x' }` ⇒ 拒）。
 */
export const ProjectListRequestSchema = z.strictObject({});
export type ProjectListRequest = z.output<typeof ProjectListRequestSchema>;

export const ProjectListValueSchema = z.strictObject({ projects: z.array(ProjectSummarySchema) });
export type ProjectListValue = z.output<typeof ProjectListValueSchema>;

/**
 * 工程名的尺与 T4 `createProject` 里那三行是**镜像**（1..200、不许首尾空白、非空）。
 * 两份规则一定会漂 —— 这是本任务唯一一次故意留两份，理由是两处的下一步动作不同：
 * 边界这一发回 `'bad-request'`（用户改一下就能过），存储层那一发是 `RangeError` ⇒ `'reconcile'`
 * （停手，因为那是我们自己把两把尺写漂了）。漂了会不会没人红：会 ——
 * `test/db/projects.test.ts` 第 3 格从边界递 200/201 两种长度，让存储层那一发也必须表态。
 */
const ProjectNameSchema = z
  .string()
  .min(1, '工程名不能为空')
  .max(200, '工程名不能超过 200 个字符')
  .refine((v) => v === v.trim(), '工程名不许带首尾空白');

export const ProjectCreateRequestSchema = z.strictObject({ name: ProjectNameSchema });
export type ProjectCreateRequest = z.output<typeof ProjectCreateRequestSchema>;

/** `create` 只回 id：开会话那一发由 renderer 接着发（第 ② 段末）。 */
export const ProjectCreateValueSchema = z.strictObject({ projectId: EntityIdSchema });
export type ProjectCreateValue = z.output<typeof ProjectCreateValueSchema>;

/**
 * main 递给屏幕的三个"该显示哪一层"。它是一条**请求方向之外**的事件，
 * 值只有一个名字，所以在这里闭集列全：加第四个值必须同时改 `panels.tsx` 那一支与
 * `ipc-channels.test.ts` 新加的第 4 格。
 */
export const UiCommandSchema = z.enum(['startup', 'config', 'projects']);
export type UiCommand = z.output<typeof UiCommandSchema>;

// —— T9 的解析出口：照 T8 那一族的样子，每个具名函数一句人话 ——

export function parseConnectionInput(where: string, value: unknown): ConnectionInput {
  const r = ConnectionInputSchema.safeParse(value);
  if (!r.success) fail(where, '连接参数', r.error);
  return r.data;
}

export function parseConfigSaveRequest(where: string, value: unknown): ConfigSaveRequest {
  const r = ConfigSaveRequestSchema.safeParse(value);
  if (!r.success) fail(where, '保存连接配置的请求', r.error);
  return r.data;
}

export function parseConfigTestRequest(where: string, value: unknown): ConfigTestRequest {
  const r = ConfigTestRequestSchema.safeParse(value);
  if (!r.success) fail(where, '试连的请求', r.error);
  return r.data;
}

/** 空表那一发的出口：它唯一的作用是让 `dispatch` 那条全称命题成立（见 `ConfigReadRequestSchema` 的注释）。 */
export function parseConfigReadRequest(where: string, value: unknown): ConfigReadRequest {
  const r = ConfigReadRequestSchema.safeParse(value);
  if (!r.success) fail(where, '读连接配置的请求', r.error);
  return r.data;
}

/** `config:read` 与 `config:save` 共用这一份（第 ② 段：回的是同一种读数）。 */
export function parseConfigValue(where: string, value: unknown): ConfigValue {
  const r = ConfigValueSchema.safeParse(value);
  if (!r.success) fail(where, '连接配置的回包', r.error);
  return r.data;
}

export function parseConnectionTestValue(where: string, value: unknown): ConnectionTestValue {
  const r = ConnectionTestValueSchema.safeParse(value);
  if (!r.success) fail(where, '试连的回包', r.error);
  return r.data;
}

export function parseProjectListRequest(where: string, value: unknown): ProjectListRequest {
  const r = ProjectListRequestSchema.safeParse(value);
  if (!r.success) fail(where, '工程列表的请求', r.error);
  return r.data;
}

export function parseProjectListValue(where: string, value: unknown): ProjectListValue {
  const r = ProjectListValueSchema.safeParse(value);
  if (!r.success) fail(where, '工程列表的回包', r.error);
  return r.data;
}

export function parseProjectCreateRequest(where: string, value: unknown): ProjectCreateRequest {
  const r = ProjectCreateRequestSchema.safeParse(value);
  if (!r.success) fail(where, '新建工程的请求', r.error);
  return r.data;
}

export function parseProjectCreateValue(where: string, value: unknown): ProjectCreateValue {
  const r = ProjectCreateValueSchema.safeParse(value);
  if (!r.success) fail(where, '新建工程的回包', r.error);
  return r.data;
}

export function parseUiCommand(where: string, value: unknown): UiCommand {
  const r = UiCommandSchema.safeParse(value);
  if (!r.success) fail(where, '界面指令', r.error);
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

/**
 * 事件方向两条（main → renderer，没有请求方向），都不许进上面的名册。
 *
 * T9 这一发只把 `uiCommand` 那条**事件**加进来，五个新请求通道（`configRead` … `projectCreate`）
 * 暂时还留在名册外：名册是"注册与扫描的同一份名单"
 * （`apps/desktop/test/unit/ipc-channels.test.ts` 按它去扫 `ipc-persist.ts` 的 `case`
 * 与 preload 的 `invoke`），而那两端与这些表是同一发落的 —— 先进名册会让那一格在 main
 * 还没有 `case` 的时候红。"还没登记"这件事由 `persist-schema.test.ts` 第 7 格那张
 * `NOT_YET_REGISTERED` 点名，接线那一发删掉它并把五条收进名册。
 */
export const SAVE_STATUS_EVENT: IpcChannel = IPC.saveStatus;
export const UI_COMMAND_EVENT: IpcChannel = IPC.uiCommand;
