import { describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION, isEntityId, type EntityId } from '@dajia/core';
import { ConfigDatabaseSchema, type ConnectionInput, type ProjectSummary } from '@dajia/protocol';
import type { JournalEntry, JournalOutcome } from '../../src/main/db/repository';
import type { MysqlEnv } from '../../src/main/db/env';
import { classifyDbError } from '../../src/main/db/diagnostics';
import { DIAGNOSTIC_TEXT } from '../../src/shared/diagnostics-text';
import {
  FIRST_STOREY,
  ProjectAdmin,
  buildDraftEnv,
  probeConnection,
  redact,
  type AdminCreateDb,
  type AdminListDb,
  type AdminPorts,
  type CreateRepo,
  type ProbeHandle,
} from '../../src/main/persist/admin';
import { SessionError } from '../../src/main/persist/session';

/** 哨兵串：本文件唯一被允许出现在断言里的"口令长相"。它绝不出现在任何期望文案之外（④ 段）。 */
const SECRET = 'SENTINEL-口令-不许回显';
/** 遮蔽串的**字面量**（不是从 `admin.ts` import 的：那个 `MASK` 是产品私有，导出它就等于给测试开一个产品专用的洞，P-15）。 */
const MASK_TXT = '•••';
const ENV: MysqlEnv = {
  host: 'example.invalid',
  port: 3306,
  user: 'root',
  password: SECRET,
  database: 'dajia',
};

const SUMMARY: ProjectSummary = {
  projectId: '0193aa00-0000-7000-8000-00000000000a' as EntityId,
  name: '样例房',
  schemaVersion: SCHEMA_VERSION,
  journalTurn: 3,
  updatedAt: '2026-10-04 03:21:55.120',
  locked: false,
};

const DRAFT: ConnectionInput = {
  host: 'db.internal',
  port: 3307,
  user: 'dajia',
  password: SECRET,
};

interface Over {
  loadConfigThrows?: Error;
  openCreateDbThrows?: Error;
  openListDbThrows?: Error;
  createProjectThrows?: Error;
  appendJournalThrows?: Error;
  deleteProjectThrows?: Error;
  listProjectsThrows?: Error;
  endThrows?: Error;
  projects?: ProjectSummary[];
}

function harness(over: Over = {}) {
  const calls: string[] = [];
  const captured: { entry: JournalEntry | null; created: { name: string; schemaVersion: number } | null } = {
    entry: null,
    created: null,
  };
  const repo: CreateRepo = {
    async createProject(input) {
      calls.push(`createProject:${input.name}:${input.schemaVersion}`);
      captured.created = { name: input.name, schemaVersion: input.schemaVersion };
      if (over.createProjectThrows) throw over.createProjectThrows;
    },
    async appendJournal(entry): Promise<JournalOutcome> {
      calls.push(`appendJournal:${entry.turn}:${entry.doc.projectId}`);
      captured.entry = entry;
      if (over.appendJournalThrows) throw over.appendJournalThrows;
      return 'applied';
    },
    async deleteProject() {
      calls.push('deleteProject');
      if (over.deleteProjectThrows) throw over.deleteProjectThrows;
    },
  };
  const end = async (): Promise<void> => {
    calls.push('end');
    if (over.endThrows) throw over.endThrows;
  };
  const createDb: AdminCreateDb = { repo, end };
  const listDb: AdminListDb = {
    listProjects: async () => {
      calls.push('listProjects');
      if (over.listProjectsThrows) throw over.listProjectsThrows;
      return over.projects ?? [SUMMARY];
    },
    end,
  };
  const ports: AdminPorts = {
    loadConfig() {
      calls.push('loadConfig');
      if (over.loadConfigThrows) throw over.loadConfigThrows;
      return ENV;
    },
    async openCreateDb(env, projectId) {
      calls.push(`openCreateDb:${env.host}:${projectId}`);
      if (over.openCreateDbThrows) throw over.openCreateDbThrows;
      return createDb;
    },
    async openListDb(env) {
      calls.push(`openListDb:${env.host}`);
      if (over.openListDbThrows) throw over.openListDbThrows;
      return listDb;
    },
  };
  return { calls, captured, admin: new ProjectAdmin(ports) };
}

/** mysql2 那一族错误的形状：带 string `code` ⇒ 分码走 `'db'`。 */
function dbError(code: string): Error {
  return Object.assign(new Error(`boom ${code}`), { code });
}

describe('ProjectAdmin.list', () => {
  it('1 格：成功 = 回包形状 + 四步调用序列，一条连接用完就掐', async () => {
    const { calls, admin } = harness();
    await expect(admin.list()).resolves.toEqual({ projects: [SUMMARY] });
    expect(calls).toEqual(['loadConfig', 'openListDb:example.invalid', 'listProjects', 'end']);
  });

  it('2 格：`loadConfig` 抛 ⇒ not-configured，且后面一步都不许发生', async () => {
    const { calls, admin } = harness({ loadConfigThrows: new Error('没配') });
    const err = await admin.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).code).toBe('not-configured');
    expect(calls).toEqual(['loadConfig']);
  });

  it('3 格：`openListDb` 抛 ⇒ db 且没有 end（没拿到手的东西不拆）', async () => {
    const { calls, admin } = harness({ openListDbThrows: dbError('ECONNREFUSED') });
    const err = await admin.list().catch((e: unknown) => e);
    expect((err as SessionError).code).toBe('db');
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('连不上库');
    expect(calls).toEqual(['loadConfig', 'openListDb:example.invalid']);
  });

  it('4 格：`listProjects` 的两级分码 —— 带 code 走 db，不带走 reconcile，两种都得掐连接', async () => {
    const a = harness({ listProjectsThrows: dbError('PROTOCOL_CONNECTION_LOST') });
    const errA = await a.admin.list().catch((e: unknown) => e);
    expect((errA as SessionError).code).toBe('db');
    expect((errA as Error).message).toContain('PROTOCOL_CONNECTION_LOST');

    const b = harness({ listProjectsThrows: new RangeError('journal_turn 超出安全整数范围') });
    const errB = await b.admin.list().catch((e: unknown) => e);
    expect((errB as SessionError).code).toBe('reconcile');
    expect((errB as Error).message).toContain('工程列表读不出来');
    // 正控制：两发都走完了 finally 里的拆卸。少了它，"结论先落地再拆"这件事没有证人。
    expect(a.calls).toContain('end');
    expect(b.calls).toContain('end');
  });

  it('5 格：`end()` 抛被吞掉，列表照原样返回，且 stdout 留了一句', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { admin } = harness({ endThrows: dbError('ER_INTERNAL_ERROR') });
    try {
      await expect(admin.list()).resolves.toEqual({ projects: [SUMMARY] });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toContain('连接没关掉');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('ProjectAdmin.create', () => {
  it('6 格：成功 = 两发的形状（createProject 的参数来自那份 doc + turn 1 的首层补丁）', async () => {
    const { calls, captured, admin } = harness();
    await admin.create('联排测试房');
    expect(captured.created).toEqual({ name: '联排测试房', schemaVersion: SCHEMA_VERSION });
    const entry = captured.entry;
    if (!entry) throw new TypeError('appendJournal 没被调，首层那一发的账没落');
    expect(entry.turn).toBe(1);
    expect(entry.patch.remove).toEqual([]);
    expect(entry.patch.upsert).toHaveLength(1);
    // 三个数是投影里读的 literals（本文件的独立证人），不是 `FIRST_STOREY` 的引用。
    expect(entry.patch.upsert[0]).toMatchObject({
      kind: 'storey',
      index: 0,
      elevationMm: 0,
      heightMm: 3000,
      projectId: entry.doc.projectId,
    });
    expect(entry.doc.byKind('storey')).toHaveLength(1);
    expect(calls).toEqual([
      'loadConfig',
      `openCreateDb:example.invalid:${entry.doc.projectId}`,
      'createProject:联排测试房:1',
      `appendJournal:1:${entry.doc.projectId}`,
      'end',
    ]);
  });

  it('7 格：三个号同源 —— 回包的、仓库绑的、那份文档的 projectId 是同一个 uuidv7', async () => {
    const { captured, admin } = harness();
    const value = await admin.create('同源');
    expect(isEntityId(value.projectId)).toBe(true);
    expect(value.projectId).toBe(captured.entry?.doc.projectId);
    // 反向对照：假 id 的注入点会让这一发变哑（第 ③ 段第一条理由的凭据）。
    expect(Object.keys(value)).toEqual(['projectId']);
  });

  it('8 格：首层那一发失败 ⇒ 补偿跑，抛的是首层的码，不是补偿的', async () => {
    const { calls, captured, admin } = harness({ appendJournalThrows: dbError('ECONNRESET') });
    const err = await admin.create('半途').catch((e: unknown) => e);
    expect((err as SessionError).code).toBe('db');
    expect((err as Error).message).toContain('首层那一发失败，工程行已按补偿删掉');
    // 序列用"步骤名"判，不拼 id：`captured.entry` 在假 repo 抛之前就被记下，
    // 所以这里能拿到那两个号 —— 上一版的写法是从 `calls[1]` 里 split 出 id，
    // 那等于让判据依赖自己的字符串格式（改一个冒号就整格假红）。
    expect(calls.map((c) => c.split(':')[0])).toEqual([
      'loadConfig',
      'openCreateDb',
      'createProject',
      'appendJournal',
      'deleteProject',
      'end',
    ]);
    expect(captured.entry?.turn).toBe(1);
  });

  it('9 格：补偿也失败 ⇒ 两支原文都在 message 里，码仍是首层那一发的', async () => {
    const { calls, admin } = harness({
      appendJournalThrows: new RangeError('FIRST-SENTINEL 跳号'),
      deleteProjectThrows: new Error('COMP-SENTINEL 删不动'),
    });
    const err = await admin.create('鬼工程').catch((e: unknown) => e);
    expect((err as SessionError).code).toBe('reconcile');
    const msg = (err as Error).message;
    expect(msg).toContain('FIRST-SENTINEL');
    expect(msg).toContain('COMP-SENTINEL');
    expect(msg).toContain('列表里看得见它');
    expect(calls.map((c) => c.split(':')[0])).toEqual([
      'loadConfig',
      'openCreateDb',
      'createProject',
      'appendJournal',
      'deleteProject',
      'end',
    ]);
  });

  it('10 格：`createProject` 抛 ⇒ 没有 appendJournal、也没有 deleteProject、更没有回包', async () => {
    // 抛的形状用存储层那把尺的原话（⑤ 段的镜像关系），名字本身是短名：
    // 201 个字符在边界那张表就被拒了（'bad-request'），走到这一发时唯一的可能形状是"尺漂了"。
    const { calls, captured, admin } = harness({
      createProjectThrows: new RangeError('工程名不能超过 200 个字符（project.name 是 VARCHAR(200)），收到 201'),
    });
    const err = await admin.create('半途而废').catch((e: unknown) => e);
    expect((err as SessionError).code).toBe('reconcile');
    expect(calls.filter((c) => c.startsWith('appendJournal'))).toEqual([]);
    expect(calls).not.toContain('deleteProject');
    expect(captured.created).not.toBeNull();
    expect(calls).toContain('end');
  });
});

describe('probeConnection / redact / buildDraftEnv', () => {
  it('11 格：试连成功 = ok 的形状、版本原样、连接照掐', async () => {
    const calls: string[] = [];
    const handle: ProbeHandle = {
      async ping() {
        calls.push('ping');
        return { version: '8.0.45' };
      },
      async end() {
        calls.push('end');
      },
    };
    const value = await probeConnection(ENV, async () => {
      calls.push('open');
      return handle;
    });
    expect(value).toEqual({
      connected: true,
      kind: 'ok',
      serverVersion: '8.0.45',
      detail: DIAGNOSTIC_TEXT.ok.detail,
    });
    expect(calls).toEqual(['open', 'ping', 'end']);
  });

  it('12 格：试连失败六型逐一对齐 classifyDbError，detail = 文案 + 过 redact 的原文', async () => {
    const samples: Record<string, string> = {
      'not-running': 'ECONNREFUSED',
      denied: 'ER_ACCESS_DENIED_ERROR',
      'no-database': 'ER_BAD_DB_ERROR',
      dropped: 'PROTOCOL_CONNECTION_LOST',
      timeout: 'ETIMEDOUT',
    };
    for (const code of Object.values(samples)) {
      const calls: string[] = [];
      const value = await probeConnection(ENV, async () => {
        calls.push('open');
        throw dbError(code);
      });
      const kind = classifyDbError(dbError(code));
      expect(value.connected).toBe(false);
      expect(value.kind).toBe(kind);
      expect(value.serverVersion).toBeNull();
      expect(value.detail.startsWith(DIAGNOSTIC_TEXT[kind].detail)).toBe(true);
      expect(value.detail).toContain(code);
      // ④ 段三条防线的第二颗牙：哨兵口令绝不从 `detail` 出去。
      expect(value.detail).not.toContain(SECRET);
      // 这一发的 `open` 自己抛，句柄压根没存在过，所以 `end` 不该出现在名单里。
      // 它判的是"没有句柄时不去掐"，**不判**"失败也要掐" —— 后者的证人只有第 11 格（成功路）
      // 与第 13 格（`open` 成了、`ping` 抛）。把这三格读成一格会得出"M27 有三重保护"的假结论。
      expect(calls).toEqual(['open']);
    }
    // 第六型没人被漏过：`unknown` 走 `ER_SOMETHING_NEW`，`redact` 之后仍要说得出 code。
    const unknownValue = await probeConnection(ENV, async () => {
      throw dbError('ER_SOMETHING_NEW');
    });
    expect(unknownValue.kind).toBe('unknown');
    expect(unknownValue.detail).toContain('ER_SOMETHING_NEW');
  });

  it('13 格：`open` 成了、`ping` 抛 ⇒ 连接照样掐（T9-M27 在这一格才有证人）', async () => {
    const calls: string[] = [];
    const handle: ProbeHandle = {
      async ping() {
        calls.push('ping');
        throw dbError('PROTOCOL_CONNECTION_LOST');
      },
      async end() {
        calls.push('end');
      },
    };
    const value = await probeConnection(ENV, async () => {
      calls.push('open');
      return handle;
    });
    expect(value.connected).toBe(false);
    expect(value.kind).toBe('dropped');
    expect(calls).toEqual(['open', 'ping', 'end']);
  });

  it('14 格：`redact` 的四把尺 + `buildDraftEnv` 的同源 + `FIRST_STOREY` 的三个数', () => {
    // 多处副本全换；名单里第二个 secret 不在文本里时也不许出事。
    expect(redact(`${SECRET} 与 ${SECRET}`, [SECRET, '另一串'])).toBe(`${MASK_TXT} 与 ${MASK_TXT}`);
    // 空串跳过、空名单原样（第 ② 段形状 ①）：`'Z'` 是个不在文本里的正常 secret。
    expect(redact('Access denied', [])).toBe('Access denied');
    expect(redact('Access denied', ['', 'Z'])).toBe('Access denied');
    // 真驱动原文（口径 ④ 点名的那一发）里用户名留着、口令那一位不许出现。
    // 三条断言各挡一种错，缺一条就少一种假绿：只写"用户名留着"挡不住口令没换；
    // 只写"口令不见了"会把"名单里根本没传口令"也一起绿。
    const raw = `Access denied for user 'root'@'localhost'（用的口令是 ${SECRET}）`;
    const masked = redact(raw, [SECRET]);
    expect(masked).toContain("'root'@'localhost'");
    expect(masked).not.toContain(SECRET);
    expect(masked).toContain(MASK_TXT);
    // 同源：enum 只有一个读数，且草稿用的就是它。
    expect(ConfigDatabaseSchema.options).toEqual(['dajia']);
    expect(buildDraftEnv(DRAFT)).toEqual({
      host: 'db.internal',
      port: 3307,
      user: 'dajia',
      password: SECRET,
      database: 'dajia',
    });
    expect(buildDraftEnv(DRAFT).database).toBe(ConfigDatabaseSchema.options[0]);
    // 三个数在这一格钉死（连库档第 1 格在投影那一侧读同样的三个数）。
    expect(FIRST_STOREY).toEqual({ index: 0, elevationMm: 0, heightMm: 3000 });
  });
});
