import { hostname } from 'node:os';
import { app, ipcMain, safeStorage, type BrowserWindow, type WebContents } from 'electron';
import type { Pool } from 'mysql2/promise';
import {
  INVOKE_CHANNELS,
  IPC,
  SAVE_STATUS_EVENT,
  parseCloseRequest,
  parseCloseValue,
  parseConfigReadRequest,
  parseConfigSaveRequest,
  parseConfigTestRequest,
  parseConfigValue,
  parseConnectionTestValue,
  parseOpenRequest,
  parseOpenValue,
  parseProjectCreateRequest,
  parseProjectCreateValue,
  parseProjectListRequest,
  parseProjectListValue,
  parseSaveStatus,
  parseSubmitRequest,
  parseSubmitValue,
  type IpcChannel,
  type IpcResult,
  type PersistErrorCode,
  type PersistFail,
  type SaveStatusWire,
} from '@dajia/protocol';
import {
  ConfigError,
  configToEnv,
  probeConfig,
  readConfig,
  writeConfig,
  type ByteCipher,
} from './persist/config-store';
import { ProjectAdmin, buildDraftEnv, probeConnection } from './persist/admin';
import { makeAdminPorts, probeOpener } from './persist/admin-ports';
import type { EntityId } from '@dajia/core';
import type { MysqlEnv } from './db/env';
import { createDbPool } from './db/pool';
import { migrate } from './db/migrate';
import { acquireLock, heartbeat, newLockTicket, releaseLock, type LockTicket } from './db/locks';
import { ProjectRepository } from './db/repository';
import { realTimer, type EmergencyPayload, type SaveStatus } from './persist/autosave';
import { describeError } from './persist/describe-error';
import { listEmergency, writeEmergencySnapshot } from './persist/emergency';
import {
  ProjectSession,
  SessionError,
  type DbHandle,
  type LockHandle,
  type PersistPorts,
} from './persist/session';

/**
 * 锁的归属串 = `机器名:pid`。两个读者：`project.lock_owner`（VARCHAR(200)，横幅上直接显示的那一行）
 * 与 `command_log.actor`（VARCHAR(64)，谁的哪一号进程写的这发账）。**同一个串**：
 * 分成两份就会漂（"锁在我这儿、账不是"这种现场没法读），而它的上限检查交给各自那把尺
 * （`newLockTicket` 管 200，`ProjectRepository` 管 64），这里不留第二份数（P-4 口径）。
 */
function lockOwner(): string {
  return `${hostname()}:${process.pid}`;
}

/**
 * `ByteCipher` 的 `safeStorage` 实现。它住在这里而不是 `persist/config-store.ts`，是 P-27 那一刀的正文：
 * `config-store.ts` 保持 electron-free，它的 10 格才跑得了纯 node 档（t9a 第 ⑦ 段末那条"import 那一刻就炸"
 * 的处境在这个文件里不存在 —— 本文件本来就被授权认识 electron）。
 *
 * `available` 是 getter 不是常量（P-36）：`safeStorage.isEncryptionAvailable()` 在 app ready 之前回 false，
 * 而模块级常量等于把"这台机器能不能加密"冻在求值那一刻。留一个惰性的读数，代价是两次读之间它会变。
 *
 * `decrypt` 那一句要 `Buffer.from(bytes)`：`ByteCipher.decrypt(bytes: Uint8Array)` 交出来的是
 * 普通 `Uint8Array`，而 `decryptString` 只认 Buffer —— 这是"类型过、运行不过"那一族（t9c 第 ② 段末预告的那发实测）。
 * `encryptString` 返回 Buffer（Buffer 是 `Uint8Array` 的子类），出去那一向不会犯。
 *
 * **没有 unit 格**：它唯一的真读者是 T11 的 `--persist-shot`（第 ⑦ 段的限度 ③）。
 */
const safeStorageCipher: ByteCipher = {
  get available() {
    return safeStorage.isEncryptionAvailable();
  },
  encrypt: (text) => safeStorage.encryptString(text),
  decrypt: (bytes) => safeStorage.decryptString(Buffer.from(bytes)),
};

/** 当前要送状态的窗口。S1 一个窗口一个工程（第 ⑩ 段），所以是一个，不是一张表。 */
let target: WebContents | null = null;
let session: ProjectSession | null = null;

/**
 * 会话之外那五条通道要的两样共用件：`userData` 目录（`config:*` 三条）与一份装配好的
 * `ProjectAdmin`（`project:list` / `project:create`）。
 *
 * 它与 `session` 分成两份是刻意的：会话有"当前开着哪个工程"这件事，而列表与向导**没有**，
 * 把两者塞进一个可空对象会得到"session 为 null 时 admin 是不是也为 null"这种没人能答的问题（P-22）。
 * `userDataDir` 走模块态而不是 `app.getPath` 就地调用，是因为 `dispatch` 是模块级函数，
 * 而 `app.getPath('userData')` 必须在 `whenReady` 之后 —— 同一个理由管 `registerPersistIpc` 的形状。
 */
let adminWiring: { readonly userDataDir: string; readonly admin: ProjectAdmin } | null = null;

function requireWiring(): { userDataDir: string; admin: ProjectAdmin } {
  if (adminWiring === null) {
    throw new SessionError('internal', '管理通道在 registerPersistIpc 之前被调用了：窗口比端口早到');
  }
  return adminWiring;
}

// —— 三条端口实现（session.ts 不认识 electron / fs / mysql2，全部从这里进来）——

/**
 * 迁移跑在**临时连接**上：一个 `.sql` 版本里是多条 DDL，只有迁移连接开 `multipleStatements`
 * （T2 在 `pool.ts` 的原话，P-17 又钉过那句注释"业务连接永远不开"不许删）。
 * 所以这里确实是两个池：迁完立刻 `end()` 掉那一个，留给会话的永远是不开多语句的这一份。
 *
 * 每次开工程都跑一遍 `migrate`：幂等（已应用的版本读校验和比对，一致就跳过），而 T9 的
 * 建库向导也跑同一条 —— 双跑无害。失败**原样上抛**：连接类失败由 session 包成 `'db'`，
 * 而迁移正文被改过那一抛是 `RangeError`，同样落进 `'db'`。码的口径是"去检查数据库那一侧"，
 * 这个场景下成立（配置指错库 / 迁移文件被改过，两边都是库那一侧的事）。
 *
 * 登记的限度（写进 Step 8 那一族）：T8 **不建库**。`dajia` 库不存在时这一发抛 `ER_BAD_DB_ERROR`
 * ⇒ `'db'`，文案带原话；建库是 T9 连接向导的职责（那也是本计划唯一行使建库授权的地方）。
 */
async function openDb(env: MysqlEnv, projectId: EntityId): Promise<DbHandle> {
  const migration = createDbPool(env, { multipleStatements: true });
  try {
    await migrate(migration, env.database);
  } finally {
    // 关掉迁移连接。**不**把它的失败盖在 migrate 的失败上：migrate 已经抛了就先让它抛，
    // 这里只保证一条 —— 抛出去的那个 `DbHandle` 一个都没留下，连接不漏。
    await migration.end().catch(() => undefined);
  }
  const pool = createDbPool(env);
  try {
    const repo = new ProjectRepository(pool, projectId, lockOwner());
    return { repo, raw: pool, end: () => pool.end() };
  } catch (err) {
    // 先关池再定码：仓库构造失败时池已经建好了（mysql2 的池是懒连接，但句柄在），
    // 不关就是每次重开漏一个池，漏到 connectionLimit 用尽时"连不上库"就不是配置错了，是我们漏的。
    await pool.end().catch(() => undefined);
    // 这一发只可能是仓库自己那把尺（`actor` 长度 1..64，`command_log.actor` 是 VARCHAR(64)）：
    // 池还没被用过，连接层不可能在这里说话。所以**就地定 'internal'**（我们的拼接错了），
    // 而不是让 session 把它包成默认的 'db' —— 那会把"屏幕上的 host:pid 太长"报成"去检查 MySQL 服务"。
    // 这正是 `session.ts` 里 `wrap` 那条"端口自己定了码 ⇒ 原样上抛"的直通通道在 T8 的真读者。
    throw new SessionError('internal', `仓库建不起来：${describeError(err)}`);
  }
}

/**
 * 拿票。`'busy'` 与 `'no-project'` 都返回 `null`（= 只读打开，第 ⑤ 段），**不抛**：
 * 那两种情形是"库里那一行让我只能读"，不是失败。各留一行日志，因为横幅上只显示"只读"，
 * 不显示为什么 —— 排查的人手里得有第二个来源。
 */
async function acquire(db: DbHandle, projectId: EntityId): Promise<LockHandle | null> {
  // 全仓仅此一次向下转型（`DbHandle.raw` 的注释里就写着这一条代价）：
  // session 那一侧必须不认识 Pool，否则 `persist/session.ts` 要 import mysql2，那 16 格就跑不进纯 node。
  const pool = db.raw as Pool;
  let ticket: LockTicket;
  try {
    ticket = newLockTicket({ projectId, owner: lockOwner() });
  } catch (err) {
    // 同样是"票还没拼出来，库一个字节都没动"：`newLockTicket` 那两把尺（projectId 形状 / owner ≤ 200）
    // 抛的是没有 `code` 的 `RangeError`，原样递到 session 会被 `persistErrorCode` 说成 `'reconcile'`
    // （"库里这份账不对，先别再写"）—— 那是把我们的拼接错误报成别人的账目问题。就地定 'internal'。
    throw new SessionError('internal', `锁票拼不出来：${describeError(err)}`);
  }
  const outcome = await acquireLock(pool, ticket);
  if (outcome !== 'acquired') {
    console.log(`[dajia] 锁没拿到（${outcome}），以只读打开工程 ${projectId}`);
    return null;
  }
  return {
    beat: () => heartbeat(pool, ticket),
    async release() {
      const result = await releaseLock(pool, ticket);
      if (result !== 'released') {
        // 'not-mine' = 锁已经被人接管。这不是"解锁失败"，是"我们已经没有那把锁了"：
        // 抛与不抛都是停手（引擎那边早按 'lost' 停了），但这句话必须留在 stdout，
        // 否则 T10 的双进程闸门红了只能看到"写不进去"。
        console.error(`[dajia] 解锁返回 ${result}：锁已被接管，等它自己过期`);
      }
    },
  };
}

/**
 * 事件方向的出站校验（③ 段：出站验值）。**不抛给引擎**：这一发跑在 `Autosave` 的 `onStatus` 钩子里，
 * 抛出会被 `drain` 当成"写库失败"记进 `lastError` —— 而坏掉的是我们的发送通路，不是数据库。
 * 宁可少报一次状态（横幅停在上一发，用户看得见它没动），也不谎报一次写失败。
 */
function emitStatus(status: SaveStatus): void {
  let wire: SaveStatusWire;
  try {
    wire = parseSaveStatus(SAVE_STATUS_EVENT, status);
  } catch (err) {
    console.error(`[dajia] 保存状态过不了自己的 schema：${describeError(err)}`);
    return;
  }
  if (target === null || target.isDestroyed()) return;
  target.send(SAVE_STATUS_EVENT, wire);
}

function writeEmergency(userDataDir: string, payload: EmergencyPayload): void {
  // 原样转交：`EmergencyInput` 比 `EmergencyPayload` 少一个 `patch`（抢救件保整份状态，T7 ⑨ 段），
  // 多余字段按结构赋值出局，这里不重组一份。
  const written = writeEmergencySnapshot(userDataDir, payload);
  if (!written.ok) {
    console.error(`[dajia] 抢救件没写成（${written.path ?? '路径也没算出来'}）：${written.error}`);
  }
}

// —— 分发：入站验请求、出站验值、错误码闭集 ——

/**
 * 会话之外的抛到这里为止。`SessionError` 是各步已经查清过的码，原样用；
 * `TypeError` 只有一个产地 —— protocol 那十个 `parse*` 出口（它们把 `ZodError` 收成一发 `TypeError`，
 * T3/T4 同一族），所以这一档就是"递来的东西形状不对" ⇒ `'bad-request'`。
 * 其余一律 `'internal'`：**默认档是"我们错了"，不是"归个类算了"**（③ 段：闭集里不留 `'unknown'` 的同一个理由）。
 *
 * 唯一的例外是**出站**那一发 `parseXValue`，它也抛 `TypeError` 却必须是 `'internal'` —— 所以它不换码，
 * 而是就地换成 `SessionError('internal', …)`（`parseOutbound`），这一档才不必靠上下文猜方向。
 *
 * 第三支是 T9 加的（P-39）：`ConfigError` 是"这份连接配置不能用"三种处境的合称（没配 / 读不出来 /
 * 这台机器存不了口令），它既不是屏幕递错了东西（`'bad-request'`），也不是我们拼错了包（`'internal'`），
 * 而用户此刻要做的三件事里第一件都是"回向导重填一次" —— 那正是 `'not-configured'` 这个码在 T8 的定义。
 * 三种处境不在码上分，在 `message` 与 `ConfigValue.state` 上分（那两个读者在屏幕上，而横幅读的是 message 原话）。
 */
function errorCode(err: unknown): PersistErrorCode {
  if (err instanceof SessionError) return err.code;
  if (err instanceof ConfigError) return 'not-configured';
  if (err instanceof TypeError) return 'bad-request';
  return 'internal';
}

function fail(code: PersistErrorCode, message: string, channel: IpcChannel): PersistFail {
  if (code === 'internal') {
    // 'internal' 的下一步动作是"人来查"，而查的人只有 stdout：这一码必须同时留原文（③ 段）。
    console.error(`[dajia] ${channel} 报了 internal：${message}`);
  }
  return { ok: false, code, message };
}
function requireSession(): ProjectSession {
  if (session === null) {
    throw new SessionError('internal', '持久化通道在 registerPersistIpc 之前被调用了：窗口比端口早到');
  }
  return session;
}

/** 出站再验一次：`TypeError` 在这里的含义是"main 自己把回包拼错了"，与入站那一档相反。 */
function parseOutbound<T>(
  channel: IpcChannel,
  value: unknown,
  parse: (where: string, raw: unknown) => T,
): T {
  try {
    return parse(channel, value);
  } catch (err) {
    throw new SessionError(
      'internal',
      `main 自己拼的 ${channel} 回包过不了自己的 schema：${describeError(err)}`,
    );
  }
}

/**
 * 屏幕递来的那一份文档会在 `session.submit` / `session.close` 里解码（`documentFromPayload`），
 * 抛的是裸 `TypeError`（重复 id）或 `RangeError`（core 的逐实体 validate）—— **不是** `SessionError`，
 * 因为那一族码归会话（`session.test.ts` 第 9 格钉的就是解码失败不吃号、也不被会话包码）。
 * 到这一层只剩一个问题可答：这一发出自屏幕，还是出自 main？答案固定是"屏幕" ⇒ 就地定 `'bad-request'`，
 * 别让 `errorCode` 的默认档把"用户递错东西"说成"我们拼错了包"。
 *
 * 代价照登记：这一发同时把 submit/close 里**其它**没包码的抛也说成 bad-request。已查过的形状是
 * 会话剩下的每一发都自己定了码（`open` 的四步、`close` 的 flush 与对账），所以剩下的可能只剩"没见过的 bug" ——
 * 它的 message 仍带 `describeError` 原话，T9 的诊断按文本分诊，不被码骗。
 */
async function askSession<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof SessionError) throw err;
    throw new SessionError('bad-request', `递来的文档解不开：${describeError(err)}`);
  }
}

async function dispatch(channel: IpcChannel, raw: unknown): Promise<IpcResult<unknown>> {
  try {
    switch (channel) {
      case IPC.projectOpen: {
        const req = parseOpenRequest(channel, raw);
        // `open` 里没有 inbound 文档解码（它只读库），所以不套 `askSession`：
        // 它的每一步失败都已经在 session 里定过码了。
        const value = parseOutbound(channel, await requireSession().open(req.projectId), parseOpenValue);
        return { ok: true, value };
      }
      case IPC.journalSubmit: {
        const req = parseSubmitRequest(channel, raw);
        const reply = await askSession(() => requireSession().submit(req));
        return { ok: true, value: parseOutbound(channel, reply, parseSubmitValue) };
      }
      case IPC.projectClose: {
        const req = parseCloseRequest(channel, raw);
        const reply = await askSession(() => requireSession().close(req));
        return { ok: true, value: parseOutbound(channel, reply, parseCloseValue) };
      }
      case IPC.configRead: {
        // 空表请求（`ConfigReadRequestSchema`）在这一发唯一的价值是让"每条通道都过自己的请求表"
        // 这句全称命题不需要特例（t9a 第 ① 段末）。它没有返回值可用，所以不接住 ——
        // `parseConfigReadRequest` 的抛就是这一发要的抛。
        parseConfigReadRequest(channel, raw);
        const { userDataDir } = requireWiring();
        // `probeConfig` **永不抛**：「还没配」是首屏要显示的常态，不是失败（第 ⑦ 段那条分工）。
        const value = parseOutbound(
          channel,
          probeConfig(userDataDir, safeStorageCipher),
          parseConfigValue,
        );
        return { ok: true, value };
      }
      case IPC.configSave: {
        const req = parseConfigSaveRequest(channel, raw);
        const { userDataDir } = requireWiring();
        // `writeConfig` 的抛有三种：`ConfigError('unavailable')`（这台机器存不了）走改动 4 那一支；
        // `ConfigRecordSchema.parse` 的 `TypeError` 走 `'bad-request'`；fs 的抛走默认档 `'internal'`
        // —— 那一条是对的，因为"写不进去"确实是我们要查的（磁盘、权限、路径）。
        const value = parseOutbound(
          channel,
          writeConfig(userDataDir, safeStorageCipher, req.connection),
          parseConfigValue,
        );
        return { ok: true, value };
      }
      case IPC.configTest: {
        const req = parseConfigTestRequest(channel, raw);
        // 试连吃的是**屏幕上那份草稿**，不是盘上存过的那一份（口径 ⑤ 的另一半：用户在改 host
        // 之后点「测试连接」，测的必须是他刚敲进去的那串）。`buildDraftEnv` 把库名钉成 `'dajia'`。
        // `probeConnection` **自己不抛**（t9d 第 ① 段末），所以这一发只有 `parseOutbound` 会抛。
        const value = parseOutbound(
          channel,
          await probeConnection(buildDraftEnv(req.connection), probeOpener),
          parseConnectionTestValue,
        );
        return { ok: true, value };
      }
      case IPC.projectList: {
        parseProjectListRequest(channel, raw);
        const { admin } = requireWiring();
        const value = parseOutbound(channel, await admin.list(), parseProjectListValue);
        return { ok: true, value };
      }
      case IPC.projectCreate: {
        const req = parseProjectCreateRequest(channel, raw);
        const { admin } = requireWiring();
        const value = parseOutbound(channel, await admin.create(req.name), parseProjectCreateValue);
        return { ok: true, value };
      }
      default:
        // 名册与 switch 漂开时（加了通道没写 case）必须报"我们错了"，而不是 `undefined` 回包 ——
        // `ipc-channels.test.ts` 第 1 格也钉这一句，但那一格扫的是文本，这一句兜的是运行时。
        throw new SessionError('internal', `没有给通道 ${channel} 写过 case`);
    }
  } catch (err) {
    // 唯一的出口收窄点：任何异常都不许跨过 IPC（`invoke` 的 reject 到屏幕侧只是一个 Error，码与
    // 下一步动作全丢）。`describeError` 会读 `err.code`，所以 `SessionError` 的 message 长成
    // `SessionError(db): 连不上库：…` —— 前缀与 `code` 字段重复是**有意的**：横幅读字段，日志读文本。
    return fail(errorCode(err), describeError(err), channel);
  }
}

/**
 * 注册持久化通道。**必须在 `app.whenReady()` 之后**（`app.getPath('userData')` 的那条规矩）。
 * 形状照盘上现物那条 `ping`：`removeHandler` + `handle` 成对 ⇒ 重建窗口（`activate` 那一支）不残留旧 handler。
 * 没有 `before-quit` 握手（第 ⑦ 段：那一整块归 T11），所以关窗不会自动收尾 —— 锁等 TTL 过期，
 * 最后那次快照缺席 ⇒ 下次打开 `wasCleanShutdown === false`，那正是 spec §9 要人看见的恢复路径。
 */
export function registerPersistIpc(win: BrowserWindow): void {
  target = win.webContents;
  const userDataDir = app.getPath('userData');
  // 配置源换血（P-27 的生产侧落点）：环境变量那一套从此只属于 `pnpm test:db` 与闸门夹具，
  // 应用只认 `userData/connection.bin` 那份密文。这一发是惰性的闭包 —— 装端口的时候不读盘，
  // 于是"没配"这件事只在用户真的要点开一个工程 / 刷新一次列表时才说话（第 ② 段末那条时序）。
  const loadConfig = (): MysqlEnv => configToEnv(readConfig(userDataDir, safeStorageCipher));
  // `ProjectAdmin` 与 `probeOpener` 各装配一次，随 `registerPersistIpc` 活（t9d 交接末句的那件事：
  // `ports` 里没有请求级状态，而 `redact` 的 `Set` 与 `firstStoreyTurn` 都是纯函数，
  // 每次请求新建一份只会让"重建窗口"那一族 bug 多一个可变因素）。
  const adminPorts = makeAdminPorts({ loadConfig, actor: lockOwner });
  adminWiring = { userDataDir, admin: new ProjectAdmin(adminPorts) };
  const ports: PersistPorts = {
    userDataDir,
    timer: realTimer,
    loadConfig,
    openDb,
    acquire,
    readEmergency: listEmergency,
    writeEmergency: (payload) => writeEmergency(userDataDir, payload),
    emitStatus,
  };
  session = new ProjectSession(ports);
  for (const channel of INVOKE_CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (_event, raw: unknown) => dispatch(channel, raw));
  }
}
