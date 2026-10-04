import { createPool } from 'mysql2/promise';
import type { Pool } from 'mysql2/promise';
import type { MysqlEnv } from './env';

export interface PoolOptions {
  /**
   * 只在迁移连接上开：一个 `.sql` 版本里是多条 DDL，逐条发要把分词器交给 JS 再写一遍。
   * **业务连接永远不开** —— 打开它等于给任何一处字符串拼接留出多语句的通道，
   * 而本计划唯一的"库名进 SQL"的地方（ensureDatabase / dropTestDatabase）靠白名单挡，不靠这个。
   */
  readonly multipleStatements?: boolean;
  readonly connectionLimit?: number;
}

export function createDbPool(env: MysqlEnv, opts: PoolOptions = {}): Pool {
  return createPool({
    host: env.host,
    port: env.port,
    user: env.user,
    password: env.password,
    database: env.database,
    waitForConnections: true,
    connectionLimit: opts.connectionLimit ?? 4,
    charset: 'utf8mb4',
    multipleStatements: opts.multipleStatements ?? false,
    // 日期一律按 DATETIME(3) 原样读回；时区口径交给服务端（P-4），客户端不参与换算。
    dateStrings: true,
    namedPlaceholders: false,
  });
}
