import { describe, expect, it } from 'vitest';
import { readMysqlEnv } from '../../src/main/db/env';

/**
 * 这一档是 `test/db/env.test.ts` 第 3 格的**复制品**，不是重复劳动（裁决 P-43）。
 *
 * 为什么两份：`readMysqlEnv` 的"缺变量就点名抛"是**红线级**判据（Global Constraints：
 * 静默跳过的集成测试等于没有测试），可它原来只住在 `test/db/**` —— 而 db 档**不进 `pnpm verify`**
 * （CI 的 ubuntu runner 没有 MySQL，也没有口令）。于是有人把 `throw` 改回"没配就返回一份默认参数"
 * （变异 M3 那一型）时，CI 一句都不红，红线在 CI 上是零覆盖。
 *
 * 这一格喂的是**假 env 对象**，不连库、不读 `process.env`，所以它能进 unit 档 —— 搬进来得零成本。
 *
 * 两份的连带代价是有意的：**改这条判据时两处会一起红**。这不是摩擦，是这条红线该有的样子。
 * `test/db` 那一份也不删 —— 它守的是"`pnpm test:db` 在真连库通路上确实会响亮失败"，
 * 与这一格守的"`readMysqlEnv` 这个函数不会静默"是两件事。
 */
const FAKE_ENV = {
  DAJIA_MYSQL_HOST: '127.0.0.1',
  DAJIA_MYSQL_PORT: '3306',
  DAJIA_MYSQL_USER: 'u',
  DAJIA_MYSQL_PASSWORD: 'p',
  DAJIA_MYSQL_DATABASE: 'dajia_test',
};

describe('readMysqlEnv：缺配置必须响亮失败（CI 通道里的红线证人，P-43）', () => {
  it('缺任何一个变量就抛，且文案点名叫哪个（不许变成 skip）', () => {
    for (const name of Object.keys(FAKE_ENV)) {
      const env = { ...FAKE_ENV } as Record<string, string>;
      delete env[name];
      expect(() => readMysqlEnv(env)).toThrow(new RegExp(name));
    }
  });

  it('空串与全缺同等对待（`""` 是一个合法的环境变量值，却同样连不上库）', () => {
    for (const name of Object.keys(FAKE_ENV)) {
      const env = { ...FAKE_ENV, [name]: '' };
      expect(() => readMysqlEnv(env)).toThrow(new RegExp(name));
    }
    // 五个全空 ⇒ 一次报齐，而不是修一个再撞一个。
    expect(() => readMysqlEnv({})).toThrow(/DAJIA_MYSQL_HOST.*DAJIA_MYSQL_PORT.*DAJIA_MYSQL_USER.*DAJIA_MYSQL_PASSWORD.*DAJIA_MYSQL_DATABASE/);
  });

  it('形状不对也抛：端口越界、库名不是搭家的', () => {
    expect(() => readMysqlEnv({ ...FAKE_ENV, DAJIA_MYSQL_PORT: '0' })).toThrow(/DAJIA_MYSQL_PORT/);
    expect(() => readMysqlEnv({ ...FAKE_ENV, DAJIA_MYSQL_PORT: '70000' })).toThrow(/DAJIA_MYSQL_PORT/);
    expect(() => readMysqlEnv({ ...FAKE_ENV, DAJIA_MYSQL_PORT: '3306abc' })).toThrow(/DAJIA_MYSQL_PORT/);
    expect(() => readMysqlEnv({ ...FAKE_ENV, DAJIA_MYSQL_DATABASE: 'smartscrm' })).toThrow(/不是搭家的库/);
  });

  it('配齐了就返回**已消毒**的形状：port 是 number、database 过了白名单', () => {
    const env = readMysqlEnv({ ...FAKE_ENV });
    expect(env).toEqual({ host: '127.0.0.1', port: 3306, user: 'u', password: 'p', database: 'dajia_test' });
    // 这一格同时挡住"把口令悄悄塞进日志"的那一型：返回值里 password 是**字段**，
    // 而 `MysqlEnv` 没有 toString，谁要打整份对象就得显式点它的名。
    expect(Object.keys(env).sort()).toEqual(['database', 'host', 'password', 'port', 'user']);
  });
});
