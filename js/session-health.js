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
        <div class="health-section-title">HOOKS</div>
        ${renderHooks(health)}
      </div>
      <div class="health-section">
        <div class="health-section-title">PLUGINS (${health.plugins.filter((p) => p.enabled).length}/${health.plugins.length} ENABLED)</div>
        ${renderPlugins(health)}
      </div>
      <div class="health-section">
        <div class="health-section-title">BACKGROUND WORKER</div>
        ${renderBackgroundWorker(health)}
      </div>
      <div class="health-section">
        <div class="health-section-title">SAFE EXIT</div>
        ${renderSafeExit(health)}
      </div>
    `;
  }

  document.addEventListener('DOMContentLoaded', loadHealth);
})();
