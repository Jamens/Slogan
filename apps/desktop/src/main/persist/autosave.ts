import type { Document, EntityId, Patch } from '@dajia/core';
import { LOCK_HEARTBEAT_INTERVAL_MS } from '../db/locks';
import type { JournalEntry, JournalOutcome } from '../db/repository';
import { describeError } from './describe-error';

/** spec §8.2 原话之「每 2000 条命令」。计数器是 `rowsSinceSnapshot`，不是 `seq`（裁决 P-6）。 */
export const SNAPSHOT_EVERY_ROWS = 2000;
/** spec §8.2 原话之「连续 60 秒无编辑」。两者先到即合并出新 snapshot。 */
export const IDLE_SNAPSHOT_MS = 60_000;
/** spec §9 的"持续重试"落成的重试间隔。它是引擎自己的口径，spec 没给数字，改这里要说得出理由。 */
export const RETRY_DELAY_MS = 2_000;

/**
 * 时钟与定时器的唯一注入点（裁决 P-2 的口径：能进 node 测试的东西才有人测）。
 * 把手只许原样交回，不许拆开看 —— 假钟与真钟各自决定内部形状。
 */
export interface TimerHandle {
  readonly cancel: () => void;
}

export interface SaveTimer {
  now(): number;
  schedule(onDue: () => void, ms: number): TimerHandle;
}

export const realTimer: SaveTimer = {
  now: () => Date.now(),
  schedule: (onDue, ms) => {
    const handle = setTimeout(onDue, ms);
    return { cancel: () => clearTimeout(handle) };
  },
};

export interface JournalSink {
  appendJournal(entry: JournalEntry): Promise<JournalOutcome>;
  writeSnapshot(turn: number, doc: Document): Promise<void>;
}

export interface EmergencyPayload {
  readonly projectId: EntityId;
  readonly turn: number;
  readonly error: string;
  readonly doc: Document;
  readonly patch: Patch;
}

export type AutosavePhase = 'idle' | 'saving' | 'failed' | 'paused' | 'stopped';

/**
 * UI 能看见的全部事实（T8 的横幅只读这一个形状）。
 * `lastError` 是**最后一次**失败的原话，成功一发就清空 —— 它同时是红条的显示条件，
 * 所以"红条一直挂着"这种烦人形态由清空这一句负责消。
 */
export interface SaveStatus {
  readonly phase: AutosavePhase;
  readonly queuedTurns: number;
  readonly lastTurn: number | null;
  readonly snapshotTurn: number | null;
  readonly rowsSinceSnapshot: number;
  readonly lastError: string | null;
  readonly pauseReason: string | null;
}

export interface AutosaveOptions {
  readonly sink: JournalSink;
  readonly timer?: SaveTimer;
  readonly snapshotEveryRows?: number;
  readonly idleSnapshotMs?: number;
  readonly retryDelayMs?: number;
  /** 与工程锁对话的那一发（T6 的 `heartbeat(pool, ticket)`）；不给就不起心跳循环。 */
  readonly beat?: () => Promise<'renewed' | 'lost'>;
  readonly onStatus?: (status: SaveStatus) => void;
  /** 落盘出口（T8 把它接到 `emergency.ts`）；引擎自己不许碰 fs（裁决 P-2/P-10）。 */
  readonly onEmergency?: (payload: EmergencyPayload) => void;
  /**
   * 从库里读回来的起点（T8 用 `loadProject` 的读数填）：`lastTurn` = `header.journalTurn`、
   * `snapshotTurn` = `snapshot?.turn ?? null`、`rowsSinceSnapshot` = `journalTurn - (snapshot?.turn ?? 0)`。
   * 不传 = 新工程从零数。不读这一份起点，"每 2000 条"这句话在重启之后就失守了 —— 阈值会从 0 重数。
   */
  readonly fromJournal?: {
    readonly lastTurn: number;
    readonly snapshotTurn: number | null;
    readonly rowsSinceSnapshot: number;
  };
}

function requirePositiveInt(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} 必须是 >=1 的安全整数，收到 ${String(value)}：0 或负数会让判定每发都触发或永不触发`);
  }
  return value;
}

function requireNonNegInt(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} 必须是 >=0 的安全整数，收到 ${String(value)}`);
  }
  return value;
}

/**
 * 保存引擎（electron-free、fs-free）：renderer 每发成功后经 IPC 投过来，这里负责
 * 串行落库、按 spec §8.2 的两条阈值合并快照、失败重试与抢救、以及"锁没了就停手"。
 *
 * 三条不可见的纪律，改代码前先读：
 * 1. **所有异步活都接在同一条 `chain` 上**（含定时器回调）。于是 `settled()` 是唯一的可靠等待点，
 *    而 `flush()` 与 24 格单测都靠它。`chain` 必须永不 reject —— 它没有 catch 支路，
 *    一次漏出的 rejection 就是进程级 unhandled rejection。
 * 2. **队首失败就停**（`drain` 里的 `break`）：turn 有序，后发先至会在账上留洞，
 *    而缺号在 T5 是"拒开"级别的损坏（尾缺/中缺两位证人）。
 * 3. **引擎不猜库里的账**：`rowsSinceSnapshot` 的起点由 `fromJournal` 给，之后只按 sink 的
 *    返回值推进（`already-applied` 不加，T7 ④ 段）。
 */
export class Autosave {
  private readonly sink: JournalSink;
  private readonly timer: SaveTimer;
  private readonly snapshotEveryRows: number;
  private readonly idleSnapshotMs: number;
  private readonly retryDelayMs: number;
  private readonly beat: (() => Promise<'renewed' | 'lost'>) | undefined;
  private readonly onStatus: ((status: SaveStatus) => void) | undefined;
  private readonly onEmergency: ((payload: EmergencyPayload) => void) | undefined;

  /** 待落库的投递，按 turn 递增。队首失败时它不移动（纪律 2）。 */
  private readonly pending: JournalEntry[] = [];
  /** 已经抢救过的 turn（T7 ⑦ 段）：重试不重新写盘。 */
  private readonly rescuedTurns = new Set<number>();
  private chain: Promise<void> = Promise.resolve();
  private pumping = false;
  /** 停写的原因；null = 允许写。T6 的 `'lost'` 与 T8 的人工只读都落在这里。 */
  private paused: string | null = null;
  private stopped = false;
  /** 投递过的最大 turn（不管落没落库）：重复投递的守卫用它，不是 `landedTurn`。 */
  private maxSeenTurn: number;
  /** 已落库的最大 turn。 */
  private landedTurn: number | null;
  /** 最后一发落地后的文档：收尾快照与抢救都用它（T7 ③ 段的成本就在这里）。 */
  private lastDoc: Document | null = null;
  private snapshotTurn: number | null;
  private rowsSinceSnapshot: number;
  private lastError: string | null = null;
  private idleHandle: TimerHandle | null = null;
  private retryHandle: TimerHandle | null = null;
  private beatHandle: TimerHandle | null = null;

  constructor(options: AutosaveOptions) {
    this.sink = options.sink;
    this.timer = options.timer ?? realTimer;
    this.snapshotEveryRows = requirePositiveInt(
      options.snapshotEveryRows ?? SNAPSHOT_EVERY_ROWS,
      'snapshotEveryRows',
    );
    this.idleSnapshotMs = requirePositiveInt(options.idleSnapshotMs ?? IDLE_SNAPSHOT_MS, 'idleSnapshotMs');
    this.retryDelayMs = requirePositiveInt(options.retryDelayMs ?? RETRY_DELAY_MS, 'retryDelayMs');
    this.beat = options.beat;
    this.onStatus = options.onStatus;
    this.onEmergency = options.onEmergency;
    const start = options.fromJournal;
    if (start) {
      this.landedTurn = requirePositiveInt(start.lastTurn, 'fromJournal.lastTurn');
      this.maxSeenTurn = start.lastTurn;
      this.snapshotTurn = start.snapshotTurn;
      this.rowsSinceSnapshot = requireNonNegInt(start.rowsSinceSnapshot, 'fromJournal.rowsSinceSnapshot');
      if (start.snapshotTurn !== null) requirePositiveInt(start.snapshotTurn, 'fromJournal.snapshotTurn');
    } else {
      this.landedTurn = null;
      this.maxSeenTurn = 0;
      this.snapshotTurn = null;
      this.rowsSinceSnapshot = 0;
    }
    if (this.rowsSinceSnapshot > 0 && this.snapshotTurn !== null && this.landedTurn !== null && this.snapshotTurn > this.landedTurn) {
      throw new TypeError(
        `fromJournal 自相矛盾：快照在 turn ${String(this.snapshotTurn)}，却只写到 turn ${String(this.landedTurn)}`,
      );
    }
    if (this.beat) this.scheduleBeat();
  }

  /** 投递一发（IPC handler 里唯一该调的入口）。返回 `ignored-duplicate` 而不是抛：重放不该打死主进程。 */
  submit(entry: JournalEntry): 'queued' | 'ignored-duplicate' {
    if (this.stopped) {
      throw new Error('Autosave 已 stop()：关掉窗口之后不许再排新的一发（这是接线错误，不是库故障）');
    }
    if (!Number.isSafeInteger(entry.turn) || entry.turn < 1) {
      throw new TypeError(
        `turn 必须是 >=1 的安全整数，收到 ${String(entry.turn)}：账目的幂等键没有"第 0 发"，也没有小数发`,
      );
    }
    if (entry.turn <= this.maxSeenTurn) {
      this.lastError = `忽略 turn ${entry.turn}：已经投递到 ${this.maxSeenTurn}，turn 必须严格递增`;
      this.report();
      return 'ignored-duplicate';
    }
    this.maxSeenTurn = entry.turn;
    this.pending.push(entry);
    // 有新活就撤空闲定时器：60 秒的钟是给"没有新编辑"计时的（「空闲计时随新编辑重置」那一格钉的就是它）。
    this.cancelIdle();
    this.kick();
    this.report();
    return 'queued';
  }

  /**
   * 把当前排上的活跑完，再尽力补一份收尾快照。**不等定时器**（T8 自己给它套超时），
   * 也**不保证写完**：库真不可达时它写不完，那就如实报 `failed` + `queuedTurns`（「flush 在库不可达时如实报 failed」那一格）。
   */
  async flush(): Promise<SaveStatus> {
    await this.settled();
    for (;;) {
      if (this.stopped || this.paused !== null) break;
      const turn = this.landedTurn;
      const doc = this.lastDoc;
      if (turn === null || doc === null || !this.needsSnapshot()) break;
      const before = this.snapshotTurn;
      await this.trySnapshot(turn, doc);
      await this.settled();
      // 没写成（失败或被跳过）就停：原地打转会把 flush 变成又一个重试循环。
      if (this.snapshotTurn === before) break;
    }
    return this.status();
  }

  pause(reason: string): void {
    if (this.paused !== null) return;
    this.paused = reason;
    this.cancelIdle();
    this.cancelRetry();
    this.report();
  }

  /** T8 重新拿到锁之后调：把停写期间憋着的队列补上，心跳链也接回来。 */
  resume(): void {
    if (this.paused === null) return;
    this.paused = null;
    this.kick();
    this.scheduleBeat();
    this.armIdle();
    this.report();
  }

  /**
   * 拆掉所有定时器。欠款非空时**不抛**（抛了会把关窗流程打断），只在 `lastError` 里说清还剩几发 ——
   * 那一句是给 T11 的闸门读的：`--persist-shot` 要能看见"关窗前没 flush 干净"这个形状。
   */
  stop(): SaveStatus {
    if (!this.stopped) {
      this.stopped = true;
      this.cancelIdle();
      this.cancelRetry();
      if (this.beatHandle !== null) {
        this.beatHandle.cancel();
        this.beatHandle = null;
      }
      if (this.pending.length > 0) {
        const head = this.pending[0];
        this.lastError = `stop() 时仍有 ${this.pending.length} 发未落盘（队首 turn ${head ? String(head.turn) : '?'}）：关窗前的 flush 没走完`;
      }
      this.report();
    }
    return this.status();
  }

  status(): SaveStatus {
    const phase: AutosavePhase = this.stopped
      ? 'stopped'
      : this.paused !== null
        ? 'paused'
        : this.lastError !== null
          ? 'failed'
          : this.pending.length > 0
            ? 'saving'
            : 'idle';
    return {
      phase,
      queuedTurns: this.pending.length,
      lastTurn: this.landedTurn,
      snapshotTurn: this.snapshotTurn,
      rowsSinceSnapshot: this.rowsSinceSnapshot,
      lastError: this.lastError,
      pauseReason: this.paused,
    };
  }

  /** 等 `chain` 上的活排空：定时器要先把钟拨到点才会接进链，所以它不等"未来"，只不等"已排上的活"。 */
  async settled(): Promise<void> {
    for (;;) {
      const tail = this.chain;
      await tail;
      if (this.chain === tail) return;
    }
  }

  private kick(): void {
    if (this.pumping || this.stopped || this.paused !== null || this.pending.length === 0) return;
    this.pumping = true;
    this.chain = this.chain.then(() => this.drain());
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending.length > 0 && this.paused === null && !this.stopped) {
        const head = this.pending[0];
        if (!head) break;
        try {
          const outcome = await this.sink.appendJournal(head);
          this.pending.shift();
          this.landedTurn = head.turn;
          this.lastDoc = head.doc;
          if (outcome === 'applied') this.rowsSinceSnapshot += 1;
          this.lastError = null;
          this.report();
          if (this.rowsSinceSnapshot >= this.snapshotEveryRows) {
            await this.trySnapshot(head.turn, head.doc);
          }
        } catch (err) {
          this.lastError = describeError(err);
          this.rescue(head);
          this.report();
          this.scheduleRetry();
          break;
        }
      }
    } finally {
      // `report()` 里的回调若抛错也不能把 `pumping` 卡在 true（那会永久停住队列）。
      this.pumping = false;
      if (!this.stopped && this.paused === null) this.armIdle();
      this.report();
    }
  }

  /**
   * 快照那一发。`turn <= snapshotTurn` 是**跳过**，不是失败（T7 ⑤ 段：引擎的记性防自伤，
   * 库的 `UNIQUE` 防"将来有人把记性删了"，两边各管一头）。
   */
  private async trySnapshot(turn: number, doc: Document): Promise<boolean> {
    if (this.snapshotTurn !== null && turn <= this.snapshotTurn) return true;
    try {
      await this.sink.writeSnapshot(turn, doc);
      this.snapshotTurn = turn;
      this.rowsSinceSnapshot = 0;
      this.lastError = null;
      this.report();
      return true;
    } catch (err) {
      this.lastError = `快照 turn ${String(turn)} 失败：${describeError(err)}`;
      this.report();
      return false;
    }
  }

  /** 库里还欠着行数（或上一份快照没写成）才需要排空闲定时器 —— 否则 60 秒就是空转（「没有新行就不许空转」那一格）。 */
  private needsSnapshot(): boolean {
    if (this.lastDoc === null || this.landedTurn === null) return false;
    if (this.rowsSinceSnapshot === 0) return false;
    return this.snapshotTurn === null || this.landedTurn > this.snapshotTurn;
  }

  private armIdle(): void {
    if (this.idleHandle !== null || this.stopped || this.paused !== null) return;
    if (!this.needsSnapshot()) return;
    this.idleHandle = this.timer.schedule(() => {
      this.idleHandle = null;
      this.chain = this.chain.then(() => this.idleFire());
    }, this.idleSnapshotMs);
  }

  private async idleFire(): Promise<void> {
    const turn = this.landedTurn;
    const doc = this.lastDoc;
    if (turn !== null && doc !== null) await this.trySnapshot(turn, doc);
    // 上一发失败留的队列也顺手推一把：60 秒这一发不只是快照的重试点，也是重试的备用触发。
    this.kick();
    // 失败就下个 60 秒再试：spec §9 的"持续重试"落在快照上就是这个形状（「快照失败不吞日志」那一格）。
    this.armIdle();
    this.report();
  }

  private scheduleRetry(): void {
    if (this.retryHandle !== null || this.stopped || this.paused !== null) return;
    this.retryHandle = this.timer.schedule(() => {
      this.retryHandle = null;
      this.kick();
    }, this.retryDelayMs);
  }

  private cancelRetry(): void {
    if (this.retryHandle === null) return;
    this.retryHandle.cancel();
    this.retryHandle = null;
  }

  private cancelIdle(): void {
    if (this.idleHandle === null) return;
    this.idleHandle.cancel();
    this.idleHandle = null;
  }

  /**
   * 一发自续的心跳：跑完一次再排下一次，而不是 `setInterval` —— 停写与停机时"下一次"要能干脆没有。
   * 间隔的数值产地是 T6 那个常量，这里不抄第二份（P-4/P-14 的账）。`persist-boundary.test.ts` 盯着
   * `LOCK_HEARTBEAT_INTERVAL_MS` 这个标识符还在不在：漂成字面量 5000 是本文件唯一没人运行时会红的漂法。
   */
  private scheduleBeat(): void {
    if (!this.beat || this.stopped || this.paused !== null) return;
    this.beatHandle = this.timer.schedule(() => {
      this.beatHandle = null;
      this.chain = this.chain.then(() => this.beatOnce());
    }, LOCK_HEARTBEAT_INTERVAL_MS);
  }

  private async beatOnce(): Promise<void> {
    const beat = this.beat;
    if (!beat || this.stopped || this.paused !== null) return;
    try {
      const answer = await beat();
      if (answer === 'lost') {
        this.lastError = '心跳报 lost：锁已被别人拿走或已过期';
        this.pause('lock-lost');
        return;
      }
    } catch (err) {
      // T7 ⑥ 段：问不出去 = 没有答案。两种可能里有一线是"别人正在写"，后果不对称 ⇒ 保守停写。
      this.lastError = `心跳调用抛错，按丢锁处理：${describeError(err)}`;
      this.pause('lock-lost: 心跳调用抛错');
      return;
    }
    this.scheduleBeat();
  }

  /** 每个 turn 只抢救一次（T7 ⑦ 段）；抢救钩子再炸也不许打断重试循环（spec §9 的同一条）。 */
  private rescue(entry: JournalEntry): void {
    if (this.rescuedTurns.has(entry.turn)) return;
    this.rescuedTurns.add(entry.turn);
    const hook = this.onEmergency;
    if (!hook) return;
    try {
      hook({
        projectId: entry.doc.projectId,
        turn: entry.turn,
        error: this.lastError ?? '未知故障',
        doc: entry.doc,
        patch: entry.patch,
      });
    } catch {
      // 吞掉：这里唯一的正确动作是继续重试，把盘写成功与否由返回值告诉调用方（emergency.ts 就是这么设计的）。
    }
  }

  private report(): void {
    const hook = this.onStatus;
    if (!hook) return;
    try {
      hook(this.status());
    } catch {
      // 上报是单向广播，它抛错不能把保存路径带走。
    }
  }
}
