import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { createDbPool } from '../../src/main/db/pool';
import { readMysqlEnv } from '../../src/main/db/env';
import { dropTestDatabase, ensureDatabase } from '../../src/main/db/database';
import { SCHEMA_TABLE, migrate } from '../../src/main/db/migrate';
import { MIGRATIONS, type Migration } from '../../src/main/db/migrations';

const env = readMysqlEnv();
const database = 'dajia_test';
let pool: Pool;

beforeAll(async () => {
  await dropTestDatabase(env, database);
  await ensureDatabase(env, database);
  pool = createDbPool({ ...env, database }, { multipleStatements: true });
});

afterEach(async () => {
  // 每个用例之间清一次表，顺序照外键方向（element 与 storey 引用 project）。
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of ['_migration', 'asset', 'snapshot', 'command_log', 'element', 'storey', 'project']) {
    await pool.query(`DROP TABLE IF EXISTS \`${t}\``);
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
    expect(tables).toContain('needs_missing_ref');
    // 版本 2 没被记账 ⇒ 换成正确的一份可以正常补上
    const [log] = await pool.query(`SELECT version FROM \`${SCHEMA_TABLE}\` ORDER BY version`);
    expect((log as { version: number }[]).map((r) => r.version)).toEqual([1]);
    const fixed: Migration[] = [MIGRATIONS[0]!, { version: 2, name: 'ok', sql: 'CREATE TABLE IF NOT EXISTS `late_add` (`id` CHAR(1) NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;', checksum: '1'.repeat(64) }];
    const out = await migrate(pool, database, fixed);
    expect(out.applied).toEqual([2]);
  });

  it('库名不在白名单 ⇒ 在任何 SQL 之前抛（这条红得比连不上库还早）', async () => {
    await expect(migrate(pool, 'smartscrm')).rejects.toThrow(/不是搭家的库/);
    await expect(dropTestDatabase(env, 'smartscrm')).rejects.toThrow(/不是搭家的库/);
    await expect(ensureDatabase(env, 'ledger_db')).rejects.toThrow(/不是搭家的库/);
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
});
