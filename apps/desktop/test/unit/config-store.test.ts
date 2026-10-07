import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigRecordSchema, type ConfigRecord, type ConnectionInput } from '@dajia/protocol';
import {
  CONFIG_FILE_NAME,
  ConfigError,
  configToEnv,
  probeConfig,
  readConfig,
  writeConfig,
  type ByteCipher,
} from '../../src/main/persist/config-store';

/** 哨兵串：它必须出现在"读回来的 record"里，又必须不出现在盘上、回显与任何 message 里。 */
const SENTINEL = 'SUP3R-SENTINEL-9';

const INPUT: ConnectionInput = {
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: SENTINEL,
};

/**
 * 假 cipher：base64 往返 + 一个**显式前缀**。
 * 前缀不是为了安全（base64 谁都解得开），是为了让"写盘有没有经过 cipher"这一件事
 * 在字节上可见 —— 少了它，`writeFileSync(path, JSON.stringify(record))` 这种破口
 * 在这一族判据里会全绿（因为读得回来、也没有 SENTINEL 之外的差异）。
 */
class FakeCipher implements ByteCipher {
  readonly calls: string[] = [];
  available = true;
  /** 让 decrypt 抛，且抛的 message 里带着 SENTINEL（P-29 的靶子）。 */
  decryptThrows = false;

  encrypt(text: string): Uint8Array {
    this.calls.push('encrypt');
    return new TextEncoder().encode(`ENC::${Buffer.from(text, 'utf8').toString('base64')}`);
  }

  decrypt(bytes: Uint8Array): string {
    this.calls.push('decrypt');
    if (this.decryptThrows) throw new Error(`bad ciphertext near ${SENTINEL}`);
    const text = new TextDecoder().decode(bytes);
    if (!text.startsWith('ENC::')) throw new Error('不是这个 cipher 写的那份东西');
    return Buffer.from(text.slice('ENC::'.length), 'base64').toString('utf8');
  }
}

let dir = '';
let cipher: FakeCipher;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dajia-config-'));
  cipher = new FakeCipher();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 盘上那份文件的**当前路径**（三格共用：拼法只许有一处，与产品代码同一个常量）。 */
const target = () => join(dir, CONFIG_FILE_NAME);

/** 盘上那份文件的原始字节（latin1 读出，好让"搜子串"判的是字节而不是解码后的形状）。 */
function rawBytes(): string {
  return readFileSync(target()).toString('latin1');
}

/** 人造一份"看起来像我们写的、内容却不对"的文件：格 7 的三个样本走这条路，不借 cipher。 */
function plant(text: string): void {
  writeFileSync(target(), Buffer.from(`ENC::${Buffer.from(text, 'utf8').toString('base64')}`, 'latin1'));
}

describe('probeConfig：首屏的三种形状', () => {
  it('1. 没配 ⇒ unset、四个回显格全 null、不抛，且盘上确实没有那个文件', () => {
    expect(probeConfig(dir, cipher)).toEqual({
      state: 'unset',
      encryptionAvailable: true,
      host: null,
      port: null,
      user: null,
      database: null,
    });
    expect(existsSync(target())).toBe(false);
    // 反向：这一发除了"文件在不在"以外什么都不该做（cipher 一次都没被用）。
    expect(cipher.calls).toEqual([]);
  });

  it('2. 没配时 readConfig 抛 ConfigError(missing)，文案里点出文件位置', () => {
    let caught: unknown;
    try {
      readConfig(dir, cipher);
      expect.unreachable('未配置时 readConfig 必须抛');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as ConfigError).kind).toBe('missing');
    expect((caught as Error).message).toContain(CONFIG_FILE_NAME);
    expect((caught as Error).message).toContain(dir);
  });

  it('3. 写→读同源：writeConfig 的回显逐字等于输入，readConfig 的 record 连 SENTINEL 都读得回来', () => {
    const value = writeConfig(dir, cipher, INPUT);
    // 这里的 `'dajia'` 是**故意的字面量**（第 ⑧ 段点名的那一格）：产品代码取的是 enum 的第一格，
    // 这一格钉的是"落盘那一份的库名只能是 dajia"。两边同源（都写 `options[0]`）就等于没钉。
    expect(value).toEqual({
      state: 'ready',
      encryptionAvailable: true,
      host: INPUT.host,
      port: INPUT.port,
      user: INPUT.user,
      database: 'dajia',
    });
    // "已保存"那句话的证据是读得回来，不是 writeFileSync 返回了。
    expect(readConfig(dir, cipher)).toEqual({ ...INPUT, database: 'dajia' });
  });
});

describe('落盘形状：经过 cipher 是唯一的写法', () => {
  it('4. 文件以 ENC:: 开头、目录里只有一个文件、字节里搜不到 SENTINEL 也搜不到 password 这个键名', () => {
    writeConfig(dir, cipher, INPUT);
    expect(rawBytes().startsWith('ENC::')).toBe(true);
    expect(rawBytes()).not.toContain(SENTINEL);
    expect(rawBytes().toLowerCase()).not.toContain('password');
    expect(readdirSync(dir)).toEqual([CONFIG_FILE_NAME]);
    // 返回的那一份来自 probeConfig ⇒ 写之后确实又按读的路径走了一遍 cipher。
    expect(cipher.calls).toEqual(['encrypt', 'decrypt']);
  });

  it('5. available=false ⇒ 拒存：不动旧文件、也不新建；probe 仍回显、read 抛 unavailable', () => {
    writeConfig(dir, cipher, INPUT); // 先来一份能用的
    const before = rawBytes();
    cipher.available = false;
    expect(() => writeConfig(dir, cipher, INPUT)).toThrow(ConfigError);
    // 旧那份一字未变（不许把"加密不可用"过成"降级成明文重写一遍"）。
    expect(rawBytes()).toBe(before);
    // 文件在但读不了 ⇒ unreadable。不是 missing —— 那句谎话会叫一个已经填过的人去重填，
    // 却说不出"你机器上的系统密钥变了"这件正在发生的事。
    expect(probeConfig(dir, cipher)).toEqual({
      state: 'unreadable',
      encryptionAvailable: false,
      host: null,
      port: null,
      user: null,
      database: null,
    });
    // 一台全新机器（目录里没文件）+ 加密不可用 ⇒ 说的仍是"还没配"：missing 先于 unavailable。
    expect(probeConfig(join(dir, 'no-such-dir'), cipher).state).toBe('unset');
    let caught: unknown;
    try {
      readConfig(dir, cipher);
      expect.unreachable();
    } catch (err) {
      caught = err;
    }
    expect((caught as ConfigError).kind).toBe('unavailable');
  });
});

describe('坏内容：一句 unreadable，绝不返回半个 record', () => {
  it('6. decrypt 抛 ⇒ probe 回 unreadable 而不抛；两处出口的文案都不许带出 SENTINEL（P-29）', () => {
    writeConfig(dir, cipher, INPUT);
    cipher.decryptThrows = true;
    expect(probeConfig(dir, cipher).state).toBe('unreadable');
    let caught: unknown;
    try {
      readConfig(dir, cipher);
      expect.unreachable();
    } catch (err) {
      caught = err;
    }
    expect((caught as ConfigError).kind).toBe('unreadable');
    expect((caught as Error).message).not.toContain(SENTINEL);
    expect(JSON.stringify(probeConfig(dir, cipher))).not.toContain(SENTINEL);
  });

  it('7. 不是 JSON / 少一格 / 库名不在 enum 里 ⇒ 三样全归 unreadable，readConfig 一个 record 都不返回', () => {
    const samples: readonly string[] = [
      '这不是 JSON',
      JSON.stringify({ host: 'h', port: 3306, user: 'u' }),
      JSON.stringify({ host: 'h', port: 3306, user: 'u', password: 'p', database: 'dajia_test' }),
    ];
    for (const text of samples) {
      plant(text);
      expect(probeConfig(dir, cipher).state).toBe('unreadable');
      let caught: unknown;
      try {
        readConfig(dir, cipher);
        expect.unreachable();
      } catch (err) {
        caught = err;
      }
      expect((caught as ConfigError).kind).toBe('unreadable');
    }
    // 第三样专门钉第 ⑧ 段：连手写盘文件都进不来 `dajia_test`（那是 `test:db` 的通路，不是屏幕的通路）。
    expect(JSON.stringify(probeConfig(dir, cipher))).not.toContain('"dajia_test"');
  });

  it('8. configToEnv 四格透传，库名再过一次 T1 白名单（白名单**外**的名字必须抛）', () => {
    writeConfig(dir, cipher, INPUT);
    const record = readConfig(dir, cipher);
    expect(configToEnv(record)).toEqual({ ...INPUT, database: 'dajia' });
    // 为什么这里不能用 `dajia_test`：`assertDatabaseName` 的白名单**包含** `dajia_test`
    // （T1 那两条授权库名），拿它当靶子这一发不会抛 —— 那是一颗哑牙。
    // 这一格要判的是"第二次把关还活着"，所以必须用一个两个产地都不认的名字。
    expect(() => configToEnv({ ...record, database: 'mysql' as unknown as ConfigRecord['database'] })).toThrow(
      RangeError,
    );
    // 而 schema 那一道的证据在上面第 7 格（`dajia_test` 归 unreadable）。两道门各有各的靶子。
    expect(ConfigRecordSchema.safeParse({ ...record, database: 'mysql' }).success).toBe(false);
  });
});

describe('位置与形状', () => {
  it('9. userDataDir 还不存在时 writeConfig 不抛（补目录），并留下一份且仅一份文件', () => {
    const fresh = join(dir, 'Application Data'); // `dir` 由 beforeEach 建好，这一层子目录不存在
    expect(existsSync(fresh)).toBe(false);
    expect(writeConfig(fresh, cipher, INPUT).state).toBe('ready');
    expect(readdirSync(fresh)).toEqual([CONFIG_FILE_NAME]);
    // `afterEach` 递归删 `dir`，所以这一发不留垃圾；但产品代码里的 `mkdirSync(recursive)` 必须真跑过。
    expect(cipher.calls).toEqual(['encrypt', 'decrypt']);
  });

  it('10. 回显形状里没有能装口令的格子：六个键，逐字', () => {
    writeConfig(dir, cipher, INPUT);
    expect(Object.keys(probeConfig(dir, cipher)).sort()).toEqual([
      'database',
      'encryptionAvailable',
      'host',
      'port',
      'state',
      'user',
    ]);
    expect(JSON.stringify(probeConfig(dir, cipher))).not.toContain(SENTINEL);
    expect(JSON.stringify(writeConfig(dir, cipher, { ...INPUT, host: 'localhost' }))).not.toContain(SENTINEL);
  });
});
