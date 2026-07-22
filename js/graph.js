// Biblioteca graph module — a starfield / galaxy visualization of the skills
// index. Each skill/agent/command/plugin/MCP renders as a glowing star:
//   • colour  = source type (theme colours pulled from the Ava palette)
//   • magnitude (size + brightness) = relevance — graph centrality boosted by
//     how often the tool has been recommended (persisted in localStorage)
//   • spatial cluster = category → related stars gather into "constellations"
//     linked by faint lines, against a dark, subtly-lit deep-space backdrop.
// Built on force-graph (canvas) so the glow/bloom, twinkle and background
// scatter are cheap to draw and the physics layout falls out naturally.
(function () {
  // ── Star colour by source type — sampled from the Ava/Biblioteca palette
  // (see css :root). Cool violet for the bulk skills, cyan for agents, a warm
  // green/amber for commands & plugins, and a bright magenta accent for the
  // rare MCP tools so they pop like accent stars.
  const SOURCE_COLOR = {
    skill: '#8b7cf8',      // --acc, cool violet — the "main sequence"
    agent: '#4BC9E2',      // cool cyan
    command: '#1D9E75',    // green
    plugin: '#E29A4B',     // warm amber
    'mcp-tool': '#E24B9E', // magenta accent — rare, bright
  };
  const SOURCE_LABEL = { skill: 'SKILL', agent: 'AGENT', command: 'CMD', plugin: 'PLUGIN', 'mcp-tool': 'MCP' };
  const SOURCE_ORDER = ['skill', 'agent', 'command', 'plugin', 'mcp-tool'];

  // ── Origin (which CLI a star belongs to) is an independent visual axis from
  // source-type: type picks the star's fill/glow colour, origin picks a thin
  // outer ring colour drawn on top — so both are legible at a glance.
  const ORIGIN_COLOR = { 'claude-code': '#B7A9FF', codex: '#33E6B8' };
  const ORIGIN_LABEL = { 'claude-code': 'CLAUDE CODE', codex: 'CODEX' };
  const ORIGIN_ORDER = ['claude-code', 'codex'];

  const MAX_EDGES_PER_NODE = 5;
  const REC_STORAGE_KEY = 'biblioteca:recCounts';

  function sourceColor(src) { return SOURCE_COLOR[src] || '#8b7cf8'; }
  function originColor(o) { return ORIGIN_COLOR[o] || ORIGIN_COLOR['claude-code']; }

  // A stable per-category hue so constellation regions (and their linking
  // lines) read as faint colour zones behind the type-coloured stars.
  function hashHue(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
    return hash % 360;
  }

  let graph = null;
  let nodes = [];
  let links = [];
  let indexData = [];
  let hoverNode = null;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const t0 = performance.now();
  const nowSec = () => (performance.now() - t0) / 1000;

  const filterState = { text: '', sources: new Set(SOURCE_ORDER), origins: new Set(ORIGIN_ORDER), plugin: '' };

  // ── Persisted recommendation tally — recommended tools brighten over time.
  function loadRecCounts() {
    try { return JSON.parse(localStorage.getItem(REC_STORAGE_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveRecCounts(counts) {
    try { localStorage.setItem(REC_STORAGE_KEY, JSON.stringify(counts)); } catch (e) { /* private mode */ }
  }
  let recCounts = loadRecCounts();

  // ── Build stars + constellation links, and derive each star's magnitude.
  function buildGraphData(index) {
    const strength = {};
    const pairScores = [];
    for (let i = 0; i < index.length; i++) {
      for (let j = i + 1; j < index.length; j++) {
        const a = index[i], b = index[j];
        let score = 0;
        if (a.category === b.category && a.category !== 'uncategorized') score += 2;
        if (a.plugin && a.plugin === b.plugin) score += 1;
        const aKw = new Set(a.keywords || []);
        const overlap = (b.keywords || []).filter((k) => aKw.has(k)).length;
        score += overlap;
        if (score > 0) {
          pairScores.push({ a: a.id, b: b.id, score });
          strength[a.id] = (strength[a.id] || 0) + score;
          strength[b.id] = (strength[b.id] || 0) + score;
        }
      }
    }

    // Normalise centrality → base magnitude, then bump by recommendation count.
    const maxStrength = Math.max(1, ...Object.values(strength));
    nodes = index.map((e) => {
      const base = Math.pow((strength[e.id] || 0) / maxStrength, 0.5);
      const recBoost = Math.min((recCounts[e.id] || 0) * 0.18, 0.6);
      const mag = Math.max(0.08, Math.min(1, base * 0.85 + recBoost));
      return {
        id: e.id,
        entry: e,
        __src: e.source,
        __origin: e.origin,
        __cat: e.category || 'uncategorized',
        __hue: hashHue(e.category || 'uncategorized'),
        __mag: mag,
        __phase: Math.random() * Math.PI * 2, // desync the twinkle
        __shine: false,
      };
    });

    // Keep only the strongest few links per node — faint constellation lines,
    // never a dense tangled web.
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const perNode = {};
    pairScores.sort((x, y) => y.score - x.score);
    links = [];
    for (const p of pairScores) {
      perNode[p.a] = perNode[p.a] || 0;
      perNode[p.b] = perNode[p.b] || 0;
      if (perNode[p.a] >= MAX_EDGES_PER_NODE || perNode[p.b] >= MAX_EDGES_PER_NODE) continue;
      perNode[p.a]++; perNode[p.b]++;
      const na = nodeById.get(p.a), nb = nodeById.get(p.b);
      const sameCat = na.__cat === nb.__cat && na.__cat !== 'uncategorized';
      links.push({ source: p.a, target: p.b, score: p.score, __hue: sameCat ? na.__hue : null });
    }
  }

  // ── Custom force: pull each star toward its category's anchor so domains
  // gather into constellations. Anchors sit on a ring (galaxy-arm feel).
  function makeClusterForce() {
    const cats = Array.from(new Set(nodes.map((n) => n.__cat)));
    const R = 60 + cats.length * 7;
    const anchors = {};
    cats.forEach((c, i) => {
      const ang = (i / cats.length) * Math.PI * 2;
      anchors[c] = { x: Math.cos(ang) * R, y: Math.sin(ang) * R };
    });
    let arr;
    function force(alpha) {
      const k = alpha * 0.14;
      for (const n of arr) {
        const a = anchors[n.__cat];
        if (!a) continue;
        const pull = k * (0.35 + n.__mag * 0.5); // bright hubs anchor harder
        n.vx += (a.x - n.x) * pull;
        n.vy += (a.y - n.y) * pull;
      }
    }
    force.initialize = (n) => { arr = n; };
    return force;
  }

  function isHidden(n) {
    const e = n.entry;
    if (!filterState.sources.has(e.source)) return true;
    if (!filterState.origins.has(e.origin)) return true;
    if (filterState.plugin && (e.plugin || '') !== filterState.plugin) return true;
    const q = filterState.text.trim().toLowerCase();
    if (!q) return false;
    return !(
      e.name.toLowerCase().includes(q) ||
      (e.description || '').toLowerCase().includes(q) ||
      (e.category || '').toLowerCase().includes(q) ||
      (e.keywords || []).some((k) => k.includes(q))
    );
  }

  // ── Deep-space background: a light scatter of tiny, non-interactive stars,
  // drawn in screen space (fixed, ignores pan/zoom → reads as distant sky).
  let bgStars = [];
  function seedBackground(w, h) {
    const count = Math.round((w * h) / 5200);
    bgStars = [];
    for (let i = 0; i < count; i++) {
      bgStars.push({
        x: Math.random(), y: Math.random(),
        r: Math.random() * 1.1 + 0.3,
        a: Math.random() * 0.5 + 0.12,
        tw: Math.random() * 0.9 + 0.2,
        ph: Math.random() * Math.PI * 2,
      });
    }
  }
  function drawBackground(ctx) {
    const cv = ctx.canvas;
    const w = cv.width, h = cv.height;
    const ratio = window.devicePixelRatio || 1;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const time = nowSec();
    ctx.fillStyle = '#cdd6ff'; // pale blue-white
    for (const s of bgStars) {
      const tw = reducedMotion ? 1 : 0.6 + 0.4 * Math.sin(time * s.tw + s.ph);
      ctx.globalAlpha = s.a * tw;
      ctx.beginPath();
      ctx.arc(s.x * w, s.y * h, s.r * ratio, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // ── Draw one star: soft radial glow (bloom) + bright core, with twinkle,
  // hover pulse and a distinct "shine" for a recommended star.
  function drawStar(node, ctx, globalScale) {
    if (node.__hidden) return;
    if (!isFinite(node.x) || !isFinite(node.y)) return; // pre-layout frame
    const time = nowSec();
    const col = sourceColor(node.__src);
    const isHover = node === hoverNode;

    let bright = 1;
    if (!reducedMotion) bright *= 0.8 + 0.2 * Math.sin(time * 1.6 + node.__phase); // twinkle
    if (isHover) bright *= reducedMotion ? 1.35 : 1.25 + 0.25 * Math.sin(time * 5);
    if (node.__shine) bright *= reducedMotion ? 1.7 : 1.5 + 0.5 * Math.sin(time * 4);

    const core = (1.5 + node.__mag * 3.4) * (isHover || node.__shine ? 1.25 : 1);
    const glowR = core * (3.6 + node.__mag * 3.2) * (node.__shine ? 1.6 : isHover ? 1.3 : 1);

    // Bloom — additive so overlapping glows brighten like a real field.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, glowR);
    g.addColorStop(0, hexA(col, Math.min(0.9, 0.55 * bright)));
    g.addColorStop(0.4, hexA(col, Math.min(0.5, 0.22 * bright)));
    g.addColorStop(1, hexA(col, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(node.x, node.y, glowR, 0, Math.PI * 2);
    ctx.fill();

    // Diffraction spikes make the recommended star unmistakable.
    if (node.__shine) {
      ctx.strokeStyle = hexA(col, 0.5 * bright);
      ctx.lineWidth = core * 0.5;
      const len = glowR * 1.15;
      ctx.beginPath();
      ctx.moveTo(node.x - len, node.y); ctx.lineTo(node.x + len, node.y);
      ctx.moveTo(node.x, node.y - len); ctx.lineTo(node.x, node.y + len);
      ctx.stroke();
    }
    ctx.restore();

    // Bright core + hot white centre.
    ctx.beginPath();
    ctx.fillStyle = hexA(col, Math.min(1, 0.85 * bright));
    ctx.arc(node.x, node.y, core, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.fillStyle = hexA('#ffffff', Math.min(0.95, 0.6 * bright));
    ctx.arc(node.x, node.y, core * 0.42, 0, Math.PI * 2);
    ctx.fill();

    // Origin ring — a thin outline in a colour distinct from every source-type
    // fill colour, so which CLI a star belongs to reads at a glance without
    // fighting the type colour for the same pixels.
    const ringR = core * 1.7;
    ctx.beginPath();
    ctx.strokeStyle = hexA(originColor(node.__origin), Math.min(0.95, (isHover || node.__shine ? 0.8 : 0.55) * bright));
    ctx.lineWidth = Math.max(0.6, core * 0.22);
    ctx.arc(node.x, node.y, ringR, 0, Math.PI * 2);
    ctx.stroke();

    // Labels only where they won't clutter: hovered/recommended always, and
    // brighter stars once zoomed in.
    const showLabel = isHover || node.__shine || (globalScale > 2.4 && node.__mag > 0.45);
    if (showLabel) {
      const fs = Math.max(9 / globalScale, 2.2);
      ctx.font = `${fs}px 'JetBrains Mono', monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = isHover || node.__shine ? '#F1EFFF' : hexA('#CECBF6', 0.85);
      ctx.fillText(node.entry.name, node.x, node.y + glowR * 0.5 + core);
    }
  }

  function drawPointerArea(node, color, ctx) {
    if (node.__hidden) return;
    const core = 1.5 + node.__mag * 3.4;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x, node.y, Math.max(core * 1.8, 4), 0, Math.PI * 2);
    ctx.fill();
  }

  // rgba() from a #hex + alpha.
  function hexA(hex, a) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function tooltip(node) {
    const e = node.entry;
    const kw = (e.keywords || []).slice(0, 6).join(' · ');
    return `<div class="star-tip">
      <div class="st-name" style="color:${sourceColor(e.source)}">${escapeHtml(e.name)}</div>
      <div class="st-tags"><span>${SOURCE_LABEL[e.source] || e.source}</span><span class="st-origin" style="color:${originColor(e.origin)}">${ORIGIN_LABEL[e.origin] || e.origin}</span><span>${escapeHtml(e.category || 'uncategorized')}</span>${e.plugin ? `<span>${escapeHtml(e.plugin)}</span>` : ''}</div>
      <div class="st-desc">${escapeHtml((e.description || '').slice(0, 200))}</div>
      ${kw ? `<div class="st-kw">${escapeHtml(kw)}</div>` : ''}
    </div>`;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderGraph() {
    const container = document.getElementById('graph-canvas');
    graph = ForceGraph()(container)
      .backgroundColor('rgba(0,0,0,0)')
      .graphData({ nodes, links })
      .nodeId('id')
      .nodeLabel(tooltip)
      .nodeCanvasObject(drawStar)
      .nodePointerAreaPaint(drawPointerArea)
      .linkColor((l) => hexA(l.__hue != null ? hslHex(l.__hue) : '#8b7cf8', l.__hue != null ? 0.16 : 0.08))
      .linkWidth((l) => Math.min(0.4 + l.score * 0.12, 1.1))
      .linkVisibility((l) => !l.source.__hidden && !l.target.__hidden)
      .onRenderFramePre((ctx) => drawBackground(ctx))
      .onNodeHover((node) => {
        hoverNode = node && !node.__hidden ? node : null;
        container.style.cursor = hoverNode ? 'pointer' : '';
      })
      .onNodeClick((node) => {
        if (node.__hidden) return;
        graph.centerAt(node.x, node.y, reducedMotion ? 0 : 600);
        graph.zoom(Math.max(graph.zoom(), 4), reducedMotion ? 0 : 600);
      })
      .cooldownTime(4000)
      .warmupTicks(20);

    // Layout forces → constellation clustering + gentle spread.
    graph.d3Force('charge').strength(-26);
    graph.d3Force('link').distance(28).strength(0.16);
    graph.d3Force('cluster', makeClusterForce());

    sizeToContainer();
    seedBackground(graph.width(), graph.height());
    new ResizeObserver(() => { sizeToContainer(); seedBackground(graph.width(), graph.height()); })
      .observe(container);
  }

  function hslHex(h) {
    // hsl → #hex for a mid, soft cluster hue.
    const s = 0.6, l = 0.62;
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x]; else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
    const to = (v) => ('0' + Math.round((v + m) * 255).toString(16)).slice(-2);
    return `#${to(r)}${to(g)}${to(b)}`;
  }

  function sizeToContainer() {
    const container = document.getElementById('graph-canvas');
    graph.width(container.clientWidth).height(container.clientHeight);
  }

  function buildMetaText(index, visibleCount) {
    const counts = {};
    for (const e of index) counts[e.source] = (counts[e.source] || 0) + 1;
    const parts = SOURCE_ORDER.filter((k) => counts[k]).map((k) => `${counts[k]} ${SOURCE_LABEL[k]}`);
    const originCounts = {};
    for (const e of index) originCounts[e.origin] = (originCounts[e.origin] || 0) + 1;
    const originParts = ORIGIN_ORDER.filter((o) => originCounts[o]).map((o) => `${originCounts[o]} ${ORIGIN_LABEL[o]}`);
    const shownSuffix = visibleCount !== index.length ? ` · ${visibleCount} SHOWN` : '';
    return parts.join(' · ') + ' · ' + originParts.join(' · ') + shownSuffix;
  }

  function applyFilters() {
    if (!graph) return;
    let visible = 0;
    for (const n of nodes) {
      n.__hidden = isHidden(n);
      if (!n.__hidden) visible++;
    }
    document.getElementById('graph-meta').textContent = buildMetaText(indexData, visible);
  }

  function populatePluginFilter(index) {
    const sel = document.getElementById('plugin-filter');
    if (!sel) return;
    // Grouped by origin so a "github" plugin from Claude Code and a
    // same-named one from Codex don't read as a single merged entry.
    const byOrigin = {};
    for (const e of index) {
      if (!e.plugin) continue;
      (byOrigin[e.origin] = byOrigin[e.origin] || new Set()).add(e.plugin);
    }
    for (const origin of ORIGIN_ORDER) {
      const plugins = Array.from(byOrigin[origin] || []).sort();
      if (!plugins.length) continue;
      const group = document.createElement('optgroup');
      group.label = ORIGIN_LABEL[origin] || origin;
      for (const p of plugins) {
        const opt = document.createElement('option');
        opt.value = p; opt.textContent = p.toUpperCase();
        group.appendChild(opt);
      }
      sel.appendChild(group);
    }
  }

  function wireControls() {
    const filterBox = document.getElementById('filter-box');
    if (filterBox) filterBox.addEventListener('input', (e) => { filterState.text = e.target.value; applyFilters(); });
    const pluginSel = document.getElementById('plugin-filter');
    if (pluginSel) pluginSel.addEventListener('change', (e) => { filterState.plugin = e.target.value; applyFilters(); });
    document.querySelectorAll('#source-filter input[type=checkbox]').forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) filterState.sources.add(cb.dataset.source);
        else filterState.sources.delete(cb.dataset.source);
        applyFilters();
      });
    });
    document.querySelectorAll('#origin-filter input[type=checkbox]').forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) filterState.origins.add(cb.dataset.origin);
        else filterState.origins.delete(cb.dataset.origin);
        applyFilters();
      });
    });
  }

  // ── Recommendation highlight: the matched star shines, pans into view, and
  // its persisted tally ticks up so it stays a little brighter next time.
  function highlightNode(nodeId) {
    if (!graph) return;
    recCounts[nodeId] = (recCounts[nodeId] || 0) + 1;
    saveRecCounts(recCounts);
    for (const n of nodes) {
      n.__shine = n.id === nodeId;
      if (n.id === nodeId) n.__mag = Math.max(n.__mag, Math.min(1, n.__mag + 0.18));
    }
    const target = nodes.find((n) => n.id === nodeId);
    if (target && target.x != null) {
      graph.centerAt(target.x, target.y, reducedMotion ? 0 : 700);
      graph.zoom(Math.max(graph.zoom(), 3.5), reducedMotion ? 0 : 700);
    }
  }

  function resetHighlight() {
    for (const n of nodes) n.__shine = false;
  }

  async function loadIndex() {
    const statusEl = document.getElementById('hdr-index-status');
    try {
      const res = await fetch('data/skills-index.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      indexData = await res.json();
    } catch (err) {
      statusEl.textContent = 'ERROR';
      const empty = document.getElementById('graph-empty');
      empty.style.display = 'flex';
      empty.textContent = 'Failed to load data/skills-index.json — run rescan.py first.';
      console.error('Biblioteca: failed to load skills index', err);
      return;
    }

    document.getElementById('graph-meta').textContent = buildMetaText(indexData, indexData.length);
    statusEl.textContent = indexData.length ? 'READY' : 'EMPTY';
    if (!indexData.length) { document.getElementById('graph-empty').style.display = 'flex'; return; }

    buildGraphData(indexData);
    renderGraph();
    populatePluginFilter(indexData);
    wireControls();
  }

  window.BibliotecaGraph = {
    loadIndex,
    highlightNode,
    resetHighlight,
    getIndex: () => indexData,
  };

  document.addEventListener('DOMContentLoaded', loadIndex);
})();
