// 洞口的写入路径。三条口径：① 校验与派生共用同一份代码（草稿文档跑 Task 6 的分段派生）；
// ② 派生抓不到的三条（宽/高为正、门洞窗台为 0、洞顶 ≤ 宿主墙高）在这里补；
// ③ 本文件只写"新建/搬动/删除一樘洞"，拉伸墙时的跟随逻辑在 commands/wall.ts。
import { uuidv7, type EntityId } from '../ids';
import { assertMm, type Mm } from '../units/mm';
import type { Command } from '../model/command';
import type { Document } from '../model/document';
import { applyPatch } from '../model/patch';
import type { OpeningEntity } from '../model/entity';
import { mustExist, requireWall } from '../model/read';
import { wallAxis } from '../geom/axis';
import { openingSpans, piecesFromSpans } from '../geom/opening';

export interface OpeningCreateInput {
  hostWallId: EntityId;
  /** 宿主墙起点到洞口近端的沿轴距离 */
  distanceMm: number;
  widthMm: number;
  heightMm: number;
  /** 洞底距本层楼面。省略时门取 0、窗取 900 */
  sillMm?: number;
  category: OpeningEntity['category'];
}

function positiveMm(value: Mm, label: string): Mm {
  if (value <= 0) throw new RangeError(`${label}必须为正，收到 ${value}`);
  return value;
}

function requireOpening(doc: Document, id: EntityId): OpeningEntity {
  const entity = mustExist(doc, id, '洞口');
  if (entity.kind !== 'opening') throw new TypeError(`${id} 不是洞口，是 ${entity.kind}`);
  return entity;
}

/**
 * 写入前校验 = 派生校验。把候选实体贴到一张草稿文档上跑 Task 6 的分段派生：
 * 派生算得出来的（不越界、不重叠、不贴边、同层）才允许进真源。
 * 命令层绝不复述区间规则 —— 写两遍的规则一定会漂，而漂掉的永远是没人看的那一遍。
 * applyPatch 是纯函数，不改传进来的 doc，所以这张草稿是免费的。
 *
 * 排序与同层都白拿：openingSpans 内部按 fromMm 升序（平距按 id 升序）并查洞口与宿主墙同层，
 * 所以喂给 assertSpansFit 的表天然是它要求的那个形状 —— 自己往表尾追加候选、不排序的话，
 * "内部错误"那条就会以用户错误的样子冒出来。lengthMm 同理：只从 wallAxis 拿，不手搓。
 */
function assertFitsAfterInsert(doc: Document, candidate: OpeningEntity): void {
  const next = applyPatch(doc, { upsert: [candidate], remove: [] }).doc;
  const wall = requireWall(next, candidate.hostWallId);
  piecesFromSpans(wall.id, wallAxis(next, wall).lengthMm, openingSpans(next, wall));
  // 竖向这条派生层看不见（它只换算沿轴区间），所以只能在写入侧补一次
  const topMm = candidate.sillMm + candidate.heightMm;
  if (topMm > wall.heightMm) {
    throw new RangeError(
      `洞口 ${candidate.id} 顶标高 ${topMm} 超过宿主墙高 ${wall.heightMm}` +
        `（窗台 ${candidate.sillMm} + 洞口高 ${candidate.heightMm}）`,
    );
  }
}

export function openingCreate(input: OpeningCreateInput): Command {
  const distanceMm = assertMm(input.distanceMm, '洞口距离');
  // 正数这两条只能卡在构造期：零宽洞口的区间 [1000,1000] 干干净净过得了 assertSpansFit
  const widthMm = positiveMm(assertMm(input.widthMm, '洞口宽度'), '洞口宽度');
  const heightMm = positiveMm(assertMm(input.heightMm, '洞口高度'), '洞口高度');
  const sillMm =
    input.sillMm === undefined
      ? input.category === 'door'
        ? 0
        : 900
      : assertMm(input.sillMm, '窗台高');
  if (sillMm < 0) throw new RangeError(`窗台高不能为负，收到 ${sillMm}`);
  // 门的 sill 是构造期定的（门要贴地做坡度与门套），派生层只看沿轴区间，管不到竖向
  if (input.category === 'door' && sillMm !== 0) {
    throw new RangeError(`门洞窗台高必须为 0，收到 ${sillMm}`);
  }
  return {
    type: 'opening.create',
    build(doc: Document) {
      const wall = requireWall(doc, input.hostWallId);
      mustExist(doc, wall.storeyId, '楼层');
      const opening: OpeningEntity = {
        kind: 'opening',
        id: uuidv7(),
        // 楼层不是入参，抄宿主墙：洞口天生跟着墙走，
        // "洞口与宿主墙不同层"从写入侧根本造不出来。
        storeyId: wall.storeyId,
        hostWallId: wall.id,
        distanceMm,
        widthMm,
        heightMm,
        sillMm,
        category: input.category,
      };
      assertFitsAfterInsert(doc, opening);
      return { upsert: [opening], remove: [] };
    },
  };
}

export function openingMove(input: { openingId: EntityId; distanceMm: number }): Command {
  const distanceMm = assertMm(input.distanceMm, '洞口距离');
  return {
    type: 'opening.move',
    build(doc: Document) {
      const opening = requireOpening(doc, input.openingId);
      // 搬动不产生新宽度，但读盘/手搓进来的负宽洞口不能由命令层盖章搬走：
      // assertFitsAfterInsert 用的派生判据不看区间朝向（Task 6 F1），这一关只能在这里补。
      // 守卫放在 move 而不是 requireOpening 里 —— 坏数据必须还能删，删除路径不许被它挡住。
      positiveMm(opening.widthMm, '洞口宽度');
      positiveMm(opening.heightMm, '洞口高度');
      const moved: OpeningEntity = { ...opening, distanceMm };
      // 同一条校验：改一樘的位置与新建一樘，允许的落点集合必须一模一样
      assertFitsAfterInsert(doc, moved);
      return { upsert: [moved], remove: [] };
    },
  };
}

export function openingDelete(input: { openingId: EntityId }): Command {
  return {
    type: 'opening.delete',
    build(doc: Document) {
      requireOpening(doc, input.openingId);
      return { upsert: [], remove: [input.openingId] };
    },
  };
}
