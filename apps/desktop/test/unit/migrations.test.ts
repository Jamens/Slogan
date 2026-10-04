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

  it('全仓不许出现第二个库名以外的 CREATE/DROP DATABASE（护栏唯一产地）', () => {
    for (const m of MIGRATIONS) {
      expect(m.sql).not.toMatch(/CREATE DATABASE|DROP DATABASE/i);
    }
  });
});
