/** -------------------- 核心函数 -------------------- */
/**
 * 抛出 Promise.allSettled 中的失败
 */
export function throwSettledErrors(
  results: readonly PromiseSettledResult<unknown>[],
  message: string,
  unwrapSingle?: boolean,
) {
  const errors = results.flatMap(result => (
    result.status === 'rejected' ? [result.reason] : []
  ))

  if (unwrapSingle && errors.length === 1)
    throw errors[0]
  if (errors.length > 0)
    throw new AggregateError(errors, message)
}
