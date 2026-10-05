import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'mysql2/promise';
import {
  Document,
  SCHEMA_VERSION,
  TransactionLog,
  applyPatch,
  storeyCreate,
  wallCreate,
  wallSetLoadBearing,
  type Command,
  type EntityId,
  type Patch,
} from '@dajia/core';
import { createDbPool } from '../../src/main/db/pool';
import { readMysqlEnv } from '../../src/main/db/env';
import { dropTestDatabase, ensureDatabase } from '../../src/main/db/database';
import { migrate } from '../../src/main/db/migrate';
import { decodeDocument } from '../../src/main/db/codec';
import { ProjectRepository, type JournalEntry } from '../../src/main/db/repository';
import { Autosave, type JournalSink } from '../../src/main/persist/autosave';
import { EMERGENCY_DIR_NAME, writeEmergencySnapshot } from '../../src/main/persist/emergency';

const env = readMysqlEnv();
// 红线同前两档：库名由本文件写死，不抄 env（env.database 允许是 dajia）。
const DATABASE = 'dajia_test';
const PROJECT_ID = '0193aa00-0000-7000-8000-00000000000c' as EntityId;

let pool: Pool;
let repo: ProjectRepository;
let emergencyDir = '';

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [res] = await pool.query(sql, params);
  return res as T[];
}

async function count(table: string, where = '', params: unknown[] = []): Promise<number> {
  const [res] = await pool.query(`SELECT COUNT(*) AS n FROM \`${table}\`${where}`, params);
  return Number((res as { n: number | string }[])[0]?.n);
}

async function clearAll(): Promise<void> {
  await pool.query('DELETE FROM `project`');
}

/**
 * 条件轮询而不是固定 sleep：这一档等的是**库里的状态**（日志行数、快照份数），
 * 不是"引擎大概跑完了吧"。真钟 + 真连接下的耗时不可预测（P-4 那一层在测试里的对应物）。
 * 唯一反着来的一格是 pause 那一格：它要证的是"不发生"，那必须给一个观察窗口（见那里的注释）。
 */
async function waitUntil(
  label: string,
  probe: () => Promise<boolean>,
  deadlineMs = 8_000,
): Promise<void> {
  const started = performance.now();
  for (;;) {
    if (await probe()) return;
    if (performance.now() - started > deadlineMs) {
      throw new TypeError(`等 ${deadlineMs}ms 仍不成立：${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function step(doc: Document, cmd: Command): { patch: Patch; doc: Document } {
  const patch = cmd.build(doc);
  return { patch, doc: applyPatch(doc, patch).doc };
}

/** 取补丁里那枚新建实体的 id。写死在这里而不是 `?? 常量`：夹具拿不到实体就是夹具塌了。 */
function firstUpsertId(patch: Patch, kind: string): EntityId {
  const entity = patch.upsert.find((e) => e.kind === kind);
  if (!entity) throw new TypeError(`补丁里没有 ${kind}，夹具塌了：${JSON.stringify(patch.upsert.map((e) => e.kind))}`);
  return entity.id;
}

/**
 * 八发连着写的账：一层、四片墙封一个口、改一发承重、二层、二层一片墙。
 * 为什么手搓而不是随机：这一档的判据是"快照落在 3 与 6"，它要求 turn 序列与补丁序列都确定；
 * 随机产量归 core 的属性测试。厚度四片一律 200 —— 同端点异厚度会撞进计划 3 尾判那条 tie-break 限度。
 */
function buildEntries(): JournalEntry[] {
  const base = Document.create(PROJECT_ID);
  const t1 = step(base, storeyCreate({ projectId: PROJECT_ID, index: 0, elevationMm: 0, heightMm: 3000 }));
  const lower = firstUpsertId(t1.patch, 'storey');
  const t2 = step(
    t1.doc,
    wallCreate({ storeyId: lower, start: { x: 0, y: 0 }, end: { x: 4000, y: 0 }, thicknessMm: 200, heightMm: 2800 }),
  );
  const wallA = firstUpsertId(t2.patch, 'wall');
  const t3 = step(
    t2.doc,
    wallCreate({ storeyId: lower, start: { x: 4000, y: 0 }, end: { x: 4000, y: 3000 }, thicknessMm: 200, heightMm: 2800 }),
  );
  const t4 = step(
    t3.doc,
    wallCreate({ storeyId: lower, start: { x: 4000, y: 3000 }, end: { x: 0, y: 3000 }, thicknessMm: 200, heightMm: 2800 }),
  );
  const t5 = step(
    t4.doc,
    wallCreate({ storeyId: lower, start: { x: 0, y: 3000 }, end: { x: 0, y: 0 }, thicknessMm: 200, heightMm: 2800 }),
  );
  const t6 = step(t5.doc, wallSetLoadBearing({ wallId: wallA, loadBearing: false }));
  const t7 = step(t6.doc, storeyCreate({ projectId: PROJECT_ID, index: 1, elevationMm: 3000, heightMm: 3000 }));
  const upper = firstUpsertId(t7.patch, 'storey');
  const t8 = step(
    t7.doc,
    wallCreate({ storeyId: upper, start: { x: 0, y: 0 }, end: { x: 5000, y: 0 }, thicknessMm: 200, heightMm: 2800 }),
  );
  return [t1, t2, t3, t4, t5, t6, t7, t8].map((s, i) => ({ turn: i + 1, patch: s.patch, doc: s.doc }));
}

/** 取夹具里的第 turn 发。不用 `as`：拿不到那一发就是夹具塌了，抛出来比静默 undefined 好查。 */
function atTurn(entries: JournalEntry[], turn: number): JournalEntry {
  const found = entries[turn - 1];
  if (!found) throw new TypeError(`夹具没有第 ${turn} 发`);
  return found;
}

function mkEntries(): JournalEntry[] {
  const entries = buildEntries();
  const first = atTurn(entries, 1);
  const last = atTurn(entries, 8);
  // 每一发的 doc 必须是**累积到那一发**的状态：appendJournal 拿它核对归属，
  // writeSnapshot 把它整个编码落盘。写成"八发共用最后一份文档"是最容易被误改的一处。
  if (last.doc.entities.size <= first.doc.entities.size) {
    throw new TypeError('夹具塌了：每一发的 doc 应当逐发累积，不是八发共用同一份');
  }
  return entries;
}

/** 只让第 failTurn 发失败 failTimes 次，其余原样交给真 repository。 */
class FlakySink implements JournalSink {
  private failed = 0;

  constructor(
    private readonly inner: JournalSink,
    private readonly failTurn: number,
    private readonly failTimes: number,
  ) {}

  async appendJournal(entry: JournalEntry) {
    if (entry.turn === this.failTurn && this.failed < this.failTimes) {
      this.failed += 1;
      throw Object.assign(new Error('注入的库故障：连接被掐断'), { code: 'ECONNREFUSED' });
    }
    return this.inner.appendJournal(entry);
  }

  writeSnapshot(turn: number, doc: Document): Promise<void> {
    return this.inner.writeSnapshot(turn, doc);
  }
}

beforeAll(async () => {
  await dropTestDatabase(env, DATABASE);
  await ensureDatabase(env, DATABASE);
  pool = createDbPool({ ...env, database: DATABASE });
  // 迁移连接单独开（P-65：`multipleStatements` 只准住在迁移连接上，业务池不开它）。
  // 规格把这发直接压在业务池上 —— 那是 T6 已经踩过并记在案的坑：`001_init.sql`
  // 是多语句 DDL，业务池不开 `multipleStatements` 时 MySQL 报
  // 「near 'CREATE TABLE IF NOT EXISTS `project`('」的语法错。照 locks.test.ts 的形状修。
  const migratePool = createDbPool({ ...env, database: DATABASE }, { multipleStatements: true });
  try {
    await migrate(migratePool, DATABASE);
  } finally {
    await migratePool.end();
  }
  repo = new ProjectRepository(pool, PROJECT_ID, 'autosave-db');
  emergencyDir = mkdtempSync(join(tmpdir(), 'dajia-emergency-db-'));
});

afterAll(async () => {
  // `emergencyDir` 为空说明 `beforeAll` 中途抛了（建库/迁移失败）。那一路
  // `rmSync('')` 会把**空串解析成 cwd** —— 在本仓库就是 `D:\ReactElectron` 整棵。
  // 它被safe-delete 守卫拦下才没出事，但"靠守卫兜住自己的bug"不是防线：
  // 这里显式判空，让失败路径不可能碰到仓库目录。
  if (emergencyDir) rmSync(emergencyDir, { recursive: true, force: true });
  if (pool) await pool.end();
  await dropTestDatabase(env, DATABASE);
});

beforeEach(async () => {
  await clearAll();
  await repo.createProject({ name: '保存引擎样例工程', schemaVersion: SCHEMA_VERSION });
});

// 每一格末尾都有 `engine.stop()`：不拆定时器的引擎会把下一格的 `waitUntil`
// 推着走（这类"过不了的绿"比红更难查）。没有 try/finally 是故意的 —— 格子里断言失败
// 时 vitest 本来就报红，而停不掉的定时器会在**下一格**报出更难归因的红。

async function snapshotTurns(): Promise<number[]> {
  const rs = await rows<{ journal_turn: number | string }>(
    'SELECT `journal_turn` FROM `snapshot` ORDER BY `journal_turn` ASC',
  );
  return rs.map((r) => Number(r.journal_turn));
}

async function logTurns(): Promise<number[]> {
  const rs = await rows<{ turn: number | string }>('SELECT `turn` FROM `command_log` ORDER BY `turn` ASC');
  return rs.map((r) => Number(r.turn));
}

async function projectTurn(): Promise<number> {
  const rs = await rows<{ t: number | string }>('SELECT `journal_turn` AS t FROM `project` WHERE `id` = ?', [
    PROJECT_ID,
  ]);
  return Number(rs[0]?.t ?? -1);
}

describe('引擎接真 repository', () => {
  it('八发连着落：日志 1..8、阈值快照在 3 与 6、空闲那一份补在 8，loadProject 还原成同一份文档', async () => {
    const entries = mkEntries();
    const engine = new Autosave({ sink: repo, snapshotEveryRows: 3, idleSnapshotMs: 40 });
    for (const entry of entries) engine.submit(entry);
    await engine.settled();
    await waitUntil('command_log 八行', async () => (await count('command_log')) === 8);
    expect(await logTurns()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // 不在这里断 `[3, 6]`：40ms 的窗口里空闲那一份可能已经落了，那是一条会自己漂的判据。
    await waitUntil('空闲补的那一份', async () => (await snapshotTurns()).includes(8));
    expect(await snapshotTurns()).toEqual([3, 6, 8]);
    expect(await projectTurn()).toBe(8);

    const loaded = await repo.loadProject('read');
    expect(loaded.header.journalTurn).toBe(8);
    expect(loaded.snapshot?.turn).toBe(8);
    expect(loaded.replayed.rows).toBe(0);
    expect(loaded.doc.canonical()).toBe(atTurn(entries, 8).doc.canonical());
    engine.stop();
  });

  it('undo 与 redo 各产出一发新账（P-5 在真库上的形状），重放仍然停在做过的最后一发', async () => {
    const entries = mkEntries();
    const engine = new Autosave({ sink: repo, snapshotEveryRows: 3, idleSnapshotMs: 60_000 });
    for (const entry of entries.slice(0, 6)) engine.submit(entry);
    await engine.settled();
    await waitUntil('前六发', async () => (await count('command_log')) === 6);

    // 事务日志接手：一发新命令、撤销、重做 —— 三发都要成为**新的账**。
    const wall = atTurn(entries, 2).doc.byKind('wall')[0];
    if (!wall) throw new TypeError('夹具里没有墙');
    const log = new TransactionLog(atTurn(entries, 6).doc);
    log.dispatch(wallSetLoadBearing({ wallId: wall.id, loadBearing: true }));
    const patchAfter = (turn: number): JournalEntry => {
      const patch = log.lastPatch;
      if (!patch) throw new TypeError(`turn ${turn} 拿不到 lastPatch：T7 Step 2 那三处赋值漏了一处`);
      return { turn, patch, doc: log.document };
    };
    engine.submit(patchAfter(7));
    expect(log.undo()).toBe(true);
    engine.submit(patchAfter(8));
    expect(log.redo()).toBe(true);
    engine.submit(patchAfter(9));
    await engine.settled();
    await waitUntil('九发齐', async () => (await count('command_log')) === 9);

    expect(await logTurns()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const loaded = await repo.loadProject('read');
    // 撤销那一发的**逆补丁**也在账上，重放完仍然停在做过的最后一发 —— 这才是"撤销也是一发新记录"。
    expect(loaded.doc.canonical()).toBe(log.document.canonical());
    engine.stop();
  });

  it('引擎递给 writeSnapshot 的那一对 (turn, doc) 同源：turn 2 的行里编码的就是第 2 发之后的文档', async () => {
    const entries = mkEntries();
    const engine = new Autosave({ sink: repo, snapshotEveryRows: 2, idleSnapshotMs: 60_000 });
    for (const entry of entries.slice(0, 4)) engine.submit(entry);
    await engine.settled();
    await waitUntil('两份阈值快照', async () => (await count('snapshot')) === 2);
    expect(await snapshotTurns()).toEqual([2, 4]);

    const rs = await rows<{ seq: number | string; journal_turn: number | string; payload: unknown }>(
      'SELECT `seq`, `journal_turn`, `payload` FROM `snapshot` ORDER BY `journal_turn` ASC',
    );
    for (const r of rs) {
      const turn = Number(r.journal_turn);
      const decoded = decodeDocument({ table: 'snapshot', id: String(Number(r.seq)) }, r.payload);
      const expected = entries[turn - 1];
      if (!expected) throw new TypeError(`快照行指认 turn ${turn}，夹具没有那一发`);
      // 这一句盯的是 `trySnapshot(head.turn, head.doc)` 那一对实参。假 sink 只数调用次数，
      // 看不见内容 —— (turn, doc) 错配（差一发型）只有在这里才红。
      expect(decoded.canonical()).toBe(expected.doc.canonical());
      expect(decoded.schemaVersion).toBe(SCHEMA_VERSION);
    }
    engine.stop();
  });

  it('already-applied 由真库的 journal_turn 判出 ⇒ 行数计数器不推进（P-6 那把尺的真库凭据）', async () => {
    const entries = mkEntries();
    const engine = new Autosave({ sink: repo, snapshotEveryRows: 2, idleSnapshotMs: 60_000 });
    engine.submit(atTurn(entries, 1));
    await engine.settled();
    await waitUntil('第一发落地', async () => (await count('command_log')) === 1);

    // 另一条路径先把第 2 发写进库（T5 的「重发旧 turn」在写侧的对应物：这里模拟"引擎之外有人补了账"）。
    const second = atTurn(entries, 2);
    expect(await repo.appendJournal(second)).toBe('applied');
    // 引擎随后自己投同一发：库给的是 already-applied，不是新增行。
    engine.submit(second);
    await engine.settled();
    await waitUntil('两行都在库里', async () => (await count('command_log')) === 2);

    const status = engine.status();
    expect(status.lastTurn).toBe(2);
    // 关键判据：库里两行，但**新增**只有一行 ⇒ 计数器是 1，不是 2 ⇒ 阈值（2）还没到 ⇒ 不许有快照。
    expect(status.rowsSinceSnapshot).toBe(1);
    expect(status.lastError).toBeNull();
    expect(await count('snapshot')).toBe(0);

    engine.submit(atTurn(entries, 3));
    await engine.settled();
    await waitUntil('第三发之后到阈值', async () => (await count('snapshot')) === 1);
    expect(await snapshotTurns()).toEqual([3]);
    expect(await logTurns()).toEqual([1, 2, 3]);
    engine.stop();
  });

  it('真故障重试：turn 序列仍然连着，且一个 turn 只落一份抢救件（onEmergency 接的是真 fs）', async () => {
    const entries = mkEntries();
    const sink = new FlakySink(repo, 4, 2);
    const rescued: string[] = [];
    const engine = new Autosave({
      sink,
      snapshotEveryRows: 3,
      idleSnapshotMs: 60_000,
      retryDelayMs: 25,
      onEmergency: (payload) => {
        const w = writeEmergencySnapshot(emergencyDir, {
          projectId: payload.projectId,
          turn: payload.turn,
          error: payload.error,
          doc: payload.doc,
        });
        // 只记路径：ok:false 时上一格那种"逐个断言"会红在 undefined，而这一格盯的是份数与内容。
        rescued.push(w.ok ? w.path : `FAILED:${w.error}`);
      },
    });
    for (const entry of entries) engine.submit(entry);
    await waitUntil('注入两次失败之后第八发落地', async () => (await count('command_log')) === 8, 15_000);
    await engine.settled();

    // 连续、无洞、无重复 —— 这一条是 T5「中间缺一发日志 ⇒ 拒开并说"缺号"」那一格的正面凭据。
    expect(await logTurns()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(rescued).toEqual([join(emergencyDir, EMERGENCY_DIR_NAME, `${PROJECT_ID}-turn-4.json`)]);
    const files = readdirSync(join(emergencyDir, EMERGENCY_DIR_NAME));
    expect(files).toEqual([`${PROJECT_ID}-turn-4.json`]);
    const only = files[0];
    if (!only) throw new TypeError('抢救件不在目录里');
    const envelope = JSON.parse(readFileSync(join(emergencyDir, EMERGENCY_DIR_NAME, only), 'utf8')) as {
      error: string;
      canonical: string;
      turn: number;
    };
    expect(envelope.turn).toBe(4);
    // 驱动那一格的 code 必须在文案里（`describeError` 存在的全部理由）。
    expect(envelope.error).toContain('ECONNREFUSED');
    // 抢救件保的那份状态，就是库里第 4 发之后应有的那份状态。
    expect(envelope.canonical).toBe(atTurn(entries, 4).doc.canonical());
    expect(engine.status().lastError).toBeNull();
    engine.stop();
  });

  it('pause 期间库里一行都不许多，resume 之后把憋着的补上且 turn 仍然连着', async () => {
    const entries = mkEntries();
    const engine = new Autosave({ sink: repo, snapshotEveryRows: 3, idleSnapshotMs: 60_000 });
    engine.submit(atTurn(entries, 1));
    await engine.settled();
    await waitUntil('第一发落地', async () => (await count('command_log')) === 1);
    const before = await count('command_log');
    const beforeTurn = await projectTurn();

    engine.pause('lock-lost：T6 说这把锁没余额了');
    for (const entry of entries.slice(1, 4)) engine.submit(entry);
    await engine.settled();
    // 证"不发生"必须给一个观察窗口 —— waitUntil 在这里不适用（要等的状态永不出现）。
    // 120ms 是宽裕上界：pause 已经撤掉重试与空闲两个定时器（`cancelIdle`/`cancelRetry`），
    // 没有任何东西会在窗口里敲第二下。
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(await count('command_log')).toBe(before);
    expect(await projectTurn()).toBe(beforeTurn);
    expect(await count('snapshot')).toBe(0);
    const paused = engine.status();
    expect(paused.phase).toBe('paused');
    expect(paused.queuedTurns).toBe(3);
    expect(paused.pauseReason).toBe('lock-lost：T6 说这把锁没余额了');

    engine.resume();
    await waitUntil('补写到第四发', async () => (await count('command_log')) === 4);
    await engine.settled();
    // 补写不是重写：turn 仍然逐发连着，pause 期间那一发都没进过库。
    expect(await logTurns()).toEqual([1, 2, 3, 4]);
    expect(await projectTurn()).toBe(4);
    engine.stop();
  });

  it('flush 把收尾快照补上、报零欠款；stop 之后 phase 是 stopped（T8 的关窗路径）', async () => {
    const entries = mkEntries();
    const engine = new Autosave({ sink: repo, snapshotEveryRows: 3, idleSnapshotMs: 60_000 });
    for (const entry of entries.slice(0, 5)) engine.submit(entry);
    await engine.settled();
    await waitUntil('阈值那一份', async () => (await count('snapshot')) === 1);
    expect(engine.status().rowsSinceSnapshot).toBe(2);
    expect(await snapshotTurns()).toEqual([3]);

    const flushed = await engine.flush();
    expect(flushed.queuedTurns).toBe(0);
    expect(flushed.snapshotTurn).toBe(5);
    expect(flushed.rowsSinceSnapshot).toBe(0);
    expect(flushed.lastError).toBeNull();
    expect(await snapshotTurns()).toEqual([3, 5]);
    // 60ms 的观察窗口：`idleSnapshotMs` 是 60 秒，这里等的是"没有第三个定时器来敲"这一件事
    // —— flush 补完那一份之后 `needsSnapshot()` 已经为假（T7 ⑤ 段那条记性）。
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await count('snapshot')).toBe(2);

    const stopped = engine.stop();
    expect(stopped.phase).toBe('stopped');
    expect(stopped.lastError).toBeNull();
    const loaded = await repo.loadProject('read');
    expect(loaded.replayed.rows).toBe(0);
    expect(loaded.doc.canonical()).toBe(atTurn(entries, 5).doc.canonical());
  });
});
