// Biblioteca graph module — loads the skills index, builds a vis-network
// graph (nodes = skills/agents/commands/plugins/mcp-tools, edges = shared
// category, overlapping trigger keywords, or common owning plugin), and
// exposes filter/highlight controls.
(function () {
  const CATEGORY_COLORS = {
    'code-review': '#8b7cf8',
    'code-quality': '#3E9EF5',
    'git-vcs': '#1D9E75',
    'feature-dev': '#E29A4B',
    'docs-lookup': '#4BC9E2',
    'browser-testing': '#E24B9E',
    'project-memory': '#9E4BE2',
    'knowledge-graph': '#4BE2A0',
    'security': '#E24B4A',
    'testing-tdd': '#C9E24B',
    'agent-orchestration': '#F5A623',
    'ui-design': '#F06CA8',
    'frontend-web': '#5AC8FA',
    'mobile-native': '#4ADE80',
    'languages-python': '#3776AB',
    'languages-jvm': '#E76F51',
    'languages-systems': '#DE935F',
    'languages-dotnet': '#8A63D2',
    'languages-web-backend': '#B45AF2',
    'database-storage': '#2DD4BF',
    'devops-infra': '#38BDF8',
    'network-infra': '#818CF8',
    'healthcare': '#F87171',
    'finance-trading': '#FBBF24',
    'marketing-content': '#FB7185',
    'video-media': '#C084FC',
    'ml-data': '#34D399',
    'research-analysis': '#60A5FA',
    'productivity-ops': '#A3E635',
    'performance': '#F472B6',
    'uncategorized': 'rgba(175,169,236,0.55)',
  };
  // Anything not in the hand-tuned map above (new taxonomy categories added
  // later, or a rescan bringing in a brand-new cluster) still gets a stable,
  // distinct color instead of falling through to a maintenance chore.
  function hashColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
    return `hsl(${hash % 360}, 62%, 62%)`;
  }
  function categoryColor(cat) {
    if (CATEGORY_COLORS[cat]) return CATEGORY_COLORS[cat];
    if (!cat || cat === 'uncategorized') return CATEGORY_COLORS.uncategorized;
    return hashColor(cat);
  }

  const SOURCE_SHAPE = { skill: 'star', plugin: 'dot', 'mcp-tool': 'diamond', agent: 'triangle', command: 'square' };
  const SOURCE_LABEL = { skill: 'SKILL', agent: 'AGENT', command: 'CMD', plugin: 'PLUGIN', 'mcp-tool': 'MCP' };
  const SOURCE_ORDER = ['skill', 'agent', 'command', 'plugin', 'mcp-tool'];
  const MAX_EDGES_PER_NODE = 6;

  let network = null;
  let nodesDataSet = null;
  let edgesDataSet = null;
  let indexData = [];

  // Combined filter state — text query, active source types, selected plugin.
  const filterState = {
    text: '',
    sources: new Set(SOURCE_ORDER),
    plugin: '',
  };

  function nodeSize(e) {
    return e.source === 'plugin' ? 16 : 12;
  }

  function buildNodesEdges(index) {
    const nodes = index.map((e) => ({
      id: e.id,
      label: e.name,
      title: `${e.description}\n\n[${e.source}] category: ${e.category}${e.plugin ? `\nplugin: ${e.plugin}` : ''}`,
      shape: SOURCE_SHAPE[e.source] || 'dot',
      color: {
        background: categoryColor(e.category),
        border: 'rgba(139,124,248,0.36)',
        highlight: { background: categoryColor(e.category), border: '#8b7cf8' },
      },
      font: { color: '#CECBF6', size: 11, face: 'JetBrains Mono' },
      size: nodeSize(e),
    }));

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
        if (score > 0) pairScores.push({ a: a.id, b: b.id, score });
      }
    }

    const perNodeCount = {};
    pairScores.sort((x, y) => y.score - x.score);
    const edges = [];
    for (const p of pairScores) {
      perNodeCount[p.a] = perNodeCount[p.a] || 0;
      perNodeCount[p.b] = perNodeCount[p.b] || 0;
      if (perNodeCount[p.a] >= MAX_EDGES_PER_NODE || perNodeCount[p.b] >= MAX_EDGES_PER_NODE) continue;
      perNodeCount[p.a]++;
      perNodeCount[p.b]++;
      edges.push({
        from: p.a,
        to: p.b,
        color: { color: 'rgba(139,124,248,0.18)', highlight: '#8b7cf8' },
        width: Math.min(1 + p.score * 0.4, 3),
      });
    }

    return { nodes, edges };
  }

  function renderGraph(nodes, edges) {
    const container = document.getElementById('graph-canvas');
    nodesDataSet = new vis.DataSet(nodes);
    edgesDataSet = new vis.DataSet(edges);
    network = new vis.Network(container, { nodes: nodesDataSet, edges: edgesDataSet }, {
      physics: {
        solver: 'barnesHut',
        barnesHut: { gravitationalConstant: -2200, springLength: 100, springConstant: 0.03, avoidOverlap: 0.2 },
        stabilization: { iterations: 150 },
        adaptiveTimestep: true,
      },
      interaction: { hover: true, tooltipDelay: 120 },
      layout: { improvedLayout: false },
      nodes: { borderWidth: 1.5 },
      edges: { smooth: { type: 'continuous' } },
    });
    // A graph this size only needs physics during initial layout — freezing
    // it afterward keeps panning/zooming/hovering responsive.
    network.once('stabilizationIterationsDone', () => {
      network.setOptions({ physics: false });
    });
  }

  function buildMetaText(index, visibleCount) {
    const counts = {};
    for (const e of index) counts[e.source] = (counts[e.source] || 0) + 1;
    const parts = SOURCE_ORDER.filter((k) => counts[k]).map((k) => `${counts[k]} ${SOURCE_LABEL[k]}`);
    const total = index.length;
    const shownSuffix = visibleCount !== total ? ` · ${visibleCount} SHOWN` : '';
    return parts.join(' · ') + shownSuffix;
  }

  function nodeHidden(e) {
    if (!filterState.sources.has(e.source)) return true;
    if (filterState.plugin && (e.plugin || '') !== filterState.plugin) return true;
    const q = filterState.text.trim().toLowerCase();
    if (!q) return false;
    const matches = e.name.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.category.toLowerCase().includes(q) ||
      (e.keywords || []).some((k) => k.includes(q));
    return !matches;
  }

  function applyFilters() {
    if (!nodesDataSet) return;
    const updates = indexData.map((e) => ({ id: e.id, hidden: nodeHidden(e) }));
    nodesDataSet.update(updates);
    const visibleCount = updates.filter((u) => !u.hidden).length;
    document.getElementById('graph-meta').textContent = buildMetaText(indexData, visibleCount);
  }

  function populatePluginFilter(index) {
    const sel = document.getElementById('plugin-filter');
    if (!sel) return;
    const plugins = Array.from(new Set(index.map((e) => e.plugin).filter(Boolean))).sort();
    for (const p of plugins) {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p.toUpperCase();
      sel.appendChild(opt);
    }
  }

  function wireControls() {
    const filterBox = document.getElementById('filter-box');
    if (filterBox) {
      filterBox.addEventListener('input', (e) => {
        filterState.text = e.target.value;
        applyFilters();
      });
    }
    const pluginSel = document.getElementById('plugin-filter');
    if (pluginSel) {
      pluginSel.addEventListener('change', (e) => {
        filterState.plugin = e.target.value;
        applyFilters();
      });
    }
    document.querySelectorAll('#source-filter input[type=checkbox]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const src = cb.dataset.source;
        if (cb.checked) filterState.sources.add(src);
        else filterState.sources.delete(src);
        applyFilters();
      });
    });
  }

  function highlightNode(nodeId) {
    if (!nodesDataSet || !network) return;
    const updates = indexData.map((e) => ({
      id: e.id,
      opacity: e.id === nodeId ? 1 : 0.25,
      borderWidth: e.id === nodeId ? 4 : 1.5,
      size: e.id === nodeId ? nodeSize(e) + 10 : nodeSize(e),
    }));
    nodesDataSet.update(updates);
    network.selectNodes([nodeId]);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    network.focus(nodeId, {
      scale: 1.6,
      animation: reducedMotion ? false : { duration: 500, easingFunction: 'easeInOutQuad' },
    });
  }

  function resetHighlight() {
    if (!nodesDataSet) return;
    const updates = indexData.map((e) => ({
      id: e.id, opacity: 1, borderWidth: 1.5, size: nodeSize(e),
    }));
    nodesDataSet.update(updates);
  }

  async function loadIndex() {
    const statusEl = document.getElementById('hdr-index-status');
    try {
      const res = await fetch('data/skills-index.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      indexData = await res.json();
    } catch (err) {
      statusEl.textContent = 'ERROR';
      document.getElementById('graph-empty').style.display = 'flex';
      document.getElementById('graph-empty').textContent = 'Failed to load data/skills-index.json — run rescan.py first.';
      console.error('Biblioteca: failed to load skills index', err);
      return;
    }

    document.getElementById('graph-meta').textContent = buildMetaText(indexData, indexData.length);
    statusEl.textContent = indexData.length ? 'READY' : 'EMPTY';

    if (!indexData.length) {
      document.getElementById('graph-empty').style.display = 'flex';
      return;
    }

    const { nodes, edges } = buildNodesEdges(indexData);
    renderGraph(nodes, edges);
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
