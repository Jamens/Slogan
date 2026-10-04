import { createPool } from 'mysql2/promise';
import type { MysqlEnv } from './env';
import { assertDatabaseName } from './db-safety';

/** 连"实例"而不是"库"：建库时目标库还不存在，不能把它写进连接参数。 */
async function withServer(env: MysqlEnv, fn: (pool: ReturnType<typeof createPool>) => Promise<void>): Promise<void> {
  const pool = createPool({ host: env.host, port: env.port, user: env.user, password: env.password });
  try {
    await fn(pool);
  } finally {
    await pool.end();
  }
}

/**
 * `CREATE DATABASE` / `DROP DATABASE` 不能参数化，名字是唯一的通路 ⇒
 * 白名单必须在这里，且**只在这里**：调用方再谨慎也不如被调方不许接受别的名字。
 * 排序规则照 spec §12 实测的服务端默认，别在这儿发明第二套。
 */
export async function ensureDatabase(env: MysqlEnv, database: string): Promise<void> {
  const name = assertDatabaseName(database);
  await withServer(env, async (pool) => {
    await pool.query(
      `CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
  });
}

/** 自建自清的另一半（spec §10 对 `dajia_test` 的要求）。`dajia` 走这里会被白名单挡在 SQL 之前。 */
export async function dropTestDatabase(env: MysqlEnv, database: string): Promise<void> {
  const name = assertDatabaseName(database);
  if (name !== 'dajia_test') {
    throw new RangeError(`dropTestDatabase 只许删 dajia_test，收到 ${JSON.stringify(name)}`);
  }
  await withServer(env, async (pool) => {
    await pool.query(`DROP DATABASE IF EXISTS \`${name}\``);
  });
}
