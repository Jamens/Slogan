import { assertDatabaseName, type AllowedDatabase } from './db-safety';

export interface MysqlEnv {
  host: string;
  port: number;
  user: string;
  password: string;
  database: AllowedDatabase;
}

const NAMES = ['DAJIA_MYSQL_HOST', 'DAJIA_MYSQL_PORT', 'DAJIA_MYSQL_USER', 'DAJIA_MYSQL_PASSWORD', 'DAJIA_MYSQL_DATABASE'] as const;

/**
 * 连接参数只从环境变量读，**不落任何进仓文件**（含测试代码与本计划文本）。
 * 缺就点名抛 —— 这一条不是风格：`test:db` 若允许"没配就跳过"，那 CI 与任何干净机器上
 * 全部 repository 用例都是绿的假象，而这批用例存在的理由正是"真 MySQL，不 mock"（spec §10）。
 */
export function readMysqlEnv(env: NodeJS.ProcessEnv = process.env): MysqlEnv {
  const missing = NAMES.filter((n) => env[n] === undefined || env[n] === '');
  if (missing.length > 0) {
    throw new RangeError(
      `缺 MySQL 环境变量：${missing.join(', ')}。` +
        `连库测试不许静默跳过 —— 配齐了再跑 pnpm test:db（口令取自本机 MySQL 配置，别写进仓库）`,
    );
  }
  const port = Number(env.DAJIA_MYSQL_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new RangeError(`DAJIA_MYSQL_PORT 必须是 1–65535 的整数，收到 ${JSON.stringify(env.DAJIA_MYSQL_PORT)}`);
  }
  return {
    host: env.DAJIA_MYSQL_HOST as string,
    port,
    user: env.DAJIA_MYSQL_USER as string,
    password: env.DAJIA_MYSQL_PASSWORD as string,
    database: assertDatabaseName(env.DAJIA_MYSQL_DATABASE),
  };
}
