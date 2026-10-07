import { requireWall, wallSetMaterial, uuidv7 } from '@dajia/core';
import { demoHouse, fitStorey, storeyTabsOf } from '@dajia/scene-2d';
import { describe, expect, it, afterEach } from 'vitest';
import type {
  CloseRequest,
  DocumentPayloadShape,
  OpenDecision,
  PersistErrorCode,
  SaveStatusWire,
  SubmitRequest,
} from '@dajia/protocol';
import { documentFromPayload, payloadFromDocument } from '../../src/shared/document-wire';
import { useEditor } from '../../src/renderer/src/stores/editorStore';
import { createProjectStore, readDajia } from '../../src/renderer/src/stores/projectStore';
import type { DajiaApi } from '../../src/preload/index';
import { DEMO, resetEditor } from './editor-fixtures';
import { tick } from './fake-timer';

/** 服务端那份文档：**故意**再调一次 `demoHouse()` —— 它必须与屏幕上那套不是同一套房
 *  （随机 id ⇒ 两套房），于是"换手以后屏幕上画的确实是回包那一份"这件事才判得出来。
 *  与 `editor-fixtures.ts` 那句"绝不再调一次"不冲突：那儿要的是**基准**，这儿要的是**对手**。 */
const SERVER = demoHouse();
const SERVER_PID = SERVER.doc.projectId;

const STATUS_IDLE: SaveStatusWire = {
  phase: 'idle', queuedTurns: 0, lastTurn: 7, snapshotTurn: 5,
  rowsSinceSnapshot: 2, lastError: null, pauseReason: null,
};

function openValueFixture(init: {
  doc?: DocumentPayloadShape;
  decision?: OpenDecision;
  name?: string;
  wasCleanShutdown?: boolean;
  replayedRows?: number;
  emergencyCount?: number;
}) {
  const payload = init.doc ?? payloadFromDocument(SERVER.doc);
  const projectId = payload.projectId;
  const count = init.emergencyCount ?? 0;
  return {
    decision: init.decision ?? 'edit',
    header: {
      projectId,
      name: init.name ?? '样例房',
      schemaVersion: 1,
      journalTurn: 0,
      wasCleanShutdown: init.wasCleanShutdown ?? true,
    },
    doc: payload,
    snapshot: null,
    replayed: { rows: init.replayedRows ?? 0, fromSeq: null, toSeq: null },
    emergency: Array.from({ length: count }, (_unused, i) => ({
      turn: i + 1,
      path: `C:/dajia/emergency/${'x'.repeat(36)}-turn-${String(i + 1)}.json`,
    })),
  };
}

function makeApi() {
  const submits: SubmitRequest[] = [];
  const closes: CloseRequest[] = [];
  const opens: string[] = [];
  /**
   * 三个假把式共用的一根顺序针（同族先例：`session.test.ts` 的夹具订正）：
   * `reopenAsEdit()` 那格要判的是"先 abandon 再 open"，而 `toEqual` 逐字比一串名字才读得出
   * "少一步"和"顺序反了" —— 分开数 `closes.length` 与 `opens.length` 只能证"各来了一次"。
   */
  const calls: string[] = [];
  const listeners: Array<(s: SaveStatusWire) => void> = [];
  const queue: ReturnType<typeof openValueFixture>[] = [];
  const box = {
    /** 非 null ⇒ 这一发 `open` 直接回失败（`opens` 与 `calls` 照记：失败重试那一型要有证人）。 */
    openFail: null as { code: PersistErrorCode; message: string } | null,
    submitFail: null as { code: PersistErrorCode; message: string } | null,
  };
  const api: DajiaApi = {
    ping: async () => 'pong',
    // brief 定稿于计划 5 之前，假 api 只有五件；裁决 T8-A③ 保住 `exportPlan` 之后这里必须
    // 补第六件才满足 `DajiaApi` —— 本档 11 格没有一发走导出，回包形状照契约的 `ok:false` 支。
    exportPlan: async () => ({ ok: false, error: '夹具不走导出' }),
    openProject: async (projectId) => {
      opens.push(projectId);
      calls.push('open');
      if (box.openFail !== null) return { ok: false, code: box.openFail.code, message: box.openFail.message };
      const next = queue.shift();
      if (next === undefined) throw new Error('夹具没准备回包：这一发 open 会挂在 await 上');
      return { ok: true, value: next };
    },
    submitJournal: async (request) => {
      submits.push(request);
      calls.push('submit');
      if (box.submitFail !== null) {
        return { ok: false, code: box.submitFail.code, message: box.submitFail.message };
      }
      return { ok: true, value: { outcome: 'queued', acceptedTurn: submits.length } };
    },
    closeProject: async (request) => {
      closes.push(request);
      calls.push(`close:${request.mode}`);
      return request.mode === 'abandon'
        ? { ok: true, value: { elementRows: null, storeyRows: null } }
        : { ok: true, value: { elementRows: 31, storeyRows: 2 } };
    },
    onSaveStatus: (listener) => {
      listeners.push(listener);
      return () => {
        const at = listeners.indexOf(listener);
        if (at >= 0) listeners.splice(at, 1);
      };
    },
  };
  return { api, submits, closes, opens, calls, listeners, queue, box };
}

type Fake = ReturnType<typeof makeApi>;

/** 每一格自己的 store + 订阅，`afterEach` 统一撤（见本节开头那句"下一格收走上一格"）。 */
const stops: Array<() => void> = [];

function mount(f: Fake) {
  const [store, stop] = createProjectStore(f.api, useEditor);
  stops.push(stop);
  return store;
}

/** 把 `open` 走完（含 `loadProject` 那一发订阅与 `put` 那一发），并等 `submitJournal` 的微任务落地。 */
async function openProject(f: Fake, store: ReturnType<typeof mount>, init?: Parameters<typeof openValueFixture>[0]) {
  f.queue.push(openValueFixture(init ?? {}));
  await store.getState().open(SERVER_PID);
  await tick();
}

afterEach(() => {
  for (const stop of stops) stop();
  stops.length = 0;
  resetEditor();
});

describe('readDajia：node 档与注入档', () => {
  it('没有 window 回 null；挂上 window.dajia 回**同一个引用**；撤掉又回 null', () => {
    const g = globalThis as { window?: { dajia?: DajiaApi } };
    expect(readDajia()).toBeNull();
    const api = makeApi().api;
    g.window = { dajia: api };
    expect(readDajia()).toBe(api);
    delete g.window;
    expect(readDajia()).toBeNull();
  });
});

describe('初始态与打开失败', () => {
  it('刚建好：phase off、banner null，屏幕上还是样例房且可写（⑧段那一屏）', () => {
    resetEditor();
    const f = makeApi();
    const store = mount(f);
    const s = store.getState();
    expect(s.phase).toBe('off');
    expect(s.opened).toBeNull();
    expect(s.failure).toBeNull();
    expect(s.save).toBeNull();
    expect(s.closedReport).toBeNull();
    expect(s.banner).toBeNull(); // ⇒ App 一个 DOM 节点都不渲染
    // 屏幕没被碰：还是样例房那一份、还是可写。`DEMO` 是 import 那一刻取的引用（⑤ 段），
    // 这一格刚 `resetEditor()` 过 ⇒ 判"这一发 store 建起来有没有顺手改屏幕"只有拿它对照才判得出。
    expect(useEditor.getState().log).toBe(DEMO.log);
    expect(useEditor.getState().readOnly).toBe(false);
    expect(f.submits.length).toBe(0);
    // 模块级 `useProject` 也在监听同一个 editor 单例，但它 `phase === 'off'` ⇒ 订阅体第一道闸门就拦住。
    // 这一格因此同时是"两份 store 互不干扰"的凭据：判据是 `f.submits` 空，而不是"看起来没事"。
  });

  it('回 `{ok:false, code:\'not-configured\'}` ⇒ red 横幅、phase 回 off、真源**没换手**', async () => {
    resetEditor();
    const f = makeApi();
    f.box.openFail = { code: 'not-configured', message: '没读到 DAJIA_MYSQL_* 环境变量' };
    const store = mount(f);
    await store.getState().open(SERVER_PID);
    const s = store.getState();
    expect(s.phase).toBe('off');
    expect(s.opened).toBeNull();
    expect(s.failure).toEqual({ code: 'not-configured', message: '没读到 DAJIA_MYSQL_* 环境变量' });
    expect(s.banner?.tone).toBe('red');
    expect(s.banner?.text).toBe('没读到 DAJIA_MYSQL_* 环境变量');
    expect(s.banner?.closable).toBe(false);
    expect(s.banner?.reopenable).toBe(false);
    // 真源没换手：样例房那一份 `TransactionLog` 实例还在原处。这一句必须与 `DEMO`（import 那一刻
    // 从活状态取的引用，⑤ 段）比 —— 拿 `useEditor.getState()` 现读一份去和它自己比是假判据：
    // 这一格刚 `resetEditor()` 过，现读读到的正是"没换手"想判的那一份，谁都过。
    expect(useEditor.getState().log).toBe(DEMO.log);
    expect(useEditor.getState().storeyId).toBe(DEMO.storeyId);
    expect(useEditor.getState().readOnly).toBe(false);
    // 只发了一次（失败那支不许重试），而且**没消费任何回包**：走的是 `!r.ok` 那一支，不是成功那一支。
    expect(f.opens).toEqual([SERVER_PID]);
    expect(f.queue.length).toBe(0);
  });
});

describe('open 成功与两种 decision', () => {
  it('open 成功那一支：换手 + 六格读数 + 横幅那一句灰话 + **零发账**', async () => {
    const f = makeApi();
    const store = mount(f);
    await openProject(f, store);
    const s = store.getState();
    expect(s.phase).toBe('open');
    expect(s.opened).not.toBeNull();
    expect(s.opened?.projectId).toBe(SERVER_PID);
    expect(s.opened?.decision).toBe('edit');
    expect(s.opened?.name).toBe('样例房');
    expect(s.opened?.wasCleanShutdown).toBe(true);
    expect(s.opened?.replayedRows).toBe(0);
    expect(s.opened?.emergencyCount).toBe(0);
    expect(s.opened?.emergencyHint).toBe('');
    // 换手到手的是**回包那一份**，不是样例房那一份 —— `SERVER` 与 `DEMO` 是两套随机 id 的房子，
    // 这一句只有真换手才成。
    expect(useEditor.getState().log.document.equals(SERVER.doc)).toBe(true);
    expect(useEditor.getState().readOnly).toBe(false);
    expect(s.banner?.tone).toBe('grey');
    expect(s.banner?.closable).toBe(true);
    expect(s.banner?.reopenable).toBe(false);
    expect(String(s.banner?.text)).toContain('样例房');
    expect(String(s.banner?.text)).toContain('已保存到第 0 发');
    // ⑤段 `lastSeen` 初值那三行注释的唯一凭据：样例房那份 `lastPatch`（非 null！）
    // 与 `loadProject` 那一发扳机都不许变成账。
    expect(f.submits.length).toBe(0);

    // 第二段：`computeBanner` 第 6 条优先级 + spec §9 那句"明确告知恢复了什么"。
    const f2 = makeApi();
    const store2 = mount(f2);
    await openProject(f2, store2, { wasCleanShutdown: false, replayedRows: 2 });
    const s2 = store2.getState();
    expect(s2.banner?.tone).toBe('amber');
    expect(String(s2.banner?.text)).toContain('上次没有正常结束');
    expect(String(s2.banner?.text)).toContain('重放 2 发');
    expect(s2.banner?.closable).toBe(true);
    expect(s2.banner?.reopenable).toBe(false);
    // 横幅那句话的读数来源就是 `opened.wasCleanShutdown`：只断文案会放行"文案写死"那一型。
    expect(s2.opened?.wasCleanShutdown).toBe(false);
    // 优先级反判据：第 6 条不许抢第 7 条的话（合并成 `||` 也能绿的形状，只有这两句分得出）。
    expect(String(s2.banner?.text)).not.toContain('盘上留着');

    // 第三段：第 7 条（`emergencyCount > 0`），`wasCleanShutdown` 回默认 true ⇒ 第 6 条不抢话。
    const f3 = makeApi();
    const store3 = mount(f3);
    await openProject(f3, store3, { emergencyCount: 3 });
    const s3 = store3.getState();
    expect(s3.banner?.tone).toBe('amber');
    expect(String(s3.banner?.text)).toContain('盘上留着 3 份没并进库的现场');
    // `emergency.at(-1)?.path` 那一行的凭据：断"最新那份"的片段，完整路径属于夹具形状。
    expect(String(s3.banner?.text)).toContain('turn-3');
    expect(s3.opened?.emergencyCount).toBe(3);
    expect(String(s3.banner?.text)).not.toContain('上次没有正常结束');
  });

  it('read-only：闸门 + 横幅 + 双保险', async () => {
    const f = makeApi();
    const store = mount(f);
    await openProject(f, store, { decision: 'read-only' });
    expect(useEditor.getState().readOnly).toBe(true);
    const s = store.getState();
    expect(s.banner?.tone).toBe('amber');
    expect(String(s.banner?.text)).toContain('只读打开');
    expect(f.submits.length).toBe(0);
    // 两道闸门同时落下：editorStore 挡住 dispatch ⇒ 连"发"的机会都没有。摘掉 `setReadOnly`
    // 那一行，这一句就红在第二道闸门（订阅体的 `decision !== 'edit'`）而不是第一道。
    useEditor.getState().dispatch(
      wallSetMaterial({ wallId: SERVER.doc.byKind('wall')[0].id, material: '混凝土' }),
    );
    expect(String(useEditor.getState().lastError)).toMatch(/^只读工程：/);
    expect(f.submits.length).toBe(0);
  });
});

describe('发账：扳机、视图动作与 P-21', () => {
  it('改一发 = 一发账，undo 也是一发', async () => {
    const f = makeApi();
    const store = mount(f);
    await openProject(f, store);
    f.submits.length = 0;
    const w = SERVER.doc.byKind('wall')[0];
    useEditor.getState().dispatch(wallSetMaterial({ wallId: w.id, material: '混凝土' }));
    expect(f.submits.length).toBe(1);
    // **对象身份**（⑨段判的就是身份），不是 `toEqual`。
    expect(f.submits[0].patch).toBe(useEditor.getState().log.lastPatch);
    expect(f.submits[0].projectId).toBe(SERVER_PID);
    expect(requireWall(documentFromPayload(f.submits[0].doc, 'test'), w.id).material).toBe('混凝土');
    await tick();
    useEditor.getState().undo();
    expect(f.submits.length).toBe(2);
    expect(f.submits[1].patch).not.toBe(f.submits[0].patch); // 逆补丁是另一个对象
    // 退回旧值 —— 撤销在库里是一发**新**账，不是删掉上一行。
    expect(requireWall(documentFromPayload(f.submits[1].doc, 'test'), w.id).material).toBe(w.material);
    await tick();
    expect(store.getState().failure).toBeNull();
  });

  it('视图动作一发都不发（⑨段的靶子）', async () => {
    const f = makeApi();
    const store = mount(f);
    await openProject(f, store);
    f.submits.length = 0;
    const revision = useEditor.getState().revision;
    const tabs = storeyTabsOf(SERVER.doc, SERVER_PID);
    useEditor.getState().setStorey(tabs[1].storeyId, fitStorey(SERVER.doc, tabs[1].storeyId, 800, 600));
    useEditor.getState().setTool('wall');
    useEditor.getState().setViewport(fitStorey(SERVER.doc, tabs[0].storeyId, 700, 500), tabs[0].storeyId);
    expect(f.submits.length).toBe(0);
    // 必须同时断这一句：只断"没发账"而 revision 也没动的话，红的是"扳机根本没扳"，
    // 看不出订阅体在不在工作。
    expect(useEditor.getState().revision).not.toBe(revision);
  });

  it('dispatchBatch 三条 = 三发账，且每发配它自己那一刻的整份快照', async () => {
    const f = makeApi();
    const store = mount(f);
    await openProject(f, store);
    f.submits.length = 0;
    const walls = SERVER.doc.byKind('wall');
    const baseMat = [walls[0].material, walls[1].material, walls[2].material];
    useEditor.getState().dispatchBatch([
      wallSetMaterial({ wallId: walls[0].id, material: 'P-1' }),
      wallSetMaterial({ wallId: walls[1].id, material: 'P-2' }),
      wallSetMaterial({ wallId: walls[2].id, material: 'P-3' }),
    ]);
    await tick();
    // **这一句就是 P-21 的靶子**：改回"一批一扳"它变 1。
    expect(f.submits.length).toBe(3);
    expect(f.submits[0].patch).not.toBe(f.submits[1].patch);
    expect(f.submits[1].patch).not.toBe(f.submits[2].patch);
    expect(f.submits[0].patch).not.toBe(f.submits[2].patch);
    // 第一发的快照里第二、三面墙**还是旧材料**：编码在 await 之前，每发配同源快照。
    expect(requireWall(documentFromPayload(f.submits[0].doc, 'test'), walls[1].id).material).toBe(baseMat[1]);
    expect(requireWall(documentFromPayload(f.submits[2].doc, 'test'), walls[1].id).material).toBe('P-2');

    // 半途失败那一支：第三条根本不该应用。
    f.submits.length = 0;
    const depth = useEditor.getState().log.depth;
    useEditor.getState().dispatchBatch([
      wallSetMaterial({ wallId: walls[3].id, material: 'Q-1' }),
      wallSetMaterial({ wallId: uuidv7(), material: 'Q-x' }),
      wallSetMaterial({ wallId: walls[4].id, material: 'Q-2' }),
    ]);
    await tick();
    expect(f.submits.length).toBe(1);
    expect(String(useEditor.getState().lastError)).toMatch(/^删不动：/);
    expect(useEditor.getState().log.depth).toBe(depth + 1);
    expect(store.getState().failure).toBeNull();
  });
});

describe('事件、出路码与两种失败', () => {
  it('保存状态驱动横幅四档；`stop()` 撤掉事件订阅**和**编辑订阅', async () => {
    const f = makeApi();
    const [store, stop] = createProjectStore(f.api, useEditor); // 不用 `mount`：这一格要 `stop` 本体
    stops.push(stop);
    await openProject(f, store);
    expect(f.listeners.length).toBe(1);

    f.listeners[0](STATUS_IDLE);
    expect(store.getState().save?.phase).toBe('idle');
    expect(store.getState().banner?.text).toContain('已保存到第 7 发');
    f.listeners[0]({ ...STATUS_IDLE, phase: 'paused', pauseReason: '锁已丢' });
    expect(store.getState().banner?.tone).toBe('red');
    expect(store.getState().banner?.reopenable).toBe(true); // 第 ⑤ 段的出路在这一屏上长成一个按钮
    // 第四档 = `computeBanner` 的第 5 条（`failed`）。它与上一档只差一个 `phase`，判据差在两端：
    // `failed` 给的是"查服务"（下一步动作在库那侧，`reopenable` 必须回 false —— 重开也修不好断连），
    // `paused` 给的是"别再写了"（下一步动作在用户这侧）。少了这一发，第 5 条那一句就没有读者，
    // 而把 3、5 两条并成一个 `if` 也照样绿 —— 那一并正是"每个码都有下一步动作"③段最容易被磨平的形状。
    f.listeners[0]({ ...STATUS_IDLE, phase: 'failed', lastError: 'ECONNREFUSED' });
    expect(store.getState().banner?.tone).toBe('red');
    expect(store.getState().banner?.text).toContain('保存失败：ECONNREFUSED');
    expect(store.getState().banner?.reopenable).toBe(false);

    const callback = f.listeners[0];
    stop();
    // (a) 事件那一半：注册表空了。`onSaveStatus` 返回空函数的话这一句红 —— 而**不能**改成
    // "再调一次 `callback`，看 `save` 更没更新"：手里已经抓住的那个闭包永远还能写 store，
    // 生产里 `removeListener` 之后根本不会再有人调它。假把式能证的只有引用有没有撤干净。
    expect(f.listeners.length).toBe(0);
    callback({ ...STATUS_IDLE, phase: 'saving', queuedTurns: 9 }); // 拿着旧引用硬打一发：不作为判据
    // (b) 编辑那一半：订阅也撤了。这一句才是本节开头"下一格收走上一格的编辑"的证人。
    f.submits.length = 0;
    useEditor.getState().dispatch(wallSetMaterial({ wallId: SERVER.doc.byKind('wall')[0].id, material: '混凝土' }));
    await tick();
    expect(f.submits.length).toBe(0);
    // `afterEach` 会对同一个 `stop` 再发一次：`removeListener` 与夹具的 `splice` 都吃重复，
    // 所以这一格不需要把 `stop` 从 `stops` 里摘出去（摘出去反而会让"忘了撤"那一型失去守卫）。
  });

  it('reopenAsEdit() = 先 abandon 再 open，顺序读得出来', async () => {
    const f = makeApi();
    const store = mount(f);
    await openProject(f, store);
    f.listeners[0]({ ...STATUS_IDLE, phase: 'paused', pauseReason: '锁已丢' }); // 把横幅推到 reopenable 那一档
    f.queue.push(openValueFixture({})); // 重开那一发的回包
    await store.getState().reopenAsEdit();
    await tick();
    // 一根共享的 `calls` 针：`toEqual` 逐字比一串名字才读得出"少一步"和"顺序反了"。
    expect(f.calls).toEqual(['open', 'close:abandon', 'open']);
    expect(f.closes[0].mode).toBe('abandon');
    expect(f.opens.length).toBe(2);
    expect(f.opens[0]).toBe(SERVER_PID);
    expect(f.opens[1]).toBe(SERVER_PID);
    expect(store.getState().phase).toBe('open');
    expect(useEditor.getState().readOnly).toBe(false); // 从只读翻回可写只有一条路：重开
    // 交上去的是**换手之后**那份文档，不是样例房那一份（`abandon` 不跑对账 ⇒ 两格 null，夹具已按此形状回）。
    expect(documentFromPayload(f.closes[0].doc, 'test').equals(SERVER.doc)).toBe(true);

    // 第二段：`closeSession('graceful')` 的那两格读数有人读（另起一根针，免得把上面那串 `calls` 搅长）。
    const f2 = makeApi();
    const store2 = mount(f2);
    await openProject(f2, store2);
    await store2.getState().closeSession('graceful');
    expect(f2.calls).toEqual(['open', 'close:graceful']); // 模式名进针里就是这一句的用处
    expect(store2.getState().phase).toBe('closed');
    expect(store2.getState().failure).toBeNull();
    expect(store2.getState().closedReport).toEqual({ elementRows: 31, storeyRows: 2 }); // 原样过界没人重算
    expect(store2.getState().banner?.tone).toBe('grey');
    expect(String(store2.getState().banner?.text)).toContain('31 行元素');
    expect(String(store2.getState().banner?.text)).toContain('2 行楼层');
    expect(store2.getState().banner?.closable).toBe(false); // 关了就没有第二个关
    expect(useEditor.getState().readOnly).toBe(true);
    useEditor.getState().dispatch(wallSetMaterial({ wallId: SERVER.doc.byKind('wall')[0].id, material: '混凝土' }));
    expect(String(useEditor.getState().lastError)).toMatch(/^只读工程：/);
    expect(f2.submits.length).toBe(0);
    // `setReadOnly(true)` 放在 `r.ok` 判断**之外**那条注释在这里同时钉住了成功那一支：不许漏落闸门。

    // 收尾再证一句"关了之后可以重开"（第 ⑤ 段那条顺序的另一半）：`open` 的闸门只挡 `opening / open`。
    // 别"顺手"给它加第三道 phase 判据 —— 加了这一句就红，而 `reopenAsEdit()` 那条路也会被同一道闸拦死。
    f2.queue.push(openValueFixture({}));
    await store2.getState().open(SERVER_PID);
    expect(f2.calls).toEqual(['open', 'close:graceful', 'open']);
    expect(store2.getState().phase).toBe('open');
    expect(useEditor.getState().readOnly).toBe(false); // `open` 成功那一支自己会把闸门抬回去
  });

  it("'reconcile' 停手，'db' 不停手", async () => {
    const f = makeApi();
    const store = mount(f);
    await openProject(f, store);
    f.box.submitFail = { code: 'reconcile', message: '三方对账不平' };
    useEditor.getState().dispatch(wallSetMaterial({ wallId: SERVER.doc.byKind('wall')[0].id, material: '混凝土' }));
    await tick();
    expect(store.getState().banner?.tone).toBe('red');
    expect(String(store.getState().banner?.text)).toContain('三方对账不平');
    // ③段那句"reconcile 的下一步动作是停下来别再写了"在屏幕侧唯一的落地。
    expect(useEditor.getState().readOnly).toBe(true);

    // 两支各自一个 store：`readOnly` 是 editor 单例上的格，前一支设成 true 之后不 reset
    // 就会串到后一支，得到一个"两边都只读"的假绿。
    resetEditor();
    // **必须把前一支的 store 也停掉**（T8 收尾时补，`stops` 只在 `afterEach` 清过）：
    // `mount` 把 `stop` 压进 `stops`，而这一格中途不退它⇒ **两个 store 同时订阅着同一个
    // `useEditor` 单例**。第二支的 `dispatch` 于是**两个订阅体都触发**，第一个 store 走它
    // 自己的 `submitOne`、命中它自己的 `submitFail: 'reconcile'` ⇒ 把 `readOnly` 设成 true。
    //
    // 读数（实测）：dispatch 前false → dispatch 后 false → **tick 之后 true**。
    // tick 是 `submitJournal` 回包落地的那一拍，所以设值发生在回包里，不在 dispatch 里。
    //
    // 判据自己的注释说"reset 一下就不会串" —— reset 只清了 `readOnly` 这一格，**没摘订阅**，
    // 于是串味从"闸门状态"换成了"两个会话同时在跑"。这一格要断的是 `'db'` 不停手，
    // 就必须让第二支**独占**编辑器，否则它量到的是第一支的账。
    //
    // 顺带记一笔生产含义：`readOnly` 是**编辑器单例**上的格，而工程会话可以有多个 ——
    // 单编辑器 + 多会话这个组合天然要求"同一时刻只有一个会话在驱动它"（S1 单窗口单工程，
    // 那条前提成立；S6 多工程并行时这条会成为真问题）。
    for (const stop of stops.splice(0)) stop();
    resetEditor();
    const f2 = makeApi();
    const store2 = mount(f2);
    await openProject(f2, store2);
    f2.box.submitFail = { code: 'db', message: 'ECONNREFUSED' };
    useEditor.getState().dispatch(wallSetMaterial({ wallId: SERVER.doc.byKind('wall')[0].id, material: '钢' }));
    await tick();
    expect(store2.getState().banner?.tone).toBe('red'); // 同一格文案位置
    expect(String(store2.getState().banner?.text)).toContain('ECONNREFUSED');
    // 服务断了不代表账错了 —— 把用户的编辑权拿走才是更坏的消息。
    expect(useEditor.getState().readOnly).toBe(false);
  });
});
