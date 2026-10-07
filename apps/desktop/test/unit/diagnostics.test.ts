import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CONNECTION_ERROR_KINDS,
  classifyDbError,
  type ConnectionErrorKind,
} from '../../src/main/db/diagnostics';
import { DIAGNOSTIC_KIND_LIST, DIAGNOSTIC_TEXT, type DiagnosticKind } from '../../src/shared/diagnostics-text';

/**
 * 分型诊断的两族判据。
 *
 * ## 为什么要两族（且第二族跨文件）
 *
 * `diagnostics.ts`（分型）与 `diagnostics-text.ts`（文案）**都零 import**，
 * 而它们合起来才是"分型诊断"这个整体。所以：
 * - 第一族断**分型**：码 ⇒ 型，以及那些"认不出来"的边界形状。
 * - 第二族断**文案**：每型三段齐不齐、`next` 互不相同、以及那条红线。
 * - **跨文件那一格**（`DIAGNOSTIC_KIND_LIST` 与 `CONNECTION_ERROR_KINDS` 对账）才是
 *   真正把两份文件缝在一起的那一发 —— 没有它，两份文件可以各自漂开而没人知道。
 */

const POOL = fileURLToPath(new URL('../../src/main/db/pool.ts', import.meta.url));

function srcOf(absolute: string): string {
  return readFileSync(absolute, 'utf8');
}

/** 造一个像驱动的错误对象：`code` 是它唯一的判据来源。 */
function dbErr(code: string): Error {
  return Object.assign(new Error(`原始人话：${code}`), { code });
}

describe('diagnostics：码 ⇒ 型（8 格）', () => {
  it('1格 spec §9 点名的四型各归各处', () => {
    // 「服务没启动」⇒ ECONNREFUSED；「认证失败」⇒ ER_ACCESS_DENIED_ERROR；
    // 「库不存在」⇒ ER_BAD_DB_ERROR；「端口占用」⇒ 走 PROTOCOL_CONNECTION_LOST / ECONNRESET
    //（客户端永远拿不到 EADDRINUSE，那是监听端才有的错 —— spec §9 的订正）。
    expect(classifyDbError(dbErr('ECONNREFUSED'))).toBe('not-running');
    expect(classifyDbError(dbErr('ER_ACCESS_DENIED_ERROR'))).toBe('denied');
    expect(classifyDbError(dbErr('ER_BAD_DB_ERROR'))).toBe('no-database');
    expect(classifyDbError(dbErr('PROTOCOL_CONNECTION_LOST'))).toBe('dropped');
  });

  it('2 格 合并进同型的别名各有一发（五码 / 两码 / 三码）', () => {
    // not-running 是五码一型
    for (const c of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']) {
      expect(classifyDbError(dbErr(c))).toBe('not-running');
    }
    // denied 是两码一型
    for (const c of ['ER_ACCESS_DENIED_ERROR', 'ER_NOT_SUPPORTED_AUTH_MODE']) {
      expect(classifyDbError(dbErr(c))).toBe('denied');
    }
    // dropped 是三码一型
    for (const c of ['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE']) {
      expect(classifyDbError(dbErr(c))).toBe('dropped');
    }
  });

  it('3 格 认不出来的码一律 unknown，**包括长得像的**', () => {
    // 逐字相似但不在表里的码 —— 那是最容易被"顺手加进if"收编的形状。
    expect(classifyDbError(dbErr('ECONNABORTED'))).toBe('unknown');
    expect(classifyDbError(dbErr('ECONNRESET2'))).toBe('unknown');
    expect(classifyDbError(dbErr('EACCESS_DENIED'))).toBe('unknown');
    expect(classifyDbError(dbErr('er_access_denied_error'))).toBe('unknown'); // 大小写
    expect(classifyDbError(dbErr(''))).toBe('unknown');
  });

  it('4 格 **message 里写着错误码不算**（分型只认 code 字段）', () => {
    // 逐字口径：message 是会改措辞的人话，拿正则去读它等于把判据建在最不稳的东西上。
    // 这一格就是"不许读 message"的牙齿。
    expect(classifyDbError(new Error('connect ECONNREFUSED 127.0.0.1:3306'))).toBe('unknown');
    expect(classifyDbError(new Error('Access denied for user'))).toBe('unknown');
  });

  it('5 格 code 类型不对一律 unknown（1045 / null / undefined / 对象 / 数组）', () => {
    expect(classifyDbError(Object.assign(new Error('x'), { code: 1045 }))).toBe('unknown');
    expect(classifyDbError(Object.assign(new Error('x'), { code: null }))).toBe('unknown');
    expect(classifyDbError(new Error('x'))).toBe('unknown');
    expect(classifyDbError(Object.assign(new Error('x'), { code: {} }))).toBe('unknown');
    expect(classifyDbError(Object.assign(new Error('x'), { code: ['ECONNREFUSED'] }))).toBe('unknown');
  });

  it('6 格 err 本身不是对象时不抛（字符串 / 数字 / true / null / undefined / Symbol）', () => {
    // 这一格与"入口声明成 unknown"是一件事：签名收 `unknown` 就是为了让运行时什么都能接。
    for (const v of ['ECONNREFUSED', 42, true, null, undefined, Symbol('ECONNREFUSED')]) {
      expect(() => classifyDbError(v)).not.toThrow();
      expect(classifyDbError(v)).toBe('unknown');
    }
    // 大写那个不能出现"不许把原型链上的东西当错误码"。
    expect(classifyDbError({})).toBe('unknown');
  });

  it('7 格 分型与文案两份名单是同一件事（跨文件那一发）', () => {
    // **这一格才是把两份文件缝在一起的那一发** —— 没有它，两份可以各自漂开而没人知道。
    // `ok` 不在错误型名单里（它是"连上了"，由试连单独判）。
    expect([...CONNECTION_ERROR_KINDS]).toEqual([
      'not-running',
      'denied',
      'no-database',
      'dropped',
      'timeout',
      'unknown',
    ]);
    // 文案侧七型 = 错误型六型 + 'ok'，且 'ok' 在第一位。
    expect(DIAGNOSTIC_KIND_LIST[0]).toBe('ok');
    expect([...DIAGNOSTIC_KIND_LIST].slice(1)).toEqual([...CONNECTION_ERROR_KINDS]);
    // 每一种错误型都有它的三段文案（`DIAGNOSTIC_TEXT` 的键集合就是七型）。
    for (const k of CONNECTION_ERROR_KINDS) {
      expect(DIAGNOSTIC_TEXT[k as DiagnosticKind]).toBeDefined();
      // 文案表的值必须是三段齐的 `DiagnosticText`，**不是**只有 title 的半张表。
      const t = DIAGNOSTIC_TEXT[k as DiagnosticKind];
      expect(Object.keys(t).sort()).toEqual(['detail', 'next', 'title']);
    }
  });

  it('7b 格 分类器真能打出名单上那六种型（不是"名单与实现各说各的"）', () => {
    // 这一格把两件事扣在一起：`CONNECTION_ERROR_KINDS` 是闭集，而 `classifyDbError`
    // 对每一种都真的打得出它。若哪天加了一型却忘了改 if，这一格红。
    const hit = new Set<ConnectionErrorKind>();
    for (const c of [
      'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
      'ER_ACCESS_DENIED_ERROR', 'ER_NOT_SUPPORTED_AUTH_MODE',
      'ER_BAD_DB_ERROR',
      'PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE',
      'ETIMEDOUT',
      'WAT',
    ]) {
      hit.add(classifyDbError(dbErr(c)));
    }
    expect([...hit].sort()).toEqual([...CONNECTION_ERROR_KINDS].sort());
    // `'ok'` 不在错误型名单里（它是"连上了"，由试连单独判，不走分型）。
    expect(hit.has('ok' as ConnectionErrorKind)).toBe(false);
  });

  it('8 格 试连超时的数值只有一个产地，且真的交到 mysql2 手上', () => {
    // 这一格跨到 `pool.ts`：`CONFIG_TEST_CONNECT_TIMEOUT_MS` 若是常量而非读数，
    // 或者没真的接到 `connectTimeout`，那么"填一个黑洞主机名五秒拿到 timeout"就验不到。
    const src = srcOf(POOL);
    expect(src).toContain('CONFIG_TEST_CONNECT_TIMEOUT_MS = 5_000');
    expect(src).toContain('connectTimeout: opts.connectTimeoutMs');
    // 不许出现字面量数字（那会绕过那个常量，于是有两份"五秒"）。
    expect(src).not.toMatch(/connectTimeout:\s*[0-9]/);
    expect(src).not.toMatch(/setTimeout|Date\.now\(/);
  });
});

describe('diagnostics-text：三段文案（6 格）', () => {
  it('1 格 七型齐、三段齐，一段都不许是空话', () => {
    // 长度下限（逐字）：一句「x」也算有，那不算文案。
    for (const k of DIAGNOSTIC_KIND_LIST) {
      const t = DIAGNOSTIC_TEXT[k];
      expect(t.title.length).toBeGreaterThanOrEqual(3);
      expect(t.detail.length).toBeGreaterThanOrEqual(8);
      expect(t.next.length).toBeGreaterThanOrEqual(12);
    }
  });

  it('2 格 六型的 next 互不相同（两型给出同一步骤就等于分型白做）', () => {
    const nexts = CONNECTION_ERROR_KINDS.map((k) => DIAGNOSTIC_TEXT[k].next);
    expect(new Set(nexts).size).toBe(CONNECTION_ERROR_KINDS.length);
  });

  it('3 格 没认出来那一型不许说成"服务"或"没装"（那条红线）', () => {
    const u = DIAGNOSTIC_TEXT.unknown;
    const all = `${u.title} ${u.detail} ${u.next}`;
    expect(all).not.toMatch(/服务/);
    expect(all).not.toMatch(/没装|未安装|启动/);
    // 它必须给出一条能照着做的动作，而不是"不知道" —— 所以必须含「原文」。
    expect(all).toContain('原文');
  });

  it('4 格 spec §9 点名的处境各有名字，四句「不许串话」', () => {
    // 串话方向：把某一型的下一步说成另一型的处境，用户就会去查错的那一格。
    expect(DIAGNOSTIC_TEXT.denied.next).not.toMatch(/启动|重启/);
    expect(DIAGNOSTIC_TEXT['no-database'].next).not.toMatch(/口令/);
    expect(DIAGNOSTIC_TEXT['no-database'].next).toContain('库不存在');
    expect(DIAGNOSTIC_TEXT['not-running'].title).toContain('连不上');
    expect(DIAGNOSTIC_TEXT.dropped.detail).toContain('端口');
  });

  it('5 格 被合并的处境，两型各自的 detail 必须都说到', () => {
    // 五码一型：端口没人听 / 主机名解析不到 / 路由不通。
    expect(DIAGNOSTIC_TEXT['not-running'].detail).toContain('端口');
    expect(DIAGNOSTIC_TEXT['not-running'].detail).toContain('解析');
    // 两码一型：口令不对 / 认证插件不被支持。
    expect(DIAGNOSTIC_TEXT.denied.detail).toContain('口令');
    expect(DIAGNOSTIC_TEXT.denied.detail).toContain('认证插件');
  });

  it('6 格 每一型的 next 都逐字出现在 docs/install-mysql.md 里（防文档变成空壳）', () => {
    // **证人不能与犯人在不同提交里**（计划第 ④ 段的纪律）：这一格要求文档与文案表同批落地，
    // 所以第一发必须把 `docs/install-mysql.md` 一起交上。
    const doc = srcOf(fileURLToPath(new URL('../../../../docs/install-mysql.md', import.meta.url)));
    // 防空壳：安装说明要是只剩几行标题，这一格会"逐字出现"但什么都没说。
    expect(doc.length).toBeGreaterThan(600);
    for (const k of DIAGNOSTIC_KIND_LIST) {
      expect(doc).toContain(DIAGNOSTIC_TEXT[k].next);
    }
    // 顺带钉住库名：向导里不出现 `dajia_test`（那是连库档专用的库名护栏）。
    expect(doc).not.toContain('dajia_test');
  });
});