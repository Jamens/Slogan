import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../src/main/db/migrations';

/**
 * 这一档不连库，专挑"进 SQL 文件里最容易漂、又只有跑起来才发现"的三件事：
 * 版本序连续、校验和与文本自洽、每张表都带 utf8mb4 与 IF NOT EXISTS（P-11 的可重放前提）。
 */
describe('迁移清单的结构', () => {
  it('版本从 1 开始连续、名字唯一', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
    const names = MIGRATIONS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('checksum 是正文的 sha256（改过已应用的迁移必须在 runner 之前就被发现）', () => {
    for (const m of MIGRATIONS) {
      const computed = createHash('sha256').update(m.sql, 'utf8').digest('hex');
      expect(m.checksum, `迁移 ${m.version} ${m.name} 的校验和与正文不符`).toBe(computed);
    }
  });

  it('001 建齐 spec §8.1 点名的六张表，且每张都 IF NOT EXISTS + utf8mb4', () => {
    const first = MIGRATIONS[0];
    if (!first) throw new TypeError('没有 001 迁移');
    for (const table of ['project', 'storey', 'element', 'command_log', 'snapshot', 'asset']) {
      const re = new RegExp(`CREATE TABLE IF NOT EXISTS \`${table}\`[\\s\\S]*?DEFAULT CHARSET=utf8mb4`, 'm');
      expect(first.sql, `表 ${table} 没建成 IF NOT EXISTS + utf8mb4 的形状`).toMatch(re);
    }
    // 生成列（spec §8.1 的 kind / loadBearing）必须写在 payload 上而不是复制列 —— P-8 的落点
    // **实测订正**（Task 2）：两条正则原来写成不带反引号的 `kind VARCHAR` / `load_bearing INT`，
    // 而 001 的 DDL 里标识符**全体带反引号**（上面那条表名判据也是这么写的）——照原文这一格永远红。
    // 改的是正则去贴 DDL，不是反过来：SQL 正文是要进 git 永不再改的那一份。
    expect(first.sql).toMatch(/`kind` VARCHAR\(\d+\) GENERATED ALWAYS AS[\s\S]*STORED/);
    expect(first.sql).toMatch(/`load_bearing` .*GENERATED ALWAYS AS[\s\S]*STORED/);
  });

  /**
   * **P-49 的静态那一半**（连库那一半在 `test/db/migrate.test.ts` 里读 `information_schema`）。
   * 上面两条正则止于 `STORED`，**不看 collation**，而且 `[\s\S]*` 无上界 —— 审查 C 节点名的两个洞
   * （kind 若写成 VIRTUAL，后面别张表的 STORED 会让它假绿；口径漂回 utf8mb4 它完全不响）。
   * 这一格把 `kind` 那一列钉到"STORED 之后紧跟 COLLATE ascii_bin NOT NULL"，且把匹配关在一条语句之内。
   * 注释行先剥掉：001 在 `STORED` 与 `COLLATE` 之间插了四行实测说明（C4b 的现场），那是给人读的，
   * 不该参与"口径有没有漂"的判据。
   */
  it('kind 生成列的字符集口径写死成 STORED COLLATE ascii_bin（P-49 的静态证人）', () => {
    const first = MIGRATIONS[0];
    if (!first) throw new TypeError('没有 001 迁移');
    const noComments = first.sql.replace(/--[^\n]*/g, '');
    expect(noComments).toMatch(
      /`kind` VARCHAR\(\d+\) GENERATED ALWAYS AS[^;]*?\)\s*STORED\s+COLLATE ascii_bin NOT NULL/,
    );
    // 反面形状：整份正文里不许出现"生成列后面接 CHARACTER SET"那种跑不通的写法（冲突 C4b 的实测结论）
    expect(noComments).not.toMatch(/STORED\s+CHARACTER SET/);
  });

  it('全仓不许出现第二个库名以外的 CREATE/DROP DATABASE（护栏唯一产地）', () => {
    for (const m of MIGRATIONS) {
      expect(m.sql).not.toMatch(/CREATE DATABASE|DROP DATABASE/i);
    }
  });
});
