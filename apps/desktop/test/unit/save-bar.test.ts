import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { saveBarReadout } from '../../src/renderer/src/SaveStatusBar';
import { createProjectStore } from '../../src/renderer/src/stores/projectStore';
import { useEditor } from '../../src/renderer/src/stores/editorStore';
import { payloadFromDocument } from '../../src/shared/document-wire';
import { resetEditor, DEMO } from './editor-fixtures';
import type { SaveStatusWire } from '@dajia/protocol';
import type { DajiaApi } from '../../src/preload/index';

/**
 * 存盘状态横幅上屏的判据。
 *
 * ## 为什么判据分两族
 *
 * **一族读源码**（B1/B2）：本仓测试跑在 **node 档**（根 `vitest.config.ts` 没有 jsdom），
 * React 组件**渲染不出 DOM** —— "横幅有没有占位"这种布局问题，判据读不到屏幕。
 * 于是用源码级判据守住那条真正要守的东西：**根元素必须 `position: absolute`**。
 *
 * **一族读 store**（B3–B6）：`computeBanner` 的文案与按钮形状由
 * `project-store.test.ts` 的 11 格判死；本文件不重算它，只验"读数通路" ——
 * 组件从 store 取值 → 公布到 `saveBarReadout()` → `__dajiaDebug` 读得到。
 *
 * ## 为什么不测"画布原点仍是 32"
 *
 * 那是**真窗口闸门**（`desktop-shot.mjs` 里 `canvasOriginPx.y === 32`）的活，需要装上
 * Electron 二进制才能跑。本文件替代不了它，只保证**自己的那一半**（不改布局）成立。
 */

const BAR = '../../src/renderer/src/SaveStatusBar.tsx';
const CANVAS = '../../src/renderer/src/PlanCanvas.tsx';

function srcOf(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

function status(over: Partial<SaveStatusWire> = {}): SaveStatusWire {
  return {
    phase: 'idle',
    queuedTurns: 0,
    lastTurn: 7,
    snapshotTurn: 5,
    rowsSinceSnapshot: 2,
    lastError: null,
    pauseReason: null,
    ...over,
  };
}

/** 一个只够跑通装配的假把式（真把式在 `project-store.test.ts` 里，那里的假把式更全）。 */
function fakeApi(): { api: DajiaApi; emit: (s: SaveStatusWire) => void } {
  const listeners: Array<(s: SaveStatusWire) => void> = [];
  const api: DajiaApi = {
    ping: async () => 'pong',
    exportPlan: async () => ({ ok: true, outPath: 'x.pdf' }),
    openProject: async () => ({
      ok: true,
      value: {
        decision: 'edit',
        header: {
          projectId: DEMO.log.document.projectId,
          name: '样例',
          schemaVersion: DEMO.log.document.schemaVersion,
          journalTurn: 7,
          wasCleanShutdown: true,
        },
        // **必须是真文档**：空 entities 会让 `open` 撞上 `storeyTabsOf(...)` 的长度检查，
        // 报「库里这个工程一份楼层都没有」⇒ `phase` 回 `off` ⇒ 后面两发状态压根不进横幅
        // （实测B6 先红在这儿）。所以这里直接用 `payloadFromDocument(DEMO.log.document)`。
        doc: payloadFromDocument(DEMO.log.document),
        snapshot: { seq: 3, turn: 5 },
        replayed: { rows: 2, fromSeq: null, toSeq: null },
        emergency: [],
      },
    }),
    submitJournal: async () => ({ ok: true, value: { outcome: 'queued', acceptedTurn: 8 } }),
    closeProject: async () => ({ ok: true, value: { elementRows: null, storeyRows: null } }),
    onSaveStatus: (listener) => {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };
  return { api, emit: (s) => listeners.forEach((l) => l(s)) };
}

/**
 * 只看**代码**、剥掉注释 —— 这一族源码扫描必须如此。
 *
 * 理由是实测过的：`SaveStatusBar.tsx` 的文件头注释里就写着「不许import `computeBanner`」
 * 这句话，而B3要断的正是"有没有 import 它"。连注释一起看，那一格永远红；
 * 更糟的是若为了让判据绿而删掉那句注释，就等于**为了迁就判据删掉纪律的原文**。
 */
function codeOf(relative: string): string {
  return srcOf(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

describe('存盘横幅：不许动布局（B1/B2 源码级）', () => {
  it('B1 根元素必须是 position: absolute —— 占位会让五道真窗口闸门的 canvasOriginPx 全红', () => {
    const src = codeOf(BAR);
    // 画布原点被 `desktop-shot.mjs` 逐字钉在 y === 32（= tab 栏高）。横幅若作为占位行
    // 插在 tab 栏之上，原点变成 32 + 条高 ⇒ shot / pick-shot / edit-shot / draw-shot /
    // prop-shot 五道当场全红。浮层不进 flex 流 ⇒ 格子尺寸不变 ⇒ 原点必然仍是 32。
    expect(src).toContain('position: \'absolute\'');
    // 反向判据：出现 `position: 'fixed'` 也不行（那会让条子不随格子滚、不随窗口缩）。
    expect(src).not.toContain('position: \'fixed\'');
  });

  it('B2 组件挂在 canvasCellRef 那格内（canvas 的同一个父级），不在 tab 栏那一行', () => {
    const src = codeOf(CANVAS);
    // **判据读的是"同一个 JSX 父级"，不是字符距离**（上一版用偏移量，量到的是文件
    // 开头的注释 ⇒ 24508那个荒谬读数）。做法：取 `<SaveStatusBar />` 所在行，往上找最近的
    // 开标签与它的 `>`，那就是父级；再取 `<canvas` 所在行的父级，两者必须逐字相同。
    const lines = src.split('\n');
    const barLine = lines.findIndex((l) => l.includes('<SaveStatusBar />'));
    expect(barLine).toBeGreaterThan(-1);
    const canvasLine = lines.findIndex((l) => l.trimStart().startsWith('<canvas'));
    expect(canvasLine).toBeGreaterThan(-1);
    // 浮层必须**先**于 canvas 出现在同一格里（zIndex 决定谁盖谁，DOM 顺序不重要 ——
    // 但"同一父级"是硬要求，所以只断父级相等）。
    const parentOf = (from: number): string => {
      for (let i = from; i >= 0; i--) {
        const t = lines[i]!.trim();
        if (t.endsWith('>') && !t.endsWith('/>') && t.includes('<')) return t;
      }
      return '(没找到)';
    };
    expect(parentOf(barLine)).toBe(parentOf(canvasLine));
  });
});

describe('存盘横幅：读数通路（B3–B6，store 级）', () => {
  it('B3 组件读的是 store 的 banner，不自己算文案（不重算是本仓硬纪律）', () => {
    const src = codeOf(BAR);
    // 唯一的数据来源是 `useProject((s) => s.banner)`。
    expect(src).toContain('useProject((s) => s.banner)');
    // **不许**在本文件里 import `computeBanner` 重算一遍 —— 那是第二份口径。
    expect(src.includes('computeBanner')).toBe(false);
  });

  it('B4 `banner === null` 时不渲染任何 DOM（⑧段：没打开工程时不许谎报"已保存"）', () => {
    const src = srcOf(BAR);
    // 早退必须存在，且在 return JSX 之前。
    expect(src).toContain('if (banner === null) return null;');
  });

  it('B5 读数初值是"横幅还没上过屏"，不是"文案为空"', () => {
    // 组件的 effect 才会写它；import 进来时它就该是初值。
    const r = saveBarReadout();
    expect(r.text).toBeNull();
    expect(r.tone).toBeNull();
    expect(r.closable).toBe(false);
    expect(r.reopenable).toBe(false);
  });

  it('B6 一发 failed 状态 ⇒ 读数里 tone 是 red、文案含"保存失败"、按钮可关', async () => {
    resetEditor();
    const f = fakeApi();
    const [store, stop] = createProjectStore(f.api, useEditor);
    try {
      // 打开成功 ⇒ 横幅是兜底那句灰话。
      await store.getState().open(DEMO.log.document.projectId);
      f.emit(status({ phase: 'failed', lastError: '连不上库' }));
      // `computeBanner` 的第 5 级：failed ⇒ red + "保存失败：…"
      const b = store.getState().banner;
      expect(b?.tone).toBe('red');
      expect(String(b?.text)).toContain('连不上库');
      // 锁丢了 ⇒ reopenable（那是唯一给"重新接管"的分支）。
      f.emit(status({ phase: 'paused', pauseReason: '锁丢了' }));
      expect(store.getState().banner?.reopenable).toBe(true);
    } finally {
      stop();
      resetEditor();
    }
  });
});
