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
 *
 * 四格各守一种破法，别把它们当同一件事（复审席第 3 题要求的分层，写死在这里）：
 *  - 格 1 是变异 M3 的证人 —— 把 `throw` 换成"没配就返回默认参数"，红的就是它。
 *  - 格 2 守"空串也算缺"和"一次报齐"：只查第一个就返回的写法在这里红，格 1 察觉不到。
 *  - 格 3 守形状校验（端口区间/整数、库名白名单）—— 与 M3 正交，删 `throw` 打不到它。
 *  - 格 4 守返回形状的**消毒**（见那一格的注释）。
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
    // **逐名断，不用一条整串正则**：整串正则（`/HOST.*PORT.*USER.*PASSWORD.*DATABASE/`）
    // 会把 `NAMES` 的**顺序**一起焊死，而顺序不是判据 —— 把 `DAJIA_MYSQL_PORT` 挪到名单第一位
    // 不是破线，却会让这一格假红（复审席第 2 题的脆性）。"一次报齐"要证的是五个名字**都在同一条
    // 消息里出现**，不是它们按某个顺序出现。
    const allMissing = (() => {
      try {
        readMysqlEnv({});
      } catch (error) {
        return (error as Error).message;
      }
      throw new TypeError('五个变量全缺却没抛 —— 这一格的前提本身被改掉了');
    })();
    for (const name of Object.keys(FAKE_ENV)) expect(allMissing).toContain(name);
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
    // 这一格证的是"返回值是**五个键的构造投影**，不是 `return { ...env }` 那种直通"。
    // 直通为什么要紧：`readMysqlEnv()` 的默认入参就是 `process.env`，直通等于把**整台机器的环境袋**
    // 挂进返回值 —— 那里面不止这一份口令，还有别的项目的变量（本机实测 15 个用户库的主人都在用）。
    // 之后任何一处 `console.log(config)` 都把它们一起吐进日志。那是设计红线拦的事（P-27 一侧）。
    // `toEqual` 对**多出来的键**本来就红，所以下面这行不是第二道强度，是第二句**人话**：
    // 它红的时候直接点名多出来的是哪个键，而 `toEqual` 只说 "Object with extra keys"。
    expect(Object.keys(env).sort()).toEqual(['database', 'host', 'password', 'port', 'user']);
  });
});
