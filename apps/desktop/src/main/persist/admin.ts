import { Document, TransactionLog, storeyCreate, uuidv7, type EntityId } from '@dajia/core';
import type {
  ConnectionInput,
  ConnectionTestValue,
  ProjectCreateValue,
  ProjectListValue,
  ProjectSummary,
} from '@dajia/protocol';
import { classifyDbError } from '../db/diagnostics';
import type { MysqlEnv } from '../db/env';
import type { JournalEntry, JournalOutcome } from '../db/repository';
import { DIAGNOSTIC_TEXT } from '../../shared/diagnostics-text';
import { describeError } from './describe-error';
// T9 第 ② 段（P-30）：`wrap` 与 `persistErrorCode` 是 T8 现物，本块只是把它们导出。
// 这里**不**具名 `SessionError` —— `admin.ts` 一个地方都不引用那个类名，引用了就是 `noUnusedLocals` 的红。
import { persistErrorCode, wrap } from './session';

/**
 * 会话之外的两发：列工程、建工程，外加一次试连。
 *
 * 它**不**认识 `ProjectSession`（裁决 P-22）：会话的不变式是"一个窗口 ↔ 一个工程 ↔ 一份锁 ↔
 * 一份保存链"，而"用户还在看列表"与"用户还在填向导"恰恰是它的反面。所以这个文件自己开连接、
 * 自己关连接，一次调用一条（口径 ① 登记的那笔代价：连着点三次刷新就是三条短连接）。
 *
 * 它也不认识 fs、electron、os、mysql2（第 ④ 段）。外部世界只从 `AdminPorts` 那三条注入通道进来 ——
 * 常驻证人在 `persist-boundary.test.ts`。
 */

/**
 * 新建工程的默认首层（口径 ② 末）。这三个数是**给屏幕看的**（向导里那一行只读输入框），
 * 所以它必须是导出的：面板要显示的数与 `appendJournal` 落进投影的数是同一个，
 * 而 `test/db/projects.test.ts` 第 1 格会在投影那一侧读出同样的三个数。
 * S1 里没有第二个消费者会改它们：`storeyCreate` 自己查 index 重复与竖向重叠。
 */
export const FIRST_STOREY = { index: 0, elevationMm: 0, heightMm: 3000 } as const;

/** 遮蔽串。三个 `•` 而不是 `***`：`***` 在 SQL 里有语义，读日志的人会先往语句那边想。 */
const MASK = '•••';

/**
 * 把可能带着口令的文本压掉（口径 ④ 三条防线的第二条）。
 *
 * 为什么需要它：`mysql2` 的 `ER_ACCESS_DENIED_ERROR` 原文只带用户名，但驱动下一版带什么没人保证，
 * 而用户手写的 `host` 里也可能重复口令。**这是纵深，不是修 bug** —— 判它的格（`admin.test.ts` 第 12 格的
 * `detail` 与第 14 格的 `redact` 直尺）也照这个尺度写：判"哨兵串不见了"，不判"文案读起来顺"。
 *
 * 两个刻意的形状：
 * ① 空串跳过。`replaceAll('')` 会在每个字符之间插一个遮蔽串，把整句话拆成 `•••a•••b•••`，
 *    而"空口令"本来就没有要遮蔽的东西（那一格在边界第一道，这一发管的是第二个读者的输入）。
 * ② 不去重排序。多个 secret 里若一个包含另一个，先换哪个都不会泄漏（两者都被换掉），
 *    所以这里不留一个"按长度排序"的额外规则 —— 它需要的理由比它保护的处境多。
 *
 * 代价照登记（本块的限度 ②）：口令短到会吃掉文案里正常的字母（一位口令 `'a'` ⇒ 所有 `a` 变 `•••`）。
 * 方向是**过度遮蔽**而不是泄漏，这是安全边上允许的那种错。
 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of new Set(secrets)) {
    if (secret.length > 0) out = out.replaceAll(secret, MASK);
  }
  return out;
}

/**
 * 向导里那四格草稿拼成一份能拨号的参数（**不落盘**：落盘走 `config-store.writeConfig`）。
 *
 * `database` 是字面量 `'dajia'`，不是从 `ConnectionInput` 里取的（⑧ 段：数据库名不进向导），
 * 也不是 `ConfigDatabaseSchema.options[0]`（第 ③ 段末：那个 `.options` 在产品代码里拿到
 * `undefined` 不红，只会拨一条 `database: undefined` 的连接）。同源那条对账由
 * `admin.test.ts` 第 14 格钉：`ConfigDatabaseSchema.options` 必须逐字等于 `['dajia']`，
 * 而 `buildDraftEnv(...).database` 必须等于它的第一个读数。
 */
export function buildDraftEnv(input: ConnectionInput): MysqlEnv {
  return {
    host: input.host,
    port: input.port,
    user: input.user,
    password: input.password,
    database: 'dajia',
  };
}

/** 试连的把手：`ping()` 是那一发 `SELECT VERSION()`，`end()` 只掐这一条连接。 */
export interface ProbeHandle {
  ping(): Promise<{ version: string }>;
  end(): Promise<void>;
}
export type ProbeOpener = (env: MysqlEnv) => Promise<ProbeHandle>;

/**
 * 一次试连：连上、问版本、掐掉。**它自己不抛**（口径 ⑤：分型与文案同源，读者两处）。
 *
 * `detail` = 文案表的 `detail` + 一个空格 + 过 `redact` 的原文。为什么把原文也带上：
 * `'unknown'` 那一型的存在理由就是"没查清的东西不许说成查清了"，而 `next` 那句人话背后
 * 必须有可查的读数；`describeError` 会把 `err.code` 写进去（T7 那一族共享口径的第二个读者）。
 * 为什么 `ok` 分支不带原文：没有原文可带，而 `serverVersion` 才是那一发的读数（逐字原样，不加工）。
 *
 * `end()` 在 `finally` 里且失败吞掉：这一发的结论已经定了（`return` 的值在 `finally` 之前就选好了），
 * 而一条没掐掉的连接比"日志里多一行"贵得多 —— 试连按钮是可以连点的。
 */
export async function probeConnection(env: MysqlEnv, open: ProbeOpener): Promise<ConnectionTestValue> {
  let handle: ProbeHandle | null = null;
  try {
    handle = await open(env);
    const { version } = await handle.ping();
    return {
      connected: true,
      kind: 'ok',
      serverVersion: version,
      detail: DIAGNOSTIC_TEXT.ok.detail,
    };
  } catch (err) {
    const kind = classifyDbError(err);
    return {
      connected: false,
      kind,
      serverVersion: null,
      detail: `${DIAGNOSTIC_TEXT[kind].detail} ${redact(describeError(err), [env.password])}`,
    };
  } finally {
    try {
      await handle?.end();
    } catch (err) {
      console.error(`[dajia] 试连的连接没关掉：${describeError(err)}`);
    }
  }
}

/** 会话之外的通道看得见的仓库。`ProjectRepository` 恰好满足它，两边都不 import 对方的类（T7 的 `JournalSink` 同族做法）。 */
export interface CreateRepo {
  createProject(input: { readonly name: string; readonly schemaVersion: number }): Promise<void>;
  appendJournal(entry: JournalEntry): Promise<JournalOutcome>;
  deleteProject(): Promise<void>;
}

export interface AdminCreateDb {
  readonly repo: CreateRepo;
  end(): Promise<void>;
}

/**
 * 列表那条连接。它递出来的是**方法**而不是 `raw` 把手，与 T8 的 `DbHandle` 故意不同：
 * `DbHandle` 需要 `raw` 是因为 `acquire(db, …)` 要把同一个连接原样拿回去认票，
 * 而这里没有任何第二发要用那条连接 —— 能给一个不透明的 `unknown` 就不给一个能被拆开的洞（P-15）。
 */
export interface AdminListDb {
  listProjects(): Promise<ProjectSummary[]>;
  end(): Promise<void>;
}

/**
 * 管理通道的全部外部依赖（第 ③ 段：三键，没有第四键）。
 * `loadConfig` 与 `PersistPorts` 里那个同名同形状 —— 同一条"没配好就抛，抛 ⇒ `'not-configured'` 且不建连接"。
 */
export interface AdminPorts {
  loadConfig(): MysqlEnv;
  openCreateDb(env: MysqlEnv, projectId: EntityId): Promise<AdminCreateDb>;
  openListDb(env: MysqlEnv): Promise<AdminListDb>;
}

/**
 * 首层 = journal 的 turn 1（口径 ②）。文档在这里造出来，`schema_version` 因此只有
 * `Document.create` 的默认参数一个产地：写进 `project.schema_version` 的那个数就是这份文档
 * 自己带的数，而读路径拿来对账的是同一个 core 常量（第 ③ 段第二条）。
 *
 * `lastPatch === null` 那一支在 dispatch 成功之后不可达（T7 第 ① 段的三个赋值点之一就在 dispatch 末尾），
 * 它留在这里是因为 strict 下 `Patch | null` 不拆开就用不了 —— 而"不可达"这件事本身要写得让人看得见。
 * 它抛的是 `RangeError`，逃出 `create` 之后到边界是 `'internal'`：那正确，因为那一刻一个字节都没写过库，
 * 唯一的可能形状是我们的夹具坏了。
 */
function firstStoreyTurn(projectId: EntityId): JournalEntry {
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(
    storeyCreate({
      projectId,
      index: FIRST_STOREY.index,
      elevationMm: FIRST_STOREY.elevationMm,
      heightMm: FIRST_STOREY.heightMm,
    }),
  );
  const patch = log.lastPatch;
  if (patch === null) {
    throw new RangeError('刚 dispatch 成功的一发拿不到补丁：首层那一发的账没拼出来，一个字节都没写进库');
  }
  return { turn: 1, patch, doc: log.document };
}

export class ProjectAdmin {
  constructor(private readonly ports: AdminPorts) {}

  /** 两发共用的前置：读配置。抛 ⇒ 定码 `'not-configured'`，且**不建连接**（与 `open` 第一步同一条口径）。 */
  private env(): MysqlEnv {
    try {
      return this.ports.loadConfig();
    } catch (err) {
      throw wrap(err, 'not-configured', '连接配置读不出来');
    }
  }

  /**
   * 拆卸的唯一出口：**先拿到结论再拆**。两处调用点都在 `finally` 里，
   * 而 `finally` 里抛出去的错误会顶掉 `try` 的返回值或原始异常 —— 那一刻用户丢的是真因。
   * 口径同 `session.teardown`（"解锁与关池的失败只记不抛"）：锁会自己过期，池留在进程手里等退出。
   */
  private static async close(handle: { end(): Promise<void> }): Promise<void> {
    try {
      await handle.end();
    } catch (err) {
      console.error(`[dajia] 管理通道的连接没关掉：${describeError(err)}`);
    }
  }

  /** 工程列表。一次调用一条连接，用完就掐（P-22 的那笔代价）。 */
  async list(): Promise<ProjectListValue> {
    const env = this.env();
    let db: AdminListDb;
    try {
      db = await this.ports.openListDb(env);
    } catch (err) {
      // 前缀逐字照 `session.open` 的第二步：同一个处境在两个文件里得到同一句话。
      throw wrap(err, 'db', '连不上库');
    }
    try {
      return { projects: await db.listProjects() };
    } catch (err) {
      // 这里是 `persistErrorCode(err)` 而不是固定 `'db'`：`listProjects` 里那两把尺
      // （`asSafeInt64` 与 `toBit`）抛的是没有 `code` 的 `RangeError`，说的是"盘上的读数不对"，
      // 下一步动作与"服务没起"完全不同（③ 段那条闭集纪律）。
      throw wrap(err, persistErrorCode(err), '工程列表读不出来');
    } finally {
      await ProjectAdmin.close(db);
    }
  }

  /**
   * 新建工程 = `project` 行 + 首层作为 turn 1，两发（口径 ② / P-23）。
   * **不顺手开会话**：那要求"还没有会话的时候先把会话造出来"，也就是把 P-22 拒掉的第三种形状从后门放回来。
   * 回包只有 `{ projectId }`，打开它由 renderer 接着发（`openProject`），与 `reopenAsEdit()` 同族先例。
   */
  async create(name: string): Promise<ProjectCreateValue> {
    const env = this.env();
    // id 在开连接之前就有：`openCreateDb(env, projectId)` 递的是同一个，于是"仓库绑的工程"
    // 与"回给屏幕的工程"是同一个号（第 ③ 段删掉 `newProjectId()` 端口的直接收益）。
    const projectId = uuidv7();
    const entry = firstStoreyTurn(projectId);
    let db: AdminCreateDb;
    try {
      db = await this.ports.openCreateDb(env, projectId);
    } catch (err) {
      throw wrap(err, 'db', '连不上库');
    }
    try {
      try {
        await db.repo.createProject({ name, schemaVersion: entry.doc.schemaVersion });
      } catch (err) {
        // 第一发就坏 ⇒ **没有**补偿：此刻 `project` 行没有（`INSERT` 要么成要么没），
        // 调 `deleteProject()` 只是多一次往返，还会把"补偿"这个词用在不需它的地方。
        // `createProject` 里的尺与边界那张表是镜像的两份（⑤ 段），漂开时这一发得到 `'reconcile'`。
        throw wrap(err, persistErrorCode(err), '工程行没建出来');
      }
      try {
        await db.repo.appendJournal(entry);
      } catch (err) {
        const first = describeError(err);
        try {
          // 行一删，`element` / `storey` / `command_log` / `snapshot` / `asset` 五张子表
          // 靠 T2 建好的 `ON DELETE CASCADE` 一起走。级联这件事的凭据在连库档第 4 格。
          await db.repo.deleteProject();
        } catch (compErr) {
          // 两支错**都**拼进 message 并照样抛：只报后一支，查的人看见的是"删不掉"，
          // 而真正坏的是首层那一发；只报前一支，库里就留下一个没人知道的鬼工程。
          throw wrap(
            err,
            persistErrorCode(err),
            `首层那一发失败（${first}），补偿删除也没成（${describeError(compErr)}）：` +
              `库里会留一个只有 project 行、打不开的工程，列表里看得见它`,
          );
        }
        throw wrap(err, persistErrorCode(err), '首层那一发失败，工程行已按补偿删掉');
      }
      return { projectId };
    } finally {
      await ProjectAdmin.close(db);
    }
  }
}
