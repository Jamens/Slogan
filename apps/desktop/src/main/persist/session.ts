import type { Document, EntityId, Patch } from '@dajia/core';
import {
  IPC,
  type CloseRequest,
  type CloseValue,
  type EmergencyRef,
  type OpenDecision,
  type OpenValue,
  type PersistErrorCode,
  type SubmitRequest,
  type SubmitValue,
} from '@dajia/protocol';
import type { MysqlEnv } from '../db/env';
import type { CloseReport, LoadOutcome, OpenIntent } from '../db/repository';
import { documentFromPayload, payloadFromDocument } from '../../shared/document-wire';
import {
  Autosave,
  type EmergencyPayload,
  type JournalSink,
  type SaveStatus,
  type SaveTimer,
  type TimerHandle,
} from './autosave';
import { describeError } from './describe-error';

/**
 * 收尾 flush 的时间上限。**唯一读者是 `close` 里那一发 `withTimeout`**：MySQL 不可达时 `flush()`
 * 挂在重试链上，而窗口在等这次收尾放行 —— 没有上限，"关闭工程"这个动作就没有出口。
 * 为什么不是 `LOCK_TTL_MS` 那种共享常量：那两个数没有同源的理由，硬凑一个名字反而误导（T7 口径）。
 */
export const CLOSE_FLUSH_TIMEOUT_MS = 10_000;

/** 会话侧看得见的仓库。`ProjectRepository` 恰好满足它，两边都不 import 对方的类（T7 的 `JournalSink` 同族做法）。 */
export interface SessionRepo extends JournalSink {
  loadProject(intent: OpenIntent): Promise<LoadOutcome>;
  closeProject(doc: Document): Promise<CloseReport>;
}

export interface DbHandle {
  readonly repo: SessionRepo;
  /**
   * 连接本体的**不透明把手**：session 一个字段都不读它，只在 `acquire(db, …)` 那一发原样递回去。
   * 为什么是 `unknown` 而不是 `Pool`：`PersistPorts` 是 electron-free / mysql-free 的那道边界
   * （P-2 同一把尺），把 `Pool` 写进来就会逼 `persist/session.ts` import mysql2，而那 16 格全跑在纯 node 里。
   * 代价：`ipc-persist.ts` 取回它时要一次向下转型（`db.raw as Pool`）—— 全仓仅此一处，写在它自己的注释里。
   */
  readonly raw: unknown;
  end(): Promise<void>;
}

/** 票已经拿到手之后剩下的两件事。心跳的**调度**不在这里（引擎自己按 `LOCK_HEARTBEAT_INTERVAL_MS` 排）。 */
export interface LockHandle {
  beat(): Promise<'renewed' | 'lost'>;
  release(): Promise<void>;
}

/**
 * 会话的全部外部依赖。`owner`（`机器名:pid`）与 `newLockTicket` 都不在这里：拼票是 `ipc-persist.ts`
 * 的事，session 连 `node:os` 都不许碰（P-2 + `persist-boundary.test.ts` 那一格）。
 */
export interface PersistPorts {
  readonly userDataDir: string;
  readonly timer: SaveTimer;
  /** 没配好就抛（T8 的实现读环境变量）。抛 ⇒ `'not-configured'`，且**不建连接**。 */
  loadConfig(): MysqlEnv;
  openDb(env: MysqlEnv, projectId: EntityId): Promise<DbHandle>;
  /** `null` = 没拿到（`'busy'` 或 `'no-project'`）⇒ 只读打开（第 ⑤ 段）。 */
  acquire(db: DbHandle, projectId: EntityId): Promise<LockHandle | null>;
  readEmergency(userDataDir: string, projectId: EntityId): EmergencyRef[];
  /** 原样转交：session 不数件、不碰 fs，"抢救过几份"这件事的读者是下一次 `open` 的 `readEmergency`。 */
  writeEmergency(payload: EmergencyPayload): void;
  emitStatus(status: SaveStatus): void;
}

export class SessionError extends Error {
  constructor(
    readonly code: PersistErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

/**
 * 一条规则，不是两个调用点（第 ③ 段）。mysql2 抛的错一律带 `code`（`ER_*` / `PROTOCOL_CONNECTION_LOST`
 * / `ECONNREFUSED`）⇒ `'db'`，下一步是"查服务"；不带 `code` 的都是我们自己抛的
 * （T5 的三方对账不平、T5 的 `loadProject` 拒开、T4 的归属守卫）⇒ `'reconcile'`，下一步是"先别再写"。
 */
function persistErrorCode(err: unknown): PersistErrorCode {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && code.length > 0 ? 'db' : 'reconcile';
}

/**
 * 各步失败的统一包装：**端口自己已经定了码 ⇒ 原样上抛**，其余的按"这一步默认是什么错"包一层。
 * 为什么需要这一条：`openDb` 里会顺手校验 `actor` 长度（T4 的仓库尺），那一发不是"连不上库"；
 * T9 的 `loadConfig` 会区分"没配"与"解不开已存的配置"。没有这条通道，端口只能把已经查清的结论
 * 降级成一个 `RangeError`，再被下一步的默认码重新解释一遍 —— 那是把事实丢了两次。
 */
function wrap(err: unknown, code: PersistErrorCode, prefix: string): SessionError {
  return err instanceof SessionError ? err : new SessionError(code, `${prefix}：${describeError(err)}`);
}

/**
 * 给 `flush()` 套上限。超时**不取消** `flush`（Promise 取消不了，队列也还在跑），只是让调用方能立刻拆会话：
 * `stop()` 撤掉链上的定时器，`db.end()` 掐了在途连接。
 * 返回 `null` 而不是抛一个自定义 Error：一支路一个形状，读的人不必先认识一个新类型。
 */
async function withTimeout(
  promise: Promise<SaveStatus>,
  ms: number,
  timer: SaveTimer,
): Promise<SaveStatus | null> {
  let handle: TimerHandle | undefined;
  const timeout = new Promise<null>((resolve) => {
    // executor 是同步跑的，所以这里 `handle` 一定有值 —— 但 TS 看不见这件事，故用 `?.`。
    handle = timer.schedule(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    handle?.cancel();
  }
}

/**
 * 一个窗口 ↔ 一个工程 ↔ 一份会话（spec §4.3，第 ⑩ 段）。
 * main 不持文档（P-9）：这里的 `Document` 全是**借来的** —— `open` 从仓库借一份发给屏幕，
 * `submit`/`close` 从屏幕借一份交给引擎/对账，每个方法返回时一个都不留在字段上。
 */
export class ProjectSession {
  private db: DbHandle | null = null;
  private lock: LockHandle | null = null;
  private autosave: Autosave | null = null;
  private projectId: EntityId | null = null;
  private openDecision: OpenDecision = 'read-only';
  /**
   * 已经**发出去**的号，不是已经落盘的号（第 ① 段）。为什么不能读 `autosave.status().lastTurn`：
   * 那一个字段是 `landedTurn`，队列里排上但还没写完的发在它上面看不见 ⇒ 下一发会拿到重复的号，
   * 而重复号在 `uk_project_turn` 那条支路上被吞成 `already-applied` = 静默丢失。
   */
  private issuedTurn = 0;

  constructor(private readonly ports: PersistPorts) {}

  get active(): boolean {
    return this.projectId !== null;
  }

  /** 没有会话 ⇒ `null`，而不是猜一个默认值：横幅与 `reopenAsEdit` 都要能区分"没开"和"开成只读"。 */
  get decision(): OpenDecision | null {
    return this.projectId === null ? null : this.openDecision;
  }

  status(): SaveStatus | null {
    return this.autosave?.status() ?? null;
  }

  async open(projectId: EntityId): Promise<OpenValue> {
    if (this.projectId !== null) {
      throw new SessionError('session', `会话已经开在工程 ${this.projectId} 上：先关再开（第 ⑩ 段）`);
    }
    let env: MysqlEnv;
    try {
      env = this.ports.loadConfig();
    } catch (err) {
      // 这一支**没有** try 里的 teardown：此刻一个资源都没拿到手，多拆一次就会把"谁分配了谁释放"搅浑。
      throw wrap(err, 'not-configured', '连接配置读不出来');
    }
    let db: DbHandle;
    try {
      db = await this.ports.openDb(env, projectId);
    } catch (err) {
      throw wrap(err, 'db', '连不上库');
    }
    // 状态先落地再往下走：下面任何一步抛，都按同一套顺序拆（`teardown` 只认字段，不认参数）。
    this.db = db;
    this.projectId = projectId;
    let lock: LockHandle | null;
    try {
      lock = await this.ports.acquire(db, projectId);
    } catch (err) {
      await this.teardown();
      throw wrap(err, persistErrorCode(err), '拿锁这一发本身坏了');
    }
    // 票一到手就把状态落地（brief 原块把这一行放在 `loadProject` 之后，格 3 的判据要求
    // 读盘失败时 `teardown` 能把刚拿到的票放回去 —— 放在后面就会漏放，格 3 必读成假绿之外的真红）：
    // 下面任何一步抛，都按同一套顺序拆（`teardown` 只认字段，不认参数）。
    this.lock = lock;
    const intent: OpenIntent = lock === null ? 'read' : 'edit';
    let loaded: LoadOutcome;
    try {
      loaded = await db.repo.loadProject(intent);
    } catch (err) {
      await this.teardown();
      throw wrap(err, persistErrorCode(err), '读不出这份工程');
    }
    this.openDecision = lock === null ? 'read-only' : 'edit';
    this.issuedTurn = loaded.header.journalTurn;
    if (lock !== null) {
      this.autosave = new Autosave({
        sink: db.repo,
        timer: this.ports.timer,
        beat: () => lock.beat(),
        onStatus: (status) => this.ports.emitStatus(status),
        onEmergency: (payload) => this.ports.writeEmergency(payload),
        fromJournal: {
          lastTurn: loaded.header.journalTurn,
          snapshotTurn: loaded.snapshot?.turn ?? null,
          rowsSinceSnapshot: loaded.header.journalTurn - (loaded.snapshot?.turn ?? 0),
        },
      });
    }
    return {
      decision: this.openDecision,
      header: loaded.header,
      doc: payloadFromDocument(loaded.doc),
      snapshot: loaded.snapshot,
      replayed: loaded.replayed,
      emergency: this.ports.readEmergency(this.ports.userDataDir, projectId),
    };
  }

  submit(req: SubmitRequest): SubmitValue {
    const autosave = this.autosave;
    const projectId = this.projectId;
    if (autosave === null || projectId === null) {
      throw new SessionError('session', '这个会话是只读的（或已经关了）：屏幕上的改动不会进库');
    }
    if (req.projectId !== projectId) {
      throw new SessionError('session', `这发记在工程 ${req.projectId} 名下，会话开的是 ${projectId}`);
    }
    const state = autosave.status();
    if (state.phase === 'paused') {
      throw new SessionError(
        'session',
        `已经停写（${state.pauseReason ?? '原因未知'}）：请重开工程，不要在同一会话里续写（第 ⑤ 段）`,
      );
    }
    if (state.phase === 'stopped') {
      throw new SessionError('session', '保存引擎已停：这个会话正在收尾');
    }
    // 先解码，后取号。反过来 = 一个坏请求吃掉一个号 ⇒ 下一发 `appendJournal` 从此撞"跳号"永久拒收。
    const doc = documentFromPayload(req.doc, `IPC ${IPC.journalSubmit}`);
    if (doc.projectId !== projectId) {
      throw new SessionError(
        'session',
        `递来的文档签在 ${doc.projectId}，会话开的是 ${projectId}：一份状态不能同时是两个工程的现场`,
      );
    }
    // 这一行是**编译期**那道牙（T4 的 `decodePatch` 同一个写法）：`PatchShape → Patch` 漂了，
    // `tsc -p apps/desktop/tsconfig.json` 当场红，不用等运行时。
    const patch: Patch = req.patch;
    const turn = this.issuedTurn + 1;
    this.issuedTurn = turn;
    const outcome = autosave.submit({ turn, patch, doc });
    return { outcome, acceptedTurn: turn };
  }

  async close(req: CloseRequest): Promise<CloseValue> {
    const projectId = this.projectId;
    const db = this.db;
    if (projectId === null || db === null) {
      throw new SessionError('session', '没有开着的会话：这一发没有可收尾的账');
    }
    if (req.projectId !== projectId) {
      throw new SessionError('session', `要关的工程是 ${req.projectId}，会话开的是 ${projectId}`);
    }
    const autosave = this.autosave;
    if (req.mode === 'abandon' || autosave === null) {
      // 只读会话与 `abandon` 走同一条路：不 flush、不对账、**不写 `clean_shutdown`**（第 ⑤ 段）。
      // 只读那一支要是跑了 `closeProject`，就等于替上一个编辑者宣告"这库干净"，那是撒谎。
      await this.teardown();
      return { elementRows: null, storeyRows: null };
    }
    const doc = documentFromPayload(req.doc, `IPC ${IPC.projectClose}`);
    if (doc.projectId !== projectId) {
      throw new SessionError('session', `收尾递来的文档签在 ${doc.projectId}，会话开的是 ${projectId}`);
    }
    let drained: SaveStatus | null;
    try {
      drained = await withTimeout(autosave.flush(), CLOSE_FLUSH_TIMEOUT_MS, this.ports.timer);
    } catch (err) {
      // 引擎本该把库错吞进 `lastError`（T7 ⑨ 段），所以走到这里要么是接线错要么是链上漏了抛：
      // 码按同一条规则给，但**必须**拆会话 —— 不留半开的锁与池。
      await this.teardown();
      throw wrap(err, persistErrorCode(err), '收尾 flush 直接抛了');
    }
    if (drained === null) {
      await this.teardown();
      throw new SessionError(
        'db',
        `收尾 flush 在 ${CLOSE_FLUSH_TIMEOUT_MS}ms 内没跑完：最后几发没落，跳过对账（不等下去会把窗口卡死）`,
      );
    }
    if (drained.queuedTurns > 0 || drained.phase === 'paused') {
      await this.teardown();
      throw new SessionError(
        drained.phase === 'paused' ? 'session' : 'db',
        `还有 ${drained.queuedTurns} 发没进库（${drained.lastError ?? '无更多信息'}）：这次收尾不对账 —— ` +
          `库里缺最后几发时，文档↔element 必然不平，跑了只会把"没落盘"说成"账坏了"`,
      );
    }
    let report: CloseReport;
    try {
      // 顺序是**先对账再放锁**：反过来会给另一个人留出"我刚写完、他还没对账"的窗口。
      report = await db.repo.closeProject(doc);
    } catch (err) {
      await this.teardown();
      throw wrap(err, persistErrorCode(err), '收尾对账没过');
    }
    await this.teardown();
    return { elementRows: report.elementRows, storeyRows: report.storeyRows };
  }

  /**
   * 唯一的拆卸口：先拆引擎（它的 idle / retry / beat 三个定时器还在排），再放锁，最后关池。
   * 顺序不许改 —— 反过来就留下"锁还在、但已经没人管队列"的那一刻，而 `beat` 会拿着已释放的票去续期。
   * 解锁与关池的失败**只记不抛**：锁会自己过期（T6 的 `LOCK_TTL_MS`），而这一发的结论已经定了。
   */
  private async teardown(): Promise<void> {
    const autosave = this.autosave;
    const lock = this.lock;
    const db = this.db;
    this.autosave = null;
    this.lock = null;
    this.db = null;
    this.projectId = null;
    this.openDecision = 'read-only';
    this.issuedTurn = 0;
    const stopped = autosave?.stop();
    try {
      await lock?.release();
    } catch (err) {
      console.error(`[dajia] 解锁失败，等它自己过期：${describeError(err)}`);
    }
    try {
      await db?.end();
    } catch (err) {
      console.error(`[dajia] 连接池没关掉：${describeError(err)}`);
    }
    if (stopped !== undefined) this.ports.emitStatus(stopped);
  }
}
