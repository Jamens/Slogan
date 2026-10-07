import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { SCHEMA_VERSION } from '@dajia/core';
import { readMysqlEnv } from '../../src/main/db/env';
import { dropTestDatabase } from '../../src/main/db/database';
import { createDbPool } from '../../src/main/db/pool';
import { ProjectRepository } from '../../src/main/db/repository';
import { ProjectAdmin } from '../../src/main/persist/admin';
import { ensureSchema, makeAdminPorts, probeOpener } from '../../src/main/persist/admin-ports';

const env = readMysqlEnv();
// 红线：库名由本文件写死，**不抄 env**。`env.database` 允许是 `dajia`（那是应用运行时的合法取值），
// 测试照抄它就把用户的真工程库当试验田 —— 而本档比别的档更危险，因为它测的就是建库那一发。
const DATABASE = 'dajia_test';
/** 七张表：`_migration` 与六张业务表。名字来自 T2 的 001 DDL，逐字抄。 */
const TABLES = ['_migration', 'asset', 'command_log', 'element', 'project', 'snapshot', 'storey'];

let reader: Pool | null = null;

/** 开一条读连接（每次用完就掐：本档要在两次断言之间把库删掉，留着连接等于留着一个会炸的东西）。 */
async function openReader(): Promise<Pool> {
  reader = createDbPool({ ...env, database: DATABASE });
  return reader;
}
async function closeReader(): Promise<void> {
  const pool = reader;
  reader = null;
  if (pool !== null) await pool.end().catch(() => undefined);
}

/** 当前连的库名。它是"这一发到底连了谁"的收据，也是 `assertDatabaseName` 那条白名单的现场证据。 */
async function databaseName(): Promise<string> {
  const pool = reader ?? (await openReader());
  const [rows] = await pool.query('SELECT DATABASE() AS db');
  return String((rows as { db: string }[])[0]?.db);
}

async function tableNames(): Promise<Set<string>> {
  const pool = reader ?? (await openReader());
  const [rows] = await pool.query(
    'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
    [DATABASE],
  );
  // 不比对有序数组：`utf8mb4_0900_ai_ci` 排序规则下 `ORDER BY` 的结果不是我们想判的那件事。
  return new Set((rows as { t: string }[]).map((r) => r.t));
}

const admin = new ProjectAdmin(
  makeAdminPorts({ loadConfig: () => ({ ...env, database: DATABASE }), actor: () => 'tester' }),
);

beforeAll(async () => {
  await dropTestDatabase(env, DATABASE);
  // **这里没有 `ensureDatabase`，也没有 `migrate`**：那两件事是格 1 与格 4 的靶。
});

afterAll(async () => {
  await closeReader();
  await dropTestDatabase(env, DATABASE);
});

describe('admin-ports 连库档：全新机器上第一条通道真的能自建自清', () => {
  it('1 格：库被删干净之后 `ensureSchema` 把库与七张表一起建回来（P-37 的正文）', async () => {
    const e = { ...env, database: DATABASE } as const;
    await closeReader();
    await dropTestDatabase(e, DATABASE);
    await ensureSchema(e);
    await openReader();
    expect(await databaseName()).toBe(DATABASE);
    const names = await tableNames();
    for (const table of TABLES) expect(names.has(table)).toBe(true);
    expect(names.size).toBe(TABLES.length);
  });

  it('2 格：`ensureSchema` 幂等 —— 连跑两次不抛，已有的一行都不少', async () => {
    const e = { ...env, database: DATABASE } as const;
    await ensureSchema(e);
    await ensureSchema(e);
    const names = await tableNames();
    expect(names.size).toBe(TABLES.length);
    // 第二发真的**跳过**了已应用的版本（不是重跑 DDL）：`project` 表还在，而 `_migration` 只有一行。
    const pool = reader ?? (await openReader());
    const [rows] = await pool.query('SELECT COUNT(*) AS n FROM `_migration`');
    expect(Number((rows as { n: number | string }[])[0]?.n)).toBe(1);
  });

  it('3 格：真端口建出来的工程，读路径打得开，而 `actor` 是递进来的那一份', async () => {
    const { projectId } = await admin.create('端口自建房');
    const pool = await openReader();
    const [log] = await pool.query(
      'SELECT `actor` FROM `command_log` WHERE `project_id` = ? ORDER BY `turn` ASC',
      [projectId],
    );
    // 这一句是 `AdminPortDeps.actor` 那个注入点的唯一凭据：写死一份"反正生产也是它"就等于把
    // 「谁写的这发账」这件事交给了一个没人检查的常量（M39 的靶）。
    expect((log as { actor: string }[]).map((r) => r.actor)).toEqual(['tester']);
    const loaded = await new ProjectRepository(pool, projectId, 'tester').loadProject('read');
    expect(loaded.header.projectId).toBe(projectId);
    expect(loaded.header.schemaVersion).toBe(SCHEMA_VERSION);
    expect(loaded.header.journalTurn).toBe(1);
    // 首层在文档里（口径 ② 那发 turn 1 的下游）：读路径与写路径说的是同一份账。
    // `Document` 的楼层要经 `byKind('storey')` 取，没有裸 `.storeys` 字段。
    expect(loaded.doc.byKind('storey').length).toBe(1);
  });

  it('4 格：库不存在时 `list()` 自己把库建回来并回一份空列表（读路径也自愈，P-37 的后一半）', async () => {
    await closeReader();
    await dropTestDatabase({ ...env, database: DATABASE } as typeof env, DATABASE);
    const value = await admin.list();
    expect(value).toEqual({ projects: [] });
    await openReader();
    expect(await databaseName()).toBe(DATABASE);
    expect((await tableNames()).has('project')).toBe(true);
  });

  it('5 格：`probeOpener` 的 ping 回一个真字符串，`end()` 之后那条池真的用不了', async () => {
    const handle = await probeOpener({ ...env, database: DATABASE });
    const { version } = await handle.ping();
    expect(typeof version).toBe('string');
    expect(version.length).toBeGreaterThan(0);
    // 这一发是本计划里**唯一**一次真驱动真握手的读数：`SELECT VERSION()` 的返回形状
    // 与 `mysql2` 的 typings（`<待实测>` 第一条的凭据就落在这里）。
    await handle.end();
    await expect(handle.ping()).rejects.toThrow();
  });
});
