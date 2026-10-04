// CommandType 在 core，这半边在 protocol，同一族"两份文本 + 测试钉死"。
// 落库那一侧（T4 的 codec）拿 CommandTypeSchema 校验 command_log.type：这里漏一条，
// 库里就多一种没人认识的 type；core 加了新命令而这里没登记，加载时 zod 直接把整个工程拒了 ——
// 后者是更坏的失败方式，所以这一格的红必须发生在提交前，而不是发生在用户按下"打开工程"时。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMMAND_TYPES, CommandTypeSchema } from '../src/command-type';

const commandSrc = readFileSync(
  new URL('../../core/src/model/command.ts', import.meta.url),
  'utf8',
);

describe('COMMAND_TYPES ↔ core CommandType', () => {
  it('16 条命令类型逐字相同（顺序不比对，集合比对）', () => {
    const block = commandSrc.match(/export type CommandType =([\s\S]*?);/);
    if (block === null) throw new Error('core 的 CommandType 没抠到 —— command.ts 结构变了');
    const coreTypes = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect([...COMMAND_TYPES].sort()).toEqual(coreTypes);
    expect(coreTypes.length).toBe(16);
  });

  it('CommandTypeSchema 收 16 条、拒未知（含大小写与首尾空白各一发）', () => {
    for (const t of COMMAND_TYPES) expect(CommandTypeSchema.safeParse(t).success).toBe(true);
    expect(CommandTypeSchema.safeParse('wall.Create').success).toBe(false);
    expect(CommandTypeSchema.safeParse(' wall.create').success).toBe(false);
    expect(CommandTypeSchema.safeParse(undefined).success).toBe(false);
  });
});
