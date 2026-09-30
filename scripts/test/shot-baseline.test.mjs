// 终审 B2 P1-4：`scripts/desktop-shot.mjs` 里写死的闸门字面量（指令表 31/20/10/1、原点 y=32、
// 判据条数表）与结构账（scene-2d 现算、panels.tsx 常量、main 的抄数）在 `pnpm verify` 侧的对账。
// desktop-shot.mjs 本体由裸 `node` 跑、进不了 verify（vitest include 不含它），它的字面量今天零凭据：
// "结构改了而闸门字面量没改"只有人手跑 `pnpm shot` 才知道。本文件把这笔账接进 verify。
// 抠法一律是"具名判据行的正则 + 恰好命中 N 次"：命中 0 = 判据被删，命中 >1 = 抠错，两种都抛。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildDrawList, demoHouse, EMPTY_SELECTION, fitStorey } from '@dajia/scene-2d';

const root = new URL('../../', import.meta.url);
const shot = readFileSync(new URL('scripts/desktop-shot.mjs', root), 'utf8');
const mainIndex = readFileSync(new URL('apps/desktop/src/main/index.ts', root), 'utf8');
const panels = readFileSync(new URL('apps/desktop/src/renderer/src/panels.tsx', root), 'utf8');
const editing = readFileSync(new URL('packages/scene-2d/src/editing.ts', root), 'utf8');

/** 从文本里按正则抠数：命中次数必须恰好 `want` 次，否则抛（不兜底、不默认）。 */
function grabAll(text, re, want, label) {
  const hits = [...text.matchAll(re)];
  if (hits.length !== want) {
    throw new Error(`${label}：正则命中 ${String(hits.length)} 次，应有 ${String(want)} 次（判据被删或抠错）`);
  }
  return hits.map((h) => Number(h[1]));
}

describe('闸门字面量 ↔ 结构账', () => {
  it('desktop-shot 基座四条的写死数 == buildDrawList(demoHouse 一层, fitStorey(1200×900, 60)) 现算', () => {
    const house = demoHouse();
    const view = fitStorey(house.doc, house.lowerStoreyId, 1200, 900, 60);
    const ops = buildDrawList(house.doc, house.lowerStoreyId, view, EMPTY_SELECTION);
    const layers = {};
    for (const o of ops) layers[o.pen.layer] = (layers[o.pen.layer] ?? 0) + 1;
    // 逐字相等：脚本里写死的数与结构账现算的那一份必须一字不差
    expect(grabAll(shot, /report\.ops === (\d+)/g, 1, 'report.ops')[0]).toBe(ops.length);
    expect(grabAll(shot, /layers\.structure === (\d+)/g, 1, 'layers.structure')[0]).toBe(layers.structure);
    expect(grabAll(shot, /layers\.opening === (\d+)/g, 1, 'layers.opening')[0]).toBe(layers.opening);
    expect(grabAll(shot, /layers\.annotation === (\d+)/g, 1, 'layers.annotation')[0]).toBe(layers.annotation);
  });

  it('runner 两处画布原点 y=32（pick :106 / prop :218 同型）== panels.tsx 的 STOREY_TAB_HEIGHT_PX', () => {
    const ys = grabAll(shot, /canvasOriginPx\?\.y === (\d+)/g, 2, '画布原点 y 断言（pick 与 prop 各一处）');
    const tabHeight = grabAll(panels, /STOREY_TAB_HEIGHT_PX\s*=\s*(\d+)/g, 1, 'STOREY_TAB_HEIGHT_PX')[0];
    for (const y of ys) expect(y).toBe(tabHeight);
  });

  it('main 抄的 STAR_EDGE_MM ≥ scene-2d 真源 MIN_WALL_LENGTH_MM × 1.2（四成余量那笔账）', () => {
    const star = grabAll(mainIndex, /const STAR_EDGE_MM = (\d+)/g, 1, 'STAR_EDGE_MM')[0];
    const min = grabAll(editing, /MIN_WALL_LENGTH_MM = (\d+)/g, 1, 'MIN_WALL_LENGTH_MM')[0];
    expect(star).toBeGreaterThanOrEqual(min * 1.2);
  });
});

describe('判据条数硬闸的账进 verify', () => {
  // 条数账（终审 B2 P1-4 订正版）：`^ {6}\[` 的行数**不等于**五数之和——五个模式各复用
  // 基座那六条（基座是 `checks = [` 数组字面量，行首 4 空格；各模式专属判据行首 6 空格）。
  // 所以逐模式钉：expectedChecksByMode[m] == 基座行数 + 该模式 push 块内的判据行数。
  // 实测（终审第三棒）：基座 6；pick 5 / edit 16 / draw 22 / prop 24 ⇒ 表 6/11/22/28/30。
  const base = grabAll(shot, /^ {4}\[/gm, 6, '基座判据（checks 数组字面量）').length;
  const tableHits = [...shot.matchAll(/expectedChecksByMode = \{([^}]+)\}/g)];
  if (tableHits.length !== 1) {
    throw new Error(`expectedChecksByMode 表命中 ${String(tableHits.length)} 次，应有 1 次`);
  }
  const expected = {};
  for (const m of tableHits[0][1].matchAll(/(\w+): (\d+)/g)) expected[m[1]] = Number(m[2]);
  for (const mode of ['shot', 'pick', 'edit', 'draw', 'prop']) {
    if (!(mode in expected)) throw new Error(`expectedChecksByMode 表里没有 ${mode}`);
  }
  it('表里的 shot 条数 == 基座行数（专属块之外一个不多一个不少）', () => {
    expect(expected.shot).toBe(base);
  });
  for (const [mode, flag] of [
    ['pick', 'wantPick'],
    ['edit', 'wantEdit'],
    ['draw', 'wantDraw'],
    ['prop', 'wantProp'],
  ]) {
    it(`表里的 ${mode} 条数 == 基座 + if (${flag}) 块内判据行数`, () => {
      const block = shot.match(new RegExp(`if \\(${flag}\\) \\{([\\s\\S]*?)\\n  \\}`));
      if (block === null) throw new Error(`${flag} 块没切出来（结构变了，抠法要跟着改）`);
      const own = (block[1].match(/^ {6}\[/gm) ?? []).length;
      expect(expected[mode]).toBe(base + own);
    });
  }
});
