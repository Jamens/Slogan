import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, type Pool } from 'mysql2/promise';
import { readMysqlEnv } from '../../src/main/db/env';
import { assertDatabaseName } from '../../src/main/db/db-safety';

/**
 * 只读普查：把 spec §12 的环境事实从"2026-09-25 那次手敲的备忘"变成会红的断言。
 * 本任务**不建库、不建表、不写一行**——建库排在 Task 2（授权的第一次落地），
 * 所以这里连的是实例本身（`database` 只用来核对白名单，不进 SQL）。
 */
let close: () => Promise<void> = async () => {};

beforeAll(async () => {
  const env = readMysqlEnv();
  const pool = createPool({ ...env, connectionLimit: 1 });
  close = () => pool.end();
  (globalThis as { __pool?: Pool }).__pool = pool;
});

afterAll(async () => {
  await close();
});

describe('MySQL 环境事实（spec §12 的凭据化）', () => {
  it('服务端参数与 spec §12 记的逐字一致（改了就红，别把设计建在飘的地上）', async () => {
    const pool = (globalThis as { __pool?: Pool }).__pool;
    if (!pool) throw new TypeError('普查用的池没建起来');
    const [rows] = await pool.query(
      "SELECT VERSION() AS v, @@character_set_server AS cs, @@collation_server AS col, " +
        '@@lower_case_table_names AS lctn, @@max_connections AS maxc',
    );
    const got = (rows as Record<string, string>[])[0];
    if (!got) throw new TypeError('SELECT 没回行');
    expect(got.cs).toBe('utf8mb4');
    expect(got.col).toBe('utf8mb4_0900_ai_ci');
    // 生成列与 id 列的 collation 都要跟着这个口径走（混着 JOIN 会报 Illegal mix of collations）
    expect(got.lctn).toBe('1');
    expect(Number(got.maxc)).toBeGreaterThanOrEqual(151);
    expect(got.v.split('.')[0]).toBe('8');
    process.stdout.write(`[census] version=${got.v} max_connections=${got.maxc}\n`);
  });

  it('库名白名单先过，连接参数里的 database 也在名单里', () => {
    const env = readMysqlEnv();
    expect(assertDatabaseName(env.database)).toBe(env.database);
  });

  it('缺任何一个变量就抛，且文案点名叫哪个（不许变成 skip）', () => {
    const base = {
      DAJIA_MYSQL_HOST: '127.0.0.1',
      DAJIA_MYSQL_PORT: '3306',
      DAJIA_MYSQL_USER: 'u',
      DAJIA_MYSQL_PASSWORD: 'p',
      DAJIA_MYSQL_DATABASE: 'dajia_test',
    };
    for (const name of Object.keys(base)) {
      const env = { ...base } as Record<string, string>;
      delete env[name];
      expect(() => readMysqlEnv(env)).toThrow(new RegExp(name));
    }
    expect(() => readMysqlEnv({ ...base, DAJIA_MYSQL_PORT: '0' })).toThrow(/DAJIA_MYSQL_PORT/);
    expect(() => readMysqlEnv({ ...base, DAJIA_MYSQL_DATABASE: 'smartscrm' })).toThrow(/不是搭家的库/);
  });
});
