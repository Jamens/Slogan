import { ensureDatabase } from '../db/database';
import type { MysqlEnv } from '../db/env';
import { migrate } from '../db/migrate';
import { createDbPool, CONFIG_TEST_CONNECT_TIMEOUT_MS } from '../db/pool';
import { listProjects, ProjectRepository } from '../db/repository';
import type { AdminCreateDb, AdminListDb, AdminPorts, ProbeOpener } from './admin';
import { describeError } from './describe-error';
import { SessionError } from './session';

/**
 * 管理通道那条连接的池宽。它与 `createDbPool` 的默认 4 不同是有意的：一次调用一条连接、
 * 用完就掐（口径 ① 那笔代价），留 2 只是给"点得快"留一点余量，而这个数唯一的读者就是本文件。
 */
const ADMIN_CONNECTION_LIMIT = 2;

/**
 * 建库 + 建表（P-37 的那件事的正文）。
 *
 * 两发都必须在这一个函数里，因为缺任何一发的处境都真实存在：只有 `CREATE DATABASE` 而没有
 * 迁移 ⇒ 列表拿到的是一张空库里的一张空表都查不到（`ER_NO_SUCH_TABLE`）；只有迁移而不建库 ⇒
 * 全新机器上第一发就 `ER_BAD_DB_ERROR`。
 *
 * **为什么读路径（`openListDb`）也允许跑 DDL**：`migrate` 幂等（已应用的版本读校验和比对，一致就跳过），
 * 而 T8 的 `openDb` 早就在每次开工程时跑同一条（t8c 第 ② 段那句"T9 的建库向导也跑同一条 —— 双跑无害"
 * 就是这一发预告的那个 T9）。把建库只放在"新建工程"那一路会得到一个更坏的形状：用户在向导里点了保存、
 * MySQL 当时没起，之后再启动服务，列表会一直报"连不上库"，直到他回去重填一遍配置。
 *
 * 失败的码不在这里定（`ProjectAdmin` 那一层的 `wrap(err, 'db', '连不上库')` 负责），理由与
 * t8c 的 `openDb` 那一段完全相同：**迁移正文被改过那一抛是 `RangeError`，同样落进 `'db'`，
 * 因为那一刻的下一步动作确实是"去检查数据库那一侧"**。
 */
export async function ensureSchema(env: MysqlEnv): Promise<void> {
  await ensureDatabase(env, env.database);
  // 迁移连接是**唯一**开 `multipleStatements` 的那一条（T2 的原话，P-17 钉过那句注释）。
  const pool = createDbPool(env, { multipleStatements: true });
  try {
    await migrate(pool, env.database);
  } finally {
    // 不把 `end()` 的失败盖在 `migrate` 的失败上（t8c 的 `openDb` 同一句）：这里只保证一条 ——
    // 抛出去的时候没有池留在手里。
    await pool.end().catch(() => undefined);
  }
}

/**
 * 装配三条真端口所需的两样外部事实（P-31 把 `AdminPorts` 收成三键之后，剩下的"还得知道什么"就只剩这两样）：
 * - `loadConfig`：它**不是**这里的实现。配置来自 `config-store`（safeStorage 那份文件）而 `userData` 目录
 *   只有 electron 侧知道，所以这一发从外面递进来 —— 连库档递的是 `{ ...env, database: 'dajia_test' }`，
 *   生产侧递的是 `configToEnv(readConfig(userDataDir, safeStorageCipher))`。
 * - `actor`：写进 `command_log.actor` 的那个"谁的哪一号进程"。它的产地仍然是 `ipc-persist.ts` 的
 *   `lockOwner()`（T8 的原话：与 `lock_owner` **同一个串**），这里不重算一份，因为 `node:os` 属于
 *   本文件要躲开的那一族（第 ⑨ 段的边界扫描）。
 */
export interface AdminPortDeps {
  loadConfig(): MysqlEnv;
  actor(): string;
}

/** `ProjectAdmin` 那三条注入端口的生产实现。它返回的正是 `AdminPorts`，所以 t9d 那句"端口的形状没有隐藏要求"在这里第二次成立。 */
export function makeAdminPorts(deps: AdminPortDeps): AdminPorts {
  return {
    loadConfig: deps.loadConfig,
    async openCreateDb(env, projectId): Promise<AdminCreateDb> {
      await ensureSchema(env);
      const pool = createDbPool(env, { connectionLimit: ADMIN_CONNECTION_LIMIT });
      try {
        return { repo: new ProjectRepository(pool, projectId, deps.actor()), end: () => pool.end() };
      } catch (err) {
        // 先关池再抛，且**就地定 `'internal'`**：此刻唯一可能的形状是仓库自己那把尺
        // （`actor` 长度 1..64）没过去，而那是我们的拼接错了，不是"去检查 MySQL 服务"。
        // 这一发照的是 t8c 的 `openDb` —— 同一个处境在两个文件里得到同一句话与同一个码。
        await pool.end().catch(() => undefined);
        throw new SessionError('internal', `仓库建不起来：${describeError(err)}`);
      }
    },
    async openListDb(env): Promise<AdminListDb> {
      await ensureSchema(env);
      const pool = createDbPool(env, { connectionLimit: ADMIN_CONNECTION_LIMIT });
      // 这里没有 try/catch：`listProjects: () => listProjects(pool)` 那一发闭包不会抛（构造期不查参数），
      // 所以"没拿到手的东西不拆"这条在 `openListDb` 上根本没有可判的形状（对照 t9d 第 ① 段格 3 的那条注释）。
      return { listProjects: () => listProjects(pool), end: () => pool.end() };
    },
  };
}

/**
 * 试连的那条连接（`probeConnection` 的 `ProbeOpener` 生产实现）。
 *
 * 三个形状各有其所以然：
 * - `connectionLimit: 1` —— 一次试连一条连接，没有第二条要它。
 * - `connectTimeoutMs: CONFIG_TEST_CONNECT_TIMEOUT_MS` —— P-34 那一发的**唯一**读者。它只握这一发的手，
 *   会话那条常驻连接不受它管（t9b 第 ③ 段注释原话）。
 * - **不**调 `ensureSchema`：试连是"我只看看"那一发（第 ⑤ 段的口径），它一拨号就把 DDL 做完了，
 *   `no-database` 那一型就永远不会出现在屏幕上，而 t9b 花一整张文案表换来的那一型正是"连上了，还没建"。
 *
 * 池是懒的（t9d 第 ① 段末实测过的那件事）：`createDbPool` 永远不抛，失败在第一发 `query()` 上炸，
 * 所以连不上的处境会带着 `ECONNREFUSED` / `ETIMEDOUT` / `ER_BAD_DB_ERROR` 走到 `classifyDbError` 面前。
 */
export const probeOpener: ProbeOpener = async (env) => {
  const pool = createDbPool(env, {
    connectionLimit: 1,
    connectTimeoutMs: CONFIG_TEST_CONNECT_TIMEOUT_MS,
  });
  return {
    async ping(): Promise<{ version: string }> {
      const [rows] = await pool.query('SELECT VERSION() AS version');
      // `as { version: string }[]` 的写法照 T4 的 `rows<T>()` 那一份夹具（同一族 mysql2 返回值），
      // `<待实测>` 那一条里包含了"这条链上 `RowDataPacket` 的索引签名能不能直接降到 `{ version: string }`"。
      const version = (rows as { version: string }[])[0]?.version;
      if (typeof version !== 'string') {
        // 这一发抛的是没有 `code` 的 `RangeError` ⇒ `classifyDbError` 回 `'unknown'`，
        // 而那正是"对面说的话不像 MySQL"时唯一诚实的答案（第 ⑤ 段：不许"归个类算了"）。
        throw new RangeError('SELECT VERSION() 没回一个字符串：对面应答了，但说的话不像 MySQL');
      }
      return { version };
    },
    end: () => pool.end(),
  };
};
