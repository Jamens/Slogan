import { useEffect, useRef, useState } from 'react';
import {
  wallSetLoadBearing,
  wallSetMaterial,
  wallSetThickness,
  type Command,
  type Document,
  type EntityId,
} from '@dajia/core';
import {
  PANEL_MATERIAL_OPTIONS,
  fitStorey,
  selectedWallForPanel,
  storeyTabsOf,
  trialCommand,
  wallPropsOf,
  type StoreyTab,
  type WallProps,
} from '@dajia/scene-2d';
import { useEditor } from './stores/editorStore';
import { useSelection } from './stores/selectionStore';

/**
 * 楼层 tab 条与右侧属性面板（Task 8）。
 *
 * 这两个组件只有一件事是它们自己的：把真源已经算好的读数**画出来**，以及把用户的一次改动
 * 拼成一条命令发出去。顺序、标签、标高、读值、"这一发收不收"的文案全都住在 `@dajia/scene-2d`
 * 的 `panel.ts` 与 `@dajia/core` 的命令工厂里，这里一份都不许重算 —— 重算就是第二套口径，
 * 而屏幕与真源一旦漂开，屏幕上是对的、真源是错的那种 bug 谁也查不出来。
 */

/**
 * `fitStorey` 的四周留白（CSS px）。
 *
 * 为什么这三格住在面板而不是 `PlanCanvas`：tab 点击那一发要拿**同一个数**复位视口
 * （两处各写一份 60，改一处就变成"点 tab 得到的视图与 resize 得到的视图不一样大"），
 * 而依赖方向只能是 `PlanCanvas` → `panels`（反向 import 成环）。
 */
export const VIEW_PAD_PX = 60;

/** tab 栏高度（CSS px）。`PlanCanvas` 的布局与闸门的原点判据都吃这个数，所以它是导出的口径。 */
export const STOREY_TAB_HEIGHT_PX = 32;

/** 属性面板宽度（CSS px）。同上：画布的 CSS 宽 = 窗口宽 − 它，两处必须报同一个数。 */
export const PROP_PANEL_WIDTH_PX = 260;

/**
 * 面板最近一次预言的账（R1：这是渲染端本地类型，`panel.ts` 导出的 `TrialResult` 只有
 * `{ ok, reason }` 两格，装不下"是哪一格、吃的是哪串字"）。
 * `ok` / `reason` 逐字取自 `trialCommand`，`kind` / `input` 是面板自己那一格的账。
 */
export interface PanelTrialReport {
  readonly kind: 'thickness' | 'material' | 'loadBearing';
  readonly input: string;
  readonly ok: boolean;
  readonly reason: string | null;
}

/**
 * 面板**实际渲染上屏**的读数（R2）。`PlanCanvas` 的 `__dajiaDebug` 是唯一读者。
 *
 * 为什么不由 `PlanCanvas` 拿同一批纯函数再算一遍：那样「`panelProps` 与真源逐字相同」
 * 「三格读数 = 真源」这类判据就成了同义反复 —— 面板画错、画空、画陈旧，报告照样绿。
 * 所以值由面板自己在提交后的 `useEffect`（不写依赖数组，每次提交都跑）里写进来：
 * effect 跑在 commit 之后，写的是屏幕上的那一帧；渲染期赋值不行，`main.tsx` 开着
 * `<StrictMode>`，双跑与被丢弃的并发渲染会把没上屏的值公布出去。
 */
export interface PanelReadout {
  storeyTabs: StoreyTab[];
  panelWallId: EntityId | null;
  panelProps: WallProps | null;
  propsAfterEdit: WallProps | null;
  lastTrial: PanelTrialReport | null;
  /**
   * 「提交通路到过人」的计数器：`onThicknessCommit` 每被调一次（每一发 Enter / blur 事件到达处理函数）就 +1。
   *
   * 为什么这一格**不走**上面那套提交后的 `useEffect`（与 `:64` 那段注释的口径相反，那是故意的）：
   * 它证的正是"事件在**上屏之前**已经到了处理函数"，而 effect 要等下一帧才公布 —— 拿它当到位凭据就
   * 退化成"等屏幕刷完"，分不清"那一发还没到"与"到了但什么都没改"。同族的先例是
   * `PlanCanvas.tsx:476` 那句"快捷键的'到过'计数器"（`hotRef`：不进依赖、不进 state、只给报告读）。
   * 对 StrictMode 的挡法：这里加的是**事件回调里的自增**（一次事件一次调用），不是渲染期赋值 ——
   * `:64` 禁的是后者（双跑/被丢弃的并发渲染会把没上屏的值公布出去），事件回调不在那条路上。
   */
  thicknessCommitAttempts: number;
}

/** 初值 = "面板还没挂过"，不是面板猜的另一份初值。 */
let readout: PanelReadout = {
  storeyTabs: [],
  panelWallId: null,
  panelProps: null,
  propsAfterEdit: null,
  lastTrial: null,
  thicknessCommitAttempts: 0,
};

function publishReadout(patch: Partial<PanelReadout>): void {
  readout = { ...readout, ...patch };
}

export function panelReadout(): PanelReadout {
  return readout;
}

/**
 * 当前层实体是唯一能读出 `projectId` 的把手（`Entity` 联合上它不是共有字段，
 * 必须先收窄成 `kind === 'storey'` —— 2026-09-28 写 `panel.test.ts` 时踩过这条 TS2339）。
 * 收窄不到就返回空 tab 列表：屏幕上"一层都没有"是文档坏了，不是面板该抛错的地方。
 */
function tabsFor(doc: Document, storeyId: string): StoreyTab[] {
  const current = doc.get(storeyId);
  if (current?.kind !== 'storey') return [];
  return storeyTabsOf(doc, current.projectId);
}

const tabBarStyle: React.CSSProperties = {
  height: `${String(STOREY_TAB_HEIGHT_PX)}px`,
  boxSizing: 'border-box',
  flex: '0 0 auto',
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  // 竖直方向一个 padding/border 都不给：`PlanCanvas` 那一格与闸门的原点判据吃的是**整数** 32，
  // 撑成小数就等式不成立（见 desktop-shot 的 origin 那一行）。
  paddingTop: '0',
  paddingBottom: '0',
  borderBottom: '1px solid #d0d0d0',
  background: '#f5f5f5',
  fontFamily: 'system-ui, sans-serif',
  fontSize: '12px',
  overflow: 'hidden',
};

const tabButtonStyle: React.CSSProperties = {
  height: '22px',
  padding: '0 8px',
  fontSize: '12px',
  border: '1px solid #b8b8b8',
  background: '#ffffff',
  cursor: 'pointer',
};

const tabButtonActiveStyle: React.CSSProperties = {
  ...tabButtonStyle,
  border: '1px solid #1a5fb4',
  background: '#e8f0fb',
  fontWeight: 'bold',
};

export interface StoreyTabsProps {
  /**
   * 画布自己的实测尺寸，由 `PlanCanvas` 用它拟合视口那一路用的同一份读数递进来。
   * 面板量不到画布，而 `fitStorey` 吃的正是画布尺寸：在这里读 `window.innerWidth`
   * 就等于"tab 点出来的视口按窗口算、resize 算出来的按画布算"，两套口径必漂。
   */
  widthPx: number;
  heightPx: number;
}

export function StoreyTabs({ widthPx, heightPx }: StoreyTabsProps): React.JSX.Element {
  const log = useEditor((s) => s.log);
  const storeyId = useEditor((s) => s.storeyId);
  const setStorey = useEditor((s) => s.setStorey);
  const tabs = tabsFor(log.document, storeyId);

  useEffect(() => {
    publishReadout({ storeyTabs: tabs });
  });

  const onTab = (tab: StoreyTab): void => {
    // 视口与层必须是同一次 `set`（P10），且视口按**画布**尺寸拟合。
    const fitted = fitStorey(log.document, tab.storeyId, widthPx, heightPx, VIEW_PAD_PX);
    setStorey(tab.storeyId, fitted);
    useSelection.getState().clear();
  };

  return (
    <div data-dajia="storey-tabs" style={tabBarStyle}>
      {tabs.map((tab) => (
        <button
          key={tab.storeyId}
          type="button"
          data-dajia="storey-tab"
          data-storey-id={tab.storeyId}
          data-current={tab.storeyId === storeyId ? '1' : '0'}
          style={tab.storeyId === storeyId ? tabButtonActiveStyle : tabButtonStyle}
          onClick={() => {
            onTab(tab);
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  width: `${String(PROP_PANEL_WIDTH_PX)}px`,
  boxSizing: 'border-box',
  flex: '0 0 auto',
  padding: '8px',
  fontFamily: 'system-ui, sans-serif',
  fontSize: '12px',
  borderLeft: '1px solid #d0d0d0',
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '6px',
};

/** 正在输入的那串字（P11 唯一允许的本地态）。跟着墙 id 存：换一面墙不许把上一面的字带过去。 */
interface Typing {
  readonly wallId: EntityId;
  readonly text: string;
}

export function PropPanel(): React.JSX.Element {
  const log = useEditor((s) => s.log);
  const storeyId = useEditor((s) => s.storeyId);
  const revision = useEditor((s) => s.revision);
  const dispatch = useEditor((s) => s.dispatch);
  const ids = useSelection((s) => s.ids);

  const doc = log.document;
  const wall = selectedWallForPanel(doc, storeyId, ids);
  const wallId = wall?.id ?? null;
  const props = wallId === null ? null : wallPropsOf(doc, wallId);

  const [typing, setTyping] = useState<Typing | null>(null);
  const [trial, setTrial] = useState<PanelTrialReport | null>(null);
  /** 成功提交那一发的标记：下一帧（真源已经落地）把当时的 `wallPropsOf` 读数钉成 `propsAfterEdit`。 */
  const afterCommitRef = useRef<boolean>(false);

  // 不写依赖数组：每次提交都跑，公布的就是这一帧真画出来的东西。
  useEffect(() => {
    const patch: Partial<PanelReadout> = {
      panelWallId: wallId,
      panelProps: props,
      lastTrial: trial,
    };
    if (afterCommitRef.current) {
      afterCommitRef.current = false;
      // 这一格是"面板读真源"的凭据：填的是**这一帧从 `wallPropsOf` 拿到的值**，
      // 不是输入框里那串字 —— 输入框成功之后已经被清掉了。
      patch.propsAfterEdit = props;
    }
    publishReadout(patch);
  });

  // P11 的代价：换一面墙 = 换一块面板，正在打的字与那行红字一起作废。
  useEffect(() => {
    setTyping(null);
    setTrial(null);
  }, [wallId]);

  // 真源一变（提交成功、撤销/重做、别处改了同一面墙）正在打的那串字就作废：
  // 留着它 = 屏幕上输入框写着 240.5、真源是 300，判据分不清"没提交"与"提交失败了"。
  // `trial` 不在这里丢 —— 它是"最近一次预言"的账，`--prop-shot` 第 5 步在提交成功之后仍要读它。
  useEffect(() => {
    setTyping(null);
  }, [revision]);

  /**
   * 现问一次真源并把答案记进账上（那行红字与 `lastTrial` 读的都是它）。
   * 吃的是工厂函数而不是已造好的命令：真源的守卫有两半，一半在工厂构造期（`assertMm` /
   * `positiveMm` / `assertMaterial`），它在 `trialCommand` 的 `try` 外面 —— 已造好的命令传进来就漏掉了那一半。
   */
  const predict = (kind: PanelTrialReport['kind'], input: string, make: () => Command): PanelTrialReport => {
    const answer = trialCommand(doc, make);
    const report: PanelTrialReport = { kind, input, ok: answer.ok, reason: answer.reason };
    setTrial(report);
    return report;
  };

  /** 落地并记账：成功 ⇒ 正在打的那串字作废、下一帧把当时的真源读数钉成 `propsAfterEdit`；失败 ⇒ 字留着（屏幕不撒谎，真源也没动）。 */
  const submit = (cmd: Command): void => {
    dispatch(cmd);
    if (useEditor.getState().lastError === null) {
      afterCommitRef.current = true;
      setTyping(null);
    }
  };

  const onThicknessText = (text: string): void => {
    if (wallId === null) return;
    setTyping({ wallId, text });
    // `Number(text)` 的**拒收产地**不在这里：非法值由 core 构造期守卫（`assertMm` / `positiveMm`）判，
    // 经 `predict`→`trialCommand` 现问一次真源（输入框那行红字读的就是它），闸门 P8 钉屏幕侧不发
    // （`desktop-shot.mjs:234-237`）。这与"浮点先过 `quantizeMm` 或被拒"是同一套口径，不是第二套。
    predict('thickness', text, () => wallSetThickness({ wallId, thicknessMm: Number(text) }));
  };

  /**
   * P11：提交只发生在 Enter 与 blur（两个调用点都在输入框上）。逐字符提交会往撤销栈上留三条记录
   * （打 `370` 要按三下 Ctrl+Z），而且每一发都跑一遍整层派生复核。
   *
   * P12：三格都是"要写的值 == 真源刚读出来的值 ⇒ 一行都不发"。
   * **这与真源口径故意不同**：core 允许同值重设并各留一条撤销记录（`panel.test.ts` 钉着），
   * 屏幕上不挡就等于把"改了什么"的账交给撤销栈去背，而 `--prop-shot` 的 depth 判据立刻分不清
   * "改过"与"摸过"。代价：将来若 core 自己挡同值，这三处判断要跟着删，不许留成第二道守卫。
   */
  const onThicknessCommit = (): void => {
    // 到位凭据（`--prop-shot` 第 6 步的条件等待读这一格）：放在守卫**之前**，因为
    // `typing === null`（或没选中墙）时 Enter 也算"到了但什么都不做"，计数照样 +1 ⇒
    // 第 6 步的 `waitUntil` 只等"到没过"这一半，不等"改了什么"（改没改是 P10 那条判据的事）。
    // 直接读模块级 `readout` 再 +1：这是事件回调里的自增，一次事件一次调用，不进 React state、不等下一帧。
    publishReadout({ thicknessCommitAttempts: readout.thicknessCommitAttempts + 1 });
    if (wallId === null || props === null || typing === null || typing.wallId !== wallId) return;
    // 这句 `Number(typing.text)` 与上面 `onThicknessText` 同一口径：拒收产地仍是 core 构造期守卫
    // （`assertMm` / `positiveMm`，经下面 `predict` 的 `trialCommand` 现问）＋闸门 P8
    // （`desktop-shot.mjs:234-237`），面板不在自己家里另立第二套判断。
    const value = Number(typing.text);
    if (value === props.thicknessMm) {
      setTyping(null);
      return;
    }
    const report = predict('thickness', typing.text, () => wallSetThickness({ wallId, thicknessMm: value }));
    // 真源说不收 ⇒ 屏幕上留着那串字与它的原话，真源一个字不写。这一问同时挡住了构造期那半道门：
    // `ok` 为真说明同一对入参刚刚造过一次命令没抛，下面那发造得出命令 —— 面板里不许有裸抛的调用点。
    if (report.ok) submit(wallSetThickness({ wallId, thicknessMm: value }));
  };

  const onMaterialChange = (value: string): void => {
    if (wallId === null || props === null || value === props.material) return;
    const report = predict('material', value, () => wallSetMaterial({ wallId, material: value }));
    if (report.ok) submit(wallSetMaterial({ wallId, material: value }));
  };

  const onLoadBearingChange = (next: boolean): void => {
    if (wallId === null || props === null || next === props.loadBearing) return;
    const report = predict('loadBearing', String(next), () => wallSetLoadBearing({ wallId, loadBearing: next }));
    if (report.ok) submit(wallSetLoadBearing({ wallId, loadBearing: next }));
  };

  // 没有可展示的墙 ⇒ 外壳照旧渲染（260px 那一格是画布尺寸口径的一部分，不能时有时无），
  // 里面一个字都不放：`panelWallId` 与 `panelProps` 由 effect 报 null。
  return (
    <div data-dajia="prop-panel" style={panelStyle}>
      {props === null ? <span data-dajia="no-wall">未选中墙</span> : null}
      {props === null ? null : (
        <>
          <div data-dajia="wall-id" style={{ fontWeight: 'bold' }}>
            {props.wallId}
          </div>
          <div style={rowStyle}>
            <span>厚度（mm）</span>
            <input
              data-dajia="thickness-input"
              type="text"
              size={8}
              value={typing !== null && typing.wallId === props.wallId ? typing.text : String(props.thicknessMm)}
              onChange={(event) => {
                onThicknessText(event.target.value);
              }}
              onKeyDown={(event) => {
                // 这两个键在输入框里是**改字**，不是删构件：不拦住的话，窗口的快捷键监听器
                // 会在用户编辑厚度时把正选中的那面墙删掉（改属性改到拆房子）。
                if (event.key === 'Backspace' || event.key === 'Delete') {
                  event.stopPropagation();
                  return;
                }
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onThicknessCommit();
                }
              }}
              onBlur={() => {
                onThicknessCommit();
              }}
            />
          </div>
          <div style={rowStyle}>
            <span>层高（mm）</span>
            <span data-dajia="height-mm">{String(props.heightMm)}</span>
          </div>
          <div style={rowStyle}>
            <span>材料</span>
            {/* 受控：值来自真源。被拒那一发不落地时 React 把它拨回真源那一个，屏幕上不留下"选了但没改"的假状态。 */}
            <select
              data-dajia="material-select"
              value={props.material}
              onChange={(event) => {
                onMaterialChange(event.target.value);
              }}
            >
              {PANEL_MATERIAL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div style={rowStyle}>
            <span>承重</span>
            <input
              data-dajia="load-bearing"
              type="checkbox"
              checked={props.loadBearing}
              onChange={(event) => {
                onLoadBearingChange(event.target.checked);
              }}
            />
          </div>
          <div style={rowStyle}>
            <span>轴长（mm）</span>
            <span data-dajia="axis-length-mm">{String(props.axisLengthMm)}</span>
          </div>
          {trial !== null && trial.ok === false ? (
            <div data-dajia="trial-reason" style={{ color: '#a01010', wordBreak: 'break-all' }}>
              {trial.reason}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
