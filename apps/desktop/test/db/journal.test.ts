import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'mysql2/promise';
import {
  Document,
  SCHEMA_VERSION,
  applyPatch,
  assertTruthSourceInvariants,
  storeyCreate,
  wallCreate,
  wallDelete,
  wallSetLoadBearing,
  type Command,
  type Entity,
  type EntityId,
  type Patch,
  type WallEntity,
} from '@dajia/core';
import { createDbPool } from '../../src/main/db/pool';
import { readMysqlEnv } from '../../src/main/db/env';
import { dropTestDatabase, ensureDatabase } from '../../src/main/db/database';
import { migrate } from '../../src/main/db/migrate';
import { ProjectRepository } from '../../src/main/db/repository';
import { encodeDocument, encodePatch } from '../../src/main/db/codec';

const env = readMysqlEnv();
// 红线同 repository.test.ts：库名由本文件写死，不抄 env（env.database 允许是 dajia）。
const DATABASE = 'dajia_test';
const PROJECT_ID = '0193aa00-0000-7000-8000-00000000000a' as EntityId;
const OTHER_PROJECT = '0193aa00-0000-7000-8000-00000000000f' as EntityId;
const BIG_JOURNAL_TURN = '9007199254740993'; // 2^53 + 1：JS 里存不成整数

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

async function cleanShutdown(): Promise<number> {
  const got = await rows<{ clean_shutdown: number | string }>(
    'SELECT `clean_shutdown` FROM `project` WHERE `id` = ?',
    [PROJECT_ID],
  );
  return Number(got[0]?.clean_shutdown);
}

/** 清场同 repository.test.ts：只删 project 行，FK 级联带走其余四张。 */
async function clearAll(): Promise<void> {
  await pool.query('DELETE FROM `project`');
}

/**
 * 夹具与 repository.test.ts 同形，**故意复制而非 import**：import 一个测试文件会把那个文件的
 * 用例一起执行一遍（vitest 按模块跑），那是"一条用例被两个文件各认一次"的另一种发生方式。
 * 复制的是夹具，不是判据 —— 读路径的放行证只有 `loadProject` 里那一份。
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

interface House {
  readonly entries: Turn[];
  readonly storeyId: EntityId;
  readonly wallA: EntityId;
  readonly wallB: EntityId;
}

/**
 * 五发：楼层 → 墙 A → 墙 B（与 A 共端点，于是 A 的起点是它独占的）→ 改 A 的非承重 → 删 A。
 * 第五发带 remove ⇒ 它既是最后一发，也是"重复投喂必炸"的那一发（`快照压在最后一发` 的牙长在这儿）。
 */
function houseTurns(): House {
  const t1 = step(
    Document.create(PROJECT_ID),
    storeyCreate({ projectId: PROJECT_ID, index: 0, elevationMm: 0, heightMm: 3000 }),
  );
  const storeyId = (t1.patch.upsert.find((e) => e.kind === 'storey') as Entity).id as EntityId;
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
  const wallA = (t2.patch.upsert.find((e) => e.kind === 'wall') as Entity).id as EntityId;
  const t3 = step(
    t2.doc,
    wallCreate({
      storeyId,
      start: { x: 4000, y: 0 },
      end: { x: 4000, y: 3000 },
      thicknessMm: 150,
      heightMm: 2800,
    }),
  );
  const wallB = (t3.patch.upsert.find((e) => e.kind === 'wall') as Entity).id as EntityId;
  const t4 = step(t3.doc, wallSetLoadBearing({ wallId: wallA, loadBearing: false }));
  const t5 = step(t4.doc, wallDelete({ wallId: wallA }));
  return {
    entries: [
      { turn: 1, ...t1 },
      { turn: 2, ...t2 },
      { turn: 3, ...t3 },
      { turn: 4, ...t4 },
      { turn: 5, ...t5 },
    ],
    storeyId,
    wallA,
    wallB,
  };
}

/** 建工程 + 把五发按 turn 顺序写进库。返回的 entries[i].doc 就是"第 i+1 发之后的终态"。 */
async function writeHouse(r: ProjectRepository = repo): Promise<House> {
  const house = houseTurns();
  await r.createProject({ name: '读路径样例', schemaVersion: SCHEMA_VERSION });
  for (const entry of house.entries) {
    expect(await r.appendJournal(entry)).toBe('applied');
  }
  return house;
}

const last = (house: House): Document => {
  const entry = house.entries[house.entries.length - 1];
  if (!entry) throw new TypeError('夹具一发都没写，后面的判据都不用读了');
  return entry.doc;
};
const at = (house: House, turn: number): Document => {
  const entry = house.entries[turn - 1];
  if (!entry) throw new TypeError(`夹具没有 turn ${turn}`);
  return entry.doc;
};

beforeAll(async () => {
  await dropTestDatabase(env, DATABASE);
  await ensureDatabase(env, DATABASE);
  // P-65（Task 4 收口时定下的一条）：`multipleStatements` **只准住在迁移连接上**。
  // 001 的正文是多条 DDL，不带它的池跑 migrate 当场 ER_PARSE_ERROR(1064)（migrate.ts 顶部第 ① 条），
  // 所以这里给迁移单开一条池、迁完就 end；下面两档池（`pool` 的手搓 SQL 与仓库的 `repoPool`）
  // 都保持单语句 —— 把它们合成一条"图省事"的池等于给任何一处字符串拼接留出多语句通道。
  const migratePool = createDbPool({ ...env, database: DATABASE }, { multipleStatements: true });
  await migrate(migratePool, DATABASE);
  await migratePool.end();
  pool = createDbPool({ ...env, database: DATABASE });
  // 与 repository.test.ts 同一条纪律：一条连接 + 1 秒行锁等待 ⇒ 少一次 release() 会当场变成超时，
  // 而不是悄悄多用一条连接把漏检盖住（`读路径不漏连接` 那一格用它）。
  repoPool = createDbPool(
    { ...env, database: DATABASE },
    { connectionLimit: 1, lockWaitTimeoutSeconds: 1 },
  );
  repo = new ProjectRepository(repoPool, PROJECT_ID, 'reader');
});

afterAll(async () => {
  await repoPool.end();
  await pool.end();
  await dropTestDatabase(env, DATABASE);
});

beforeEach(async () => {
  await clearAll();
});

describe('加载 = 最近快照 + 重放其后的日志', () => {
  it('没有快照时全靠重放：五发之后 load 得到同一份文档', async () => {
    const house = await writeHouse();
    const got = await repo.loadProject('edit');
    expect(got.snapshot).toBeNull();
    expect(got.replayed).toEqual({ rows: 5, fromSeq: expect.any(Number), toSeq: expect.any(Number) });
    // 上面那行只断"是个 Number"⇒ 把 fromSeq/toSeq 对调（或让 fromSeq 记末行）它照样绿。这里补**相对**判据：
    // 绝不写绝对 seq 数字（P-6 之后 seq 可带洞、每发都在漂，写死等于复制判据），只断端点同向 + 与外部一次
    // 独立 SELECT 逐值对齐 —— 两次读数来自两条语句，把 fromSeq 记成末行会红在这里。
    const { fromSeq, toSeq } = got.replayed;
    if (fromSeq === null || toSeq === null) throw new TypeError('重放了五发，端点不该是 null');
    expect(fromSeq <= toSeq).toBe(true);
    const snapTurn = got.snapshot?.turn ?? 0; // 本格没有快照（上面刚断过 null）⇒ 重放覆盖 turn > 0 的全部行
    const edges = await rows<{ lo: number | string; hi: number | string }>(
      'SELECT MIN(`seq`) AS lo, MAX(`seq`) AS hi FROM `command_log` WHERE `project_id` = ? AND `turn` > ?',
      [PROJECT_ID, snapTurn],
    );
    const edge = edges[0];
    if (!edge) throw new TypeError('command_log 一行都没有，端点判据没处对');
    expect([Number(edge.lo), Number(edge.hi)]).toEqual([fromSeq, toSeq]);
    expect(got.doc.canonical()).toBe(last(house).canonical());
    expect(got.header.journalTurn).toBe(5);
    expect(got.header.name).toBe('读路径样例');
    expect(got.doc.byKind('wall').map((w) => w.id)).toEqual([house.wallB]);
  });

  it('有快照时只重放其后的发：快照落在第 3 发 ⇒ 重放 2 发', async () => {
    const house = await writeHouse();
    await repo.writeSnapshot(3, at(house, 3));
    const got = await repo.loadProject('edit');
    expect(got.snapshot?.turn).toBe(3);
    expect(got.replayed.rows).toBe(2);
    expect(got.doc.canonical()).toBe(last(house).canonical());
  });

  it('快照正好压在最后一发 ⇒ 重放 0 发（`>` 写成 `>=` 就红在这里：第五发的 remove 会被投喂两次）', async () => {
    const house = await writeHouse();
    await repo.writeSnapshot(5, last(house));
    const got = await repo.loadProject('edit');
    expect(got.replayed).toEqual({ rows: 0, fromSeq: null, toSeq: null });
    expect(got.doc.canonical()).toBe(last(house).canonical());
  });

  it('加载出来的文档自己过得了放行证（不是复制判据，是把"load 成功"与"不变式成立"钉在同一份文档上）', async () => {
    await writeHouse();
    const got = await repo.loadProject('edit');
    expect(() => assertTruthSourceInvariants(got.doc)).not.toThrow();
  });

  it('重发旧 turn 说 already-applied，且加载结果逐字节不变（turn 幂等的读侧另一半）', async () => {
    const house = await writeHouse();
    const before = await repo.loadProject('edit');
    const first = house.entries[0];
    const tail = house.entries[4];
    if (!first || !tail) throw new TypeError('夹具塌了');
    expect(await repo.appendJournal(first)).toBe('already-applied');
    expect(await repo.appendJournal(tail)).toBe('already-applied');
    const after = await repo.loadProject('edit');
    expect(after.replayed.rows).toBe(before.replayed.rows);
    expect(after.doc.canonical()).toBe(before.doc.canonical());
    expect(after.header.journalTurn).toBe(5);
  });

  it('seq 可以带洞而 turn 不行：造一发回滚 ⇒ 洞真在盘上，加载照旧（P-6 的凭据）', async () => {
    const house = await writeHouse();
    const removed = house.entries[4]?.patch.remove[0];
    if (!removed) throw new TypeError('第五发没有 remove，夹具塌了');
    // 手搓一发"日志说要删、表上已经没有"的补丁：appendJournal 在 INSERT command_log 之后才抛，
    // 事务回滚 ⇒ 日志行没留下，但那个 AUTO_INCREMENT 值已被 MySQL 吃掉 ⇒ 洞在 max 之后。
    await expect(
      repo.appendJournal({ turn: 6, patch: { upsert: [], remove: [removed] }, doc: last(house) }),
    ).rejects.toThrow(/没有可删的 element/);
    // 洞之后仍要能正常记账：turn 6 现在可以正经写一次（这一发把 seq 推到洞之后）。
    // 注意方向：wallB 是 wallCreate 默认出来的，默认就是承重（`input.loadBearing ?? true`），
    // 所以这一发必须翻成 false 才是一次真变更 —— 写 `true` 它也会落一行，但断言变成同义反复。
    const t6 = step(last(house), wallSetLoadBearing({ wallId: house.wallB, loadBearing: false }));
    expect(await repo.appendJournal({ turn: 6, patch: t6.patch, doc: t6.doc })).toBe('applied');

    const edges = await rows<{ lo: string; hi: string; n: string }>(
      'SELECT MIN(`seq`) AS lo, MAX(`seq`) AS hi, COUNT(*) AS n FROM `command_log` WHERE `project_id` = ?',
      [PROJECT_ID],
    );
    const edge = edges[0];
    if (!edge) throw new TypeError('command_log 一行都没有');
    // 跨度 > 行数 ⇒ 洞真在盘上。**判据只读相对关系**：P-6 之后任何绝对 seq 值每发都在漂。
    expect(Number(edge.hi) - Number(edge.lo) + 1).toBeGreaterThan(Number(edge.n));
    expect(Number(edge.n)).toBe(6);

    const got = await repo.loadProject('edit');
    expect(got.replayed.rows).toBe(6);
    // 断言写 `false` 才有牙：wallB 由 wallCreate 默认出来就是承重 `true`，
    // 只有第六发真进了重放，读到的才是被翻过去的 `false`。
    // 连"只剩这一面墙"一起断，免得 byKind 多塞一行还读成同一个值。
    expect(got.doc.byKind('wall').map((w) => [w.id, w.loadBearing])).toEqual([[house.wallB, false]]);
  });

  it('读到的 turn 序列严格递增，且 ORDER BY seq 与 ORDER BY turn 给出同一个 seq 顺序（"同向"这件事要量，不许默认成立）', async () => {
    await writeHouse();
    const bySeq = await rows<{ seq: string; turn: string }>(
      'SELECT `seq`, `turn` FROM `command_log` WHERE `project_id` = ? ORDER BY `seq` ASC',
      [PROJECT_ID],
    );
    const byTurn = await rows<{ seq: string; turn: string }>(
      'SELECT `seq`, `turn` FROM `command_log` WHERE `project_id` = ? ORDER BY `turn` ASC',
      [PROJECT_ID],
    );
    expect(bySeq.map((r) => r.seq)).toEqual(byTurn.map((r) => r.seq));
    expect(bySeq.map((r) => Number(r.turn))).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('拒开：盘上账本不该被静默圆回来的那些形状', () => {
  it('工程不在库里 ⇒ 拒开，且文案点名它', async () => {
    await repo.createProject({ name: '只建不开', schemaVersion: SCHEMA_VERSION });
    await pool.query('DELETE FROM `project` WHERE `id` = ?', [PROJECT_ID]);
    await expect(repo.loadProject('edit')).rejects.toThrow(new RegExp(`工程 ${PROJECT_ID} 不在库里`));
  });

  it('project.schema_version 与这份程序不符 ⇒ 拒开（不是"能读多少算多少"）', async () => {
    const future = new ProjectRepository(repoPool, OTHER_PROJECT, 'reader');
    await future.createProject({ name: '来自未来', schemaVersion: SCHEMA_VERSION + 98 });
    await expect(future.loadProject('edit')).rejects.toThrow(/schema_version/);
  });

  it('snapshot 列上的 schema_version 与工程头不符 ⇒ 拒开', async () => {
    await writeHouse();
    // Document 的 schemaVersion 只能由 create 定；writeSnapshot 把它同时写进列与 payload。
    await repo.writeSnapshot(5, Document.create(PROJECT_ID, SCHEMA_VERSION + 7));
    await expect(repo.loadProject('edit')).rejects.toThrow(/schema_version/);
  });

  it('snapshot payload 里的 schemaVersion 与工程头不符 ⇒ 也拒开（列与正文是两条支路，各一条牙）', async () => {
    await writeHouse();
    await pool.query(
      'INSERT INTO `snapshot` (`project_id`, `journal_turn`, `schema_version`, `payload`) VALUES (?, ?, ?, ?)',
      [PROJECT_ID, 5, SCHEMA_VERSION, encodeDocument(Document.create(PROJECT_ID, SCHEMA_VERSION + 7), 5)],
    );
    await expect(repo.loadProject('edit')).rejects.toThrow(/payload/);
  });

  it('snapshot payload 的 projectId 是别的工程 ⇒ 拒开（键与正文各说各话时，正文不算数）', async () => {
    await writeHouse();
    await pool.query(
      'INSERT INTO `snapshot` (`project_id`, `journal_turn`, `schema_version`, `payload`) VALUES (?, ?, ?, ?)',
      [PROJECT_ID, 5, SCHEMA_VERSION, encodeDocument(Document.create(OTHER_PROJECT, SCHEMA_VERSION), 5)],
    );
    await expect(repo.loadProject('edit')).rejects.toThrow(new RegExp(`payload 写的是工程 ${OTHER_PROJECT}`));
  });

  it('快照的列与正文说的是不同的一发 ⇒ 拒开（列快于正文、正文快于列两个方向各一发）', async () => {
    // P-70 的那一型，也是本计划最难查的一型：列写 5、正文只到 turn 3 ⇒ 下面那条
    // `AND turn > replayFrom` 会跳过 4 与 5 ⇒ 交出一份"形状全对"的旧文档。
    // 上面三条判据（版本列 / 版本正文 / 工程归属）一条都不管这根turn 轴，
    // 所以它必须有自己的一条。
    // 夹具注意：writeHouse() 已经建过工程并写了五发，**别再调createProject**（撞主键会红在错误的原因上）。
    const house = await writeHouse();
    // 方向一：列快于正文（列 5、正文只到 3）
    await pool.query('DELETE FROM `snapshot`');
    await pool.query(
      'INSERT INTO `snapshot` (`project_id`, `journal_turn`, `schema_version`, `payload`) VALUES (?, ?, ?, ?)',
      [PROJECT_ID, 5, SCHEMA_VERSION, encodeDocument(at(house, 3), 3)],
    );
    await expect(repo.loadProject('read')).rejects.toThrow(/不是同一发，拒开/);

    // 方向二：正文快于列（列 3、正文到 5）
    await pool.query('DELETE FROM `snapshot`');
    await pool.query(
      'INSERT INTO `snapshot` (`project_id`, `journal_turn`, `schema_version`, `payload`) VALUES (?, ?, ?, ?)',
      [PROJECT_ID, 3, SCHEMA_VERSION, encodeDocument(at(house, 5), 5)],
    );
    await expect(repo.loadProject('read')).rejects.toThrow(/不是同一发，拒开/);

    // 反向对照：列与正文同一发时必须正常打开 —— 否则这一格证的是别的东西
    //（夹具歪了、或者前面的判据抢了它），不是 P-70 那一型。
    await pool.query('DELETE FROM `snapshot`');
    await pool.query(
      'INSERT INTO `snapshot` (`project_id`, `journal_turn`, `schema_version`, `payload`) VALUES (?, ?, ?, ?)',
      [PROJECT_ID, 5, SCHEMA_VERSION, encodeDocument(at(house, 5), 5)],
    );
    await expect(repo.loadProject('read')).resolves.toBeDefined();
  });

  it('中间缺一发日志 ⇒ 拒开并说"缺号"（无静默丢失的反面就是静默补洞）', async () => {
    await writeHouse();
    await pool.query('DELETE FROM `command_log` WHERE `project_id` = ? AND `turn` = 3', [PROJECT_ID]);
    await expect(repo.loadProject('edit')).rejects.toThrow(/缺号/);
  });

  it('尾缺一发日志 ⇒ 拒开（逐发连着仍然成立，只有工程头能看出来）', async () => {
    await writeHouse();
    await pool.query('DELETE FROM `command_log` WHERE `project_id` = ? AND `turn` = 5', [PROJECT_ID]);
    await expect(repo.loadProject('edit')).rejects.toThrow(/journal_turn/);
  });

  it('手插一发跳号的日志 ⇒ 拒开（UPDATE 造出来的洞与 DELETE 造出来的洞落在同一条判据的两端）', async () => {
    await writeHouse();
    await pool.query('UPDATE `command_log` SET `turn` = 9 WHERE `project_id` = ? AND `turn` = 5', [PROJECT_ID]);
    await expect(repo.loadProject('edit')).rejects.toThrow(/缺号/);
  });

  it('重放撞空行 ⇒ 抛的文案带 command_log 的行号与 turn（没有坐标的"重放失败"等于没报）', async () => {
    const house = await writeHouse();
    const removed = house.entries[4]?.patch.remove[0];
    if (!removed) throw new TypeError('第五发没有 remove，夹具塌了');
    // 同一发删除投两次（绕过 appendJournal 手插，所以 turn 连着、坐标落在最后一行上）。
    await pool.query(
      'INSERT INTO `command_log` (`project_id`, `turn`, `actor`, `payload`) VALUES (?, ?, ?, ?)',
      [PROJECT_ID, 6, 'attacker', encodePatch({ upsert: [], remove: [removed] })],
    );
    await expect(repo.loadProject('edit')).rejects.toThrow(/command_log 行 \d+（turn 6）/);
  });

  /**
   * 上面那一格撞的是 `applyPatch`（remove 撞空行），所以它看不见重放尽头的那道放行证 ——
   * 实测：删掉 `assertTruthSourceInvariants(doc)`（T5-M10）时 `journal+repo` 靶全绿（补法落地后才有红相）。
   * 这里补一发只走那道门的：
   * 补丁本身合法（zod 过、applyPatch 过，改的是自己家的墙 B），坏在引用指向**别人**的实体 id，
   * 只有引用完整性判据看得见它。
   *
   * brief 给 T5-M10 的补法（把上一格的 payload 直接换成这种 upsert）实测**不可达**：它的 turn 6
   * 没有同步把 `project.journal_turn` 推上去 ⇒ 先撞收尾判据（`重放读到 turn 6，journal_turn 记的是 5`），
   * 根本走不到那一行（`tmp/t5-mut-T5-M10fix-journal+repo.log`）。所以这里把头寸一并写成 6，
   * 并且**新起一格**而不是改上一格 —— 上一格的坐标文案判据还得留着。
   */
  it('重放出来的文档形状全对、端点指向别人的实体 ⇒ 只有那道放行证拦得住（T5-M10 的可达补法）', async () => {
    const house = await writeHouse();
    const wallB = last(house).get(house.wallB);
    if (!wallB) throw new TypeError('夹具的墙 B 不在终态文档里，这一发没处打');
    await pool.query(
      'INSERT INTO `command_log` (`project_id`, `turn`, `actor`, `payload`) VALUES (?, ?, ?, ?)',
      [
        PROJECT_ID,
        6,
        'attacker',
        encodePatch({
          // 显式的 `WallEntity` 形状（原来是 `as never`：它把整个表达式连形状一起打掉，
          // 而 OTHER_PROJECT 本身就是 EntityId，根本不需要 never）。
          // "这一发在盘上是脏数据"的语义一点没变：脏在**值**指错工程（startId 指向别人的实体 id），
          // encodePatch 不校验、zod 也照样过，只有引用完整性那道放行证看得见它。
          upsert: [{ ...(wallB as WallEntity), startId: OTHER_PROJECT }],
          remove: [],
        }),
      ],
    );
    await pool.query('UPDATE `project` SET `journal_turn` = 6 WHERE `id` = ?', [PROJECT_ID]);
    await expect(repo.loadProject('edit')).rejects.toThrow(/墙起点 不存在/);
    // 拒开不许留下"这里曾打开过"的痕迹，靠的是**顺序**而不是回滚：edit 支那发抹 0 排在所有拒开判据之后
    //（本格的抛点在放行证那一步，抹 0 在它下面），所以拒开天然无痕。
    // 这一格守的就是这个顺序，它同时是"别把抹 0 提到事务前面"的哨兵 —— 提上来的话这里当场红。
    expect(await cleanShutdown()).toBe(1);
  });

  it('journal_turn 超出 JS 安全整数 ⇒ 抛，不是悄悄失精（这一格同时是 P-17 那条 supportBigNumbers 的牙）', async () => {
    await writeHouse();
    await pool.query('UPDATE `project` SET `journal_turn` = ? WHERE `id` = ?', [
      BIG_JOURNAL_TURN,
      PROJECT_ID,
    ]);
    const read = await rows<{ journal_turn: unknown }>(
      'SELECT `journal_turn` FROM `project` WHERE `id` = ?',
      [PROJECT_ID],
    );
    process.stdout.write(
      `[T5] journal_turn 读数 typeof=${String(typeof read[0]?.journal_turn)} value=${String(read[0]?.journal_turn)}\n`,
    );
    await expect(repo.loadProject('edit')).rejects.toThrow(/安全整数/);
  });
});

describe('clean_shutdown 与恢复告知', () => {
  it('新建工程就是 1：没人动过的账不需要恢复', async () => {
    await repo.createProject({ name: '新工程', schemaVersion: SCHEMA_VERSION });
    expect(await cleanShutdown()).toBe(1);
  });

  it('edit 打开落 0、closeProject 回 1、再开得 true', async () => {
    const house = await writeHouse();
    const open = await repo.loadProject('edit');
    expect(open.header.wasCleanShutdown).toBe(true);
    expect(await cleanShutdown()).toBe(0);
    await repo.closeProject(last(house));
    expect(await cleanShutdown()).toBe(1);
    expect((await repo.loadProject('edit')).header.wasCleanShutdown).toBe(true);
  });

  it('连开两次：第二次报 false（它**不是**"那条 UPDATE 不许加 affectedRows 断言"的证人，理由见下面四行）', async () => {
    // 标题原先写"这一格也是那条纪律的证人"（brief 原文）—— 实测**不成立**，所以这一发改口只改标题：
    // 给那条 UPDATE 加 `affectedRows === 1` 断言（T5-M15）时 `journal+repo` 靶全绿，这一格照样过 ——
    // 同一条语句还写 `updated_at = NOW(3)`，重复打开时行确实变了 ⇒ affectedRows 是 1 不是 0。
    // 但"绿"是**时序运气**而不是证明：`updated_at` 是 DATETIME(3)（001_init.sql:23 ⇒ 毫秒粒度），
    // 两次打开落在同一毫秒时它不变、头寸又是 0→0 ⇒ 那一发 affectedRows 就是 0，断言当场抛。
    // 于是全仓没有任何一格能**稳定**抓住那条断言 ⇒ 连绿也别当成证明。
    // 这条判据真正的落脚点在 repository.ts 那段注释里（"押在 updated_at 上的断言"），不在这一格。
    await writeHouse();
    expect((await repo.loadProject('edit')).header.wasCleanShutdown).toBe(true);
    expect((await repo.loadProject('edit')).header.wasCleanShutdown).toBe(false);
    expect((await repo.loadProject('edit')).header.wasCleanShutdown).toBe(false);
  });

  it('read 意图只读不写：旁观者不把别人的告别信号抹脏（T6 拿不到锁走的就是这一支）', async () => {
    await writeHouse();
    const seen = await repo.loadProject('read');
    expect(seen.header.wasCleanShutdown).toBe(true);
    expect(await cleanShutdown()).toBe(1);
    expect((await repo.loadProject('read')).header.wasCleanShutdown).toBe(true);
  });

  it('没告别就"崩"：换仓库实例重开 ⇒ 报告里既有未收尾信号，也有未合并的片段数', async () => {
    const house = await writeHouse();
    await repo.writeSnapshot(2, at(house, 2));
    await repo.loadProject('read'); // 旁观一次，不抹信号
    const crashed = new ProjectRepository(repoPool, PROJECT_ID, 'reopener');
    const got = await crashed.loadProject('edit');
    expect(got.header.wasCleanShutdown).toBe(true); // 上一发是 read，所以还没落 0
    expect(got.snapshot?.turn).toBe(2);
    expect(got.replayed.rows).toBe(3); // 未合并片段 = 快照之后那 3 发，全靠重放取回
    expect(got.doc.canonical()).toBe(last(house).canonical());
    // 现在才是真"没告别"：edit 打开之后不再收尾，换实例重开。
    const reopened = await new ProjectRepository(repoPool, PROJECT_ID, 'third').loadProject('edit');
    expect(reopened.header.wasCleanShutdown).toBe(false);
    expect(reopened.replayed.rows).toBe(3);
  });

  it('收尾不删账：closeProject 之后 command_log 与 element 都还在', async () => {
    const house = await writeHouse();
    await repo.loadProject('edit');
    await repo.closeProject(last(house));
    expect(await count('command_log', ' WHERE `project_id` = ?', [PROJECT_ID])).toBe(5);
    expect(await count('element', ' WHERE `project_id` = ?', [PROJECT_ID])).toBe(
      last(house).entities.size,
    );
  });
});

describe('closeProject 的三方对账', () => {
  it('平账的收尾：报行数，且 clean_shutdown 回到 1', async () => {
    const house = await writeHouse();
    await repo.loadProject('edit');
    const report = await repo.closeProject(last(house));
    expect(report.elementRows).toBe(last(house).entities.size);
    expect(report.storeyRows).toBe(1);
    expect(await cleanShutdown()).toBe(1);
  });

  it('storey 表少一行 ⇒ 抛且点名 element↔storey 与那一行的 id，且不落 1', async () => {
    const house = await writeHouse();
    await repo.loadProject('edit');
    await pool.query('DELETE FROM `storey` WHERE `id` = ?', [house.storeyId]);
    await expect(repo.closeProject(last(house))).rejects.toThrow(/element↔storey/);
    await expect(repo.closeProject(last(house))).rejects.toThrow(new RegExp(house.storeyId));
    expect(await cleanShutdown()).toBe(0);
  });

  it('storey.elevation_mm 差 1 毫米 ⇒ 抛且点名 elevationMm（整行比对只会说"不等"，不会说哪里不等）', async () => {
    const house = await writeHouse();
    await repo.loadProject('edit');
    await pool.query('UPDATE `storey` SET `elevation_mm` = `elevation_mm` + 1 WHERE `id` = ?', [
      house.storeyId,
    ]);
    await expect(repo.closeProject(last(house))).rejects.toThrow(/elevationMm/);
    expect(await cleanShutdown()).toBe(0);
  });

  it('element.storey_id 列被手改 ⇒ 抛且点名 element.storey_id↔payload', async () => {
    const house = await writeHouse();
    await repo.loadProject('edit');
    await pool.query('UPDATE `element` SET `storey_id` = NULL WHERE `id` = ?', [house.wallB]);
    const message = await repo.closeProject(last(house)).then(
      () => '没抛，判据塌了',
      (err: unknown) => String(err),
    );
    expect(message).toMatch(/element\.storey_id↔payload/);
    expect(message).toMatch(new RegExp(house.wallB));
  });

  it('element 少一行 ⇒ 只有 document↔element 报它（删一行时"列"与"正文"一起消失，行内自比只剩这一个证人，那个 id 至少出现一次）；"两对同时报"由下面那格认', async () => {
    const house = await writeHouse();
    await repo.loadProject('edit');
    await pool.query('DELETE FROM `element` WHERE `id` = ?', [house.wallB]);
    const message = await repo.closeProject(last(house)).then(
      () => '没抛，判据塌了',
      (err: unknown) => String(err),
    );
    expect(message).toMatch(/document↔element/);
    // 原文要"出现两次以上"，实测只有一对报它 —— 删掉一行 element 时"列"与"正文"是一起消失的
    // （那半对是行内自比，行没了就没有可比的两列），所以第二个证人根本不存在。
    // 真正的"两对同时报"是删**楼层的 element 行**（document↔element 与 element↔storey 各报一次同一个 id），
    // 那一型由下面那格 `删楼层的 element 行 ⇒ 两对同时报` 认，判据强度不降（原文那半句仍然成立）。
    expect(message.split(house.wallB).length - 1).toBeGreaterThanOrEqual(1);
    expect(message).toMatch(/command_log/);
    expect(await cleanShutdown()).toBe(0);
  });

  it('删楼层的 element 行 ⇒ 两对同时报，同一个 id 在文案里出现两次以上（原文那句"两对"的真实形状）', async () => {
    const house = await writeHouse();
    await repo.loadProject('edit');
    await pool.query('DELETE FROM `element` WHERE `id` = ?', [house.storeyId]);
    const message = await repo.closeProject(last(house)).then(
      () => '没抛，判据塌了',
      (err: unknown) => String(err),
    );
    expect(message).toMatch(/document↔element/);
    expect(message).toMatch(/element↔storey/);
    expect(message.split(house.storeyId).length - 1).toBeGreaterThanOrEqual(2);
    expect(await cleanShutdown()).toBe(0);
  });

  it('文档多一发（渲染器画了但那一发没落盘）⇒ 抛，且重开拿到的是日志那一份：既不静默丢，也不静默多算', async () => {
    const house = await writeHouse();
    await repo.loadProject('edit');
    // 只在内存里加一面墙，不写库 —— 就是"改了没保存"的那一发。
    const unsaved = step(
      last(house),
      wallCreate({
        storeyId: house.storeyId,
        start: { x: 0, y: 0 },
        end: { x: 0, y: 3000 },
        thicknessMm: 200,
        heightMm: 2800,
      }),
    );
    await expect(repo.closeProject(unsaved.doc)).rejects.toThrow(/document↔element/);
    const reopened = await repo.loadProject('edit');
    expect(reopened.doc.canonical()).toBe(last(house).canonical());
    expect(reopened.header.wasCleanShutdown).toBe(false);
    expect(reopened.replayed.rows).toBe(5);
  });

  it('不属于本工程的照片不收：拿别人的文档收尾 ⇒ 抛，且不动 clean_shutdown', async () => {
    await writeHouse();
    await repo.loadProject('edit');
    await expect(repo.closeProject(Document.create(OTHER_PROJECT, SCHEMA_VERSION))).rejects.toThrow(
      /属于工程/,
    );
    expect(await cleanShutdown()).toBe(0);
  });

  it('project 行本身没了（FK 级联带走投影）⇒ 收尾抛"没有可收尾的账"，不是悄悄报一个平账', async () => {
    const house = await writeHouse();
    await repo.loadProject('edit');
    // 清场用的同一条语句：只删 project 行，element / storey / command_log / snapshot 由 FK 级联带走。
    await pool.query('DELETE FROM `project` WHERE `id` = ?', [PROJECT_ID]);
    await expect(repo.closeProject(last(house))).rejects.toThrow(/没有可收尾的账/);
    // 判据在 closeProject 锁行那一步（SELECT id FROM project ... FOR UPDATE 回 0 行 ⇒ 抛），今天零证人：
    // 其余收尾用例都留着 project 行。摘掉那一支的话"投影被级联清空 + 文档非空"会改走 document↔element
    // 的 left-only，同样抛、同样不落 1 ⇒ 只有这一格能区分"没有可收尾的账"与"账对不平"。加格不加判据。
    expect(await count('element', ' WHERE `project_id` = ?', [PROJECT_ID])).toBe(0);
  });

  it('读路径不漏连接：connectionLimit=1 的池上连开两次再收尾都成功（少一次 release 就变成等 1 秒超时）', async () => {
    // 原文这里是 `const house = await writeHouse();`，但这一格通篇只用 `a`/`b` 两份 load 回来的文档
    // —— 绑一个不用的名字在 `noUnusedLocals` 下直接编译不过（tsconfig.test.json 会红在本格）。
    // 判据不变：这一格证的是"三次取连接都还得回去"，与夹具返回值无关。
    await writeHouse();
    const a = await repo.loadProject('edit');
    const b = await repo.loadProject('edit');
    expect(a.doc.canonical()).toBe(b.doc.canonical());
    await repo.closeProject(b.doc);
    expect((await repo.loadProject('edit')).header.wasCleanShutdown).toBe(true);
    expect(await cleanShutdown()).toBe(0);
  });
});
