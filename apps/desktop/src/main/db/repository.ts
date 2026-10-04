import type { Pool } from 'mysql2/promise';
import {
  Document,
  SCHEMA_VERSION,
  applyPatch,
  assertTruthSourceInvariants,
  type EntityId,
  type Patch,
} from '@dajia/core';
import { JournalTurnSchema } from '@dajia/protocol';
import {
  decodeDocument,
  decodeEntity,
  decodePatch,
  encodeDocument,
  encodeEntity,
  encodePatch,
} from './codec';
// `storeyIdOf` 住在 ./reconcile：T4 里它是模块私有的，T5 把它挪过来改成 import ——
// 写这一列（appendJournal）与审这一列（closeProject 的三方对账）必须共用同一份规则，两份一定会漂
// （同 T3 的 assertNoVerticalOverlap 那条理由）。
// 代价（T5-M14 登记的限度）：列由这份规则写、又由同一份规则自比，规则自己漂了对账看不见 ⇒
// 外部证人 = test/db/repository.test.ts 的「楼层那一行的 `storey_id` 是 NULL，别的三类都带着自己的层」
// 那一格（它直接读列的实测值）。标题这里照抄逐字全文（含反引号与后半句），
// 免得引用 grep 不到用例 —— 本档的纪律是"引用用例用 `it()` 名，不用第 N 格"。
import {
  formatMismatches,
  reconcileProjection,
  storeyIdOf,
  type ElementRowView,
  type StoreyRowView,
} from './reconcile';

export type JournalOutcome = 'applied' | 'already-applied';

export interface JournalEntry {
  /** 客户端分配的单调计数：幂等键（P-6）。 */
  readonly turn: number;
  /** 这一发状态变更的补丁，原样落进 `command_log.payload`（P-3）。 */
  readonly patch: Patch;
  /** 应用补丁之后的文档。只用它核对归属与 `schemaVersion`；投影一律走 `patch`。 */
  readonly doc: Document;
}

interface Header {
  readonly affectedRows?: number | string;
  readonly insertId?: number | string;
}

function hdr(res: unknown): { affectedRows: number; insertId: number } {
  const h = res as Header;
  return { affectedRows: Number(h.affectedRows ?? 0), insertId: Number(h.insertId ?? 0) };
}

function notThisProject(what: string, got: EntityId, want: EntityId): RangeError {
  return new RangeError(
    `${what}属于工程 ${got}，这个仓库绑的是 ${want}：一份文档不能写进两个工程的账`,
  );
}

/** 打开工程的两种意图：`edit` 参与写（锁行 + 抹 `clean_shutdown`），`read` 只旁观（T6 拿不到锁那一支）。 */
export type OpenIntent = 'edit' | 'read';

export interface ProjectHeader {
  readonly projectId: EntityId;
  readonly name: string;
  readonly schemaVersion: number;
  readonly journalTurn: number;
  /** 翻 0 **之前**读到的那一格：false = 上一会话没告别。T8 的恢复横幅只读这一格。 */
  readonly wasCleanShutdown: boolean;
}

export interface LoadOutcome {
  readonly doc: Document;
  readonly header: ProjectHeader;
  readonly snapshot: { readonly seq: number; readonly turn: number } | null;
  /** 重放了几发、首尾 seq。洞在 seq 上（P-6），所以 fromSeq/toSeq 只作报告用，不作判据用。 */
  readonly replayed: {
    readonly rows: number;
    readonly fromSeq: number | null;
    readonly toSeq: number | null;
  };
}

export interface CloseReport {
  readonly elementRows: number;
  readonly storeyRows: number;
}

interface ProjectRow {
  readonly name: string;
  readonly schema_version: number | string;
  readonly journal_turn: number | string;
  readonly clean_shutdown: number | string;
}
interface SnapshotRow {
  readonly seq: number | string;
  readonly journal_turn: number | string;
  readonly schema_version: number | string;
  readonly payload: unknown;
}
interface LogRow {
  readonly seq: number | string;
  readonly turn: number | string;
  readonly payload: unknown;
}
interface ElementDbRow {
  readonly id: string;
  readonly storey_id: string | null;
  readonly payload: unknown;
}
interface StoreyDbRow {
  readonly id: string;
  readonly index_no: number | string;
  readonly elevation_mm: number | string;
  readonly height_mm: number | string;
}

/**
 * BIGINT 列的读数口径（P-17）。`supportBigNumbers: true` + `bigNumberStrings: false` 之下：
 * 安全范围内是 number，范围外是 **string**。所以"string 就是越界"这一支必须先判，
 * 不能先 `Number()` —— 那样 9007199254740993 会静默变成 …92 并通过 `isSafeInteger`，
 * 于是"越界会抛"这句主张悄悄失效（T5-M7 打的就是这一支）。
 *
 * `clean_shutdown` 不走这里：它只有 0/1 两个值，用 `Number(...) === 1` 归一即可，
 * 越界的 0/1 列不成立。查询结果的本地接口一律写成"裸形状"再 `as`，不 `extends RowDataPacket`
 * —— T4 用的是这个形状，别在同一个文件里混两种。
 */
function asSafeInt64(raw: unknown, label: string): number {
  if (typeof raw === 'string') {
    throw new RangeError(`${label} = ${raw} 超出 JS 安全整数范围：这一列存进 JS 必然失精，拒开`);
  }
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
    throw new RangeError(`${label} 的读数 ${String(raw)} 不是安全整数，拒开`);
  }
  return raw;
}

/**
 * 盘上那份账的唯一出入口：写（`createProject` / `appendJournal` / `writeSnapshot`）、
 * 读（`loadProject` = 工程头 + 最近快照 + 其后日志重放）、收尾（`closeProject` 的三方对账）。
 * 写路径与读路径分成两批用例（`test/db/repository.test.ts` / `test/db/journal.test.ts`）是故意的 ——
 * 写路径每一发要独立证"要么全写要么全无"，读路径要证的是"盘上的账能自洽地还原成一份文档"，
 * 两批用例混在一个文件里只会互相遮蔽。
 */
export class ProjectRepository {
  constructor(
    private readonly pool: Pool,
    private readonly projectId: EntityId,
    private readonly actor: string,
  ) {
    if (actor.length < 1 || actor.length > 64) {
      throw new RangeError(
        `actor 长度必须在 1..64（command_log.actor 是 VARCHAR(64)），收到 ${JSON.stringify(actor)}`,
      );
    }
  }

  async createProject(input: {
    readonly name: string;
    readonly schemaVersion: number;
  }): Promise<void> {
    if (input.name === '' || input.name !== input.name.trim()) {
      throw new RangeError('工程名不能为空或带首尾空白：存储层不替调用方修手滑');
    }
    if (input.name.length > 200) {
      throw new RangeError(
        `工程名不能超过 200 个字符（project.name 是 VARCHAR(200)），收到 ${input.name.length}`,
      );
    }
    if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1) {
      throw new RangeError(`schemaVersion 必须是正整数，收到 ${input.schemaVersion}`);
    }
    await this.pool.query(
      'INSERT INTO `project` (`id`, `schema_version`, `name`, `journal_turn`, `clean_shutdown`) VALUES (?, ?, ?, 0, 1)',
      [this.projectId, input.schemaVersion, input.name],
    );
  }

  /**
   * 一发 turn = 一个事务：归属预检（**在任何写之前**）→ 锁 project 行 → 写日志 →
   * 改 element 投影 → 改 storey 投影 → 记 turn。
   * 中间任何一处失败 ⇒ 全没有（`repository.test.ts` 那一格用外部行锁把失败点砸在正中间）。
   */
  async appendJournal(entry: JournalEntry): Promise<JournalOutcome> {
    const turn = JournalTurnSchema.parse(entry.turn);
    const { patch, doc } = entry;
    if (doc.projectId !== this.projectId) {
      throw notThisProject('文档', doc.projectId, this.projectId);
    }
    // 楼层的归属预检必须在这里，不能在投影那一趟 —— 挪到后面就等于"先写一半再抛"，
    // 那时靠回滚兜住（第 8 格判的就是这个位置：element 一行都不许有）。
    for (const entity of patch.upsert) {
      if (entity.kind === 'storey' && entity.projectId !== this.projectId) {
        throw notThisProject(`楼层 ${entity.id}`, entity.projectId, this.projectId);
      }
    }

    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      // 所有写都在这一发行锁之后串行：两台机器打开同一工程时第二个必须排队，
      // 于是"跳号"与"重复 turn"都能在同一个读数上判出来，而不是靠两边的时钟。
      const [locked] = await conn.query(
        'SELECT `journal_turn` FROM `project` WHERE `id` = ? FOR UPDATE',
        [this.projectId],
      );
      const row = (locked as { journal_turn: number | string }[])[0];
      if (!row) throw new RangeError(`工程 ${this.projectId} 在盘上没有 project 行：先 createProject`);
      const journalTurn = Number(row.journal_turn);

      if (turn <= journalTurn) {
        // 幂等出口（P-6）：同一发重放不是错误，是"已经落过盘"。
        await conn.commit();
        return 'already-applied';
      }
      if (turn !== journalTurn + 1) {
        throw new RangeError(
          `journal turn 跳号：盘上记到 ${journalTurn}，这发要写 ${turn} —— ` +
            `中间那一发去哪了没查清之前，不许往账上写`,
        );
      }

      const [logRes] = await conn.query(
        'INSERT INTO `command_log` (`project_id`, `turn`, `actor`, `payload`) VALUES (?, ?, ?, ?)',
        [this.projectId, turn, this.actor, encodePatch(patch)],
      );
      const seq = hdr(logRes).insertId;

      for (const id of patch.remove) {
        const [del] = await conn.query(
          'DELETE FROM `element` WHERE `id` = ? AND `project_id` = ?',
          [id, this.projectId],
        );
        if (hdr(del).affectedRows !== 1) {
          throw new RangeError(
            `盘上没有可删的 element ${id}（工程 ${this.projectId}）：` +
              `日志说要删的东西表上没有，两本账已经不对齐`,
          );
        }
        // 楼层行跟着没（P-7 的投影）。对非楼层 id 这一发删 0 行，无所谓：
        // 改成"先查 kind 再决定删不删"要多一次往返，还多一条"查到的 kind 与删的时候不一致"的窗口。
        await conn.query(
          'DELETE FROM `storey` WHERE `id` = ? AND `project_id` = ?',
          [id, this.projectId],
        );
      }

      for (const entity of patch.upsert) {
        await conn.query(
          'INSERT INTO `element` (`id`, `project_id`, `storey_id`, `payload`, `updated_seq`) VALUES (?, ?, ?, ?, ?) ' +
            'AS new ON DUPLICATE KEY UPDATE `storey_id` = new.`storey_id`, ' +
            '`payload` = new.`payload`, `updated_seq` = new.`updated_seq`',
          [entity.id, this.projectId, storeyIdOf(entity), encodeEntity(entity), seq],
        );
      }

      for (const entity of patch.upsert) {
        if (entity.kind !== 'storey') continue;
        await conn.query(
          'INSERT INTO `storey` (`id`, `project_id`, `index_no`, `elevation_mm`, `height_mm`) VALUES (?, ?, ?, ?, ?) ' +
            'AS new ON DUPLICATE KEY UPDATE `index_no` = new.`index_no`, ' +
            '`elevation_mm` = new.`elevation_mm`, `height_mm` = new.`height_mm`',
          [entity.id, this.projectId, entity.index, entity.elevationMm, entity.heightMm],
        );
      }

      // updated_at 本来就有 ON UPDATE CURRENT_TIMESTAMP(3)，这里再写一次 NOW(3) 是把它钉在
      // "服务端时钟"上（P-4）：以后谁改了默认值口径，这一发还是同一个读数来源。
      await conn.query(
        'UPDATE `project` SET `journal_turn` = ?, `updated_at` = NOW(3) WHERE `id` = ?',
        [turn, this.projectId],
      );
      await conn.commit();
      return 'applied';
    } catch (err) {
      try {
        await conn.rollback();
      } catch {
        // 连接已经死了（KILL / 断网）：回滚由服务端做。这里吞掉第二个错误，
        // 否则调用方读到的是"回滚失败"，真因（那一条 SQL 为什么失败）反而看不见。
      }
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * 裸 INSERT（P-16）：同一个 turn 落两份快照说明 autosave 的触发判定漂了，
   * 让 `uk_project_turn` 当场抛比 `ON DUPLICATE KEY UPDATE` 静默覆盖更容易查。
   * 与 `appendJournal` **故意不在同一事务**：快照是可选加速件，写失败时"少一份快照"
   * 必须能用重放补回来，而不是把已经成立的那一发日志一起回滚掉。
   */
  async writeSnapshot(turn: number, doc: Document): Promise<void> {
    const t = JournalTurnSchema.parse(turn);
    if (doc.projectId !== this.projectId) {
      throw notThisProject('文档', doc.projectId, this.projectId);
    }
    await this.pool.query(
      'INSERT INTO `snapshot` (`project_id`, `journal_turn`, `schema_version`, `payload`) VALUES (?, ?, ?, ?)',
      [this.projectId, t, doc.schemaVersion, encodeDocument(doc)],
    );
  }

  /**
   * 读路径 = 工程头 + 最近一份快照 + 其后所有日志正向重放（Architecture ③），三发读与那一发写
   * **同在一个事务、同一个快照**里。
   * `edit` 支先 `FOR UPDATE` 锁 project 行 —— 与 `appendJournal` 同一个首锁，加锁顺序一致 ⇒ 不会互相咬成死锁。
   * `read` 支不锁行也不写：T6 拿不到锁的那个实例走的就是这一支（旁观者参与抹 `clean_shutdown`
   * 就是把没在编辑的人的告别信号写脏）。
   *
   * 投影（`element` / `storey`）**不参与加载**：Architecture ④ 写死它是投影不是加载源。把它升格成加载源，
   * "库里存了什么"就有两个答案（日志说做过、投影说没做），而这两个答案漂开时恰好是本计划最难查的一型。
   */
  async loadProject(intent: OpenIntent): Promise<LoadOutcome> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const select =
        'SELECT `name`, `schema_version`, `journal_turn`, `clean_shutdown` FROM `project` WHERE `id` = ?';
      const [projectRows] = await conn.query(intent === 'edit' ? `${select} FOR UPDATE` : select, [
        this.projectId,
      ]);
      const project = (projectRows as ProjectRow[])[0];
      if (!project) {
        throw new RangeError(
          `工程 ${this.projectId} 不在库里：要么它从没建过，要么它已经被删；不能凭空开一份文档当它是读来的`,
        );
      }
      const schemaVersion = asSafeInt64(project.schema_version, 'project.schema_version');
      // 两处常量当前同值，读的是 Document 那个（Document.create 的默认参数就是它）；
      // CORE_SCHEMA_VERSION 是 index 的再导出，这里同时用两个就是留两个产地。
      if (schemaVersion !== SCHEMA_VERSION) {
        throw new RangeError(
          `工程 ${this.projectId} 的 schema_version 是 ${String(schemaVersion)}，这份程序只认 ${String(
            SCHEMA_VERSION,
          )}：S1 没有迁移路径，硬读会得到一份没人验过的文档`,
        );
      }
      const journalTurn = asSafeInt64(project.journal_turn, 'project.journal_turn');
      const wasCleanShutdown = Number(project.clean_shutdown) === 1;

      const [snapshotRows] = await conn.query(
        'SELECT `seq`, `journal_turn`, `schema_version`, `payload` FROM `snapshot` WHERE `project_id` = ? ORDER BY `seq` DESC LIMIT 1',
        [this.projectId],
      );
      const snap = (snapshotRows as SnapshotRow[])[0];
      let doc: Document;
      let snapshot: { seq: number; turn: number } | null = null;
      let replayFrom = 0;
      if (snap) {
        const snapSeq = asSafeInt64(snap.seq, 'snapshot.seq');
        const snapTurn = asSafeInt64(snap.journal_turn, `snapshot 行 ${String(snapSeq)} 的 journal_turn`);
        const snapSchema = asSafeInt64(
          snap.schema_version,
          `snapshot 行 ${String(snapSeq)} 的 schema_version`,
        );
        if (snapSchema !== schemaVersion) {
          throw new RangeError(
            `snapshot 行 ${String(snapSeq)} 的 schema_version 是 ${String(snapSchema)}，工程头记的是 ${String(
              schemaVersion,
            )}：同一份快照的列上与工程上说的不是同一个版本，拒开`,
          );
        }
        const decoded = decodeDocument({ table: 'snapshot', id: String(snapSeq) }, snap.payload);
        if (decoded.schemaVersion !== schemaVersion) {
          throw new RangeError(
            `snapshot 行 ${String(snapSeq)} 的 payload 写着 schemaVersion ${String(
              decoded.schemaVersion,
            )}，工程头记的是 ${String(schemaVersion)}：列与正文各说各话时以工程头为准，拒开`,
          );
        }
        if (decoded.projectId !== this.projectId) {
          throw new RangeError(
            `snapshot 行 ${String(snapSeq)} 的 payload 写的是工程 ${decoded.projectId}，` +
              `而这条快照挂在工程 ${this.projectId} 上：两份账指认的不是同一个工程，拒开`,
          );
        }
        doc = decoded;
        snapshot = { seq: snapSeq, turn: snapTurn };
        // 这一行把快照**列**上的 turn 直接当成"正文已经写到这一发"，而列无法自证：payload 里没有 turn 字段
        // （codec 只写 projectId / schemaVersion / entities）。上面三条判据管的是版本列、版本正文、工程归属三根轴，
        // 这根 turn 轴空着 ⇒「列快于正文 ⇒ 静默少重放 ⇒ 交出旧文档」这一型在本发**没有牙**：
        // 列写 5 而正文只是 turn 3 的终态时，下面那条 `AND turn > replayFrom ORDER BY seq` 会跳过 4、5，
        // 尾判据与放行证都看不出来（旧文档形状是全对的）。设牙在 T7（`encodeDocument` 增 `journalTurn` +
        // `writeSnapshot` 校验 + `loadProject` 同形状拒开判据）；本发只登记，不动 codec、不加判据。
        replayFrom = snapTurn;
      } else {
        doc = Document.create(this.projectId, schemaVersion);
      }

      const [logRows] = await conn.query(
        'SELECT `seq`, `turn`, `payload` FROM `command_log` WHERE `project_id` = ? AND `turn` > ? ORDER BY `seq` ASC',
        [this.projectId, replayFrom],
      );
      let prevTurn = replayFrom;
      let replayedRows = 0;
      let fromSeq: number | null = null;
      let toSeq: number | null = null;
      for (const row of logRows as LogRow[]) {
        const seq = asSafeInt64(row.seq, 'command_log.seq');
        const turn = asSafeInt64(row.turn, `command_log 行 ${String(seq)} 的 turn`);
        // turn 必须逐发连着（appendJournal 就是这么写的：跳号当场抛）。缺号说明日志被删过或插过，
        // 而"少重放几发得到的文档"是一份形状完全正常的坏文档 —— 正是本计划要拦的那一型。
        if (turn !== prevTurn + 1) {
          throw new RangeError(
            `command_log 缺号：行 ${String(seq)} 的 turn 是 ${String(turn)}，上一发读到 ${String(
              prevTurn,
            )}（工程 ${this.projectId}，快照 turn ${String(replayFrom)}）：` +
              `中间那些发去哪了没查清之前，不能当它是完整的`,
          );
        }
        prevTurn = turn;
        const patch = decodePatch({ table: 'command_log', id: String(seq) }, row.payload);
        try {
          doc = applyPatch(doc, patch).doc;
        } catch (err) {
          // 坐标必须落在这一句里：一份盘上有几百发补丁，"重放失败"四个字帮不了任何人。
          throw new RangeError(
            `重放 command_log 行 ${String(seq)}（turn ${String(turn)}）失败：${String(err)} —— ` +
              `快照与日志这两本账已经接不上，拒开`,
          );
        }
        replayedRows += 1;
        if (fromSeq === null) fromSeq = seq;
        toSeq = seq;
      }
      // 读到尾还不够，尾必须落在工程头记的那一格：少就是"头寸比账本大"（尾被删），
      // 多就是"账本比头寸大"（头寸没跟上）。两种都拒。
      if (prevTurn !== journalTurn) {
        throw new RangeError(
          `重放读到 turn ${String(prevTurn)}，project.journal_turn 记的是 ${String(journalTurn)}：` +
            `工程 ${this.projectId} 的这两本账对不上，拒开`,
        );
      }

      // 唯一的放行证（T3）。放在这里而不是 codec：解码只管形状，这里才知道一共读了几层、引用闭不闭。
      assertTruthSourceInvariants(doc);

      if (intent === 'edit') {
        // 不加 affectedRows 断言。理由不是 brief 那句"重复打开时 0→0 返回 0"（实测它不成立：
        // 同一条 UPDATE 还写 `updated_at = NOW(3)`，头寸没变但行确实变了 ⇒ affectedRows 照样是 1，
        // T5-M15 加上断言后 `journal+repo` 靶全绿，`tmp/t5-mut-T5-M15-journal+repo.log`）。
        // 但那一次"全绿"是**时序运气**，不是证明：`project.updated_at` 是 DATETIME(3)
        // （migrations/001_init.sql:23 ⇒ 毫秒粒度），两次打开落在同一毫秒时 `updated_at` 不变、头寸又是 0→0
        // ⇒ 那一发 affectedRows 就是 0。所以加了断言以后它红不红取决于时钟，全仓没有一格能**稳定**抓住那条断言
        //（`连开两次` 那一格的绿同理是运气 ⇒ 别把它读成"加了也无害"：加了只会造出一格毫秒级 flaky 的测试）。
        // 成立的那条更简单：这一发本来就不许失败，失败由"抛在 commit 之前"+ `finally` 里那次 release 兜住
        // —— 不是由回滚兜住，见下面那两句的顺序账；
        // 拿 affectedRows 当判据只会把语义押在 updated_at 上 —— 哪天它被挪出这条语句，
        // 断言立刻把"重复打开"这条正当路径变成红，而它什么坏东西都没拦住。
        // 顺序账：这一发抹 0 排在上面所有拒开判据（缺 project 行 / 三处版本 / 缺号 / 尾不落头 / 放行证）之后
        // ⇒ 拒开天然无痕；`重放出来的文档形状全对、端点指向别人的实体` 那一格守的就是**这个顺序**，
        // 它同时是"别把抹 0 提到事务前面"的哨兵。loadProject 的回滚在本任务里没有可撤销之物，
        // 它自己的证人归 T6-M17。
        await conn.query(
          'UPDATE `project` SET `clean_shutdown` = 0, `updated_at` = NOW(3) WHERE `id` = ?',
          [this.projectId],
        );
      }
      await conn.commit();
      return {
        doc,
        header: {
          projectId: this.projectId,
          name: project.name,
          schemaVersion,
          journalTurn,
          wasCleanShutdown,
        },
        snapshot,
        replayed: { rows: replayedRows, fromSeq, toSeq },
      };
    } catch (err) {
      try {
        await conn.rollback();
      } catch {
        // 同 appendJournal：吞掉第二个错误，否则调用方读到的是"回滚失败"，真因反而看不见。
      }
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * 收尾：三方对账（文档 ↔ element ↔ storey）通过才把 `clean_shutdown` 落回 1。
   * 不平 ⇒ 抛且不落 1 ⇒ 下次打开出恢复告知。真源永远是 `command_log`，投影由下一次写入重建。
   * `doc` 由 renderer 在收尾时递过来（P-9 说的是 main 不**拥有**文档对象图，不是它一辈子不许看见文档；
   * emergency 快照走的是同一条路，P-10）。
   */
  async closeProject(doc: Document): Promise<CloseReport> {
    if (doc.projectId !== this.projectId) {
      throw notThisProject('文档', doc.projectId, this.projectId);
    }
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [locked] = await conn.query(
        'SELECT `id` FROM `project` WHERE `id` = ? FOR UPDATE',
        [this.projectId],
      );
      if ((locked as unknown[]).length === 0) {
        throw new RangeError(`工程 ${this.projectId} 不在库里：没有可收尾的账`);
      }
      const [elementRows] = await conn.query(
        'SELECT `id`, `storey_id`, `payload` FROM `element` WHERE `project_id` = ?',
        [this.projectId],
      );
      const [storeyRows] = await conn.query(
        'SELECT `id`, `index_no`, `elevation_mm`, `height_mm` FROM `storey` WHERE `project_id` = ?',
        [this.projectId],
      );
      const elements: ElementRowView[] = (elementRows as ElementDbRow[]).map((r) => ({
        id: r.id as EntityId,
        storeyId: r.storey_id as EntityId | null,
        entity: decodeEntity({ table: 'element', id: r.id }, r.payload),
      }));
      const storeys: StoreyRowView[] = (storeyRows as StoreyDbRow[]).map((r) => ({
        id: r.id as EntityId,
        indexNo: asSafeInt64(r.index_no, `storey 行 ${r.id} 的 index_no`),
        elevationMm: asSafeInt64(r.elevation_mm, `storey 行 ${r.id} 的 elevation_mm`),
        heightMm: asSafeInt64(r.height_mm, `storey 行 ${r.id} 的 height_mm`),
      }));
      const mismatches = reconcileProjection(doc, elements, storeys);
      if (mismatches.length > 0) {
        // 回滚交给下面那个 catch，这里不重复一发 —— 重复会让"谁在回滚"有两个答案。
        throw new RangeError(formatMismatches(this.projectId, mismatches));
      }
      // 同样不许加 affectedRows 断言：收过尾的工程再收一次是 1→1。
      await conn.query(
        'UPDATE `project` SET `clean_shutdown` = 1, `updated_at` = NOW(3) WHERE `id` = ?',
        [this.projectId],
      );
      await conn.commit();
      return { elementRows: elements.length, storeyRows: storeys.length };
    } catch (err) {
      try {
        await conn.rollback();
      } catch {
        /* 同 loadProject：吞掉第二个错误，真因不能被"回滚失败"盖住。 */
      }
      throw err;
    } finally {
      conn.release();
    }
  }
}
