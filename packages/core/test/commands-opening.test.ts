// 洞口的写入路径与"拉伸墙时洞口跟随"：校验只有一份（派生），正数与竖向那条派生抓不到
import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  applyPatch,
  deriveStoreyGeometry,
  openingCreate,
  openingDelete,
  openingMove,
  openingSpans,
  piecesFromSpans,
  storeyCreate,
  uuidv7,
  wallAxisById,
  wallCreate,
  wallDelete,
  wallMoveEndpoint,
  type OpeningEntity,
  type WallCreateInput,
  type WallEntity,
} from '@dajia/core';

const projectId = uuidv7();

function buildLog(): TransactionLog {
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  return log;
}

function storey0(log: TransactionLog): string {
  const hit = log.document.byKind('storey').find((s) => s.index === 0);
  if (!hit) throw new Error('测试找不到楼层');
  return hit.id;
}

/** 新建的墙/洞口一律从 affected 里取：同毫秒的 uuidv7 不保证有序，byKind 下标是掷硬币。 */
function lastWall(log: TransactionLog): WallEntity {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new Error('最近一次 dispatch 没有新建墙');
}

function lastOpening(log: TransactionLog): OpeningEntity {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'opening') return entity;
  }
  throw new Error('最近一次 dispatch 没有新建洞口');
}

function addWall(
  log: TransactionLog,
  spec: Omit<WallCreateInput, 'storeyId' | 'heightMm'>,
): WallEntity {
  log.dispatch(wallCreate({ storeyId: storey0(log), heightMm: 3000, ...spec }));
  return lastWall(log);
}

type OpeningSpec = {
  distanceMm: number;
  widthMm: number;
  heightMm: number;
  sillMm?: number;
  category?: 'door' | 'window';
};

/** category 给默认值 'window'：spec 里省略它时，OpeningCreateInput 的必填字段才不会缺。 */
function addOpening(log: TransactionLog, wall: WallEntity, spec: OpeningSpec): OpeningEntity {
  log.dispatch(openingCreate({ hostWallId: wall.id, category: 'window', ...spec }));
  return lastOpening(log);
}

/** 一面 3600×240 的墙，墙高 3000，独占一个文档（depth 建完是 2）。 */
function oneWall(): { log: TransactionLog; wall: WallEntity } {
  const log = buildLog();
  const wall = addWall(log, {
    start: { x: 0, y: 0 },
    end: { x: 3600, y: 0 },
    thicknessMm: 240,
  });
  return { log, wall };
}

/** 拐角在 (3600, 0)：A 水平 3600 长，B 竖直 2400 长，共享那个点。 */
function lCorner(): {
  log: TransactionLog;
  sharedId: string;
  first: WallEntity;
  second: WallEntity;
} {
  const log = buildLog();
  const first = addWall(log, {
    start: { x: 0, y: 0 },
    end: { x: 3600, y: 0 },
    thicknessMm: 240,
  });
  const sharedId = first.endId;
  const second = addWall(log, {
    start: { pointId: sharedId },
    end: { x: 3600, y: 2400 },
    thicknessMm: 240,
  });
  return { log, sharedId, first, second };
}

describe('openingCreate', () => {
  it('建门洞：窗台默认 0，楼层抄宿主墙，affected 只有新洞口', () => {
    const { log, wall } = oneWall();
    const depth = log.depth;
    log.dispatch(
      openingCreate({
        hostWallId: wall.id,
        distanceMm: 0,
        widthMm: 900,
        heightMm: 2100,
        category: 'door',
      }),
    );
    const made = lastOpening(log);
    expect(made.sillMm).toBe(0);
    expect(made.storeyId).toBe(wall.storeyId);
    expect(made.hostWallId).toBe(wall.id);
    expect(log.affected).toEqual(new Set([made.id]));
    expect(log.depth).toBe(depth + 1);
  });

  it('建窗洞：窗台默认 900，且默认值自己过得了竖向守卫', () => {
    const { log, wall } = oneWall();
    log.dispatch(
      openingCreate({
        hostWallId: wall.id,
        distanceMm: 600,
        widthMm: 1500,
        heightMm: 1500,
        category: 'window',
      }),
    );
    expect(lastOpening(log).sillMm).toBe(900);
    // 900 + 1500 = 2400 ≤ 3000。默认值要是越了界，等于每次建窗都得先撞一次错。
    expect(() => deriveStoreyGeometry(log.document, wall.storeyId)).not.toThrow();
  });

  it('显式 sillMm 覆盖默认值', () => {
    const { log, wall } = oneWall();
    log.dispatch(
      openingCreate({
        hostWallId: wall.id,
        distanceMm: 600,
        widthMm: 1500,
        heightMm: 1500,
        sillMm: 400,
        category: 'window',
      }),
    );
    expect(lastOpening(log).sillMm).toBe(400);
  });

  it('门洞窗台非 0 → 构造期就抛，日志一步没走', () => {
    const { log, wall } = oneWall();
    const before = log.document.canonical();
    expect(() =>
      log.dispatch(
        openingCreate({
          hostWallId: wall.id,
          distanceMm: 0,
          widthMm: 900,
          heightMm: 2100,
          sillMm: 100,
          category: 'door',
        }),
      ),
    ).toThrow(/门洞窗台高必须为 0/);
    expect(log.document.canonical()).toBe(before);
    expect(log.depth).toBe(2);
    // 正对照：同一批参数把 sillMm 拿掉就建得成 —— 抛错是因为窗台，不是因为别的
    log.dispatch(
      openingCreate({
        hostWallId: wall.id,
        distanceMm: 0,
        widthMm: 900,
        heightMm: 2100,
        category: 'door',
      }),
    );
    expect(log.depth).toBe(3);
  });

  it('窗台为负 / 洞口顶超过宿主墙高 → 抛；正好等于墙高合法（正对照）', () => {
    const { log, wall } = oneWall();
    expect(() =>
      log.dispatch(
        openingCreate({
          hostWallId: wall.id,
          distanceMm: 0,
          widthMm: 900,
          heightMm: 1500,
          sillMm: -100,
          category: 'window',
        }),
      ),
    ).toThrow(/窗台高不能为负/);
    expect(() =>
      log.dispatch(
        openingCreate({
          hostWallId: wall.id,
          distanceMm: 0,
          widthMm: 900,
          heightMm: 2200,
          sillMm: 900,
          category: 'window',
        }),
      ),
    ).toThrow(/超过宿主墙高/);
    // 900 + 2100 = 3000 = 墙高：判据是 > 不是 >=，这条放行才说明顶部齐平可画
    log.dispatch(
      openingCreate({
        hostWallId: wall.id,
        distanceMm: 0,
        widthMm: 900,
        heightMm: 2100,
        sillMm: 900,
        category: 'window',
      }),
    );
    expect(lastOpening(log).heightMm).toBe(2100);
  });

  it('越出墙尾 → /超出宿主墙/；正好收在墙尾合法（正对照）', () => {
    const { log, wall } = oneWall();
    expect(() =>
      log.dispatch(
        openingCreate({
          hostWallId: wall.id,
          distanceMm: 2800,
          widthMm: 900,
          heightMm: 2100,
          category: 'door',
        }),
      ),
    ).toThrow(/超出宿主墙/);
    log.dispatch(
      openingCreate({
        hostWallId: wall.id,
        distanceMm: 2700,
        widthMm: 900,
        heightMm: 2100,
        category: 'door',
      }),
    );
    expect(lastOpening(log).distanceMm).toBe(2700);
  });

  it('与已有洞口重叠或贴边 → 抛；中间留 1mm 合法（正对照）', () => {
    const { log, wall } = oneWall();
    addOpening(log, wall, { distanceMm: 900, widthMm: 900, heightMm: 2100, category: 'door' });
    expect(() =>
      log.dispatch(
        openingCreate({
          hostWallId: wall.id,
          distanceMm: 1800,
          widthMm: 900,
          heightMm: 2100,
          category: 'door',
        }),
      ),
    ).toThrow(/重叠或贴边/);
    log.dispatch(
      openingCreate({
        hostWallId: wall.id,
        distanceMm: 1801,
        widthMm: 900,
        heightMm: 2100,
        category: 'door',
      }),
    );
    expect(openingSpans(log.document, wall)).toHaveLength(2);
  });

  it('负距离由派生那条判据兜住：命令层不另写一份区间规则', () => {
    const { log, wall } = oneWall();
    expect(() =>
      log.dispatch(
        openingCreate({
          hostWallId: wall.id,
          distanceMm: -100,
          widthMm: 900,
          heightMm: 2100,
          category: 'door',
        }),
      ),
    ).toThrow(/超出宿主墙/);
  });

  it('宿主墙不存在 → /不存在/；宿主指向点或墙自己 → /不是墙/', () => {
    const { log, wall } = oneWall();
    const spec = { distanceMm: 0, widthMm: 900, heightMm: 2100, category: 'door' as const };
    expect(() => log.dispatch(openingCreate({ hostWallId: uuidv7(), ...spec }))).toThrow(/不存在/);
    expect(() => log.dispatch(openingCreate({ hostWallId: wall.startId, ...spec }))).toThrow(
      /不是墙/,
    );
  });

  it('宽度或高度为 0 → 抛；反证：零宽洞口确实骗得过派生层', () => {
    const { log, wall } = oneWall();
    expect(() =>
      log.dispatch(
        openingCreate({
          hostWallId: wall.id,
          distanceMm: 1000,
          widthMm: 0,
          heightMm: 2100,
          category: 'door',
        }),
      ),
    ).toThrow(/洞口宽度必须为正/);
    expect(() =>
      log.dispatch(
        openingCreate({
          hostWallId: wall.id,
          distanceMm: 1000,
          widthMm: 900,
          heightMm: 0,
          category: 'door',
        }),
      ),
    ).toThrow(/洞口高度必须为正/);
    // 反证（不是多余检查）：绕过命令直接贴一条零宽进文档，派生层一声不吭。
    // 删掉 positiveMm 的话上面两条红，这条仍绿 —— 三条一起看才知道构造期那道守卫非有不可。
    const hacked = applyPatch(log.document, {
      upsert: [
        {
          kind: 'opening',
          id: uuidv7(),
          storeyId: wall.storeyId,
          hostWallId: wall.id,
          distanceMm: 1000,
          widthMm: 0,
          heightMm: 2100,
          sillMm: 0,
          category: 'door',
        },
      ],
      remove: [],
    }).doc;
    expect(() => piecesFromSpans(wall.id, 3600, openingSpans(hacked, wall))).not.toThrow();
    expect(log.document.byKind('opening')).toEqual([]);
  });

  it('浮点入参在构造期就抛，日志一步没走', () => {
    const { log, wall } = oneWall();
    expect(() =>
      log.dispatch(
        openingCreate({
          hostWallId: wall.id,
          distanceMm: 100.5,
          widthMm: 900,
          heightMm: 2100,
          category: 'door',
        }),
      ),
    ).toThrow(/整数毫米/);
    expect(log.depth).toBe(2);
    expect(log.document.byKind('opening')).toEqual([]);
  });
});

describe('openingMove', () => {
  it('改距离：只有 distanceMm 变，其余字段逐字不变', () => {
    const { log, wall } = oneWall();
    const opening = addOpening(log, wall, {
      distanceMm: 600,
      widthMm: 1500,
      heightMm: 1500,
    });
    log.dispatch(openingMove({ openingId: opening.id, distanceMm: 1200 }));
    expect(log.document.get(opening.id)).toEqual({ ...opening, distanceMm: 1200 });
    expect(log.affected).toEqual(new Set([opening.id]));
  });

  it('移到与另一樘重叠 → 抛，文档一字未改', () => {
    const { log, wall } = oneWall();
    addOpening(log, wall, { distanceMm: 0, widthMm: 900, heightMm: 2100, category: 'door' });
    const b = addOpening(log, wall, {
      distanceMm: 2000,
      widthMm: 900,
      heightMm: 2100,
      category: 'door',
    });
    const before = log.document.canonical();
    // b 挪到 450：区间 [450,1350] 与 a 的 [0,900] 交叠
    expect(() => log.dispatch(openingMove({ openingId: b.id, distanceMm: 450 }))).toThrow(
      /重叠或贴边/,
    );
    expect(log.document.canonical()).toBe(before);
    expect((log.document.get(b.id) as OpeningEntity).distanceMm).toBe(2000);
  });

  it('目标不是洞口 → 抛；同一条命令换回真洞口就成功（正对照）', () => {
    const { log, wall } = oneWall();
    const opening = addOpening(log, wall, {
      distanceMm: 600,
      widthMm: 900,
      heightMm: 2100,
      category: 'door',
    });
    expect(() => log.dispatch(openingMove({ openingId: wall.startId, distanceMm: 800 }))).toThrow(
      /不是洞口/,
    );
    expect(() => log.dispatch(openingMove({ openingId: wall.id, distanceMm: 800 }))).toThrow(
      /不是洞口/,
    );
    expect(() => log.dispatch(openingMove({ openingId: uuidv7(), distanceMm: 800 }))).toThrow(
      /洞口 不存在/,
    );
    log.dispatch(openingMove({ openingId: opening.id, distanceMm: 800 }));
    expect((log.document.get(opening.id) as OpeningEntity).distanceMm).toBe(800);
  });

  it('撤销/重做移动：距离回到原值，canonical 与初始逐字节相同', () => {
    const { log, wall } = oneWall();
    const opening = addOpening(log, wall, {
      distanceMm: 600,
      widthMm: 900,
      heightMm: 2100,
      category: 'door',
    });
    const before = log.document.canonical();
    log.dispatch(openingMove({ openingId: opening.id, distanceMm: 2000 }));
    expect(log.document.canonical()).not.toBe(before);
    expect(log.undo()).toBe(true);
    expect(log.document.canonical()).toBe(before);
    expect(log.redo()).toBe(true);
    expect((log.document.get(opening.id) as OpeningEntity).distanceMm).toBe(2000);
  });
});

describe('openingDelete', () => {
  it('删除后只剩一整段；撤销后逐字节复原', () => {
    const { log, wall } = oneWall();
    const opening = addOpening(log, wall, {
      distanceMm: 1200,
      widthMm: 900,
      heightMm: 2100,
      category: 'door',
    });
    // [1200,2100] 把 3600 的墙切成 [0,1200] 与 [2100,3600]
    expect(deriveStoreyGeometry(log.document, wall.storeyId).pieces).toHaveLength(2);
    const before = log.document.canonical();
    log.dispatch(openingDelete({ openingId: opening.id }));
    expect(log.document.get(opening.id)).toBeUndefined();
    expect(deriveStoreyGeometry(log.document, wall.storeyId).pieces).toHaveLength(1);
    log.undo();
    expect(log.document.canonical()).toBe(before);
    expect(deriveStoreyGeometry(log.document, wall.storeyId).pieces).toHaveLength(2);
  });

  it('删墙连带删洞口，撤销把墙与洞口一起带回来', () => {
    const { log, wall } = oneWall();
    const opening = addOpening(log, wall, {
      distanceMm: 1200,
      widthMm: 900,
      heightMm: 2100,
      category: 'door',
    });
    const before = log.document.canonical();
    log.dispatch(wallDelete({ wallId: wall.id }));
    expect(log.document.get(opening.id)).toBeUndefined();
    expect(log.affected).toEqual(new Set([wall.id, opening.id, wall.startId, wall.endId]));
    log.undo();
    expect(log.document.canonical()).toBe(before);
  });
});

describe('洞口跟随拉伸', () => {
  it('拉长墙：洞口距离一字不改，affected 里也只有那个点（正对照）', () => {
    const { log, wall } = oneWall();
    const opening = addOpening(log, wall, {
      distanceMm: 2700,
      widthMm: 900,
      heightMm: 2100,
      category: 'door',
    });
    log.dispatch(wallMoveEndpoint({ wallId: wall.id, end: 'end', x: 4800, y: 0 }));
    expect((log.document.get(opening.id) as OpeningEntity).distanceMm).toBe(2700);
    // 没夹就不进补丁。实现若改成"每次拖动都重述全部洞口"，这条 affected 断言会红 ——
    // 那时 affected 再也不能说明"这次真的改了什么"，Task 9 的增量重建就退化成全量。
    expect(log.affected).toEqual(new Set([wall.endId]));
  });

  it('缩墙：洞口夹到 floor(新轴长 − 宽)，affected 含洞口 id', () => {
    const { log, wall } = oneWall();
    const opening = addOpening(log, wall, {
      distanceMm: 2700,
      widthMm: 900,
      heightMm: 2100,
      category: 'door',
    });
    log.dispatch(wallMoveEndpoint({ wallId: wall.id, end: 'end', x: 3000, y: 0 }));
    expect((log.document.get(opening.id) as OpeningEntity).distanceMm).toBe(2100);
    expect(log.affected).toEqual(new Set([wall.endId, opening.id]));
    expect(() => deriveStoreyGeometry(log.document, wall.storeyId)).not.toThrow();
  });

  it('斜墙按 Math.floor 而不是 round：轴长 1999.7 → 1099，不是 1100', () => {
    const log = buildLog();
    const wall = addWall(log, {
      start: { x: 0, y: 0 },
      end: { x: 2000, y: 2000 },
      thicknessMm: 240,
    });
    const opening = addOpening(log, wall, {
      distanceMm: 1900,
      widthMm: 900,
      heightMm: 2100,
      category: 'door',
    });
    // 拖动前 [1900,2800] 在 2828.4 的墙里；拖到 (1414,1414) 后轴长只剩 1999.7
    log.dispatch(wallMoveEndpoint({ wallId: wall.id, end: 'end', x: 1414, y: 1414 }));
    expect(wallAxisById(log.document, wall.id).lengthMm).toBeCloseTo(1999.698, 2);
    expect((log.document.get(opening.id) as OpeningEntity).distanceMm).toBe(1099);
    // 1100 + 900 = 2000 > 1999.698：写成 Math.round 会留下越界洞口，下面这条派生断言就红
    expect(() => deriveStoreyGeometry(log.document, wall.storeyId)).not.toThrow();
  });

  it('新墙比洞口还短 → /放不下洞口/，文档一步没走', () => {
    const { log, wall } = oneWall();
    const opening = addOpening(log, wall, {
      distanceMm: 2700,
      widthMm: 900,
      heightMm: 2100,
      category: 'door',
    });
    const before = log.document.canonical();
    // 轴长 800 > 墙厚 240，Task 3 的守卫放行；到洞口这一关才被挡下
    expect(() =>
      log.dispatch(wallMoveEndpoint({ wallId: wall.id, end: 'end', x: 800, y: 0 })),
    ).toThrow(/放不下洞口/);
    expect(() =>
      log.dispatch(wallMoveEndpoint({ wallId: wall.id, end: 'end', x: 800, y: 0 })),
    ).toThrow(opening.id);
    expect(log.document.canonical()).toBe(before);
    expect(log.depth).toBe(3);
  });

  it('往回夹会让两樘撞上 → /重叠或贴边/，绝不留下一对重叠的洞口', () => {
    const { log, wall } = oneWall();
    addOpening(log, wall, { distanceMm: 1000, widthMm: 900, heightMm: 2100, category: 'door' });
    const b = addOpening(log, wall, {
      distanceMm: 2000,
      widthMm: 900,
      heightMm: 2100,
      category: 'door',
    });
    expect(openingSpans(log.document, wall).map((s) => [s.fromMm, s.toMm])).toEqual([
      [1000, 1900],
      [2000, 2900],
    ]);
    const before = log.document.canonical();
    // 缩到 2500：a 不用动（1900 ≤ 2500），b 夹到 floor(2500−900)=1600 → [1600,2500] 撞进 a
    expect(() =>
      log.dispatch(wallMoveEndpoint({ wallId: wall.id, end: 'end', x: 2500, y: 0 })),
    ).toThrow(/重叠或贴边/);
    expect(log.document.canonical()).toBe(before);
    expect((log.document.get(b.id) as OpeningEntity).distanceMm).toBe(2000);
  });

  it('拖拐角：邻墙的洞口一起被夹到 300，本墙的洞口仍是 2000', () => {
    const { log, sharedId, first, second } = lCorner();
    const onFirst = addOpening(log, first, { distanceMm: 2000, widthMm: 900, heightMm: 1500 });
    const onSecond = addOpening(log, second, {
      distanceMm: 1400,
      widthMm: 900,
      heightMm: 2100,
      category: 'door',
    });
    // A 变长到 3794.7：窗 [2000,2900] 仍在墙内 → 一个字节都不该改
    // B 缩到 1200：门 1400 → floor(1200−900) = 300，正好收在新墙尾
    log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 1200 }));
    expect((log.document.get(onFirst.id) as OpeningEntity).distanceMm).toBe(2000);
    expect((log.document.get(onSecond.id) as OpeningEntity).distanceMm).toBe(300);
    expect(log.affected).toEqual(new Set([sharedId, onSecond.id]));
    expect(() => deriveStoreyGeometry(log.document, first.storeyId)).not.toThrow();
  });

  it('撤销拉伸：墙长与洞口距离一起回退，重放逐字节相同', () => {
    const { log, first, second } = lCorner();
    addOpening(log, first, { distanceMm: 2000, widthMm: 900, heightMm: 1500 });
    const door = addOpening(log, second, {
      distanceMm: 1400,
      widthMm: 900,
      heightMm: 2100,
      category: 'door',
    });
    const before = log.document.canonical();
    log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 1200 }));
    const dragged = log.document.canonical();
    expect(dragged).not.toBe(before);
    expect((log.document.get(door.id) as OpeningEntity).distanceMm).toBe(300);
    expect(log.undo()).toBe(true);
    expect(log.document.canonical()).toBe(before);
    expect((log.document.get(door.id) as OpeningEntity).distanceMm).toBe(1400);
    expect(log.redo()).toBe(true);
    expect(log.document.canonical()).toBe(dragged);
  });
});
