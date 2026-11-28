/* ==========================================================================
   图表工具条（2026-11-27）
   每张 ECharts 图右上角悬停出现三个按钮：放大 · 导出 PNG · 导出 CSV。
   不改动各模块的渲染代码：靠 ECharts 写在容器上的 _echarts_instance_ 属性发现图表，
   图表被 dispose 再重建时（容器 innerHTML 被清空）自动重新挂上。
   ========================================================================== */
(function () {
  'use strict';
  if (!window.echarts || typeof window.echarts.getInstanceByDom !== 'function') return;

  const ATTR = '_echarts_instance_';
  const MIN_W = 220;
  const MIN_H = 150;
  const TZ_OFFSET_MS = 8 * 3600 * 1000; // 全站时间口径为 UTC+8

  const ICON = {
    full: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>',
    exit: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>',
    png: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>',
    csv: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>'
  };

  function chartOf(dom) {
    try { return window.echarts.getInstanceByDom(dom) || null; } catch (e) { return null; }
  }

  // 图的标题：就近找面板 / 卡片标题，用于文件名与按钮提示
  function titleOf(dom) {
    const panel = dom.closest('.tp-chart-panel, .chart-panel, .chart-container, .bento-card');
    const t = panel && panel.querySelector('.tp-chart-title, .chart-title, h3, h2');
    const text = t ? t.textContent : '';
    return text.replace(/\s+/g, ' ').trim().slice(0, 48);
  }

  function stamp() {
    const d = new Date(Date.now() + TZ_OFFSET_MS);
    const p = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
  }

  function fileBase(dom) {
    const id = (dom.id || 'chart').replace(/-?echarts?$/i, '').replace(/[^a-z0-9_-]/gi, '') || 'chart';
    return `bigdy_${id}_${stamp()}`;
  }

  function download(href, name) {
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function canvasBg() {
    const cs = getComputedStyle(document.documentElement);
    return (cs.getPropertyValue('--bg-canvas') || '').trim() || '#0c0b0a';
  }

  // ---------------------------------------------------------------- PNG
  function exportPng(dom) {
    const chart = chartOf(dom);
    if (!chart) return;
    const url = chart.getDataURL({
      type: 'png',
      pixelRatio: Math.max(2, window.devicePixelRatio || 1),
      backgroundColor: canvasBg(),
      excludeComponents: ['toolbox']
    });
    download(url, `${fileBase(dom)}.png`);
  }

  // ---------------------------------------------------------------- CSV
  function fmtTime(v) {
    const d = new Date(Number(v) + TZ_OFFSET_MS);
    if (isNaN(d.getTime())) return String(v);
    const p = n => String(n).padStart(2, '0');
    const day = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
    const hm = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
    return hm === '00:00' || hm === '08:00' ? day : `${day} ${hm}`;
  }

  function cellOf(v) {
    if (v === null || v === undefined || v === '-' || (typeof v === 'number' && !isFinite(v))) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function unwrap(d) {
    return d && typeof d === 'object' && !Array.isArray(d) && 'value' in d ? d.value : d;
  }

  /** 把 option 里的序列摊成一张宽表：首列为 x（类目或时间），其余每列一条序列 */
  function buildCsv(chart) {
    const opt = chart.getOption() || {};
    const xAxis = (opt.xAxis || [])[0] || {};
    const yAxis = (opt.yAxis || [])[0] || {};
    // 横向条形图：类目在 y 轴上
    const catAxis = Array.isArray(xAxis.data) && xAxis.data.length ? xAxis
      : (Array.isArray(yAxis.data) && yAxis.data.length ? yAxis : null);
    const cats = catAxis ? catAxis.data.map(unwrap) : null;
    const isTime = xAxis.type === 'time';

    const series = (opt.series || []).filter(s => Array.isArray(s.data) && s.data.length && s.type !== 'pie' && s.type !== 'gauge');
    if (!series.length) return null;

    const keys = [];
    const rows = new Map();
    const headers = [];
    const seen = new Map();

    series.forEach((s, si) => {
      let name = String(s.name || `series_${si + 1}`);
      const n = (seen.get(name) || 0) + 1;
      seen.set(name, n);
      if (n > 1) name = `${name} (${n})`;
      headers.push(name);

      s.data.forEach((raw, i) => {
        const v = unwrap(raw);
        let x, y;
        if (Array.isArray(v)) {
          if (v.length >= 3) { x = `${v[0]} | ${v[1]}`; y = v[2]; } // 热力图等 [x, y, value]
          else { x = v[0]; y = v[1]; }
        } else {
          x = cats ? cats[i] : i;
          y = v;
        }
        const key = String(x);
        if (!rows.has(key)) { rows.set(key, { x, vals: [] }); keys.push(key); }
        rows.get(key).vals[si] = y;
      });
    });

    if (isTime) keys.sort((a, b) => Number(rows.get(a).x) - Number(rows.get(b).x));
    const looksDate = keys.length && /^\d{4}-\d{2}-\d{2}/.test(keys[0]);
    const xLabel = isTime ? 'time (UTC+8)' : (catAxis && catAxis.name ? String(catAxis.name) : (looksDate ? 'date' : 'x'));
    const lines = [[xLabel].concat(headers).map(cellOf).join(',')];
    keys.forEach(k => {
      const r = rows.get(k);
      const x = isTime && typeof r.x === 'number' ? fmtTime(r.x) : r.x;
      const cells = [cellOf(x)];
      for (let i = 0; i < headers.length; i++) cells.push(cellOf(r.vals[i]));
      lines.push(cells.join(','));
    });
    return lines.join('\r\n');
  }

  function exportCsv(dom, btn) {
    const chart = chartOf(dom);
    if (!chart) return;
    let csv = null;
    try { csv = buildCsv(chart); } catch (e) { console.warn('[ChartTools] CSV 导出失败:', e.message); }
    if (!csv) {
      flashHint(btn, '此图没有可导出的序列');
      return;
    }
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }); // BOM：Excel 正确识别中文
    const url = URL.createObjectURL(blob);
    download(url, `${fileBase(dom)}.csv`);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function flashHint(btn, text) {
    if (!btn) return;
    const old = btn.getAttribute('title');
    btn.setAttribute('title', text);
    btn.classList.add('is-denied');
    setTimeout(() => { btn.classList.remove('is-denied'); if (old) btn.setAttribute('title', old); }, 1600);
  }

  // ---------------------------------------------------------------- 放大
  // 不用浏览器原生全屏：内嵌浏览器与 iPhone Safari 都不支持元素级全屏。
  // 卡片带 backdrop-filter，会成为 fixed 子元素的定位容器，所以要把图节点暂时移到 body 下的浮层里，
  // 原位置留一个等高占位；还原时原样放回（节点、id、ECharts 实例与事件都不变）。
  let expanded = null;

  function setFullBtn(dom, on) {
    const b = dom.querySelector(':scope > .bdy-chart-tools [data-act="full"]');
    if (!b) return;
    b.innerHTML = on ? ICON.exit : ICON.full;
    b.setAttribute('aria-label', on ? '还原' : '放大查看');
    b.setAttribute('title', on ? '还原 (Esc)' : '放大查看');
  }

  // 节点刚移动完就同步重算一次（读尺寸会强制布局），再在下一帧补一次以防样式尚未生效；
  // 不能只靠 requestAnimationFrame：页面在后台时它会暂停
  function resizeSoon(dom) {
    const run = () => { const c = chartOf(dom); if (c) c.resize(); };
    run();
    requestAnimationFrame(run);
    setTimeout(run, 120);
  }

  function expand(dom) {
    if (expanded) collapse();
    const ph = document.createElement('div');
    ph.className = 'bdy-chart-placeholder';
    ph.style.height = `${dom.offsetHeight}px`;
    dom.parentNode.insertBefore(ph, dom);

    const shell = document.createElement('div');
    shell.className = 'bdy-chart-overlay';
    shell.setAttribute('role', 'dialog');
    shell.setAttribute('aria-modal', 'true');
    const title = titleOf(dom);
    shell.setAttribute('aria-label', title || '图表');
    const head = document.createElement('div');
    head.className = 'bdy-chart-overlay-head';
    head.textContent = title;
    shell.appendChild(head);
    shell.appendChild(dom);
    shell.addEventListener('click', (e) => { if (e.target === shell) collapse(); });
    document.body.appendChild(shell);

    dom.classList.add('bdy-chart-expanded');

    expanded = { dom, ph, shell, focus: document.activeElement };
    setFullBtn(dom, true);
    resizeSoon(dom);
    const btn = dom.querySelector(':scope > .bdy-chart-tools [data-act="full"]');
    if (btn) btn.focus({ preventScroll: true });
  }

  function collapse() {
    if (!expanded) return;
    const { dom, ph, shell, focus } = expanded;
    expanded = null;
    if (ph.parentNode) ph.parentNode.insertBefore(dom, ph);
    ph.remove();
    shell.remove();
    dom.classList.remove('bdy-chart-expanded');

    setFullBtn(dom, false);
    resizeSoon(dom);
    if (focus && focus.focus) focus.focus({ preventScroll: true });
  }

  function toggleFull(dom) {
    if (expanded && expanded.dom === dom) collapse();
    else expand(dom);
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && expanded) { e.stopPropagation(); collapse(); }
  }, true);
  document.addEventListener('bigdy:viewchange', collapse);

  // ---------------------------------------------------------------- 挂载
  function attach(dom) {
    if (!dom || !dom.isConnected || !dom.getAttribute(ATTR)) return;
    if (dom.querySelector(':scope > .bdy-chart-tools')) return;
    // 弹窗里的图（大宗解析、PnL 模拟）有自己的尺寸管理，不挂工具条
    if (dom.closest('[class*="modal"], .atl-gallery, [data-no-chart-tools]')) return;
    // 隐藏视图里的图尺寸为 0：等它显示出来（视图切换时会再扫描一次）
    const w = dom.clientWidth, h = dom.clientHeight;
    if (!w || !h) return;
    if (w < MIN_W || h < MIN_H) return; // 迷你图、仪表盘不加

    if (getComputedStyle(dom).position === 'static') dom.style.position = 'relative';
    const title = titleOf(dom);
    const bar = document.createElement('div');
    bar.className = 'bdy-chart-tools';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', title ? `${title} · 图表工具` : '图表工具');
    bar.innerHTML =
      `<button type="button" data-act="full" title="放大查看" aria-label="放大查看">${ICON.full}</button>` +
      `<button type="button" data-act="png" title="导出 PNG" aria-label="导出 PNG">${ICON.png}</button>` +
      `<button type="button" data-act="csv" title="导出 CSV（图上全部序列）" aria-label="导出 CSV">${ICON.csv}</button>`;
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'full') toggleFull(dom);
      else if (act === 'png') exportPng(dom);
      else if (act === 'csv') exportCsv(dom, btn);
    });
    // 工具条上的指针事件不要传给 ECharts（避免触发 tooltip / 缩放）
    ['mousedown', 'mousemove', 'wheel', 'pointerdown'].forEach(t => bar.addEventListener(t, e => e.stopPropagation(), { passive: true }));
    dom.appendChild(bar);
  }

  function scan(root) {
    (root || document).querySelectorAll('[' + ATTR + ']').forEach(attach);
  }

  let scanTimer = 0;
  function scheduleScan(delay) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => scan(), delay == null ? 120 : delay);
  }

  const mo = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes' && r.attributeName === ATTR) { scheduleScan(80); return; }
      // dispose 会清空容器，重建后需重新挂载
      if (r.type === 'childList' && r.target.nodeType === 1 && r.target.hasAttribute && r.target.hasAttribute(ATTR)
          && !r.target.querySelector(':scope > .bdy-chart-tools')) { scheduleScan(80); return; }
    }
  });
  mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: [ATTR] });

  document.addEventListener('bigdy:viewchange', () => scheduleScan(400));
  window.addEventListener('resize', () => scheduleScan(300), { passive: true });
  scheduleScan(600);

  window.BigdyChartTools = { scan, buildCsv: (dom) => { const c = chartOf(dom); return c ? buildCsv(c) : null; } };
})();
