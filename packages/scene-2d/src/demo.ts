import {
  Document,
  TransactionLog,
  openingCreate,
  openingMove,
  storeyCreate,
  storeySetElevation,
  uuidv7,
  wallCreate,
  wallMoveEndpoint,
  wallSetThickness,
  type Command,
  type PointRef,
  type WallEntity,
} from '@dajia/core';

const STOREY_HEIGHT_MM = 3000;

function lastCreatedWall(log: TransactionLog): WallEntity {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new TypeError('affected 里没有新建的墙');
}

function lastCreatedId(log: TransactionLog, kind: 'opening' | 'storey'): string {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === kind) return entity.id;
  }
  throw new TypeError(`affected 里没有新建的 ${kind}`);
}

/**
 * 无持久化（M1.3 之前）时的样例工程：8000×6000 两层，一层吃过 4 次编辑。
 * 它不是测试夹具的专利 —— desktop 首屏也吃它，于是"看到的"和"测到的"是同一份几何。
 */
export function demoHouse(): {
  log: TransactionLog;
  doc: Document;
  lowerStoreyId: string;
  upperStoreyId: string;
} {
  const projectId = uuidv7();
  const log = new TransactionLog(Document.create(projectId));
  const step = (cmd: Command): void => {
    log.dispatch(cmd);
  };

  const buildStorey = (storeyId: string) => {
    // 一面墙一个具名 const：`Record<string, WallEntity>` 在 noUncheckedIndexedAccess 下
    // 每次读都带 | undefined，写 `walls.southWest.endId` 直接编译不过。具名引用既过了
    // 类型检查，又把"谁接在谁后面"这层建造顺序摊平在纸面上。
    const put = (start: PointRef, end: PointRef, thicknessMm: number): WallEntity => {
      step(wallCreate({ storeyId, start, end, thicknessMm, heightMm: STOREY_HEIGHT_MM }));
      return lastCreatedWall(log);
    };

    const southWest = put({ x: 0, y: 0 }, { x: 4000, y: 0 }, 240);
    const southEast = put({ pointId: southWest.endId }, { x: 8000, y: 0 }, 240);
    const east = put({ pointId: southEast.endId }, { x: 8000, y: 6000 }, 240);
    const north = put({ pointId: east.endId }, { x: 0, y: 6000 }, 240);
    const west = put({ pointId: southWest.startId }, { pointId: north.endId }, 240);
    const stem = put({ pointId: southWest.endId }, { x: 4000, y: 3000 }, 120);
    const partWest = put({ x: 1000, y: 3000 }, { pointId: stem.endId }, 120);
    const partEast = put({ pointId: stem.endId }, { x: 7000, y: 3000 }, 120);
    const walls = { southWest, southEast, east, north, west, stem, partWest, partEast };

    const open = (hostWallId: string, distanceMm: number, widthMm: number, category: 'door' | 'window'): string => {
      step(
        openingCreate({
          hostWallId,
          distanceMm,
          widthMm,
          heightMm: category === 'door' ? 2100 : 1500,
          category,
        }),
      );
      return lastCreatedId(log, 'opening');
    };
    open(southWest.id, 1500, 1000, 'door');
    open(east.id, 1000, 1000, 'door');
    const winNorth = open(north.id, 2000, 1500, 'window');
    open(west.id, 3500, 1200, 'window');

    return { walls, winNorth };
  };

  step(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: STOREY_HEIGHT_MM }));
  const lowerStoreyId = lastCreatedId(log, 'storey');
  const lower = buildStorey(lowerStoreyId);
  step(storeyCreate({ projectId, index: 1, elevationMm: 6000, heightMm: STOREY_HEIGHT_MM }));
  const upperStoreyId = lastCreatedId(log, 'storey');
  buildStorey(upperStoreyId);

  // 一层吃 4 次编辑：二层保持原样，两层的差异正好给视图当对照
  step(wallMoveEndpoint({ wallId: lower.walls.partWest.id, end: 'start', x: 800, y: 3000 }));
  step(wallSetThickness({ wallId: lower.walls.stem.id, thicknessMm: 240 }));
  step(openingMove({ openingId: lower.winNorth, distanceMm: 2200 }));
  step(storeySetElevation({ storeyId: upperStoreyId, elevationMm: 3000 }));

  return { log, doc: log.document, lowerStoreyId, upperStoreyId };
}
