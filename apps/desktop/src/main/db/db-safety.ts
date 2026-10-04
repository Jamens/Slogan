/**
 * 用户给的授权原话：「允许在 MySQL 建 `dajia` 和 `dajia_test` 库」。
 * 那台实例里另有 14 个用户的库（spec §12 实测：含 smartscrm、smartscrm_react、flowmart、ledger_db…），
 * 而 `CREATE DATABASE` / `DROP DATABASE` 这类语句连不上"参数化"——一旦名字进错，删掉的是别人一天的工作。
 * 所以所有会建/删/连库的函数第一行都调这里，且**在建连接之前**抛。
 *
 * 白名单而不是正则：`^dajia.*` 会放过 `dajia_smartscrm_backup` 这种真存在过的命名风格，
 * 正则挡注入的代价是把判断交给字符串形状，这里没有任何一种形状需要被放过。
 */
export const ALLOWED_DATABASES = ['dajia', 'dajia_test'] as const;
export type AllowedDatabase = (typeof ALLOWED_DATABASES)[number];

export function assertDatabaseName(value: unknown): AllowedDatabase {
  if (typeof value === 'string' && (ALLOWED_DATABASES as readonly string[]).includes(value)) {
    return value as AllowedDatabase;
  }
  throw new RangeError(
    `库名 ${JSON.stringify(value)} 不是搭家的库：只允许 ${ALLOWED_DATABASES.join(' / ')}（授权只覆盖这两个）`,
  );
}
