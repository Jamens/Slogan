import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'mysql2/promise';
import {
  Document,
  applyPatch,
  storeyCreate,
  storeyDelete,
  storeySetElevation,
  wallCreate,
  wallDelete,
  wallSetLoadBearing,
  type Command,
  type Entity,
  type EntityId,
  type Patch,
} from '@dajia/core';
import { createDbPool } from '../../src/main/db/pool';
import { readMysqlEnv } from '../../src/main/db/env';
import { dropTestDatabase, ensureDatabase } from '../../src/main/db/database';
import { migrate } from '../../src/main/db/migrate';
import { ProjectRepository } from '../../src/main/db/repository';
import { decodeDocument, decodeEntity } from '../../src/main/db/codec';

const env = readMysqlEnv();
// 红线（见"授权与红线"那一节）：库名由本文件写死，**不抄 env**。`env.database` 允许是 `dajia`
// —— 那是应用运行时的合法取值，测试照抄它就把用户的真工程库当试验田，且一句错都不报。
const DATABASE = 'dajia_test';
const PROJECT_ID = '0193aa00-0000-7000-8000-00000000000a' as EntityId;
const OTHER_PROJECT = '0193aa00-0000-7000-8000-00000000000f' as EntityId;

let pool: Pool;
let repoPool: Pool;
let repo: ProjectRepository;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [res] = await pool.query(sql, params);
  return res as T[];
}

async function count(table: string, where = '', params: unknown[] = []): Promise<number> {
  const [res] = await pool.query(`SELECT COUNT(*) AS n FROM \`${table}\`${where}`, params);
  return Number((res as { n: number | string }[])[0]?.n);
}

/**
 * 清场只删 `project` 行：FK 都带 ON DELETE CASCADE，级联把 element / storey / command_log /
 * snapshot / asset 的子行一起带走。不用 `TRUNCATE` —— 有外键的表上 MySQL 会拒
 * （或要 `SET FOREIGN_KEY_CHECKS = 0`，那是把约束关掉再祈祷）。
 * 代价照 P-6 说：`AUTO_INCREMENT` 不重置 ⇒ `seq` 起点每发都在漂，
 * 所以本文件**没有任何一条判据读绝对 seq 值**，只读相对关系（子查询、DISTINCT、行内比对）。
 */
async function clearAll(): Promise<void> {
  await pool.query('DELETE FROM `project`');
}

/**
 * 用真命令造一发 turn 的补丁。测试自己**不**走 `TransactionLog`：`log.lastPatch` 要到 T7 才存在，
 * 而写路径吃的就是 `(patch, doc)` 这一对。T7 落地时把这里的 `step()` 换成 dispatch + `log.lastPatch`，
 * 用例形状不用改 —— 这是故意留下的接口，不是临时脚手架。
 */
function step(doc: Document, cmd: Command): { patch: Patch; doc: Document } {
  const patch = cmd.build(doc);
  return { patch, doc: applyPatch(doc, patch).doc };
}

interface Turn {
  readonly turn: number;
  readonly patch: Patch;
  readonly doc: Document;
}

/** 一层 + 一面承重墙：两个 turn，足够喂满四张表的写路径。 */
function houseTurns(): { entries: Turn[]; storeyId: EntityId; wallId: EntityId } {
  const t1 = step(
    Document.create(PROJECT_ID),
    storeyCreate({ projectId: PROJECT_ID, index: 0, elevationMm: 0, heightMm: 3000 }),
  );
  const storeyId = (t1.patch.upsert[0] as Entity).id as EntityId;
  const t2 = step(
    t1.doc,
    wallCreate({
      storeyId,
      start: { x: 0, y: 0 },
      end: { x: 4000, y: 0 },
      thicknessMm: 200,
      heightMm: 2800,
      loadBearing: true,
    }),
  );
  const wall = t2.patch.upsert.find((e) => e.kind === 'wall');
  if (!wall) throw new TypeError('wallCreate 的补丁里没有墙，夹具塌了');
  return { entries: [{ turn: 1, ...t1 }, { turn: 2, ...t2 }], storeyId, wallId: wall.id };
}

beforeAll(async () => {
  await dropTestDatabase(env, DATABASE);
  await ensureDatabase(env, DATABASE);
  pool = createDbPool({ ...env, database: DATABASE }, { multipleStatements: true });
  await migrate(pool, DATABASE);
  // 仓库用的池：一条连接 + 1 秒行锁等待。connectionLimit 是 1 且有意的 ——
  // 少了 `conn.release()` 时重发会拿不到连接（M5 的凭据），而不是悄悄多用一条连接把漏检盖住。
  repoPool = createDbPool(
    { ...env, database: DATABASE },
    { connectionLimit: 1, lockWaitTimeoutSeconds: 1 },
  );
  repo = new ProjectRepository(repoPool, PROJECT_ID, 'tester');
});

afterAll(async () => {
  await repoPool.end();
  await pool.end();
  await dropTestDatabase(env, DATABASE);
});

describe('连库守卫', () => {
  it('连接真的落在 dajia_test（哪怕环境变量指着的不是它）', async () => {
    const got = await rows<{ db: string }>('SELECT DATABASE() AS db');
    expect(got[0]?.db).toBe(DATABASE);
  });

  it('越界的 LONGLONG 回 string 而不是失精的 number（P-17 的 D 档钉成断言）', async () => {
    const got = await rows<{ big: unknown }>('SELECT 9007199254740993 AS big');
    expect(typeof got[0]?.big).toBe('string');
    expect(got[0]?.big).toBe('9007199254740993');
  });
});

describe('createProject', () => {
  beforeEach(clearAll);

  it('project 行落账：journal_turn 从 0 起、clean_shutdown 为 1、schema_version 照文档记', async () => {
    await repo.createProject({ name: '样例房', schemaVersion: 1 });
    const got = await rows<Record<string, string | number>>(
      'SELECT `schema_version`, `name`, `journal_turn`, `clean_shutdown` FROM `project` WHERE `id` = ?',
      [PROJECT_ID],
    );
    expect(got[0]).toMatchObject({
      schema_version: 1,
      name: '样例房',
      journal_turn: 0,
      clean_shutdown: 1,
    });
  });

  it('同一个 id 建两次 ⇒ 抛，且 `project` 表还是一行', async () => {
    await repo.createProject({ name: '样例房', schemaVersion: 1 });
    await expect(repo.createProject({ name: '另一份', schemaVersion: 1 })).rejects.toThrow(
      /Duplicate entry|已存在/i,
    );
    expect(await count('project')).toBe(1);
  });

  it('工程名空串、带首尾空白、超长 ⇒ 抛，且一个字段都不写（存储层不替调用方修手滑）', async () => {
    await expect(repo.createProject({ name: '', schemaVersion: 1 })).rejects.toThrow(/工程名/);
    await expect(repo.createProject({ name: '  ', schemaVersion: 1 })).rejects.toThrow(/工程名/);
    await expect(repo.createProject({ name: ' 样例房', schemaVersion: 1 })).rejects.toThrow(/工程名/);
    await expect(repo.createProject({ name: 'a'.repeat(201), schemaVersion: 1 })).rejects.toThrow(
      /200 个字符/,
    );
    await expect(repo.createProject({ name: '样例房', schemaVersion: 0 })).rejects.toThrow(
      /schemaVersion/,
    );
    expect(await count('project')).toBe(0);
  });

  it('actor 空串或超 64 字符 ⇒ 构造当场抛（VARCHAR(64) 截断是静默的那种错）', () => {
    expect(() => new ProjectRepository(repoPool, PROJECT_ID, '')).toThrow(/actor 长度/);
    expect(() => new ProjectRepository(repoPool, PROJECT_ID, 'a'.repeat(65))).toThrow(/actor 长度/);
  });
});

describe('appendJournal：一发 turn 的四张表', () => {
  beforeEach(async () => {
    await clearAll();
    await repo.createProject({ name: '样例房', schemaVersion: 1 });
  });

  it('两个 turn 跑完：command_log / element / storey / project 四处同时有账，且 updated_seq 跟着最后一发', async () => {
    const { entries } = houseTurns();
    expect(await repo.appendJournal(entries[0]!)).toBe('applied');
    expect(await repo.appendJournal(entries[1]!)).toBe('applied');

    expect(await count('command_log')).toBe(2);
    expect(await count('storey')).toBe(1);
    expect(await count('project', ' WHERE `journal_turn` = ?', [2])).toBe(1);

    const log = await rows<{ turn: number; actor: string }>(
      'SELECT `turn`, `actor` FROM `command_log` ORDER BY `seq`',
    );
    expect(log.map((r) => [r.turn, r.actor])).toEqual([
      [1, 'tester'],
      [2, 'tester'],
    ]);

    // element 的 id 集合逐字等于文档的实体 id 集合 —— P-7 的双写只在这一发上有牙
    const final = entries[1]!.doc;
    const onDisk = (await rows<{ id: EntityId }>('SELECT `id` FROM `element` ORDER BY `id`')).map(
      (r) => r.id,
    );
    expect(onDisk).toEqual([...final.entities.keys()].sort());

    // updated_seq 跟着"最后碰这一行的那一发"：turn 1 写楼层那一行、turn 2 写墙+两端点三行，
    // 楼层那行不被 turn 2 的 upsert 重述 ⇒ DISTINCT updated_seq = 2（brief 原文写 1，与 Step 7
    // 逐实体 upsert 的写法冲突，已连证据登记进报告）。两发的 seq 各覆盖自己那一发 upsert 的行数，
    // 合起来逐字等于整张投影 —— 这才是"四处同时有账"在 updated_seq 维度上的真身。
    expect(
      Number((await rows<{ n: number }>('SELECT COUNT(DISTINCT `updated_seq`) AS n FROM `element`'))[0]?.n),
    ).toBe(2);
    const seq1 = (await rows<{ seq: string | number }>('SELECT `seq` FROM `command_log` WHERE `turn` = 1'))[0]
      ?.seq;
    const seq2 = (await rows<{ seq: string | number }>('SELECT `seq` FROM `command_log` WHERE `turn` = 2'))[0]
      ?.seq;
    const touchedByTurn1 = await count('element', ' WHERE `updated_seq` = ?', [Number(seq1)]);
    const touchedByTurn2 = await count('element', ' WHERE `updated_seq` = ?', [Number(seq2)]);
    expect(touchedByTurn1).toBe(entries[0]!.patch.upsert.length);
    expect(touchedByTurn2).toBe(entries[1]!.patch.upsert.length);
    expect(touchedByTurn1 + touchedByTurn2).toBe(final.entities.size);
  });

  it('payload 读回来的实体与文档逐字段相同，且生成列认这套 payload 写法', async () => {
    const { entries, wallId } = houseTurns();
    await repo.appendJournal(entries[0]!);
    await repo.appendJournal(entries[1]!);
    const raw = await rows<{ payload: unknown }>(
      'SELECT `payload` FROM `element` WHERE `id` = ?',
      [wallId],
    );
    expect(decodeEntity({ table: 'element', id: wallId }, raw[0]?.payload)).toEqual(
      entries[1]!.doc.get(wallId),
    );
    const gen = await rows<{ kind: string; load_bearing: number | null }>(
      'SELECT `kind`, `load_bearing` FROM `element` WHERE `id` = ?',
      [wallId],
    );
    expect([gen[0]?.kind, gen[0]?.load_bearing]).toEqual(['wall', 1]);

    // 改承重 ⇒ 生成列跟着走（T2-M2 那一发的活体版本：repository 写的 payload 必须让生成列算得出）
    const t3 = step(entries[1]!.doc, wallSetLoadBearing({ wallId, loadBearing: false }));
    expect(await repo.appendJournal({ turn: 3, ...t3 })).toBe('applied');
    const after = await rows<{ load_bearing: number | null }>(
      'SELECT `load_bearing` FROM `element` WHERE `id` = ?',
      [wallId],
    );
    expect(after[0]?.load_bearing).toBe(0);
  });

  it('楼层那一行的 `storey_id` 是 NULL，别的三类都带着自己的层', async () => {
    const { entries, storeyId } = houseTurns();
    await repo.appendJournal(entries[0]!);
    await repo.appendJournal(entries[1]!);
    const s = await rows<{ storey_id: EntityId | null }>(
      'SELECT `storey_id` FROM `element` WHERE `id` = ?',
      [storeyId],
    );
    expect(s[0]?.storey_id).toBe(null);
    expect(await count('element', ' WHERE `storey_id` IS NOT NULL')).toBe(3);
  });

  it('同一 turn 重发 ⇒ `already-applied`，log 不涨、投影一个字不动（P-6 的落点）', async () => {
    const { entries } = houseTurns();
    await repo.appendJournal(entries[0]!);
    const before = await rows<{ id: EntityId; updated_seq: string | number }>(
      'SELECT `id`, `updated_seq` FROM `element` ORDER BY `id`',
    );
    expect(await repo.appendJournal(entries[0]!)).toBe('already-applied');
    expect(await repo.appendJournal(entries[0]!)).toBe('already-applied');
    expect(await count('command_log')).toBe(1);
    const after = await rows<{ id: EntityId; updated_seq: string | number }>(
      'SELECT `id`, `updated_seq` FROM `element` ORDER BY `id`',
    );
    expect(after).toEqual(before);
    expect(await count('project', ' WHERE `journal_turn` = ?', [1])).toBe(1);
  });

  it('跳号（盘上 0、这发 2）⇒ 抛，且四张表全无账', async () => {
    const { entries } = houseTurns();
    await expect(repo.appendJournal(entries[1]!)).rejects.toThrow(/journal turn 跳号/);
    expect(await count('command_log')).toBe(0);
    expect(await count('element')).toBe(0);
    expect(await count('storey')).toBe(0);
    expect(await count('project', ' WHERE `journal_turn` = ?', [0])).toBe(1);
  });

  it('半途被外部行锁掐断 ⇒ 全无账；释放后同 turn 重发成功（P-15：rollback 与 release 的唯一凭据）', async () => {
    const { entries, wallId } = houseTurns();
    await repo.appendJournal(entries[0]!);
    await repo.appendJournal(entries[1]!);

    // 另一条连接把墙那一行锁住不提交：仓库这一发会先写成 command_log，再在 element 那一发上等锁超时
    // —— 失败点落在事务**中间**，正是"要么全写要么全无"要看的位置。
    const blockerPool = createDbPool({ ...env, database: DATABASE }, { connectionLimit: 2 });
    const blocker = await blockerPool.getConnection();
    try {
      await blocker.beginTransaction();
      await blocker.query('SELECT `id` FROM `element` WHERE `id` = ? FOR UPDATE', [wallId]);

      const t3 = step(entries[1]!.doc, wallSetLoadBearing({ wallId, loadBearing: false }));
      await expect(repo.appendJournal({ turn: 3, ...t3 })).rejects.toThrow(/Lock wait timeout/);

      expect(await count('command_log', ' WHERE `turn` = ?', [3])).toBe(0);
      expect(await count('project', ' WHERE `journal_turn` = ?', [3])).toBe(0);
      expect(await count('storey')).toBe(1);
      const still = await rows<{ payload: unknown }>(
        'SELECT `payload` FROM `element` WHERE `id` = ?',
        [wallId],
      );
      expect(decodeEntity({ table: 'element', id: wallId }, still[0]?.payload)).toEqual(
        entries[1]!.doc.get(wallId),
      );

      await blocker.rollback();
      // 没有 `conn.rollback()` ⇒ 这里撞 uk_project_turn（那条未回滚的 log 行被下一次 BEGIN 隐式提交）；
      // 没有 `conn.release()` ⇒ 这里卡在 getConnection（connectionLimit 是 1）。
      expect(await repo.appendJournal({ turn: 3, ...t3 })).toBe('applied');
      expect(await count('command_log', ' WHERE `turn` = ?', [3])).toBe(1);
    } finally {
      await blocker.release();
      await blockerPool.end();
    }
  });

  it('文档属于别的工程 ⇒ 抛在任何一个字之前', async () => {
    const other = Document.create(OTHER_PROJECT);
    const t1 = step(
      other,
      storeyCreate({ projectId: OTHER_PROJECT, index: 0, elevationMm: 0, heightMm: 3000 }),
    );
    await expect(repo.appendJournal({ turn: 1, ...t1 })).rejects.toThrow(
      /属于工程 0193aa00-\S+，这个仓库绑的是/,
    );
    expect(await count('command_log')).toBe(0);
    expect(await count('element')).toBe(0);
    expect(await count('storey')).toBe(0);
  });

  it('楼层实体属于别的工程 ⇒ 抛（文档归属对了不等于每个实体都对了），且 element 一行都不写', async () => {
    const intruder: Entity = {
      kind: 'storey',
      id: '0193aa00-0000-7000-8000-0000000000e1' as EntityId,
      projectId: OTHER_PROJECT,
      index: 0,
      elevationMm: 0,
      heightMm: 3000,
    };
    const doc = Document.replaceEntities(
      Document.create(PROJECT_ID),
      new Map<EntityId, Entity>([[intruder.id, intruder]]),
    );
    await expect(
      repo.appendJournal({ turn: 1, patch: { upsert: [intruder], remove: [] }, doc }),
      // 正则按 Step 7 的 `notThisProject` 实际文案对齐：它是 `${what}属于工程`（"楼层 <id>属于工程"，
      // "属于"前无空格），brief 原文多写了个空格 ⇒ 匹配不上；这里去掉那个空格，判据强度不变
      // （仍要求"楼层 + 那枚 id + 属于工程"三段同现）。冲突已登记进报告。
    ).rejects.toThrow(/楼层 \S+属于工程/);
    expect(await count('element')).toBe(0);
    expect(await count('storey')).toBe(0);
    expect(await count('command_log')).toBe(0);
  });

  it('remove 的 id 在盘上不存在 ⇒ 抛（日志说要删的东西表上没有 = 两本账已经不对齐）', async () => {
    const { entries, wallId } = houseTurns();
    await repo.appendJournal(entries[0]!);
    await repo.appendJournal(entries[1]!);
    // 手工把墙那一行抹掉：core 不知道，补丁照旧带着它
    await pool.query('DELETE FROM `element` WHERE `id` = ?', [wallId]);
    const t3 = step(entries[1]!.doc, wallDelete({ wallId }));
    await expect(repo.appendJournal({ turn: 3, ...t3 })).rejects.toThrow(/盘上没有可删的 element/);
    expect(await count('command_log', ' WHERE `turn` = ?', [3])).toBe(0);
    expect(await count('project', ' WHERE `journal_turn` = ?', [2])).toBe(1);
  });

  it('删一整层 ⇒ element 与 storey 两张表跟着一起掉（P-7 的投影不漂）', async () => {
    const t1 = step(
      Document.create(PROJECT_ID),
      storeyCreate({ projectId: PROJECT_ID, index: 0, elevationMm: 0, heightMm: 3000 }),
    );
    const storeyA = (t1.patch.upsert[0] as Entity).id as EntityId;
    const t2 = step(
      t1.doc,
      wallCreate({
        storeyId: storeyA,
        start: { x: 0, y: 0 },
        end: { x: 4000, y: 0 },
        thicknessMm: 200,
        heightMm: 2800,
      }),
    );
    const t3 = step(
      t2.doc,
      storeyCreate({ projectId: PROJECT_ID, index: 1, elevationMm: 3000, heightMm: 3000 }),
    );
    const storeyB = (t3.patch.upsert[0] as Entity).id as EntityId;
    const entries: Turn[] = [
      { turn: 1, ...t1 },
      { turn: 2, ...t2 },
      { turn: 3, ...t3 },
    ];
    for (const e of entries) expect(await repo.appendJournal(e)).toBe('applied');
    expect(await count('storey')).toBe(2);

    const t4 = step(t3.doc, storeyDelete({ storeyId: storeyA }));
    expect(await repo.appendJournal({ turn: 4, ...t4 })).toBe('applied');
    expect(await count('storey')).toBe(1);
    expect(await count('storey', ' WHERE `id` = ?', [storeyB])).toBe(1);
    const left = (await rows<{ id: EntityId }>('SELECT `id` FROM `element` ORDER BY `id`')).map(
      (r) => r.id,
    );
    expect(left).toEqual([...t4.doc.entities.keys()].sort());
  });

  it('改标高只动楼层：`storey` 投影那一行跟着走，墙与点一个字不动', async () => {
    const { entries, storeyId } = houseTurns();
    await repo.appendJournal(entries[0]!);
    await repo.appendJournal(entries[1]!);
    const t3 = step(entries[1]!.doc, storeySetElevation({ storeyId, elevationMm: 3000 }));
    expect(await repo.appendJournal({ turn: 3, ...t3 })).toBe('applied');
    const s = await rows<{ index_no: number; elevation_mm: string | number; height_mm: string | number }>(
      'SELECT `index_no`, `elevation_mm`, `height_mm` FROM `storey` WHERE `id` = ?',
      [storeyId],
    );
    expect([s[0]?.index_no, Number(s[0]?.elevation_mm), Number(s[0]?.height_mm)]).toEqual([0, 3000, 3000]);
    // 这一发只碰了一行 element（楼层那行），且碰的是 turn 3 的那个 seq
    expect(
      await count(
        'element',
        ' WHERE `updated_seq` = (SELECT `seq` FROM `command_log` WHERE `turn` = 3)',
      ),
    ).toBe(1);
  });
});

describe('writeSnapshot', () => {
  beforeEach(async () => {
    await clearAll();
    await repo.createProject({ name: '样例房', schemaVersion: 1 });
  });

  it('快照落盘后 canonical() 逐字节回来（含经过 MySQL 的 JSON 规范化再回来）', async () => {
    const { entries } = houseTurns();
    await repo.appendJournal(entries[0]!);
    await repo.appendJournal(entries[1]!);
    const final = entries[1]!.doc;
    await repo.writeSnapshot(2, final);
    expect(await count('snapshot')).toBe(1);
    const got = await rows<{ payload: unknown }>(
      'SELECT `payload` FROM `snapshot` WHERE `journal_turn` = 2',
    );
    // Step 1 的 A 档读数顺带在这里落盘（判据不依赖它 —— asJsonValue 两支都能吃，这正是它存在的理由）
    process.stdout.write(`[t4] snapshot payload typeof = ${typeof got[0]?.payload}\n`);
    expect(
      decodeDocument({ table: 'snapshot', id: '2' }, got[0]?.payload).canonical(),
    ).toBe(final.canonical());
  });

  it('同一个 turn 落两份快照 ⇒ 抛（`uk_project_turn` 有活干，P-16 选裸 INSERT 的依据）', async () => {
    const { entries } = houseTurns();
    await repo.appendJournal(entries[0]!);
    await repo.writeSnapshot(1, entries[0]!.doc);
    await expect(repo.writeSnapshot(1, entries[0]!.doc)).rejects.toThrow(/Duplicate entry/);
    expect(await count('snapshot')).toBe(1);
  });

  it('文档属于别的工程 ⇒ 抛，`snapshot` 一行都不写', async () => {
    await expect(repo.writeSnapshot(1, Document.create(OTHER_PROJECT))).rejects.toThrow(
      /这个仓库绑的是/,
    );
    expect(await count('snapshot')).toBe(0);
  });
});
