import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from 'mysql2/promise';
import type { Pool } from 'mysql2/promise';
import { createDbPool } from '../../src/main/db/pool';
import { readMysqlEnv } from '../../src/main/db/env';
import { dropTestDatabase, ensureDatabase } from '../../src/main/db/database';
import { SCHEMA_TABLE, migrate } from '../../src/main/db/migrate';
import { MIGRATIONS, type Migration } from '../../src/main/db/migrations';

const env = readMysqlEnv();
const database = 'dajia_test';
let pool: Pool;

/**
 * **一个打不通的实例**（127.0.0.1:1 —— 端口 1 上没有 MySQL，实测 2ms 回 `ECONNREFUSED`，
 * 见 `tmp/plan4-t2fix-probe.log` 的 C 条）。它只用来把**顺序**变成判据（P-47 / P-48）：
 * 白名单闸若在发 SQL 之后，喂给它非法名字拿到的会是连接错误；闸在之前 ⇒ 拿到的是白名单文案。
 * 于是"挪走闸就红"这件事由断言的**错误种类**接住，而不是靠"总有什么红了"。
 * 它永远连不到真实例 ⇒ 那 15 个用户库一个字都碰不到。
 */
const unreachableEnv = { ...env, host: '127.0.0.1', port: 1 };

beforeAll(async () => {
  await dropTestDatabase(env, database);
  await ensureDatabase(env, database);
  pool = createDbPool({ ...env, database }, { multipleStatements: true });
});

afterEach(async () => {
  // **P-50**：清表不照固定名单，而是 `SHOW TABLES` 读什么清什么。
  // 原来这里写死七张表，而"坏迁移"那两格会留下名单之外的探针表（`needs_missing_ref` / `late_add`），
  // 于是第一格那条严格 `toEqual` 只是**恰好**在声明顺序下绿（第 4 格的残留排在它后面）。
  // T3..T7 会把这套夹具复制出去 ⇒ 顺序耦合不该跟着复制。清全部之后，每个用例起手都是一张表都没有的空库，
  // 用例之间不再有先后前提（这一条的验收方式：把本文件的 `it` 打乱重跑，全套仍绿）。
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  const [tables] = await pool.query('SHOW TABLES');
  for (const row of tables as Record<string, string>[]) {
    // 名字来自服务端自己回报的 `SHOW TABLES`，不是外部输入；`DROP TABLE` 不能参数化，
    // 反引号插值在这里没有第二条路（库本身是 dajia_test，能出现在里面的只有本文件的夹具）。
    const table = Object.values(row)[0];
    await pool.query(`DROP TABLE IF EXISTS \`${table}\``);
  }
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');
});

afterAll(async () => {
  await pool.end();
  await dropTestDatabase(env, database);
});

describe('迁移 runner', () => {
  it('空库上跑一次建齐六张表，再跑一次是整批 no-op（幂等）', async () => {
    const first = await migrate(pool, database);
    expect(first.applied).toEqual([1]);
    expect(first.alreadyApplied).toEqual([]);
    const second = await migrate(pool, database);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual([1]);

    const [rows] = await pool.query('SHOW TABLES');
    const tables = (rows as Record<string, string>[]).map((r) => Object.values(r)[0]).sort();
    expect(tables).toEqual(['_migration', 'asset', 'command_log', 'element', 'project', 'snapshot', 'storey'].sort());
  });

  it('_migration 记下版本、名字与校验和', async () => {
    await migrate(pool, database);
    const [rows] = await pool.query(`SELECT \`version\`, \`name\`, \`checksum\` FROM \`${SCHEMA_TABLE}\``);
    const got = (rows as { version: number; name: string; checksum: string }[])[0];
    expect(got?.version).toBe(1);
    expect(got?.name).toBe('init');
    expect(got?.checksum).toBe(MIGRATIONS[0]?.checksum);
  });

  it('改过已应用的迁移 ⇒ 抛，且不碰库里已有的表', async () => {
    await migrate(pool, database);
    const tampered: Migration[] = [{ ...MIGRATIONS[0]!, checksum: 'f'.repeat(64) }];
    await expect(migrate(pool, database, tampered)).rejects.toThrow(/被改过/);
  });

  it('坏迁移停在半途：前一版本留下、坏版本不记账，重放能修好（DDL 隐式提交照 P-11 的形状兜住）', async () => {
    const broken: Migration[] = [
      MIGRATIONS[0]!,
      { version: 2, name: 'broken', sql: 'SELECT 1; CREATE TABLE `needs_missing_ref` (`id` CHAR(1) NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB; ALTER TABLE `needs_missing_ref` ADD CONSTRAINT `fk_x` FOREIGN KEY (`id`) REFERENCES `no_such_table` (`id`);', checksum: '0'.repeat(64) },
    ];
    await migrate(pool, database, [MIGRATIONS[0]!]);
    await expect(migrate(pool, database, broken)).rejects.toThrow();
    const [rows] = await pool.query('SHOW TABLES');
    const tables = (rows as Record<string, string>[]).map((r) => Object.values(r)[0]);
    // **实测订正**（Task 2，`tmp/plan4-t2-step5-run3.log`）：brief 原文断的是 `not.toContain`，
    // 那是把 DDL 当成可回滚的东西 —— MySQL 每条 DDL 隐式提交，所以坏版本**自己**前半条建的表也留下了。
    // 于是这一格断的是"残留确实在"，兜住它的不是回滚而是下面那两行：版本没记账 ⇒ 换成正确的一份就能补上。
    // （标题里"停在半途"讲的是这个形状：假装它能回滚比照它设计更诚实。）
    // **P-45**：`not.toContain` 那条主张并没有死，它只是不属于这一格 —— 换一种失败形状它照样成立，
    // 见下面那一格"坏迁移的第一条语句就失败"。两格合起来才是完整的形状：
    // **停在半途不是回滚；无残留是因为它根本没开始。**
    expect(tables).toContain('needs_missing_ref');
    // 版本 2 没被记账 ⇒ 换成正确的一份可以正常补上
    const [log] = await pool.query(`SELECT version FROM \`${SCHEMA_TABLE}\` ORDER BY version`);
    expect((log as { version: number }[]).map((r) => r.version)).toEqual([1]);
    const fixed: Migration[] = [MIGRATIONS[0]!, { version: 2, name: 'ok', sql: 'CREATE TABLE IF NOT EXISTS `late_add` (`id` CHAR(1) NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;', checksum: '1'.repeat(64) }];
    const out = await migrate(pool, database, fixed);
    expect(out.applied).toEqual([2]);
  });

  it('坏迁移的第一条语句就失败 ⇒ 库里不留任何表、版本不记账（P-45：无残留的另一半是"根本没开始"）', async () => {
    // 这一格是上面那一格的对偶，用的是**首发即失败**的 SQL（实测 `tmp/plan4-t2fix-probe.log` 的 E 条：
    // 第一条 `ALTER TABLE 不存在的表` 报 ER_NO_SUCH_TABLE，mysql2 的多语句批在错误处停下，
    // 第二条 CREATE 根本没执行 ⇒ 表数量一格没多）。于是 brief 原文那句 `not.toContain` 在这里逐字成立，
    // 而且不需要假装 DDL 能回滚 —— 它压根没开始。
    const brokenFirst: Migration[] = [
      MIGRATIONS[0]!,
      { version: 2, name: 'broken_first', sql: 'ALTER TABLE `no_such_table` ADD COLUMN `x` INT; CREATE TABLE IF NOT EXISTS `never_created_by_broken_first` (`id` CHAR(1) NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;', checksum: '2'.repeat(64) },
    ];
    await migrate(pool, database, [MIGRATIONS[0]!]);
    const [before] = await pool.query('SHOW TABLES');
    const tableCountBefore = (before as unknown[]).length;

    await expect(migrate(pool, database, brokenFirst)).rejects.toThrow();

    const [rows] = await pool.query('SHOW TABLES');
    const tables = (rows as Record<string, string>[]).map((r) => Object.values(r)[0]);
    expect(tables).not.toContain('never_created_by_broken_first');
    // "不留任何表"的字面读法：坏版本跑完之后，表**一张都没多**（不是靠回滚，是靠它没走到那条 CREATE）
    expect(tables.length, `首发即失败的版本不该多建任何表：${tables.join(',')}`).toBe(tableCountBefore);
    // 也没记账 ⇒ 与上一格共用同一条兜底：未记账的版本可以重来
    const [log] = await pool.query(`SELECT version FROM \`${SCHEMA_TABLE}\` ORDER BY version`);
    expect((log as { version: number }[]).map((r) => r.version)).toEqual([1]);
  });

  it('生成列真在算：kind 抽出、loadBearing 对 JSON 布尔给 1/0、非墙给 NULL', async () => {
    await migrate(pool, database);
    await pool.query(`INSERT INTO \`project\` (\`id\`, \`schema_version\`, \`name\`) VALUES ('01991c00-0000-7000-8000-000000000000', 1, '生成列探针')`);
    const insert = (id: string, payload: string) =>
      pool.query(
        `INSERT INTO \`element\` (\`id\`, \`project_id\`, \`storey_id\`, \`payload\`) VALUES (?, ?, ?, ?)`,
        [id, '01991c00-0000-7000-8000-000000000000', '01991c00-0000-7000-8000-000000000001', payload],
      );
    await insert('01991c00-0000-7000-8000-0000000000a1', JSON.stringify({ kind: 'wall', loadBearing: true }));
    await insert('01991c00-0000-7000-8000-0000000000a2', JSON.stringify({ kind: 'wall', loadBearing: false }));
    await insert('01991c00-0000-7000-8000-0000000000a3', JSON.stringify({ kind: 'point' }));
    const [rows] = await pool.query(
      'SELECT id, kind, load_bearing FROM `element` WHERE project_id = ? ORDER BY id',
      ['01991c00-0000-7000-8000-000000000000'],
    );
    const got = rows as { id: string; kind: string; load_bearing: number | null }[];
    expect(got.map((r) => [r.kind, r.load_bearing])).toEqual([
      ['wall', 1],
      ['wall', 0],
      ['point', null],
    ]);
    // 生成列存在的唯一理由（spec §8.1：S5 要 SQL 聚合）—— 这一发必须走索引，不许退化成全表 JSON 解析
    const [explain] = await pool.query(
      'EXPLAIN SELECT id FROM `element` WHERE project_id = ? AND load_bearing = 1',
      ['01991c00-0000-7000-8000-000000000000'],
    );
    const plan = (explain as Record<string, string>[])[0];
    expect(plan?.key).toBe('idx_project_loadbearing');
  });

  /**
   * **P-49 的常驻证人**：`element.kind` 的落点是 `STORED COLLATE ascii_bin`（⇒ 字符集 ascii）。
   * 为什么这一格值存在：001 正文的 `STORED CHARACTER SET ascii` 在本机是 ER_PARSE_ERROR（冲突 C4b），
   * 落地时改成了只写 `COLLATE`；那条订正到现在**只由一次性探针 `tmp/plan4-t2-probe-gcol.log` 撑着**，
   * 而探针不进 CI。静态那两条正则止于 `STORED`，也不看 collation。
   * 于是"漂回 utf8mb4"的后果是：运行时**不红**（`JSON_UNQUOTE` 抽出来的还是同一批串，
   * 差别只在 `'wall'` 与 `'WALL'` 是否同一个值这种大小写口径上），只有这一格红。
   * （读数本身实测见 `tmp/plan4-t2fix-probe.log` 的 D 条：charset=ascii / collation=ascii_bin /
   * EXTRA='STORED GENERATED'。）
   */
  it('element.kind 生成列的落点是 ascii / ascii_bin（P-49 常驻证人，漂回 utf8mb4 只有这里红）', async () => {
    await migrate(pool, database);
    const [rows] = await pool.query(
      `SELECT CHARACTER_SET_NAME AS charset_name, COLLATION_NAME AS collation_name, EXTRA AS extra
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'element' AND COLUMN_NAME = 'kind'`,
    );
    const col = (rows as { charset_name: string | null; collation_name: string | null; extra: string }[])[0];
    expect(col, 'information_schema 里没读到 element.kind 这一列').toBeDefined();
    expect(col?.charset_name).toBe('ascii');
    expect(col?.collation_name).toBe('ascii_bin');
    // 顺带钉住"它是 STORED 生成列"（不是有人日后偷偷换成复制列 + 手工维护）
    expect(col?.extra).toBe('STORED GENERATED');
  });
});

/**
 * **闸与顺序**（P-46 / P-47 / P-48）。原先这些判据串在一个 `it` 里的三发 `await expect(...)` 上，
 * 第一条失败即中止 ⇒ "三条入口各自独立"这件事根本观测不到（审查 I6）。现在一条 `it` 守一个入口，
 * 并且每一格都带一个"顺序证人"：拿 `unreachableEnv`（打不通的实例）或已关闭的池喂同一个名字，
 * 红的一定是**错误种类** —— 闸被挪到 SQL 之后，这一格就拿到连接错误而红。
 */
describe('库名白名单与迁移目标核对（闸在任何 SQL 之前）', () => {
  it('migrate 的白名单排在发 SQL 之前：已关闭的池喂 smartscrm，红的仍是"不是搭家的库"（P-47）', async () => {
    // 用**另开一发**并关掉的池，不关共享的 `pool` —— 关掉它后面的格子就全塌了，
    // 而本文件的格子之间不许有顺序前提（P-50）。
    const closed = createDbPool({ ...env, database }, { multipleStatements: true });
    await closed.end();
    // 已关闭的池上任何 `query` 都报 `Pool is closed.`（实测 probe.log 的 F 条）。
    // 所以这一格的读数只在"白名单先于第一发 SQL"时成立；把闸挪到 `readApplied` 之后
    // 或者把 `SELECT DATABASE()` 核对挪到它之前，拿到的都是 `Pool is closed.` ⇒ 红。
    await expect(migrate(closed, 'smartscrm')).rejects.toThrow(/不是搭家的库/);
  });

  it('migrate 核对目标库：拿着连 dajia_test 的池声称迁 dajia ⇒ 抛、点名两个名字、零写入（P-46）', async () => {
    // 这一格堵的是这台机器上最贵的一类错：`database` 参数过去只是主张，不参与路由，
    // 于是"连 dajia_test 的池 + 声称 dajia"会静默把 001 打进 dajia_test 并返回 {applied:[1]}。
    // 白名单允许 dajia（它是授权名），所以第一道闸**挡不住**这种错，只有核对挡得住。
    const message = await migrate(pool, 'dajia').then(() => '', (e: unknown) => (e as Error).message);
    expect(message).toMatch(/迁移目标与连接实际所在的库不一致/);
    expect(message).toMatch(/参数说 dajia，连接在 dajia_test/);
    // 抛在读写之前 ⇒ 库里一张表都不该多（`readApplied` 也没跑，否则 `_migration` 已经在别的形状下被读了）
    const [rows] = await pool.query('SHOW TABLES');
    expect(rows, '核对失败时不许动过库').toEqual([]);
  });

  it('migrate 核对目标库：只连实例、没选库的池不能当迁移目标（SELECT DATABASE() 回 NULL）（P-46）', async () => {
    // T1 那一档的池就是这个形状（只取 host/port/user/password，`database` 不进连接串，见 P-40）。
    // 它合法，但**不能当迁移目标** —— 回 NULL 不是"名字未知"，是"没地方可迁"。
    // 这一发显式绕开 `createDbPool`（它必填 `database`），照 `env.test.ts` 的样子只连实例。
    const instanceOnly = createPool({ host: env.host, port: env.port, user: env.user, password: env.password });
    try {
      await expect(migrate(instanceOnly, database)).rejects.toThrow(/没有选中任何库/);
    } finally {
      await instanceOnly.end();
    }
  });

  it('dropTestDatabase 的第一道闸：白名单外的名字在任何 SQL 之前抛（拆自原文第 5 格，P-48）', async () => {
    await expect(dropTestDatabase(env, 'smartscrm')).rejects.toThrow(/不是搭家的库/);
    // 顺序证人：闸若在 SQL 之后，这一发拿到的是 ECONNREFUSED ⇒ 断的是错误种类，不是有没有红。
    await expect(dropTestDatabase(unreachableEnv, 'smartscrm')).rejects.toThrow(/不是搭家的库/);
  });

  it('dropTestDatabase 的第二道闸：dajia 是合法名但不许删 ⇒ 抛且一发 SQL 都不发（P-48 / 审查 I1 的零判据）', async () => {
    // 审查 I1 指出的正是这一处：`database.ts:32-34` 那道闸原来**删掉不会有任何格子红**
    // （原文只喂 smartscrm，第一道闸就挡住了）。现在它有证人：
    // 第二道闸被删 ⇒ 这里拿到的是 ECONNREFUSED（打不通的实例）而不是白名单文案 ⇒ 红。
    // `dajia` 是白名单内的名字，只有"删库"这一侧不许它。
    await expect(dropTestDatabase(env, 'dajia')).rejects.toThrow(/只许删 dajia_test/);
    await expect(dropTestDatabase(unreachableEnv, 'dajia')).rejects.toThrow(/只许删 dajia_test/);
  });

  it('ensureDatabase 的闸：白名单外的名字在任何 SQL 之前抛（拆自原文第 5 格，P-48）', async () => {
    await expect(ensureDatabase(env, 'ledger_db')).rejects.toThrow(/不是搭家的库/);
    await expect(ensureDatabase(unreachableEnv, 'ledger_db')).rejects.toThrow(/不是搭家的库/);
  });

  it('ensureDatabase 对 dajia 是**放行**的：第二道闸只管删，不是"dajia 一律不许动"（P-48 的对偶）', async () => {
    // 这一格读的是"不对称的形状"：同一个 `dajia`，建库放行、删库挡住。
    // 如果有人把第二道闸写成两个函数共用（那会顺手把 T11 建 dajia 的路也堵死），
    // 这里拿到的是白名单文案 ⇒ 红。用 unreachableEnv 跑 ⇒ 放行时只会撞到连接错误，
    // **绝不真建出 dajia 库**（Step 7 要求跑完 `SHOW DATABASES` 里没有 dajia，它归 T11 的闸门）。
    const message = await ensureDatabase(unreachableEnv, 'dajia').then(() => '', (e: unknown) => (e as Error).message);
    expect(message, '连打不通的实例都没抛，说明这一发没走到连接').not.toBe('');
    expect(message).not.toMatch(/不是搭家的库/);
    expect(message).not.toMatch(/只许删 dajia_test/);
  });
});
