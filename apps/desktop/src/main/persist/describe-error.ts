/**
 * 把"外部世界"的抛错压成一行不带换行的文本。驱动的错误在 `err.code` 上
 * （ECONNREFUSED / ER_* / ENOTDIR），那一格丢了就查不到根因，所以它必须出现在文案里。
 * 分型文案（"下一步该做什么"）归 T9 的 `classifyDbError`：这里只保证不丢，不保证好听。
 * 共享的理由见上一段：`SaveStatus.lastError` 与抢救件的 `error` 是同一条口径的两个读者。
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string'
      ? `${err.name}(${code}): ${err.message}`
      : `${err.name}: ${err.message}`;
  }
  return `非 Error 抛出：${String(err)}`;
}
