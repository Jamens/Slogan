/**
 * **本模块全部走 `pool.query`，不用 `execute` —— 实测选型**（2026-10-04，`tmp/plan4-t2-probe-execute.log`）：
 * ① 迁移正文一个版本里是多条 DDL，`execute` 发的是服务端预处理语句，实测当场
 *    `ER_PARSE_ERROR (1064)`（服务端不许把多条语句塞进一条 prepared statement）—— 不是偏好，是没有第二条路。
 * ② 连 `SHOW TABLES LIKE ?` 这种工具语句 `execute` 也报 1064，`query` 正常 ⇒ `schemaTableExists` 同一条路。
 * ③ 带 `?` 的那条 INSERT 两种都行、回值形状一致（`affectedRows`/`insertId` 相同），
 *    串里有 `a'b"c;--` 也原样进库原样读出 ⇒ `query` 的客户端转义在这一发上够。
 *    选一个不换第二遍：整个 runner 只有 `query`，读代码的人不用逐条判断该走哪条。
 * ④ 迁移正文**永远不进参数位**（它是 SQL 本身，不是数据）；唯一进参数位的是版本号/名字/校验和三元组。
 */
import type { Pool } from 'mysql2/promise';
import { assertDatabaseName } from './db-safety';
import { MIGRATIONS, type Migration } from './migrations';

export const SCHEMA_TABLE = '_migration';

interface AppliedRow {
  version: number;
  checksum: string;
}

/**
 * `_migration` 本身是 001 的第一条语句建的 ⇒ "空库"是这个 runner 的正常入口，不是异常。
 * 实测（2026-10-04，`tmp/plan4-t2-step5-run1.log`）：不问一句直接 SELECT 它，五格用例全红在
 * `Error: Table 'dajia_test._migration' doesn't exist`。所以先探一次存在性再读。
 * 探测用 `SHOW TABLES LIKE`：`_` 在 LIKE 里是单字符通配符，所以回值还要按名字逐字比对一遍，
 * 免得这条判据哪天在别的表名上放放水。
 */
async function schemaTableExists(pool: Pool): Promise<boolean> {
  const [rows] = await pool.query('SHOW TABLES LIKE ?', [SCHEMA_TABLE]);
  return (rows as Record<string, unknown>[]).some((r) => Object.values(r)[0] === SCHEMA_TABLE);
}

async function readApplied(pool: Pool): Promise<Map<number, AppliedRow>> {
  const out = new Map<number, AppliedRow>();
  if (!(await schemaTableExists(pool))) return out;
  const [rows] = await pool.query(
    `SELECT \`version\`, \`checksum\` FROM \`${SCHEMA_TABLE}\` ORDER BY \`version\``,
  );
  for (const r of rows as AppliedRow[]) out.set(r.version, r);
  return out;
}

/**
 * 顺序应用，一次一条版本。三条形状要说清：
 * ① **MySQL 的 DDL 隐式提交** ⇒ 一个版本内多条语句失败时不可回滚，前几条的表已经留下。
 *    可重放性因此全靠 DDL 写成 `IF NOT EXISTS`（Step 1 有一条测试专门钉它），
 *    以及"版本没记进 `_migration` 就重来一遍"这个形状。这不是缺陷，是 MySQL 的语义，
 *    照它设计比假装它能回滚要诚实。
 * ② 已应用的版本若校验和对不上 ⇒ 抛，**不修**。有人改了历史 SQL，必须人来决定。
 * ③ 库名先过白名单再动任何东西。
 * ④ `_migration` 还不存在（空库）= 零条已应用，不是错误 —— 见 `schemaTableExists`。
 */
export async function migrate(
  pool: Pool,
  database: string,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<{ applied: number[]; alreadyApplied: number[] }> {
  assertDatabaseName(database);
  const applied: number[] = [];
  const alreadyApplied: number[] = [];
  const seen = await readApplied(pool);
  for (const m of migrations) {
    const row = seen.get(m.version);
    if (row) {
      if (row.checksum !== m.checksum) {
        throw new RangeError(
          `迁移 ${m.version}（${m.name}）的正文被改过：库里记的校验和是 ${row.checksum}，` +
            `现在这份是 ${m.checksum}。历史迁移不许改，请新开一个版本。`,
        );
      }
      alreadyApplied.push(m.version);
      continue;
    }
    await pool.query(m.sql);
    await pool.query(
      `INSERT INTO \`${SCHEMA_TABLE}\` (\`version\`, \`name\`, \`checksum\`) VALUES (?, ?, ?)`,
      [m.version, m.name, m.checksum],
    );
    applied.push(m.version);
  }
  return { applied, alreadyApplied };
}
