import { describe, expect, it } from 'vitest';
import {
  ExportPlanRequestSchema,
  IPC,
  isIpcChannel,
  parseExportPlanRequest,
} from '../src/index';

/**
 * 「导出平面图」这条 IPC 的**契约**判据（plan5 T8 接线棒）。
 *
 * 契约层的存在意义只有一条：**主进程不信任 renderer 递过来的任何东西**。
 * 于是这里钉的是"坏形状进不来"—— 缺键、多键、错的 id 格式、非有限的坐标，
 * 全部在 `safeParse` 那一层就红，而不是等到主进程拿它去建 Map 才炸。
 */

const PID = '0193bb00-0000-7000-8000-0000000000a1';
const STOREY = '0193bb00-0000-7000-8000-0000000000a2';

const GOOD = {
  doc: {
    projectId: PID,
    schemaVersion: 1,
    entities: [
      { kind: 'storey' as const, id: STOREY, projectId: PID, index: 0, elevationMm: 0, heightMm: 3000 },
    ],
  },
  opts: {
    storeyId: STOREY,
    title: '平面图',
    drafter: '搭家',
    sheetNo: 'A-101',
    date: '2026-10-06',
  },
};

describe('导出 IPC 契约', () => {
  it('通道已登记，且 isIpcChannel 认得它', () => {
    expect(IPC.exportPlan).toBe('dajia:export-plan');
    expect(isIpcChannel(IPC.exportPlan)).toBe(true);
    expect(isIpcChannel('dajia:export-plan-2')).toBe(false);
  });

  it('良构请求过；日期/设计人是必填入参（E3 的口径在契约层就不给时钟留口子）', () => {
    expect(ExportPlanRequestSchema.safeParse(GOOD).success).toBe(true);
    for (const key of ['title', 'drafter', 'sheetNo', 'date'] as const) {
      const opts: Record<string, unknown> = { ...GOOD.opts };
      delete opts[key];
      expect(ExportPlanRequestSchema.safeParse({ ...GOOD, opts }).success).toBe(false);
    }
  });

  it('线上快照是三键：多一个 journalTurn 就拒（renderer 没有合法的 turn 可填，P-18）', () => {
    expect(ExportPlanRequestSchema.safeParse(GOOD).success).toBe(true);
    const withTurn = { ...GOOD, doc: { ...GOOD.doc, journalTurn: 7 } };
    const r = ExportPlanRequestSchema.safeParse(withTurn);
    expect(r.success).toBe(false);
    // strictness 没丢：报的是"不认识的键"，不是别的。
    expect(r.success === false && r.error.issues.some((i) => /journalTurn|Unrecognized/.test(i.message))).toBe(true);
  });

  it('多一个键就拒（strictObject 不是摆设）', () => {
    const extra = { ...GOOD, opts: { ...GOOD.opts, extra: 1 } };
    expect(ExportPlanRequestSchema.safeParse(extra).success).toBe(false);
  });

  it('storeyId / id 必须是 UUIDv7；实体字段错一个就拒', () => {
    expect(ExportPlanRequestSchema.safeParse({ ...GOOD, opts: { ...GOOD.opts, storeyId: 'nope' } }).success).toBe(false);
    const badEntity = {
      ...GOOD,
      doc: { ...GOOD.doc, entities: [{ ...GOOD.doc.entities[0]!, index: -1 }] },
    };
    expect(ExportPlanRequestSchema.safeParse(badEntity).success).toBe(false);
  });

  it('clipLine 可选；给了就必须两 finite 端点', () => {
    expect(ExportPlanRequestSchema.safeParse({ ...GOOD, opts: { ...GOOD.opts, clipLine: undefined } }).success).toBe(true);
    const okClip = { ...GOOD, opts: { ...GOOD.opts, clipLine: { a: { x: -50, y: 0 }, b: { x: 50, y: 0 } } } };
    expect(ExportPlanRequestSchema.safeParse(okClip).success).toBe(true);
    const nanClip = { ...GOOD, opts: { ...GOOD.opts, clipLine: { a: { x: Number.NaN, y: 0 }, b: { x: 50, y: 0 } } } };
    expect(ExportPlanRequestSchema.safeParse(nanClip).success).toBe(false);
    // 少一个端点也不行。
    const halfClip = { ...GOOD, opts: { ...GOOD.opts, clipLine: { a: { x: 0, y: 0 } } } };
    expect(ExportPlanRequestSchema.safeParse(halfClip).success).toBe(false);
  });

  it('parseExportPlanRequest 把 ZodError 收成带前缀的 TypeError（边界另一侧只见文本）', () => {
    expect(() => parseExportPlanRequest('dajia:export-plan', GOOD)).not.toThrow();
    try {
      parseExportPlanRequest('dajia:export-plan', { doc: {}, opts: {} });
      expect.unreachable('上面那行必须抛');
    } catch (err) {
      expect(err).toBeInstanceOf(TypeError);
      expect(String(err)).toContain('dajia:export-plan 解不出导出请求');
    }
  });
});
