import {
  wallAxisById,
  type Command,
  type Document,
  type EntityId,
  type StoreyEntity,
  type WallEntity,
} from '@dajia/core';

/**
 * 屏幕右侧那一栏的**只读派生**（Task 8）：属性面板的三格读值、材料下拉框的候选集、
 * 楼层 tab 的列表，以及"输入框里那一发真源收不收"的唯一预言。
 *
 * 为什么不塞进 `editing.ts`：`editing.ts` 管的是**改之前**的判断（要不要发、发给谁、删的时候发几条），
 * 本文件管的是**读出来给人看**与**输入框里的数能不能进**。两者共用的那条纪律
 * （合法性只问真命令试跑）在这里以 `trialCommand` 一个函数收掉，与 `legalWallCreate` / `legalDrop`
 * 是同一形状的第三次出现 —— 出现三次而不抽公共层：三者的入参形状（草稿 / 把手落点 / 属性补丁）
 * 本来就不一样，抽出来只剩一个 `try`。
 */

/** 材料下拉框的一格。`value` 写进真源，`label` 只给屏幕看。 */
export interface MaterialOption {
  readonly value: string;
  readonly label: string;
}

/**
 * 材料候选集。**值在 UI 侧，写法纪律在真源**（core 的 `assertMaterial` 判非空、无首尾空白、≤32 字符；
 * 面板测试逐条问一遍，见 `panel.test.ts`「候选集里每一项都过真源那道写法纪律」）。
 *
 * 为什么候选集不放 core：材料是**图纸上的标注文字**，S1 的真源只把它当字符串存 ——
 * 不进派生、不参与几何（`wall.setMaterial` 不跑 `assertDerivesAfterApply`）。
 * 放进 core 等于假装 core 认识这些材料，而它不认识。
 * 代价：柱 / 板 / 门窗将来要各自再列一张表，不许互相借 —— 借来的是不相干的候选。
 */
export const PANEL_MATERIAL_OPTIONS: readonly MaterialOption[] = [
  { value: 'brick', label: '砖墙' },
  { value: 'concrete', label: '混凝土' },
  { value: 'aerated-concrete', label: '加气混凝土' },
  { value: 'wood', label: '木' },
  { value: 'steel', label: '钢' },
];

/**
 * 面板三格的读值。字段名与真源逐字一致，面板不许自己攒一份状态：
 * 攒了就是第二套口径，改了不写回时屏幕上是对的真源是错的。
 */
export interface WallProps {
  readonly wallId: EntityId;
  readonly thicknessMm: number;
  readonly heightMm: number;
  readonly material: string;
  readonly loadBearing: boolean;
  /**
   * 轴长（毫米，浮点，来自 core 的 `wallAxisById`）。面板显示它只有一个理由：
   * 真源那道守卫判的是 `thicknessMm >= 轴长`，输入框里的 240 合不合法**取决于这面墙有多长**。
   */
  readonly axisLengthMm: number;
}

/**
 * 选中集 → 面板要展示的那面墙。**恰好一面**才给答案，两面以上给 null。
 *
 * 为什么"取第一面"不行：下拉框一改就发命令，"第一面"取决于 `Set` 的插入序（撤销一次就漂），
 * 于是屏幕上会出现"改的是我没选的那面墙"。
 * 别层的、已不存在的、柱 / 板 / 洞口 / 楼层同样给 null —— S1 的面板只认墙（屏幕上点得到的只有墙与洞口，
 * 而洞口的位置由 `openingMove` 那条通路管，柱与板还没有属性面板）。
 */
export function selectedWallForPanel(
  doc: Document,
  storeyId: string,
  ids: Iterable<EntityId>,
): WallEntity | null {
  const picked: WallEntity[] = [];
  for (const id of ids) {
    const entity = doc.get(id);
    if (entity?.kind !== 'wall') continue;
    if (entity.storeyId !== storeyId) continue;
    picked.push(entity);
  }
  return picked.length === 1 ? picked[0]! : null;
}

/** 一面墙 → 面板读值。墙不在文档里给 null（撤销掉正被选中的那一发：面板跟着清空，不抛）。 */
export function wallPropsOf(doc: Document, wallId: EntityId): WallProps | null {
  const wall = doc.get(wallId);
  if (wall?.kind !== 'wall') return null;
  return {
    wallId: wall.id,
    thicknessMm: wall.thicknessMm,
    heightMm: wall.heightMm,
    material: wall.material,
    loadBearing: wall.loadBearing,
    axisLengthMm: wallAxisById(doc, wall.id).lengthMm,
  };
}

/** `trialCommand` 的答案。`reason` 是**真源那句抛错文案**，不是屏幕编的。 */
export interface TrialResult {
  readonly ok: boolean;
  readonly reason: string | null;
}

/**
 * 输入框那一发的预言：把"造命令 + 跑 `build`"整段放进 try，拿真源的文案当答案。
 *
 * ① **吃的是工厂函数，不是 Command 对象**。真源的守卫有两半：一半在命令工厂里
 *   （`assertMm` / `positiveMm` / `assertMaterial`，构造期就抛），一半在 `build` 里
 *   （查实体、查墙厚不小于轴长、跑 Task 7 的派生复核）。传进来的是已造好的 Command，
 *   前者就在 try 外面 —— 输入框打 `240.5` 是一条未捕获异常，屏幕上表现为整个面板崩掉。
 * ② **不重写守卫**。`wall.setThickness` 现在有六道门（整数、正、墙厚 < 轴长、墙存在、
 *   接头直通两墙同厚、整层派生复核）。屏幕侧照抄前两道的版本在 Task 7 那天已经漂过一次
 *   （七条用例改写），不许再抄第三遍。
 * ③ **试跑不碰真源**：`build(doc)` 只算补丁，`Document` 不可变，落地要经 `TransactionLog.dispatch`。
 *   所以没有副本、没有深拷贝，也没有"试跑之后要撤销"的账。
 *
 * 为什么返回文案而不是布尔：面板要把"为什么进不去"给用户看。真源那句
 * 「接头 … 的直通两墙厚度不同（370 / 240），S1 的 T 接与十字要求直通两墙同厚：请统一墙厚，或把它改画成 L 角」
 * 带着数字与下一步，屏幕自编的「墙厚太大」两句都给不了。
 *
 * 面板每次 `revision` 变化重问一遍，不缓存：预言吃的是**当前文档**，用户在输入框改数期间
 * 按了撤销，缓存的那一份就是谎话（`moveDraft` 每次重问 `legalWallCreate` 同一条理由）。
 */
export function trialCommand(doc: Document, makeCommand: () => Command): TrialResult {
  try {
    makeCommand().build(doc);
    return { ok: true, reason: null };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** 楼层 tab 的一格。`label` 给按钮，`index` 是真源那个序号（顺序由它决定）。 */
export interface StoreyTab {
  readonly storeyId: EntityId;
  readonly index: number;
  readonly elevationMm: number;
  readonly heightMm: number;
  readonly label: string;
}

/**
 * 楼层 tab 列表。**按真源的 `index` 升序，不是照抄 `byKind` 的顺序**：
 * `Document.byKind` 按 id 升序返回，而 uuidv7 在同一毫秒内不单调 ⇒ 照抄它，两层项目的 tab
 * 顺序会跨进程漂（`panel.test.ts` 把这件事钉成一个可数的量：十轮打乱、断言"至少五轮 id 序与 index
 * 序不同"；实测六次独立进程跑出的轮数是 9、8、9、8、7、9，下限留 5 是留出实测的抖动余量）。
 * `index` 在同项目内唯一（`storeyCreate` 的构造期守卫），所以这个排序是全序，不必再排第二次。
 *
 * 标高读真源而不是算 `index * heightMm`：样例房二层被 `storeySetElevation` 从 6000 改成 3000，
 * 算出来的 tab 上写的是假数字。
 */
export function storeyTabsOf(doc: Document, projectId: EntityId): StoreyTab[] {
  const storeys: StoreyEntity[] = doc
    .byKind('storey')
    .filter((s) => s.projectId === projectId)
    .sort((a, b) => a.index - b.index);
  return storeys.map((s) => ({
    storeyId: s.id,
    index: s.index,
    elevationMm: s.elevationMm,
    heightMm: s.heightMm,
    label: `第 ${s.index + 1} 层`,
  }));
}
