/**
 * 库侧连接失败的分型（spec §9 要的"分型诊断"）。
 *
 * ## 这个文件的边界：零 import
 *
 * **一行 import 都不许有**，`import type` 也不算（`persist-boundary.test.ts` 第 7 格
 * 用 `from '` 扫，`import type { x } from` 同样命中）。三条理由：
 *
 * 1. 它住在 `main/db/` 里，而**连库档的夹具（`test/db/**`）要能 import 它**。
 *    那个档跑在纯 node，不该被任何 import链拖进 electron 或 zod。
 * 2. 分型是"看一眼错误形状"的纯函数，**它的正确性必须能被单独证**。
 *    带一个 import 就多一份"这条 import 会不会变"的耦合，而它没有任何依赖的需求。
 * 3. P-25：`classifyDbError` **只分型不写文案**，文案住在 `shared/diagnostics-text.ts`。
 *    两边都零 import ⇒ 两份可以各自独立编译（连 renderer 侧的那份也能引）。
 *
 * ## 为什么只认 `err.code`，不读 `err.message`
 *
 * 逐字口径（计划第③ 段）：message 是会改措辞的人话，拿正则去读它等于把判据建在
 * 最不稳的东西上；而 `ER_ACCESS_DENIED_ERROR` 那种原文里也带 `Access denied` 的字符串，
 * 正则与字段会给出两个答案。**字段是稳定的那个**。
 */

/** 六个分型。`'ok'` 不在此表—— 它是"连上了"，由 `probeConnection` 单独判，不走错误分型。 */
export const CONNECTION_ERROR_KINDS = [
  'not-running',
  'denied',
  'no-database',
  'dropped',
  'timeout',
  'unknown',
] as const;
export type ConnectionErrorKind = (typeof CONNECTION_ERROR_KINDS)[number];

/**
 * 分型的依据：驱动错误对象的 `code` 字段。
 *
 * **形状是 `unknown` 而不是 `NodeJS.ErrnoException`**：判据第 6 格要求
 * `classifyDbError` 接受**任何**输入（字符串 / 数字 / true / null / undefined / Symbol）
 * 而不抛 —— 而 TS 的 `ErrnoException` 是 `Error & {code?: string}`，
 * 传一个字符串进去**在编译期就红**。我们要的是"运行时什么都不认识也不抛"，
 * 所以入口必须声明成 `unknown`。
 */
export interface ErrorLike {
  readonly code?: unknown;
}

/** 五码一型 / 两码一型 / 三码一型的三张表。分型口径逐条记在下面。 */
const NOT_RUNNING_CODES: readonly string[] = [
  'ECONNREFUSED',
  // 主机名解析不到（`ENOTFOUND`）与 DNS 临时不可用（`EAI_AGAIN`）——
  // 对用户来说是同一句话：「那个地址我找不到/连不上」。
  'ENOTFOUND',
  'EAI_AGAIN',
  // 路由不通：主机名解析出来了，但网络到不了（网段隔离 / 防火墙丢包）。
  'EHOSTUNREACH',
  'ENETUNREACH',
];

const DENIED_CODES: readonly string[] = [
  'ER_ACCESS_DENIED_ERROR',
  // 认证插件不被驱动支持（MySQL 8 默认 `caching_sha2_password`，老驱动握不上手）。
  // **并进 `denied` 的理由**（计划第 ⑤ 段）：它的下一步动作与"口令错了"完全相同
  // （去安装说明的「认证失败」一节三步排查），所以 `detail` 必须把两种处境都说到。
  'ER_NOT_SUPPORTED_AUTH_MODE',
];

const DROPPED_CODES: readonly string[] = [
  'PROTOCOL_CONNECTION_LOST',
  // **spec §9 点名的「端口占用」归这一型**（该节原文的订正）：客户端永远拿不到
  // `EADDRINUSE`（那是监听端才有的错）。真实症状是"连上了，但对面说话不像 MySQL"，
  // 于是落在这两个码上。文案里明写「端口可能被别的程序占用」。
  'ECONNRESET',
  'EPIPE',
];

/**
 * 把一个驱动错误分型。**永不抛** —— `err` 是任何东西都返回 `unknown`（判据第 5、6 格）。
 *
 * @param err 驱动的错误对象，或者任何别的值。
 * @returns 六个分型之一。认不出来的码**一律** `'unknown'`（含长得像的：见第 3 格判据）。
 */
export function classifyDbError(err: unknown): ConnectionErrorKind {
  // `err` 本身不是对象时（字符串 / 数字 / true / null / undefined / Symbol）
  // 就没有 `code` 可读 ⇒ 直接落 `unknown`，**不抛**。
  if (typeof err !== 'object' || err === null) return 'unknown';
  const code = (err as ErrorLike).code;
  // `code` 的类型不是 string（`1045` / `null` / `undefined` / `{}` / 数组）⇒ 一律 unknown
  // （第 5 格）。驱动偶尔给数字错误号，那是 mysql 层的，形状与这里的码表不同。
  if (typeof code !== 'string') return 'unknown';

  if (NOT_RUNNING_CODES.includes(code)) return 'not-running';
  if (DENIED_CODES.includes(code)) return 'denied';
  if (code === 'ER_BAD_DB_ERROR') return 'no-database';
  if (DROPPED_CODES.includes(code)) return 'dropped';
  if (code === 'ETIMEDOUT') return 'timeout';
  // **不许在这里"归个类算了"**（逐字）。给闭集去掉 `'unknown'` 的理由在文案这一族同样成立：
  // 留一个"看起来像"的默认型，就等于允许哪天把没查清的东西说成"服务未启动"。
  return 'unknown';
}