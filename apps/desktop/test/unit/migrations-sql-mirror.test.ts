import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../src/main/db/migrations';

/**
 * P-11 的 ② 方案落地：迁移正文的**真身**是 `migrations.ts` 里的内联常量，
 * `apps/desktop/src/main/db/migrations/*.sql` 只是给运维手敲用的镜像（`pnpm db:sql` 读它）。
 * 一份内容存在两处永远是会漂的，所以这里逐字节钉住：镜像漂了 ⇒ 这一格红（进 `pnpm verify`，CI 有牙）。
 * 反向也要守：目录里多出一个没登记进 MIGRATIONS 的 `.sql` 同样红 —— 否则"镜像"会变成第二个真相。
 */
const DIR = fileURLToPath(new URL('../../src/main/db/migrations', import.meta.url));
const FILE_RE = /^(\d+)_(.+)\.sql$/;

describe('迁移正文与散文件镜像逐字节相同', () => {
  it('每个版本一份镜像，内容一字不差，目录里也不许多出没登记的文件', () => {
    const expected = MIGRATIONS.map((m) => ({
      file: `${String(m.version).padStart(3, '0')}_${m.name}.sql`,
      bytes: Buffer.from(m.sql, 'utf8'),
    }));
    const mirrorFiles = readdirSync(DIR)
      .filter((f) => FILE_RE.test(f))
      .sort();
    expect(mirrorFiles, '镜像目录里的文件清单与 MIGRATIONS 对不上（多出来或缺一份）').toEqual(
      expected.map((e) => e.file),
    );

    for (const e of expected) {
      const onDisk = readFileSync(`${DIR}/${e.file}`);
      expect(onDisk.equals(e.bytes), `镜像 ${e.file} 与内联正文不是逐字节相同`).toBe(true);
    }
  });
});
