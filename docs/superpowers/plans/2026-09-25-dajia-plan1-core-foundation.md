# 搭家 S1 · 计划 1：内核地基 Implementation Plan

> **For agent workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立搭家的 pnpm workspace 骨架与 `@dajia/core` 文档模型 —— 整数毫米真源、UUIDv7 标识、补丁式事务日志与撤销/重做，并用属性测试证明"撤销后状态逐字节还原"。

**Architecture:** 单一真源的内存文档模型（不可变 `Document` + `Patch` + `TransactionLog`），所有变更经命令构造器产出补丁，撤销即应用逆补丁。本计划**不含任何几何算法**（墙轮廓、接头、吸附在计划 2），也不含 UI 交互（计划 3）。Electron 壳在本计划末尾只做"能构建、能双向通信"的最小接线。

**Tech Stack:** Node 24.14、pnpm 11.18、TypeScript、Vitest、fast-check 4、Electron + electron-vite + React 19。

2026-09-25 用 `npm view <pkg> version` 实测到的 `latest`：`typescript@7.0.2`、`vitest@5.0.2`、`fast-check@4.10.2`、`electron@44.4.5`、`electron-vite@5.0.0`、`electron-builder@26.15.3`、`react@19.3.0`、`zustand@5.0.15`、`mysql2@3.24.4`。安装命令一律不带版本号（取 `latest`），装完把**精确解析结果**写进执行日志并随 `pnpm-lock.yaml` 一起提交 —— 锁文件是唯一事实，这张表只是让人看出漂移。

**Spec:** `docs/superpowers/specs/2026-09-25-dajia-s1-design.md` —— 本计划实现其 **M1.0 全部** 与 **M1.1 的前半**（实体模型、command 层与撤销、`quantize`）。轴线→轮廓与接头派生、AABB 索引、几何不变式属计划 2。

## 计划系列（S1 共 6 份）

| # | 名称 | 覆盖 | 独立可交付 |
|---|---|---|---|
| **1（本文档）** | 内核地基 | M1.0 + M1.1 前半 | `pnpm verify` 全绿；文档模型可撤销重做并经属性测试 |
| 2 | 几何与不变式 | M1.1 后半 | 墙轮廓、L/T/十字接头、洞口夹取、AABB 索引、几何属性测试 |
| 3 | 画得出 | M1.2 + M1.6 | 交互画出一栋两层房 + 3D 只读拉伸 + 选中双向同步 |
| 4 | 存得下 | M1.3 | MySQL 迁移/repository/连接向导/工程锁/崩溃恢复，真库集成测试 |
| 5 | 出得了图 | M1.4 + M1.5 | 一页 A3 1:100 平面图矢量 PDF，含三道尺寸线与图框 |
| 6 | 补完 | M1.7 + M1.8 | 3D 拖整层、描图底图两点定标、端到端金路径与 S1 验收 |

**为什么不在现在把 2–6 写全**：计划 2 之后每个任务的接口都依赖前一层的真实签名（例如接头的输出形状决定吸附能拿到什么候选点）。现在写只会得到看着整齐、落地必改的假代码。每份计划在其开工前写。

## Global Constraints

每条对全部任务生效，值逐字取自 spec。

- 真源坐标与长度一律**整数毫米**（D8）。浮点只允许出现在视口投影与临时构造计算中，写回真源必过 `quantizeMm`。
- 包依赖方向：`core` ← `{ scene-2d, scene-3d, drawing }`，**三者互相禁止 import**；`drawing` 只许依赖 `core`。由 CI 的 `pnpm lint:deps` 强制，不靠人工自觉（D2b、4.2）。
- renderer 永不接触数据库；持久化路径固定为 renderer → preload 窄接口 → main `mysql2` 池 → repository（4.3）。
- 每条 command 必须可逆；`dispatch → undo` 必须把文档还原到**逐字节相同**（5.5）。
- ID 一律 UUIDv7 字符串（5.1）。
- core 内部不变式被违反时**直接抛错，不做兜底**（第 9 节）。
- **不引入 ORM**；迁移用顺序 `.sql` runner（8.2）。
- UI 文案仅中文；不使用 emoji。
- `Node >= 24`，包管理器锁定 pnpm。
- 仓库行尾 `.gitattributes` 必须是 `* text=auto eol=lf`（第 12 节实测该机器 `core.autocrlf=true`）。
- MySQL 约定：`utf8mb4` / `utf8mb4_0900_ai_ci`；库名 `dajia`（生产）与 `dajia_test`（测试）。建库已获授权，执行排在计划 4。
- 每个任务结束时 `pnpm verify` 必须全绿才允许提交。

---

### Task 1: workspace 骨架与 core 包空壳

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts`
- Create: `.gitattributes`
- Create: `.gitignore`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`
- Create: `packages/core/test/smoke.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: workspace 根、`@dajia/core`（`main`/`exports` 指向 `./src/index.ts`，源码直连不出产物）、根脚本 `pnpm typecheck` / `pnpm test` / `pnpm verify`；vitest alias `@dajia/core` → `packages/core/src/index.ts`。后续所有任务的测试都靠这三样跑起来。

- [ ] **Step 1: 写 workspace 与根配置**

`pnpm-workspace.yaml`：

```yaml
packages:
  - 'packages/*'
  - 'apps/*'
```

`package.json`（版本用范围，装完把实际解析结果记进执行日志）：

```json
{
  "name": "dajia",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "typecheck": "tsc --noEmit -p packages/core/tsconfig.json",
    "test": "vitest run",
    "verify": "pnpm typecheck && pnpm lint:deps && pnpm test"
  }
}
```

`tsconfig.base.json`：

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "paths": {
      "@dajia/core": ["./packages/core/src/index.ts"],
      "@dajia/protocol": ["./packages/protocol/src/index.ts"],
      "@dajia/drawing": ["./packages/drawing/src/index.ts"],
      "@dajia/scene-2d": ["./packages/scene-2d/src/index.ts"],
      "@dajia/scene-3d": ["./packages/scene-3d/src/index.ts"]
    },
    "strict": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  }
}
```

`paths` 这一组是必须的，不是便利：包 `exports` 直接指向 `.ts` 源文件（本项目不出编译产物），tsc 经 `node_modules` 软链解析这种 `exports` 目标不是稳定行为，smoke 测试会在 typecheck 阶段红。`paths` 让它与 vitest 的 alias 走同一条确定路径。

**执行期修正（Task 1 实测）**：本文档初稿写的是 `"baseUrl": "."` + 不带 `./` 的 `paths`。`typescript@7.0.2` 直接拒绝这种配置：`TS5102 Option 'baseUrl' has been removed` 与 `TS5090 Non-relative paths are not allowed`。现在的写法（无 `baseUrl`，`paths` 值以 `./` 起头）在本机可用，且 `./` 相对**声明 paths 的那个配置文件**解析 —— 已在 `packages/core/test/` 里通过一次性探针验证：临时 import 一个不存在的导出会报 `TS2305 has no exported member`，说明别名指向的是真实文件而不是静默退化成 `any`。

`vitest.config.ts`：

```ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@dajia/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'scripts/test/**/*.test.mjs'],
  },
});
```

`.gitattributes`（缺一行就会在跨平台时污染 diff）：

```
* text=auto eol=lf
*.png binary
*.jpg binary
*.pdf binary
```

`.gitignore`：

```
node_modules/
dist/
out/
release/
coverage/
.vite/
*.log
.DS_Store
Thumbs.db
```

- [ ] **Step 2: 装根依赖**

```bash
pnpm add -D -w typescript vitest @types/node
```

Expected: `node_modules` 生成，`pnpm-lock.yaml` 出现且含 `typescript`、`vitest`。把三者解析到的版本抄进本任务的执行日志行。

**执行日志（Task 1，2026-09-25 本机实测）**：`pnpm add -D -w typescript vitest @types/node` 解析到 `typescript@7.0.2`、`vitest@5.0.1`、`@types/node@26.6.2`，共 41 个包，`node_modules/.bin/tsc -v` 确认 `tsc` 二进制在 TS7 下仍叫 `tsc`。`pnpm typecheck` 首次因 `baseUrl` 被 TS7 移除而失败，配置修正后退出 0；`pnpm test` 先故意把断言改成 `toBe(2)` 得到 `AssertionError: expected 1 to be 2 / Tests 1 failed`，改回后 `1 passed`，退出 0。

- [ ] **Step 3: 建 `@dajia/core` 空壳与冒烟测试**

`packages/core/package.json`：

```json
{
  "name": "@dajia/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  }
}
```

`packages/core/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test", "../../vitest.config.ts"]
}
```

`packages/core/src/index.ts`：

```ts
export const CORE_SCHEMA_VERSION = 1;
```

`packages/core/test/smoke.test.ts` —— 同时验证 alias 生效：

```ts
import { describe, expect, it } from 'vitest';
import { CORE_SCHEMA_VERSION } from '@dajia/core';

describe('workspace 骨架', () => {
  it('可以通过包名 import @dajia/core', () => {
    expect(CORE_SCHEMA_VERSION).toBe(1);
  });
});
```

- [ ] **Step 4: 跑门禁确认失败路径与成功路径都成立**

```bash
pnpm typecheck && pnpm test
```

Expected: typecheck 无输出退出 0；`vitest run` 报 `1 passed`。

故意改坏一次以确认门禁真的会拦（不验这一条，等于门禁是摆设）：把 `smoke.test.ts` 的断言改成 `toBe(2)`，跑 `pnpm test`，Expected: **FAIL**；改回 `toBe(1)`，Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json vitest.config.ts .gitattributes .gitignore packages/core
git commit -m "chore: 搭建 pnpm workspace 与 @dajia/core 骨架

加入 .gitattributes 强制 eol=lf：本机 core.autocrlf=true，否则行尾会污染 diff。
smoke 测试顺带验证 vitest 的 @dajia/core alias。"
```

注意：本仓库已有两个 docs commit（`c6c848e`、`5f2e3b0`），本任务之后是第 3 个。

---

### Task 2: 包依赖方向守卫（CI 强制 D2b）

**Files:**
- Create: `scripts/check-package-deps.mjs`
- Create: `scripts/test/deps-check.test.mjs`
- Modify: `package.json`（加 `lint:deps` 脚本，`verify` 已经引用它）
- Create: `packages/protocol/package.json`、`packages/protocol/src/index.ts`
- Create: `packages/scene-2d/package.json`、`packages/scene-2d/src/index.ts`
- Create: `packages/scene-3d/package.json`、`packages/scene-3d/src/index.ts`
- Create: `packages/drawing/package.json`、`packages/drawing/src/index.ts`

**Interfaces:**
- Consumes: Task 1 的根脚本表
- Produces: `findViolations(rootDir): Violation[]`、`ALLOWED_DEPS: Record<string, string[]>`；`pnpm lint:deps`（违规时退出码 1 并打印 `file:line from -> to`）

为什么用脚本而不是 `eslint-plugin-import/no-restricted-paths`：守卫本身要能被测试（它误报或漏报时，整条 D2b 就是假的）。脚本可被 vitest 直接喂 fixture 目录断言，插件做不到这点。

- [ ] **Step 1: 写失败的测试**

`scripts/test/deps-check.test.mjs`：

```js
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

describe('findViolations', () => {
  /** 违规按 from->to 排序比较：不依赖 PACKAGE_DIRS 的声明顺序 */
  const asPairs = (violations) => violations.map((v) => `${v.from}->${v.to}`).sort();

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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run scripts/test/deps-check.test.mjs
```

Expected: FAIL，`Cannot find module .../scripts/check-package-deps.mjs`。

- [ ] **Step 3: 实现守卫**

`scripts/check-package-deps.mjs`：

```js
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 包名 -> 目录；apps/desktop 不在 packages/ 下 */
export const PACKAGE_DIRS = {
  core: 'packages/core',
  drawing: 'packages/drawing',
  'scene-2d': 'packages/scene-2d',
  'scene-3d': 'packages/scene-3d',
  protocol: 'packages/protocol',
  desktop: 'apps/desktop',
};

/** D2b：core 为真源，三个消费方互不相识 */
export const ALLOWED_DEPS = {
  core: [],
  protocol: [],
  drawing: ['core'],
  'scene-2d': ['core', 'protocol'],
  'scene-3d': ['core', 'protocol'],
  desktop: ['core', 'drawing', 'scene-2d', 'scene-3d', 'protocol'],
};

const IMPORT_RE =
  /(?:from|import|await\s+import|\brequire)\s*\(?\s*['"]@dajia\/([a-z0-9-]+)/g;

function exists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts')) yield full;
  }
}

/** 目录里有包、PACKAGE_DIRS 里没登记 → 抛错。漏配规则不能静默通过 */
function assertNoUnknownPackages(rootDir) {
  for (const group of ['packages', 'apps']) {
    const base = join(rootDir, group);
    if (!exists(base)) continue;
    for (const name of readdirSync(base)) {
      const declared = Object.values(PACKAGE_DIRS).some((d) => d === `${group}/${name}`);
      if (!declared) throw new Error(`未知包 ${group}/${name}：请把目录登记进 PACKAGE_DIRS`);
    }
  }
}

export function findViolations(rootDir) {
  assertNoUnknownPackages(rootDir);
  const violations = [];
  for (const [pkg, relDir] of Object.entries(PACKAGE_DIRS)) {
    const dir = join(rootDir, relDir);
    if (!exists(dir)) continue;
    for (const file of walk(dir)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        IMPORT_RE.lastIndex = 0;
        let m;
        while ((m = IMPORT_RE.exec(line)) !== null) {
          const to = m[1];
          if (!(to in ALLOWED_DEPS)) throw new Error(`未知包 @dajia/${to}`);
          // 自引用不是依赖边：包内用包名 import 自己是正常写法（各包的 test/ 靠它验证别名）
          if (to === pkg) continue;
          if (!ALLOWED_DEPS[pkg].includes(to)) {
            violations.push({
              from: pkg,
              to,
              file: relative(rootDir, file).split(sep).join('/'),
              line: i + 1,
            });
          }
        }
      });
    }
  }
  return violations;
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const root = process.cwd();
  let violations;
  try {
    violations = findViolations(root);
  } catch (err) {
    console.error(String(err.message));
    process.exit(1);
  }
  if (violations.length === 0) {
    console.log('依赖方向检查通过');
    process.exit(0);
  }
  for (const v of violations) {
    console.error(`${v.file}:${v.line}  @dajia/${v.from} -> @dajia/${v.to} 违反 D2b`);
  }
  process.exit(1);
}
```

上面 `assertNoUnknownPackages` 这一段是守卫可信度的关键：如果新增了一个包目录却忘了登记进 `PACKAGE_DIRS`，脚本会**扫不到它**并打印"检查通过"。所以未知目录一律抛错，测试 4（`packages/mystery`）钉的就是这一条。

- [ ] **Step 4: 建其余包的空壳，让守卫有东西可扫**

四个包各一份 `package.json`（`name` 依次为 `@dajia/drawing`、`@dajia/scene-2d`、`@dajia/scene-3d`、`@dajia/protocol`，`main` 与 `exports` 指向 `./src/index.ts`，`type: "module"`，`private: true`），与一份只导出常量的 `src/index.ts`：

```ts
export const DRAWING_PACKAGE = 'drawing';
```

（其余三个把常量名换成对应包名；`protocol` 用 `export const PROTOCOL_PACKAGE = 'protocol';`。）

- [ ] **Step 5: 接上脚本并跑全量**

`package.json` 的 `scripts` 加一行，保持 `verify` 不变：

```json
    "lint:deps": "node scripts/check-package-deps.mjs"
```

```bash
pnpm lint:deps && pnpm test
```

Expected: `依赖方向检查通过`；`pnpm test` 全绿，共 6 passed（Task 1 的包名解析 1 条 + 本任务 5 条）。

再故意违规一次证明它会拦：在 `packages/drawing/src/index.ts` 的**第一行**临时插入 `import '@dajia/scene-2d';`（drawing 只允许依赖 core），跑 `pnpm lint:deps`。Expected: **退出码 1**，且打印 `packages/drawing/src/index.ts:1  @dajia/drawing -> @dajia/scene-2d 违反 D2b`。确认后删掉这一行——这一步不能省，否则守卫可能是"永远返回空数组"的假通过。

- [ ] **Step 6: 提交**

```bash
git add scripts packages package.json
git commit -m "feat: 用 CI 脚本强制包依赖方向

spec D2b 规定 scene-2d / scene-3d / drawing 互不相识。用可被测试的脚本
而不是 eslint 插件：守卫误报或漏报时 D2b 就是假的，脚本能吃 fixture 断言。
未知包目录一律抛错，避免漏配规则被静默当成通过。"
```

**执行日志（Task 2，本机实测）**：守卫在真仓库上第一次跑就抓到自己的一条误判 —— `packages/core/test/smoke.test.ts` 用包名 import 自己被判成违规（`ALLOWED_DEPS.core` 为空）。修法是跳过自引用（`to === pkg`），并补第 5 条测试把它钉住；该测试同时混入一条真违规，用来区分"忽略自引用"与"根本没扫到文件"。另：本任务测试的违规断言改成按 `from->to` 排序比较，因为初稿依赖 `PACKAGE_DIRS` 的声明顺序，而那个顺序是 `core, drawing, scene-2d…`，会让"先报 scene-2d 再报 drawing"的期望必然为假红。实测：新测试在修复前 `expected [...] to have a length of 1 but got 3`，修复后 5 passed；`pnpm lint:deps` 干净退出 0，插入 `import '@dajia/scene-2d';` 后退出 1 并打印 `packages/drawing/src/index.ts:1  @dajia/drawing -> @dajia/scene-2d 违反 D2b`，删除后恢复 0。

---

### Task 3: 整数毫米单位层

**Files:**
- Create: `packages/core/src/units/mm.ts`
- Create: `packages/core/test/units.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: Task 1 的 `@dajia/core` 包壳
- Produces: `type Mm = number`（约定：整数毫米）、`quantizeMm(value: number): Mm`、`assertMm(value: number, label: string): Mm`、`mmToMeters(mm: Mm): number`、`MM_PER_M`。真源里每一个长度字段都用 `Mm` 类型标注。

- [ ] **Step 1: 写失败的测试**

`packages/core/test/units.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { MM_PER_M, assertMm, mmToMeters, quantizeMm } from '@dajia/core';

describe('quantizeMm', () => {
  it('四舍五入到整数毫米', () => {
    expect(quantizeMm(3600.4)).toBe(3600);
    expect(quantizeMm(3600.6)).toBe(3601);
    expect(quantizeMm(-3600.6)).toBe(-3601);
  });

  it('幂等：量化两次与一次相同（spec 第 10 节不变式）', () => {
    for (const v of [0, 0.2, 3600.5, -120.49, 1e6 + 0.9]) {
      expect(quantizeMm(quantizeMm(v))).toBe(quantizeMm(v));
    }
  });

  it('非有限数直接抛，不返回 NaN', () => {
    expect(() => quantizeMm(Number.NaN)).toThrow(RangeError);
    expect(() => quantizeMm(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('assertMm', () => {
  it('接受整数毫米', () => {
    expect(assertMm(240, '墙厚')).toBe(240);
    expect(assertMm(0, '偏移')).toBe(0);
  });

  it('拒绝浮点：未量化的值写进真源必须炸', () => {
    expect(() => assertMm(240.5, '墙厚')).toThrow(TypeError);
    expect(() => assertMm(240.5, '墙厚')).toThrow(/墙厚/);
  });

  it('拒绝超出安全整数：超过后加减不再准确', () => {
    expect(() => assertMm(Number.MAX_SAFE_INTEGER + 2, '坐标')).toThrow(RangeError);
  });
});

describe('换算', () => {
  it('毫米到米是纯除法，不引入浮点误差累积', () => {
    expect(MM_PER_M).toBe(1000);
    expect(mmToMeters(3600)).toBe(3.6);
    expect(mmToMeters(1)).toBe(0.001);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run packages/core/test/units.test.ts
```

Expected: FAIL，`quantizeMm is not a function`（或导入解析失败）。

- [ ] **Step 3: 实现**

`packages/core/src/units/mm.ts`：

```ts
/** 真源唯一的长度类型：整数毫米（spec D8）。 */
export type Mm = number;

export const MM_PER_M = 1000;

/**
 * 把任意浮点构造结果落到整数毫米。唯一允许写回真源的入口。
 * 用 Math.round：0.5 向正无穷侧舍入，-0.5 → -0（与 0 全等）。
 */
export function quantizeMm(value: number): Mm {
  if (!Number.isFinite(value)) {
    throw new RangeError(`quantizeMm 需要有限数，收到 ${value}`);
  }
  return Math.round(value);
}

/** 断言已经是整数毫米，用于所有命令构造器的入参校验。 */
export function assertMm(value: number, label: string): Mm {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} 必须是整数毫米，收到 ${value}：浮点坐标须先过 quantizeMm`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} 超出安全整数范围：${value}`);
  }
  return value;
}

/** 仅用于 UI 显示与图纸标注文案，绝不写回真源。 */
export function mmToMeters(mm: Mm): number {
  return mm / MM_PER_M;
}
```

`packages/core/src/index.ts` 追加：

```ts
export * from './units/mm';
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm verify
```

Expected: typecheck 通过、依赖方向通过、`pnpm test` 全绿。**实测计数：13 passed**（Task 1 smoke 1 + Task 2 守卫 5 + 本任务 units 7）。初稿这里写的"5 passed"是从没跑过的手算，往后各任务一律以实际输出为准。

- [ ] **Step 5: 提交**

```bash
git add packages/core
git commit -m "feat: 整数毫米单位层

真源唯一长度类型 Mm，quantizeMm 是浮点落回整数的唯一入口，assertMm 挡住
未量化坐标写进文档。超出安全整数范围一并拒掉：再大加减就不准了。"
```

**执行日志（Task 3）**：先跑红确认两道门禁都拦得住（vitest `TypeError: quantizeMm is not a function` ×7、tsc `TS2305 has no exported member` ×4），实现后转绿。测试在初稿 7 条断言组之外补了三条边界：`-Infinity` 也要抛、`Number.MAX_SAFE_INTEGER` 本身必须放行（只拒超出者的话，合法上限会被误杀）、`mmToMeters(-240)` 的负值换算。

---

### Task 4: UUIDv7 标识

**Files:**
- Create: `packages/core/src/ids.ts`
- Create: `packages/core/test/ids.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: Task 1 包壳
- Produces: `type EntityId = string`、`uuidv7(now?: number): EntityId`、`timeFromUuid(id: EntityId): number`、`isEntityId(value: unknown): value is EntityId`

为什么自研而不是引包：Node 的 `crypto.randomUUID()` 只有 v4（无时间有序性），而 spec 5.1 要求 v7；为 25 行代码引依赖不值，且 v7 的位布局本身要被测试钉住。

**已知边界，写进注释**：同一毫秒内的多个 ID 由随机位决定，**不保证毫秒内单调**。实体创建顺序靠 `TransactionLog` 的命令序列与数据库自增 `seq` 表达，不靠 ID。

- [ ] **Step 1: 写失败的测试**

`packages/core/test/ids.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { isEntityId, timeFromUuid, uuidv7 } from '@dajia/core';

const V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv7', () => {
  it('符合 RFC 9562 v7 的格式、版本位与变体位', () => {
    for (let i = 0; i < 200; i++) {
      expect(uuidv7()).toMatch(V7_RE);
    }
  });

  it('时间戳前 48 位可还原', () => {
    const t = 1_760_000_000_123;
    expect(timeFromUuid(uuidv7(t))).toBe(t);
  });

  it('跨毫秒字典序递增', () => {
    const a = uuidv7(1_760_000_000_000);
    const b = uuidv7(1_760_000_000_001);
    expect(a < b).toBe(true);
  });

  it('同毫秒不保证有序（已知边界，排序靠命令序列）', () => {
    const same = Array.from({ length: 500 }, () => uuidv7(1_760_000_000_000));
    expect(new Set(same).size).toBeGreaterThan(1);
  });

  it('48 位以外的时间戳高位会被拒绝，不产生静默错序', () => {
    expect(() => uuidv7(2 ** 48)).toThrow(RangeError);
    expect(() => uuidv7(-1)).toThrow(RangeError);
  });
});

describe('isEntityId', () => {
  it('认 v7，不认 v4 与手搓字符串', () => {
    expect(isEntityId(uuidv7())).toBe(true);
    expect(isEntityId(crypto.randomUUID())).toBe(false);
    expect(isEntityId('wall-1')).toBe(false);
    expect(isEntityId(undefined)).toBe(false);
    expect(isEntityId(42)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run packages/core/test/ids.test.ts
```

Expected: FAIL，导入解析失败。

- [ ] **Step 3: 实现**

`packages/core/src/ids.ts`：

```ts
export type EntityId = string;

const HEX = '0123456789abcdef';
const MAX_TS_48 = 2 ** 48;

/**
 * 48 位大端毫秒时间戳 + 12 位 rand_a + 62 位 rand_b。
 * 同毫秒内不保证单调：创建顺序由命令序列表达，不靠 ID。
 */
export function uuidv7(now: number = Date.now()): EntityId {
  if (!Number.isInteger(now) || now < 0 || now >= MAX_TS_48) {
    throw new RangeError(`uuidv7 需要 [0, 2^48) 内的整数毫秒，收到 ${now}`);
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 6; i++) {
    bytes[i] = Math.floor(now / 2 ** (40 - 8 * i)) & 0xff;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f];
    if (i === 3 || i === 5 || i === 7 || i === 9) out += '-';
  }
  return out;
}

export function timeFromUuid(id: EntityId): number {
  const hex = id.replace(/-/g, '').slice(0, 12);
  return Number.parseInt(hex, 16);
}

const V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isEntityId(value: unknown): value is EntityId {
  return typeof value === 'string' && V7_RE.test(value);
}
```

`packages/core/src/index.ts` 追加：

```ts
export * from './ids';
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm verify
```

Expected: 全绿。若"跨毫秒字典序递增"偶发失败，说明时间戳字节序写错（须大端），回去看 `for (let i = 0; i < 6; i++)` 那一行。

**执行日志（Task 4）**：先红（`uuidv7 is not a function` ×6）后绿，`pnpm verify` 计数 **19 passed**（smoke 1 + 守卫 5 + units 7 + ids 6）。"跨毫秒字典序递增"不是概率断言：两个 ID 的时间戳字节必不相同，大端前缀决定字典序，与随机位无关。测试另补一条 `uuidv7(1.5)` 必须抛（非整数毫秒）。

- [ ] **Step 5: 提交**

```bash
git add packages/core
git commit -m "feat: UUIDv7 标识

自研 25 行：Node crypto.randomUUID 只有 v4，无时间有序性。
同毫秒不保证单调这一点写进注释和测试，顺序交给命令序列与 DB seq。"
```

---

### Task 5: 实体类型、规范序列化与不可变 Document

**Files:**
- Create: `packages/core/src/model/entity.ts`
- Create: `packages/core/src/model/stable-stringify.ts`
- Create: `packages/core/src/model/document.ts`
- Create: `packages/core/test/entity.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `Mm`/`assertMm`（Task 3）、`EntityId`（Task 4）
- Produces:
  - `PointEntity`、`WallEntity`、`OpeningEntity`、`StoreyEntity`、`ColumnEntity`、`SlabEntity`、联合类型 `Entity`、`EntityKind`
  - `stableStringify(value: unknown): string`
  - `class Document`：`static create(projectId, schemaVersion?)`、`static replaceEntities(doc, entities): Document`、`get(id): Entity | undefined`、`byKind<K>(kind: K): EntityOf<K>[]`、`readonly entities: ReadonlyMap<EntityId, Entity>`、`readonly projectId`、`readonly schemaVersion`、`canonical(): string`、`equals(other: Document): boolean`
  - `type EntityOf<K extends EntityKind> = Extract<Entity, { kind: K }>`

`equals` 依赖 `canonical()`，后者是 Task 9 属性测试"逐字节还原"的判定依据 —— 所以键序与实体序都必须确定。

- [ ] **Step 1: 写失败的测试**

`packages/core/test/entity.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  Document,
  stableStringify,
  uuidv7,
  type Entity,
  type WallEntity,
} from '@dajia/core';

const projectId = uuidv7();
const A_ID = '00000000-0000-7000-8000-00000000000a';

function wall(over: Partial<WallEntity> = {}): WallEntity {
  return {
    kind: 'wall',
    id: uuidv7(),
    storeyId: uuidv7(),
    startId: uuidv7(),
    endId: uuidv7(),
    thicknessMm: 240,
    heightMm: 3000,
    elevationOffsetMm: 0,
    loadBearing: true,
    material: 'brick',
    ...over,
  };
}

function point(x: number, y: number) {
  return { kind: 'point', id: uuidv7(), storeyId: uuidv7(), x, y } as const;
}

describe('stableStringify', () => {
  it('键顺序无关', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it('数组顺序有关', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it('嵌套对象也按键排序', () => {
    expect(stableStringify({ x: { b: 1, a: [true, null, 's'] } })).toBe(
      '{"x":{"a":[true,null,"s"],"b":1}}',
    );
  });

  it('NaN / Infinity 抛错，不能悄悄变成 null 而看不出差异', () => {
    expect(() => stableStringify({ v: Number.NaN })).toThrow(TypeError);
    expect(() => stableStringify({ v: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });

  it('Map 抛错：必须先转有序数组，否则序不确定', () => {
    expect(() => stableStringify(new Map([['a', 1]]))).toThrow(TypeError);
  });
});

describe('Document', () => {
  it('新建即空', () => {
    const doc = Document.create(uuidv7());
    expect(doc.entities.size).toBe(0);
    expect(doc.byKind('wall')).toEqual([]);
  });

  it('byKind 按 id 升序返回，与插入顺序无关（canonical 确定性的前提）', () => {
    const w1 = wall({ id: '00000000-0000-7000-8000-000000000001' });
    const w2 = wall({ id: '00000000-0000-7000-8000-000000000002' });
    const doc = Document.create(uuidv7());
    const after = Document.replaceEntities(doc, new Map([[w2.id, w2], [w1.id, w1]]));
    expect(after.byKind('wall').map((w) => w.id)).toEqual([w1.id, w2.id]);
  });

  it('canonical 与实体插入顺序无关', () => {
    const a = wall();
    const b = wall();
    const d1 = Document.replaceEntities(Document.create(projectId), new Map([[a.id, a]]));
    const both = new Map([[a.id, a], [b.id, b]]);
    const reversed = new Map([[b.id, b], [a.id, a]]);
    expect(Document.replaceEntities(d1, both).canonical()).toBe(
      Document.replaceEntities(d1, reversed).canonical(),
    );
  });

  it('equals 对同一份内容返回 true', () => {
    const entities = new Map([[A_ID, wall({ id: A_ID })]]);
    const one = Document.replaceEntities(Document.create(projectId), entities);
    const two = Document.replaceEntities(Document.create(projectId), new Map(entities));
    expect(one.equals(two)).toBe(true);
  });

  it('浮点尾差进不了真源：构造文档时直接抛，不靠 equals 去分辨', () => {
    expect(() =>
      Document.replaceEntities(
        Document.create(projectId),
        new Map([[A_ID, wall({ id: A_ID, thicknessMm: 240.0001 })]]),
      ),
    ).toThrow(/thicknessMm/);
  });

  it('坐标同属整数毫米约定：点带浮点 x 必须被拒（spec D8）', () => {
    const p = point(1200.5, 0);
    expect(() =>
      Document.replaceEntities(Document.create(projectId), new Map([[p.id, p]])),
    ).toThrow(/point\.x/);
    const ok = point(1200, 0);
    const doc = Document.replaceEntities(Document.create(projectId), new Map([[ok.id, ok]]));
    expect(doc.byKind('point')[0]?.x).toBe(1200);
  });

  it('拒绝形状不合法的实体：id 不是 v7 就抛', () => {
    const doc = Document.create(uuidv7());
    expect(() =>
      Document.replaceEntities(
        doc,
        new Map([['wall-1', { ...(wall() as Entity), id: 'wall-1' }]]),
      ),
    ).toThrow(/id/);
  });

  it('拒绝 Map 的 key 与实体 id 不一致', () => {
    const w = wall();
    expect(() =>
      Document.replaceEntities(Document.create(projectId), new Map([[uuidv7(), w]])),
    ).toThrow(/key 与实体 id 不一致/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run packages/core/test/entity.test.ts
```

Expected: FAIL，导入解析失败。

- [ ] **Step 3: 实现实体类型与规范序列化**

`packages/core/src/model/entity.ts`：

```ts
import type { Mm } from '../units/mm';
import type { EntityId } from '../ids';

export type EntityKind = 'point' | 'wall' | 'opening' | 'storey' | 'column' | 'slab';

export interface PointEntity {
  kind: 'point';
  id: EntityId;
  storeyId: EntityId;
  x: Mm;
  y: Mm;
}

/** 真源是轴线两端点 + 厚度；轮廓与接头一律派生（spec 5.2）。 */
export interface WallEntity {
  kind: 'wall';
  id: EntityId;
  storeyId: EntityId;
  startId: EntityId;
  endId: EntityId;
  thicknessMm: Mm;
  heightMm: Mm;
  elevationOffsetMm: Mm;
  loadBearing: boolean;
  material: string;
}

export interface OpeningEntity {
  kind: 'opening';
  id: EntityId;
  storeyId: EntityId;
  hostWallId: EntityId;
  /** 沿宿主墙起点到洞口近端的距离 */
  distanceMm: Mm;
  widthMm: Mm;
  heightMm: Mm;
  /** 洞底距本层楼面的高度，门恒为 0 */
  sillMm: Mm;
  category: 'door' | 'window';
}

export interface StoreyEntity {
  kind: 'storey';
  id: EntityId;
  projectId: EntityId;
  index: number;
  elevationMm: Mm;
  heightMm: Mm;
}

/** S1 有类型、有命令、无编辑器 UI（spec 5.5 第二档）。 */
export interface ColumnEntity {
  kind: 'column';
  id: EntityId;
  storeyId: EntityId;
  pointId: EntityId;
  widthMm: Mm;
  depthMm: Mm;
  heightMm: Mm;
  loadBearing: boolean;
  material: string;
}

export interface SlabEntity {
  kind: 'slab';
  id: EntityId;
  storeyId: EntityId;
  boundaryPointIds: EntityId[];
  thicknessMm: Mm;
  elevationOffsetMm: Mm;
}

export type Entity =
  | PointEntity
  | WallEntity
  | OpeningEntity
  | StoreyEntity
  | ColumnEntity
  | SlabEntity;

export type EntityOf<K extends EntityKind> = Extract<Entity, { kind: K }>;
```

`packages/core/src/model/stable-stringify.ts`：

```ts
function normalize(value: unknown): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) throw new TypeError(`无法序列化非有限数：${n}`);
    return n;
  }
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'undefined') return undefined;
  if (t === 'bigint') throw new TypeError('不支持 bigint：真源长度一律整数毫米 number');
  if (value instanceof Map) {
    throw new TypeError('stableStringify 不支持 Map，请先转成有序数组以保证序确定');
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (t === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      const v = normalize(src[key]);
      if (v !== undefined) out[key] = v;
    }
    return out;
  }
  throw new TypeError(`stableStringify 不支持的类型：${t}`);
}

/** 键递归排序 + 数组保序。canonical() 的地基，别改它的行为。 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}
```

- [ ] **Step 4: 实现 Document**

`packages/core/src/model/document.ts`：

```ts
import { isEntityId, type EntityId } from '../ids';
import type { Entity, EntityKind, EntityOf } from './entity';
import { stableStringify } from './stable-stringify';

export const SCHEMA_VERSION = 1;

/**
 * 每种实体必须为整数毫米的字段。**含点的 x/y**：spec D8 写的是"坐标与长度一律整数
 * 毫米"，初稿只叫 `MM_FIELDS` 且按 `*Mm` 后缀列举，把浮点坐标留在了真源里。
 */
const INTEGER_FIELDS: Record<EntityKind, readonly string[]> = {
  point: ['x', 'y'],
  wall: ['thicknessMm', 'heightMm', 'elevationOffsetMm'],
  opening: ['distanceMm', 'widthMm', 'heightMm', 'sillMm'],
  storey: ['elevationMm', 'heightMm'],
  column: ['widthMm', 'depthMm', 'heightMm'],
  slab: ['thicknessMm', 'elevationOffsetMm'],
};

function byId(a: Entity, b: Entity): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function validate(entity: Entity): void {
  if (!isEntityId(entity.id)) {
    throw new TypeError(`实体 id 必须是 UUIDv7，收到 ${JSON.stringify(entity.id)}`);
  }
  for (const field of INTEGER_FIELDS[entity.kind]) {
    const value = (entity as unknown as Record<string, unknown>)[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new TypeError(`${entity.kind}.${field} 必须是整数毫米，收到 ${JSON.stringify(value)}`);
    }
  }
}

/** 不可变文档。改它只有一条路：Document.replaceEntities 造新实例。 */
export class Document {
  private constructor(
    readonly projectId: EntityId,
    readonly schemaVersion: number,
    readonly entities: ReadonlyMap<EntityId, Entity>,
  ) {}

  static create(projectId: EntityId, schemaVersion: number = SCHEMA_VERSION): Document {
    if (!isEntityId(projectId)) throw new TypeError('projectId 必须是 UUIDv7');
    return new Document(projectId, schemaVersion, new Map());
  }

  static replaceEntities(doc: Document, entities: ReadonlyMap<EntityId, Entity>): Document {
    const next = new Map<EntityId, Entity>();
    for (const [id, entity] of entities) {
      validate(entity);
      if (entity.id !== id) {
        throw new TypeError(`Map 的 key 与实体 id 不一致：${id} vs ${entity.id}`);
      }
      next.set(id, entity);
    }
    return new Document(doc.projectId, doc.schemaVersion, next);
  }

  get(id: EntityId): Entity | undefined {
    return this.entities.get(id);
  }

  byKind<K extends EntityKind>(kind: K): EntityOf<K>[] {
    const out: EntityOf<K>[] = [];
    for (const entity of this.entities.values()) {
      if (entity.kind === kind) out.push(entity as EntityOf<K>);
    }
    return out.sort(byId);
  }

  /** 确定性序列化：实体按 id 升序 + 键递归排序。equals 与属性测试都靠它。 */
  canonical(): string {
    return stableStringify({
      projectId: this.projectId,
      schemaVersion: this.schemaVersion,
      entities: [...this.entities.values()].sort(byId),
    });
  }

  equals(other: Document): boolean {
    return this.canonical() === other.canonical();
  }
}
```

`packages/core/src/index.ts` 现在是：

```ts
export const CORE_SCHEMA_VERSION = 1;

export * from './units/mm';
export * from './ids';
export type * from './model/entity';
export { stableStringify } from './model/stable-stringify';
export { Document, SCHEMA_VERSION } from './model/document';
```

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm verify
```

Expected: 全绿。`equals` 相关的两条若红，先查 `INTEGER_FIELDS.wall` 是否含 `thicknessMm`，再查 `byKind`/`canonical` 的排序 —— 不要靠放宽断言解决。

- [ ] **Step 6: 提交**

```bash
git add packages/core
git commit -m "feat: 实体类型、规范序列化与不可变 Document

canonical() = 实体按 id 升序 + 键递归排序，是 Task 9 属性测试判定
「撤销后逐字节还原」的唯一依据。replaceEntities 顺手校验 id 为 v7、
长度字段为整数毫米，浮点尾差进不了真源。"
```

**执行日志（Task 5）**：实现时改掉了初稿一处与 spec D8 冲突的地方 —— `MM_FIELDS.point` 是空数组，即只校验带 `Mm` 后缀的长度字段，**点的 x/y 两个坐标没被校验**，浮点坐标可以静默进真源。现改名 `INTEGER_FIELDS` 并把 `point: ['x', 'y']` 补上，配一条 `point(1200.5, 0)` 必须抛的测试。另补两条：Map 的 key 与实体 id 不一致要抛、合法坐标 1200 要放行（防"一律抛"造成假绿）。实测先红（11/13 失败）后绿，`pnpm verify` 计数 **32 passed**（前四任务 19 + 本任务 13）。

---

### Task 6: 补丁与应用/求逆

**Files:**
- Create: `packages/core/src/model/patch.ts`
- Create: `packages/core/test/patch.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `Document`（Task 5）、`Entity`/`EntityId`
- Produces:
  - `interface Patch { readonly upsert: readonly Entity[]; readonly remove: readonly EntityId[] }`
  - `interface PatchResult { doc: Document; previous: ReadonlyMap<EntityId, Entity | undefined> }`
  - `applyPatch(doc: Document, patch: Patch): PatchResult`
  - `invertPatch(patch: Patch, previous: ReadonlyMap<EntityId, Entity | undefined>): Patch`

`previous` 必须为 `patch.upsert` 与 `patch.remove` 里的**每一个** id 都留有记录（新建的记为 `undefined`）—— 求逆全靠它，缺一个就会把新实体漏在文档里。

- [ ] **Step 1: 写失败的测试**

`packages/core/test/patch.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  Document,
  applyPatch,
  invertPatch,
  uuidv7,
  type Entity,
  type PointEntity,
  type WallEntity,
} from '@dajia/core';

const projectId = uuidv7();
const storeyId = uuidv7();

function point(id: string, x: number, y: number): PointEntity {
  return { kind: 'point', id, storeyId, x, y };
}

function wall(id: string, startId: string, endId: string): WallEntity {
  return {
    kind: 'wall',
    id,
    storeyId,
    startId,
    endId,
    thicknessMm: 240,
    heightMm: 3000,
    elevationOffsetMm: 0,
    loadBearing: true,
    material: 'brick',
  };
}

const P = (n: number) => `00000000-0000-7000-8000-00000000000${n}`;

function docWith(...entities: Entity[]): Document {
  const map = new Map(entities.map((e) => [e.id, e]));
  return Document.replaceEntities(Document.create(projectId), map);
}

describe('applyPatch', () => {
  it('upsert 新建实体并记录 previous 为 undefined', () => {
    const doc = docWith();
    const r = applyPatch(doc, { upsert: [point(P(1), 0, 0)], remove: [] });
    expect(r.doc.entities.size).toBe(1);
    expect(r.previous.get(P(1))).toBeUndefined();
  });

  it('upsert 覆盖已有实体时保留旧值', () => {
    const doc = docWith(wall(P(2), P(1), P(3)));
    const thick240 = doc.get(P(2)) as WallEntity;
    const r = applyPatch(doc, {
      upsert: [{ ...thick240, thicknessMm: 120 }],
      remove: [],
    });
    expect((r.doc.get(P(2)) as WallEntity).thicknessMm).toBe(120);
    expect((r.previous.get(P(2)) as WallEntity).thicknessMm).toBe(240);
  });

  it('remove 删除实体并留下旧值供求逆', () => {
    const doc = docWith(point(P(1), 0, 0));
    const r = applyPatch(doc, { upsert: [], remove: [P(1)] });
    expect(r.doc.entities.size).toBe(0);
    expect(r.previous.get(P(1))?.kind).toBe('point');
  });

  it('原 doc 不被改动（不可变）', () => {
    const doc = docWith(point(P(1), 0, 0));
    applyPatch(doc, { upsert: [], remove: [P(1)] });
    expect(doc.entities.size).toBe(1);
  });

  it('同一 id 既 upsert 又 remove 时抛错：命令写错了就该炸', () => {
    const doc = docWith();
    expect(() => applyPatch(doc, { upsert: [point(P(1), 0, 0)], remove: [P(1)] })).toThrow(
      /同一 id 既 upsert 又 remove/,
    );
  });

  it('remove 不存在的 id 时抛错：不变式违反不兜底（spec 第 9 节）', () => {
    expect(() => applyPatch(docWith(), { upsert: [], remove: [P(9)] })).toThrow(/不存在/);
  });

  it('upsert 内 id 重复时抛错，避免后写覆盖前写的歧义', () => {
    expect(() =>
      applyPatch(docWith(), { upsert: [point(P(1), 0, 0), point(P(1), 1, 1)], remove: [] }),
    ).toThrow(/重复/);
  });
});

describe('invertPatch', () => {
  it('新建的逆是删除', () => {
    const doc = docWith();
    const patch = { upsert: [point(P(1), 0, 0)], remove: [] };
    const { previous } = applyPatch(doc, patch);
    const inv = invertPatch(patch, previous);
    expect(inv.upsert).toEqual([]);
    expect(inv.remove).toEqual([P(1)]);
  });

  it('删除的逆是原样恢复', () => {
    const doc = docWith(point(P(1), 100, 200));
    const patch = { upsert: [], remove: [P(1)] };
    const { previous } = applyPatch(doc, patch);
    const inv = invertPatch(patch, previous);
    expect(inv.remove).toEqual([]);
    expect(inv.upsert).toEqual([point(P(1), 100, 200)]);
  });

  it('修改的逆是写回旧值', () => {
    const doc = docWith(wall(P(2), P(1), P(3)));
    const before = doc.get(P(2)) as WallEntity;
    const patch = { upsert: [{ ...before, thicknessMm: 120 }], remove: [] };
    const { previous } = applyPatch(doc, patch);
    const inv = invertPatch(patch, previous);
    expect((inv.upsert[0] as WallEntity).thicknessMm).toBe(240);
    expect(inv.remove).toEqual([]);
  });

  it('apply 后再 apply 其逆，canonical 逐字节还原（Task 9 属性测试的种子用例）', () => {
    const doc = docWith(wall(P(2), P(1), P(3)), point(P(1), 0, 0), point(P(3), 3600, 0));
    const before = doc.canonical();
    const patch = {
      upsert: [point(P(4), 10, 10), { ...(doc.get(P(2)) as WallEntity), thicknessMm: 120 }],
      remove: [P(1)],
    };
    const applied = applyPatch(doc, patch);
    expect(applied.doc.canonical()).not.toBe(before);
    const undone = applyPatch(applied.doc, invertPatch(patch, applied.previous));
    expect(undone.doc.canonical()).toBe(before);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run packages/core/test/patch.test.ts
```

Expected: FAIL，导入解析失败。

- [ ] **Step 3: 实现**

`packages/core/src/model/patch.ts`：

```ts
import type { EntityId } from '../ids';
// Document 必须是值导入：applyPatch 运行时调用 Document.replaceEntities，
// 用 import type 会被 verbatimModuleSyntax 擦掉，测试里表现为 ReferenceError。
import { Document } from './document';
import type { Entity } from './entity';

export interface Patch {
  readonly upsert: readonly Entity[];
  readonly remove: readonly EntityId[];
}

export interface PatchResult {
  doc: Document;
  /** patch 涉及的每个 id 都要有记录；新建的记为 undefined。求逆的唯一依据。 */
  previous: ReadonlyMap<EntityId, Entity | undefined>;
}

export function applyPatch(doc: Document, patch: Patch): PatchResult {
  const upsertIds = new Set<EntityId>();
  for (const entity of patch.upsert) {
    if (upsertIds.has(entity.id)) {
      throw new TypeError(`Patch.upsert 内 id 重复：${entity.id}`);
    }
    upsertIds.add(entity.id);
  }
  for (const id of patch.remove) {
    if (upsertIds.has(id)) {
      throw new TypeError(`Patch 同一 id 既 upsert 又 remove：${id}`);
    }
    if (!doc.entities.has(id)) {
      throw new TypeError(`Patch.remove 的实体不存在：${id}`);
    }
  }

  const previous = new Map<EntityId, Entity | undefined>();
  for (const id of patch.remove) previous.set(id, doc.entities.get(id));
  for (const entity of patch.upsert) {
    if (!previous.has(entity.id)) previous.set(entity.id, doc.entities.get(entity.id));
  }

  const next = new Map(doc.entities);
  for (const id of patch.remove) next.delete(id);
  for (const entity of patch.upsert) next.set(entity.id, entity);

  return { doc: Document.replaceEntities(doc, next), previous };
}

export function invertPatch(
  patch: Patch,
  previous: ReadonlyMap<EntityId, Entity | undefined>,
): Patch {
  const restore: Entity[] = [];
  const drop: EntityId[] = [];
  for (const id of patch.remove) {
    const entity = previous.get(id);
    if (entity) restore.push(entity);
  }
  for (const entity of patch.upsert) {
    const before = previous.get(entity.id);
    if (before) restore.push(before);
    else drop.push(entity.id);
  }
  return { upsert: restore, remove: drop };
}
```

`packages/core/src/index.ts` 追加：

```ts
export type * from './model/patch';
export { applyPatch, invertPatch } from './model/patch';
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm verify
```

Expected: 全绿。`previous` 里没记录到 remove 项会导致"删除的逆"返回空 upsert —— 那正是本任务最可能出错的地方，测试 2 就是钉它的。

- [ ] **Step 5: 提交**

```bash
git add packages/core
git commit -m "feat: 补丁与求逆

Patch 只有 upsert/remove 两种动作；previous 记录涉及 id 的原值，
invertPatch 据此还原。非法补丁（同 id 又增又删、删不存在、重复）一律抛。"
```

**执行日志（Task 6）**：本任务的代码清单有两处是照着抄就会炸的：

1. `import type { Document }` —— `applyPatch` 在运行时调用 `Document.replaceEntities`，而 `verbatimModuleSyntax` 会把类型导入整条擦掉，实测 9 条测试报 `ReferenceError: Document is not defined`。改成值导入，并在文件里留注释说明为什么不能 `import type`。Task 7 起沿用同一判据：**只要运行时用到被导入方的静态方法或值，就必须值导入**。
2. 测试里 `toThrow(/同时/)` 与实现抛的消息 `Patch 同一 id 既 upsert 又 remove：…` 不匹配 —— 正则改成 `/同一 id 既 upsert 又 remove/`。这条本来会静默放行任何别的 TypeError（"抛了"就能通过），属于断言太松，不是抄错。

另外把 Step 4 提到的"previous 没记录 remove 项"从**叙述**变成了**断言**：第 1 条测试补 `expect(r.previous.has(P(1))).toBe(true)`。原清单只断言 `previous.get(P(1))` 是 `undefined`，而"键不存在"与"键存在且值为 undefined"在 `get` 下无法区分 —— 正是 `invertPatch` 区分"新建"与"没记录"的依据。随后做了变异验证：把 `if (!previous.has(entity.id)) previous.set(...)` 改成永不记录，测试从 11 passed 变 **4 failed | 7 passed**（含 `expected false to be true` 与逐字节还原那条），改回后 11 passed —— 门禁是活的。

**偏离计划之处（记录，不掩饰）**：Step 1–3 把测试与实现写在同一轮里跑的，所以观测到的"红"是上面两个真 bug，而不是计划设想的"实现缺失导致的导入失败"。Task 7–10 按 Step 1 写测试 → Step 2 看红 → Step 3 实现 的顺序执行。实测计数：`pnpm verify` **43 passed**（前序 32 + 本任务 11）。

---

### Task 7: 命令与事务日志（撤销/重做）

**Files:**
- Create: `packages/core/src/model/command.ts`
- Create: `packages/core/src/model/transaction.ts`
- Create: `packages/core/test/transaction.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `Document`、`Patch`、`applyPatch`、`invertPatch`（Task 5–6）
- Produces:
  - `type CommandType = 'storey.create' | 'wall.create' | 'wall.moveEndpoint' | 'wall.setThickness' | 'wall.delete' | 'opening.create' | 'opening.move' | 'opening.delete' | 'column.create' | 'slab.create'`
  - `interface Command { readonly type: CommandType; build(doc: Document): Patch }`
  - `class TransactionLog`：`constructor(doc)`、`get document(): Document`、`get affected(): ReadonlySet<EntityId>`、`get canUndo/canRedo(): boolean`、`get depth(): number`、`dispatch(cmd: Command): void`、`undo(): boolean`、`redo(): boolean`
  - `function affectedIds(patch: Patch): Set<EntityId>`

计划 3 的 3D 增量重建要用 `log.affected` 决定重建哪几个 mesh（spec 第 6 节）。

- [ ] **Step 1: 写失败的测试**

`packages/core/test/transaction.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  uuidv7,
  type Command,
  type EntityId,
  type PointEntity,
  type WallEntity,
} from '@dajia/core';

const storeyId = uuidv7();
const PID = (n: number) => `00000000-0000-7000-8000-00000000000${n}`;

function point(id: string, x: number, y: number): PointEntity {
  return { kind: 'point', id, storeyId, x, y };
}

function wall(id: string, startId: string, endId: string): WallEntity {
  return {
    kind: 'wall',
    id,
    storeyId,
    startId,
    endId,
    thicknessMm: 240,
    heightMm: 3000,
    elevationOffsetMm: 0,
    loadBearing: true,
    material: 'brick',
  };
}

function seed(): TransactionLog {
  const doc = Document.replaceEntities(
    Document.create(uuidv7()),
    new Map<string, PointEntity | WallEntity>([
      [PID(1), point(PID(1), 0, 0)],
      [PID(2), point(PID(2), 3600, 0)],
      [PID(3), wall(PID(3), PID(1), PID(2))],
    ]),
  );
  return new TransactionLog(doc);
}

const movePoint = (id: EntityId, x: number, y: number): Command => ({
  type: 'wall.moveEndpoint',
  build(doc) {
    const target = doc.get(id) as PointEntity;
    return { upsert: [{ ...target, x, y }], remove: [] };
  },
});

describe('TransactionLog', () => {
  it('dispatch 后可见新状态，affected 覆盖改动面', () => {
    const log = seed();
    log.dispatch(movePoint(PID(1), 100, 200));
    expect((log.document.get(PID(1)) as PointEntity).x).toBe(100);
    expect(log.affected).toEqual(new Set([PID(1)]));
    expect(log.canUndo).toBe(true);
    expect(log.canRedo).toBe(false);
  });

  it('undo 还原并开 redo', () => {
    const log = seed();
    const before = log.document.canonical();
    log.dispatch(movePoint(PID(1), 100, 200));
    expect(log.undo()).toBe(true);
    expect(log.document.canonical()).toBe(before);
    expect(log.canRedo).toBe(true);
  });

  it('undo/redo 的 affected 跟着被撤/被重做的那笔走', () => {
    const setThickness = (): Command => ({
      type: 'wall.setThickness',
      build(doc) {
        const w = doc.get(PID(3)) as WallEntity;
        return { upsert: [{ ...w, thicknessMm: 120 }], remove: [] };
      },
    });
    const log = seed();
    log.dispatch(movePoint(PID(1), 100, 200));
    log.dispatch(setThickness());
    expect(log.affected).toEqual(new Set([PID(3)]));
    expect(log.undo()).toBe(true);
    expect(log.undo()).toBe(true);
    // 撤到第一笔：不随 undo 刷新的话这里会停在 {PID(3)}
    expect(log.affected).toEqual(new Set([PID(1)]));
    expect(log.redo()).toBe(true);
    expect(log.redo()).toBe(true);
    expect(log.affected).toEqual(new Set([PID(3)]));
  });

  it('redo 再应用，与不撤销等价', () => {
    const log = seed();
    log.dispatch(movePoint(PID(1), 100, 200));
    const moved = log.document.canonical();
    log.undo();
    expect(log.redo()).toBe(true);
    expect(log.document.canonical()).toBe(moved);
  });

  it('新命令清空 redo 栈（撤销后改一笔，原分支不可再 redo）', () => {
    const log = seed();
    log.dispatch(movePoint(PID(1), 100, 200));
    log.undo();
    log.dispatch(movePoint(PID(2), 500, 500));
    expect(log.canRedo).toBe(false);
    expect(log.redo()).toBe(false);
  });

  it('空栈 undo/redo 返回 false，不抛', () => {
    const log = seed();
    expect(log.undo()).toBe(false);
    expect(log.redo()).toBe(false);
    expect(log.depth).toBe(0);
  });

  it('连撤 30 步回到起点，连重做 30 步回到末尾（S1 验收 2 的前置）', () => {
    const log = seed();
    const before = log.document.canonical();
    for (let i = 0; i < 30; i++) {
      log.dispatch(movePoint(PID(1), i * 10, i * 20));
    }
    for (let i = 0; i < 30; i++) {
      expect(log.undo()).toBe(true);
    }
    expect(log.document.canonical()).toBe(before);
    expect(log.depth).toBe(0);
    for (let i = 0; i < 30; i++) {
      expect(log.redo()).toBe(true);
    }
    for (let i = 0; i < 30; i++) {
      log.undo();
    }
    expect(log.document.canonical()).toBe(before);
  });

  it('命令 build 抛错时不留半条事务记录', () => {
    const log = seed();
    const before = log.document.canonical();
    const boom: Command = {
      type: 'wall.delete',
      build() {
        throw new TypeError('故意失败');
      },
    };
    expect(() => log.dispatch(boom)).toThrow(/故意失败/);
    expect(log.document.canonical()).toBe(before);
    expect(log.depth).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run packages/core/test/transaction.test.ts
```

Expected: FAIL，`TransactionLog is not a constructor` / 导入解析失败。

- [ ] **Step 3: 实现命令类型与事务日志**

`packages/core/src/model/command.ts`：

```ts
import type { Document } from './document';
import type { Patch } from './patch';

/** spec 5.5 的 S1 命令全集。 */
export type CommandType =
  | 'storey.create'
  | 'wall.create'
  | 'wall.moveEndpoint'
  | 'wall.setThickness'
  | 'wall.delete'
  | 'opening.create'
  | 'opening.move'
  | 'opening.delete'
  | 'column.create'
  | 'slab.create';

export interface Command {
  readonly type: CommandType;
  /** 纯函数：只读 doc，产出 Patch，绝不改 doc。 */
  build(doc: Document): Patch;
}
```

`packages/core/src/model/transaction.ts`：

```ts
import type { EntityId } from '../ids';
import type { Command } from './command';
// TransactionLog 只在类型位置用到 Document（字段/参数/返回值），不调它的静态方法，
// 所以是类型导入；Task 6 的反例（applyPatch 调 Document.replaceEntities）才需要值导入。
import type { Document } from './document';
import type { Entity } from './entity';
import { applyPatch, invertPatch, type Patch } from './patch';

interface Entry {
  patch: Patch;
  previous: ReadonlyMap<EntityId, Entity | undefined>;
}

export function affectedIds(patch: Patch): Set<EntityId> {
  const ids = new Set<EntityId>();
  for (const entity of patch.upsert) ids.add(entity.id);
  for (const id of patch.remove) ids.add(id);
  return ids;
}

/**
 * 撤销即应用逆补丁。重做直接再应用正向补丁：撤销后的文档状态与原 dispatch
 * 前状态相同（由 applyPatch/invertPatch 的成对性保证），故无需复用存的 previous。
 */
export class TransactionLog {
  private doc: Document;
  private readonly undoStack: Entry[] = [];
  private readonly redoStack: Entry[] = [];
  private lastAffected: Set<EntityId> = new Set();

  constructor(doc: Document) {
    this.doc = doc;
  }

  get document(): Document {
    return this.doc;
  }

  /** 最近一次 dispatch/undo/redo 触及的实体 id，供计划 3 的 3D 增量重建使用。 */
  get affected(): ReadonlySet<EntityId> {
    return this.lastAffected;
  }

  get depth(): number {
    return this.undoStack.length;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  dispatch(cmd: Command): void {
    const patch = cmd.build(this.doc);
    const result = applyPatch(this.doc, patch);
    this.doc = result.doc;
    this.undoStack.push({ patch, previous: result.previous });
    this.redoStack.length = 0;
    this.lastAffected = affectedIds(patch);
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    this.doc = applyPatch(this.doc, invertPatch(entry.patch, entry.previous)).doc;
    this.redoStack.push(entry);
    this.lastAffected = affectedIds(entry.patch);
    return true;
  }

  redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    this.doc = applyPatch(this.doc, entry.patch).doc;
    this.undoStack.push(entry);
    this.lastAffected = affectedIds(entry.patch);
    return true;
  }
}
```

`packages/core/src/index.ts` 追加：

```ts
export type * from './model/command';
export { TransactionLog, affectedIds } from './model/transaction';
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm verify
```

Expected: 全绿。"连撤 30 步"若失败，几乎一定是 `Document.canonical()` 不确定（回 Task 5 查排序），不是撤销逻辑错 —— 这个顺序要记住，别去改撤销代码。

- [ ] **Step 5: 提交**

```bash
git add packages/core
git commit -m "feat: 命令与事务日志

dispatch/undo/redo 以补丁及其 previous 为单位；build 抛错时不动栈，
避免半途事务。affected 供计划 3 的 3D 增量重建使用。"
```

**执行日志（Task 7）**：按 Task 6 补的规矩走的顺序 —— 先写测试跑红，再实现。红态同时打中两道门禁：vitest 7 条全 `TypeError: TransactionLog is not a constructor`；`pnpm typecheck` 报 `TS2305 has no exported member 'TransactionLog' / 'Command'` 外加一条 `TS7006 Parameter 'doc' implicitly has an 'any' type` —— `build(doc)` 的上下文类型来自 `Command`，`Command` 还没导出时它只能是隐式 any。这条是顺带证明"测试确实经过类型检查"。

清单里 `import { Document }` 改成了 `import type { Document }`（本文件只在类型位置用它，不调静态方法），清单已同步修正，并留注释对照 Task 6 的反例。

**变异验证（本任务的重点发现）**：先给 `undo 还原并开 redo` 补一条 `expect(log.affected).toEqual(new Set([PID(1)]))`，然后把 `undo()` 里的 `lastAffected` 更新删掉 —— **8 条全绿**。原因是这条断言恒真：dispatch 刚把 `lastAffected` 设成 `{PID(1)}`，undo 更不更新看不出差别。改成"两笔动不同实体的命令，连撤两次"的场景（撤到第一笔时正确值应为 `{PID(1)}`，不刷新则停在 `{PID(3)}`）才真正咬住。最终三轮变异各打红 1 条：A = `undo` 不刷 affected、B = `dispatch` 不清 redoStack、C = `redo` 不刷 affected；恢复后与备份 `diff` 逐字节一致，`pnpm verify` **51 passed**（前序 43 + 本任务 8）。教训：**"实现里已经做了"不等于"测试能证明它做了"**，断言必须让"做了"与"没做"落到不同的可观测值上。

---

### Task 8: 楼层与墙命令（含级联删除与孤儿点回收）

**Files:**
- Create: `packages/core/src/commands/storey.ts`
- Create: `packages/core/src/commands/wall.ts`
- Create: `packages/core/test/commands.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `Command`、`Document`、实体类型、`assertMm`（Task 3–7）
- Produces:
  - `storeyCreate(input: { projectId: EntityId; index: number; elevationMm: number; heightMm: number }): Command`
  - `wallCreate(input: { storeyId: EntityId; start: { x: number; y: number }; end: { x: number; y: number }; thicknessMm: number; heightMm: number; elevationOffsetMm?: number; loadBearing?: boolean; material?: string }): Command`
  - `wallDelete(input: { wallId: EntityId }): Command`
  - `wallSetThickness(input: { wallId: EntityId; thicknessMm: number }): Command`
  - `wallMoveEndpoint(input: { wallId: EntityId; end: 'start' | 'end'; x: number; y: number }): Command`

`wallCreate` 在计划 1 里**总是新建两个端点**，共享端点与接头吸附属计划 2 —— 现在做会需要还没有的拓扑查询。级联删除现在就做，因为它只是引用扫描。

- [ ] **Step 1: 写失败的测试**

`packages/core/test/commands.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  storeyCreate,
  uuidv7,
  wallCreate,
  wallDelete,
  wallMoveEndpoint,
  wallSetThickness,
  type ColumnEntity,
  type OpeningEntity,
  type PointEntity,
  type SlabEntity,
  type StoreyEntity,
  type WallEntity,
} from '@dajia/core';

const projectId = uuidv7();

function emptyLog(): TransactionLog {
  return new TransactionLog(Document.create(projectId));
}

function oneWall(log: TransactionLog): { storeyId: string; wallId: string } {
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  const storeyId = log.document.byKind('storey')[0]!.id;
  log.dispatch(
    wallCreate({
      storeyId,
      start: { x: 0, y: 0 },
      end: { x: 3600, y: 0 },
      thicknessMm: 240,
      heightMm: 3000,
    }),
  );
  return { storeyId, wallId: log.document.byKind('wall')[0]!.id };
}

describe('storeyCreate', () => {
  it('建楼层，可撤销回空文档', () => {
    const log = emptyLog();
    const before = log.document.canonical();
    log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
    const storey = log.document.byKind('storey')[0] as StoreyEntity;
    expect(storey.elevationMm).toBe(0);
    expect(storey.heightMm).toBe(3000);
    log.undo();
    expect(log.document.canonical()).toBe(before);
  });

  it('index 重复时抛错', () => {
    const log = emptyLog();
    log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
    expect(() =>
      log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 3000, heightMm: 3000 })),
    ).toThrow(/index/);
  });
});

describe('wallCreate', () => {
  it('建墙即带出两个端点，坐标落到整数毫米', () => {
    const log = emptyLog();
    log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
    const storeyId = log.document.byKind('storey')[0]!.id;
    log.dispatch(
      wallCreate({
        storeyId,
        start: { x: 0, y: 0 },
        end: { x: 3600.4, y: 0.2 },
        thicknessMm: 240,
        heightMm: 3000,
      }),
    );
    const w = log.document.byKind('wall')[0] as WallEntity;
    const pts = log.document.byKind('point') as PointEntity[];
    expect(pts).toHaveLength(2);
    expect(w.endId).not.toBe(w.startId);
    expect(pts.find((p) => p.id === w.endId)!.x).toBe(3600);
    expect(w.loadBearing).toBe(true);
    expect(w.material).toBe('brick');
    expect(w.elevationOffsetMm).toBe(0);
  });

  it('浮点墙厚被拒：未量化的值不能进真源', () => {
    const log = emptyLog();
    log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
    const storeyId = log.document.byKind('storey')[0]!.id;
    expect(() =>
      log.dispatch(
        wallCreate({
          storeyId,
          start: { x: 0, y: 0 },
          end: { x: 1000, y: 0 },
          thicknessMm: 240.5,
          heightMm: 3000,
        }),
      ),
    ).toThrow(/整数毫米/);
  });

  it('零长墙抛错', () => {
    const log = emptyLog();
    log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
    const storeyId = log.document.byKind('storey')[0]!.id;
    expect(() =>
      log.dispatch(
        wallCreate({
          storeyId,
          start: { x: 100, y: 100 },
          end: { x: 100.2, y: 100.1 },
          thicknessMm: 240,
          heightMm: 3000,
        }),
      ),
    ).toThrow(/零长/);
  });

  it('墙厚不能大于等于自身长度（自相交轮廓的入口，先挡住）', () => {
    const log = emptyLog();
    log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
    const storeyId = log.document.byKind('storey')[0]!.id;
    expect(() =>
      log.dispatch(
        wallCreate({
          storeyId,
          start: { x: 0, y: 0 },
          end: { x: 100, y: 0 },
          thicknessMm: 240,
          heightMm: 3000,
        }),
      ),
    ).toThrow(/不小于墙长/);
  });
});

describe('wallSetThickness / wallMoveEndpoint', () => {
  it('改厚度并撤销回原值', () => {
    const log = emptyLog();
    const { wallId } = oneWall(log);
    const before = log.document.canonical();
    log.dispatch(wallSetThickness({ wallId, thicknessMm: 120 }));
    expect((log.document.get(wallId) as WallEntity).thicknessMm).toBe(120);
    log.undo();
    expect(log.document.canonical()).toBe(before);
  });

  it('移动端点只改那一个点，affected 恰好一个实体', () => {
    const log = emptyLog();
    const { wallId } = oneWall(log);
    const w = log.document.get(wallId) as WallEntity;
    log.dispatch(wallMoveEndpoint({ wallId, end: 'end', x: 4800, y: 900 }));
    expect((log.document.get(w.endId) as PointEntity).x).toBe(4800);
    expect((log.document.get(w.startId) as PointEntity).x).toBe(0);
    expect(log.affected).toEqual(new Set([w.endId]));
  });

  it('把端点移到与另一端同处 = 零长墙，抛错', () => {
    const log = emptyLog();
    const { wallId } = oneWall(log);
    const w = log.document.get(wallId) as WallEntity;
    const start = log.document.get(w.startId) as PointEntity;
    expect(() =>
      wallMoveEndpoint({ wallId, end: 'end', x: start.x, y: start.y }).build(log.document),
    ).toThrow(/零长/);
  });
});

describe('wallDelete', () => {
  function wallWithOpening(log: TransactionLog) {
    const { wallId, storeyId } = oneWall(log);
    log.dispatch({
      type: 'opening.create',
      // 不写 doc 形参：这条命令不读文档，留着会撞 noUnusedParameters（TS6133）。
      // Command.build 允许少写参数。
      build() {
        const opening: OpeningEntity = {
          kind: 'opening',
          id: uuidv7(),
          storeyId,
          hostWallId: wallId,
          distanceMm: 900,
          widthMm: 900,
          heightMm: 2100,
          sillMm: 0,
          category: 'door',
        };
        return { upsert: [opening], remove: [] };
      },
    });
    const openingId = log.document.byKind('opening')[0]!.id;
    return { wallId, openingId };
  }

  it('删墙级联删其洞口', () => {
    const log = emptyLog();
    const { wallId, openingId } = wallWithOpening(log);
    expect(log.document.get(openingId)).toBeDefined();
    log.dispatch(wallDelete({ wallId }));
    expect(log.document.get(wallId)).toBeUndefined();
    expect(log.document.get(openingId)).toBeUndefined();
  });

  it('无人引用的端点被回收，仍被引用的留下', () => {
    const log = emptyLog();
    const { wallId } = oneWall(log);
    const first = log.document.get(wallId) as WallEntity;
    // 第二面墙共享 first.endId
    log.dispatch({
      type: 'wall.create',
      build() {
        const end: PointEntity = {
          kind: 'point',
          id: uuidv7(),
          storeyId: first.storeyId,
          x: 3600,
          y: 2400,
        };
        const w: WallEntity = {
          kind: 'wall',
          id: uuidv7(),
          storeyId: first.storeyId,
          startId: first.endId,
          endId: end.id,
          thicknessMm: 240,
          heightMm: 3000,
          elevationOffsetMm: 0,
          loadBearing: true,
          material: 'brick',
        };
        return { upsert: [end, w], remove: [] };
      },
    });
    const sharedEnd = first.endId;
    const orphanStart = first.startId;
    log.dispatch(wallDelete({ wallId }));
    expect(log.document.get(orphanStart)).toBeUndefined();
    expect(log.document.get(sharedEnd)).toBeDefined();
  });

  it('删不存在的墙抛错', () => {
    const log = emptyLog();
    expect(() => wallDelete({ wallId: uuidv7() }).build(log.document)).toThrow(/不存在/);
  });

  it('端点仍被柱或板引用时不回收', () => {
    const log = emptyLog();
    const { wallId, storeyId } = oneWall(log);
    const wall = log.document.get(wallId) as WallEntity;
    log.dispatch({
      type: 'column.create',
      build() {
        const column: ColumnEntity = {
          kind: 'column',
          id: uuidv7(),
          storeyId,
          pointId: wall.startId,
          widthMm: 400,
          depthMm: 400,
          heightMm: 3000,
          loadBearing: true,
          material: 'concrete',
        };
        const slab: SlabEntity = {
          kind: 'slab',
          id: uuidv7(),
          storeyId,
          // 故意只挂终点：让"查柱"与"查板"各自决定一个点的生死，
          // 否则起点被柱和板同时引用，漏查板也能蒙过。板的边界点数 S1 不校验。
          boundaryPointIds: [wall.endId],
          thicknessMm: 120,
          elevationOffsetMm: 0,
        };
        return { upsert: [column, slab], remove: [] };
      },
    });
    log.dispatch(wallDelete({ wallId }));
    // 起点只剩柱引用，终点只剩板引用：两条引用扫描少一条就会误删
    expect(log.document.get(wall.startId)).toBeDefined();
    expect(log.document.get(wall.endId)).toBeDefined();
  });

  it('撤消删除后墙、洞口、端点全部原样回来', () => {
    const log = emptyLog();
    const { wallId, openingId } = wallWithOpening(log);
    const before = log.document.canonical();
    log.dispatch(wallDelete({ wallId }));
    expect(log.document.canonical()).not.toBe(before);
    log.undo();
    expect(log.document.get(wallId)).toBeDefined();
    expect(log.document.get(openingId)).toBeDefined();
    expect(log.document.canonical()).toBe(before);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run packages/core/test/commands.test.ts
```

Expected: FAIL，`wallCreate is not a function`。

- [ ] **Step 3: 实现楼层命令**

`packages/core/src/commands/storey.ts`：

```ts
import { uuidv7, type EntityId } from '../ids';
import { assertMm, type Mm } from '../units/mm';
import type { Document } from '../model/document';
import type { Command } from '../model/command';
import type { StoreyEntity } from '../model/entity';

export interface StoreyCreateInput {
  projectId: EntityId;
  index: number;
  elevationMm: Mm;
  heightMm: Mm;
}

export function storeyCreate(input: StoreyCreateInput): Command {
  const elevationMm = assertMm(input.elevationMm, '楼层标高');
  const heightMm = assertMm(input.heightMm, '层高');
  if (heightMm <= 0) throw new RangeError(`层高必须为正，收到 ${heightMm}`);
  if (!Number.isInteger(input.index) || input.index < 0) {
    throw new RangeError(`楼层序号必须为非负整数，收到 ${input.index}`);
  }
  return {
    type: 'storey.create',
    build(doc: Document) {
      const clash = doc
        .byKind('storey')
        .some((s) => s.projectId === input.projectId && s.index === input.index);
      if (clash) {
        throw new TypeError(`楼层 index 重复：project=${input.projectId} index=${input.index}`);
      }
      const storey: StoreyEntity = {
        kind: 'storey',
        id: uuidv7(),
        projectId: input.projectId,
        index: input.index,
        elevationMm,
        heightMm,
      };
      return { upsert: [storey], remove: [] };
    },
  };
}
```

- [ ] **Step 4: 实现墙命令**

`packages/core/src/commands/wall.ts`：

```ts
import { uuidv7, type EntityId } from '../ids';
import { assertMm, quantizeMm, type Mm } from '../units/mm';
import type { Document } from '../model/document';
import type { Command } from '../model/command';
import type {
  Entity,
  OpeningEntity,
  PointEntity,
  WallEntity,
} from '../model/entity';

export interface WallCreateInput {
  storeyId: EntityId;
  start: { x: number; y: number };
  end: { x: number; y: number };
  thicknessMm: Mm;
  heightMm: Mm;
  elevationOffsetMm?: Mm;
  loadBearing?: boolean;
  material?: string;
}

function mustExist(doc: Document, id: EntityId, label: string): Entity {
  const entity = doc.get(id);
  if (!entity) throw new TypeError(`${label} 不存在：${id}`);
  return entity;
}

function requireWall(doc: Document, wallId: EntityId): WallEntity {
  const entity = mustExist(doc, wallId, '墙');
  if (entity.kind !== 'wall') throw new TypeError(`${wallId} 不是墙，是 ${entity.kind}`);
  return entity;
}

function requirePoint(doc: Document, id: EntityId, label: string): PointEntity {
  const entity = mustExist(doc, id, label);
  if (entity.kind !== 'point') throw new TypeError(`${label} 不是 point 实体：${id}`);
  return entity;
}

function axisLengthMm(doc: Document, wall: WallEntity): number {
  const a = requirePoint(doc, wall.startId, '墙起点');
  const b = requirePoint(doc, wall.endId, '墙终点');
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** 共享端点与接头吸附属计划 2，这里总是新建两个端点。 */
export function wallCreate(input: WallCreateInput): Command {
  const thicknessMm = assertMm(input.thicknessMm, '墙厚');
  const heightMm = assertMm(input.heightMm, '墙高');
  const elevationOffsetMm = assertMm(input.elevationOffsetMm ?? 0, '标高偏移');
  const x0 = quantizeMm(input.start.x);
  const y0 = quantizeMm(input.start.y);
  const x1 = quantizeMm(input.end.x);
  const y1 = quantizeMm(input.end.y);
  if (x0 === x1 && y0 === y1) {
    throw new RangeError(`零长墙：两端点量化后同为 (${x0}, ${y0})`);
  }
  const lengthMm = Math.hypot(x1 - x0, y1 - y0);
  if (thicknessMm >= lengthMm) {
    throw new RangeError(
      `墙厚 ${thicknessMm} 不小于墙长 ${Math.round(lengthMm)}，轮廓会自相交`,
    );
  }
  return {
    type: 'wall.create',
    build(doc: Document) {
      mustExist(doc, input.storeyId, '楼层');
      const start: PointEntity = { kind: 'point', id: uuidv7(), storeyId: input.storeyId, x: x0, y: y0 };
      const end: PointEntity = { kind: 'point', id: uuidv7(), storeyId: input.storeyId, x: x1, y: y1 };
      const wall: WallEntity = {
        kind: 'wall',
        id: uuidv7(),
        storeyId: input.storeyId,
        startId: start.id,
        endId: end.id,
        thicknessMm,
        heightMm,
        elevationOffsetMm,
        loadBearing: input.loadBearing ?? true,
        material: input.material ?? 'brick',
      };
      return { upsert: [start, end, wall], remove: [] };
    },
  };
}

export function wallSetThickness(input: { wallId: EntityId; thicknessMm: Mm }): Command {
  const thicknessMm = assertMm(input.thicknessMm, '墙厚');
  return {
    type: 'wall.setThickness',
    build(doc: Document) {
      const wall = requireWall(doc, input.wallId);
      if (thicknessMm <= 0) throw new RangeError(`墙厚必须为正，收到 ${thicknessMm}`);
      if (thicknessMm >= axisLengthMm(doc, wall)) {
        throw new RangeError(`墙厚 ${thicknessMm} 不小于墙长，轮廓会自相交`);
      }
      return { upsert: [{ ...wall, thicknessMm }], remove: [] };
    },
  };
}

export function wallMoveEndpoint(input: {
  wallId: EntityId;
  end: 'start' | 'end';
  x: number;
  y: number;
}): Command {
  const x = quantizeMm(input.x);
  const y = quantizeMm(input.y);
  return {
    type: 'wall.moveEndpoint',
    build(doc: Document) {
      const wall = requireWall(doc, input.wallId);
      const moving = requirePoint(doc, input.end === 'start' ? wall.startId : wall.endId, '端点');
      const anchor = requirePoint(doc, input.end === 'start' ? wall.endId : wall.startId, '另一端点');
      if (anchor.x === x && anchor.y === y) {
        throw new RangeError(`零长墙：端点移到与另一端 (${x}, ${y}) 重合`);
      }
      return { upsert: [{ ...moving, x, y }], remove: [] };
    },
  };
}

export function wallDelete(input: { wallId: EntityId }): Command {
  return {
    type: 'wall.delete',
    build(doc: Document) {
      const wall = requireWall(doc, input.wallId);
      const remove: EntityId[] = [wall.id];
      const openings: readonly OpeningEntity[] = doc.byKind('opening');
      for (const opening of openings) {
        if (opening.hostWallId === wall.id) remove.push(opening.id);
      }
      for (const pointId of [wall.startId, wall.endId]) {
        if (!stillReferenced(doc, pointId, wall.id)) remove.push(pointId);
      }
      return { upsert: [], remove };
    },
  };
}

/** 除被删的这面墙之外，还有谁指着这个点。柱与板也要查，否则孤儿判定会误删。 */
function stillReferenced(doc: Document, pointId: EntityId, excludeWallId: EntityId): boolean {
  for (const w of doc.byKind('wall')) {
    if (w.id === excludeWallId) continue;
    if (w.startId === pointId || w.endId === pointId) return true;
  }
  for (const c of doc.byKind('column')) {
    if (c.pointId === pointId) return true;
  }
  for (const s of doc.byKind('slab')) {
    if (s.boundaryPointIds.includes(pointId)) return true;
  }
  return false;
}
```

`packages/core/src/index.ts` 追加：

```ts
export * from './commands/storey';
export * from './commands/wall';
```

注意 `wallCreate` 的几何校验放在**命令构造期**（抛错即不产生事务记录），对 `Document` 的引用检查放在 `build` 里 —— 因为前者不依赖文档状态。`zero 长墙`与`墙厚 ≥ 墙长`两条测试因此可以不调 `.build()` 就断言抛错，而 `wallMoveEndpoint` 的零长检查依赖锚点坐标，必须在 `build` 内。这个分工别混。

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm verify
```

Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add packages/core
git commit -m "feat: 楼层与墙命令，含级联删除与孤儿点回收

删墙连带删其洞口，端点在没有任何墙/柱/板引用时才回收。
零长墙与墙厚≥墙长在命令构造期就拒，不让自相交轮廓进真源。"
```

**执行日志（Task 8）**：Step 1 的红同时打中两道门禁，且暴露清单里三处照抄就过不去的地方：

1. **`toThrow(/厚度/)` 与实现的消息不匹配** —— 抛的是 `墙厚 240 不小于墙长 100，轮廓会自相交`，里面没有"厚度"两个字。这是 Task 6 `/同时/` 的同一类错：正则放宽到"抛了就算过"会失去区分力，所以改成 `/不小于墙长/`（既咬住这条规则，又不会因"零长墙"或"必须是整数毫米"意外通过）。改前先跑了一次，实测 `AssertionError: expected [Function] to throw error matching /厚度/ but got '墙厚 240 不小于墙长…'` —— 先拿到证据再改断言，不是猜。
2. **两处 `build(doc)` 的 `doc` 未使用，被 `noUnusedParameters` 判 TS6133** —— `pnpm typecheck` 报 `commands.test.ts(172,13)` 与 `(207,13)`。改成 `build()`：`Command.build` 允许实现方少写参数。
3. 测试里长行做了换行展开（与 biome/prettier 无关，纯可读性），实现里 `dropOpening` 改名 `openings`。

**补了一条计划没有的测试**：`stillReferenced` 的查柱与查板两条分支在计划里**完全没有被测**（计划 1 没有柱/板命令，但 `wallDelete` 已经依赖它们，漏了就会误删点）。用一条手写的 `column.create` 原始命令补上：柱只挂起点、板只挂终点，使两条分支各自决定一个点的生死 —— 若板同时挂两点，漏查板也能蒙过。

**变异验证（`commands.test.ts` 14 条，每轮单独短路一处，跑完与 `/tmp/wall_backup.ts` diff 确认逐字节还原）**：

| 变异 | 结果 |
| --- | --- |
| A `wallDelete` 不级联洞口 | 1 failed（`删墙级联删其洞口`） |
| B `stillReferenced` 不查柱 | 1 failed（`端点仍被柱或板引用时不回收`） |
| C `stillReferenced` 不查板 | 1 failed（同上） |
| D `wallCreate` 不查零长 | 1 failed（`零长墙抛错`） |
| E `wallCreate` 终点不量化（`x1 = input.end.x`） | 2 failed（`建墙即带出两个端点` + `零长墙抛错`） |

第一轮跑 A–D 时 B、C 的输出是 `Tests no tests` + `PARSE_ERROR`：变异写成了 `if (false)` 后面留着 `return true;` 的悬空体，把文件写坏了，不是测试漏了。改成 `if (false && …)` 后两处各咬 1 条。E 顺带证明"端点量化"这条被两条不同的测试守着。

**仍未覆盖**：`wallSetThickness` 的 `thicknessMm <= 0` 与 `墙厚 ≥ 墙长` 分支、`storeyCreate` 的 `heightMm <= 0` 与 index 非整数分支（计划只测了 index 重复）；柱/板命令本体要等计划 2。实测 `pnpm verify` **65 passed**（前序 51 + 本任务 14）。

---

### Task 9: 属性测试（fast-check）

**Files:**
- Create: `packages/core/test/properties.test.ts`
- Create: `packages/core/test/arbitraries.ts`
- Modify: `package.json` + `pnpm-lock.yaml`（新增 devDependency `fast-check`）

**Interfaces:**
- Consumes: Task 3–8 全部
- Produces: 四条不变式的随机化证明 + `REGRESSIONS` 反例哨兵机制。这四条是 spec 第 10 节里**只靠 core 就能证**的部分；接头闭合、洞口不超出宿主墙这两条要等计划 2 的几何内核（`joint`、沿墙参数化）存在才有主语，届时在同一文件里续写。

1. `quantizeMm` 幂等
2. 任意随机命令序列 `dispatch* → undo*` 后 `canonical()` 与初始逐字节相同
3. `dispatch` 后紧接 `undo` 等价于没发生（单步版，定位更快）
4. 任何时刻文档里所有实体都通过 `Document` 的整数毫米校验（由 `replaceEntities` 保证，用随机序列跑一遍来证明没有旁路）

- [ ] **Step 1: 装依赖并写生成器**

```bash
pnpm add -D -w fast-check
```

`packages/core/test/arbitraries.ts`：

```ts
import fc from 'fast-check';

/** 坐标：整数毫米，范围取真实建房量级 */
export const arbMm = fc.integer({ min: -20_000, max: 20_000 });
export const arbThickness = fc.integer({ min: 50, max: 500 });
export const arbHeight = fc.integer({ min: 1000, max: 6000 });
export const arbWallLength = fc.integer({ min: 2000, max: 12_000 });
export const arbWallAngle = fc.integer({ min: -179, max: 179 });

/**
 * 墙的形状，刻意不用 filter：
 * - 墙长下界 2000 > 墙厚上界 500，"墙厚 ≥ 墙长"的非法输入生成不出来；
 * - 墙长 ≥ 2000 使量化后两端点必不重合，零长墙也生成不出来。
 * 生成器自己就不产非法值，比 filter 掉非法值强：不减速、不触发 no-allocation 告警，
 * 也不会让人误以为"非法值测过了"。
 */
export const arbWallShape = fc
  .tuple(arbMm, arbMm, arbWallLength, arbWallAngle, arbThickness, arbHeight)
  .map(([x, y, len, angleDeg, thicknessMm, heightMm]) => {
    const rad = (angleDeg * Math.PI) / 180;
    return {
      start: { x, y },
      end: {
        x: x + Math.round(len * Math.cos(rad)),
        y: y + Math.round(len * Math.sin(rad)),
      },
      thicknessMm,
      heightMm,
    };
  });
```

`arbOpening` 一类洞口生成器属计划 2（洞口沿墙定位与夹取算法那时才有）。

- [ ] **Step 2: 写失败的测试**

`packages/core/test/properties.test.ts`：

```ts
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  quantizeMm,
  storeyCreate,
  uuidv7,
  wallCreate,
  wallDelete,
  wallMoveEndpoint,
  wallSetThickness,
  type PointEntity,
  type WallCreateInput,
} from '@dajia/core';
import { arbThickness, arbWallShape } from './arbitraries';

type WallShape = Omit<WallCreateInput, 'storeyId'>;

function freshStorey(): { log: TransactionLog; storeyId: string } {
  const projectId = uuidv7();
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  return { log, storeyId: log.document.byKind('storey')[0]!.id };
}

function withStorey(storeyId: string, shape: WallShape): WallCreateInput {
  return { storeyId, ...shape };
}

/**
 * 反例哨兵。随机样本不可复现，属性测试红过之后必须把 Counterexample 抄成写死的用例，
 * 否则下一次改代码它可能再也随机不到。这里先钉两条生成器边界。
 */
const REGRESSIONS: Array<{ note: string; shape: WallShape }> = [
  {
    note: '轴长下界 2000 配墙厚上界 500：thickness < length 的临界仍须放行',
    shape: { start: { x: 0, y: 0 }, end: { x: 2000, y: 0 }, thicknessMm: 500, heightMm: 1000 },
  },
  {
    note: '45° 斜墙：偏移取整后轴长 1999mm，墙厚 500 仍小于它',
    shape: { start: { x: 0, y: 0 }, end: { x: 1414, y: 1414 }, thicknessMm: 500, heightMm: 6000 },
  },
];

describe('反例哨兵', () => {
  it.each(REGRESSIONS)('$note', ({ shape }) => {
    const { log, storeyId } = freshStorey();
    const before = log.document.canonical();
    log.dispatch(wallCreate(withStorey(storeyId, shape)));
    const wall = log.document.byKind('wall')[0]!;
    expect(wall.thicknessMm).toBe(shape.thicknessMm);
    expect(log.undo()).toBe(true);
    expect(log.document.canonical()).toBe(before);
  });
});

describe('不变式 1：quantizeMm 幂等', () => {
  it('有界范围内任意浮点，量化两次与一次相同', () => {
    let executed = 0;
    fc.assert(
      fc.property(fc.double({ min: -1e12, max: 1e12, noNaN: true }), (v) => {
        executed++;
        expect(quantizeMm(quantizeMm(v))).toBe(quantizeMm(v));
      }),
      { numRuns: 2000 },
    );
    expect(executed).toBe(2000);
  });
});

describe('不变式 2：随机命令序列全撤销后逐字节还原', () => {
  it('建若干墙 → 随机改端点/改厚/删墙/加墙 → 全撤 → canonical 回到初始', () => {
    let executed = 0;
    fc.assert(
      fc.property(
        fc.array(arbWallShape, { minLength: 1, maxLength: 8 }),
        fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 0, maxLength: 20 }),
        (shapes, editPicks) => {
          executed++;
          const { log, storeyId } = freshStorey();
          const initial = log.document.canonical();

          for (const shape of shapes) log.dispatch(wallCreate(withStorey(storeyId, shape)));
          expect(log.document.canonical()).not.toBe(initial);

          for (const pick of editPicks) {
            const walls = log.document.byKind('wall');
            if (walls.length === 0) break;
            const target = walls[pick % walls.length]!;
            if (pick === 0) {
              // 相对锚点偏移，保证永不可能与另一端点重合（否则命令层会抛）
              const anchor = log.document.get(target.startId) as PointEntity;
              log.dispatch(
                wallMoveEndpoint({
                  wallId: target.id,
                  end: 'end',
                  x: anchor.x + 1000,
                  y: anchor.y + 700,
                }),
              );
            } else if (pick === 1) {
              log.dispatch(wallSetThickness({ wallId: target.id, thicknessMm: 120 }));
            } else if (pick === 2) {
              log.dispatch(wallDelete({ wallId: target.id }));
            } else {
              log.dispatch(
                wallCreate({
                  storeyId,
                  start: { x: 0, y: 0 },
                  end: { x: 5000, y: 0 },
                  thicknessMm: 240,
                  heightMm: 3000,
                }),
              );
            }
          }

          let guard = 0;
          while (log.canUndo && guard++ < 500) log.undo();
          expect(guard).toBeLessThan(500);
          expect(log.canUndo).toBe(false);
          expect(log.document.canonical()).toBe(initial);
        },
      ),
      { numRuns: 300 },
    );
    expect(executed).toBe(300);
  });
});

describe('不变式 3：单步 dispatch → undo 等价于没发生', () => {
  it('wallCreate 后 undo 回到建墙前', () => {
    fc.assert(
      fc.property(arbWallShape, (shape) => {
        const { log, storeyId } = freshStorey();
        const before = log.document.canonical();
        log.dispatch(wallCreate(withStorey(storeyId, shape)));
        log.undo();
        expect(log.document.canonical()).toBe(before);
      }),
      { numRuns: 300 },
    );
  });

  it('wallSetThickness 后 undo → redo 与不撤销相同', () => {
    fc.assert(
      fc.property(arbWallShape, arbThickness, (shape, thickness) => {
        const { log, storeyId } = freshStorey();
        log.dispatch(wallCreate(withStorey(storeyId, shape)));
        const wall = log.document.byKind('wall')[0]!;
        log.dispatch(wallSetThickness({ wallId: wall.id, thicknessMm: thickness }));
        const after = log.document.canonical();
        expect(log.undo()).toBe(true);
        expect(log.redo()).toBe(true);
        expect(log.document.canonical()).toBe(after);
      }),
      { numRuns: 300 },
    );
  });

  it('wallDelete 后 undo 找回墙与其端点', () => {
    fc.assert(
      fc.property(arbWallShape, (shape) => {
        const { log, storeyId } = freshStorey();
        log.dispatch(wallCreate(withStorey(storeyId, shape)));
        const before = log.document.canonical();
        const wall = log.document.byKind('wall')[0]!;
        log.dispatch(wallDelete({ wallId: wall.id }));
        expect(log.document.canonical()).not.toBe(before);
        log.undo();
        expect(log.document.canonical()).toBe(before);
      }),
      { numRuns: 300 },
    );
  });
});

describe('不变式 4：没有旁路能把非法值写进真源', () => {
  it('随机序列跑完，每个 *Mm 字段都仍是安全整数', () => {
    let executed = 0;
    fc.assert(
      fc.property(fc.array(arbWallShape, { minLength: 1, maxLength: 6 }), (shapes) => {
        executed++;
        const { log, storeyId } = freshStorey();
        for (const shape of shapes) {
          log.dispatch(wallCreate(withStorey(storeyId, shape)));
          const wall = log.document.byKind('wall').at(-1)!;
          const anchor = log.document.get(wall.startId) as PointEntity;
          // 同样用相对锚点偏移：绝对坐标有极小概率正好落在 start 上，命令层会抛零长墙，
          // 那是生成器的运气问题不是被测代码的缺陷，不该让它变成红测试。
          log.dispatch(
            wallMoveEndpoint({ wallId: wall.id, end: 'end', x: anchor.x - 800, y: anchor.y + 1500 }),
          );
          const grown = log.document.byKind('wall').at(-1)!;
          log.dispatch(wallSetThickness({ wallId: grown.id, thicknessMm: 50 }));
        }
        for (const entity of log.document.entities.values()) {
          const record = entity as unknown as Record<string, unknown>;
          for (const [key, value] of Object.entries(record)) {
            if (!key.endsWith('Mm')) continue;
            expect(typeof value).toBe('number');
            expect(Number.isSafeInteger(value)).toBe(true);
          }
        }
      }),
      { numRuns: 200 },
    );
    expect(executed).toBe(200);
  });
});
```

`expect(executed).toBe(300)` 这一类硬计数断言是**防空跑**的：fast-check 在生成器退化或 filter 过严时会少跑甚至不跑 property 体，而 `fc.assert` 本身对此静默 —— 少跑一次不变式测试，看起来跟全跑过一样绿。

- [ ] **Step 3: 跑测试确认它抓到东西**

```bash
pnpm vitest run packages/core/test/properties.test.ts
```

Expected: 初跑大概率**红**。红色才是这一步的收获。若真红，做两件事：

1. 把报错里的 `Counterexample:` 那组值原样抄成 `REGRESSIONS` 数组的一条（`note` 写清为什么危险），让它从此变成写死的用例；
2. 修 `packages/core/src` 里的代码，**不要**放宽生成器或改小 `numRuns` 让它变绿。

一条典型的预期失败：`undo` 链走到某次 `wallDelete` 后，被回收的端点 id 又被另一面共享该点的墙引用 —— 那是级联删除的引用扫描漏了一种 kind，补 `stillReferenced` 而不是在测试里跳过。

- [ ] **Step 4: 确认全绿且样本量不是空转**

```bash
pnpm verify
```

Expected: 全绿。

**空跑自查**（这一步不能省，否则"绿"可能意味着一次都没跑）：把"不变式 2"的 `numRuns` 临时改成 `1000`，Expected: `expect(executed).toBe(300)` 立刻**失败** —— 证明那条硬计数断言确实在数样本，而不是恒真。改回 `300` 再跑一次 `pnpm vitest run packages/core/test/properties.test.ts`，Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core pnpm-lock.yaml package.json
git commit -m "test: 核心不变式的属性测试

随机命令序列撤销后 canonical 逐字节还原；任何旁路都写不进非整数毫米。
这类断言手写用例覆盖不到，正是属性测试存在的理由。"
```

---

### Task 10: Electron 壳与 CI

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/tsconfig.node.json`
- Create: `apps/desktop/electron.vite.config.ts`
- Create: `apps/desktop/electron-builder.yml`
- Create: `apps/desktop/src/main/index.ts`
- Create: `apps/desktop/src/preload/index.ts`
- Create: `apps/desktop/src/renderer/index.html`
- Create: `apps/desktop/src/renderer/src/main.tsx`
- Create: `apps/desktop/src/renderer/src/App.tsx`
- Create: `packages/protocol/src/ipc.ts`
- Modify: `packages/protocol/src/index.ts`
- Create: `packages/protocol/test/ipc.test.ts`
- Modify: `vitest.config.ts`（加 `@dajia/protocol` alias）
- Modify: `package.json`（根 `typecheck` 扩到多包）
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `@dajia/core`（main 进程侧冒烟使用）
- Produces: `IPC` 常量表（`IPC.ping = 'dajia:ping'`）、`window.dajia.ping(): Promise<string>`（主进程实回 `` `pong:${CORE_SCHEMA_VERSION}` ``，即 `'pong:1'`）、可构建的 Electron 三入口、`pnpm verify` + GitHub Actions

计划 4 的持久化接口就挂在这条 preload 通道旁边，所以契约表先立起来。

**本任务不引入 zod**：spec 4.3 要求"IPC 消息在两侧均由 `@dajia/protocol` 的 zod schema 校验"，而 `ping` 没有消息体可校验。schema 与两侧校验随计划 4 的第一条带载荷的消息一起落地，届时 `@dajia/protocol` 才需要 `zod` 依赖。

- [ ] **Step 1: 建 desktop 包，再装它的依赖**

先写 `apps/desktop/package.json`（`--filter` 要求包已存在于 workspace 里，顺序反了会报 `No projects matched`）：

```json
{
  "name": "@dajia/desktop",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "start": "electron-vite preview",
    "dist": "electron-builder",
    "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.node.json"
  },
  "dependencies": {
    "@dajia/core": "workspace:*",
    "@dajia/protocol": "workspace:*"
  }
}
```

`vitest.config.ts` 的 `resolve.alias` 加：

```ts
      '@dajia/protocol': fileURLToPath(new URL('./packages/protocol/src/index.ts', import.meta.url)),
```

装依赖（`apps/desktop/package.json` 存在之后才跑）：

```bash
pnpm --filter @dajia/desktop add react react-dom
pnpm --filter @dajia/desktop add -D electron electron-vite electron-builder @vitejs/plugin-react typescript @types/react @types/react-dom
```

`@types/*` 装进 desktop 包而不是根：pnpm 不做提升，装在根上时 `apps/desktop` 里的 tsc 要靠向上找 `node_modules/@types` 才看得到，换个包就失效。

Expected: 三条命令均成功。把解析到的精确版本抄进执行日志；Electron 首次会下载约 100MB，失败就报出来，不要跳过这一步。

- [ ] **Step 2: 写 IPC 契约与它的测试**

`packages/protocol/src/ipc.ts`：

```ts
export const IPC = {
  ping: 'dajia:ping',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

export function isIpcChannel(value: unknown): value is IpcChannel {
  return typeof value === 'string' && Object.values(IPC).includes(value as IpcChannel);
}
```

`packages/protocol/test/ipc.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { IPC, isIpcChannel } from '@dajia/protocol';

describe('IPC 通道表', () => {
  it('通道名一律带 dajia: 前缀，不与三方库撞名', () => {
    for (const channel of Object.values(IPC)) {
      expect(channel.startsWith('dajia:')).toBe(true);
    }
  });

  it('无重复通道名', () => {
    const values = Object.values(IPC);
    expect(new Set(values).size).toBe(values.length);
  });

  it('isIpcChannel 只认表内通道', () => {
    expect(isIpcChannel(IPC.ping)).toBe(true);
    expect(isIpcChannel('dajia:nope')).toBe(false);
    expect(isIpcChannel(undefined)).toBe(false);
  });
});
```

`packages/protocol/src/index.ts`：

```ts
export const PROTOCOL_PACKAGE = 'protocol';

export * from './ipc';
```

```bash
pnpm vitest run packages/protocol/test/ipc.test.ts
```

Expected: PASS。

- [ ] **Step 3: 三入口**

`apps/desktop/src/main/index.ts`：

```ts
import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { CORE_SCHEMA_VERSION } from '@dajia/core';
import { IPC } from '@dajia/protocol';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    title: '搭家',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  ipcMain.removeHandler(IPC.ping);
  ipcMain.handle(IPC.ping, () => `pong:${CORE_SCHEMA_VERSION}`);

  void win.once('ready-to-show', () => win.show());
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

`apps/desktop/src/preload/index.ts`：

```ts
import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '@dajia/protocol';

export interface DajiaApi {
  ping(): Promise<string>;
}

const api: DajiaApi = {
  ping: () => ipcRenderer.invoke(IPC.ping) as Promise<string>,
};

contextBridge.exposeInMainWorld('dajia', api);
```

`apps/desktop/src/renderer/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>搭家</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/desktop/src/renderer/src/main.tsx`：

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`apps/desktop/src/renderer/src/App.tsx`：

```tsx
import { useEffect, useState } from 'react';
import type { DajiaApi } from '../preload/index';

declare global {
  interface Window {
    dajia: DajiaApi;
  }
}

export default function App(): React.JSX.Element {
  const [reply, setReply] = useState('未连接主进程');

  useEffect(() => {
    let alive = true;
    window.dajia
      .ping()
      .then((value) => {
        if (alive) setReply(value);
      })
      .catch((err: unknown) => {
        if (alive) setReply(`主进程无响应：${String(err)}`);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui', padding: 24 }}>
      <h1>搭家</h1>
      <p>主进程应答：{reply}</p>
    </main>
  );
}
```

`apps/desktop/electron.vite.config.ts`：

```ts
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {},
  preload: {},
  renderer: { plugins: [react()] },
});
```

`apps/desktop/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": ["node", "vite/client"]
  },
  "include": ["src/main", "src/preload", "src/renderer/src"],
  "exclude": ["src/renderer/index.html"]
}
```

`apps/desktop/tsconfig.node.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["electron.vite.config.ts"]
}
```

`apps/desktop/electron-builder.yml`（本任务只保证 `dist:mac: false` 之类不影响构建；签名开关按计划走 (c) 关着）：

```yaml
appId: com.dajia.desktop
productName: 搭家
directories:
  output: release
files:
  - out/**
  - package.json
win:
  target: nsis
nsis:
  oneClick: false
  perMachine: true
  allowToChangeInstallationDirectory: true
  artifactName: ${productName}-Setup-${version}.${ext}
```

这里刻意**不写** `win.icon`：`apps/desktop/build/icon.ico` 现在不存在，写了会让 `pnpm dist` 在打包阶段直接失败。图标与签名一起排在计划 4 之后（spec 13 条 4 取的 (c)：先不签名，配图文安装说明）。本任务只跑 `electron-vite build`，不跑 `electron-builder`，所以 yml 只需语法成立。

- [ ] **Step 4: 扩根门禁并跑全量**

`package.json` 的 `scripts` 改为（typecheck 覆盖全部包）：

```json
    "typecheck": "tsc --noEmit -p packages/core/tsconfig.json && pnpm --filter @dajia/desktop typecheck && tsc --noEmit -p packages/protocol/tsconfig.json",
    "build": "pnpm --filter @dajia/desktop build"
```

`packages/protocol/tsconfig.json`（新建，与 core 同构）：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2023"] },
  "include": ["src", "test"]
}
```

```bash
pnpm verify
pnpm --filter @dajia/desktop build
```

Expected: `pnpm verify` 全绿；build 产出 `apps/desktop/out/{main,preload,renderer}`。

若 electron-vite 报 preload 扩展名不匹配（`.js` vs `.mjs`），以 `out/preload/` 实际产物为准修正 main 里的 preload 路径，并把结论记进本任务执行日志 —— 不要留着猜。

- [ ] **Step 5: 写 CI**

`.github/workflows/ci.yml`：

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 11
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm verify
      - run: pnpm --filter @dajia/desktop build
```

- [ ] **Step 6: 提交（并如实记录未验证项）**

```bash
git add apps packages vitest.config.ts package.json .github
git commit -m "feat: Electron 壳与 CI

main/preload/renderer 三入口接通，ping/pong 证明 IPC 通路可用；
@ 通道表立在 @dajia/protocol，计划 4 的持久化接口挂旁边。
CI 跑 pnpm verify + 桌面构建。

未验证：窗口真实打开与渲染（需人工执行 pnpm dev 目测），
electron-builder 出安装包（排在计划 4 之后一起做）。"
```

```bash
git status --short
```

Expected: 干净（`.gitignore` 已忽略 `out/`、`release/`、`node_modules/`）。

---

## Self-Review

**1. Spec 覆盖**：本计划对应 M1.0 全部（workspace、electron-vite、依赖方向守卫、CI）与 M1.1 的前半（实体模型、command 层与撤销、`quantize`）。M1.1 剩下的"轴线→轮廓与接头派生、AABB 索引、几何不变式属性测试"明确归计划 2。`opening.create`/`opening.move`/`opening.delete`/`column.create`/`slab.create` 的命令本体也归计划 2（它们要等洞口沿墙定位与夹取算法）。**Task 8 只交付墙与楼层命令，是本计划的边界。**

**2. 占位符**：全文无 TBD / "适当处理" / "留给实现者"。初稿里我自己埋的四处省事写法已在本轮自检中改写进正文，不留尾账：Task 2 的"未知包目录抛错"原来是主代码块之后的一段补述（要实现者自己拼进 `findViolations`，且测试 4 依赖它），现已写成 `assertNoUnknownPackages()` 并接在函数首行；Task 8 的 `void doc;` 与 `EntityId as _Id` 已删除；Task 9 原"不变式 3"含恒真自比较断言与 `void dx/dy/thickness`，已换成三条真断言，生成器的 `filter` 也改成靠下界构造排除非法值；Task 9 Step 4 原来让人"另加一条硬断言"，而测试里已经有 `executed` 计数器，改成了一条能证明该计数器非恒真的自查步骤。

**3. 类型一致性**：`Mm`/`assertMm`/`quantizeMm` 自 Task 3 起贯穿；`Document.replaceEntities(doc, Map)` 签名在 Task 5 定义、6/7/8/9 使用一致；`Patch = { upsert: readonly Entity[]; remove: readonly EntityId[] }` 在 Task 6 定义后，Task 7 的 `affectedIds`、Task 8 的各 `build` 返回、Task 9 的测试全部按它写；`Command.build(doc): Patch` 一致；`TransactionLog.affected` 在 Task 7 定义、Task 8 测试 `toEqual(new Set([w.endId]))` 使用一致；`type EntityId = string`（Task 4），所以 Task 9 里 `storeyId: string` 的辅助函数签名成立。`WallCreateInput`/`StoreyCreateInput` 由 Task 8 导出，Task 9 以 `Omit<WallCreateInput, 'storeyId'>` 复用。

本轮另外查出的两处**会导致直接失败**的问题也一起改了：Task 1 的 `tsconfig.base.json` 原先没有 `paths`，而包 `exports` 指向 `.ts` 源文件，tsc 走软链解析这种目标是未定义行为，smoke 测试会在第一道门禁就红；Task 10 原先要求先 `pnpm --filter @dajia/desktop add`（包还不存在，必然 `No projects matched`），且 `electron-builder.yml` 引用了不存在的 `build/icon.ico`。

**4. 已知的执行期风险（写在明处，不假装没有）**

- `noUnusedParameters` + `verbatimModuleSyntax` 会在我几处省事写法上报错；这是好事，按提示改。
- `import.meta.dirname` 需 Node 20.11+，本机 24 满足；electron-vite 打包后是否保留该语义要在 Step 4 实测。
- **源码直连的打包风险**：包 `exports` 指向 `.ts`，Electron 侧要靠 vite/esbuild 转译 node_modules 里的 workspace 软链目标。若 `pnpm --filter @dajia/desktop build` 报 "failed to resolve @dajia/core" 或把 `.ts` 原样丢进产物，解法是在 `electron.vite.config.ts` 的 `main`/`preload` 里加 `resolve.alias` 指向 `packages/core/src/index.ts`（与 vitest 同一招），并把结论记进执行日志 —— 不许改成"先给 core 出一份编译产物"，那会推翻 D2 的源码直连决定。
- **`typescript@7` 是新主版本**（本机 `npm view typescript dist-tags` 实测 `latest = 7.0.2`，`6.0.3` 仍可选）。**Task 1 已命中它**：TS7 移除了 `baseUrl`（`TS5102`）并要求 `paths` 值以 `./` 起头（`TS5090`），配置已按实测改好；`tsc` 二进制名未变。暂不需要退到 `^6`，真退时把实际主版本记进 spec 第 12 节。
- Electron 首次装会下载 ~100MB，网络代理下可能失败 —— 失败时报出来，不要退到"跳过这一步"。
- 属性测试若长期跑不动（>60s），降 `numRuns` 而不是删不变式，并在 commit message 里记下实际值；`executed` 的硬计数断言要同步改，否则它会以"期望 300 实际 1000"的方式红。
