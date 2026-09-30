import {
  columnDelete,
  length,
  openingDelete,
  quantizeMm,
  requireStorey,
  slabDelete,
  sub,
  TransactionLog,
  vec,
  wallCreate,
  wallDelete,
  type Command,
  type Document,
  type EntityId,
  type PointRef,
} from '@dajia/core';
import { mmToPx, type Px, type Viewport } from './viewport';
import { MIN_PICK_EDGE_PX, pickAt } from './pick';
import { buildDrawList, type DrawOp } from './drawlist';
import {
  dropTargetOf,
  pointRefOf,
  snapFieldOf,
  type DropTarget,
  type MoveTarget,
  type SnapField,
  type SnapResult,
} from './snapping';

/**
 * 屏幕上"这一发该不该发命令"的那一层（Task 6 起，Task 8 补柱/板两支）。三个模块各管一问，互不越界：
 * `snapping.ts` = 这一发光标落在**哪儿**；`handles.ts` = 这一发**接得到**哪枚既有的点；
 * 本文件 = 接住了之后**要不要发**这条命令、发出去把谁拿回来、删的时候发几条。
 *
 * 为什么新建与删除放在同一个文件：两者共用同一套判据（真命令试跑、`affected` 的事后复核、
 * 选中的事后剪枝）。拆成两个文件就是各写一份 —— 漂掉的永远是没人看的那一份
 * （`commands/opening.ts` 顶部"命令层绝不复述区间规则"同一条理由）。
 */

/** 交互模式。`wall` = 正在拉新墙，此时删除键什么都不发（见 `planDelete`）。 */
export type Tool = 'select' | 'wall';

/**
 * 新墙的默认墙厚。真源里没有"上一层用多厚"可读，这是产品给的起点；Task 8 的数值输入替换它
 * —— 而**本任务没有替换它**：属性面板改的是既有墙的厚度，新建墙那一路仍然吃这个常量。
 */
export const NEW_WALL_THICKNESS_MM = 240;

/**
 * 新墙的最小长度（毫米）—— **只作用于 `wallProbe` 挑靶子**，别把它读成"用户那一发也有这道闸"：
 * 屏幕上真正拦得住长度的只有真源那两条（零长、墙厚不小于墙长，见 `wallCreate`），一面 300mm
 * 的短墙在真源里完全合法，本任务不假装屏幕上有第三道闸。
 *
 * 为什么探针还需要这条：像素那一道下限量的是**轮廓长边**（`lengthMm - thicknessMm` 对 64px），
 * 放大越多它换算回毫米越小 —— 2px/mm 时一面 272mm 长的墙（长边只剩 32mm）就够 64px 了，
 * 而真源只不许 `thicknessMm >= lengthMm`，所以 240mm 到 500mm 之间那段墙全都合法、又短得没法施工。
 * 这道毫米筛把靶子钉在 500mm 以上，与放大倍率无关。Task 8 落地时也没有把这条下限搬到输入框上
 * —— 它到今天仍只作用于探针，边界由 `panel.test.ts` 那条用例钉着。
 */
export const MIN_WALL_LENGTH_MM = 500;

export interface NewWallDefaults {
  readonly thicknessMm: number;
  readonly heightMm: number;
}

/**
 * 新墙的墙厚 / 墙高。**Task 8 的"数值输入"要替换掉的唯一占位入口** —— 届时只改这一个函数，
 * `draftCommand` 与 `legalWallCreate` 的调用点一行不动（它们只吃 `NewWallDefaults`）。
 *
 * 层高读真源（`requireStorey`）而不是抄常量：把新墙画在 3600 的层上却给 3000 的墙高，
 * 2D 屏幕上看不出来，到了 3D 与施工图上是一面够不到顶的墙。墙厚没有真源可读，才留常量。
 */
export function newWallDefaults(doc: Document, storeyId: string): NewWallDefaults {
  return {
    thicknessMm: NEW_WALL_THICKNESS_MM,
    heightMm: requireStorey(doc, storeyId).heightMm,
  };
}

/**
 * 草稿的起点 = 按下那一发的答案。带着完整的 `SnapResult`（而不是拆成 `pointId` + `kind`）：
 * `pointRefOf` 吃的就是这一份，拆开再拼回去等于把"复用哪枚点"这条判据抄两遍。
 */
export interface DraftPoint {
  readonly mm: MoveTarget;
  /**
   * 按下那一发的**光标像素**（不是吸附点的像素）。它的读者是**预览线的起点** ——
   * `PlanCanvas.tsx` 里 `paintPreview(ctx, draft.start.px, draft.cursorPx)` 用它当临时线那一头，
   * 于是"手指按在哪儿"与"落点吸到哪儿"在屏幕上是两个值。
   * 起点那枚吸附标记**不读它**：标记画在 `snap.mm` 换算的像素上（`mmToPx(viewport, snap.mm)`），
   * 位置一律走毫米对账 —— 同 `snapping.ts` 里 `SNAP_COLOR` 那条注的口径（第四色只证"吸走了"，
   * 吸到哪由毫米说）。
   */
  readonly px: Px;
  readonly snap: SnapResult | null;
}

/** 一次拉墙的完整现场。不可变：`moveDraft` 每次返回新对象，renderer 比引用就能决定重绘。 */
export interface DraftWall {
  readonly storeyId: string;
  readonly start: DraftPoint;
  /** 裸光标：临时线**恒**画到这里（S4 第三条纪律），不是吸附点。 */
  readonly cursorPx: Px;
  readonly end: DropTarget;
  /** 真命令试跑的结论。false ⇒ 松手不发命令。 */
  readonly legal: boolean;
}

/**
 * 按下那一发的起点。锚点给 **null** ⇒ 只有靶子档参与：按下时还没有"从哪儿出发"这回事，
 * 给它锚点等于"点下去就自动变正交"，那是抢方向盘（S3 的措辞）。
 */
export function draftAtPress(v: Viewport, px: Px, field: SnapField): DraftPoint {
  const drop = dropTargetOf(v, px, null, field);
  return { mm: drop.mm, px, snap: drop.snap };
}

/** 草稿的两个端点 → 命令入参。吸到既有点就复用，否则才新建（`pointRefOf` 是唯一的判据）。 */
export function draftRefs(draft: DraftWall): { readonly start: PointRef; readonly end: PointRef } {
  return { start: pointRefOf(draft.start.mm, draft.start.snap), end: pointRefOf(draft.end.mm, draft.end.snap) };
}

/**
 * 移动那一发：终点**以起点为锚**（"水平 / 竖直 / 15°"只有相对起点才成立），并且排掉起点的坐标
 * —— 不排的话光标压在起点上会吸回自己（端点档 + 该点轴线上的垂足档），屏幕上表现为"拖不开"，
 * 真源里是零长墙被 `wallCreate` 拒掉，用户以为松手键坏了。
 *
 * `doc` 每次现问，不缓存进草稿：草稿活着的那几十秒里可能来一发撤销，那一份 `legal` 就成了谎话。
 */
export function moveDraft(
  doc: Document,
  draft: DraftWall,
  v: Viewport,
  cursorPx: Px,
  field: SnapField,
): DraftWall {
  const end = dropTargetOf(v, cursorPx, draft.start.mm, field, { excludeMm: draft.start.mm });
  const next: DraftWall = { ...draft, cursorPx, end, legal: false };
  return { ...next, legal: legalWallCreate(doc, next) };
}

/**
 * 合法性 = 拿**真命令**试跑一次（`legalDrop` 的同一条理由：绝不在屏幕上重写一遍守卫）。
 * `wallCreate` 的守卫有零长、墙厚不小于墙长、墙高为正、楼层存在、跨层复用点等五道，
 * 抄一道漏四道。构造期与 `build` 两道都会抛，所以整段在 try 里。
 */
export function legalWallCreate(doc: Document, draft: DraftWall): boolean {
  try {
    buildCreate(doc, draft, newWallDefaults(doc, draft.storeyId));
    return true;
  } catch {
    return false;
  }
}

function buildCreate(doc: Document, draft: DraftWall, defaults: NewWallDefaults) {
  const refs = draftRefs(draft);
  return wallCreate({
    storeyId: draft.storeyId,
    start: refs.start,
    end: refs.end,
    thicknessMm: defaults.thicknessMm,
    heightMm: defaults.heightMm,
  }).build(doc);
}

/**
 * 草稿 → 命令。**只认 `legal` 一色**：false 就是不发（null），true 时 `wallCreate` 的构造期
 * 判据必然也过（同一对入参、同一套守卫，`legalWallCreate` 已经跑过一遍）。
 * 所以这里不 catch —— 真抛出来说明 `legal` 与入参之间漂了，那是程序错误，该红不该被咽下去。
 */
export function draftCommand(draft: DraftWall, defaults: NewWallDefaults): Command | null {
  if (!draft.legal) return null;
  const refs = draftRefs(draft);
  return wallCreate({
    storeyId: draft.storeyId,
    start: refs.start,
    end: refs.end,
    thicknessMm: defaults.thicknessMm,
    heightMm: defaults.heightMm,
  });
}

/**
 * 删除的计划。四条出口，各有各的判据，**不许合并成"成功 / 失败"两色**：
 * 'empty' 与 'ignored-in-wall-mode' 都发 0 条命令，但前者该提示"没选中东西"、
 * 后者该什么都不做（拉墙时误触 Delete 不该清空选中集）—— 合并了屏幕上就分不开。
 */
export type DeleteOutcome = 'ok' | 'empty' | 'ignored-in-wall-mode' | 'unsupported';

export interface DeletePlan {
  readonly outcome: DeleteOutcome;
  /** 派发顺序 = 数组顺序：洞口 → 柱 → 板 → 墙（S5 扩成四段，理由见 `planDelete`）。 */
  readonly commands: readonly Command[];
  /** `commands` 的 `type` 抄一份：探针与日志判"发了哪几条"用它，不用反射。 */
  readonly commandTypes: readonly string[];
  /** 真的发出命令的那些 id，与 `commands` 同序（洞口 → 柱 → 板 → 墙，各段内按 id 升序）。 */
  readonly candidateIds: readonly EntityId[];
  /**
   * 本次不删的 id：**别层构件**，加上屏幕上取不到的 `storey` / `point`（后两者的删除入口不是
   * Delete 键，理由写在 `planDelete` 最后那段注释里）。样例房里恒空 —— 那儿没有别层的东西被选中。
   */
  readonly unsupported: readonly EntityId[];
}

/**
 * 选中集 → 删除命令。**四条规则，一条都不复述真源已经做的事**：
 * ① 选中的墙 → `wall.delete`（它自己会级联收掉宿主是它的洞口、自己判端点还剩谁引用）；
 * ② 选中的洞口且**宿主墙不在本次删除集里** → `opening.delete`；
 * ③ 选中的柱 → `column.delete`（它自己收掉独占的落点，孤儿判定问 `pointStillReferenced`）；
 * ④ 选中的板 → `slab.delete`（同上，逐枚边界点各问一次）。
 *
 * 为什么反过来（先给每个选中洞口发 `opening.delete`、再删墙）也不行：那是对真源已有级联的
 * 复述，复述的规则一定会漂；而先删墙之后那些洞口已经不存在，第二条命令 `requireOpening`
 * 直接抛，`dispatchBatch` 就在半途留下半套状态。
 *
 * 顺序排成"洞口 → 柱 → 板 → 墙"是为了撤销的可读性：栈顶是 `wall.delete`，一次 Ctrl+Z 把
 * "墙 + 它自己级联掉的洞口"整组还原，而不是先还回一樘无主的洞口。柱与板排在墙**之前**：
 * 它们与墙共享端点时，先删板/柱会让那些点变成孤儿候选，而 `wallDelete` 的孤儿判定是事后问的，
 * 两个顺序都合法 —— 定死一个，撤销栈的形状才可预测（`--prop-shot` 里"删一根柱再撤销"那条判据读它）。
 *
 * **屏幕上今天还点不到柱与板**：`buildDrawList` 的指令表与 `pickAt` 的命中集都只认墙与洞口，
 * 所以 ③④ 两支的凭据只能是合成夹具（手工把柱/板的 id 放进选中集）。不许为了在屏幕上"证明它"
 * 就把柱画进指令表 —— 那是**计划 4** 的边界（Task 9 只把柱心/板角喂进**吸附场**，指令表与命中集一行未动），
 * 混进来会让 `--draw-shot` 那 28 行像素判据全数重测。
 */
export function planDelete(
  doc: Document,
  storeyId: string,
  tool: Tool,
  ids: Iterable<EntityId>,
): DeletePlan {
  const all = [...ids];
  if (tool === 'wall') {
    return { outcome: 'ignored-in-wall-mode', commands: [], commandTypes: [], candidateIds: [], unsupported: [] };
  }
  const wallIds = new Set<EntityId>();
  const openingIds = new Set<EntityId>();
  const columnIds = new Set<EntityId>();
  const slabIds = new Set<EntityId>();
  const unsupported: EntityId[] = [];
  for (const id of all) {
    const entity = doc.get(id);
    // 已经不在了：两次渲染之间被撤销掉、或被同伴级联删掉。**一律不发命令也不进 unsupported** ——
    // 该管这件事的是 `pruneSelection`（屏幕上那一发本来就点不到它），在这里记账只会把
    // "选中集没剪干净"和"删除能力不够"混成同一条红。
    if (entity === undefined) continue;
    if (entity.kind === 'wall') {
      // 别层的墙不当"不支持"处理：它是"不该在这一层删的东西出现在了这一层的选中集"，
      // 那是选中集的问题（pruneSelection 的活），不是删除能力的问题。
      if (entity.storeyId !== storeyId) unsupported.push(id);
      else wallIds.add(id);
      continue;
    }
    if (entity.kind === 'opening') {
      if (entity.storeyId !== storeyId) unsupported.push(id);
      else openingIds.add(id);
      continue;
    }
    if (entity.kind === 'column') {
      if (entity.storeyId !== storeyId) unsupported.push(id);
      else columnIds.add(id);
      continue;
    }
    if (entity.kind === 'slab') {
      if (entity.storeyId !== storeyId) unsupported.push(id);
      else slabIds.add(id);
      continue;
    }
    // 剩下只有 `storey` 与 `point` 两种，而它们**不进删除集**：
    // 楼层实体没有 `storeyId`（它就是层本身），`pruneSelection` 一律剔掉，所以它进不到这里；
    // `storeyDelete` 的入口因此不是 Delete 键，而是楼层 tab 上那条显式动作（删整层 = 连带删光该层
    // 所有构件，需要确认框，S1 没有确认框）。点在屏幕上也不会命中楼层或裸点 —— 命中集只有墙与洞口。
    unsupported.push(id);
  }
  // 宿主墙要一起删的洞口不发第二条：wallDelete 的级联已经收了它。
  const solo = [...openingIds].filter((id) => {
    const opening = doc.get(id);
    if (opening?.kind !== 'opening') return false;
    return !wallIds.has(opening.hostWallId);
  });
  const sortedSolo = solo.sort();
  const sortedColumns = [...columnIds].sort();
  const sortedSlabs = [...slabIds].sort();
  const sortedWalls = [...wallIds].sort();
  const commands: Command[] = [
    ...sortedSolo.map((openingId) => openingDelete({ openingId })),
    ...sortedColumns.map((columnId) => columnDelete({ columnId })),
    ...sortedSlabs.map((slabId) => slabDelete({ slabId })),
    ...sortedWalls.map((wallId) => wallDelete({ wallId })),
  ];
  const candidateIds = [...sortedSolo, ...sortedColumns, ...sortedSlabs, ...sortedWalls];
  const outcome: DeleteOutcome =
    commands.length > 0 ? 'ok' : unsupported.length > 0 ? 'unsupported' : 'empty';
  return { outcome, commands, commandTypes: commands.map((c) => c.type), candidateIds, unsupported };
}

/**
 * 删除 / 撤销之后重算一遍选中：还存在的、且还在本层的才留下。
 *
 * 为什么不预测补丁内容：`wallDelete` 会级联删掉洞口，还会收掉不再被引用的端点，
 * UI 侧照抄一遍等于把真源的孤儿判定抄第二份。事后拿真源问一遍，永远只有一个口径。
 * 排序是为了让"选中集没变"这种比较可判（`Set` 的迭代序跟着插入顺序，撤销一次就漂）。
 */
export function pruneSelection(doc: Document, storeyId: string, ids: Iterable<EntityId>): EntityId[] {
  const out: EntityId[] = [];
  for (const id of ids) {
    const entity = doc.get(id);
    if (entity === undefined) continue;
    // 楼层实体没有 `storeyId`（它就是层本身），本层的选中集里出现它就是错 ⇒ 一律剔掉。
    // 少这一支下面那句会编译不过，所以它不是"顺手写的"：Task 8 决定 `storeyDelete` 的入口
    // **不是** Delete 键（删整层要连带删光该层构件，需要确认框，S1 没有），于是这一支剔掉的就是
    // 最终答案，而不是"先剔掉、等 planDelete 再记账"的中间态。
    if (entity.kind === 'storey') continue;
    // 点按它自己的 `storeyId` 筛：`PointEntity.storeyId` 可为 null（地形 / 园林点不属于任何一层），
    // 那一支同样落不进本层的选中集。曾经这里写的是"point 一律放行"，理由是"点没有 storeyId" ——
    // 那个前提是假的（`resolvePointRef` 正靠这句判跨层），假前提写进判据就是漏。
    if (entity.storeyId !== storeyId) continue;
    out.push(id);
  }
  return out.sort();
}

/** `lastCreatedWall` 的答案。`startId` / `endId` 是给探针复核用的三样之一（另一个是 `wallId`）。 */
export interface LastCreatedWall {
  readonly wallId: EntityId;
  readonly storeyId: EntityId;
  readonly startId: EntityId;
  readonly endId: EntityId;
}

/**
 * 从最近一次派发的 `affected` 里取新建的那面墙 —— renderer 侧第一个读 `affected` 的人。
 *
 * 三条纪律，缺一条就会拿到一面不存在的墙：
 * ① 只在 `dispatch` 的成功分支里**同步**读（异步读会读到别人之后的 `affected`）；
 * ② 读完立刻拿 `doc.get(id)` 复核（`undo()` 把 `lastAffected` 设成**前向**补丁的 id，
 *    撤销掉一次 `wall.create` 之后 `affected` 里仍然列着那面墙，而文档里已经没有它了）；
 * ③ 不许缓存（下一次派发就换内容）。
 * `affected` 的语义是"最近一次触及的 id"，不是"新出现的 id" —— 所以调用方永远要把文档当第二票。
 */
export function lastCreatedWall(
  doc: Document,
  affected: ReadonlySet<EntityId>,
  storeyId: string,
): LastCreatedWall | null {
  for (const id of affected) {
    // 判别式只认 `doc.get(id)`：uuidv7 在同一毫秒内不单调，`byKind('wall').at(-1)` 会拿到
    // 别的实体（全局约束那条），而这里连"最后一条"都不必 —— affected 里 wall 只会有一面。
    const entity = doc.get(id);
    if (entity?.kind !== 'wall') continue;
    if (entity.storeyId !== storeyId) continue; // 别层的墙（撤销后重做、或探针挑错了靶子）不算
    return { wallId: entity.id, storeyId: entity.storeyId, startId: entity.startId, endId: entity.endId };
  }
  return null;
}

/**
 * `wallProbe` 的候选落点：整数毫米，全部 **axis 对齐**（正交档会把它钉在同一根坐标上，
 * 于是新墙与既有墙垂直相交，屏幕上看着像那么回事）。顺序写死在这里 ⇒ 同一份文档
 * 每次问都给同一个靶子，"撤销后回到原值"那类判据才有可比的对象。
 */
const WALL_PROBE_OFFSETS: readonly MoveTarget[] = [
  { x: 2000, y: 0 },
  { x: 0, y: 2000 },
  { x: -2000, y: 0 },
  { x: 0, y: -2000 },
  { x: 2000, y: 2000 },
  { x: -2000, y: 2000 },
  { x: 2000, y: -2000 },
  { x: -2000, y: -2000 },
  { x: 3000, y: 0 },
  { x: 0, y: 3000 },
];

/** `--draw-shot` 的一次拉墙现场：三枚**整数**像素 + 两对整数毫米 + 命令入参的默认值。 */
export interface WallProbe {
  /** 起点的像素：它**就是**既有端点那一发，按下即吸上。 */
  readonly startPx: Px;
  readonly startMm: MoveTarget;
  /** 起点复用的那枚点：判据 D4「新建的墙与既有墙共享一枚点」读它。 */
  readonly startPointId: EntityId;
  /** 终点像素（整数）：`sendInputEvent` 只收整数 DIP，毫米由它反算。 */
  readonly endPx: Px;
  readonly endMm: MoveTarget;
  /** 新墙中点的像素：删除那一步要在真窗口里点中它，`pickPxOf` 之外第二道对照。 */
  readonly midPx: Px;
  readonly lengthMm: number;
  readonly defaults: NewWallDefaults;
}

/**
 * 找一发"值得在真窗口里拉"的新墙。返回 null 是合法结果（空层、铺满的层），闸门在那一步就抛，
 * 不许放宽下面的筛来迁就样例房。
 *
 * 六道筛，每条各堵一处假绿：
 * ① **起点必须吸到既有端点**（`snapKind === 'endpoint'` 且 `pointId` 非 null）：不复用就接不上头，
 *    判据 D4 只能在真源里成立、在屏幕上证不出来。注意这一筛**不假设每个端点都吸得上**：
 *    像素原点带小数的视图下（`fitStorey` 在 1200×901 就是这样），把光标取整到端点像素后
 *    垂足档可能比端点更近半像素，于是那一枚端点被跳过、探针换下一个 —— 实测过，不是想象。
 *    谁吸得上是 `takeBest` 的判据，探针只负责服从它（把它改成"信自己按毫米拼出来的端点"，
 *    屏幕上就会出现探针说吸上了、真窗口里没吸上）。
 * ② **终点的 `pointId` 必须为 null**（S7 的准确口径）：它保证这面墙的终点那一头是**新建的点**。
 *    注意不是"终点不许吸附" —— 探针的候选全是轴对齐的，正交档必然命中，那是保坐标、不引点。
 *    只有引了别人的点，`wallDelete` 才会判定那枚点仍被引用而留下它，
 *    "删掉这面墙带走恰好一枚孤儿点"的账就变成看运气。
 * ③ 长度同时过毫米下限与像素下限：前者防墙屑，后者防"闸门建了一面点不中的墙"
 *    （轮廓长边 ≈ 轴长 − 墙厚，小于 `MIN_PICK_EDGE_PX` 时 `pickPxOf` 给 null，删除那一步没法点名）。
 * ④ 落点与中点那两发像素**一个候选都不许命中**：不判它，探针可能挑到穿过既有墙的位置，
 *    新墙的轮廓与老墙叠在一起，`pickPxOf` 的"唯一命中"筛会一路换边换到 null。
 * ⑤ **三发像素全在画布内**（`insideCanvas`）：越界的那一发 `sendInputEvent` 发不出去，
 *    闸门会在"按了没反应"和"毫米对不上"之间反复横跳。
 * ⑥ **建得出还要画得出**（`derivesCleanly`）：Task 7 起 `wallCreate` 的 `build` 末尾就复核了派生，
 *    所以这一筛在样例房上与 `legalWallCreate` **判得一样**（实测同一批候选）。留着它是因为
 *    "画得出"这句话在屏幕上只有这一个读者 —— 见 `derivesCleanly` 的注释，别顺手删。
 */
export function wallProbe(
  doc: Document,
  storeyId: string,
  ops: readonly DrawOp[],
  v: Viewport,
): WallProbe | null {
  const field = snapFieldOf(doc, storeyId);
  const defaults = newWallDefaults(doc, storeyId);
  const endpoints = field.points.filter((p) => p.kind === 'endpoint');
  for (const ep of endpoints) {
    if (ep.pointId === null) continue; // 端点档恒有 pointId；这一支只为让类型收窄成立
    // 起点走与屏幕完全同一条通路：先算像素、再 `dropTargetOf`。探针自己按毫米拼 `pointId`
    // 就等于绕开吸附 —— 屏幕上真会吸到别处时探针看不见。
    const startPx = intPx(mmToPx(v, vec(ep.mm.x, ep.mm.y)));
    const start = draftAtPress(v, startPx, field);
    if (start.snap?.kind !== 'endpoint' || start.snap.pointId !== ep.pointId) continue;
    for (const off of WALL_PROBE_OFFSETS) {
      const guess: MoveTarget = { x: ep.mm.x + off.x, y: ep.mm.y + off.y };
      const endPx = intPx(mmToPx(v, vec(guess.x, guess.y)));
      const end = dropTargetOf(v, endPx, ep.mm, field, { excludeMm: ep.mm });
      if (end.snap !== null && end.snap.pointId !== null) continue; // 筛 ②
      const lengthMm = length(sub(vec(end.mm.x, end.mm.y), vec(ep.mm.x, ep.mm.y)));
      if (lengthMm < MIN_WALL_LENGTH_MM) continue; // 筛 ③ 之一
      if ((lengthMm - defaults.thicknessMm) * v.pxPerMm < MIN_PICK_EDGE_PX) continue; // 筛 ③ 之二
      const midPx = intPx(mmToPx(v, vec(quantizeMm((ep.mm.x + end.mm.x) / 2), quantizeMm((ep.mm.y + end.mm.y) / 2))));
      if (pickAt(ops, endPx).length !== 0) continue; // 筛 ④
      if (pickAt(ops, midPx).length !== 0) continue; // 筛 ④
      // 筛 ⑤：三发像素全在画布内（见 `insideCanvas`）。放在 ④ 之后、`legalWallCreate` 之前：
      // 它比试跑命令便宜，且越界那一发根本发不出去，合法性与否都无从在真窗口里对账。
      if (!insideCanvas(v, startPx) || !insideCanvas(v, endPx) || !insideCanvas(v, midPx)) continue;
      const draft: DraftWall = {
        storeyId,
        start: { mm: ep.mm, px: startPx, snap: start.snap },
        cursorPx: endPx,
        end,
        legal: false,
      };
      if (!legalWallCreate(doc, draft)) continue;
      // 筛 ⑥：建得成还要画得出。Task 7 之后 `legalWallCreate` 里的 `build` 已经复核过派生，
      // 这一筛与它判得一样（实测同一批候选）；留着它是"画得出"这句话的唯一读者。
      if (!derivesCleanly(doc, { ...draft, legal: true }, v, defaults)) continue;
      return {
        startPx,
        startMm: ep.mm,
        startPointId: ep.pointId,
        endPx,
        endMm: end.mm,
        midPx,
        lengthMm,
        defaults,
      };
    }
  }
  return null;
}

/**
 * 筛 ⑥：拿一份**副本真建一遍、再把整层派生一遍**。
 *
 * `legalWallCreate` 跑命令的 `build`，而 Task 7 起 `build` 的最后一行就是派生复核（`assertDerivesAfterApply`）；
 * `buildDrawList` 走的也是 `deriveStoreyGeometry` → `deriveJoints` 那一条 —— 两侧从此对"三个方向过同一枚点"
 * （S1 不支持星形接头）给同一个判决。
 * 这条筛不是想象出来的：加进筛 ⑤ 之后样例房的探针改挑 `(0,0) → (2000,2000)` 那发 45°，
 * 而 `(0,0)` 本来已经过着两条线 —— 建完墙 `buildDrawList` 当场抛
 * 「接头 … 有 3 个墙端、3 组方向线，S1 不支持」（2026-09-28 实测，红在既有那条"建出来真的点得中"上）。
 * 在真窗口里那一发的现象是**松手之后整层画不出来**：抛错发生在 paint effect 里，
 * 判据会红在一句与画墙无关的对账上。所以挑靶子阶段就拒掉。
 *
 * **代价与边界**：每个候选多一次整层派生（样例房一层八面墙，`wallProbe` 全程仍在毫秒级）。
 * **Task 7 之后它不再是唯一防线**：`wallCreate` 的 `build` 已经复核过派生（`assertDerivesAfterApply`），
 * 它与 `legalWallCreate` 从此判得一样（2026-09-28 实测 80 发候选里被挡的那 48 发在两侧是同一批），
 * 是**第二道保险**而不是唯一防线。留着它是因为它是**画得出**而不是**建得出**的唯一读者：
 * `buildDrawList` 将来长出派生之外的失败（渲染期的算术、新的抛点）时，探针依然只给得出
 * 真窗口里点得中、画得出的一发。摘掉它的改坏行是 E28，登记在执行日的重测里。
 */
function derivesCleanly(
  doc: Document,
  draft: DraftWall,
  v: Viewport,
  defaults: NewWallDefaults,
): boolean {
  try {
    const command = draftCommand(draft, defaults);
    if (command === null) return false;
    // 副本：`TransactionLog.dispatch` 换的是 log 自己那份 document 引用，传进来的那份不动
    const trial = new TransactionLog(doc);
    trial.dispatch(command);
    buildDrawList(trial.document, draft.storeyId, v);
    return true;
  } catch {
    return false;
  }
}

/**
 * 筛 ⑤ 的判据：这一发像素能不能真的**点**到。
 *
 * 为什么非要有这一条：样例房一层在 `fitStorey(…, 1200, 900, 60)`（2026-09-28 实测 pxPerMm=0.125、
 * origin `(-800, 6600)`）下，`wallProbe` 在没有这条筛时挑中的是 `(0,0) → (-2000,0)` 那一发 ——
 * 毫米完全合法，可 `endPx` 是 `(-150, 825)`、`midPx` 是 `(-25, 825)`，**两发都在画布外**。
 * `sendInputEvent` 的 x/y 是相对内容区的 DIP，负数与越界值不会报错、只会落到没有 canvas 的地方，
 * 于是 `--draw-shot` 表现为"按了没反应"，而抛错点却在十几步之后的一句毫米对账上。
 * 留 2px 边而不是 0：`Math.round` 出来的 0 与 `widthPx` 本身就压在边界像素上，而画布外侧没有像素。
 */
function insideCanvas(v: Viewport, p: Px): boolean {
  return p.x >= 2 && p.y >= 2 && p.x < v.widthPx - 2 && p.y < v.heightPx - 2;
}

/** `sendInputEvent` 只收整数 DIP：先把像素取整，再由像素反算毫米（`handles.ts` 的 `snapPx` 同一条理由）。 */
function intPx(p: Px): Px {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}
