// 只读回环自检（Plan 4 Task 3 修复轮 C1 的回环判据）：
// `model/invariants.ts` 的**传递相对 import** 不许碰到 `commands/**` ——
// `assertWallShape` 搬进 invariants 之后，`commands/wall.ts → model/invariants.ts` 必须是单向边，
// 否则"唯一产地"变成互相，ESM 初始化期循环也会跟着复活。
// 本脚本不写任何文件、不改任何代码；退出码 0 = 无环。用法：node scripts/check-invariants-cycle.mjs
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

const START = resolve('packages/core/src/model/invariants.ts');
const seen = new Set();
const queue = [START];
while (queue.length > 0) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/from\s*'(\.[^']*)'/g)) {
    const base = resolve(dirname(file), m[1]);
    const found = [`${base}.ts`, resolve(base, 'index.ts')].find((c) => existsSync(c));
    if (found === undefined) throw new Error(`解析不到 import：${m[1]}（来自 ${file}）`);
    queue.push(found);
  }
}
const visited = [...seen].map((f) => f.split(sep).join('/')).sort();
const offenders = visited.filter((f) => f.includes('/commands/'));
console.log(`已扫 ${String(visited.length)} 个文件（自 model/invariants.ts 的传递 import 闭包）：`);
for (const f of visited) console.log(`  ${f}`);
if (offenders.length > 0) {
  console.error(`回环：model/invariants.ts 的传递 import 触到了 commands/**：\n${offenders.join('\n')}`);
  process.exit(1);
}
console.log('无环：model/invariants.ts 的传递 import 不碰 commands/**（commands/wall.ts → model/invariants.ts 是单向边）。');
