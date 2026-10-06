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
  pdf: 'packages/pdf',
};

/** D2b：core 为真源，三个消费方互不相识 */
export const ALLOWED_DEPS = {
  core: [],
  protocol: [],
  drawing: ['core'],
  'scene-2d': ['core', 'protocol'],
  'scene-3d': ['core', 'protocol'],
  desktop: ['core', 'drawing', 'scene-2d', 'scene-3d', 'protocol'],
  pdf: ['drawing'],
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
