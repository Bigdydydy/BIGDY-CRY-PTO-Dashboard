'use strict';
/**
 * 先回旧数据、后台刷新 (stale-while-revalidate)，带一个等待上限。
 *
 * 取数模块的缓存过期时，以前是让当次请求原地等上游 (数秒到数十秒)，页面只能空着。
 * 现在：手里有通过校验的旧数据时，刷新照常发出，但请求最多等 budgetMs——
 *   - 刷新在上限内完成 → 返回刷新结果 (新数据，或模块自己的失败兜底)；
 *   - 刷新在上限内失败 → 返回旧数据；
 *   - 超过上限 → 返回旧数据并标 `revalidating: true`，刷新在后台继续，
 *     结果写入模块缓存，下一次请求即可拿到。
 *
 * 旧数据的 dataHealth 由调用方用 withDataHealth 按载荷自己的时钟实时重算，
 * 过了新鲜度窗口照样显示「旧缓存 / 过期不可用」，不会被标成新的。
 * `revalidating` 只出现在返回给调用方的副本上，不会写进模块缓存或磁盘。
 */

const DEFAULT_BUDGET_MS = (() => {
  const v = Number(process.env.SWR_BUDGET_MS);
  return Number.isFinite(v) && v >= 0 ? v : 1200;
})();

/**
 * @param {Promise<object>} refresh   正在进行的刷新 (调用方负责单飞)
 * @param {() => object} stale        取旧数据 (已带实时重算的 dataHealth)
 * @param {object} [opts]
 * @param {number} [opts.budgetMs]    最多等刷新多久
 * @param {boolean} [opts.rethrow]    刷新在上限内失败时抛出原错误，而不是回旧数据
 *                                    (用于没有数据健康标注、旧数据不能悄悄顶替的接口)
 */
function raceStale(refresh, stale, { budgetMs = DEFAULT_BUDGET_MS, rethrow = false } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ...stale(), revalidating: true });
    }, budgetMs);
    refresh.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, (err) => {
      // 失败已由取数模块记入数据健康；超过上限后的失败在这里被接住，不会成为未处理的 rejection
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (rethrow) reject(err); else resolve(stale());
    });
  });
}

module.exports = { raceStale, DEFAULT_BUDGET_MS };
