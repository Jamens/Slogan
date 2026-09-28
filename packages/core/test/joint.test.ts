// 接头分类与斜切量：只认拓扑、无缝闭合、非法即抛（计划 2 Task 4 的三条不变式）
import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  cornerPoint,
  cross,
  deriveJoints,
  dot,
  memberTrim,
  storeyCreate,
  uuidv7,
  wallAxisById,
  wallCreate,
  vec,
  type Entity, // （Task 7 加：handBuild 要贴 Entity[]）
  type Joint,
  type WallCreateInput,
  type WallEntity,
} from '@dajia/core';

const projectId = uuidv7();

/** 一层多墙，specs 里的 storeyId 与 heightMm 由本函数填。 */
function build(specs: Array<Omit<WallCreateInput, 'storeyId' | 'heightMm'>>) {
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  const storeyId = log.document.byKind('storey')[0]!.id;
  for (const spec of specs) log.dispatch(wallCreate({ storeyId, heightMm: 3000, ...spec }));
  return log;
}

function jointsAt(log: TransactionLog, pointId: string): Joint {
  const hit = deriveJoints(log.document).find((j) => j.pointId === pointId);
  if (!hit) throw new Error(`测试找不到接头 ${pointId}`);
  return hit;
}

/**
 * 取最近一次 dispatch 新建的墙。禁止 `byKind('wall').at(-1)`：同毫秒的 uuidv7
 * 不保证单调（Global Constraints 与计划 1 的 ids.test.ts），那样取新墙是掷硬币。
 */
function lastWall(log: TransactionLog): WallEntity {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new Error('最近一次 dispatch 没有新建墙');
}

/** 建一面复用 startId 的新墙，返回墙本体。 */
function appendWall(
  log: TransactionLog,
  startId: string,
  end: { x: number; y: number },
  thicknessMm: number,
): WallEntity {
  const storeyId = log.document.byKind('storey')[0]!.id;
  log.dispatch(
    wallCreate({ storeyId, start: { pointId: startId }, end, thicknessMm, heightMm: 3000 }),
  );
  return lastWall(log);
}

/**
 * **不经命令层**，把手工实体直接贴进文档：坐标相同的两端复用同一枚点 id（与命令层的
 * 共享端点语义一致），差别只在于绕开 `wallCreate` 那道门。
 *
 * 为什么需要它：Task 7 给 `wallCreate` / `wallMoveEndpoint` / `wallSetThickness` 加了派生
 * 复核（`assertDerivesAfterApply`），"合法命令造得出画不出的文档"这条路于是被堵死。那正是
 * 复核要的效果，但派生层这四道守卫（同向重叠 / 轮廓翻面 / 直通异厚 / star）必须**仍然可测** ——
 * 它们是读盘与协作写入（计划 4、计划 6）唯一的哨兵，不能因为命令层提前挡就把哨兵本身
 * 失去凭据。所以这些用例改成手工造文档；"命令层也挡得住"另由 `derive-guard.test.ts` 从正面钉。
 */
function handBuild(
  specs: Array<{
    start: { x: number; y: number };
    end: { x: number; y: number };
    thicknessMm: number;
  }>,
): Document {
  const storeyId = uuidv7();
  const entities: Entity[] = [
    { kind: 'storey', id: storeyId, projectId, index: 0, elevationMm: 0, heightMm: 3000 },
  ];
  const pointIds = new Map<string, string>();
  const pointOf = (at: { x: number; y: number }): string => {
    const key = `${at.x},${at.y}`;
    const hit = pointIds.get(key);
    if (hit) return hit;
    const id = uuidv7();
    pointIds.set(key, id);
    entities.push({ kind: 'point', id, storeyId, x: at.x, y: at.y });
    return id;
  };
  for (const spec of specs) {
    entities.push({
      kind: 'wall',
      id: uuidv7(),
      storeyId,
      startId: pointOf(spec.start),
      endId: pointOf(spec.end),
      thicknessMm: spec.thicknessMm,
      heightMm: 3000,
      elevationOffsetMm: 0,
      loadBearing: true,
      material: 'brick',
    });
  }
  return Document.replaceEntities(
    Document.create(projectId),
    new Map(entities.map((entity) => [entity.id, entity])),
  );
}

/** 直角 L：A (0,0)→P(1000,0)，B P→(1000,800)，同厚 240。 */
function rightL(thicknessA = 240, thicknessB = 240) {
  const log = build([
    { start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, thicknessMm: thicknessA },
  ]);
  const a = log.document.byKind('wall')[0]!;
  const b = appendWall(log, a.endId, { x: 1000, y: 800 }, thicknessB);
  return { log, sharedId: a.endId, a, b };
}

describe('分组只认拓扑', () => {
  it('一面孤墙给两个 free 接头，trim 全 0', () => {
    const log = build([{ start: { x: 0, y: 0 }, end: { x: 3600, y: 0 }, thicknessMm: 240 }]);
    const wall = log.document.byKind('wall')[0]!;
    const joints = deriveJoints(log.document);
    expect(joints).toHaveLength(2);
    expect(joints.map((j) => j.kind)).toEqual(['free', 'free']);
    for (const j of joints) {
      expect(j.members).toHaveLength(1);
      expect(j.members[0]!.trimLeftMm).toBe(0);
      expect(j.members[0]!.trimRightMm).toBe(0);
    }
    expect(joints.map((j) => j.pointId).sort()).toEqual([wall.startId, wall.endId].sort());
  });

  it('正对照：坐标撞在一起但不共享点，仍是两个 free，不是 corner', () => {
    // 少了这条，用例 3 之后的所有断言都可能只是"坐标吸附"在起作用
    const log = build([
      { start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, thicknessMm: 240 },
      { start: { x: 1000, y: 0 }, end: { x: 1000, y: 800 }, thicknessMm: 240 },
    ]);
    const kinds = deriveJoints(log.document).map((j) => j.kind);
    expect(kinds).toEqual(['free', 'free', 'free', 'free']);
    expect(log.document.byKind('point')).toHaveLength(4);
  });

  it('共线直通给 collinear，四侧 trim 全 0（两墙拼成一条连续带）', () => {
    const log = build([{ start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, thicknessMm: 240 }]);
    const storeyId = log.document.byKind('storey')[0]!.id;
    const w1 = log.document.byKind('wall')[0]!;
    log.dispatch(
      wallCreate({
        storeyId,
        start: { pointId: w1.endId },
        end: { x: 2000, y: 0 },
        thicknessMm: 240,
        heightMm: 3000,
      }),
    );
    const joint = jointsAt(log, w1.endId);
    expect(joint.kind).toBe('collinear');
    expect(joint.members).toHaveLength(2);
    for (const m of joint.members) {
      expect(m.trimLeftMm).toBe(0);
      expect(m.trimRightMm).toBe(0);
    }

    // 上面是**反向**配对的一正：一墙的 end 遇另一墙的 start，两墙拼成一条连续带。
    // 不变式 3 还要钉住同向那一例 —— 同一个点上两个墙端朝同一方向离开，那是两条完全
    // 重叠的墙带（用户在同一个点上朝同一方向画了两笔）。lineGroups 只按无向方向折桶，
    // 所以这种输入本身就会落到 collinear（trim 全 0）、什么也不报，必须由 assertNoSameRay
    // 在分类之前抛。Task 7 起命令层就会先挡住这一发（`derive-guard.test.ts` 钉的是
    // `/同向重叠/` 从 `wallCreate.build` 抛出），所以这里手工造文档，只考派生层那道哨兵。
    const sameRay = handBuild([
      { start: { x: 1000, y: 0 }, end: { x: 2000, y: 0 }, thicknessMm: 240 },
      { start: { x: 1000, y: 0 }, end: { x: 3000, y: 0 }, thicknessMm: 240 },
    ]);
    expect(() => deriveJoints(sameRay)).toThrow(/同向重叠/);

    // 鸽笼：同一条线上三个墙端（一反向两同向）不需要专门分支，逐对检查自然命中
    const threeOnOneLine = handBuild([
      { start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, thicknessMm: 240 },
      { start: { x: 1000, y: 0 }, end: { x: 2000, y: 0 }, thicknessMm: 240 },
      { start: { x: 1000, y: 0 }, end: { x: 3000, y: 0 }, thicknessMm: 240 },
    ]);
    expect(() => deriveJoints(threeOnOneLine)).toThrow(/同向重叠/);

    // 同向那一对还能藏在 tee 形状里（x 族两个同向成员 + 一根支墙）。少了守卫，
    // 它们会被当成 tee 的"直通两墙"，requireEqualThrough 反而夸这两面墙同厚合规
    const insideTee = handBuild([
      { start: { x: 1000, y: 0 }, end: { x: 2000, y: 0 }, thicknessMm: 240 },
      { start: { x: 1000, y: 0 }, end: { x: 3000, y: 0 }, thicknessMm: 240 },
      { start: { x: 1000, y: 0 }, end: { x: 1000, y: 800 }, thicknessMm: 120 },
    ]);
    expect(() => deriveJoints(insideTee)).toThrow(/同向重叠/);
  });
});

describe('corner：等厚直角', () => {
  it('分类 corner，两成员各得 (+120, -120)', () => {
    const { log, sharedId, a, b } = rightL();
    const joint = jointsAt(log, sharedId);
    expect(joint.kind).toBe('corner');
    // 契约是"墙 id 升序 + 同墙 start 先于 end"，不是"建墙顺序"（同毫秒 uuidv7 不保证单调）。
    // 用排序比较，让这条断言只考成员集合，不受 id 运气影响。
    expect(joint.members.map((m) => `${m.wallId}:${m.end}`).sort()).toEqual(
      [`${a.id}:end`, `${b.id}:start`].sort(),
    );
    for (const m of joint.members) {
      expect(m.trimLeftMm).toBe(120);
      expect(m.trimRightMm).toBe(-120);
    }
  });

  it('两端角点精确重合：两墙轮廓共用同一条接缝（不变式 2）', () => {
    // 计划文本在这里还解构了 sharedId，但本用例只按墙 id 查 trim、不读它（noUnusedLocals 会红）
    const { log, a, b } = rightL();
    const axisA = wallAxisById(log.document, a.id);
    const axisB = wallAxisById(log.document, b.id);
    const trimA = memberTrim(deriveJoints(log.document), a.id, 'end');
    const trimB = memberTrim(deriveJoints(log.document), b.id, 'start');
    expect(cornerPoint(axisA, 'end', 1, trimA.trimLeftMm)).toEqual({ x: 880, y: 120 });
    expect(cornerPoint(axisB, 'start', 1, trimB.trimLeftMm)).toEqual({ x: 880, y: 120 });
    expect(cornerPoint(axisA, 'end', -1, trimA.trimRightMm)).toEqual({ x: 1120, y: -120 });
    expect(cornerPoint(axisB, 'start', -1, trimB.trimRightMm)).toEqual({ x: 1120, y: -120 });
  });

  it('不变式：corner 的 trimLeft 恒为 -trimRight（边线关于共享点中心对称）', () => {
    const { log, sharedId } = rightL(370, 200);
    const joint = jointsAt(log, sharedId);
    expect(joint.kind).toBe('corner');
    for (const m of joint.members) expect(m.trimLeftMm).toBeCloseTo(-m.trimRightMm, 9);
  });
});

describe('corner：同向起画（start-start 与 end-end）', () => {
  /**
   * 同一个物理直角，两种画法。P=(0,0)，两墙实体都在第一象限，同厚 240：
   * - `startStart`：两墙都**从** P 起画（用户在共享点上连画两笔），成员是 start/start；
   * - `endEnd`：两墙都**收在** P（先把两笔反向画出来），成员是 end/end。
   * 并集轮廓必须一模一样（凹角 (120,120)、凸角 (-120,-120)），只有 side 编号跟着画法翻。
   */
  function startStart() {
    const log = build([
      { start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, thicknessMm: 240 },
    ]);
    const a = log.document.byKind('wall')[0]!;
    const b = appendWall(log, a.startId, { x: 0, y: 800 }, 240);
    return { log, sharedId: a.startId, a, b };
  }

  function endEnd() {
    const log = build([
      { start: { x: 1000, y: 0 }, end: { x: 0, y: 0 }, thicknessMm: 240 },
    ]);
    const a = log.document.byKind('wall')[0]!;
    const storeyId = log.document.byKind('storey')[0]!.id;
    log.dispatch(
      wallCreate({
        storeyId,
        start: { x: 0, y: 800 },
        end: { pointId: a.endId },
        thicknessMm: 240,
        heightMm: 3000,
      }),
    );
    return { log, sharedId: a.endId, a, b: lastWall(log) };
  }

  it('start-start：接缝是另一条对角 —— 凹角 (120,120)、凸角 (-120,-120)', () => {
    const { log, sharedId, a, b } = startStart();
    expect(jointsAt(log, sharedId).kind).toBe('corner');
    const joints = deriveJoints(log.document);
    const axisA = wallAxisById(log.document, a.id);
    const axisB = wallAxisById(log.document, b.id);
    const trimA = memberTrim(joints, a.id, 'start');
    const trimB = memberTrim(joints, b.id, 'start');
    // A 的内侧面是 +normal（y=+120），B 的内侧面是 -normal（x=+120）：异侧配对。
    // 若照"各自的第 s 条边线相交"去算，会得到 (-120,120) —— 那个点在两堵墙之外，
    // 两墙轮廓随即重叠，而 trimLeft=-trimRight、接缝闭合、Σ 面积恒等全都照样成立，
    // 所以这条用例是本任务唯一盯着这个坑的东西。
    expect(trimA.trimLeftMm).toBe(120);
    expect(trimA.trimRightMm).toBe(-120);
    expect(trimB.trimLeftMm).toBe(-120);
    expect(trimB.trimRightMm).toBe(120);
    expect(cornerPoint(axisA, 'start', 1, trimA.trimLeftMm)).toEqual({ x: 120, y: 120 });
    expect(cornerPoint(axisB, 'start', -1, trimB.trimRightMm)).toEqual({ x: 120, y: 120 });
    expect(cornerPoint(axisA, 'start', -1, trimA.trimRightMm)).toEqual({ x: -120, y: -120 });
    expect(cornerPoint(axisB, 'start', 1, trimB.trimLeftMm)).toEqual({ x: -120, y: -120 });
  });

  it('end-end：同一个物理直角反过来画，轮廓一模一样，只有 side 编号翻转', () => {
    const { log, sharedId, a, b } = endEnd();
    expect(jointsAt(log, sharedId).kind).toBe('corner');
    const joints = deriveJoints(log.document);
    const axisA = wallAxisById(log.document, a.id);
    const axisB = wallAxisById(log.document, b.id);
    const trimA = memberTrim(joints, a.id, 'end');
    const trimB = memberTrim(joints, b.id, 'end');
    expect(trimA.trimLeftMm).toBe(-120);
    expect(trimA.trimRightMm).toBe(120);
    expect(trimB.trimLeftMm).toBe(120);
    expect(trimB.trimRightMm).toBe(-120);
    // 四角点集合与 start-start 那条完全相同：画法不改变图纸
    const vs = [
      cornerPoint(axisA, 'end', 1, trimA.trimLeftMm),
      cornerPoint(axisA, 'end', -1, trimA.trimRightMm),
      cornerPoint(axisB, 'end', 1, trimB.trimLeftMm),
      cornerPoint(axisB, 'end', -1, trimB.trimRightMm),
    ];
    expect(vs.filter((v) => v.x === 120 && v.y === 120)).toHaveLength(2);
    expect(vs.filter((v) => v.x === -120 && v.y === -120)).toHaveLength(2);
  });
});

describe('corner：斜角与异厚', () => {
  it('60° 异厚：顶点仍重合，且薄墙切得比厚墙多', () => {
    // A 沿 -x 到 P(0,0)，厚 370；B 从 P 走 60° 的整数端点
    const log = build([{ start: { x: -2000, y: 0 }, end: { x: 0, y: 0 }, thicknessMm: 370 }]);
    const a = log.document.byKind('wall')[0]!;
    // away 方向 (-1000, 1732)：与 (-1,0) 夹 60°
    const b = appendWall(log, a.endId, { x: -1000, y: 1732 }, 200);
    const joints = deriveJoints(log.document);
    const joint = jointsAt(log, a.endId);
    expect(joint.kind).toBe('corner');
    const axisA = wallAxisById(log.document, a.id);
    const axisB = wallAxisById(log.document, b.id);
    const trimA = memberTrim(joints, a.id, 'end');
    const trimB = memberTrim(joints, b.id, 'start');
    for (const side of [1, -1] as const) {
      const left = side === 1 ? 'trimLeftMm' : 'trimRightMm';
      const va = cornerPoint(axisA, 'end', side, trimA[left]);
      const vb = cornerPoint(axisB, 'start', side, trimB[left]);
      expect(va.x).toBeCloseTo(vb.x, 9);
      expect(va.y).toBeCloseTo(vb.y, 9);
    }
    // 独立验算（不是把实现抄一遍）：θ = 两墙实体的内夹角，h = 半厚，
    // 内侧面那一侧的 trim = (h_对 + h_己·cosθ) / sinθ。
    // 本 fixture 里两墙的内侧面恰好都是 +normal（θ<90° 且 B 在 A 的逆时针侧），
    // 所以直接比 trimLeftMm：A(厚 370) ≈ 222.28、B(薄 200) ≈ 271.36 —— **薄墙切得多**。
    // 反直觉之处：厚墙的侧面离自己的轴线远，薄墙的轴线得外伸更多才够得着它。
    // "厚墙占地方多所以切得多"是错的直觉，所以这条既钉数值也钉大小关系。
    // 取负必须走 vec()：裸字面量 { x: -dir.x, y: -dir.y } 在水平墙上给出 y: -0，
    // 而 Object.is(-0, 0) 为 false（Global Constraints 的 ±0 纪律）。
    const iA = vec(-axisA.dir.x, -axisA.dir.y); // A 的实体离开 P 的方向
    const iB = axisB.dir; // B 从 P 起画，实体就在自己的 dir 上
    const cosT = dot(iA, iB);
    const sinT = Math.abs(cross(iA, iB));
    const hA = axisA.thicknessMm / 2;
    const hB = axisB.thicknessMm / 2;
    expect(trimA.trimLeftMm).toBeCloseTo((hB + hA * cosT) / sinT, 6);
    expect(trimB.trimLeftMm).toBeCloseTo((hA + hB * cosT) / sinT, 6);
    expect(trimB.trimLeftMm).toBeGreaterThan(trimA.trimLeftMm);
    expect(trimA.trimLeftMm).toBeCloseTo(-trimA.trimRightMm, 9);
    expect(trimB.trimLeftMm).toBeCloseTo(-trimB.trimRightMm, 9);
  });

  it('夹角小到轮廓翻面 → 抛，不画出自相交四边形', () => {
    // 与 -x 只夹约 1°：cot(0.5°) ≈ 114，斜切量远超 2000 的轴长。
    // Task 7 起 wallCreate 的复核会先挡住这一发，所以手工造文档，只考派生层那道哨兵。
    const doc = handBuild([
      { start: { x: -2000, y: 0 }, end: { x: 0, y: 0 }, thicknessMm: 500 },
      { start: { x: 0, y: 0 }, end: { x: -2000, y: 35 }, thicknessMm: 500 },
    ]);
    expect(() => deriveJoints(doc)).toThrow(/翻面/);
  });
});

describe('tee', () => {
  /** 直通：W1 (0,0)→P(1000,0)、W2 P→(2000,0)，同厚 240；支墙 W3 P→(1000,800)，厚 120 */
  function teeFixture(stemThickness = 120) {
    const log = build([{ start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, thicknessMm: 240 }]);
    const w1 = log.document.byKind('wall')[0]!;
    appendWall(log, w1.endId, { x: 2000, y: 0 }, 240);
    const w3 = appendWall(log, w1.endId, { x: 1000, y: 800 }, stemThickness);
    return { log, sharedId: w1.endId, w1, w3 };
  }

  it('分类 tee：支墙两侧 trim = 直通墙半厚 120，直通两墙 0', () => {
    const { log, sharedId, w3 } = teeFixture();
    const joint = jointsAt(log, sharedId);
    expect(joint.kind).toBe('tee');
    expect(joint.members).toHaveLength(3);
    const stem = joint.members.find((m) => m.wallId === w3.id)!;
    expect(stem.end).toBe('start');
    expect(stem.trimLeftMm).toBe(120);
    expect(stem.trimRightMm).toBe(120);
    for (const m of joint.members.filter((x) => x.wallId !== w3.id)) {
      expect(m.trimLeftMm).toBe(0);
      expect(m.trimRightMm).toBe(0);
    }
  });

  it('支墙两个角点都落在直通墙的北面上（y 都等于 120，与支墙厚度无关）', () => {
    const { log, w1, w3 } = teeFixture(400);
    const joints = deriveJoints(log.document);
    const axis = wallAxisById(log.document, w3.id);
    const trim = memberTrim(joints, w3.id, 'start');
    const left = cornerPoint(axis, 'start', 1, trim.trimLeftMm);
    const right = cornerPoint(axis, 'start', -1, trim.trimRightMm);
    expect(left.y).toBeCloseTo(120, 9);
    expect(right.y).toBeCloseTo(120, 9);
    expect(left.x).toBeCloseTo(1000 - 200, 9);
    expect(right.x).toBeCloseTo(1000 + 200, 9);
    // 直通墙自己的角点仍在轴线上，与支墙的角点共同构成一条直线接缝
    const axis1 = wallAxisById(log.document, w1.id);
    expect(cornerPoint(axis1, 'end', 1, 0).y).toBeCloseTo(120, 9);
  });

  it('支墙朝南时切到南面：faceSide 的判据真的在起作用，不是恒取 +1', () => {
    const log = build([{ start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, thicknessMm: 240 }]);
    const hub = log.document.byKind('wall')[0]!.endId;
    appendWall(log, hub, { x: 2000, y: 0 }, 240);
    const stem = appendWall(log, hub, { x: 1000, y: -800 }, 120);
    expect(jointsAt(log, hub).kind).toBe('tee');
    const joints = deriveJoints(log.document);
    const trim = memberTrim(joints, stem.id, 'start');
    expect(trim.trimLeftMm).toBe(120);
    expect(trim.trimRightMm).toBe(120);
    const axis = wallAxisById(log.document, stem.id);
    // 支墙朝南，两个角点的 y 都等于直通墙的南面 -120
    expect(cornerPoint(axis, 'start', 1, trim.trimLeftMm).y).toBeCloseTo(-120, 9);
    expect(cornerPoint(axis, 'start', -1, trim.trimRightMm).y).toBeCloseTo(-120, 9);
  });

  it('直通两墙厚度不同 → 抛（S1 的 T 接不允许带台阶的直通）', () => {
    // Task 7 起命令层不给建这种图纸，手工造它，只考派生层那道哨兵。
    const doc = handBuild([
      { start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, thicknessMm: 240 },
      { start: { x: 1000, y: 0 }, end: { x: 2000, y: 0 }, thicknessMm: 370 },
      { start: { x: 1000, y: 0 }, end: { x: 1000, y: 800 }, thicknessMm: 120 },
    ]);
    expect(() => deriveJoints(doc)).toThrow(/厚度不同/);
  });
});

describe('cross 与 star', () => {
  /** 十字：四条臂都结束于 P(1000,1000)，全厚 240 */
  function plus() {
    const log = build([
      { start: { x: 0, y: 1000 }, end: { x: 1000, y: 1000 }, thicknessMm: 240 },
    ]);
    const storeyId = log.document.byKind('storey')[0]!.id;
    const eastIn = log.document.byKind('wall')[0]!;
    const specs: Array<{ start: { pointId: string }; end: { x: number; y: number } }> = [
      { start: { pointId: eastIn.endId }, end: { x: 2000, y: 1000 } },
      { start: { pointId: eastIn.endId }, end: { x: 1000, y: 0 } },
      { start: { pointId: eastIn.endId }, end: { x: 1000, y: 2000 } },
    ];
    for (const s of specs) {
      log.dispatch(wallCreate({ storeyId, thicknessMm: 240, heightMm: 3000, ...s }));
    }
    return { log, sharedId: eastIn.endId };
  }

  it('十字：方向角更小的那族当直通（trim 0），另一族各自切到自己那一面', () => {
    const { log, sharedId } = plus();
    const joint = jointsAt(log, sharedId);
    expect(joint.kind).toBe('cross');
    expect(joint.members).toHaveLength(4);
    const horizontal = joint.members.filter(
      (m) => wallAxisById(log.document, m.wallId).dir.y === 0,
    );
    const vertical = joint.members.filter((m) => wallAxisById(log.document, m.wallId).dir.x === 0);
    // 两条过滤必须覆盖全部成员：冒出斜墙说明 fixture 或分组坏了
    expect(horizontal.length + vertical.length).toBe(4);
    expect(horizontal).toHaveLength(2);
    for (const m of horizontal) expect([m.trimLeftMm, m.trimRightMm]).toEqual([0, 0]);
    for (const m of vertical) expect([m.trimLeftMm, m.trimRightMm]).toEqual([120, 120]);
    // 两支墙在直通墙的两侧，必须各自顶到**自己那一面**：北臂落在 y=1120，南臂落在 y=880。
    // 只按 stemLine[0] 算一次 face 的实现会让另一臂被切到对面去（trim 变 -120），
    // 而"红哪一臂"取决于 uuidv7 的运气 —— 那种运气依赖就是"实现读了成员顺序"的警报。
    for (const m of vertical) {
      const axis = wallAxisById(log.document, m.wallId);
      const yLeft = cornerPoint(axis, m.end, 1, m.trimLeftMm).y;
      const yRight = cornerPoint(axis, m.end, -1, m.trimRightMm).y;
      expect(yLeft).toBe(yRight); // 平接：两角点同在直通墙的一个面上
      expect(Math.abs(yLeft - 1000)).toBe(120); // 北面 1120 或南面 880，二选一
    }

    // 支族两臂**异厚**同样是合法图纸：它们被直通带隔开、彼此从不接触，各自平接到自己
    // 那一面，缝闭合且只留一个台阶（北臂切到 y=1120、南臂切到 y=880，中间是 240 厚的横带）。
    // 计划文本的 cross 分支还额外要求支族同厚（requireEqualThrough(pointId, stemLine)），
    // 那句「直通两墙厚度不同」描述的并不是这一对墙，等于用一条不成立的规矩拒掉合法图纸。
    const stepped = build([
      { start: { x: 0, y: 1000 }, end: { x: 1000, y: 1000 }, thicknessMm: 240 },
    ]);
    const steppedWest = stepped.document.byKind('wall')[0]!;
    const steppedHub = steppedWest.endId;
    const steppedEast = appendWall(stepped, steppedHub, { x: 2000, y: 1000 }, 240);
    const steppedNorth = appendWall(stepped, steppedHub, { x: 1000, y: 2000 }, 400);
    const steppedSouth = appendWall(stepped, steppedHub, { x: 1000, y: 0 }, 120);
    const steppedJoint = jointsAt(stepped, steppedHub);
    expect(steppedJoint.kind).toBe('cross');
    expect(steppedJoint.members).toHaveLength(4);
    const steppedJoints = deriveJoints(stepped.document);
    // 直通族（两面 240 的横墙）仍然方头，且它才是"直通两墙同厚"那条规矩管的那一对
    for (const [throughWall, throughEnd] of [
      [steppedWest, 'end'],
      [steppedEast, 'start'],
    ] as const) {
      const trim = memberTrim(steppedJoints, throughWall.id, throughEnd);
      expect([trim.trimLeftMm, trim.trimRightMm]).toEqual([0, 0]);
    }
    // 两支臂：faceY = 它自己那一面的面线，half = 它自己的半厚（台阶由这个差值构成）
    for (const [stem, faceY, half] of [
      [steppedNorth, 1120, 200],
      [steppedSouth, 880, 60],
    ] as const) {
      const axis = wallAxisById(stepped.document, stem.id);
      const trim = memberTrim(steppedJoints, stem.id, 'start');
      // 平接量只由直通墙半厚决定（120），与支臂自己的厚度无关 —— 与 tee 那条同源
      expect([trim.trimLeftMm, trim.trimRightMm]).toEqual([120, 120]);
      const left = cornerPoint(axis, 'start', 1, trim.trimLeftMm);
      const right = cornerPoint(axis, 'start', -1, trim.trimRightMm);
      expect(left.y).toBe(right.y); // 两角点同在一条面线上：无缝、不穿过横带
      expect(left.y).toBeCloseTo(faceY, 9);
      expect(Math.abs(left.x - 1000)).toBeCloseTo(half, 9);
      expect(Math.abs(right.x - 1000)).toBeCloseTo(half, 9);
    }
  });

  it('Y 形三臂（三个方向）→ 抛 star，并提示打断成 T 接', () => {
    // 三条臂必须在三个**方向**上：计划文本原本第一臂走 (2000,0)，与 A 的轴线共线，
    // 于是该点只有两条方向线 —— 分类是 tee，永远到不了 star 分支（用例名要的就是三方向）。
    // Task 7 起 wallCreate 的复核会先挡住这颗星，所以手工造文档，只考派生层那道哨兵。
    const doc = handBuild([
      { start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, thicknessMm: 240 },
      { start: { x: 1000, y: 0 }, end: { x: 2000, y: 900 }, thicknessMm: 240 },
      { start: { x: 1000, y: 0 }, end: { x: 1000, y: 900 }, thicknessMm: 240 },
    ]);
    expect(() => deriveJoints(doc)).toThrow(/star/);
    expect(() => deriveJoints(doc)).toThrow(/打断/);
  });
});

describe('deriveJoints 的确定性', () => {
  it('同一文档派生两次逐字节相同，且 joints 按 pointId 升序', () => {
    const { log, sharedId } = rightL();
    const first = deriveJoints(log.document);
    expect(deriveJoints(log.document)).toEqual(first);
    expect(JSON.stringify(first)).toBe(JSON.stringify(deriveJoints(log.document)));
    expect(first.map((j) => j.pointId)).toEqual([...first.map((j) => j.pointId)].sort());
    // 计划文本这里是 expect(sharedId).toBeTruthy()：走到这一行它必真，是空跑断言。
    // 换成有鉴别力的：接头表里确实有 sharedId 那一个，而且它是全图唯一的非 free 接头。
    expect(first.filter((j) => j.pointId === sharedId).map((j) => j.kind)).toEqual(['corner']);
    expect(first.filter((j) => j.kind !== 'free')).toHaveLength(1);
    expect(first).toHaveLength(3);
    // 组内顺序同样是契约（Task 5 按它铺轮廓顶点）：墙 id 升序，同一面墙 start 先于 end
    for (const j of first) {
      const keys = j.members.map((m) => `${m.wallId}:${m.end === 'start' ? 0 : 1}`);
      expect(keys).toEqual([...keys].sort());
    }
  });

  it('memberTrim 找不到该墙的端点时抛，不给默认 0', () => {
    const { log } = rightL();
    const joints = deriveJoints(log.document);
    expect(() => memberTrim(joints, uuidv7(), 'start')).toThrow(/找不到/);
  });
});
