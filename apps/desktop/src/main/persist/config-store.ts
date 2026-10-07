import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConfigDatabaseSchema,
  ConfigRecordSchema,
  type ConfigRecord,
  type ConfigState,
  type ConfigValue,
  type ConnectionInput,
} from '@dajia/protocol';
import { assertDatabaseName } from '../db/db-safety';
import type { MysqlEnv } from '../db/env';

/** 盘上那个文件的名字。它是 `userData` 目录里唯一属于我们的凭据件（抢救件在另一个目录，T7）。 */
export const CONFIG_FILE_NAME = 'connection.bin';

/**
 * 加解密的全部接口。三格，一个都不多 —— 尤其**没有**"算法/密钥/路径"这类旋钮：
 * 那等于把"用系统密钥环"这个决定重新打开一次。
 * `available` 必须是**读数**而不是方法：`writeConfig` 要在使用它之前先看一眼，
 * 而"看一眼"与"试一下再 catch"是两种形状（后者会把"加密器坏了"与"口令太长"混成同一个 catch）。
 */
export interface ByteCipher {
  readonly available: boolean;
  encrypt(text: string): Uint8Array;
  decrypt(bytes: Uint8Array): string;
}

export type ConfigErrorKind = 'missing' | 'unreadable' | 'unavailable';

/**
 * 配置读不出来的三种处境。`kind` 是 main 侧的内部三分法，**不进 protocol**（T9 第 ⑦ 段末）：
 * 屏幕看到的是 `ConfigValue.state` 那一格三值，以及这一发的 `message`。
 *
 * 为什么文案里没有底层错误的原文（裁决 P-29，与 `admin.ts` 的 `detail` 相反）：
 * 这一整份文件就是密文，解密器抛的时候很常见地把**它吃进去的字节**抄进 message，
 * 而我们无法保证那些字节与口令没有重叠的形状（`safeStorage` 哪天换个包装就是未知）。
 * 试连的原文有诊断价值（`kind` 要从里面认），这一发的价值只有"重填一次" —— 不需要原话就能定的下一步，
 * 就别带上可能含密文的东西。凭据 = `config-store.test.ts` 第 6 格（假 cipher 抛的 message 里种 SENTINEL，
 * 两处出口都不许把它带出来）。
 */
export class ConfigError extends Error {
  constructor(
    readonly kind: ConfigErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

const MISSING_TEXT = (path: string) =>
  `还没有连接配置：在「工程 → 连接设置」里填一次并保存（配置文件位置：${path}）`;
const UNAVAILABLE_TEXT = (path: string) =>
  `这台机器的系统加密不可用（safeStorage 起不来）：为了不把口令明文写在盘上，` +
  `这里拒绝保存也拒绝使用（${path}）`;
const UNREADABLE_TEXT = (path: string) =>
  `连接配置读不出来 —— 文件坏了，或换过机器/换过 Windows 用户导致系统密钥变了。` +
  `在「工程 → 连接设置」里重填一次即可（${path}）`;

const TEXT_BY_KIND: Record<ConfigErrorKind, (path: string) => string> = {
  missing: MISSING_TEXT,
  unavailable: UNAVAILABLE_TEXT,
  unreadable: UNREADABLE_TEXT,
};

function configPath(userDataDir: string): string {
  return join(userDataDir, CONFIG_FILE_NAME);
}

/**
 * 一次读，两种出口共用（第 ⑦ 段"两个出口、一份文件"的字面形状）。
 * 分成 `probeConfig` 与 `readConfig` 两份各读一遍文件是**错的**：那会得到两个事实
 * （probe 说 `ready` 而 read 抛），而屏幕上刚显示"已配置"的那一格立刻在下一发变成错误。
 *
 * 三种失败的**先后**也是判据（`missing` 先于 `unavailable`）：文件根本不存在时，
 * 加密器可用与否都不相干 —— 那句该说的话是"还没配"，不是"这台机器存不了口令"。
 * 反过来（先查 available）会让一台没配过的空机器上的首屏说成"加密不可用"，
 * 而那是一个此刻根本不是问题的问题。
 */
type Read =
  | { readonly ok: true; readonly record: ConfigRecord }
  | { readonly ok: false; readonly reason: ConfigErrorKind };

function attempt(userDataDir: string, cipher: ByteCipher): Read {
  const path = configPath(userDataDir);
  if (!existsSync(path)) return { ok: false, reason: 'missing' };
  if (!cipher.available) return { ok: false, reason: 'unavailable' };
  let text: string;
  try {
    text = cipher.decrypt(readFileSync(path));
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  const r = ConfigRecordSchema.safeParse(parsed);
  if (!r.success) return { ok: false, reason: 'unreadable' };
  return { ok: true, record: r.data };
}

/** 未配与读不出来都回"四个回显格全 null"：`ConfigValueSchema` 那条 refine 判的就是这件事同向。 */
function blankValue(state: ConfigState, cipher: ByteCipher): ConfigValue {
  return {
    state,
    encryptionAvailable: cipher.available,
    host: null,
    port: null,
    user: null,
    database: null,
  };
}

/**
 * 首屏与保存之后回的那一份：**永不抛**。"没配"是首屏要显示的常态，
 * 而会话拿不到能用的参数才是异常 —— 那一半归 `readConfig`（它的抛经 T8 的
 * `wrap(err, 'not-configured', …)` 变成横幅上那句人话）。
 */
export function probeConfig(userDataDir: string, cipher: ByteCipher): ConfigValue {
  const r = attempt(userDataDir, cipher);
  if (!r.ok) return blankValue(r.reason === 'missing' ? 'unset' : 'unreadable', cipher);
  return {
    state: 'ready',
    encryptionAvailable: cipher.available,
    // 回显四格，口令不在其列：这份东西要进屏幕、进日志、进截图判据，
    // 而它唯一的用途是让用户看见自己填了什么。
    host: r.record.host,
    port: r.record.port,
    user: r.record.user,
    database: r.record.database,
  };
}

/** 会话与试连用的那一份：抛，且带 `ConfigErrorKind` 让 main 能说清是哪一种。 */
export function readConfig(userDataDir: string, cipher: ByteCipher): ConfigRecord {
  const r = attempt(userDataDir, cipher);
  if (r.ok) return r.record;
  throw new ConfigError(r.reason, TEXT_BY_KIND[r.reason](configPath(userDataDir)));
}

/**
 * 保存。返回 `probeConfig(...)` 而不是 `void`：**写完立刻以读的那条路验一遍** ——
 * 于是"存进去了"这句话的证据是"读得回来"，而不是"我以为 writeFileSync 成功了"。
 * 也正因为如此，向导上那句"已保存"永远与回显同源。
 */
export function writeConfig(
  userDataDir: string,
  cipher: ByteCipher,
  input: ConnectionInput,
): ConfigValue {
  if (!cipher.available) {
    // 产品决定（第 ⑦ 段）：宁可这台机器配不上连接，也不把口令写在盘上等人来读。
    // 这一支**在任何 fs 调用之前**：不许 mkdir、不许写、更不许把已有那份覆盖成明文。
    throw new ConfigError('unavailable', UNAVAILABLE_TEXT(configPath(userDataDir)));
  }
  // 库名不在向导里（第 ⑧ 段）：它的唯一产地是 `ConfigDatabaseSchema` 的第一格，
  // 而 `persist-config-schema.test.ts` 第 4 格钉住那个 enum 只有一个值。这里写
  // `ConfigDatabaseSchema.options[0]` 而不是 `'dajia'`，是为了让"哪天放开它"必须过 schema 那一格
  // 而不是这个字符串。
  const record = ConfigRecordSchema.parse({
    ...input,
    database: ConfigDatabaseSchema.options[0],
  });
  const path = configPath(userDataDir);
  // `userData` 目录在首屏时可能还不存在（Electron 建它是在 app ready 之后，而我们这一发
  // 可能跑在装配路径更早的地方）。ENOENT 不是"用户填错了"，所以这里补目录而不是抛。
  if (!existsSync(userDataDir)) mkdirSync(userDataDir, { recursive: true });
  writeFileSync(path, cipher.encrypt(JSON.stringify(record)), { mode: 0o600 });
  return probeConfig(userDataDir, cipher);
}

/**
 * 存储层的第二次把关（第 ⑧ 段末）：`ConfigDatabaseSchema` 管线上形状，
 * `assertDatabaseName`（T1 的白名单）管"这个东西真要拿去连库了没有"。
 * 两句都不是冗余：前者会随协议漂，后者会随库名策略漂，漂开的那一刻这里抛，而不是连到 `dajia_test` 上写。
 */
export function configToEnv(record: ConfigRecord): MysqlEnv {
  return {
    host: record.host,
    port: record.port,
    user: record.user,
    password: record.password,
    database: assertDatabaseName(record.database),
  };
}
