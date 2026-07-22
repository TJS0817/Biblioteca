// Biblioteca task-recommender module — calls the Groq API to rank the
// best-matching skill/tool for a described task, then highlights it on the graph.
(function () {
  const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
  const GROQ_MODEL = 'llama-3.1-8b-instant';
  const SHORTLIST_SIZE = 25;
  const DESC_TRUNCATE = 220;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function getApiKey() {
    return window.BIBLIOTECA_CONFIG && window.BIBLIOTECA_CONFIG.groqApiKey;
  }

  function setStatus(text, isError) {
    const el = document.getElementById('task-status');
    el.textContent = text;
    el.className = isError ? 'err' : '';
  }

  // The full catalog can run into the hundreds of entries (skills + agents +
  // commands across every installed plugin) — sending all of it to Groq on
  // every request risks blowing token/rate limits on the free tier. Shortlist
  // by keyword/category/name overlap first, then let Groq make the final call
  // among a manageable candidate set.
  function shortlist(task, index, limit) {
    const q = task.toLowerCase();
    const qWords = new Set(q.match(/[a-z']+/g) || []);
    const scored = index.map((entry) => {
      let score = 0;
      const desc = (entry.description || '').toLowerCase();
      const name = entry.name.toLowerCase();
      if (q.includes(name)) score += 4;
      if (desc && q.includes(desc)) score += 3;
      for (const kw of (entry.keywords || [])) {
        if (q.includes(kw)) score += 2;
        if (qWords.has(kw)) score += 2;
      }
      if (entry.category && qWords.has(entry.category.replace(/-/g, ' '))) score += 1;
      return { entry, score };
    });
    scored.sort((a, b) => b.score - a.score);
    const withSignal = scored.filter((s) => s.score > 0);
    const chosen = (withSignal.length >= 5 ? withSignal : scored).slice(0, limit);
    return chosen.map((s) => s.entry);
  }

  function buildPrompt(task, candidates) {
    const catalog = candidates.map((e) => ({
      id: e.id,
      name: e.name,
      description: (e.description || '').slice(0, DESC_TRUNCATE),
      category: e.category,
      origin: e.origin,
    }));
    const system = 'You are a routing assistant for Biblioteca, a local unified skills/tools library covering ' +
      'BOTH Claude Code and Codex. Given a task description and a shortlisted catalog of candidate skills/tools ' +
      'drawn from both tools, pick the single best match regardless of which tool it comes from -- rank purely ' +
      'on fit for the task. Each candidate has an "origin" field, either "claude-code" or "codex", naming which ' +
      'CLI provides it. Explicitly name that origin in your reasoning (e.g. "This is a Codex skill that..."). ' +
      'Respond with ONLY a JSON object, no prose, no markdown fences, in this exact shape: ' +
      '{"id": "<catalog id>", "reasoning": "<one or two sentence explanation that names the origin>"}.';
    const user = `Task: ${task}\n\nCatalog:\n${JSON.stringify(catalog)}`;
    return { system, user };
  }

  function parseResponse(raw, index) {
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch (e2) { /* fall through */ }
      }
    }
    if (parsed && parsed.id) {
      const entry = index.find((e) => e.id === parsed.id);
      if (entry) return { entry, reasoning: parsed.reasoning || '' };
    }
    // Fallback: scan raw text for a catalog entry name.
    const byNameHit = index.find((e) => raw.toLowerCase().includes(e.name.toLowerCase()));
    if (byNameHit) return { entry: byNameHit, reasoning: raw.trim() };
    return null;
  }

  async function onSubmit() {
    const taskInput = document.getElementById('task-input');
    const task = taskInput.value.trim();
    const reasoningBox = document.getElementById('reasoning-box');
    if (!task) {
      setStatus('Enter a task description first.', true);
      return;
    }

    const apiKey = getApiKey();
    if (!apiKey) {
      setStatus('Add config.local.js — see config.example.js', true);
      return;
    }

    const index = (window.BibliotecaGraph && window.BibliotecaGraph.getIndex()) || [];
    if (!index.length) {
      setStatus('No index loaded — run rescan.py first.', true);
      return;
    }

    const submitBtn = document.getElementById('task-submit');
    submitBtn.disabled = true;
    reasoningBox.style.display = 'none';

    const candidates = shortlist(task, index, SHORTLIST_SIZE);
    setStatus(`Asking Groq… (shortlisted ${candidates.length}/${index.length} candidates)`, false);

    const { system, user } = buildPrompt(task, candidates);

    try {
      const res = await fetch(GROQ_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.2,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }

      const data = await res.json();
      const raw = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!raw) throw new Error('Empty response from Groq');

      const result = parseResponse(raw, index);
      if (!result) {
        setStatus('Could not parse a match from the model response.', true);
        console.warn('Biblioteca: unparsed Groq response', raw);
        return;
      }

      setStatus('Match found.', false);
      reasoningBox.style.display = 'block';
      const originLabel = result.entry.origin === 'codex' ? 'CODEX' : 'CLAUDE CODE';
      reasoningBox.innerHTML = `<span class="r-name">${escapeHtml(result.entry.name)}</span>` +
        `<span class="r-origin r-origin-${result.entry.origin}">${originLabel}</span>` +
        `${escapeHtml(result.reasoning || '')}`;
      if (window.BibliotecaGraph) window.BibliotecaGraph.highlightNode(result.entry.id);
    } catch (err) {
      setStatus(`Error: ${err.message}`, true);
      console.error('Biblioteca: Groq request failed', err);
    } finally {
      submitBtn.disabled = false;
    }
  }

  function initGroqStatus() {
    const el = document.getElementById('hdr-groq-status');
    el.textContent = getApiKey() ? 'READY' : 'NO KEY';
  }

  document.addEventListener('DOMContentLoaded', () => {
    initGroqStatus();
    const submitBtn = document.getElementById('task-submit');
    if (!getApiKey()) {
      submitBtn.disabled = true;
      setStatus('Add config.local.js — see config.example.js', true);
    }
    submitBtn.addEventListener('click', onSubmit);
    document.getElementById('task-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onSubmit();
    });
  });
})();
