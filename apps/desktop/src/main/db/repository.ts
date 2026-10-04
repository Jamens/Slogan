import type { Pool } from 'mysql2/promise';
import type { Document, Entity, EntityId, Patch } from '@dajia/core';
import { JournalTurnSchema } from '@dajia/protocol';
import { encodeDocument, encodeEntity, encodePatch } from './codec';

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

/** 楼层实体自己就是层，`element.storey_id` 对它为空；别的四类都带着 storeyId。 */
function storeyIdOf(entity: Entity): EntityId | null {
  return entity.kind === 'storey' ? null : entity.storeyId;
}

function notThisProject(what: string, got: EntityId, want: EntityId): RangeError {
  return new RangeError(
    `${what}属于工程 ${got}，这个仓库绑的是 ${want}：一份文档不能写进两个工程的账`,
  );
}

/**
 * 唯一的写库出口。**只有写**：读路径（`loadProject` = 快照 + 重放）与 `closeProject` 在 T5。
 * 拆成两个任务是故意的 —— 写路径每一发都要能独立证"要么全写要么全无"，
 * 读路径要证的是"盘上的账能自洽地还原成一份文档"，两批用例混在一个文件里只会互相遮蔽。
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
}
