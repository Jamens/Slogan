import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'mysql2/promise';
import {
  Document,
  SCHEMA_VERSION,
  applyPatch,
  storeyCreate,
  uuidv7,
  type Command,
  type Entity,
  type EntityId,
  type Patch,
} from '@dajia/core';
import { createDbPool } from '../../src/main/db/pool';
import { readMysqlEnv } from '../../src/main/db/env';
import { dropTestDatabase, ensureDatabase } from '../../src/main/db/database';
import { migrate } from '../../src/main/db/migrate';
import { ProjectRepository } from '../../src/main/db/repository';
import {
  LOCK_TTL_MS,
  acquireLock,
  heartbeat,
  lockState,
  newLockTicket,
  releaseLock,
  type LockTicket,
} from '../../src/main/db/locks';

const env = readMysqlEnv();
// 红线同前两档：库名由本文件写死，不抄 env（env.database 允许是 dajia）。
const DATABASE = 'dajia_test';
const PROJECT_ID = '0193aa00-0000-7000-8000-00000000000a' as EntityId;
const OTHER_PROJECT = '0193aa00-0000-7000-8000-00000000000f' as EntityId;

/** 一格里的两个"机器"。名字只在 owner 文案里出现，不参与判定。 */
const OWNER_A = '机器A:1001';
const OWNER_B = '机器B:2002';

let pool: Pool;
let holderPool: Pool;
let rivalPool: Pool;
let editPool: Pool;
let repo: ProjectRepository;
let editRepo: ProjectRepository;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [res] = await pool.query(sql, params);
  return res as T[];
}

async function count(table: string, where = '', params: unknown[] = []): Promise<number> {
  const [res] = await pool.query(`SELECT COUNT(*) AS n FROM \`${table}\`${where}`, params);
  return Number((res as { n: number | string }[])[0]?.n);
}

/** 手搓坏列用的那一发（返回值是 affectedRows，判据要求它真改到行才算夹具立住了）。 */
async function exec(sql: string, params: unknown[] = []): Promise<number> {
  const [res] = await pool.query(sql, params);
  return Number((res as { affectedRows?: number }).affectedRows ?? 0);
}

async function clearAll(): Promise<void> {
  await pool.query('DELETE FROM `project`');
}

function ticket(owner: string, projectId: EntityId = PROJECT_ID): LockTicket {
  return newLockTicket({ projectId, owner });
}

/**
 * 条件轮询而不是固定 sleep：等的是"服务端说这把锁没余额了"那个**状态**，
 * 不是 300 毫秒（P-4 的代价：TTL 只能真等，不能拨表）。
 * 这一处 `performance.now()` 在测试里 —— 第 ② 段那条"产品代码不读客户机时钟"的扫描管的是 `locks.ts`，
 * 测试要计时总得有表。
 */
async function waitUntilNotHeld(projectId: EntityId, token: EntityId, deadlineMs = 5_000): Promise<void> {
  const started = performance.now();
  for (;;) {
    const state = await lockState(pool, projectId, token);
    if (!state.held) return;
    if (performance.now() - started > deadlineMs) {
      throw new TypeError(`等 ${deadlineMs}ms 锁还没过期：${JSON.stringify(state)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function step(doc: Document, cmd: Command): { patch: Patch; doc: Document } {
  const patch = cmd.build(doc);
  return { patch, doc: applyPatch(doc, patch).doc };
}

beforeAll(async () => {
  await dropTestDatabase(env, DATABASE);
  await ensureDatabase(env, DATABASE);
  // 迁移连接单独开（P-65：`multipleStatements` 只准住在迁移连接上；业务池不开它）。
  // brief 原稿把这发直接压在业务池上，实测 SQL 语法错（`001_init.sql` 是多语句 DDL）——
  // 照 `journal.test.ts` 的形状补一个用完即关的 migratePool。
  const migratePool = createDbPool({ ...env, database: DATABASE }, { multipleStatements: true });
  try {
    await migrate(migratePool, DATABASE);
  } finally {
    await migratePool.end();
  }
  pool = createDbPool({ ...env, database: DATABASE });
  // 两个池 = 两台机器。connectionLimit 用 2 而不是 1：并发那一格要两条连接真并发。
  // lockWaitTimeoutSeconds 2（不是默认 50 秒）：万一将来有人把 CAS 改成"先 SELECT FOR UPDATE 再 UPDATE"，
  // 这里 2 秒就炸，而不是让测试看起来像挂死（P-17 那条口径在锁这一档的形状）。
  holderPool = createDbPool(
    { ...env, database: DATABASE },
    { connectionLimit: 2, lockWaitTimeoutSeconds: 2 },
  );
  rivalPool = createDbPool(
    { ...env, database: DATABASE },
    { connectionLimit: 2, lockWaitTimeoutSeconds: 2 },
  );
  // 第三档池只为一格服务（P-71：`loadProject('edit')` 自己那把行锁的证人 + 回滚的证人）。
  // 不能借用 holderPool/rivalPool：它们 `connectionLimit: 2`，漏一次 release 还有第二条连接顶着；
  // 这一档限 1 条 + 1 秒锁等待，跟 `journal.test.ts` 的 `repoPool` 同形状 ⇒ "拒开之后同池还能再走一次"
  // 才真的在证"那条连接带着已结束的事务回到了池里"。
  editPool = createDbPool(
    { ...env, database: DATABASE },
    { connectionLimit: 1, lockWaitTimeoutSeconds: 1 },
  );
  repo = new ProjectRepository(pool, PROJECT_ID, 'watcher');
  editRepo = new ProjectRepository(editPool, PROJECT_ID, 'editor');
});

afterAll(async () => {
  await editPool.end();
  await rivalPool.end();
  await holderPool.end();
  await pool.end();
  await dropTestDatabase(env, DATABASE);
});

beforeEach(async () => {
  await clearAll();
  await repo.createProject({ name: '锁样例工程', schemaVersion: SCHEMA_VERSION });
});

describe('拿锁（单语句 CAS）', () => {
  it('没人上锁 ⇒ acquired，三列都有账', async () => {
    const a = ticket(OWNER_A);
    expect(await acquireLock(holderPool, a, 60_000)).toBe('acquired');
    const state = await lockState(pool, PROJECT_ID, a.token);
    expect(state.exists).toBe(true);
    expect(state.held).toBe(true);
    expect(state.mine).toBe(true);
    expect(state.owner).toBe(OWNER_A);
    expect(state.ttlMsRemaining).toBeGreaterThan(0);
    expect(state.ttlMsRemaining).toBeLessThanOrEqual(60_000);
  });

  it('同一张票再拿一次 ⇒ acquired（幂等，不是 busy）', async () => {
    const a = ticket(OWNER_A);
    expect(await acquireLock(holderPool, a, 60_000)).toBe('acquired');
    expect(await acquireLock(holderPool, a, 60_000)).toBe('acquired');
    expect((await lockState(pool, PROJECT_ID, a.token)).owner).toBe(OWNER_A);
  });

  it('别人持着活锁 ⇒ busy，且读得到是谁', async () => {
    const a = ticket(OWNER_A);
    const b = ticket(OWNER_B);
    expect(await acquireLock(holderPool, a, 60_000)).toBe('acquired');
    expect(await acquireLock(rivalPool, b, 60_000)).toBe('busy');
    // busy 那一发不许改到任何东西：票、owner、余额都还是 A 的。
    const state = await lockState(pool, PROJECT_ID, b.token);
    expect(state.held).toBe(true);
    expect(state.mine).toBe(false);
    expect(state.owner).toBe(OWNER_A);
    expect((await lockState(pool, PROJECT_ID, a.token)).mine).toBe(true);
  });

  it('工程行不存在 ⇒ no-project，不是 busy', async () => {
    const ghost = ticket(OWNER_A, uuidv7() as EntityId);
    expect(await acquireLock(holderPool, ghost, 60_000)).toBe('no-project');
    expect((await lockState(pool, ghost.projectId, ghost.token)).exists).toBe(false);
  });

  it('锁按工程分：A 持 P1 不妨碍 B 拿 P2', async () => {
    const other = new ProjectRepository(pool, OTHER_PROJECT, 'watcher');
    await other.createProject({ name: '第二个工程', schemaVersion: SCHEMA_VERSION });
    const a = ticket(OWNER_A, PROJECT_ID);
    const b = ticket(OWNER_B, OTHER_PROJECT);
    expect(await acquireLock(holderPool, a, 60_000)).toBe('acquired');
    expect(await acquireLock(rivalPool, b, 60_000)).toBe('acquired');
    expect((await lockState(pool, PROJECT_ID, a.token)).owner).toBe(OWNER_A);
    expect((await lockState(pool, OTHER_PROJECT, b.token)).owner).toBe(OWNER_B);
  });

  it('解 P1 的锁不动 P2 的锁', async () => {
    const other = new ProjectRepository(pool, OTHER_PROJECT, 'watcher');
    await other.createProject({ name: '第二个工程', schemaVersion: SCHEMA_VERSION });
    const a = ticket(OWNER_A, PROJECT_ID);
    const b = ticket(OWNER_B, OTHER_PROJECT);
    await acquireLock(holderPool, a, 60_000);
    await acquireLock(rivalPool, b, 60_000);
    expect(await releaseLock(holderPool, a)).toBe('released');
    expect((await lockState(pool, OTHER_PROJECT, b.token)).held).toBe(true);
    expect((await lockState(pool, PROJECT_ID, a.token)).held).toBe(false);
  });
});

describe('过期与接管（判定全在服务端时钟）', () => {
  it('ttlMs = 0 的锁写完就不算活（SLEEP 跨过 1 毫秒刻度，不是靠 sleep 撞）', async () => {
    const a = ticket(OWNER_A);
    expect(await acquireLock(holderPool, a, 0)).toBe('acquired');
    await rows<{ s: number }>('SELECT SLEEP(0.002) AS s');
    const state = await lockState(pool, PROJECT_ID, a.token);
    expect(state.held).toBe(false);
    expect(state.mine).toBe(false);
    expect(state.ttlMsRemaining).toBe(0);
    // 票还在列上：过期不等于释放。这是第 ④ 段"心跳能复活"的前提。
    expect((await rows<{ owner: string | null }>('SELECT `lock_owner` AS owner FROM `project` WHERE `id` = ?', [PROJECT_ID]))[0]?.owner).toBe(OWNER_A);
  });

  it('过期的锁可以被第二个池接管，接管者三列全换成自己的', async () => {
    const a = ticket(OWNER_A);
    const b = ticket(OWNER_B);
    expect(await acquireLock(holderPool, a, 0)).toBe('acquired');
    await rows<{ s: number }>('SELECT SLEEP(0.002) AS s');
    expect(await acquireLock(rivalPool, b, 60_000)).toBe('acquired');
    expect((await lockState(pool, PROJECT_ID, b.token)).mine).toBe(true);
    expect((await lockState(pool, PROJECT_ID, a.token)).mine).toBe(false);
    expect((await lockState(pool, PROJECT_ID, null)).owner).toBe(OWNER_B);
  });

  it('列被手搓成"票为空而余额在未来"⇒ 照样能拿（ACQUIRE_WHERE 那一支的证人）', async () => {
    const a = ticket(OWNER_A);
    expect(await acquireLock(holderPool, a, 60_000)).toBe('acquired');
    expect(
      await exec('UPDATE `project` SET `lock_token` = NULL, `lock_owner` = NULL WHERE `id` = ?', [
        PROJECT_ID,
      ]),
    ).toBe(1);
    const b = ticket(OWNER_B);
    expect(await acquireLock(rivalPool, b, 60_000)).toBe('acquired');
  });

  it('列被手搓成"票有值而余额为空"⇒ 别人能拿（HELD 的 NULL 分支）', async () => {
    const a = ticket(OWNER_A);
    expect(await acquireLock(holderPool, a, 60_000)).toBe('acquired');
    expect(await exec('UPDATE `project` SET `lock_expires_at` = NULL WHERE `id` = ?', [PROJECT_ID])).toBe(1);
    const b = ticket(OWNER_B);
    expect(await acquireLock(rivalPool, b, 60_000)).toBe('acquired');
    expect((await lockState(pool, PROJECT_ID, b.token)).mine).toBe(true);
  });

  it('真等接管全链：A 的锁过期 ⇒ B 拿走 ⇒ A 下一次心跳 lost', async () => {
    const a = ticket(OWNER_A);
    const b = ticket(OWNER_B);
    expect(await acquireLock(holderPool, a, 300)).toBe('acquired');
    expect(await heartbeat(holderPool, a, 300)).toBe('renewed');
    await waitUntilNotHeld(PROJECT_ID, a.token);
    expect(await acquireLock(rivalPool, b, 60_000)).toBe('acquired');
    expect(await heartbeat(holderPool, a, 60_000)).toBe('lost');
    // A 的 beat 不许动 B 的账（WHERE 带 token 的那一半凭据）。
    expect((await lockState(pool, PROJECT_ID, b.token)).mine).toBe(true);
    expect((await lockState(pool, PROJECT_ID, null)).owner).toBe(OWNER_B);
  });

  it('接管之后原持有者解锁 ⇒ not-mine，且接管者的余额原样还在', async () => {
    const a = ticket(OWNER_A);
    const b = ticket(OWNER_B);
    expect(await acquireLock(holderPool, a, 0)).toBe('acquired');
    await rows<{ s: number }>('SELECT SLEEP(0.002) AS s');
    expect(await acquireLock(rivalPool, b, 60_000)).toBe('acquired');
    expect(await releaseLock(holderPool, a)).toBe('not-mine');
    const after = await lockState(pool, PROJECT_ID, b.token);
    expect(after.held).toBe(true);
    expect(after.mine).toBe(true);
    expect(after.owner).toBe(OWNER_B);
    expect(after.ttlMsRemaining).toBeGreaterThan(0);
  });
});

describe('心跳', () => {
  it('活锁 beat ⇒ renewed', async () => {
    const a = ticket(OWNER_A);
    await acquireLock(holderPool, a, 60_000);
    expect(await heartbeat(holderPool, a, 60_000)).toBe('renewed');
    expect((await lockState(pool, PROJECT_ID, a.token)).held).toBe(true);
  });

  it('过期但仍是我的票 ⇒ beat 把它复活（第 ④ 段那条口径的证人）', async () => {
    const a = ticket(OWNER_A);
    expect(await acquireLock(holderPool, a, 0)).toBe('acquired');
    await rows<{ s: number }>('SELECT SLEEP(0.002) AS s');
    expect((await lockState(pool, PROJECT_ID, a.token)).held).toBe(false);
    expect(await heartbeat(holderPool, a, 60_000)).toBe('renewed');
    const after = await lockState(pool, PROJECT_ID, a.token);
    expect(after.held).toBe(true);
    expect(after.mine).toBe(true);
    expect(after.ttlMsRemaining).toBeGreaterThan(0);
  });

  it('心跳只推余额：票与 owner 一个字不动', async () => {
    const a = ticket(OWNER_A);
    await acquireLock(holderPool, a, 0);
    const before = await rows<{ token: string | null; owner: string | null }>(
      'SELECT `lock_token` AS token, `lock_owner` AS owner FROM `project` WHERE `id` = ?',
      [PROJECT_ID],
    );
    expect(await heartbeat(holderPool, a, 60_000)).toBe('renewed');
    const after = await rows<{ token: string | null; owner: string | null }>(
      'SELECT `lock_token` AS token, `lock_owner` AS owner FROM `project` WHERE `id` = ?',
      [PROJECT_ID],
    );
    expect(after[0]).toEqual(before[0]);
  });

  it('工程行被删 ⇒ lost（不抛）：调用方对两种情况的动作是同一个', async () => {
    const a = ticket(OWNER_A);
    await acquireLock(holderPool, a, 60_000);
    await clearAll();
    expect(await heartbeat(holderPool, a, 60_000)).toBe('lost');
  });

  it('余额读数按毫秒：60_000 的锁读回来在 (50_000, 60_000]', async () => {
    const a = ticket(OWNER_A);
    await acquireLock(holderPool, a, 60_000);
    const state = await lockState(pool, PROJECT_ID, a.token);
    expect(state.ttlMsRemaining).toBeGreaterThan(50_000);
    expect(state.ttlMsRemaining).toBeLessThanOrEqual(60_000);
  });

  it('同一语句里算的差值也按毫秒：DIV 1000 的读数落在 (55_000, 60_000]', async () => {
    const a = ticket(OWNER_A);
    await acquireLock(holderPool, a, 60_000);
    const read = await rows<{ ms: number | string }>(
      'SELECT TIMESTAMPDIFF(MICROSECOND, NOW(3), `lock_expires_at`) DIV 1000 AS ms ' +
        'FROM `project` WHERE `id` = ?',
      [PROJECT_ID],
    );
    const ms = Number(read[0]?.ms);
    expect(ms).toBeGreaterThan(55_000);
    expect(ms).toBeLessThanOrEqual(60_000);
    // 顺手把"余额是被 TTL 决定的"钉住：改成写死一天，上面两格一起红（T6-M10 的另一半）。
    expect(ms).toBeLessThanOrEqual(LOCK_TTL_MS * 4);
  });
});

describe('解锁', () => {
  it('release ⇒ released，三列一起归 NULL', async () => {
    const a = ticket(OWNER_A);
    await acquireLock(holderPool, a, 60_000);
    expect(await releaseLock(holderPool, a)).toBe('released');
    const raw = await rows<{ token: string | null; owner: string | null; expires: string | null }>(
      'SELECT `lock_token` AS token, `lock_owner` AS owner, `lock_expires_at` AS expires FROM `project` WHERE `id` = ?',
      [PROJECT_ID],
    );
    expect(raw[0]).toEqual({ token: null, owner: null, expires: null });
    const state = await lockState(pool, PROJECT_ID, a.token);
    expect(state.held).toBe(false);
    expect(state.owner).toBe(null);
    expect(state.ttlMsRemaining).toBe(0);
  });

  it('没上锁时 release ⇒ not-mine（快路不需要读回的那一型）', async () => {
    expect(await releaseLock(holderPool, ticket(OWNER_A))).toBe('not-mine');
  });

  it('release 两次 ⇒ 第二次 not-mine（幂等不许说成 released）', async () => {
    const a = ticket(OWNER_A);
    await acquireLock(holderPool, a, 60_000);
    expect(await releaseLock(holderPool, a)).toBe('released');
    expect(await releaseLock(holderPool, a)).toBe('not-mine');
  });

  it('release 之后 beat ⇒ lost', async () => {
    const a = ticket(OWNER_A);
    await acquireLock(holderPool, a, 60_000);
    await releaseLock(holderPool, a);
    expect(await heartbeat(holderPool, a, 60_000)).toBe('lost');
  });

  it('release 只解一张票，不动别人的锁', async () => {
    const a = ticket(OWNER_A);
    const b = ticket(OWNER_B);
    await acquireLock(rivalPool, b, 60_000);
    expect(await releaseLock(holderPool, a)).toBe('not-mine');
    expect((await lockState(pool, PROJECT_ID, b.token)).mine).toBe(true);
  });
});

describe('两个池同时抢（不等时钟）', () => {
  it('并发 acquire ⇒ 恰好一个 acquired、一个 busy', async () => {
    const a = ticket(OWNER_A);
    const b = ticket(OWNER_B);
    const [ra, rb] = await Promise.all([
      acquireLock(holderPool, a, 60_000),
      acquireLock(rivalPool, b, 60_000),
    ]);
    expect([ra, rb].sort()).toEqual(['acquired', 'busy']);
    const winner = ra === 'acquired' ? a : b;
    const state = await lockState(pool, PROJECT_ID, winner.token);
    expect(state.mine).toBe(true);
    // 行上带的是两位竞得者之一，不是 null 也不是第三个名字（brief 原稿的
    // `owner === OWNER_A && owner === OWNER_B` 在 TS 的字面量收窄下 TS2367、
    // 且运行时恒假 —— 改成"或"式断言，同一意图才真正有牙）。
    expect(state.owner === OWNER_A || state.owner === OWNER_B).toBe(true);
    // 隔离级别只是这条判据的背景说明，不是判据本身：真并发下的形状由这一格测。
    const iso = await rows<{ level: string }>('SELECT @@transaction_isolation AS level');
    process.stdout.write(`[T6] transaction_isolation=${iso[0]?.level ?? '读不到'}\n`);
  });

  it('赢家释放后输家能拿到（锁没被"赢完就僵住"）', async () => {
    const a = ticket(OWNER_A);
    const b = ticket(OWNER_B);
    const [ra] = await Promise.all([
      acquireLock(holderPool, a, 60_000),
      acquireLock(rivalPool, b, 60_000),
    ]);
    const winner = ra === 'acquired' ? a : b;
    const loser = winner === a ? b : a;
    expect(await releaseLock(holderPool, winner)).toBe('released');
    expect(await acquireLock(rivalPool, loser, 60_000)).toBe('acquired');
  });
});

describe('锁与写路径互不知情（第 ⑥ 段那对相反的判据）', () => {
  it('拿锁不动账：journal_turn 与四张表一个字不变', async () => {
    const before = await rows<{ turn: number | string }>(
      'SELECT `journal_turn` AS turn FROM `project` WHERE `id` = ?',
      [PROJECT_ID],
    );
    const a = ticket(OWNER_A);
    await acquireLock(holderPool, a, 60_000);
    await heartbeat(holderPool, a, 60_000);
    await releaseLock(holderPool, a);
    const after = await rows<{ turn: number | string }>(
      'SELECT `journal_turn` AS turn FROM `project` WHERE `id` = ?',
      [PROJECT_ID],
    );
    expect(after[0]?.turn).toBe(before[0]?.turn);
    expect(await count('command_log')).toBe(0);
    expect(await count('element')).toBe(0);
    expect(await count('storey')).toBe(0);
    expect(await count('snapshot')).toBe(0);
  });

  it('没拿锁也能 appendJournal ⇒ applied（S1 不建模"对抗自己的代码"）', async () => {
    const t1 = step(
      Document.create(PROJECT_ID),
      storeyCreate({ projectId: PROJECT_ID, index: 0, elevationMm: 0, heightMm: 3000 }),
    );
    // 这一格钉的是**现状**：写路径认不认票是一个会被下一个人误改的口径。
    // 若将来要给 appendJournal 加锁校验，改的是这条判据与计划文本，不许两边都留着。
    expect(await repo.appendJournal({ turn: 1, patch: t1.patch, doc: t1.doc })).toBe('applied');
    const state = await lockState(pool, PROJECT_ID, null);
    expect(state.held).toBe(false);
    expect((t1.patch.upsert[0] as Entity).kind).toBe('storey');
  });
});

describe('那一把行锁的两个方向（P-71：T5-M9 那发恒绿的可达补法）', () => {
  // T5 的 T5-M9（删掉 `repository.ts:320` 的 `FOR UPDATE`）在 `journal.test.ts` 里 53 格全绿 ——
  // 一个池、一条连接、串行执行，那把锁根本没有第二个要锁的人，所以它是**登记过的限度**。
  // 这里补的是可达形状（照 `repository.test.ts` 的「半途被外部行锁掐断 ⇒ 全无账；释放后同 turn 重发成功（P-15…）」那一发）：
  // 让**另一个连接**真把 `project` 那一行锁住不提交：`edit` 支必须在 1 秒内被拒开（fail-fast），`read` 支必须不等。
  // 限度照 T6-M17 实测：删掉 `repository.ts:320` 的 `FOR UPDATE` 这两格**不会红** —— 裸 SELECT 是 MVCC 的
  // 非锁定读，而 edit 支后续的 `clean_shutdown` UPDATE 照样撞同一把未提交锁。所以这两格证的是
  // "edit 路径 1 秒拒开"，**不是**":320 是等锁那一句"；语句级的证人靠 fail-fast 结构 + T6-M18 的反向牙。
  it('外部连接锁住 project 行 ⇒ edit 支等锁超时拒开；放锁后同池再走一次 ⇒ 读得开也收得尾', async () => {
    const blocker = await holderPool.getConnection();
    try {
      await blocker.beginTransaction();
      await blocker.query('SELECT `id` FROM `project` WHERE `id` = ? FOR UPDATE', [PROJECT_ID]);
      // `editPool` 的 `lockWaitTimeoutSeconds: 1` ⇒ 1 秒就炸，不是 50 秒（`pool.ts` 的 connection 事件那条）。
      await expect(editRepo.loadProject('edit')).rejects.toThrow(/Lock wait timeout/);
      // 拒开这一发不留痕迹：`repository.ts` 的抹 0 排在所有拒开判据**之后**（`:440` 晚于 `:431`），
      // 这一发连那一行都没读到，更轮不到它。
      expect(await count('command_log')).toBe(0);
      expect(
        (await rows<{ c: number | string }>('SELECT `clean_shutdown` AS c FROM `project` WHERE `id` = ?', [PROJECT_ID]))[0]?.c,
      ).toBe(1);

      await blocker.rollback();
      // 后半发是 `rollback()` + `release()` 的证人（`repository.ts:458-464` 那对 catch/finally）。
      // `editPool` 只有 **1 条连接**：上一发若把事务留在半途、或没把连接放回池，这里要么卡在
      // `getConnection`、要么再撞一次锁超时 —— 两种都红，不会静默通过。
      const got = await editRepo.loadProject('edit');
      expect(got.header.journalTurn).toBe(0);
      expect(got.snapshot).toBeNull();
      expect(got.replayed.rows).toBe(0);
      // `closeProject` 的签名收一份文档（`closeProject(doc)`）：收的就是上面刚读回的那份空文档 ——
      // 空文档 ↔ 零投影行，三方对账才过得去；直呼 `closeProject()` 少一个实参会在函数第一行 TypeError。
      const closed = await editRepo.closeProject(got.doc);
      expect(closed.elementRows).toBe(0);
      expect(closed.storeyRows).toBe(0);
      expect(
        (await rows<{ c: number | string }>('SELECT `clean_shutdown` AS c FROM `project` WHERE `id` = ?', [PROJECT_ID]))[0]?.c,
      ).toBe(1);
    } finally {
      await blocker.release();
    }
  });

  it('同一把外部锁底下 read 支照样读得开，且一个字不写（旁观者不该被编辑者的锁饿死）', async () => {
    const blocker = await holderPool.getConnection();
    try {
      await blocker.beginTransaction();
      await blocker.query('SELECT `id` FROM `project` WHERE `id` = ? FOR UPDATE', [PROJECT_ID]);
      // 一致性读不抢行锁 ⇒ 这一发**必须**在外部锁还握着的时候成功。T8 的"拿不到锁就用 read 打开"
      // 全靠这一条：编辑者锁着工程，旁观者照样能看。
      const got = await editRepo.loadProject('read');
      expect(got.header.wasCleanShutdown).toBe(true);
      expect(got.header.journalTurn).toBe(0);
      // 读意图不写：`repository.ts` 那一发 UPDATE 挂在 `intent === 'edit'` 上（M8 的牙在写侧，这一格锁侧）。
      expect(
        (await rows<{ c: number | string }>('SELECT `clean_shutdown` AS c FROM `project` WHERE `id` = ?', [PROJECT_ID]))[0]?.c,
      ).toBe(1);
    } finally {
      await blocker.rollback();
      await blocker.release();
    }
  });
});
