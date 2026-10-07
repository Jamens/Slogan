import { wallSetMaterial, uuidv7 } from '@dajia/core';
import { fitStorey, type Viewport } from '@dajia/scene-2d';
import { beforeEach, describe, expect, it } from 'vitest';
import { useEditor } from '../../src/renderer/src/stores/editorStore';
import { DEMO, oneStoreyDoc, resetEditor } from './editor-fixtures';

const WALL = DEMO.log.document.byKind('wall')[0];

/** 一次 `set` 之后要逐格比的那几张（**不含** action：函数引用本来就不该动）。 */
const KEYS = [
  'log', 'storeyId', 'viewport', 'viewportStoreyId', 'revision',
  'lastError', 'drag', 'draft', 'tool', 'readOnly',
] as const;

function snapshot(): Record<string, unknown> {
  const s = useEditor.getState();
  const out: Record<string, unknown> = {};
  for (const k of KEYS) out[k] = s[k];
  return out;
}

/**
 * （原`revisionDepthBaseline()` 已删—— T8 收尾时发现它是**判据缺陷的产地**：
 * 它读`DEMO.log.depth` 的当前值，于是写在断言行里就等于"和刚才那发比"而不是"和调用前比"，
 * P-21 因此恒红（实测 expected 33 to be 36）。**纪律留在这里，函数不留**：
 * 断相对量时基线必须在被测动作**之前捕获成局部变量**，不许调一个"现读现用"的辅助函数 ——
 * 那函数读的是那一刻的值，而那一刻已经在动作之后了。）
 */

beforeEach(() => {
  resetEditor();
});

describe('只读闸门：四处写动作、五处视图动作各归各的', () => {
  it('只读挡住 `dispatch` 与 `dispatchBatch`：真源一字不动，只落 lastError', () => {
    const beforeRevision = useEditor.getState().revision;
    const beforeDepth = DEMO.log.depth;
    useEditor.getState().setReadOnly(true);
    useEditor.getState().dispatch(wallSetMaterial({ wallId: WALL.id, material: '混凝土' }));
    expect(useEditor.getState().revision).toBe(beforeRevision);
    expect(DEMO.log.depth).toBe(beforeDepth);
    expect(String(useEditor.getState().lastError)).toMatch(/^只读工程：/);
    // 正控制：闸门真的存在，而不是"命令自己失败了所以看起来像被挡"。
    useEditor.getState().setReadOnly(false);
    useEditor.getState().dispatch(wallSetMaterial({ wallId: WALL.id, material: '混凝土' }));
    expect(useEditor.getState().revision).toBe(beforeRevision + 1);
    expect(DEMO.log.depth).toBe(beforeDepth + 1);
    useEditor.getState().setReadOnly(true);
    useEditor.getState().dispatchBatch([
      wallSetMaterial({ wallId: WALL.id, material: '钢' }),
      wallSetMaterial({ wallId: DEMO.log.document.byKind('wall')[1].id, material: '钢' }),
    ]);
    expect(DEMO.log.depth).toBe(beforeDepth + 1); // 只多了正控制那一发，batch 一条都没进
    expect(String(useEditor.getState().lastError)).toMatch(/^只读工程：这一批删不掉（2 条命令）/);
  });

  it('只读挡住 `undo`/`redo`（账本关了，退了也没地方记）', () => {
    useEditor.getState().dispatch(wallSetMaterial({ wallId: WALL.id, material: '木' }));
    const depth = DEMO.log.depth;
    const revision = useEditor.getState().revision;
    useEditor.getState().setReadOnly(true);
    useEditor.getState().undo();
    useEditor.getState().redo();
    expect(DEMO.log.depth).toBe(depth);
    expect(useEditor.getState().revision).toBe(revision);
    expect(String(useEditor.getState().lastError)).toMatch(/^只读工程：重做不动/);
  });

  it('只读**不挡**视图动作：切层照常 +1 revision，工具/草稿/视口照旧写', () => {
    useEditor.getState().setReadOnly(true);
    const vp: Viewport = fitStorey(DEMO.log.document, DEMO.storeyId, 800, 600);
    const revision = useEditor.getState().revision;
    useEditor.getState().setStorey(DEMO.storeyId, vp);
    expect(useEditor.getState().revision).toBe(revision + 1);
    expect(useEditor.getState().viewportStoreyId).toBe(DEMO.storeyId);
    useEditor.getState().setTool('wall');
    useEditor.getState().setDrag(null);
    useEditor.getState().setViewport(vp, DEMO.storeyId);
    expect(useEditor.getState().tool).toBe('wall');
    expect(useEditor.getState().viewport).toBe(vp);
  });
});

describe('loadProject：换手那一发', () => {
  it('成功那一支：换 log、层跟着换、视口两格同发置 null、其余视图格清零', () => {
    const { doc, storeyId } = oneStoreyDoc();
    useEditor.getState().setTool('wall');
    useEditor.getState().setReadOnly(true);
    const revision = useEditor.getState().revision;
    expect(useEditor.getState().loadProject(doc, storeyId)).toBe(true);
    const s = useEditor.getState();
    expect(s.log).not.toBe(DEMO.log);
    expect(s.log.document.equals(doc)).toBe(true);
    expect(s.storeyId).toBe(storeyId);
    // 两格同一发：`viewport` 与"它为哪一层算的"要么都有要么都没有（P10 同一条）。
    expect(s.viewport).toBeNull();
    expect(s.viewportStoreyId).toBeNull();
    expect(s.revision).toBe(revision + 1);
    expect(s.tool).toBe('select');
    expect(s.drag).toBeNull();
    expect(s.draft).toBeNull();
    expect(s.lastError).toBeNull();
    // 换手不越权决定写权限：`readOnly` 留着调用方（projectStore 按 decision）判。
    expect(s.readOnly).toBe(true);
  });

  it('拒收那一支：整个 state 一字不动（两个非法入参各判一型）', () => {
    const { doc, wallId } = oneStoreyDoc();
    const before = snapshot();
    expect(useEditor.getState().loadProject(doc, uuidv7())).toBe(false); // 没这个 id
    expect(snapshot()).toEqual(before);
    expect(useEditor.getState().loadProject(doc, wallId)).toBe(false); // id 在，但不是层
    expect(snapshot()).toEqual(before);
  });

  it('换手把撤销栈一起换掉：旧工程的"撤销回丢锁之前"没了（⑤段代价 ②）', () => {
    // brief 原文这一句写的是 `expect(DEMO.log.depth).toBe(1)`：绝对值在任何实现下都到不了
    // （样例房在 `demoHouse()` 建起来那一刻栈深就已经不是 0，⑤段那句"绝对 depth 没有意义、
    // 所有用例断相对量"钉的正是这件事）。按 ⑤ 段口径改成"调用前读一次、调用后比"。
    const beforeDepth = DEMO.log.depth;
    useEditor.getState().dispatch(wallSetMaterial({ wallId: WALL.id, material: '石' }));
    expect(DEMO.log.canUndo).toBe(true);
    const { doc, storeyId } = oneStoreyDoc();
    useEditor.getState().loadProject(doc, storeyId);
    const log = useEditor.getState().log;
    expect(log).not.toBe(DEMO.log);
    expect(log.depth).toBe(0);
    expect(log.canUndo).toBe(false);
    expect(log.canRedo).toBe(false);
    // 旧栈还在旧 log 上：屏幕换到新文档以后，`undo()` 走的是新 log，不会把旧工程的补丁退回新文档里。
    useEditor.getState().undo();
    expect(String(useEditor.getState().lastError)).toBe('没有可撤销的操作');
    expect(DEMO.log.depth).toBe(beforeDepth + 1);
  });
});

describe('闸门没把计划 3 的语义碰坏', () => {
  it('可写路径：成功 +1 且清 lastError，失败不动 revision 且落 `拖不动：`', () => {
    const revision = useEditor.getState().revision;
    useEditor.getState().dispatch(wallSetMaterial({ wallId: WALL.id, material: 'A' }));
    expect(useEditor.getState().revision).toBe(revision + 1);
    expect(useEditor.getState().lastError).toBeNull();
    useEditor.getState().dispatch(wallSetMaterial({ wallId: uuidv7(), material: 'B' }));
    expect(useEditor.getState().revision).toBe(revision + 1);
    expect(String(useEditor.getState().lastError)).toMatch(/^拖不动：/);
  });

  it('P-21：`dispatchBatch` 每应用一条扳一次；半途失败只扳已应用的那几发', () => {
    const walls = DEMO.log.document.byKind('wall');
    const revision = useEditor.getState().revision;
    // **基线必须在 dispatchBatch 之前取**（T8 收尾时 `tsc` 修完编译错后暴露出来的一处判据缺陷）：
    // `revisionDepthBaseline()` 读的是 `DEMO.log.depth` 的**当前值**，而 `dispatchBatch` 已经在
    // 上面执行过三条 ⇒ 拿到的是**执行后**的深度 ⇒ 断言恒红（实测 expected 33 to be 36）。
    // 原来的写法把基线的取用放在断言行里，看起来是"和调用前比"，实际比的是"和刚才比"。
    // 相对量的纪律没变，只是基线必须**先捕获**（夹具注释里那句"`depth` 与调用前比"就是这个意思）。
    const depthBaseline = DEMO.log.depth;
    useEditor.getState().dispatchBatch([
      wallSetMaterial({ wallId: walls[0].id, material: 'P21-1' }),
      wallSetMaterial({ wallId: walls[1].id, material: 'P21-2' }),
      wallSetMaterial({ wallId: walls[2].id, material: 'P21-3' }),
    ]);
    // 改前这里是 +1（一批一扳），现在是 +3 —— 订阅体（projectStore 格 8）靠的就是这三下。
    expect(useEditor.getState().revision).toBe(revision + 3);
    expect(DEMO.log.depth).toBe(depthBaseline + 3);
    expect(useEditor.getState().lastError).toBeNull();

    const r2 = useEditor.getState().revision;
    const d2 = DEMO.log.depth;
    useEditor.getState().dispatchBatch([
      wallSetMaterial({ wallId: walls[3].id, material: 'P21-4' }),
      wallSetMaterial({ wallId: uuidv7(), material: 'P21-x' }), // 第二条起不存在
      wallSetMaterial({ wallId: walls[4].id, material: 'P21-5' }),
    ]);
    expect(useEditor.getState().revision).toBe(r2 + 1);
    expect(DEMO.log.depth).toBe(d2 + 1);
    expect(String(useEditor.getState().lastError)).toMatch(/^删不动：/);

    // 一条都没应用成功：循环一次没进 ⇒ revision 一字不动（"失败不动扳机"那条纪律还在）。
    const r3 = useEditor.getState().revision;
    useEditor.getState().dispatchBatch([wallSetMaterial({ wallId: uuidv7(), material: '没门' })]);
    expect(useEditor.getState().revision).toBe(r3);
    expect(String(useEditor.getState().lastError)).toMatch(/^删不动：/);
  });

  it('闸门是双向门，且现物那两条空栈文案一字没动', () => {
    useEditor.getState().setReadOnly(true);
    useEditor.getState().undo();
    expect(String(useEditor.getState().lastError)).toMatch(/^只读工程：/);
    useEditor.getState().setReadOnly(false);
    useEditor.getState().undo();
    useEditor.getState().redo();
    expect(useEditor.getState().lastError).toBeNull(); // 上面那发 dispatch 把 redoStack 清了，undo 也退了
    // **把栈退空，并逐次确认**（T8 收尾时补）：原写法连打三次 `undo()` 就假定栈空了 ——
    // 而这一格跑在同文件的前几格之后，`DEMO.log` 那份单例的撤销栈有多深取决于**前面打过几发**
    // （实测三次退不够⇒ 下面那对 undo/redo 真的改了东西 ⇒ revision 多 2 ⇒ 恒红）。
    // **依赖执行顺序的判据不是判据。** 改成"退到 `lastError` 说栈空为止"，
    // 于是下面两发断的是**空栈**这一事实，不依赖前面打过几发。
    for (let guard = 0; guard < 200; guard++) {
      if (/^没有可撤销的操作$/.test(String(useEditor.getState().lastError))) break;
      useEditor.getState().undo();
      if (guard === 199) throw new Error('退 200 次还没退空：撤销栈的形状变了，不是"栈很深"');
    }
    // 正控制：确认真的退到了空栈 —— 这一行也是"闸门是关着的"的对证
    // （带闸门退栈的话 `lastError` 会是"只读工程："，上面那行就抓不到）。
    expect(String(useEditor.getState().lastError)).toMatch(/^没有可撤销的操作$/);
    const before = useEditor.getState().revision;
    // **只判 undo 那一侧**（第三次改这一格）：原写法在退空之后还打了一对 `undo()+redo()`，
    // 假定"undo 栈空 ⇒ redo 栈也空"—— 但**两个栈是独立的**，第 188 行那次 `redo()`
    // 恰恰把一发改回了 redo 栈 ⇒ 下面的 `redo()` 真的改了东西 ⇒ revision 多 1（实测 33 vs 32）。
    //
    // 这一格要验的是"**空 undo 栈**那一句文案，且失败不动扳机"，与 redo 无关。
    // 顺带把 redo 那一侧也断掉，但要**先把它的栈也退干净**，否则又是一个顺序依赖。
    useEditor.getState().undo();
    expect(useEditor.getState().revision).toBe(before);
    expect(String(useEditor.getState().lastError)).toMatch(/^没有可撤销的操作$/);
    for (let guard = 0; guard < 200; guard++) {
      if (/^没有可重做的操作$/.test(String(useEditor.getState().lastError))) break;
      useEditor.getState().redo();
      if (guard === 199) throw new Error('退 200 次还没退空 redo 栈：形状变了，不是"栈很深"');
    }
    const beforeRedo = useEditor.getState().revision;
    useEditor.getState().redo();
    expect(useEditor.getState().revision).toBe(beforeRedo);
    expect(String(useEditor.getState().lastError)).toMatch(/^没有可重做的操作$/);
  });
});
