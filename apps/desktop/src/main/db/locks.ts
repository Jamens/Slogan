import { isEntityId, uuidv7, type EntityId } from '@dajia/core';
import type { Pool } from 'mysql2/promise';

/**
 * 工程锁（spec §8.2 的 S1 必做项）。三列都挂在 `project` 行上，不建第二张表（口径见计划 T6 第 ① 段）。
 *
 * 三条总纪律：
 * 1. **时间全归服务端**（P-4）：比较用 `NOW(3)`，写入用 `TIMESTAMPADD(MICROSECOND, ?, NOW(3))`，
 *    余额用 `TIMESTAMPDIFF(MICROSECOND, NOW(3), ...)`。本文件一次都不读客户机时钟 ——
 *    `locks-ticket.test.ts` 的源码扫描是这条口径唯一的常驻证人。
 * 2. **单语句 CAS**：不开事务，也不 `getConnection()`。InnoDB 在语句级串行化同一行的写，
 *    后到的那条等到行锁之后按**已提交的当前版本**重判 WHERE —— 所以"两个池同时 acquire
 *    恰好一个成功"是驱动与引擎给的，不是我们假设的（`locks.test.ts` 那一格测的就是它）。
 * 3. **`affectedRows` 只当快路**：判决来自写完之后的服务端读回，理由与限度都写在 `decide()` 上。
 *    Step 1 的 D 档实测修正了一条直觉：本仓 mysql2 3.24.5 默认带 `FOUND_ROWS`
 *    （`connection_config.js` 的 getDefaultFlags），同值重发 affectedRows 给 **1**、changedRows 给 0
 *    —— 在这套驱动上 affectedRows 数的是**匹配的行**，不是真变化的行。快路用它没错，
 *    但"没匹配上"之后的两种去向（工程行不在 / 活锁在别人手里）只有读回分得开。
 */

/** 默认余额：漏两次心跳（10 秒）才丢锁。T7 的定时器与 T8 的 IPC 默认值都从这里取。 */
export const LOCK_TTL_MS = 15_000;
export const LOCK_HEARTBEAT_INTERVAL_MS = 5_000;

/** TTL 的上界：一小时。超过它的值在形状上就像 bug，不像配置。 */
const TTL_MAX_MS = 3_600_000;
/** `project.lock_owner` 是 VARCHAR(200)，MySQL 数的是字符。前置校验的文案里就写这个数。 */
const OWNER_MAX_CHARS = 200;

export interface LockTicket {
  readonly projectId: EntityId;
  readonly token: EntityId;
  /** 给人看的那一个（横幅要直接显示它）：`机器名:pid` 之类的形状由调用方决定，本模块不猜。 */
  readonly owner: string;
}

export type AcquireOutcome = 'acquired' | 'busy' | 'no-project';
export type HeartbeatOutcome = 'renewed' | 'lost';
export type ReleaseOutcome = 'released' | 'not-mine';

export interface LockState {
  /** `project` 行在不在：不在时其余三项一律是"没有锁"的形状，不猜。 */
  readonly exists: boolean;
  /** 服务端算的：有余额的锁（不看票主是谁）。 */
  readonly held: boolean;
  /** `held && lock_token` 是我这张。过期了就不算 mine —— 与 `held` 同一个口径。 */
  readonly mine: boolean;
  readonly owner: string | null;
  /** 服务端算出的余额（毫秒，向下取整）。没锁、没票主、负余额都是 0，不是负数。 */
  readonly ttlMsRemaining: number;
}

/**
 * 「这把锁现在活着」的唯一文本。接管条件靠字符串拼接嵌进来（`ACQUIRE_WHERE`），
 * 所以两个谓词不可能各漂一半（T6-M3 打的就是另写一份）。取 `>`：`lock_expires_at` 是
 * "余额到这一刻为止"，到点即过期 ⇒ `ttlMs = 0` 的锁写完就不算活。
 * 这一毫秒内的相等边界造不出确定红（要写与读落在同一个 `NOW(3)` 刻度上），
 * 所以互补关系靠共享文本保证，不靠用例保证 —— 用例管的是两端那一对。
 */
const HELD_SQL = '`lock_expires_at` IS NOT NULL AND `lock_expires_at` > NOW(3)';

/**
 * 能不能拿：没人上锁、锁已过期、或那本来就是我的票（幂等重发）—— 三者任一。
 * `lock_token` IS NULL 那一支看着与 `NOT (HELD)` 重复，其实不重复：
 * 列被手搓成"票为空而余额在未来"那一型，只有这一支能拿（`locks.test.ts` 有一格）。
 */
const ACQUIRE_WHERE =
  '(`lock_token` IS NULL OR `lock_token` = ? OR NOT (' + HELD_SQL + '))';

/** 校验 + 换算。0 是合法读数（"我要一把写完就过期的锁"），不是测试后门。 */
export function ttlToMicroseconds(ttlMs: number): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0 || ttlMs > TTL_MAX_MS) {
    throw new RangeError(
      `ttlMs 必须是 0 到 ${TTL_MAX_MS} 之间的整数毫秒，收到 ${ttlMs}`,
    );
  }
  // 乘 1000 走 MICROSECOND 而不是把秒直接绑进去：DATETIME(3) 对小数秒会舍入，
  // 整型微秒让 0 与 300 这类值都能按字面意思落进语句。
  return ttlMs * 1000;
}

export function newLockTicket(input: {
  readonly projectId: EntityId;
  readonly owner: string;
}): LockTicket {
  if (!isEntityId(input.projectId)) {
    throw new RangeError(`projectId 不是 uuidv7 形状，收到 ${JSON.stringify(input.projectId)}`);
  }
  const { owner } = input;
  if (owner === '' || owner !== owner.trim()) {
    throw new RangeError('owner 不能为空或带首尾空白（它是横幅上直接显示的那一行）');
  }
  if (owner.length > OWNER_MAX_CHARS) {
    // 不许让 MySQL 去报这一发：1406 的文案里没有"哪把尺、多长"（Step 1 的 F 档实测：
    // strict mode 下它报 ER_DATA_TOO_LONG / "Data too long for column 'lock_owner' at row 1"，不截断）。
    throw new RangeError(
      `owner 不能超过 ${OWNER_MAX_CHARS} 个字符（project.lock_owner 是 VARCHAR(200)），收到 ${owner.length}`,
    );
  }
  return { projectId: input.projectId, token: uuidv7(), owner };
}

function affected(res: unknown): number {
  return Number((res as { affectedRows?: number }).affectedRows ?? 0);
}

/**
 * 写完之后的服务端读回：那一行现在是不是我的票。
 * 为什么判决不押在 `affectedRows` 上 —— Step 1 的 D 档在这台实例上实测：同值重发
 * affectedRows 给 1、changedRows 给 0（FOUND_ROWS 默认开启），所以它只回答"WHERE 匹配没匹配上"，
 * 连"为什么没匹配上"都分不开；拿它当唯一判据时"工程行不存在"会被误报成 `busy`（T6-M9 打的就是这一发），
 * 而快路接得住幂等重发（匹配 ⇒ 1 ⇒ `acquired`）不代表读回可以删 —— `no-project` 与 `busy` 的分家
 * 只有这一发读得出来。登记的限度（T6-M9）：brief 原设想的"同毫秒重发逐字节相同"那一型在这套驱动上
 * 根本走不到读回（快路直接给 1），故它造不出确定红；能确定打到删 `decide()` 的是 `no-project` 那一格。
 * 所以这段理由必须留在注释里，不许"简化"成快路。
 * `lock_token` 为 NULL 时 `lock_token = ?` 得 SQL NULL 而不是 0，所以前面挂 `IS NOT NULL`
 * （C 档实测：列 NULL 带守卫读 0、不带读 null；绑 SQL NULL 时表达式整体是 null）——
 * 两个读数都取 `=== 1`，不把"未知"读成"是"。
 */
async function decide(
  pool: Pool,
  projectId: EntityId,
  token: EntityId,
): Promise<'mine' | 'other' | 'no-project'> {
  const [res] = await pool.query(
    'SELECT (`lock_token` IS NOT NULL AND `lock_token` = ?) AS matched FROM `project` WHERE `id` = ?',
    [token, projectId],
  );
  const row = (res as { matched: number | null }[])[0];
  if (!row) return 'no-project';
  return Number(row.matched) === 1 ? 'mine' : 'other';
}

/**
 * 拿锁。返回 `'acquired'` 之后，`ticket.token` 就是那一行上的票；
 * 返回 `'busy'` 时**什么都不必清理** —— 一发没匹配的 UPDATE 不改任何东西。
 */
export async function acquireLock(
  pool: Pool,
  ticket: LockTicket,
  ttlMs: number = LOCK_TTL_MS,
): Promise<AcquireOutcome> {
  const micros = ttlToMicroseconds(ttlMs);
  const [res] = await pool.query(
    'UPDATE `project` SET `lock_token` = ?, `lock_owner` = ?, ' +
      '`lock_expires_at` = TIMESTAMPADD(MICROSECOND, ?, NOW(3)) ' +
      'WHERE `id` = ? AND ' +
      ACQUIRE_WHERE,
    [ticket.token, ticket.owner, micros, ticket.projectId, ticket.token],
  );
  if (affected(res) === 1) return 'acquired';
  const who = await decide(pool, ticket.projectId, ticket.token);
  return who === 'mine' ? 'acquired' : who === 'other' ? 'busy' : 'no-project';
}

/**
 * 续锁。WHERE 只认票不认余额（口径见计划 T6 第 ④ 段）：过期但还没人接管的锁，
 * 心跳等于一次少往返的重新 acquire；一旦有人接管，票已经换人 ⇒ `'lost'`。
 * 工程行没了也返回 `'lost'`（而不是抛）：调用方对"我没锁了"与"工程没了"的动作是同一个 —— 停手。
 */
export async function heartbeat(
  pool: Pool,
  ticket: LockTicket,
  ttlMs: number = LOCK_TTL_MS,
): Promise<HeartbeatOutcome> {
  const micros = ttlToMicroseconds(ttlMs);
  const [res] = await pool.query(
    'UPDATE `project` SET `lock_expires_at` = TIMESTAMPADD(MICROSECOND, ?, NOW(3)) ' +
      'WHERE `id` = ? AND `lock_token` = ?',
    [micros, ticket.projectId, ticket.token],
  );
  if (affected(res) === 1) return 'renewed';
  return (await decide(pool, ticket.projectId, ticket.token)) === 'mine' ? 'renewed' : 'lost';
}

/**
 * 解锁。只清自己的票：WHERE 带 `lock_token = ?`，接管之后这一发匹配不上 ⇒ `'not-mine'`，
 * 别人的余额一个字不动（`locks.test.ts` 里那条判据的形状）。
 * 这一发不需要读回：匹配上的行必然带着非 NULL 的三列，SET NULL 必然真变化；
 * 即便按 D 档实测的 FOUND_ROWS 口径（affectedRows 数匹配的行），匹配 ⇒ 1 的结论也一样 ——
 * 两种口径下结论相同，才敢只走快路。
 */
export async function releaseLock(pool: Pool, ticket: LockTicket): Promise<ReleaseOutcome> {
  const [res] = await pool.query(
    'UPDATE `project` SET `lock_token` = NULL, `lock_owner` = NULL, `lock_expires_at` = NULL ' +
      'WHERE `id` = ? AND `lock_token` = ?',
    [ticket.projectId, ticket.token],
  );
  return affected(res) === 1 ? 'released' : 'not-mine';
}

/**
 * 读锁状态（只读，不加锁、不写）。`token` 传 null 就是"我只想知道有没有人拿着，不参与判定"。
 * 余额在这一发里只做一次 µs→ms 的换算；`locks.test.ts` 另有一格在同一语句里读 `DIV 1000`
 * —— 两处换算各有各的证人（T6-M10 一次打两个）。
 */
export async function lockState(
  pool: Pool,
  projectId: EntityId,
  token: EntityId | null = null,
): Promise<LockState> {
  const [res] = await pool.query(
    'SELECT `lock_owner` AS owner, ' +
      '(`lock_token` IS NOT NULL AND `lock_token` = ?) AS matched, ' +
      `(${HELD_SQL}) AS held, ` +
      'IFNULL(TIMESTAMPDIFF(MICROSECOND, NOW(3), `lock_expires_at`), 0) AS ttl_us ' +
      'FROM `project` WHERE `id` = ?',
    [token, projectId],
  );
  const row = (
    res as { owner: string | null; matched: number | null; held: number | null; ttl_us: number | string | null }[]
  )[0];
  if (!row) {
    return { exists: false, held: false, mine: false, owner: null, ttlMsRemaining: 0 };
  }
  const held = Number(row.held) === 1;
  const micros = Number(row.ttl_us);
  return {
    exists: true,
    held,
    mine: held && Number(row.matched) === 1,
    owner: row.owner,
    // 向下取整：宁可报"比真值少一毫秒"，也不报一把已经不活的锁还有余额。
    ttlMsRemaining: held && Number.isFinite(micros) && micros > 0 ? Math.trunc(micros / 1000) : 0,
  };
}
