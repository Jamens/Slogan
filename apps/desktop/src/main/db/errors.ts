/**
 * `'no-project'` 这个码的**唯一产地**（T9 第 ⑥ 段）。
 *
 * 为什么是一个类而不是一个 `code` 字段：`persistErrorCode` 的现有规则是"有 string `code` ⇒ `'db'`"
 * （mysql2 抛的东西一律带 `code`，那条规则的全部用途就是把"驱动说的错"归给"查服务"）。
 * 给自家错误也塞一个 `code`，等于让它冒领驱动错误的形状 —— 下一版规则一改，
 * "这个工程不存在"就会被归成"服务没起来"，而那是两条不同的下一步。
 *
 * 为什么零 import：抛它的是 `db/repository.ts`（T5），认它的是 `persist/session.ts`（T8）。
 * 两个目录都要能 import 它，而 `persist/**` 一旦因为别的原因认识 `db/**` 就连了方向；
 * 只有"运行时谁都不认识"的文件能同时住在两边。它连 `@dajia/core` 的 `EntityId` 都只用 `string`
 * 表达：带上一行模块导入就不算零 import 了 —— 哪怕写成 `import type`（编译后确实被抹掉），
 * 那条判据扫的是源码里还留着模块说明符这件事（`persist-boundary.test.ts` 第 7 格），
 * 而这一发的调用者只有 `repository.ts` 一处，它传的本来就是 `this.projectId`。
 *
 * 为什么**不留字段**：`projectId` 拼进文案就丢了。一个没人读的 public 字段是给下一个编辑者的谜题
 * （"这大概是留给谁用的？"），而此刻唯一的读者 `wrap` 只认 `instanceof` 与 `message`（同 P-15
 * 那条"不许为测试留钩子"）。真要它，就回来加字段**并同时**加一个读者与一格判据。
 */
export class MissingProjectError extends Error {
  constructor(projectId: string) {
    // 这一句是 T5 的 `loadProject` 原话，**逐字**搬过来（换类不换话）。
    // 它的旧证人在连库那一档：`test/db/repository.test.ts` 里「工程不在库里 ⇒ 拒开，且文案点名它」
    // 那一格判的是 `/工程 ${PROJECT_ID} 不在库里/` —— 它不需要改写，也正因为不需要改写，
    // 它是这一处改动唯一"老判据仍然会红"的证据。
    super(
      `工程 ${projectId} 不在库里：要么它从没建过，要么它已经被删；不能凭空开一份文档当它是读来的`,
    );
    this.name = 'MissingProjectError';
  }
}
