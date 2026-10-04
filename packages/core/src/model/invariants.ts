import type { EntityId } from '../ids';
import type { Mm } from '../units/mm';
import { assertSimpleRing } from '../geom/ring';
import { length, sub, vec, type Vec2 } from '../geom/vec';
import { assertNoGhostColumn } from '../geom/topology';
import { deriveStoreyGeometry } from '../geom/outline';
import { INTEGER_FIELDS, type Document } from './document';
import type { Entity, StoreyEntity } from './entity';
import { requirePoint, requireStorey, requireWall } from './read';

/**
 * 楼层竖向重叠：**这份是唯一的产地**。`commands/storey.ts` 的 create / setElevation 与
 * 读盘检查器共用它 —— 计划 2 交下来的原话是"两份规则一定会漂"。
 * 报错文案逐字保留（`commands/storey.ts` 的现有用例吃它），搬动时一个字符都不许改。
 *
 * 竖向不重叠：楼层占用 [elevationMm, elevationMm + heightMm)。
 * 正好贴邻合法（一层的顶就是二层的地），留出空隙也合法（错层、夹层、吊顶），
 * 只有重叠是物理上不可能。负标高合法（地下室），所以符号一律不查。
 * storeyCreate 与 storeySetElevation 共用这一份：两份规则一定会漂。
 */
export function assertNoVerticalOverlap(doc: Document, candidate: StoreyEntity): void {
  const top = candidate.elevationMm + candidate.heightMm;
  for (const other of doc.byKind('storey')) {
    if (other.id === candidate.id || other.projectId !== candidate.projectId) continue;
    const otherTop = other.elevationMm + other.heightMm;
    const from = Math.max(candidate.elevationMm, other.elevationMm);
    const to = Math.min(top, otherTop);
    if (from < to) {
      throw new RangeError(
        `楼层标高重叠：${candidate.id} 占 ${candidate.elevationMm}–${top}，` +
          `与楼层 ${other.id} 的 ${other.elevationMm}–${otherTop} 相交（区间按半开算，贴邻合法）`,
      );
    }
  }
}

/**
 * 轮廓能不能成立（零长与厚 ≥ 轴长共用这一份）：**这份是唯一的产地**。`commands/wall.ts` 的
 * 构造期与 build 期两处调用与读盘门的墙循环共用它 —— 计划 2 交下来的同一条理由：两份规则一定会漂。
 * `label` 把报错指到具体那面墙：命令层传 `'该墙'`（构造期墙还没有 id），读盘侧传墙 id。
 * 文案必须继续含 `零长` 与 `不小于墙长` 两个子串：盘上 8 处命令侧断言
 * （commands.test.ts / topology.test.ts / geometry-properties.test.ts）吃的都只有子串，
 * 没有一处逐字钉整句。读盘证人还吃 `两端点量化后同为` —— 用它把这一发与 `geom/axis.ts`
 * 那句"轴线无方向"分开，免得"到底是哪道门拦的"再次没有凭据。
 */
export function assertWallShape(
  label: string,
  thicknessMm: Mm,
  x0: Mm,
  y0: Mm,
  x1: Mm,
  y1: Mm,
): void {
  if (x0 === x1 && y0 === y1) {
    throw new RangeError(`零长墙：${label}两端点量化后同为 (${x0}, ${y0})`);
  }
  const lengthMm = length(sub(vec(x1, y1), vec(x0, y0)));
  if (thicknessMm >= lengthMm) {
    throw new RangeError(
      `墙厚 ${thicknessMm} 不小于墙长 ${Math.round(lengthMm)}，轮廓会自相交（${label}）`,
    );
  }
}

function tag(entity: Entity): string {
  return `${entity.kind} ${entity.id}`;
}

/**
 * 取整数毫米字段：`INTEGER_FIELDS` 是唯一表产地（document.ts），这里只读不另立名单。
 * `typeof` 守卫照 `document.ts` 的 validate 补：字段缺失时直接下标返回 `undefined`，
 * 而 `Object.is(undefined, -0)` 与 `undefined < 1` 都是 false —— 少了这一发，那道门会被
 * **悄悄跳过**而不是拒掉。文案点名实体 id 与字段名（`tag` 带 kind + id）。
 */
function mm(entity: Entity, field: string): number {
  const value = (entity as unknown as Record<string, unknown>)[field];
  if (typeof value !== 'number') {
    throw new TypeError(`${tag(entity)}.${field} 必须是数字毫米，收到 ${String(value)}`);
  }
  return value;
}

function assertNoNegativeZero(entity: Entity): void {
  for (const field of INTEGER_FIELDS[entity.kind]) {
    if (Object.is(mm(entity, field), -0)) {
      throw new TypeError(`${tag(entity)}.${field} 不接受 -0：真源里的零不许带符号`);
    }
  }
}

function assertAtLeastOne(entity: Entity, fields: readonly string[]): void {
  for (const field of fields) {
    const v = mm(entity, field);
    if (v < 1) throw new RangeError(`${tag(entity)}.${field} 必须 ≥ 1mm，收到 ${String(v)}`);
  }
}

/**
 * 引用完整性 + 同层 + 下界 + 门规 + 竖向不重叠 + `-0`：读盘侧的放行证。
 * **零层文档合法**（刚 createProject 还没画层），所以本函数不许要求"至少一层"——
 * 命令层那条"最后一层不许删"是 `storeyDelete` 的规则，不是数据规则，别在这里复制。
 *
 * 这一道门自己覆盖：引用解析与同层、index 唯一 + 非负安全整数、≥1 的字段、`-0`、
 * 零长墙与墙厚不小于墙长（`assertWallShape`，与命令层同一产地）、洞口负 distance /
 * 负 sill / 门洞 sill≠0 / 洞顶超过宿主墙高、同层同坐标幽灵柱（`assertNoGhostColumn`，
 * 与命令层同一产地）、楼板环简单（`assertSimpleRing`）。
 * 归最后一遍逐层 `deriveStoreyGeometry`（派生层是那些判据的唯一产地，这里不重算）：
 * 接头不闭合、轮廓翻面、同向重叠、星形接头、洞口沿轴区间重叠（`assertSpansFit`）。
 */
export function assertTruthSourceInvariants(doc: Document): void {
  const seenIndex = new Set<string>();
  for (const storey of doc.byKind('storey')) {
    if (storey.projectId !== doc.projectId) {
      throw new TypeError(`楼层 ${storey.id} 的 projectId ${storey.projectId} 与文档 ${doc.projectId} 不一致：归属别的项目的数据不许混进来`);
    }
    if (!Number.isSafeInteger(storey.index) || storey.index < 0) {
      throw new RangeError(`楼层 ${storey.id} 的 index 必须为非负整数，收到 ${String(storey.index)}`);
    }
    const key = `${storey.projectId}:${storey.index}`;
    if (seenIndex.has(key)) throw new RangeError(`楼层 index 重复：${key}`);
    seenIndex.add(key);
    assertNoNegativeZero(storey);
    assertAtLeastOne(storey, ['heightMm']);
    assertNoVerticalOverlap(doc, storey);
  }

  for (const point of doc.byKind('point')) {
    assertNoNegativeZero(point);
    requireStorey(doc, point.storeyId); // 不存在即抛，消息带 id
  }

  for (const wall of doc.byKind('wall')) {
    assertNoNegativeZero(wall);
    assertAtLeastOne(wall, ['thicknessMm', 'heightMm']);
    const owner = requireStorey(doc, wall.storeyId);
    const start = requirePoint(doc, wall.startId, '墙起点');
    const end = requirePoint(doc, wall.endId, '墙终点');
    for (const p of [start, end]) {
      if (p.storeyId !== wall.storeyId) {
        throw new TypeError(
          `墙 ${wall.id} 属于楼层 ${owner.id}，端点 ${p.id} 属于楼层 ${p.storeyId}：跨层的端点会让两层墙网凭空焊死，同层判据不许放宽`,
        );
      }
    }
    // 零长与厚 ≥ 墙长走搬进来的那份共享判据（label 带墙 id，报错点名是哪面墙）。
    // 这里刻意不借道 geom/axis 的 wallAxis：axis.ts 自带一句零长文案，借道等于第三份判据，
    // 还多一次抛点与一次换算；坐标用的就是上面已经取到的 start/end。
    assertWallShape(`${wall.id}`, wall.thicknessMm, start.x, start.y, end.x, end.y);
  }

  for (const opening of doc.byKind('opening')) {
    assertNoNegativeZero(opening);
    assertAtLeastOne(opening, ['widthMm', 'heightMm']);
    requireStorey(doc, opening.storeyId);
    const host = requireWall(doc, opening.hostWallId);
    if (host.storeyId !== opening.storeyId) {
      throw new TypeError(`洞口 ${opening.id} 在楼层 ${opening.storeyId}，宿主墙 ${host.id} 在楼层 ${host.storeyId}：洞口与宿主必须同层`);
    }
    if (mm(opening, 'distanceMm') < 0) throw new RangeError(`洞口 ${opening.id} 的 distanceMm 不能为负`);
    if (mm(opening, 'sillMm') < 0) throw new RangeError(`洞口 ${opening.id} 的 sillMm 不能为负`);
    if (opening.category === 'door' && mm(opening, 'sillMm') !== 0) {
      throw new RangeError(`门 ${opening.id} 的 sillMm 必须为 0，收到 ${String(mm(opening, 'sillMm'))}`);
    }
    // 洞顶超宿主墙高：派生层只换算沿轴区间，竖向那条看不见（commands/opening.ts 顶部
    // 白纸黑字把它列为派生抓不到的一条），所以只能在这一道门显式拦。
    // 注意这条**不主张"读盘门是写盘门的超集"**：`assertFitsAfterInsert` 是并入同宿主已有
    // 洞口之后再判竖向，比这里按裸字段判更严 —— 已知不对称，不是缺陷。
    const openingTopMm = mm(opening, 'sillMm') + mm(opening, 'heightMm');
    if (openingTopMm > host.heightMm) {
      throw new RangeError(
        `洞口 ${opening.id} 顶标高 ${openingTopMm} 超过宿主墙高 ${host.heightMm}` +
          `（窗台 ${mm(opening, 'sillMm')} + 洞口高 ${mm(opening, 'heightMm')}）`,
      );
    }
  }

  for (const column of doc.byKind('column')) {
    assertNoNegativeZero(column);
    assertAtLeastOne(column, ['widthMm', 'depthMm', 'heightMm']);
    requireStorey(doc, column.storeyId);
    const at = requirePoint(doc, column.pointId, '柱落点');
    if (at.storeyId !== column.storeyId) {
      throw new TypeError(`柱 ${column.id} 在楼层 ${column.storeyId}，落点 ${at.id} 在楼层 ${at.storeyId}：必须同层`);
    }
    // 幽灵柱：柱与板不进派生表、SpatialIndex 只装墙与洞口，重影柱在视图与索引里都看不见，
    // 命令层那条"同层同坐标只准一根柱"必须在这里再判一次。判据共用 geom/topology 那份产地。
    // 代价：每根柱扫全层柱，O(columns²)，与派生层同一量级、loads 时的一次性成本。
    // 残余盲区（登记）：exceptPointId 按点 id 排除，挂在**同一枚点**上的重影柱互相都算排除，
    // 这一型仍放行 —— 能拦的是"不同 id、同坐标"那一型（命令层造不出前者，读盘手搓能）。
    assertNoGhostColumn(doc, column.storeyId, { x: at.x, y: at.y }, column.pointId);
  }

  for (const slab of doc.byKind('slab')) {
    assertNoNegativeZero(slab);
    assertAtLeastOne(slab, ['thicknessMm']);
    requireStorey(doc, slab.storeyId);
    const ring: Vec2[] = slab.boundaryPointIds.map((id: EntityId) => {
      const p = requirePoint(doc, id, '楼板顶点');
      if (p.storeyId !== slab.storeyId) {
        throw new TypeError(`楼板 ${slab.id} 的顶点 ${id} 属于楼层 ${p.storeyId}：必须同层`);
      }
      return vec(p.x, p.y);
    });
    assertSimpleRing(`楼板 ${slab.id} `, ring); // 共线 / 自交 / 顶点数退化的唯一产地
  }

  // 最后一道：把派生层跑一遍。这一遍覆盖的是派生层自己的那五道守卫 —— 接头不闭合、轮廓翻面、
  // 同向重叠、星形接头、洞口沿轴区间重叠（assertSpansFit），那份判据以派生层为唯一产地，
  // invariants 里一条都不重算；零长与厚 ≥ 墙长、洞顶超墙高、幽灵柱**不在这一遍里**，
  // 是上面各循环里的显式条目（派生层看不见它们：outline.ts 的四道守卫不含厚/长，
  // 竖向与柱更不进派生表）。
  for (const storey of doc.byKind('storey')) {
    deriveStoreyGeometry(doc, storey.id);
  }
}
