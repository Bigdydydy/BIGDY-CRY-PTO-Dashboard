#!/usr/bin/env node
/**
 * Module 1 数据快照：重建宏观图与优先股数据集并写回 data/。
 * 由 GitHub Actions 定时运行并提交，线上实例冷启动时从 GitHub raw 读取这份快照，
 * 即使实例所在 IP 被个别数据源限流，页面也不会退回到上次部署时的旧数据。
 */
const { fetchAndBuildMacroData } = require('../server/macro_fetcher');
const { getPreferredsData } = require('../server/mstr_preferreds');

async function main() {
  const macro = await fetchAndBuildMacroData();
  const s = macro.summary;
  console.log('[macro_snapshot] macro', s.dateRange.end, 'sources', JSON.stringify(s.sources));

  try {
    const pref = await getPreferredsData(true);
    console.log('[macro_snapshot] preferreds', pref.summary.asOf, 'sources', JSON.stringify(pref.summary.sources));
  } catch (err) {
    // 优先股数据失败不影响宏观快照提交
    console.warn('[macro_snapshot] preferreds failed:', err.message);
  }
}

main().catch((err) => {
  console.error('[macro_snapshot] failed:', err.message);
  process.exit(1);
});
