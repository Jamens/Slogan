import { describe, expect, it } from 'vitest';
import { ALLOWED_DATABASES, assertDatabaseName } from '../../src/main/db/db-safety';

describe('库名白名单（授权红线）', () => {
  it('放行的两个名字逐字命中', () => {
    expect([...ALLOWED_DATABASES].sort()).toEqual(['dajia', 'dajia_test']);
    expect(assertDatabaseName('dajia')).toBe('dajia');
    expect(assertDatabaseName('dajia_test')).toBe('dajia_test');
  });

  it('别人的库一律抛，且文案点名它不是我们的库', () => {
    for (const name of ['smartscrm', 'smartscrm_react', 'flowmart', 'ledger_db', 'mysql', 'information_schema']) {
      expect(() => assertDatabaseName(name)).toThrow(/不是搭家的库/);
    }
  });

  it('大小写、空白、后缀注入都不放过（lower_case_table_names=1 不代表能少查一遍）', () => {
    for (const bad of ['DAJIA', ' dajia', 'dajia ', 'dajia;DROP', 'dajia_test2', '', 'null', 'undefined']) {
      expect(() => assertDatabaseName(bad)).toThrow(/不是搭家的库/);
    }
  });

  it('非字符串也抛（env 里读出来的一切都是 string 或 undefined）', () => {
    for (const bad of [undefined, null, 42, {}, ['dajia']]) {
      expect(() => assertDatabaseName(bad)).toThrow(/不是搭家的库/);
    }
  });
});
