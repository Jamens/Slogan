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
  // **`database` 不进连接**（裁决 P-40）：本任务连的是实例本身，建库排在 Task 2。
  // 写成 `{ ...env }` 会让 mysql2 在建连时自己发 `USE dajia_test` ⇒ 库还没建就当场红，
  // "不建库、不建表、不写一行"这句注释于是会变成一条永远跑不绿的判据。
  // 显式列四件套而不是 omit 解构：`noUnusedLocals` 那侧少一个解释成本。
  const pool = createPool({
    host: env.host,
    port: env.port,
    user: env.user,
    password: env.password,
    connectionLimit: 1,
  });
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
    // **回值的形状本身也是这一格学到的东西**（裁决 P-41）：`VERSION()` 是字符串，两个 `@@` 整数
    // 变量在 mysql2 下回 JS number —— 实测 2026-10-04：`lctn` 回的是数字 1，不是 '1'。
    // 所以这里不许把整行 cast 成 `Record<string, string>` 假装它全是字符串（那正是下一行原来写错的原因），
    // 而是整数一律过 `Number()`、字符串那一发过 `String()`。
    const got = (rows as Record<string, string | number>[])[0];
    if (!got) throw new TypeError('SELECT 没回行');
    expect(got.cs).toBe('utf8mb4');
    expect(got.col).toBe('utf8mb4_0900_ai_ci');
    // 生成列与 id 列的 collation 都要跟着这个口径走（混着 JOIN 会报 Illegal mix of collations）。
    // 断"恰好等于 1"而不是"非零"：库名大小写不敏感是 T2 那六张表与生成列设计的前提。
    expect(Number(got.lctn)).toBe(1);
    expect(Number(got.maxc)).toBeGreaterThanOrEqual(151);
    expect(String(got.v).split('.')[0]).toBe('8');
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
