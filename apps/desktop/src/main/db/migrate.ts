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
import { assertDatabaseName, type AllowedDatabase } from './db-safety';
import { MIGRATIONS, type Migration } from './migrations';

export const SCHEMA_TABLE = '_migration';

interface AppliedRow {
  version: number;
  checksum: string;
}

/**
 * **P-46：`database` 参数是"主张"，不是路由** —— 它过去只过白名单，从不与连接实际所在的库核对，
 * 于是"拿着连 `dajia_test` 的池声称迁 `dajia`"会把 001 打进 `dajia_test` 并**返回成功**。
 * 这一台实例里躺着用户别的项目的 15 个库，那种"报成功而打错了库"是这台机器上最贵的一种错，
 * 而这一档是后面 5 个任务（T3..T7）的地板 ⇒ 从这一版起它是判据。
 *
 * 位置（这才是重点，不是风格）：**白名单闸之后、任何读写之前**。`readApplied` 也算读写 ——
 * 在别的库里读到的 `_migration` 没有意义，读到空还会把"这库没迁过"当成事实往下写。
 *
 * 代价（写明）：每次 `migrate` 多一发 `SELECT DATABASE()`。它是服务端常量投影，不走表、不走索引，
 * 成本在一次 round-trip；与"少一类不可能的错"相比值。
 *
 * 两种红法分开写，因为它们指向不同的错：
 * ① 回 NULL = 这个连接**没选中任何库**（比如 T1 那种"只连实例"的池，见 `env.test.ts` 的 P-40 段）
 *    ⇒ 它根本不能当迁移目标，不是"名字暂未知"，不许往下走。
 * ② 名字不一致 = 池与参数各说各话 ⇒ 文案点名两个名字，让人一眼看出连的是哪个、声称的是哪个。
 */
async function assertTargetDatabase(pool: Pool, database: AllowedDatabase): Promise<void> {
  const [rows] = await pool.query('SELECT DATABASE() AS current_database');
  const current = (rows as { current_database: string | null }[])[0]?.current_database ?? null;
  if (current === null) {
    throw new RangeError(
      `无法核对迁移目标：这个连接没有选中任何库（SELECT DATABASE() 回 NULL），它不能当迁移目标：${database}`,
    );
  }
  if (current !== database) {
    throw new RangeError(
      `迁移目标与连接实际所在的库不一致：参数说 ${database}，连接在 ${current}。` +
        `要么换成连 ${database} 的池，要么改参数 —— 别把迁移打进 ${current} 却报 ${database} 的成功。`,
    );
  }
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
 * ③ 库名先过白名单再动任何东西，**紧接着**核对 `SELECT DATABASE()` 与参数一致（P-46，见
 *    `assertTargetDatabase`：白名单管"这个名字准不准动"，那一发管"这个连接是不是它"）。
 * ④ `_migration` 还不存在（空库）= 零条已应用，不是错误 —— 见 `schemaTableExists`。
 */
export async function migrate(
  pool: Pool,
  database: string,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<{ applied: number[]; alreadyApplied: number[] }> {
  const target = assertDatabaseName(database);
  await assertTargetDatabase(pool, target);
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
