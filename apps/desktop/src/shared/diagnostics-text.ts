/**
 * 连接失败的**三段文案**（title / detail / next）的唯一产地（P-25）。
 *
 * ## 为什么它零 import（P-25 的另一半）
 *
 * `classifyDbError` 只分型不写文案，文案住在这里。两个文件**都不许 import 任何东西**
 * （连 `import type` 都不许 —— `persist-boundary.test.ts` 第 7 格用 `from '` 扫）。
 *
 * 零 import 的实际收益是它能被**任何一侧独立编译**：渲染进程要显示这一行、
 * main 要拿它拼 `detail`、连库档要断言它逐字出现在 `install-mysql.md` 里 ——
 * 三处引的是同一个常量源，而那三处互相之间不需要认识。
 *
 * ## 三段的分工（每段各回答一个不同的问题）
 *
 * - `title`：**发生了什么**（短，可以进按钮或标签）。
 * - `detail`：**我这边看到的是什么**（含那两种被合并的处境 —— 见下面两处说明）。
 * - `next`：**你下一步做什么**（spec §9：每个分型都必须有一个下一步动作）。
 *
 * ## 两条不可省的纪律
 *
 * ① **`unknown` 那一型的三段里不许出现「服务」「没装」「未安装」「启动」任何字样**，
 *    且 `next` 必须含「原文」二字。没查清的东西**不能**被说成某个已知的下一步
 *    （与 `classifyDbError` 那个 `default` 分支的理由同源）。
 * ② **六型的 `next` 必须互不相同**。两型给出同一个下一步，就等于分型白做 ——
 *    判据 `diagnostics-text.test.ts` 第 2 格逐字比。
 */

/** 七个诊断型。`'ok'` 在**第一位** —— 分型失败那六型在 `diagnostics.ts` 里且不含它。 */
export const DIAGNOSTIC_KIND_LIST = [
  'ok',
  'not-running',
  'denied',
  'no-database',
  'dropped',
  'timeout',
  'unknown',
] as const;
export type DiagnosticKind = (typeof DIAGNOSTIC_KIND_LIST)[number];

export interface DiagnosticText {
  /** 发生了什么。短。 */
  readonly title: string;
  /** 我这边看到的是什么。 */
  readonly detail: string;
  /** 下一步做什么（spec §9 的硬要求：每型都有）。 */
  readonly next: string;
}

/**
 * 七型的三段文案，逐字。
 *
 * `not-running` 与 `denied` 两型的 `detail` **必须把被合并的多种处境都说到**
 * （计划第 ⑤ 段：说不到就是文案 bug，由 `diagnostics-text.test.ts` 判）。
 */
export const DIAGNOSTIC_TEXT: Readonly<Record<DiagnosticKind, DiagnosticText>> = {
  ok: {
    title: '连上了',
    detail: '这台 MySQL 应答正常。',
    next: '保存配置，然后在工程列表里新建或打开一个工程。',
  },
  // 带连字符的键必须引起来（`not-running` / `no-database` 在 TS 的标识符语法里
  // 都不是合法键名 —— 不加引号是 PARSE_ERROR，不是 lint 警告）。
  'not-running': {
    title: '连不上这个地址',
    // 五码一型（ECONNREFUSED / ENOTFOUND / EAI_AGAIN / EHOSTUNREACH / ENETUNREACH）
    // ⇒ 这三种处境都要说到：端口没人听、主机名解析不到、路由不通。
    detail: '没有程序在听这个端口（服务没启动），或者主机名解析不到、路由不通。',
    next: '先确认服务已经启动，再确认主机名和端口填的是同一台机器上那一套。',
  },
  denied: {
    title: '认证失败',
    // 两码一型（ER_ACCESS_DENIED_ERROR / ER_NOT_SUPPORTED_AUTH_MODE）⇒ 两种处境：
    // 口令不对，或者服务端的认证插件不被驱动支持。少说一个用户就会只查口令。
    detail: '用户名或口令不对，也可能是服务端的认证插件不被驱动支持。',
    next: '按安装说明的「认证失败」一节三步排查：用户名、口令、认证插件。',
  },
  // 带连字符的键必须引起来（`no-database` 在 TS 的标识符语法里不是合法键名）。
  'no-database': {
    title: '库不存在',
    // **不许出现「口令」二字**（判据第 4 格的四句「不许串话」之一）：
    // 这一型的下一步是建库，说成口令会让用户去改他没做错的那一格。
    detail: '连上了服务器，但那个库还没建。',
    next: '按安装说明的「库不存在」一节建库建表，`pnpm db:sql` 可以导出建表语句。',
  },
  dropped: {
    title: '连上了又被断开',
    // spec §9 点名的「端口占用」归这一型（客户端拿不到 `EADDRINUSE`，
    // 真实症状是"连上了但对面说话不像 MySQL"）⇒ 文案里明写端口占用。
    detail: '端口能连上，但对面说的话不像 MySQL。',
    next: '先看 3306 端口被哪个程序占用；不是 MySQL 就改端口，是 MySQL 就是服务中途重启了。',
  },
  timeout: {
    title: '等回应等超时',
    detail: '连不上也没被拒绝，一直到超时。',
    next: '先改用 127.0.0.1 试一次；还不行就去看安装说明「连不上但超时」一节的防火墙那一头。',
  },
  unknown: {
    // ① 那一组三段合起来不许出现「服务」「没装」「未安装」「启动」任何字样。
    title: '这一条我们没认出来',
    detail: '收到的错误码不在已知的种类里，不猜原因。',
    // 必须含「原文」二字 —— 它要给出一条能照着做的动作，而不是"不知道"。
    next: '点「一键复制诊断」把原文贴出来查，或按原文里的错误码搜索。',
  },
};