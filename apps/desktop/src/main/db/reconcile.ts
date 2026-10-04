import {
  type Document,
  type Entity,
  type EntityId,
  type StoreyEntity,
} from '@dajia/core';

/**
 * 三方对账的判据，纯函数。住 `db/` 而不进 core：它审的是"存储层的双写"，
 * core 不该知道 `storey` 表存在（P-7 是存储决定，不是真源决定）。
 * 不连库 ⇒ CI 有牙（`apps/desktop/test/unit/reconcile.test.ts`）；连库那一档只证 SQL 真把行喂进来了。
 *
 * 三个 `pair` 的左右两侧由名字里的顺序定（`element↔storey` = 左 element 右 storey），
 * `left-only` / `right-only` 一律按这个名字读，别在文案里再解释一遍方向。
 */
export type Pair = 'document↔element' | 'element.storey_id↔payload' | 'element↔storey';
export type Problem = 'left-only' | 'right-only' | 'differs';

export interface Mismatch {
  readonly pair: Pair;
  readonly id: EntityId;
  readonly problem: Problem;
  /** `differs` 时列出不相等的字段名（按名序）；另两型为空。 */
  readonly fields: readonly string[];
}

export interface ElementRowView {
  readonly id: EntityId;
  /** `element.storey_id` 列的原样读数（楼层行为 null）。 */
  readonly storeyId: EntityId | null;
  /** 同一行 payload 解出来的实体。列与正文自比用得到它，所以这一列不是多余的。 */
  readonly entity: Entity;
}

export interface StoreyRowView {
  readonly id: EntityId;
  readonly indexNo: number;
  readonly elevationMm: number;
  readonly heightMm: number;
}

/** 报告最多列几条。对账不平一次能漂几百行，全列出来没人读，且会把真因挤出日志。 */
export const MISMATCH_REPORT_CAP = 12;

/**
 * `element.storey_id` 该填什么。**写路径（T4 的 appendJournal）与对账路径共用这一份**，
 * T4 里那个模块私有版搬到这里：一份规则两个读者，就不会自己跟自己漂。
 * 代价写在 T5-M14：列由这份规则写、又由同一份规则审，规则自己漂了自比看不见，
 * 所以外部证人（T4 那条读列实测值的库用例）必须留着。
 */
export function storeyIdOf(entity: Entity): EntityId | null {
  return entity.kind === 'storey' ? null : entity.storeyId;
}

function byId(a: { id: EntityId }, b: { id: EntityId }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function byPairThenId(a: Mismatch, b: Mismatch): number {
  if (a.pair !== b.pair) return a.pair < b.pair ? -1 : 1;
  return byId(a, b);
}

function indexBy<T extends { id: EntityId }>(items: Iterable<T>): Map<EntityId, T> {
  const map = new Map<EntityId, T>();
  for (const item of items) map.set(item.id, item);
  return map;
}

/**
 * 逐字段比，用 `Object.is`：0 与 -0 在这里不算相等（codec 那侧实测"盘上不存 -0"，这一句是"万一存了要能看出来"）。
 * 取两侧键的并集 ⇒「少一个键」与「键的值不同」都落到字段名上，而不是只报"整串不等"。
 */
function differingFields(a: Entity, b: Entity): string[] {
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(ra), ...Object.keys(rb)])].sort();
  return keys.filter((k) => !Object.is(ra[k], rb[k]));
}

/** 左侧 = `element` 里的楼层行（由 payload 解出），右侧 = `storey` 表。 */
export function diffStoreyProjection(
  storeyEntities: readonly StoreyEntity[],
  rows: readonly StoreyRowView[],
): Mismatch[] {
  const out: Mismatch[] = [];
  const right = indexBy(rows);
  for (const entity of [...storeyEntities].sort(byId)) {
    const row = right.get(entity.id);
    if (!row) {
      out.push({ pair: 'element↔storey', id: entity.id, problem: 'left-only', fields: [] });
      continue;
    }
    right.delete(entity.id);
    const fields: string[] = [];
    if (!Object.is(entity.elevationMm, row.elevationMm)) fields.push('elevationMm');
    if (!Object.is(entity.heightMm, row.heightMm)) fields.push('heightMm');
    if (!Object.is(entity.index, row.indexNo)) fields.push('indexNo');
    if (fields.length > 0) {
      out.push({ pair: 'element↔storey', id: entity.id, problem: 'differs', fields });
    }
  }
  for (const row of [...right.values()].sort(byId)) {
    out.push({ pair: 'element↔storey', id: row.id, problem: 'right-only', fields: [] });
  }
  return out;
}

/**
 * 同一行内部的两列自比：`storey_id` 列 vs 同行 payload 推出来的值。
 * 抓的是"列被手改过"或"写列的规则漂了"。文档不参与 —— 掺进第三方就说不清是谁漂了。
 */
export function diffStoreyIdColumn(rows: readonly ElementRowView[]): Mismatch[] {
  const out: Mismatch[] = [];
  for (const row of [...rows].sort(byId)) {
    if (!Object.is(storeyIdOf(row.entity), row.storeyId)) {
      out.push({
        pair: 'element.storey_id↔payload',
        id: row.id,
        problem: 'differs',
        fields: ['storeyId'],
      });
    }
  }
  return out;
}

/** 左侧 = 真源文档（renderer 递来的终态），右侧 = `element` 投影。 */
export function diffDocAgainstElement(
  doc: Document,
  rows: readonly ElementRowView[],
): Mismatch[] {
  const out: Mismatch[] = [];
  const right = indexBy(rows);
  for (const entity of [...doc.entities.values()].sort(byId)) {
    const row = right.get(entity.id);
    if (!row) {
      out.push({ pair: 'document↔element', id: entity.id, problem: 'left-only', fields: [] });
      continue;
    }
    right.delete(entity.id);
    const fields = differingFields(entity, row.entity);
    if (fields.length > 0) {
      out.push({ pair: 'document↔element', id: entity.id, problem: 'differs', fields });
    }
  }
  for (const row of [...right.values()].sort(byId)) {
    out.push({ pair: 'document↔element', id: row.id, problem: 'right-only', fields: [] });
  }
  return out;
}

/**
 * 收尾对账的唯一入口，三对合成一份、排序后交给 `formatMismatches`。
 * `element↔storey` 的左侧从 **element 行**推（不从文档推）：这一对审的是双写本身，
 * 掺进文档就变成"文档说三遍都对"，那是复制判据不是对账。
 */
export function reconcileProjection(
  doc: Document,
  elementRows: readonly ElementRowView[],
  storeyRows: readonly StoreyRowView[],
): Mismatch[] {
  const storeyEntities: StoreyEntity[] = [];
  for (const row of elementRows) {
    if (row.entity.kind === 'storey') storeyEntities.push(row.entity);
  }
  return [
    ...diffDocAgainstElement(doc, elementRows),
    ...diffStoreyIdColumn(elementRows),
    ...diffStoreyProjection(storeyEntities, storeyRows),
  ].sort(byPairThenId);
}

const PAIR_TEXT: Record<Pair, string> = {
  'document↔element': '文档（真源）↔ element 投影',
  'element.storey_id↔payload': 'element.storey_id 列 ↔ 同一行的 payload',
  'element↔storey': 'element 的楼层行 ↔ storey 表（P-7 的投影）',
};

const PROBLEM_TEXT: Record<Problem, string> = {
  'left-only': '只在左侧有',
  'right-only': '只在右侧有',
  differs: '同 id 的字段不等',
};

export function formatMismatches(projectId: EntityId, mismatches: readonly Mismatch[]): string {
  const head = `工程 ${projectId} 的账对不平（${String(mismatches.length)} 处）：`;
  // `  - ` 这个前缀**只准条目行用**：`reconcile.test.ts` 的 `超出上限只列前 12 处` 那一格是按这个
  // 前数行数的（它证的是"最多列 CAP 条"）。汇总行若也带子弹，那条断言就把"列了 13 条"读成合法。
  const shown = mismatches.slice(0, MISMATCH_REPORT_CAP).map((m) => {
    const fields = m.fields.length > 0 ? ` 字段 ${m.fields.join('、')}` : '';
    // 每一行都带上 `pair` 标签的原形（不只人类文案）：`journal.test.ts` 那四格对账用例吃的就是标签
    // （`/element↔storey/`、`/document↔element/`、`/element\.storey_id↔payload/`），日志里 grep 的也是它。
    // 标签给机器认、PAIR_TEXT 给人读，两个都在行上；这一发的牙齿归 T5-M11。
    return `  - ${m.pair} / ${PAIR_TEXT[m.pair]} / ${PROBLEM_TEXT[m.problem]} / ${m.id}${fields}`;
  });
  const rest =
    mismatches.length > shown.length
      ? [`  另有 ${String(mismatches.length - shown.length)} 处未列出`]
      : [];
  return [
    head,
    ...shown,
    ...rest,
    '处置：这一发收尾不落 clean_shutdown=1 —— 真源以 command_log 为准，投影由下一次写入重建；下次打开会出恢复告知。',
  ].join('\n');
}
