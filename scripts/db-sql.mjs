// 把迁移正文按版本打到 stdout，给"没装 mysql CLI、但要手敲 SQL"的运维通路（P-11 的代价缓解）。
// 用法：pnpm db:sql            全打
//       pnpm db:sql 2         只打第 2 版
// 它**只读**镜像文件，不碰数据库 —— 别把它当成"执行迁移"的另一个入口。
//
// 为什么读的是 `apps/desktop/src/main/db/migrations/*.sql` 而不是 `migrations.ts`：
// ① 真身是内联常量（P-11），但裸 `node` 引不到仓库里的 `.ts`（本仓已知：无扩展名相对导入
//    `--experimental-strip-types` 也解析不到），给这一发套一层 bundler 不值；
// ② 于是散文件是**镜像**，`migrations.ts` 仍是唯一真身；
// ③ 重复由 `apps/desktop/test/unit/migrations-sql-mirror.test.ts` 逐字节钉住（进 `pnpm verify`），
//    漂了就红 —— 这条比"记得两边都改"硬，因为它把重复变成了判据。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../apps/desktop/src/main/db/migrations', import.meta.url));
const FILE_RE = /^(\d+)_(.+)\.sql$/;

const files = readdirSync(DIR)
  .map((f) => {
    const m = FILE_RE.exec(f);
    return m ? { file: f, version: Number(m[1]), name: m[2] } : null;
  })
  .filter((e) => e !== null)
  .sort((a, b) => a.version - b.version);

const wanted = process.argv[2];
if (wanted === undefined) {
  for (const e of files) process.stdout.write(`-- ===== version ${e.version}: ${e.name} (${e.file}) =====\n${read(join(DIR, e.file))}`);
} else {
  const version = Number(wanted);
  const hit = files.find((e) => Number.isInteger(version) && e.version === version);
  if (!hit) {
    process.stderr.write(
      `db:sql 里没有第 ${wanted} 版：已有 ${files.map((e) => `${e.version} (${e.name})`).join(' / ') || '（一个都没有）'}\n`,
    );
    process.exit(2);
  }
  process.stdout.write(read(join(DIR, hit.file)));
}

/** 原样输出：一行不改、末尾那个换行也不改 —— 这份要能逐字贴进 mysql 客户端。 */
function read(path) {
  return readFileSync(path, 'utf8');
}
