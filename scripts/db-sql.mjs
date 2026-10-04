// T1 占位：迁移 SQL 在 Task 2 落地（见计划 4 的 P-11）。
// 现在就把 `db:sql` 挂进 package.json 是为了让它有人认领，别让 CI 之外的第二条通路裸奔。
process.stderr.write('db:sql 还没有迁移文件可导出（计划 4 Task 2 落地它）\n');
process.exit(2);
