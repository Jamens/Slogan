import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findViolations } from '../../scripts/check-package-deps.mjs';

const roots = [];

function makeTree(specs) {
  const root = mkdtempSync(join(tmpdir(), 'dajia-deps-'));
  roots.push(root);
  for (const [path, body] of Object.entries(specs)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** 违规按 from->to 排序比较：不依赖 PACKAGE_DIRS 的声明顺序 */
const asPairs = (violations) => violations.map((v) => `${v.from}->${v.to}`).sort();

describe('findViolations', () => {
  it('三者互相 import 时全部报出', () => {
    const root = makeTree({
      'packages/scene-2d/src/a.ts': `import { foo } from '@dajia/scene-3d';\nexport const a = foo;\n`,
      'packages/drawing/src/b.ts': `import { foo } from '@dajia/scene-2d';\nexport const b = foo;\n`,
      'packages/core/src/c.ts': `export const foo = 1;\n`,
    });
    const v = findViolations(root);
    expect(v).toHaveLength(2);
    expect(asPairs(v)).toEqual(['drawing->scene-2d', 'scene-2d->scene-3d']);
    expect(v.every((x) => Number.isInteger(x.line) && x.line > 0)).toBe(true);
    expect(v.every((x) => x.file.startsWith('packages/'))).toBe(true);
  });

  it('合规图上零违规，且动态 import 也算', () => {
    const root = makeTree({
      'packages/drawing/src/ok.ts': `import type { Mm } from '@dajia/core';\nexport const x = 1;\n`,
      'packages/scene-3d/src/bad.ts': `const m = await import('@dajia/drawing');\nexport default m;\n`,
    });
    const v = findViolations(root);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ from: 'scene-3d', to: 'drawing' });
  });

  it('apps/desktop 允许依赖全部包', () => {
    const root = makeTree({
      'apps/desktop/src/main/x.ts':
        `import 'dajia-core';\nimport a from '@dajia/core';\nimport b from '@dajia/drawing';\nimport c from '@dajia/scene-2d';\nimport d from '@dajia/scene-3d';\nexport const y = [a, b, c, d];\n`,
    });
    expect(findViolations(root)).toEqual([]);
  });

  it('包内用包名 import 自己不算依赖边，但同目录的真违规照样报', () => {
    // 真实场景：packages/core/test/smoke.test.ts 用 '@dajia/core' 验证别名可用。
    // 若把自引用当成违规，第一道门禁就会拦住自己包的测试，守卫变成噪音。
    // 混进一条真违规是为了区分"忽略自引用"与"根本没扫到文件"。
    const root = makeTree({
      'packages/core/test/a.test.ts': `import { foo } from '@dajia/core';\nexport const a = foo;\n`,
      'packages/drawing/src/b.ts': `import { foo } from '@dajia/drawing';\nexport const b = foo;\n`,
      'packages/drawing/src/c.ts': `import { foo } from '@dajia/scene-2d';\nexport const c = foo;\n`,
    });
    const v = findViolations(root);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ from: 'drawing', to: 'scene-2d' });
  });

  it('未知包名直接抛错，避免漏配规则被当成通过', () => {
    const root = makeTree({ 'packages/mystery/src/a.ts': `export const a = 1;\n` });
    expect(() => findViolations(root)).toThrow(/未知包/);
  });
});
