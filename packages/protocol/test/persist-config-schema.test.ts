import { describe, expect, it } from 'vitest';
import { IPC } from '../src/ipc';
import {
  CONNECTION_ERROR_KINDS,
  CONNECTION_TEST_KINDS,
  ConfigDatabaseSchema,
  ConfigReadRequestSchema,
  ConfigSaveRequestSchema,
  ConfigTestRequestSchema,
  ConfigValueSchema,
  ConnectionInputSchema,
  ConnectionTestValueSchema,
  PERSIST_ERROR_CODES,
  ProjectCreateRequestSchema,
  ProjectListRequestSchema,
  ProjectSummarySchema,
  UI_COMMAND_EVENT,
  UiCommandSchema,
  parseConfigReadRequest,
  parseConfigSaveRequest,
  parseConfigValue,
  parseConnectionInput,
  parseConnectionTestValue,
  parseProjectCreateRequest,
  parseProjectListRequest,
  parseUiCommand,
} from '../src/persist-schema';

/**
 * 哨兵口令。它**不是**任何真实凭据（spec §12 那台机器上的真口令一个字节都不进仓库），
 * 它存在的唯一目的是被断言"绝不出现在回包与文案里"（T9 第 ④ 段三条防线的凭据）。
 */
const SENTINEL = 'SUP3R-SENTINEL-9';

function input(over: Partial<Record<'host' | 'port' | 'user' | 'password', unknown>> = {}) {
  return { host: '127.0.0.1', port: 3306, user: 'root', password: SENTINEL, ...over };
}

describe('T9：连接参数的形状', () => {
  it('1 格：四个字段齐了才放行，缺任一格、多任一键都拒；空口令放行', () => {
    expect(ConnectionInputSchema.safeParse(input()).success).toBe(true);
    // 空口令是 Windows 上 root 的常见装完形状（第 ④ 段注释），拒它等于把人挡在自己机器外面。
    expect(ConnectionInputSchema.safeParse(input({ password: '' })).success).toBe(true);
    for (const key of ['host', 'port', 'user', 'password'] as const) {
      const missing = { ...input() } as Record<string, unknown>;
      delete missing[key];
      expect(ConnectionInputSchema.safeParse(missing).success).toBe(false);
    }
    // 多一键：`database` 不在这里，它是 `ConfigRecord` 的事（第 ⑧ 段）。
    expect(ConnectionInputSchema.safeParse({ ...input(), database: 'dajia' }).success).toBe(false);
    // `null` 与 `undefined` 不等价：口令缺省必须是"没填"，不是"空"。这一发判的是 optional 没被顺手写出来。
    expect(ConnectionInputSchema.safeParse({ ...input(), password: undefined }).success).toBe(false);
  });

  it('2 格：长度与空白的尺各就各位（253/254、32/33、0/1/65535/65536、1.5）', () => {
    expect(ConnectionInputSchema.safeParse(input({ host: 'h'.repeat(253) })).success).toBe(true);
    expect(ConnectionInputSchema.safeParse(input({ host: 'h'.repeat(254) })).success).toBe(false);
    expect(ConnectionInputSchema.safeParse(input({ host: 'a b' })).success).toBe(false);
    expect(ConnectionInputSchema.safeParse(input({ host: ' ' })).success).toBe(false);
    expect(ConnectionInputSchema.safeParse(input({ user: 'u'.repeat(32) })).success).toBe(true);
    expect(ConnectionInputSchema.safeParse(input({ user: 'u'.repeat(33) })).success).toBe(false);
    expect(ConnectionInputSchema.safeParse(input({ user: '' })).success).toBe(false);
    for (const bad of [0, -1, 65_536, 1.5, '3306', null]) {
      expect(ConnectionInputSchema.safeParse(input({ port: bad })).success).toBe(false);
    }
    expect(ConnectionInputSchema.safeParse(input({ port: 65_535 })).success).toBe(true);
    expect(ConnectionInputSchema.safeParse(input({ port: 1 })).success).toBe(true);
  });

  it('3 格：文案里不许出现口令与用户名（哨兵跑过三条失败通路）', () => {
    // (a) 超长口令那一抛
    const long = 'x'.repeat(256);
    let msgA = '';
    try {
      parseConnectionInput(IPC.configSave, input({ password: long }));
    } catch (err) {
      msgA = String(err);
    }
    expect(msgA).toContain('口令太长');
    expect(msgA).not.toContain(long);
    expect(msgA).not.toContain(SENTINEL);
    // (b) 含空白的主机名那一抛：文案里有字段名，没有值
    let msgB = '';
    try {
      parseConnectionInput(IPC.configSave, input({ host: 'db host' }));
    } catch (err) {
      msgB = String(err);
    }
    expect(msgB).toContain('主机名不许含空白');
    expect(msgB).not.toContain('db host');
    // (c) 外层请求多带一个 `password` 键：`strictObject` 拒的时候只会点出**键名**，
    // 不许把值带出来（这一发的价值就在于它是 `fail()` 那条通用文案，不是我们手写的）。
    let msgC = '';
    try {
      parseConfigSaveRequest(IPC.configSave, { connection: input(), password: SENTINEL });
    } catch (err) {
      msgC = String(err);
    }
    expect(msgC).toContain('解不开保存连接配置的请求');
    expect(msgC).not.toContain(SENTINEL);
    // 反向证一句：`SENTINEL` 确实是被送进去的那个值，否则上面三句 not.toContain 是空转。
    expect(input().password).toBe(SENTINEL);
  });

  it('4 格：库名只有 `dajia`；`dajia_test` 与空串都拒（第 ⑧ 段那道门槛）', () => {
    expect(ConfigDatabaseSchema.options.length).toBe(1);
    expect(ConfigDatabaseSchema.safeParse('dajia').success).toBe(true);
    for (const bad of ['dajia_test', 'mysql', 'DAJIA', '', 'dajia ']) {
      expect(ConfigDatabaseSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('5 格：`state` 与回显读数同向；带 `password` 的回包一律拒', () => {
    const ready = {
      state: 'ready',
      encryptionAvailable: true,
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      database: 'dajia',
    };
    expect(ConfigValueSchema.safeParse(ready).success).toBe(true);
    const unset = { ...ready, state: 'unset', host: null, port: null, user: null, database: null };
    expect(ConfigValueSchema.safeParse(unset).success).toBe(true);
    // `.refine` 那一发要能红：`state` 说没配而读数还留着，面板就会把上一台机器的参数当真。
    expect(ConfigValueSchema.safeParse({ ...ready, state: 'unset' }).success).toBe(false);
    expect(ConfigValueSchema.safeParse({ ...unset, host: '127.0.0.1' }).success).toBe(false);
    // 回包方向的口令格子一个都不许存在（第 ④ 段第 2 块牙在这里有一发独立的）。
    expect(ConfigValueSchema.safeParse({ ...ready, password: SENTINEL }).success).toBe(false);
    // `encryptionAvailable` 不许省：少了它，"存不了口令"那句话就没有读数来源。
    const noFlag = { ...unset } as Record<string, unknown>;
    delete noFlag.encryptionAvailable;
    expect(ConfigValueSchema.safeParse(noFlag).success).toBe(false);
  });

  it('6 格：`connected` 与 `kind` 同向；七型各过，第八种拼法拒', () => {
    const ok = { connected: true, kind: 'ok', serverVersion: '8.0.45', detail: '连上了' };
    expect(ConnectionTestValueSchema.safeParse(ok).success).toBe(true);
    for (const kind of CONNECTION_ERROR_KINDS) {
      expect(
        ConnectionTestValueSchema.safeParse({
          connected: false,
          kind,
          serverVersion: null,
          detail: `诊断：${kind}`,
        }).success,
      ).toBe(true);
    }
    // 两个方向的反例：这一发不判就等于允许"连不上但报 ok"那种自相矛盾的回包上屏。
    expect(ConnectionTestValueSchema.safeParse({ ...ok, kind: 'denied' }).success).toBe(false);
    expect(
      ConnectionTestValueSchema.safeParse({ ...ok, connected: false, kind: 'ok' }).success,
    ).toBe(false);
    expect(
      ConnectionTestValueSchema.safeParse({
        connected: false,
        kind: 'timeout',
        serverVersion: null,
      }).success,
    ).toBe(false); // 缺 detail：诊断说出来却没有那句话 = 屏幕上一个空气泡
    expect(
      ConnectionTestValueSchema.safeParse({
        connected: false,
        kind: 'not_runing',
        serverVersion: null,
        detail: 'x',
      }).success,
    ).toBe(false);
    // `'db'` 是错误**码**不是**型**：拿它当 kind 会把"查服务"这个建议配到所有连不上的处境上。
    expect(
      ConnectionTestValueSchema.safeParse({
        connected: false,
        kind: 'db',
        serverVersion: null,
        detail: 'x',
      }).success,
    ).toBe(false);
  });

  it('7 格：列表那六格逐个少一格都拒，`locked` 只认真布尔（真库给 0/1 时在过界那一发红）', () => {
    const row = {
      projectId: '01932f6a-7c1e-7000-8000-000000000001',
      name: '样例房',
      schemaVersion: 1,
      journalTurn: 7,
      updatedAt: '2026-10-04 01:12:33.512',
      locked: false,
    };
    expect(ProjectSummarySchema.safeParse(row).success).toBe(true);
    const keys = Object.keys(row);
    // 逐格删一遍：`locked` 也在名单里（少一格 ⇒ 面板上"没锁"永远为真，那种 bug 不会有人报）。
    for (const key of keys) {
      const missing = { ...row } as Record<string, unknown>;
      delete missing[key];
      expect(ProjectSummarySchema.safeParse(missing).success).toBe(false);
    }
    // `SELECT lock_owner IS NOT NULL` 在 mysql2 里回来的是 1/0。忘了 CAST 就是这一格红，
    // 而不是面板上"没锁"永远为真。
    for (const bad of [0, 1, 'true', null]) {
      expect(ProjectSummarySchema.safeParse({ ...row, locked: bad }).success).toBe(false);
    }
    expect(ProjectSummarySchema.safeParse({ ...row, locked: true }).success).toBe(true);
    expect(ProjectSummarySchema.safeParse({ ...row, journalTurn: 2 ** 53 }).success).toBe(false);
    expect(ProjectSummarySchema.safeParse({ ...row, name: '' }).success).toBe(false);
    // `updatedAt` 是字符串不是 Date：`dateStrings: true`（T2）没生效时这里红。
    expect(ProjectSummarySchema.safeParse({ ...row, updatedAt: new Date(0) }).success).toBe(false);
  });

  it('8 格：两份 kind 名单对账（`slice(1)` 必须逐字等于错误型名单），且与错误码**不相交**', () => {
    expect([...CONNECTION_TEST_KINDS].slice(1)).toEqual([...CONNECTION_ERROR_KINDS]);
    expect(CONNECTION_TEST_KINDS[0]).toBe('ok');
    expect(CONNECTION_ERROR_KINDS.length).toBe(6);
    expect(new Set(CONNECTION_ERROR_KINDS).size).toBe(6);
    // 两张表只共享'ok' 之外的一个名字都不许有。这一句才是"别把它们合成一张"的真正护栏：
    // 混用的后果见上面那段注释（把 'db' 这个"下一步"配上"连不上是因为什么"这份读数）。
    const shared = CONNECTION_ERROR_KINDS.filter((k) =>
      (PERSIST_ERROR_CODES as readonly string[]).includes(k),
    );
    expect(shared).toEqual([]);
  });

  it('9 格：界面指令闭集三值；两张空表请求（列表与读配置）多一个键就拒', () => {
    for (const v of ['startup', 'config', 'projects']) {
      expect(UiCommandSchema.safeParse(v).success).toBe(true);
    }
    for (const bad of ['shutdown', 'startup ', '', null, 1]) {
      expect(() => parseUiCommand(UI_COMMAND_EVENT, bad)).toThrow(/界面指令/);
    }
    expect(ProjectListRequestSchema.safeParse({}).success).toBe(true);
    expect(ProjectListRequestSchema.safeParse(undefined).success).toBe(false);
    expect(() => parseProjectListRequest(IPC.projectList, { filter: 'x' })).toThrow(/工程列表的请求/);
    // `config:read` 的同一条空表（上面那张表的注释里写着为什么不省）：两张表分别判，
    // 是因为"只加了一张表、忘了第二张"正是这一格要抓住的那一型漂移。
    expect(ConfigReadRequestSchema.safeParse({}).success).toBe(true);
    expect(ConfigReadRequestSchema.safeParse(undefined).success).toBe(false);
    expect(() => parseConfigReadRequest(IPC.configRead, { force: true })).toThrow(
      /读连接配置的请求/,
    );
  });

  it('10 格：新建工程的名字尺 + 五个新 parse 沿用 T8 那一族文案形状', () => {
    expect(ProjectCreateRequestSchema.safeParse({ name: '样例房' }).success).toBe(true);
    expect(ProjectCreateRequestSchema.safeParse({ name: '  两面墙  ' }).success).toBe(false);
    expect(ProjectCreateRequestSchema.safeParse({ name: 'x'.repeat(200) }).success).toBe(true);
    expect(ProjectCreateRequestSchema.safeParse({ name: 'x'.repeat(201) }).success).toBe(false);
    // 保存与试连两条通道吃同一份 `ConnectionInput`，但表是两张：一张表加字段不会带着另一张漂。
    expect(ConfigSaveRequestSchema.safeParse({ connection: input() }).success).toBe(true);
    expect(ConfigTestRequestSchema.safeParse(input()).success).toBe(false);
    // 文案口径（同 T8 第 9 格）：`<通道名> 解不开<那一句>：<点号路径>: …`
    expect(() => parseConfigValue(IPC.configRead, { state: 'ready' })).toThrow(
      /^dajia:config:read 解不开连接配置的回包：/,
    );
    // `parseConnectionInput` 验的是**里面那一层**，所以点号路径从 `password` 起头（不带 `connection.`）；
    // 外层那一条走 `parseConfigSaveRequest`，两发各证一层，别让"路径少一段"这件事没人判。
    expect(() => parseConnectionInput(IPC.configSave, input({ password: 42 }))).toThrow(
      /^dajia:config:save 解不开连接参数：password: /,
    );
    expect(() => parseConfigSaveRequest(IPC.configSave, { connection: input({ port: '3306' }) })).toThrow(
      /connection\.port: /,
    );
    // 剩下两个出口：路径各自落在自己的那一格，文案前缀各是自己的通道名。
    expect(() => parseProjectCreateRequest(IPC.projectCreate, { name: '' })).toThrow(
      /^dajia:project:create 解不开新建工程的请求：name: /,
    );
    expect(() =>
      parseConnectionTestValue(IPC.configTest, {
        connected: false,
        kind: 'ok',
        serverVersion: null,
        detail: 'x',
      }),
    ).toThrow(/^dajia:config:test 解不开试连的回包：/);
  });
});
