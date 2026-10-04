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
  /**
   * 行锁等待秒数。**唯一读者是 `repository.test.ts` 的第 12 格**（裁决 P-15：外部连接持行锁
   * 把事务掐断）。默认 50 秒会让那一格看起来像挂死，而测试要的是一次**快速、可断言**的失败。
   * 生产连接不设它 —— "一次保存卡 50 秒"是产品问题，不该由存储层替产品决定。
   *
   * 落地方式（实测选型，见 task-4-report Step 5 回填）：mysql2 既无 `sessionVariables` 连接项、
   * 其 typings 也不接受（`grep` 在 lib/ 与 typings/ 两处都零命中），所以走 `pool.on('connection')`
   * 里对**新建连接**发 `SET SESSION innodb_lock_wait_timeout`。探针实测：promise 池转发的 'connection'
   * 事件回的是底层 callback 连接（`conn.constructor.name = PoolConnection`），其 `query(sql)` 返回带
   * `.then` 的 sequence 且会把 SET 排进这条连接的队列 ⇒ `connectionLimit:1` 下后续取到的就是同一条、
   * 超时已生效（探针读数 `@@innodb_lock_wait_timeout = 1`）。秒数先验成 1..65535 的整数再插值 ⇒ 无注入面。
   */
  readonly lockWaitTimeoutSeconds?: number;
}

export function createDbPool(env: MysqlEnv, opts: PoolOptions = {}): Pool {
  const pool = createPool({
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
    // P-17：BIGINT 四列（journal_turn / turn / seq / updated_seq）默认被 mysql2 直接转 JS number，
    // 超出 2^53 静默失精。supportBigNumbers 开 + bigNumberStrings 关 ⇒ "范围内回 number、范围外回 string"，
    // 而 string 过不了 MmSchema / JournalTurnSchema ⇒ 越界变成一次抛，不是一次悄悄写歪的账。
    // Step 1 的 D 档读数就是这两行的凭据（关着时 9007199254740993 → 失精 number，开着 → 精确 string）；
    // 第 2 格把它钉成断言。本仓库这四列的实际取值都远小于 2^53 ⇒ 常态回 number，两条配置只在越界处起作用。
    // 读数口径现在有两格读者：T4 的 BIGINT 字面量探针（repository.test.ts 的「越界的 LONGLONG 回 string」），
    // 与 T5 的 `asSafeInt64`（journal.test.ts 的「journal_turn 超出 JS 安全整数」那一格）。
    // brief 说"这两格的牙都在这两行配置上，关掉就红在那一格" —— 实测只对它一半，两格各有各的漂法：
    // ①关掉下面这两行（T5-M7pool）：红的是 **T4 那一格**（`typeof` 从 string 变回 number），
    //   journal 那一格反而**不红**：9007199254740993 失精成 2^53，而 2^53 也不是安全整数，
    //   `asSafeInt64` 的第二支照样抛 ⇒ 它测不出配置被关掉（`tmp/t5-mut-T5-M7pool-journal+repo.log`）。
    // ②只删 `asSafeInt64` 的 string 支（T5-M7 的字面删法）：**`journal+repo` 靶全绿**，因为第二支
    //   `Number.isSafeInteger` 已经把 string 挡在外面（它不是 number）。要打出这一支得把整个函数
    //   变成 `return Number(raw)`（T5-M7b），那一发才红在 journal 那一格上。
    // 留这一格不是嫌 brief 啰嗦：它是"下面这两行配置 + `asSafeInt64` 的两个分支"互相遮蔽关系唯一的实测记录，
    // 摘掉任一条另一条会顶上来。口径也钉死（别用裸计数）：配置是**两行**、分支是**两个**，
    // 不是"两道守卫 / 三道守卫"那种各数各的说法 —— 两种说法都自洽，并排读就会让人以为有人改过函数。
    supportBigNumbers: true,
    bigNumberStrings: false,
  });

  if (opts.lockWaitTimeoutSeconds !== undefined) {
    const seconds = opts.lockWaitTimeoutSeconds;
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 65_535) {
      throw new RangeError(
        `lockWaitTimeoutSeconds 必须是 1..65535 的整数（innodb_lock_wait_timeout 的取值域），收到 ${seconds}`,
      );
    }
    const sql = `SET SESSION innodb_lock_wait_timeout = ${seconds}`;
    pool.on('connection', (conn) => {
      // 类型与运行时分叉，这是全任务最阴的一处：
      // · 类型侧：mysql2/promise 把 'connection' 事件的 `conn` 声明成 **promise** PoolConnection
      //   （`promise.d.ts:97`），所以 `conn.query(sql).then(...)` 能过 tsc —— 这也正是初版 Step 5
      //   写完 tsc 全绿的由来。
      // · 运行时侧：promise 池把事件原样转发给**底层 callback 连接**（探针实测 `conn.promise` 存在、
      //   `conn.query` 是 callback 版）。对它返回的东西调 `.then()` 当场踩中 mysql2 的 promise-wrapper
      //   误用报错（"You have tried to call .then()... on the result of query that is not a promise"）；
      //   这发异常抛在事件监听里会打断建连接流程 ⇒ `pool.getConnection()` 永不 resolve ⇒ 整个 suite 挂死
      //   （`tmp/t4-repo-verbatim2.log` 那一发就是这条：0 完成、20 skip）。
      // 正确写法就是探针用的那一发：**单参数 fire-and-forget** `conn.query(sql)`，不带 callback、不调 .then。
      // 单参数既过类型（promise 重载里有 `query(sql): Promise<...>`，`void` 丢弃）又走 runtime（callback 版
      // 收到 1 个 sql 参数即入队执行）。实测：这样改完 `getConnection` 2ms 返回、`@@innodb_lock_wait_timeout`
      // 回 1（`probe-connection-callback.mjs`，见报告 Step 5 回填）。
      // SET 的成败不靠这里观察：由第 12 格 `rejects.toThrow(/Lock wait timeout/)` 端到端兜底
      // —— 它若没生效会卡在默认 50 秒而不是快速抛，那一格超时红，不静默。
      void conn.query(sql);
    });
  }

  return pool;
}
