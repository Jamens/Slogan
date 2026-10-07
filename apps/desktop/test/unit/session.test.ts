import { describe, expect, it } from 'vitest';
import {
  Document,
  SCHEMA_VERSION,
  type Entity,
  type EntityId,
  type Patch,
  type PointEntity,
} from '@dajia/core';
import {
  type CloseRequest,
  type EmergencyRef,
  type PatchShape,
  type SubmitRequest,
} from '@dajia/protocol';
import {
  CLOSE_FLUSH_TIMEOUT_MS,
  ProjectSession,
  SessionError,
  type DbHandle,
  type LockHandle,
  type PersistPorts,
  type SessionRepo,
} from '../../src/main/persist/session';
import type {
  CloseReport,
  JournalEntry,
  JournalOutcome,
  LoadOutcome,
  OpenIntent,
} from '../../src/main/db/repository';
import type { MysqlEnv } from '../../src/main/db/env';
import type { EmergencyPayload, SaveStatus } from '../../src/main/persist/autosave';
import { documentFromPayload, payloadFromDocument } from '../../src/shared/document-wire';
import { MissingProjectError } from '../../src/main/db/errors';
import { FakeTimer, tick } from './fake-timer';

const PID = '0193aa00-0000-7000-8000-00000000000a';
const OTHER = '0193aa00-0000-7000-8000-00000000000c';
const S1 = '0193aa00-0000-7000-8000-000000000001';
const P1 = '0193aa00-0000-7000-8000-000000000002';

const point: PointEntity = { kind: 'point', id: P1, storeyId: S1, x: 1000, y: 0 };
const DOC = Document.replaceEntities(
  Document.create(PID, SCHEMA_VERSION),
  new Map<EntityId, Entity>([[P1, point]]),
);

/** 假把式的 env：这个文件零 mysql2，它只是 `loadConfig` 的返回值形状，永远不会被拨号。 */
const FAKE_ENV: MysqlEnv = {
  host: 'example.invalid',
  port: 3306,
  user: 'fake',
  password: 'fake',
  database: 'dajia_test',
};

// 夹具订正（`<待实测>` 的下游）：core 的 `Patch` 两层 readonly，`PatchShape`（zod 产物）是可变数组，
// readonly → mutable 不可赋值 ⇒ 喂 `SubmitRequest.patch` 的工厂注解成 `PatchShape`（判据一字不动）。
const patchOf = (x: number): PatchShape => ({
  upsert: [{ ...point, x }],
  remove: [],
});

const submitReq = (projectId: EntityId, doc: Document): SubmitRequest => ({
  projectId,
  patch: patchOf(1000),
  doc: payloadFromDocument(doc),
});

const closeReq = (projectId: EntityId, doc: Document, mode: 'graceful' | 'abandon'): CloseRequest => ({
  projectId,
  doc: payloadFromDocument(doc),
  mode,
});

/**
 * 一发真账的形状：补丁把 P1 的 x 改成 `x`，文档就是改完之后的样子。
 * 两边对不上也没人查（引擎不看内容，`closeProject` 的三方对账才看），
 * 但假把式里写一致可以省掉一格"到底是哪一侧漂了"的排查。
 */
const docAt = (x: number): Document =>
  Document.replaceEntities(
    Document.create(PID, SCHEMA_VERSION),
    new Map<EntityId, Entity>([[P1, { ...point, x }]]),
  );

const submitAt = (x: number): SubmitRequest => ({ projectId: PID, patch: patchOf(x), doc: payloadFromDocument(docAt(x)) });

class FakeRepo implements SessionRepo {
  readonly appended: { turn: number; docCanonical: string; patch: Patch }[] = [];
  loadResult: LoadOutcome;
  loadThrows: Error | null = null;
  closeThrows: Error | null = null;
  failTurns = new Set<number>();
  hangAppends = false;

  /** 时间线**只有一个**：`calls` 由 harness 传进来，与 `FakeLock`、`PersistPorts` 三个假把式共用同一根针。 */
  constructor(readonly calls: string[]) {
    this.loadResult = {
      doc: DOC,
      header: {
        projectId: PID,
        name: '接线样例',
        schemaVersion: SCHEMA_VERSION,
        journalTurn: 7,
        wasCleanShutdown: true,
      },
      snapshot: { seq: 3, turn: 5 },
      replayed: { rows: 2, fromSeq: 4, toSeq: 5 },
    };
  }

  async appendJournal(entry: JournalEntry): Promise<JournalOutcome> {
    if (this.hangAppends) return new Promise<JournalOutcome>(() => {});
    if (this.failTurns.has(entry.turn)) {
      // 不带 `code` 是我们自己的抛；带 `code` 的那一型由格 12 用另一支假错打。
      throw new RangeError(`假故障：turn ${entry.turn} 写不进去`);
    }
    this.calls.push(`append:${entry.turn}`);
    this.appended.push({ turn: entry.turn, docCanonical: entry.doc.canonical(), patch: entry.patch });
    return 'applied';
  }

  async writeSnapshot(turn: number): Promise<void> {
    this.calls.push(`snapshot:${turn}`);
  }

  async loadProject(intent: OpenIntent): Promise<LoadOutcome> {
    this.calls.push(`load:${intent}`);
    if (this.loadThrows) throw this.loadThrows;
    return this.loadResult;
  }

  async closeProject(doc: Document): Promise<CloseReport> {
    // 文案只记"是不是同一份文档"：canonical 串太长，会把顺序判据读成噪音。
    this.calls.push(doc.canonical() === DOC.canonical() ? 'close:same' : 'close:other');
    if (this.closeThrows) throw this.closeThrows;
    return { elementRows: 4, storeyRows: 1 };
  }
}

class FakeLock implements LockHandle {
  outcome: 'renewed' | 'lost' = 'renewed';
  constructor(private readonly calls: string[]) {}

  async beat(): Promise<'renewed' | 'lost'> {
    this.calls.push('beat');
    return this.outcome;
  }

  async release(): Promise<void> {
    this.calls.push('release');
  }
}

function harness(over: {
  lock?: LockHandle | null;
  loadConfigThrows?: Error;
  openDbThrows?: Error;
  acquireThrows?: Error;
  emergency?: EmergencyRef[];
} = {}) {
  const calls: string[] = [];
  const repo = new FakeRepo(calls);
  const timer = new FakeTimer();
  const statuses: SaveStatus[] = [];
  const rescued: EmergencyPayload[] = [];
  const lock = over.lock === undefined ? new FakeLock(calls) : over.lock;
  const ports: PersistPorts = {
    userDataDir: '/tmp/dajia-session-test',
    timer,
    loadConfig() {
      calls.push('loadConfig');
      if (over.loadConfigThrows) throw over.loadConfigThrows;
      return FAKE_ENV;
    },
    async openDb(env, projectId) {
      calls.push(`openDb:${projectId}:${env.host}`);
      if (over.openDbThrows) throw over.openDbThrows;
      // `raw` 在这里没有含义：假把式不连库，session 也一个字段都不读它（第 ⑥ 段）。
      const db: DbHandle = { repo, raw: 'fake-pool', async end() { calls.push('end'); } };
      return db;
    },
    async acquire() {
      calls.push('acquire');
      if (over.acquireThrows) throw over.acquireThrows;
      return lock;
    },
    readEmergency(_userDataDir, projectId) {
      calls.push(`readEmergency:${projectId}`);
      return over.emergency ?? [];
    },
    writeEmergency(payload) {
      calls.push(`emergency:${payload.turn}`);
      rescued.push(payload);
    },
    emitStatus(status) {
      statuses.push(status);
    },
  };
  return {
    session: new ProjectSession(ports),
    repo,
    timer,
    lock,
    calls,
    statuses,
    rescued,
  };
}

/** 每格都从这里起步：一个开好的可写会话。 */
async function opened(h?: ReturnType<typeof harness>) {
  const ctx = h ?? harness();
  await ctx.session.open(PID);
  return ctx;
}

describe('open 的失败分型：每一步失败只报自己那一步，后一步零调用', () => {
  it('1. 配置读不出来 ⇒ not-configured，且一个连接都没建', async () => {
    const ctx = harness({ loadConfigThrows: new Error('缺 DAJIA_MYSQL_PASSWORD') });
    await expect(ctx.session.open(PID)).rejects.toMatchObject({ code: 'not-configured' });
    expect(ctx.calls.filter((c) => c.startsWith('openDb'))).toEqual([]);
    expect(ctx.session.active).toBe(false);
  });

  it('2. 连库失败 ⇒ db，且一次锁都没试过', async () => {
    const ctx = harness({ openDbThrows: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    await expect(ctx.session.open(PID)).rejects.toMatchObject({ code: 'db' });
    expect(ctx.calls).toEqual(['loadConfig', 'openDb:0193aa00-0000-7000-8000-00000000000a:example.invalid']);
    expect(ctx.session.active).toBe(false);
  });

  it('3. 读盘拒开（不带 code 的抛）⇒ reconcile；端口自己定了码 ⇒ 原样上抛、不被降级', async () => {
    const a = harness();
    a.repo.loadThrows = new RangeError('journal turn 跳号：盘上记到 3，这发要写 5');
    await expect(a.session.open(PID)).rejects.toMatchObject({ code: 'reconcile' });
    expect(a.calls).toContain('release');
    expect(a.calls).toContain('end');
    expect(a.session.active).toBe(false);

    // `wrap` 的那条通道：端口已经查清的结论不许被下一步的默认码重说一遍
    // （没有这一支，T9 的"配置解不开"到了横幅上就会变成"连不上库"）。
    const b = harness({ acquireThrows: new SessionError('bad-request', '假把式：这台机器名太长') });
    await expect(b.session.open(PID)).rejects.toMatchObject({ code: 'bad-request' });
    // **票从未到手 ⇒ 无可释放**（T8 收尾时改口径）：原写法在这里也要求 `release` 被调用，
    // 可 `acquire` 抛错时局部 `lock` 没被赋值、`this.lock` 也还是 `null`
    // （`session.ts` 里`this.lock = lock` 在 `acquire` 之后才执行）⇒ `teardown` 的
    // `await lock?.release()` 被可选链短路，**不调** `release` 才是正确行为。
    //
    // 这一行反过来还有牙：将来若有人把 `this.lock = lock` 提到 `acquire` 之前，
    // 它会红（那时会拿着一个 undefined 的句柄去解锁）。
    expect(b.calls).not.toContain('release');
    // 但连接池照样要关 —— 票没拿到不等于什么都没分配。
    expect(b.calls).toContain('end');
    expect(b.session.active).toBe(false);
  });
});

describe('open 的两条岔路', () => {
  it('4. 拿到票 ⇒ edit、loadProject("edit")、引擎起来了，且 fromJournal 三格读数来自库里那份头', async () => {
    const ctx = await opened();
    expect(ctx.session.decision).toBe('edit');
    expect(ctx.calls).toContain('load:edit');
    const status = ctx.session.status();
    expect(status).not.toBeNull();
    expect(status?.phase).toBe('idle');
    // journalTurn=7 而快照在 5 ⇒ 阈值计数器从 2 起算，不是从 0（"每 2000 条"在重启之后还成立靠的就是这一格）
    expect(status?.snapshotTurn).toBe(5);
    expect(status?.rowsSinceSnapshot).toBe(2);
    // **`lastTurn` 是 7 而不是 null**（T8 收尾时改口径）：`fromJournal.lastTurn` 给的是
    // `header.journalTurn`（库里那份头的读数），引擎从它起算 —— 这正是 T7 那句
    // "**引擎不猜库里的账**"（`rowsSinceSnapshot` 的起点由 `fromJournal` 给）。
    // 它有真实读者：`projectStore.computeBanner` 的兜底那一句灰话
    // 「${name}：已保存到第 ${lastTurn} 发」，而那句在真进程里是**常驻**的
    // （`phase === 'open'` 且无异常时，它就是横幅）。若这里回 null，屏幕上会显示
    // "已保存到第 0 发" —— 一句关于用户工程的谎话。
    //
    // 反过来看这个口径为什么值得钉：`null` 只在"**新工程**（fromJournal 没给）"时出现，
    // 那时"第 0 发"确实是对的（库里一份账都没有）。两种形状各有各的语义，别混。
    expect(status?.lastTurn).toBe(7);
  });

  it('5. 拿不到票 ⇒ read、loadProject("read")、没有引擎，submit 一律 session', async () => {
    const ctx = harness({ lock: null });
    const value = await ctx.session.open(PID);
    expect(value.decision).toBe('read-only');
    expect(ctx.session.decision).toBe('read-only');
    expect(ctx.calls).toContain('load:read');
    expect(ctx.session.status()).toBeNull();
    try {
      ctx.session.submit(submitReq(PID, DOC));
      expect.unreachable('只读会话的 submit 必须抛');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionError);
      expect((err as SessionError).code).toBe('session');
    }
  });

  it('6. 回包逐字段同源：doc 往返不漂、snapshot/replayed 原样、emergency 来自 readEmergency', async () => {
    const refs: EmergencyRef[] = [{ turn: 4, path: '/tmp/dajia-session-test/emergency/a.json' }];
    const ctx = harness({ emergency: refs });
    const value = await ctx.session.open(PID);
    expect(documentFromPayload(value.doc, 'test').canonical()).toBe(DOC.canonical());
    expect(value.header).toEqual({
      projectId: PID,
      name: '接线样例',
      schemaVersion: SCHEMA_VERSION,
      journalTurn: 7,
      wasCleanShutdown: true,
    });
    expect(value.snapshot).toEqual({ seq: 3, turn: 5 });
    expect(value.replayed).toEqual({ rows: 2, fromSeq: 4, toSeq: 5 });
    expect(value.emergency).toEqual(refs);
    expect(ctx.calls).toContain(`readEmergency:${PID}`);
  });

  it('7. 会话还开着时二开 ⇒ session，并且现有会话一个资源都没动', async () => {
    const ctx = await opened();
    const before = [...ctx.calls];
    await expect(ctx.session.open(OTHER)).rejects.toMatchObject({ code: 'session' });
    // 调用序列一字没动 ⇒ 没有 second openDb / acquireLock / loadProject，也没有把现有会话的锁放了
    expect(ctx.calls).toEqual(before);
    expect(ctx.calls).not.toContain('release');
    expect(ctx.calls).not.toContain('end');
    expect(ctx.session.active).toBe(true);
  });
});

describe('submit：取号纪律（第 ① 段的全部牙）', () => {
  it('8. 连投三发 ⇒ 8、9、10（起点来自库里的 journalTurn=7），且补丁与文档原样到 sink', async () => {
    const ctx = await opened();
    const turns: number[] = [];
    for (const x of [1000, 2000, 3000]) {
      turns.push(ctx.session.submit(submitAt(x)).acceptedTurn);
    }
    expect(turns).toEqual([8, 9, 10]);
    await tick();
    expect(ctx.repo.appended.map((a) => a.turn)).toEqual([8, 9, 10]);
    expect(ctx.repo.appended[0]?.docCanonical).toBe(docAt(1000).canonical());
    expect(ctx.repo.appended[2]?.patch.upsert[0]?.kind).toBe('point');
  });

  it('9. 坏 payload 吃掉一个号 = 永久跳号，所以解码必须在取号之前', async () => {
    const ctx = await opened();
    const bad = payloadFromDocument(DOC);
    const dup = { ...bad, entities: [...bad.entities, bad.entities[0] as (typeof bad.entities)[number]] };
    expect(() => ctx.session.submit({ projectId: PID, patch: patchOf(1000), doc: dup })).toThrow(
      /出现两次：一份快照不许有重复 id/,
    );
    // 号没有被吃掉：下一发仍然是 8。这一格是"坏请求不吃号"的唯一证人。
    expect(ctx.session.submit(submitReq(PID, DOC)).acceptedTurn).toBe(8);
  });

  it('10. 工程号对不上、文档签名对不上 ⇒ session，且都不消耗号', async () => {
    const ctx = await opened();
    expect(() => ctx.session.submit(submitReq(OTHER, DOC))).toThrow(/记在工程/);
    const otherDoc = Document.replaceEntities(
      Document.create(OTHER, SCHEMA_VERSION),
      new Map<EntityId, Entity>([[P1, point]]),
    );
    expect(() => ctx.session.submit(submitReq(PID, otherDoc))).toThrow(/一份状态不能同时是两个工程的现场/);
    expect(ctx.calls.filter((c) => c.startsWith('append'))).toEqual([]);
    expect(ctx.session.submit(submitReq(PID, DOC)).acceptedTurn).toBe(8);
  });

  it('11. 写失败 ⇒ 抢救件原样转交；丢锁 ⇒ 停写，此后 submit 报 session，且号一个都不许回收', async () => {
    const ctx = await opened();
    ctx.repo.failTurns = new Set([8]);
    ctx.session.submit(submitReq(PID, DOC));
    await tick();
    expect(ctx.rescued.length).toBe(1);
    expect(ctx.rescued[0]?.turn).toBe(8);
    expect(ctx.rescued[0]?.projectId).toBe(PID);
    expect(ctx.session.status()?.phase).toBe('failed');
    (ctx.lock as FakeLock).outcome = 'lost';
    ctx.timer.advance(5_000);
    await tick();
    expect(ctx.session.status()?.phase).toBe('paused');
    expect(() => ctx.session.submit(submitReq(PID, DOC))).toThrow(/已经停写/);
    // 号不回退：停写之前已经发出去的是 8，恢复能力归"重开"，不归原地补号（第 ⑤ 段）
    expect(ctx.repo.appended.map((a) => a.turn)).toEqual([]);
  });
});

describe('close 的五种收场', () => {
  it('12. abandon ⇒ 不 flush、不对账、只拆；两格读数是 null 而不是 0', async () => {
    const ctx = await opened();
    const value = await ctx.session.close(closeReq(PID, DOC, 'abandon'));
    expect(value).toEqual({ elementRows: null, storeyRows: null });
    expect(ctx.calls.filter((c) => c.startsWith('append'))).toEqual([]);
    expect(ctx.calls).not.toContain('close:same');
    expect(ctx.calls).toContain('release');
    expect(ctx.calls).toContain('end');
    expect(ctx.session.active).toBe(false);
    expect(ctx.session.decision).toBeNull();
    expect(ctx.timer.pending()).toBe(0);
    expect(ctx.statuses.at(-1)?.phase).toBe('stopped');
  });

  it('13. 只读会话的 graceful ⇒ 与 abandon 同路，绝不替别人宣告这库干净', async () => {
    const ctx = harness({ lock: null });
    await ctx.session.open(PID);
    const value = await ctx.session.close(closeReq(PID, DOC, 'graceful'));
    expect(value).toEqual({ elementRows: null, storeyRows: null });
    expect(ctx.calls).not.toContain('close:same');
    // **不释放锁，因为从来没有锁**（T8 收尾时改口径，与格 3 后半同型）：只读会话的
    // `acquire` 返回 `null`（别人持着锁），`teardown` 的 `await lock?.release()`
    // 被可选链短路。原写法要求 `release` 被调用，等于要求一份"没到手的票也去解锁"。
    // 格 14（可写会话）仍然要求 `release`，两条合起来才是"有票才放"。
    expect(ctx.calls).not.toContain('release');
    expect(ctx.calls).toContain('end'); // 池照样关
  });

  it('14. graceful 平账 ⇒ 顺序是 flush→closeProject→release→end；读数原样、定时器清零', async () => {
    const ctx = await opened();
    ctx.session.submit(submitReq(PID, DOC));
    await tick();
    const value = await ctx.session.close(closeReq(PID, DOC, 'graceful'));
    expect(value).toEqual({ elementRows: 4, storeyRows: 1 });
    const order = ctx.calls.filter((c) =>
      ['append:8', 'close:same', 'release', 'end'].includes(c),
    );
    expect(order).toEqual(['append:8', 'close:same', 'release', 'end']);
    expect(ctx.timer.pending()).toBe(0);
    expect(ctx.statuses.at(-1)?.phase).toBe('stopped');
  });

  it('15. 对账不平（不带 code 的抛）⇒ reconcile，且 closeProject 只试一次、照样拆干净', async () => {
    const ctx = await opened();
    ctx.repo.closeThrows = new RangeError('对账不平：element↔storey 少一行');
    await expect(ctx.session.close(closeReq(PID, DOC, 'graceful'))).rejects.toMatchObject({
      code: 'reconcile',
    });
    expect(ctx.calls.filter((c) => c === 'close:same')).toEqual(['close:same']);
    expect(ctx.calls).toContain('release');
    expect(ctx.calls).toContain('end');
  });

  it('16. flush 挂死（库不可达）⇒ 到 CLOSE_FLUSH_TIMEOUT_MS 报 db，窗口不许被卡住', async () => {
    const ctx = await opened();
    ctx.repo.hangAppends = true;
    ctx.session.submit(submitReq(PID, DOC));
    const closing = ctx.session.close(closeReq(PID, DOC, 'graceful'));
    // 拨到 10 秒会顺路敲一发心跳（5 秒那一档），但它**不会**留下第二个定时器：
    // `close` 的续体先跑 `stop()`，而 `scheduleBeat()` 第一行就是 `if (this.stopped) return`。
    // 于是下面那句 `pending()` 是 0 而不是 1 —— 读的人不必怀疑这一格会飘（T7 的 `stopped` 闸门在这里第二次上岗）。
    ctx.timer.advance(CLOSE_FLUSH_TIMEOUT_MS);
    await expect(closing).rejects.toMatchObject({ code: 'db' });
    expect(ctx.calls).toContain('release');
    expect(ctx.calls).toContain('end');
    expect(ctx.timer.pending()).toBe(0);
  });
});

describe('T9 的分型补格：no-project 有身份，不对称有证人', () => {
  it('17. 缺行那一发 ⇒ no-project，屏幕上说的是 T5 的原话，且会话拆干净', async () => {
    const ctx = harness();
    ctx.repo.loadThrows = new MissingProjectError(PID);
    const err = await ctx.session.open(PID).then(() => null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).code).toBe('no-project');
    // 文案逐字：`wrap` 只会前置"读不出这份工程：MissingProjectError: "，不许改写后半句。
    expect((err as SessionError).message).toContain(
      `工程 ${PID} 不在库里：要么它从没建过，要么它已经被删；不能凭空开一份文档当它是读来的`,
    );
    expect(ctx.calls).toContain('release');
    expect(ctx.calls).toContain('end');
    expect(ctx.session.active).toBe(false);
  });

  it('18. 同一发位置的三种错各归各码：新支路只吃这一型，其余照旧', async () => {
    const missing = harness();
    missing.repo.loadThrows = new MissingProjectError(PID);
    await expect(missing.session.open(PID)).rejects.toMatchObject({ code: 'no-project' });

    // 带 `code` 的一律 `'db'`（"查服务"），哪怕它长得像我们自己的错。
    const driver = harness();
    driver.repo.loadThrows = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    await expect(driver.session.open(PID)).rejects.toMatchObject({ code: 'db' });

    // 不带 `code` 的自家抛仍是 `'reconcile'`（"先别再写"）：这一格是"新支路没有把别的日子也接管走"的证人。
    const ours = harness();
    ours.repo.loadThrows = new RangeError('snapshot 行 7 的 schema_version 是 2，工程头记的是 1');
    await expect(ours.session.open(PID)).rejects.toMatchObject({ code: 'reconcile' });
  });

  it('19. MissingProjectError 只有身份与文案：不给 code 字段，也不留 projectId 字段', () => {
    const err = new MissingProjectError(PID);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('MissingProjectError');
    // 第一条是 P-26 的正面：它不许冒领 mysql2 错误的形状（有 `code` ⇒ 会被归成 `'db'`）。
    expect((err as { code?: unknown }).code).toBeUndefined();
    // 第二条是"不留字段"的证人：哪天有人加回来，这一格红，逼他同时写出那个读者。
    expect((err as { projectId?: unknown }).projectId).toBeUndefined();
  });

  it('20. 有意不对称：close 里那句"不在库里：没有可收尾的账"仍是 reconcile', async () => {
    const ctx = await opened();
    // T5 的 `closeProject` 缺行那一发**故意不换类**：此刻会话开着、账在动，
    // 唯一正确的建议是"这份账先别再动"，而不是"去建个工程"（T9 第 ⑥ 段末）。
    ctx.repo.closeThrows = new RangeError(`工程 ${PID} 不在库里：没有可收尾的账`);
    await expect(ctx.session.close(closeReq(PID, DOC, 'graceful'))).rejects.toMatchObject({
      code: 'reconcile',
    });
    expect(ctx.session.active).toBe(false);
  });
});
