import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Document, type Entity, type EntityId } from '@dajia/core';
import type { ExportPlanRequestShape } from '@dajia/protocol';
import { encodeDocumentPayload } from '../../src/shared/document-payload';
import { decodeDocumentPayload } from '../../src/shared/document-wire';
import { runExportPlan } from '../../src/main/ipc/export-plan-core';

/**
 * 「导出平面图」这条 IPC 的**电子自由**判据（unit 档，不启 Electron、不连库）。
 *
 * 为什么能在这里验：handler 被拆成两半 —— `ipc/export-plan.ts`（electron：弹对话框 + 取路径）
 * 与 `ipc/export-plan-core.ts`（纯逻辑：解 payload → 还原文档 → 调 `exportPlan`）。
 * 被验的是**逻辑那一半**：契约解码、文档往返、字节可复现、错误可分辨。
 * 那一半若合进 electron 文件，就只能靠 `--shot` 真窗口取证（一次几十秒），且
 * "取消保存对话框"这一支根本没法在脚本里稳定制造。
 *
 * 与 `export-plan.test.ts`（E1–E4 + X8）**分工不重叠**：那一格验 `exportPlan` 这个纯函数
 * 本身（不 import electron、字节稳定、排序稳定）；本文件验**它外面那一圈** ——
 * 快照编码/解码、契约拒绝、错误收成 `ok:false` 而不是抛。
 */

const PID = '0193bb00-0000-7000-8000-0000000000f1' as EntityId;
const STOREY = '0193bb00-0000-7000-8000-0000000000f2' as EntityId;
const P1 = '0193bb00-0000-7000-8000-0000000000f3' as EntityId;
const P2 = '0193bb00-0000-7000-8000-0000000000f4' as EntityId;
const W1 = '0193bb00-0000-7000-8000-0000000000f5' as EntityId;

/** 一层一堵墙（够 `planSheet` 出图，也够 `clipSheet` 剖出东西）。 */
function buildDoc(reverseInsertion = false): Document {
  const entries: Array<[EntityId, Entity]> = [
    [STOREY, { kind: 'storey' as const, id: STOREY, projectId: PID, index: 0, elevationMm: 0, heightMm: 3000 }],
    [P1, { kind: 'point' as const, id: P1, storeyId: STOREY, x: 0, y: 0 }],
    [P2, { kind: 'point' as const, id: P2, storeyId: STOREY, x: 3600, y: 0 }],
    [W1, { kind: 'wall' as const, id: W1, storeyId: STOREY, startId: P1, endId: P2, thicknessMm: 240, heightMm: 3000, elevationOffsetMm: 0, loadBearing: true, material: '砖' }],
  ];
  if (reverseInsertion) entries.reverse();
  return Document.replaceEntities(Document.create(PID), new Map(entries));
}

const OPTS = {
  title: '平面图',
  drafter: '搭家',
  sheetNo: 'A-101',
  date: '2026-10-06',
} as const;

function requestOf(doc: Document, opts?: Partial<ExportPlanRequestShape['opts']>): ExportPlanRequestShape {
  return {
    doc: encodeDocumentPayload(doc),
    opts: { storeyId: STOREY, ...OPTS, ...opts },
  };
}

function tmpPdf(): string {
  return join(tmpdir(), `export-ipc-${Math.random().toString(36).slice(2)}.pdf`);
}

function srcOf(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

describe('导出 IPC 的电子自由内核', () => {
  it('快照往返：encode → decode 得到 canonical() 逐字相同的文档（线上契约是三键）', () => {
    const doc = buildDoc();
    const payload = encodeDocumentPayload(doc);
    // 线上契约**没有 journalTurn**：renderer 没有合法的 turn 可填（P-18）。
    expect(Object.keys(payload).sort()).toEqual(['entities', 'projectId', 'schemaVersion']);
    const back = decodeDocumentPayload('测试', payload);
    expect(back.canonical()).toBe(doc.canonical());
    expect(back.projectId).toBe(PID);
  });

  it('编码按 id 升序，不随 Map 插入序漂（与 codec 的落盘口径一致）', () => {
    const a = encodeDocumentPayload(buildDoc(false)).entities.map((e) => e.id);
    const b = encodeDocumentPayload(buildDoc(true)).entities.map((e) => e.id);
    expect(a).toEqual(b);
    // 且确实是升序，不是碰巧两个夹具同序。
    expect([...a].sort()).toEqual(a);
  });

  it('runExportPlan 落盘一个真 PDF：ok:true 带 outPath，两次跑字节逐字相同', () => {
    const doc = buildDoc();
    const req = requestOf(doc);
    const p1 = tmpPdf();
    const p2 = tmpPdf();
    const r1 = runExportPlan(req, p1);
    const r2 = runExportPlan(req, p2);
    expect(r1.ok).toBe(true);
    expect(r1.outPath).toBe(p1);
    // 两次都报回自己的路径（outPath 不是上一轮留下的陈值）。
    expect(r2.ok).toBe(true);
    expect(r2.outPath).toBe(p2);
    const bytes1 = readFileSync(p1);
    const bytes2 = readFileSync(p2);
    expect(bytes1.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(Buffer.compare(bytes1, bytes2)).toBe(0);
  });

  it('X8 给了 clipLine ⇒ 经 IPC 两页（字节比单页长）且仍可复现', () => {
    const doc = buildDoc();
    const one = tmpPdf();
    const two = tmpPdf();
    runExportPlan(requestOf(doc), one);
    const reqClip = requestOf(doc, { clipLine: { a: { x: -50, y: 0 }, b: { x: 50, y: 0 } } });
    expect(runExportPlan(reqClip, two).ok).toBe(true);
    expect(readFileSync(two).length).toBeGreaterThan(readFileSync(one).length);
    // 同输入复现。
    const twoAgain = tmpPdf();
    runExportPlan(reqClip, twoAgain);
    expect(Buffer.compare(readFileSync(two), readFileSync(twoAgain))).toBe(0);
  });

  it('坏请求收成 ok:false 而不是抛：缺 storeyId / 实体重复 / 根本不是对象', () => {
    const p = tmpPdf();
    // 缺 storeyId（EntityIdSchema 要 UUIDv7）。
    const missing = runExportPlan({ doc: encodeDocumentPayload(buildDoc()), opts: { ...OPTS } }, p);
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('导出请求');

    // 同一个实体 id 出现两次：zod 的数组不查重复，靠 decode 的 Map 守卫当场抛。
    const doc = buildDoc();
    const dup = { ...encodeDocumentPayload(doc), entities: [...encodeDocumentPayload(doc).entities, encodeDocumentPayload(doc).entities[0]!] };
    const repeated = runExportPlan({ doc: dup, opts: { storeyId: STOREY, ...OPTS } }, p);
    expect(repeated.ok).toBe(false);
    expect(repeated.error).toContain('出现两次');

    // 压根不是对象。
    expect(runExportPlan('nope', p).ok).toBe(false);
  });

  it('边界纪律：core 与 preload 不许 import electron；renderer 的 encode 半边不许值导入 protocol', () => {
    // electron-free 内核：碰 electron 就意味着这段逻辑只能靠真窗口取证。
    const core = srcOf('../../src/main/ipc/export-plan-core.ts');
    expect(core.includes("from 'electron'")).toBe(false);
    expect(core.includes('runExportPlan')).toBe(true);

    // 共享两半：decode 侧（主进程）可用 protocol；encode 侧（渲染进程）**只许类型导入** ——
    // 值导入会把 zod 拖进浏览器包，而 renderer 段根本没 alias protocol。
    const decode = srcOf('../../src/shared/document-wire.ts');
    expect(decode.includes('parseDocumentPayload')).toBe(true);
    const encode = srcOf('../../src/shared/document-payload.ts');
    expect(encode.includes('import type { DocumentPayloadShape }')).toBe(true);
    // encode 侧不许出现 protocol 的值导入（`import {` 开头且带 protocol）。
    expect(/import\s*\{[^}]*\}\s*from\s*'@dajia\/protocol'/.test(encode)).toBe(false);
    expect(encode.includes('node:')).toBe(false);
  });
});
