import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isEntityId, type Document, type EntityId } from '@dajia/core';
import { describeError } from './describe-error';

/** 目录名的唯一产地：`userData/emergency`。恢复侧（T8/T9）读同一个名字，不许各拼一份。 */
export const EMERGENCY_DIR_NAME = 'emergency';

/**
 * 每个工程各留这么多份（T7 ⑩ 段）。20 是"一晚上的崩溃不至于把盘写满，而真要查问题时
 * 手里还有二十发现场"这两头的折中；改这个数要说得出理由。
 */
export const EMERGENCY_KEEP = 20;

/** envelope 的格式标记：将来换格式的人得能认出旧件，而不是拿新解析器读旧账。 */
const ENVELOPE_KIND = 'dajia.emergency.v1';

/**
 * 输入故意比 `EmergencyPayload` 少一个 `patch`：抢救件保的是**整份状态**。
 * 补丁是增量，靠它恢复得先有一份可信基线 —— 崩溃现场恰恰不保证有基线。
 * T8 接线时把 payload 整个递过来即可（多余字段不影响结构赋值）。
 */
export interface EmergencyInput {
  readonly projectId: EntityId;
  readonly turn: number;
  readonly error: string;
  readonly doc: Document;
}

/** T7 ⑨ 段：本文件唯一的出口形状。成功带 path，失败带 error 与尽力算出的 path。 */
export type EmergencyWrite =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: string; readonly path: string | null };

interface Envelope {
  readonly kind: typeof ENVELOPE_KIND;
  readonly projectId: string;
  readonly turn: number;
  readonly schemaVersion: number;
  readonly writtenAtMs: number;
  readonly error: string;
  /** `doc.canonical()` 原样一份字符串。恢复侧 `JSON.parse` 它，再 `Document.replaceEntities`。 */
  readonly canonical: string;
}

/** 认形状：文件名 + 词干必须是 UUIDv7。写侧守卫与这里用的是同一个 `isEntityId`（T7 ⑩ 段）。 */
const FILE_RE = /^(.+)-turn-(\d+)\.json$/;

/**
 * 两条尺都在**算路径之前**。projectId 要直接进文件名词干，`../` 这种串放过去就是
 * "调用方指定写到哪一层"，而调用方那一侧是 IPC 传来的字符串（T8），不是我们自己人。
 */
function guardName(projectId: unknown, turn: unknown): { projectId: EntityId; turn: number } {
  if (!isEntityId(projectId)) {
    throw new TypeError(
      `projectId 必须是 UUIDv7，收到 ${JSON.stringify(projectId)}：这一串直接进文件名词干，认不出就别拼路径`,
    );
  }
  if (!Number.isSafeInteger(turn) || (turn as number) < 1) {
    throw new TypeError(
      `turn 必须是 >=1 的安全整数，收到 ${String(turn)}：它既是文件名也是裁剪的排序键`,
    );
  }
  // `Number.isSafeInteger` 返回普通 boolean，**不是**类型守卫，所以上面那关过后`turn`
  // 仍是 `unknown`。这一行是收窄的产地：守卫已经证过它是安全整数且 >=1，
  // 这里只是把那个结论落到类型上，不再重复校验。
  return { projectId, turn: turn as number };
}

export function emergencyFileName(projectId: EntityId, turn: number): string {
  const guarded = guardName(projectId, turn);
  return `${guarded.projectId}-turn-${guarded.turn}.json`;
}

function emergencyDir(userDataDir: string): string {
  if (userDataDir === '') {
    throw new TypeError(
      'userDataDir 不能是空串：拼出来是相对路径 "emergency"，会写进进程的当前工作目录，' +
        '打包后的应用里那里可能是安装目录',
    );
  }
  return join(userDataDir, EMERGENCY_DIR_NAME);
}

/**
 * 落一份抢救件。**同步**是故意的：调用它的时机是"刚刚失败"，异步版会把这一发交给
 * 一个可能正在被拆掉的进程（`before-quit` 那一头）。它**不抛**，理由见 T7 ⑨ 段。
 */
export function writeEmergencySnapshot(userDataDir: string, input: EmergencyInput): EmergencyWrite {
  let path: string | null = null;
  try {
    const { projectId, turn } = guardName(input.projectId, input.turn);
    if (input.doc.projectId !== projectId) {
      throw new RangeError(
        `抢救件说这是工程 ${projectId}，文档却签在 ${input.doc.projectId}：` +
          `一份状态不能同时是两个工程的现场`,
      );
    }
    const dir = emergencyDir(userDataDir);
    path = join(dir, emergencyFileName(projectId, turn));
    const envelope: Envelope = {
      kind: ENVELOPE_KIND,
      projectId,
      turn,
      schemaVersion: input.doc.schemaVersion,
      writtenAtMs: Date.now(),
      error: input.error,
      canonical: input.doc.canonical(),
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  } catch (err) {
    return { ok: false, error: describeError(err), path };
  }
  // 裁剪单独包一层：文件已经在盘上了，把裁剪失败谎报成"没抢救成功"是双重错 ——
  // 调用方会再写一份，而 T7 ⑦ 段刚立的规矩是同一 turn 只留一份现场。
  try {
    pruneEmergency(userDataDir, EMERGENCY_KEEP);
  } catch {
    // 忽略：宁可目录临时多几份，也不谎报写入结果。
  }
  return { ok: true, path };
}

/**
 * 按工程分桶裁剪，返回**删掉的文件名**（调用方要在日志里说清删了什么，返回值不是装饰）。
 * 排序键是文件名里的 turn，不是 mtime —— T7 ⑧ 段：同一次会话连发两败可能撞在同一毫秒刻度上。
 */
export function pruneEmergency(userDataDir: string, keep: number): string[] {
  if (!Number.isSafeInteger(keep) || keep < 1) {
    throw new RangeError(
      `keep 必须是 >=1 的安全整数，收到 ${String(keep)}：0 等于一份都不留，` +
        '那是"关掉抢救"，该由调用方不装这个钩子来表述，不该让裁剪悄悄删光',
    );
  }
  const dir = emergencyDir(userDataDir);
  const byProject = new Map<EntityId, { name: string; turn: number }[]>();
  for (const name of readdirSync(dir)) {
    const m = FILE_RE.exec(name);
    const candidateId = m?.[1];
    const rawTurn = m?.[2];
    if (!candidateId || !rawTurn || !isEntityId(candidateId)) continue;
    const turn = Number(rawTurn);
    // 长得像但数值不合法（手搓的 turn-99999999999999999999.json）⇒ 不认识，不动。
    if (!Number.isSafeInteger(turn) || turn < 1) continue;
    const bucket = byProject.get(candidateId) ?? [];
    bucket.push({ name, turn });
    byProject.set(candidateId, bucket);
  }
  const removed: string[] = [];
  for (const bucket of byProject.values()) {
    if (bucket.length <= keep) continue;
    // 新的在前；同 turn 的双份（手搓出来的）按名字定序，保证这一发是确定的。
    bucket.sort((a, b) => b.turn - a.turn || (a.name < b.name ? -1 : 1));
    for (const item of bucket.slice(keep)) {
      // 名字来自 readdirSync，不含分隔符 ⇒ join 之后仍在 dir 里，这一发没有路径拼接风险。
      rmSync(join(dir, item.name), { force: true });
      removed.push(item.name);
    }
  }
  return removed;
}

/**
 * 抢救件的读侧形状。为什么**不** import protocol 的 `EmergencyRef`：这一族文件住在 fs 侧，
 * `{ turn, path }` 与那张表结构同型，直接写得让 fs 侧认识 protocol —— T9 换 wire 形状时就得改两个包。
 * 同一理由见 `EmergencyInput` 为什么比 `EmergencyPayload` 少一个 `patch`（T7 ⑨ 段）。
 */
export interface EmergencyFound {
  readonly turn: number;
  readonly path: string;
}

/**
 * 读出某个工程在盘上的现场，**按 turn 升序**（写侧的 `pruneEmergency` 是"新的在前"，因为裁剪要砍尾巴；
 * 读侧给横幅，升序才读得出"最新那一份是第几发"）。
 *
 * 除 `userDataDir` 为空串那一刀（`emergencyDir` 的参数守卫，与写侧同一把尺，**不吞** ——
 * 吞了就把"我们没接线"说成"盘上没有现场"），其余失败一律不抛：这一发发生在 `open` 的途中，
 * 读目录失败不能把"打开工程"整个拒掉。但**也不能悄悄返回空**：横幅上"有 K 发没进库"那句
 * 要是因为读不动就说成"没有"，那是这一族文件最不该撒的一句谎 —— 所以除 ENOENT 之外都 `console.error` 一声。
 */
export function listEmergency(userDataDir: string, projectId: EntityId): EmergencyFound[] {
  const dir = emergencyDir(userDataDir);
  const found: EmergencyFound[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if ((err as { code?: unknown }).code !== 'ENOENT') {
      console.error(`[dajia] 抢救件目录读不动，"有几发没进库"这一发只能空着：${describeError(err)}`);
    }
    return found;
  }
  for (const name of names) {
    const m = FILE_RE.exec(name);
    const stem = m?.[1];
    const rawTurn = m?.[2];
    // 词干直接等于要查的工程号：形状不认识与别人的文件都从这里出局（与 pruneEmergency 同一口径）。
    if (stem !== projectId || rawTurn === undefined) continue;
    const turn = Number(rawTurn);
    if (!Number.isSafeInteger(turn) || turn < 1) continue;
    found.push({ turn, path: join(dir, name) });
  }
  return found.sort((a, b) => a.turn - b.turn);
}
