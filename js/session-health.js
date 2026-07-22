// Biblioteca session-health module — renders the static config/plugin
// snapshot produced by rescan.py. Diagnostic only, not a live process monitor.
(function () {
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function renderHooks(health) {
    if (!health.hooksConfigured) {
      return `<div class="health-note">No hooks configured in settings.json / settings.local.json.</div>`;
    }
    const rows = Object.keys(health.hooks).map((event) => {
      const count = Array.isArray(health.hooks[event]) ? health.hooks[event].length : 1;
      return `<div class="health-row"><span class="sdot sdot-g"></span><span class="h-name">${escapeHtml(event)}</span><span class="h-meta">${count} matcher${count === 1 ? '' : 's'}</span></div>`;
    }).join('');
    return rows || `<div class="health-note">No hooks configured.</div>`;
  }

  function renderPlugins(health) {
    if (!health.plugins.length) {
      return `<div class="health-note">No plugins installed.</div>`;
    }
    return health.plugins.map((p) => {
      const dot = p.enabled ? 'sdot-g' : 'sdot-r';
      const state = p.enabled ? '' : 'DISABLED · ';
      return `<div class="health-row"><span class="sdot ${dot}"></span><span class="h-name">${escapeHtml(p.name)}</span><span class="h-meta">${state}${escapeHtml(p.marketplace)} · v${escapeHtml(p.version)}</span></div>`;
    }).join('');
  }

  function renderBackgroundWorker(health) {
    const bw = health.backgroundWorker;
    if (!bw.detected) {
      return `<div class="health-note">${escapeHtml(bw.note)}</div>`;
    }
    return `
      <div class="health-row"><span class="sdot sdot-a"></span><span class="h-name">${escapeHtml(bw.pluginName)}</span><span class="h-meta">BACKGROUND WORKER</span></div>
      <div class="health-note">${escapeHtml(bw.note)}</div>
      <div class="repair-cmd">${escapeHtml(bw.repairCommand)}</div>
      ${bw.docsUrl ? `<div class="health-note" style="margin-top:5px">${escapeHtml(bw.docsUrl)}</div>` : ''}
    `;
  }

  function renderSafeExit(health) {
    return `<ul class="safe-exit-list">${health.safeExit.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`;
  }

  function renderCodexPlugins(codex) {
    if (!codex.plugins.length) {
      return `<div class="health-note">No plugins configured in config.toml.</div>`;
    }
    return codex.plugins.map((p) => {
      const dot = p.enabled ? 'sdot-g' : 'sdot-r';
      const state = p.enabled ? '' : 'DISABLED · ';
      return `<div class="health-row"><span class="sdot ${dot}"></span><span class="h-name">${escapeHtml(p.name)}</span><span class="h-meta">${state}${escapeHtml(p.marketplace)}</span></div>`;
    }).join('');
  }

  function renderCodexMcp(codex) {
    if (!codex.mcpServers.length) return `<div class="health-note">No global MCP servers configured.</div>`;
    return `<div class="health-note">${codex.mcpServers.map(escapeHtml).join(', ')}</div>`;
  }

  function renderCodexAgents(codex) {
    if (!codex.configuredAgents.length) return `<div class="health-note">No config.toml sub-agents defined.</div>`;
    return `<div class="health-note">${codex.configuredAgents.map(escapeHtml).join(', ')}</div>`;
  }

  function renderCodex(health) {
    const codex = health.codex;
    if (!codex || !codex.available) {
      return `<div class="health-note">No ~/.codex/config.toml found on this machine -- Codex health data unavailable.</div>`;
    }
    const enabledCount = codex.plugins.filter((p) => p.enabled).length;
    return `
      <div class="health-note" style="margin-bottom:8px">${escapeHtml(codex.note)}</div>
      <div class="health-section-title" style="margin-top:2px">PLUGINS (${enabledCount}/${codex.plugins.length} ENABLED)</div>
      ${renderCodexPlugins(codex)}
      <div class="health-section-title" style="margin-top:10px">GLOBAL MCP SERVERS (${codex.mcpServers.length})</div>
      ${renderCodexMcp(codex)}
      <div class="health-section-title" style="margin-top:10px">CONFIG SUB-AGENTS (${codex.configuredAgents.length})</div>
      ${renderCodexAgents(codex)}
      ${codex.backgroundWorker.detected ? `
        <div class="health-section-title" style="margin-top:10px">BACKGROUND WORKER</div>
        <div class="health-row"><span class="sdot sdot-a"></span><span class="h-name">${escapeHtml(codex.backgroundWorker.pluginName)}</span></div>
        <div class="repair-cmd">${escapeHtml(codex.backgroundWorker.repairCommand)}</div>
      ` : ''}
    `;
  }

  async function loadHealth() {
    const body = document.getElementById('health-body');
    const meta = document.getElementById('health-meta');
    let health;
    try {
      const res = await fetch('data/session-health.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      health = await res.json();
    } catch (err) {
      body.innerHTML = `<div class="health-note">Failed to load data/session-health.json — run rescan.py first.</div>`;
      console.error('Biblioteca: failed to load session health', err);
      return;
    }

    meta.textContent = new Date(health.generatedAt).toLocaleString();

    body.innerHTML = `
      <div class="health-section">
        <div class="health-section-title">HOOKS <span class="health-origin-tag">CLAUDE CODE</span></div>
        ${renderHooks(health)}
      </div>
      <div class="health-section">
        <div class="health-section-title">PLUGINS (${health.plugins.filter((p) => p.enabled).length}/${health.plugins.length} ENABLED) <span class="health-origin-tag">CLAUDE CODE</span></div>
        ${renderPlugins(health)}
      </div>
      <div class="health-section">
        <div class="health-section-title">BACKGROUND WORKER <span class="health-origin-tag">CLAUDE CODE</span></div>
        ${renderBackgroundWorker(health)}
      </div>
      <div class="health-section">
        <div class="health-section-title">CODEX <span class="health-origin-tag health-origin-tag-codex">CODEX</span></div>
        ${renderCodex(health)}
      </div>
      <div class="health-section">
        <div class="health-section-title">SAFE EXIT</div>
        ${renderSafeExit(health)}
      </div>
    `;
  }

  document.addEventListener('DOMContentLoaded', loadHealth);
})();
