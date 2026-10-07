import { useEffect, useState } from 'react';
import { useProject, type ProjectBannerTone } from './stores/projectStore';

/**
 * 存盘状态横幅（`computeBanner` 的唯一读者）。
 *
 * ## 它为什么不改布局 —— 这是本文件唯一的设计约束
 *
 * 画布原点被五道真窗口闸门**逐字**钉着（`desktop-shot.mjs` 里`canvasOriginPx.y === 32`，
 * 32 = 楼层 tab 栏高）。横幅若作为**占位行**插在 tab 栏之上，画布原点会变成 `32 + 条高`，
 * 五道闸门当场全红 —— 而那五个数字是"布局没偷偷漂移"的牙齿，改它等于放弃这道防线。
 *
 * 所以本组件**只做浮层**：根元素 `position: absolute`，挂在
 * `PlanCanvas` 的`canvasCellRef` 格内（那格是 `position: relative`）。
 * 不进 flex 流 ⇒ 格子尺寸不变 ⇒ `fit()` 量到的读数不变 ⇒ 原点必然仍是 32。
 * `packaging.test.ts` 那一族之外，本文件另有一条源码判据钉住"必须是 absolute"。
 *
 * ## 代价（明写，不藏）
 *
 * 浮层会**盖住画布顶部一小块**。只在两种情况下出现横幅：会话生命周期切换，
 * 或异常（`failed` /锁丢了）。灰色常态（"已保存到第 N 发"）给`pointer-events: none`
 * 且半透明 —— 鼠标能穿透过去继续画图，不打扰。
 *
 * ## 为什么横幅文案一个字都不在这里写
 *
 * `computeBanner`（`projectStore.ts`）是文案的**唯一产地**，八级优先级已经由
 * `project-store.test.ts` 11 格判死。本文件只做三件事：选色、摆位置、给按钮接线。
 * 在这里"顺手润色"一句文案，就是第二份口径 —— 而屏幕上那句话与判据里那句一旦漂开，
 * 红起来读不出是谁错的（同 D2那条"屏幕与真源各说一套"）。
 */

/** 三色对应 `computeBanner` 的三个 `tone`。**只做映射，不改语义** —— 文案是它产的。 */
const TONE_STYLE: Record<ProjectBannerTone, { readonly bg: string; readonly fg: string; readonly border: string }> = {
  // 红：这一屏没存上／ 这一屏压根没打开成。屏幕上任何东西都不许盖过它。
  red: { bg: '#fdecec', fg: '#8a1f1f', border: '#d97373' },
  // 琥珀：能继续干，但有件事要人知道（只读打开 / 恢复了什么 / 盘上留着现场）。
  amber: { bg: '#fdf5e3', fg: '#7a5312', border: '#d9b25c' },
  // 灰：常态（已保存到第 N 发）。**半透明 + 鼠标穿透** —— 不打扰画图（见文件头"代价"）。
  grey: { bg: 'rgba(245,245,245,0.86)', fg: '#3a3a3a', border: '#c8c8c8' },
};

const barStyle: React.CSSProperties = {
  // 浮层，不占位—— 见文件头"它为什么不改布局"。
  position: 'absolute',
  left: '0',
  top: '0',
  right: '0',
  zIndex: 10,
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '4px 8px',
  fontFamily: 'system-ui, sans-serif',
  fontSize: '12px',
  borderBottom: '1px solid',
  boxSizing: 'border-box',
};

const buttonStyle: React.CSSProperties = {
  flex: '0 0 auto',
  fontSize: '12px',
  padding: '1px 6px',
  cursor: 'pointer',
  border: '1px solid currentColor',
  background: 'transparent',
  color: 'inherit',
};

export function SaveStatusBar(): React.JSX.Element | null {
  // 订阅两格：`banner`（要显示什么）与两个动作（重接 / 收尾）。
  // **不订阅整个 store** —— 那会让每一发`submitJournal` 都重渲这一条。
  const banner = useProject((s) => s.banner);
  const reopenAsEdit = useProject((s) => s.reopenAsEdit);
  const closeSession = useProject((s) => s.closeSession);
  const [busy, setBusy] = useState(false);

  // 公布上屏那一帧的读数（给 `__dajiaDebug` 读，理由见文件头"诊断读数"）。
  // **不写依赖数组**：每次提交都跑，公布的就是这一帧真画出来的东西。
  useEffect(() => {
    publishReadout({
      text: banner === null ? null : banner.text,
      tone: banner === null ? null : banner.tone,
      closable: banner !== null && banner.closable,
      reopenable: banner !== null && banner.reopenable,
    });
  });

  // 两个动作都要等 main 回来，所以给一个"正在处理"的闸：连点会连着发两次 `closeSession`
  // （第二次 `opened` 已经是 null，函数自己会 return，但用户会看到两次抖动）。
  // 换一帧就清：横幅内容变了（新一句话）说明上一轮已经结束。
  useEffect(() => {
    setBusy(false);
  }, [banner?.tone, banner?.text]);

  // `computeBanner` 在 `phase === 'off'` 时回 `null`（⑧段那一屏）——
  // **那一屏不许有任何横幅**：没打开工程时"已保存到第 0 发"是一句关于用户工程的谎话。
  if (banner === null) return null;

  const tone = TONE_STYLE[banner.tone];
  const run = (action: () => Promise<void>): void => {
    if (busy) return;
    setBusy(true);
    void action().catch(() => {
      // 动作自己会把失败写进 `failure`（进而变成横幅），这里不重复报 ——
      // 同一个错误说两遍，屏幕上就会出现两句矛盾的话。
    });
  };

  return (
    <div
      data-dajia="save-status-bar"
      data-tone={banner.tone}
      // 灰色常态不拦鼠标（见文件头"代价"）；红/琥珀要拦，否则点不到条上的按钮。
      style={{
        ...barStyle,
        background: tone.bg,
        color: tone.fg,
        borderColor: tone.border,
        pointerEvents: banner.tone === 'grey' ? 'none' : 'auto',
      }}
    >
      <span data-dajia="save-status-text" style={{ flex: '1 1 auto', minWidth: 0, wordBreak: 'break-all' }}>
        {banner.text}
      </span>
      {banner.reopenable ? (
        <button
          data-dajia="save-reopen"
          type="button"
          style={buttonStyle}
          disabled={busy}
          onClick={() => {
            run(reopenAsEdit);
          }}
        >
          重新接管
        </button>
      ) : null}
      {banner.closable ? (
        <button
          data-dajia="save-close"
          type="button"
          style={buttonStyle}
          disabled={busy}
          onClick={() => {
            run(async () => {
              await closeSession('graceful');
            });
          }}
        >
          收尾并关闭
        </button>
      ) : null}
    </div>
  );
}

/**
 * 诊断读数：横幅上屏的那一帧显示了什么。
 *
 * **为什么需要它**：本仓的测试跑在 **node 档**（根 `vitest.config.ts` 没有 jsdom），
 * 所以 React 组件**渲染不出来** —— 屏幕上有没有那一条，判据读不到。
 * 于是值由组件自己（`useEffect`，跑在 commit 之后，也就是"真的上屏了"那一帧）
 * 写进模块级账，`__dajiaDebug` 读它。
 *
 * 为什么不是渲染期赋值：`<StrictMode>` 双跑 + 被丢弃的并发渲染会把**没上屏**的值公布出去
 * （同 `panels.tsx` 的 `PanelReadout` 那条纪律，理由逐字相同）。
 *
 * `null` 是初值，含义是"这条横幅还没上过屏" —— 不是"横幅文案为空"。
 */
export interface SaveBarReadout {
  /** 上屏的横幅文案；`null` = 屏幕上没有横幅。 */
  readonly text: string | null;
  readonly tone: ProjectBannerTone | null;
  /** 按钮形状。**与文案同一处决定**（`computeBanner`），这里只透出来给判据读。 */
  readonly closable: boolean;
  readonly reopenable: boolean;
}

let readout: SaveBarReadout = { text: null, tone: null, closable: false, reopenable: false };

function publishReadout(patch: Partial<SaveBarReadout>): void {
  readout = { ...readout, ...patch };
}

export function saveBarReadout(): SaveBarReadout {
  return readout;
}
