/**
 * Atelier — 油画背景舞台 · ASCII 叠层 · 画廊 · 交互动效
 * 「狂妄的投入生命的张力」
 *
 * 独立于 app.js：只通过 DOM、全局 switchView / toggleTheme 以及 app.js 派发的
 * `bigdy:viewchange` 事件协作。必须在 app.js 之前加载，才能接住首次视图切换事件。
 */
(function () {
  'use strict';

  const prefersReducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const root = document.documentElement;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };
  const sessionStore = {
    get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
  };

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ===========================================================================
  // 画作目录 —— 3 幅公有领域油画，已存于 public/art/（同源，ASCII 叠层可直接读取像素）
  // 原图来源：Wikimedia Commons（Google Art Project）· Barnes Foundation 开放馆藏 · 大都会博物馆开放获取
  // ===========================================================================
  const PAINTINGS = [
    {
      id: 'friedrich-monk',
      title: '海边的修士',
      original: 'Der Mönch am Meer',
      artist: '卡斯帕·大卫·弗里德里希', artistEn: 'Caspar David Friedrich',
      year: '1808–1810',
      collection: 'Alte Nationalgalerie · 柏林',
      concept: '永不消解的剩余', conceptOrig: 'der nie aufgehende Rest',
      thinker: '谢林《论人类自由的本质》',
      note: '这幅画与谢林的《自由论》几乎同时诞生。画中没有船，也没有可以依托的岸线，只有一个人面对吞没一切的海与天；克莱斯特说，看它时「仿佛眼睑被割去」。每一个模型都会在根底处留下一份无法化入知性的剩余——交易者必须独自站在它的岸边。',
      quote: { orig: '… der nie aufgehende Rest, das, was sich mit der größten Anstrengung nicht in Verstand auflösen läßt, sondern ewig im Grunde bleibt.', zh: '……那永不消解的剩余：以最大的努力也无法化入知性、永远留在根底之中的东西。', by: '谢林，1809' },
      src: '/art/friedrich-monk-by-the-sea.jpg',
      thumb: '/art/friedrich-monk-by-the-sea-thumb.jpg',
      source: 'https://commons.wikimedia.org/wiki/File:Caspar_David_Friedrich_-_Der_M%C3%B6nch_am_Meer_-_Google_Art_Project.jpg',
      focus: [0.5, 0.5]
    },
    {
      id: 'cezanne-card-players',
      title: '玩纸牌者',
      original: 'Les Joueurs de cartes',
      artist: '保罗·塞尚', artistEn: 'Paul Cézanne',
      year: '1890–1892',
      collection: 'Barnes Foundation · 费城（BF564）',
      concept: '牌桌上没有旁观者', conceptOrig: 'Tathandlung',
      thinker: '费希特 · 本原行动',
      note: '巴恩斯收藏的这一版，是塞尚同题系列中尺幅最大、人物最多的一幅。没有人虚张声势，只有沉默与专注；连站在一旁的人也被牌局的引力吸住。费希特说，自我只在行动中、在遭遇阻力（Anstoß）时才认识自己——市场的知识也只能以下注为代价换取。',
      quote: { orig: 'Was für eine Philosophie man wähle, hängt sonach davon ab, was man für ein Mensch ist.', zh: '人选择什么样的哲学，取决于他是什么样的人。', by: '费希特，1797' },
      src: '/art/cezanne-card-players.jpg',
      thumb: '/art/cezanne-card-players-thumb.jpg',
      source: 'https://collection.barnesfoundation.org/objects/6992/The-Card-Players-(Les-Joueurs-de-cartes)',
      focus: [0.5, 0.35]
    },
    {
      id: 'homer-gulf-stream',
      title: '湾流',
      original: 'The Gulf Stream',
      artist: '温斯洛·霍默', artistEn: 'Winslow Homer',
      year: '1899',
      collection: 'The Metropolitan Museum of Art · 纽约',
      concept: '停留于否定之中', conceptOrig: 'Verweilen beim Negativen',
      thinker: '黑格尔《精神现象学》序言',
      note: '桅杆折断，鲨群环伺，地平线上卷起水龙卷，远处的帆船未必看得见他。霍默画里的水手没有挣扎，他侧卧着望向海面。黑格尔说，精神的生命不是畏惧死亡、躲开荒芜的生命，而是承受死亡并在其中保持自身。流动性枯竭之时，能停留在否定之中的人，才看得清对手盘。',
      quote: { orig: '… sondern das ihn erträgt und in ihm sich erhält, ist das Leben des Geistes.', zh: '……而是承受死亡、并在死亡中保持自身的生命，才是精神的生命。', by: '黑格尔，1807' },
      src: '/art/homer-gulf-stream.jpg',
      thumb: '/art/homer-gulf-stream-thumb.jpg',
      source: 'https://www.metmuseum.org/art/collection/search/11122',
      focus: [0.5, 0.5]
    }
  ];
  const PAINTING_BY_ID = Object.fromEntries(PAINTINGS.map(p => [p.id, p]));
  const DEFAULT_PAINTING = 'friedrich-monk';

  // ===========================================================================
  // 图像加载（同一 URL 只请求一次；crossOrigin 让 ASCII 叠层可以读取像素）
  // ===========================================================================
  const imageCache = new Map();
  function loadImage(url) {
    if (imageCache.has(url)) return imageCache.get(url);
    const promise = new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => {
        imageCache.delete(url);
        reject(new Error(`画作加载失败: ${url}`));
      };
      img.src = url;
    });
    imageCache.set(url, promise);
    return promise;
  }

  // ===========================================================================
  // ASCII 叠层：按单元格采样画作颜色，在噪声流动的区域把画面「重写」成字符
  // ===========================================================================
  const Ascii = (function () {
    const canvas = document.getElementById('atl-ascii');
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    const RAMP = '@%#8&0$Oo*+=~-:.';
    const CW = 7;
    const CH = 11;

    let W = 0, H = 0, dpr = 1, cols = 0, rows = 0;
    let rgb = null, lum = null, edge = null;
    let atlasDark = null, atlasLight = null;
    let source = null, focus = [0.5, 0.5];
    let raf = 0, last = 0, running = false;
    let sweepStart = -1;
    let threshold = 0.66, targetThreshold = 0.66;
    const mouse = { x: -1e4, y: -1e4, power: 0, lastMove: 0 };
    let tainted = false;

    function hash(x, y) {
      let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    }
    function noise(x, y) {
      const xi = Math.floor(x), yi = Math.floor(y);
      const xf = x - xi, yf = y - yi;
      const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
      const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    }

    function buildAtlas(color) {
      const atlas = document.createElement('canvas');
      atlas.width = Math.ceil(RAMP.length * CW * dpr);
      atlas.height = Math.ceil(CH * dpr);
      const a = atlas.getContext('2d');
      a.scale(dpr, dpr);
      a.font = `600 ${CH - 1}px "JetBrains Mono", Consolas, monospace`;
      a.textAlign = 'center';
      a.textBaseline = 'middle';
      a.fillStyle = color;
      for (let i = 0; i < RAMP.length; i++) a.fillText(RAMP[i], i * CW + CW / 2, CH / 2 + 0.5);
      return atlas;
    }

    function resize() {
      W = window.innerWidth;
      H = window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      cols = Math.ceil(W / CW);
      rows = Math.ceil(H / CH);
      atlasDark = buildAtlas('rgba(12, 10, 8, 1)');
      atlasLight = buildAtlas('rgba(255, 250, 238, 1)');
      sample();
      if (!running) draw(performance.now());
    }

    function sample() {
      rgb = null;
      if (!source || !cols) return;
      const off = document.createElement('canvas');
      off.width = cols;
      off.height = rows;
      const octx = off.getContext('2d', { willReadFrequently: true });
      octx.imageSmoothingQuality = 'high';
      // 与 object-fit: cover + object-position 完全一致的映射，保证字符与画面对齐
      const iw = source.naturalWidth, ih = source.naturalHeight;
      const s = Math.max(W / iw, H / ih);
      const dw = iw * s, dh = ih * s;
      const dx = (W - dw) * focus[0], dy = (H - dh) * focus[1];
      octx.drawImage(source, dx / CW, dy / CH, dw / CW, dh / CH);
      let data;
      try {
        data = octx.getImageData(0, 0, cols, rows).data;
      } catch (e) {
        tainted = true; // 跨域图像未授权：静默关闭叠层
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }
      tainted = false;
      const n = cols * rows;
      rgb = new Uint8ClampedArray(n * 3);
      lum = new Float32Array(n);
      edge = new Float32Array(n);
      let lumSum = 0;
      for (let i = 0; i < n; i++) {
        const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
        rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
        const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        lum[i] = L;
        lumSum += L;
      }
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const i = y * cols + x;
          const right = x + 1 < cols ? lum[i + 1] : lum[i];
          const down = y + 1 < rows ? lum[i + cols] : lum[i];
          edge[i] = Math.min(1, (Math.abs(lum[i] - right) + Math.abs(lum[i] - down)) * 3.2);
        }
      }
      root.style.setProperty('--stage-lum', (lumSum / n).toFixed(3));
    }

    function draw(now) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!rgb || tainted) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const t = now / 1000;
      threshold += (targetThreshold - threshold) * 0.15;
      const idle = now - mouse.lastMove;
      mouse.power += ((idle < 1400 ? 1 : 0) - mouse.power) * 0.18;
      const lensR = 170;

      let sweepP = -1;
      if (sweepStart >= 0) {
        sweepP = (now - sweepStart) / 1500;
        if (sweepP > 1) { sweepStart = -1; sweepP = -1; }
      }

      const darkCells = [];
      const lightCells = [];
      let lastFill = '';
      for (let y = 0; y < rows; y++) {
        const cy = y * CH;
        for (let x = 0; x < cols; x++) {
          const i = y * cols + x;
          let m = 0.62 * noise(x * 0.045 + t * 0.05, y * 0.075 - t * 0.03)
                + 0.38 * noise(x * 0.14 - t * 0.09, y * 0.21 + 7.3);
          m += edge[i] * 0.42;
          if (mouse.power > 0.02) {
            const dx = x * CW - mouse.x, dy = cy - mouse.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < lensR * lensR) {
              const k = 1 - Math.sqrt(d2) / lensR;
              m += k * k * 0.75 * mouse.power;
            }
          }
          if (sweepP >= 0) {
            const u = x / cols + (noise(x * 0.1, y * 0.1) - 0.5) * 0.18;
            const center = -0.15 + sweepP * 1.3;
            const band = 1 - Math.abs(u - center) / 0.14;
            if (band > 0) m += band * 1.2;
          }
          if (m < threshold) continue;

          const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
          const fill = `rgb(${r},${g},${b})`;
          if (fill !== lastFill) { ctx.fillStyle = fill; lastFill = fill; }
          ctx.fillRect(x * CW, cy, CW, CH);

          let gi = Math.min(RAMP.length - 1, Math.floor(lum[i] * RAMP.length));
          if (Math.random() < 0.04) gi = (Math.random() * RAMP.length) | 0; // 数字微光
          (lum[i] > 0.52 ? darkCells : lightCells).push(x, y, gi);
        }
      }

      const sw = CW * dpr, sh = CH * dpr;
      ctx.globalAlpha = 0.6;
      for (let k = 0; k < darkCells.length; k += 3) {
        ctx.drawImage(atlasDark, darkCells[k + 2] * sw, 0, sw, sh, darkCells[k] * CW, darkCells[k + 1] * CH, CW, CH);
      }
      ctx.globalAlpha = 0.55;
      for (let k = 0; k < lightCells.length; k += 3) {
        ctx.drawImage(atlasLight, lightCells[k + 2] * sw, 0, sw, sh, lightCells[k] * CW, lightCells[k + 1] * CH, CW, CH);
      }
      ctx.globalAlpha = 1;
    }

    function loop(now) {
      raf = requestAnimationFrame(loop);
      const interval = sweepStart >= 0 ? 45 : 110; // 平时约 9fps 的「数字微光」，转场时提速
      if (now - last < interval) return;
      last = now;
      draw(now);
    }

    function start() {
      if (running || prefersReducedMotion) return;
      running = true;
      raf = requestAnimationFrame(loop);
    }
    function stop() {
      running = false;
      cancelAnimationFrame(raf);
    }

    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 160);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop(); else start();
    });
    if (!prefersReducedMotion) {
      window.addEventListener('pointermove', (e) => {
        mouse.x = e.clientX;
        mouse.y = e.clientY;
        mouse.lastMove = performance.now();
      }, { passive: true });
    }

    resize();
    start();

    return {
      setSource(img, f) {
        source = img;
        focus = f || [0.5, 0.5];
        sample();
        sweepStart = prefersReducedMotion ? -1 : performance.now();
        if (!running) draw(performance.now());
      },
      setIntensity(level) {
        targetThreshold = level === 'high' ? 0.58 : 0.66;
      }
    };
  })();

  // ===========================================================================
  // 背景舞台：两层交叉淡入；缩略图先行，高清图到达后无缝替换
  // ===========================================================================
  const Stage = (function () {
    const layers = Array.from(document.querySelectorAll('.atl-layer'));
    let front = 0;
    let seq = 0;
    let shownId = null;

    async function show(painting) {
      if (!layers.length || !painting) return;
      if (painting.id === shownId) return;
      const mySeq = ++seq;
      shownId = painting.id;

      let thumb;
      try {
        thumb = await loadImage(painting.thumb);
      } catch (e) {
        console.warn('[Atelier]', e.message);
        return;
      }
      if (mySeq !== seq) return;

      const next = layers[1 - front];
      const pos = `${painting.focus[0] * 100}% ${painting.focus[1] * 100}%`;
      next.innerHTML = '';
      const singleRes = painting.src === painting.thumb;
      const lo = thumb.cloneNode();
      // 只有一种分辨率的画作（如巴恩斯 CDN 图）直接清晰显示，不走模糊占位
      lo.className = singleRes ? 'atl-hi is-ready' : 'atl-lo';
      lo.alt = '';
      lo.style.objectPosition = pos;
      next.appendChild(lo);

      layers[front].classList.remove('is-front');
      next.classList.add('is-front');
      front = 1 - front;
      if (Ascii) Ascii.setSource(thumb, painting.focus);
      root.dataset.painting = painting.id;

      if (singleRes) return;
      loadImage(painting.src).then(full => {
        if (mySeq !== seq) return;
        const hi = full.cloneNode();
        hi.className = 'atl-hi';
        hi.alt = '';
        hi.style.objectPosition = pos;
        next.appendChild(hi);
        requestAnimationFrame(() => hi.classList.add('is-ready'));
      }).catch(e => console.warn('[Atelier]', e.message));
    }

    return { show };
  })();

  // ===========================================================================
  // 当前画作状态（committed = 挂上墙的；预览只临时改变舞台）
  // ===========================================================================
  let committedId = PAINTING_BY_ID[store.get('atelier_painting')] ? store.get('atelier_painting') : DEFAULT_PAINTING;

  function currentPainting() {
    return PAINTING_BY_ID[committedId];
  }

  function commitPainting(id, { silent = false } = {}) {
    const p = PAINTING_BY_ID[id];
    if (!p) return;
    committedId = id;
    store.set('atelier_painting', id);
    Stage.show(p);
    renderCaption();
    Gallery.syncCurrent();
    Contemplate.render();
    if (!silent && typeof window.showToast === 'function') {
      window.showToast(`已挂上墙：${p.artist}《${p.title}》 · ${p.concept}`);
    }
  }

  function previewPainting(id) {
    const p = PAINTING_BY_ID[id];
    if (p) Stage.show(p);
  }

  // ---------------------------------------------------------------------------
  // 右下角画作铭牌
  // ---------------------------------------------------------------------------
  const captionEl = document.getElementById('atl-caption');
  function renderCaption() {
    if (!captionEl) return;
    const p = currentPainting();
    captionEl.innerHTML = `
      <img src="${esc(p.thumb)}" crossorigin="anonymous" alt="">
      <span class="atl-caption-text">
        <span class="atl-caption-title">${esc(p.artistEn)} · <em>${esc(p.original)}</em>, ${esc(p.year)}</span>
        <span class="atl-caption-concept">${esc(p.concept)} — ${esc(p.conceptOrig)}</span>
      </span>`;
    captionEl.setAttribute('aria-label', `当前背景画作：${p.artist}《${p.title}》，打开画廊`);
  }
  if (captionEl) captionEl.addEventListener('click', () => Gallery.open());

  // ===========================================================================
  // 画廊抽屉：悬停预览，点击挂上墙
  // ===========================================================================
  const Gallery = (function () {
    const el = document.createElement('div');
    el.className = 'atl-gallery';
    el.id = 'atl-gallery';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `
      <div class="atl-gallery-backdrop" data-close></div>
      <section class="atl-gallery-panel" role="dialog" aria-modal="true" aria-labelledby="atl-gallery-title">
        <header class="atl-gallery-head">
          <div>
            <div class="atl-eyebrow">Atelier · 画廊</div>
            <h3 id="atl-gallery-title">选择你的观看背景</h3>
            <p>悬停即预览，点击即挂上墙。</p>
          </div>
          <button class="atl-icon-btn" data-close aria-label="关闭画廊">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </header>
        <div class="atl-gallery-list">
          ${PAINTINGS.map((p, i) => `
            <article class="atl-art" data-id="${p.id}" tabindex="0" role="button" aria-label="${esc(p.artist)}《${esc(p.title)}》" style="--i:${i}">
              <div class="atl-art-media">
                <img src="${esc(p.thumb)}" crossorigin="anonymous" loading="lazy" alt="${esc(p.artistEn)}, ${esc(p.original)}">
                <span class="atl-art-no">${String(i + 1).padStart(2, '0')}</span>
                <span class="atl-art-current">当前</span>
              </div>
              <div class="atl-art-body">
                <div class="atl-art-concept"><span>${esc(p.concept)}</span><em>${esc(p.conceptOrig)}</em></div>
                <h4>${esc(p.title)}</h4>
                <div class="atl-art-orig">${esc(p.original)}</div>
                <div class="atl-art-meta">${esc(p.artistEn)} · ${esc(p.year)} · ${esc(p.collection)} · <a class="atl-art-source" href="${esc(p.source)}" target="_blank" rel="noopener">馆藏页 ↗</a></div>
                <p class="atl-art-note">${esc(p.note)}</p>
                <blockquote class="atl-art-quote">
                  ${p.quote.orig ? `<span class="atl-q-orig">${esc(p.quote.orig)}</span>` : ''}
                  <span class="atl-q-zh">${esc(p.quote.zh)}</span>
                  <cite>— ${esc(p.quote.by)}</cite>
                </blockquote>
                <div class="atl-art-actions">
                  <button class="atl-btn-primary" data-act="apply">挂上墙</button>
                  <button class="atl-btn-ghost" data-act="view">观画</button>
                  <span class="atl-art-thinker">${esc(p.thinker)}</span>
                </div>
              </div>
            </article>`).join('')}
        </div>
        <footer class="atl-gallery-foot">全部为公有领域作品 · 原图来自 Barnes Foundation 开放馆藏、大都会博物馆开放获取与 Wikimedia Commons，已存于本站</footer>
      </section>`;
    document.body.appendChild(el);

    let previewTimer = 0;
    let lastFocus = null;

    function isOpen() { return el.classList.contains('is-open'); }
    function open() {
      if (isOpen()) return;
      lastFocus = document.activeElement;
      el.classList.add('is-open');
      el.setAttribute('aria-hidden', 'false');
      syncCurrent();
      const cur = el.querySelector('.atl-art.is-current') || el.querySelector('.atl-art');
      setTimeout(() => {
        if (cur) {
          cur.scrollIntoView({ block: 'nearest' });
          cur.focus({ preventScroll: true });
        }
      }, 60);
    }
    function close() {
      if (!isOpen()) return;
      clearTimeout(previewTimer);
      el.classList.remove('is-open');
      el.setAttribute('aria-hidden', 'true');
      previewPainting(committedId);
      if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus({ preventScroll: true });
    }
    function syncCurrent() {
      el.querySelectorAll('.atl-art').forEach(card => {
        const on = card.dataset.id === committedId;
        card.classList.toggle('is-current', on);
        card.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }

    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) { close(); return; }
      if (e.target.closest('a')) return; // 馆藏页外链：只跳转，不换画
      const card = e.target.closest('.atl-art');
      if (!card) return;
      const act = e.target.closest('[data-act]');
      commitPainting(card.dataset.id);
      if (act && act.dataset.act === 'view') {
        close();
        Contemplate.enter();
      }
    });
    el.addEventListener('keydown', (e) => {
      const card = e.target.closest && e.target.closest('.atl-art');
      if (card && (e.key === 'Enter' || e.key === ' ') && e.target === card) {
        e.preventDefault();
        commitPainting(card.dataset.id);
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const cards = Array.from(el.querySelectorAll('.atl-art'));
        const idx = cards.indexOf(document.activeElement);
        if (idx >= 0) {
          e.preventDefault();
          const nextCard = cards[(idx + (e.key === 'ArrowDown' ? 1 : -1) + cards.length) % cards.length];
          nextCard.focus();
          nextCard.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion ? 'auto' : 'smooth' });
        }
      }
    });
    // 悬停 / 聚焦即预览
    const schedulePreview = (id) => {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => previewPainting(id), 140);
    };
    el.addEventListener('pointerover', (e) => {
      const card = e.target.closest('.atl-art');
      if (card) schedulePreview(card.dataset.id);
    });
    el.addEventListener('focusin', (e) => {
      const card = e.target.closest('.atl-art');
      if (card) schedulePreview(card.dataset.id);
    });
    el.querySelector('.atl-gallery-list').addEventListener('pointerleave', () => {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => previewPainting(committedId), 220);
    });

    return { open, close, isOpen, syncCurrent, toggle() { isOpen() ? close() : open(); } };
  })();

  // ===========================================================================
  // 观画模式：界面退场，只留下画作、铭牌与引文
  // ===========================================================================
  const Contemplate = (function () {
    const el = document.createElement('div');
    el.className = 'atl-contemplate';
    el.id = 'atl-contemplate';
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);

    function isOn() { return root.classList.contains('atl-contemplating'); }
    function render() {
      const p = currentPainting();
      const idx = PAINTINGS.indexOf(p);
      el.innerHTML = `
        <div class="atl-contemplate-plate">
          <div class="atl-eyebrow">Contemplatio · 观画 <span>${String(idx + 1).padStart(2, '0')} / ${String(PAINTINGS.length).padStart(2, '0')}</span></div>
          <h3>${esc(p.title)}</h3>
          <div class="atl-contemplate-orig">${esc(p.original)}</div>
          <div class="atl-contemplate-meta">${esc(p.artistEn)} · ${esc(p.year)} · ${esc(p.collection)} · <a class="atl-art-source" href="${esc(p.source)}" target="_blank" rel="noopener">馆藏页 ↗</a></div>
          <div class="atl-art-concept"><span>${esc(p.concept)}</span><em>${esc(p.conceptOrig)}</em></div>
          <blockquote class="atl-art-quote">
            ${p.quote.orig ? `<span class="atl-q-orig">${esc(p.quote.orig)}</span>` : ''}
            <span class="atl-q-zh">${esc(p.quote.zh)}</span>
            <cite>— ${esc(p.quote.by)}</cite>
          </blockquote>
          <div class="atl-contemplate-nav">
            <button class="atl-icon-btn" data-step="-1" aria-label="上一幅">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <button class="atl-icon-btn" data-step="1" aria-label="下一幅">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
            <button class="atl-btn-primary" data-exit>回到雷达</button>
            <span class="atl-contemplate-hint">Esc 返回 · ← → 换画</span>
          </div>
        </div>`;
    }
    function step(delta) {
      const idx = PAINTINGS.findIndex(p => p.id === committedId);
      const next = PAINTINGS[(idx + delta + PAINTINGS.length) % PAINTINGS.length];
      commitPainting(next.id, { silent: true });
    }
    function enter() {
      render();
      root.classList.add('atl-contemplating');
      el.setAttribute('aria-hidden', 'false');
      if (Ascii) Ascii.setIntensity('high');
      setTimeout(() => {
        const btn = el.querySelector('[data-exit]');
        if (btn) btn.focus({ preventScroll: true });
      }, 400);
    }
    function exit() {
      root.classList.remove('atl-contemplating');
      el.setAttribute('aria-hidden', 'true');
      if (Ascii) Ascii.setIntensity('normal');
    }
    el.addEventListener('click', (e) => {
      const s = e.target.closest('[data-step]');
      if (s) { step(Number(s.dataset.step)); return; }
      if (e.target.closest('[data-exit]')) exit();
    });
    // 点击画面空白处返回
    const stageEl = document.getElementById('atl-stage');
    if (stageEl) stageEl.addEventListener('click', () => { if (isOn()) exit(); });

    return { enter, exit, isOn, step, render };
  })();

  // ===========================================================================
  // 侧栏：图标轨 ↔ 展开；滑动高亮；收起时的悬浮标签
  // ===========================================================================
  const Rail = (function () {
    const sidebar = document.getElementById('app-sidebar');
    const toggleBtn = document.getElementById('atl-rail-toggle');
    const nav = document.getElementById('sidebar-nav');
    const tip = document.createElement('div');
    tip.className = 'atl-tip';
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);

    const indicator = document.createElement('span');
    indicator.className = 'atl-nav-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    if (nav) nav.prepend(indicator);

    function isCollapsed() { return root.classList.contains('atl-rail-collapsed'); }
    function set(collapsed) {
      root.classList.toggle('atl-rail-collapsed', collapsed);
      store.set('atelier_rail', collapsed ? 'collapsed' : 'expanded');
      if (toggleBtn) {
        toggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        toggleBtn.setAttribute('aria-label', collapsed ? '展开侧栏' : '收起侧栏');
      }
      tip.classList.remove('is-on');
      // 侧栏宽度过渡结束后让图表重新量尺寸
      setTimeout(() => {
        moveIndicator();
        window.dispatchEvent(new Event('resize'));
      }, 480);
    }
    function moveIndicator() {
      if (!nav) return;
      const active = nav.querySelector('.sidebar-nav-item.active');
      if (!active) { indicator.style.opacity = '0'; return; }
      indicator.style.opacity = '1';
      indicator.style.transform = `translateY(${active.offsetTop}px)`;
      indicator.style.height = `${active.offsetHeight}px`;
    }

    if (toggleBtn) {
      toggleBtn.setAttribute('aria-expanded', isCollapsed() ? 'false' : 'true');
      toggleBtn.addEventListener('click', () => set(!isCollapsed()));
    }

    if (sidebar) {
      sidebar.addEventListener('pointerover', (e) => {
        const item = e.target.closest('.sidebar-nav-item, .atl-rail-action');
        if (!item || !isCollapsed() || window.innerWidth <= 1024) { tip.classList.remove('is-on'); return; }
        const title = item.querySelector('.nav-title');
        const idx = item.querySelector('.nav-index');
        tip.textContent = title
          ? title.textContent.replace(idx ? idx.textContent : '', '').trim()
          : (item.getAttribute('aria-label') || '');
        const r = item.getBoundingClientRect();
        tip.style.transform = `translate(${Math.round(r.right + 12)}px, ${Math.round(r.top + r.height / 2)}px) translateY(-50%)`;
        tip.classList.add('is-on');
      });
      sidebar.addEventListener('pointerleave', () => tip.classList.remove('is-on'));
    }
    window.addEventListener('resize', moveIndicator);

    return { set, toggle() { set(!isCollapsed()); }, isCollapsed, moveIndicator };
  })();

  // ===========================================================================
  // 视图头图（Hero）：模块序号 + 逐字浮现的标题
  // ===========================================================================
  const VIEW_ORDER = ['view-overview', 'view-term-premium', 'view-options', 'view-block-trades', 'view-ssro', 'view-coinbase-liquidity', 'view-gold-correlation', 'view-wave-radar'];
  const VIEW_KICKERS = {
    'view-overview': 'Macro · Liquidity · Breadth',
    'view-term-premium': 'Basis · Term Structure · Carry',
    'view-options': 'Volatility · Gamma · Skew',
    'view-block-trades': 'Block Flow · Icebergs',
    'view-ssro': 'Stablecoin Supply Ratio',
    'view-coinbase-liquidity': 'Order Book · Depth · Slippage',
    'view-gold-correlation': 'Gold × Bitcoin',
    'view-wave-radar': 'Elliott Wave · Multi-degree',
    'view-all': 'All Modules · Panorama'
  };
  const Hero = (function () {
    const elIndex = document.getElementById('atl-hero-index');
    const elKicker = document.getElementById('atl-hero-kicker');
    const elTitle = document.getElementById('atl-hero-title');
    const elDesc = document.getElementById('atl-hero-desc');

    function viewTitle(viewId) {
      try {
        if (typeof VIEW_TITLES !== 'undefined' && VIEW_TITLES[viewId]) return VIEW_TITLES[viewId];
      } catch (e) {}
      const t = document.querySelector(`.sidebar-nav-item[data-view="${viewId}"] .nav-title`);
      return t ? t.textContent.replace(/^\s*\S+\//, '').trim() : '';
    }
    function viewDesc(viewId) {
      const d = document.querySelector(`.sidebar-nav-item[data-view="${viewId}"] .nav-desc`);
      return d ? d.textContent.trim() : '';
    }
    function render(viewId) {
      if (!elTitle) return;
      const idx = VIEW_ORDER.indexOf(viewId);
      if (elIndex) elIndex.textContent = idx >= 0 ? `${String(idx + 1).padStart(2, '0')} / ${String(VIEW_ORDER.length).padStart(2, '0')}` : 'ALL';
      if (elKicker) elKicker.textContent = VIEW_KICKERS[viewId] || '';
      const title = viewTitle(viewId);
      elTitle.setAttribute('aria-label', title);
      elTitle.innerHTML = Array.from(title).map((ch, i) =>
        `<span class="atl-ch" aria-hidden="true" style="--d:${Math.min(i, 24) * 26}ms">${ch === ' ' ? '&nbsp;' : esc(ch)}</span>`
      ).join('');
      if (elDesc) {
        elDesc.textContent = viewDesc(viewId);
        elDesc.classList.remove('atl-fade-in');
        void elDesc.offsetWidth;
        elDesc.classList.add('atl-fade-in');
      }
    }
    return { render };
  })();

  // ===========================================================================
  // 入场编排：卡片与指标瓷砖错峰升起
  // ===========================================================================
  const TILE_SELECTOR = '.macro-metric-card, .metric-pill-box, .tp-subcard, .cdri-comp-card, .el-kpi, .cluster-card';
  function playEntrance(viewId) {
    if (prefersReducedMotion) return;
    const panels = viewId === 'view-all'
      ? Array.from(document.querySelectorAll('.view-panel'))
      : [document.getElementById(viewId)].filter(Boolean);
    let n = 0;
    panels.forEach(panel => {
      panel.querySelectorAll('.bento-card').forEach(card => {
        if (card.parentElement && card.parentElement.closest('.bento-card')) return; // 只编排顶层卡片
        if (n > 8) return;
        animateOnce(card, 'atl-rise', n++ * 80);
      });
      panel.querySelectorAll(TILE_SELECTOR).forEach((tile, i) => {
        if (i > 18) return;
        animateOnce(tile, 'atl-tile-in', 160 + i * 32);
      });
    });
  }
  function animateOnce(el, cls, delay) {
    el.classList.remove(cls);
    el.style.setProperty('--atl-delay', `${delay}ms`);
    void el.offsetWidth;
    el.classList.add(cls);
    const done = () => {
      el.classList.remove(cls);
      el.style.removeProperty('--atl-delay');
      el.removeEventListener('animationend', done);
    };
    el.addEventListener('animationend', done);
  }

  let activeViewId = 'view-overview';
  document.addEventListener('bigdy:viewchange', (e) => {
    activeViewId = (e.detail && e.detail.viewId) || 'view-overview';
    Hero.render(activeViewId);
    requestAnimationFrame(() => Rail.moveIndicator());
    if (!root.classList.contains('atl-booting')) playEntrance(activeViewId);
  });

  // ===========================================================================
  // 卡片聚光：边框随指针点亮
  // ===========================================================================
  if (!prefersReducedMotion) {
    let spotCard = null;
    document.addEventListener('pointermove', (e) => {
      const card = e.target.closest && e.target.closest('.bento-card');
      if (spotCard && spotCard !== card) spotCard.classList.remove('atl-lit');
      spotCard = card;
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - r.left}px`);
      card.style.setProperty('--my', `${e.clientY - r.top}px`);
      card.classList.add('atl-lit');
    }, { passive: true });
    document.addEventListener('pointerleave', () => {
      if (spotCard) spotCard.classList.remove('atl-lit');
    });
  }

  // 顶栏滚动后浮起玻璃底
  const header = document.querySelector('.app-header');
  if (header) {
    const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 8);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // ===========================================================================
  // 命令面板 ⌘K / Ctrl+K
  // ===========================================================================
  const Palette = (function () {
    const el = document.createElement('div');
    el.className = 'atl-palette';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `
      <div class="atl-palette-backdrop" data-close></div>
      <div class="atl-palette-box" role="dialog" aria-modal="true" aria-label="命令面板">
        <div class="atl-palette-input">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" placeholder="跳转模块、更换画作、执行命令…" aria-label="搜索命令" autocomplete="off" spellcheck="false">
          <kbd>Esc</kbd>
        </div>
        <div class="atl-palette-list" role="listbox"></div>
      </div>`;
    document.body.appendChild(el);
    const input = el.querySelector('input');
    const list = el.querySelector('.atl-palette-list');
    let items = [];
    let filtered = [];
    let cursor = 0;

    function buildItems() {
      const views = Array.from(document.querySelectorAll('#app-sidebar .sidebar-nav-item[data-view]')).map(btn => {
        const idx = btn.querySelector('.nav-index');
        const title = btn.querySelector('.nav-title');
        const desc = btn.querySelector('.nav-desc');
        return {
          group: '模块',
          label: title ? title.textContent.replace(idx ? idx.textContent : '', '').trim() : btn.dataset.view,
          hint: desc ? desc.textContent.trim() : '',
          badge: idx ? idx.textContent.replace('/', '') : '',
          run: () => { if (typeof window.switchView === 'function') window.switchView(btn.dataset.view); }
        };
      });
      const arts = PAINTINGS.map((p, i) => ({
        group: '画作',
        label: `${p.title}`,
        hint: `${p.artistEn} · ${p.year} · ${p.concept}`,
        badge: String(i + 1).padStart(2, '0'),
        keywords: `${p.original} ${p.artist} ${p.conceptOrig} ${p.thinker}`,
        run: () => commitPainting(p.id)
      }));
      const actions = [
        { group: '命令', label: '打开画廊', hint: '浏览全部背景画作与其思想注解', badge: 'G', run: () => Gallery.open() },
        { group: '命令', label: '观画模式', hint: '隐去界面，只看画', badge: 'V', run: () => Contemplate.enter() },
        { group: '命令', label: '切换日间 / 夜间', hint: 'Alt + T', badge: '◐', run: () => { if (typeof window.toggleTheme === 'function') window.toggleTheme(); } },
        { group: '命令', label: '实时同步数据', hint: '重新校验全部数据源', badge: '↻', run: () => { const b = document.getElementById('btn-refresh'); if (b) b.click(); } },
        { group: '命令', label: '收起 / 展开侧栏', hint: '快捷键 [', badge: '[', run: () => Rail.toggle() },
        { group: '命令', label: '重播开场', hint: '再看一次开场动画', badge: '▶', run: () => runSplash({ replay: true }) }
      ];
      return [...views, ...arts, ...actions];
    }

    function render() {
      const q = input.value.trim().toLowerCase();
      filtered = items.filter(it => !q || `${it.label} ${it.hint} ${it.keywords || ''} ${it.group}`.toLowerCase().includes(q));
      if (cursor >= filtered.length) cursor = Math.max(0, filtered.length - 1);
      let lastGroup = '';
      list.innerHTML = filtered.length ? filtered.map((it, i) => {
        const head = it.group !== lastGroup ? `<div class="atl-palette-group">${esc(it.group)}</div>` : '';
        lastGroup = it.group;
        return `${head}<div class="atl-palette-item${i === cursor ? ' is-active' : ''}" role="option" data-i="${i}" aria-selected="${i === cursor}">
          <span class="atl-palette-badge">${esc(it.badge)}</span>
          <span class="atl-palette-label">${esc(it.label)}</span>
          <span class="atl-palette-hint">${esc(it.hint)}</span>
        </div>`;
      }).join('') : '<div class="atl-palette-empty">没有匹配项</div>';
      const act = list.querySelector('.is-active');
      if (act) act.scrollIntoView({ block: 'nearest' });
    }
    function isOpen() { return el.classList.contains('is-open'); }
    function open() {
      items = buildItems();
      cursor = 0;
      input.value = '';
      render();
      el.classList.add('is-open');
      el.setAttribute('aria-hidden', 'false');
      setTimeout(() => input.focus(), 30);
    }
    function close() {
      el.classList.remove('is-open');
      el.setAttribute('aria-hidden', 'true');
    }
    function runAt(i) {
      const it = filtered[i];
      if (!it) return;
      close();
      setTimeout(() => it.run(), 120);
    }
    input.addEventListener('input', () => { cursor = 0; render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); cursor = Math.min(filtered.length - 1, cursor + 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); cursor = Math.max(0, cursor - 1); render(); }
      else if (e.key === 'Enter') { e.preventDefault(); runAt(cursor); }
    });
    list.addEventListener('click', (e) => {
      const row = e.target.closest('.atl-palette-item');
      if (row) runAt(Number(row.dataset.i));
    });
    list.addEventListener('pointermove', (e) => {
      const row = e.target.closest('.atl-palette-item');
      if (!row) return;
      const i = Number(row.dataset.i);
      if (i !== cursor) {
        cursor = i;
        list.querySelectorAll('.atl-palette-item').forEach(r => {
          const on = Number(r.dataset.i) === cursor;
          r.classList.toggle('is-active', on);
          r.setAttribute('aria-selected', on);
        });
      }
    });
    el.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
    return { open, close, isOpen, toggle() { isOpen() ? close() : open(); } };
  })();

  // ---------------------------------------------------------------------------
  // 全局按键 & 入口按钮
  // ---------------------------------------------------------------------------
  function isTyping(e) {
    const t = e.target;
    return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  }
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      Palette.toggle();
      return;
    }
    if (e.key === 'Escape') {
      if (Palette.isOpen()) { Palette.close(); return; }
      if (Gallery.isOpen()) { Gallery.close(); return; }
      if (Contemplate.isOn()) { Contemplate.exit(); return; }
    }
    if (Contemplate.isOn() && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      Contemplate.step(e.key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '[') { Rail.toggle(); }
  });

  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-atl]');
    if (!trigger) return;
    const action = trigger.dataset.atl;
    if (action === 'gallery') Gallery.open();
    else if (action === 'contemplate') Contemplate.enter();
    else if (action === 'palette') Palette.open();
  });

  // ===========================================================================
  // 启动画面：首屏数据同步期间展示画作与题词，就绪后退场并编排入场
  // ===========================================================================
  const splashEl = document.getElementById('atl-splash');
  const splashTemplate = splashEl ? splashEl.outerHTML : '';

  /**
   * 运行启动画面。首访时等首屏数据就绪；重播时数据已在，展示片刻即退场。
   * @param {{replay?: boolean, hold?: boolean}} opts hold 为 true 时不自动退场（调试 / 截图）
   */
  function runSplash(opts = {}) {
    let splash = document.getElementById('atl-splash');
    if (opts.replay) {
      if (splash || !splashTemplate) return;
      document.body.insertAdjacentHTML('afterbegin', splashTemplate);
      splash = document.getElementById('atl-splash');
      root.classList.add('atl-booting');
    }
    if (!root.classList.contains('atl-booting') || !splash) {
      if (splash) splash.remove();
      return;
    }
    const rays = splash.querySelector('.atl-rays');
    if (rays) {
      const lines = [];
      for (let i = 0; i < 72; i++) {
        const a = (i / 72) * Math.PI * 2;
        const r0 = 46;
        const r1 = 70 + ((i * 37) % 11) * 9 + (i % 2 ? 0 : 26);
        lines.push(`<line x1="${(160 + Math.cos(a) * r0).toFixed(1)}" y1="${(160 + Math.sin(a) * r0).toFixed(1)}" x2="${(160 + Math.cos(a) * r1).toFixed(1)}" y2="${(160 + Math.sin(a) * r1).toFixed(1)}"/>`);
      }
      rays.innerHTML = `<svg viewBox="0 0 320 320" aria-hidden="true"><defs><radialGradient id="atl-ray-fade" cx="50%" cy="50%" r="50%"><stop offset="20%" stop-color="#fff" stop-opacity="0.9"/><stop offset="100%" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><g stroke="url(#atl-ray-fade)" stroke-width="1" stroke-linecap="round">${lines.join('')}</g></svg>`;
    }

    const refreshBtn = document.getElementById('btn-refresh');
    const enterBtn = splash.querySelector('#atl-enter');
    const started = performance.now();
    const observers = [];
    let ready = false;
    let left = false;

    function markReady() {
      if (ready || left) return;
      ready = true;
      splash.classList.add('is-ready');
      if (enterBtn) enterBtn.disabled = false;
      if (opts.hold) return;
      const wait = Math.max(0, 1500 - (performance.now() - started));
      setTimeout(leave, wait + 700);
    }

    if (opts.replay) {
      setTimeout(markReady, 900);
    } else {
      if (refreshBtn) {
        let sawLoading = refreshBtn.classList.contains('loading');
        const mo = new MutationObserver(() => {
          if (refreshBtn.classList.contains('loading')) sawLoading = true;
          else if (sawLoading) markReady();
        });
        mo.observe(refreshBtn, { attributes: true, attributeFilter: ['class'] });
        observers.push(mo);
      }
      setTimeout(markReady, 7000); // 数据源迟迟不回也不把人挡在门外
    }

    function onKey(e) {
      if (e.key === 'Enter' || e.key === 'Escape' || e.key === ' ') leave();
    }

    function leave() {
      if (left) return;
      left = true;
      observers.forEach(mo => mo.disconnect());
      window.removeEventListener('keydown', onKey);
      sessionStore.set('atelier_intro_seen', '1');
      splash.classList.add('is-leaving');
      root.classList.add('atl-entering');
      root.classList.remove('atl-booting');
      Hero.render(activeViewId);
      playEntrance(activeViewId);
      requestAnimationFrame(() => {
        Rail.moveIndicator();
        window.dispatchEvent(new Event('resize'));
      });
      setTimeout(() => {
        splash.remove();
        root.classList.remove('atl-entering');
      }, 1300);
    }
    splash.addEventListener('click', leave);
    window.addEventListener('keydown', onKey);
  }
  runSplash();

  // ===========================================================================
  // 启动
  // ===========================================================================
  Stage.show(currentPainting());
  renderCaption();
  Gallery.syncCurrent();

  window.Atelier = {
    paintings: PAINTINGS,
    setPainting: (id) => commitPainting(id),
    openGallery: () => Gallery.open(),
    contemplate: () => Contemplate.enter(),
    replayIntro: (opts) => runSplash(Object.assign({}, opts, { replay: true }))
  };
})();
