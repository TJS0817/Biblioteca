#!/usr/bin/env python3
"""Biblioteca rescan script.

Regenerates data/skills-index.json (skills + agents + commands + plugins +
MCP tool servers, each categorized/keyworded by a local heuristic) and
data/session-health.json (a static snapshot of hooks/plugins/background-worker
config) from the current state of ~/.claude AND ~/.codex on this machine.
No third-party dependencies (tomllib is stdlib as of Python 3.11).

Every entry is tagged with an "origin" field ("claude-code" or "codex") in
addition to its "source" field (skill/agent/command/plugin/mcp-tool) -- the
two are independent axes: origin is which CLI surfaces it, source is what
kind of thing it is. Codex-sourced entry ids are prefixed with "codex:" to
keep them unique from Claude Code ids of the same name; Claude Code ids are
left unchanged for backwards compatibility with persisted recommendation
tallies.

Claude Code scans:
  - Personal skills:      ~/.claude/skills/<name>/SKILL.md
  - Plugin skills:        <plugin install dir>/skills/<name>/SKILL.md
  - Plugin agents:        <plugin install dir>/agents/<name>.md
  - Plugin commands:      <plugin install dir>/commands/<name>.md
  - Plugins themselves:   ~/.claude/plugins/installed_plugins.json + manifests
  - MCP tool servers:     inline in plugin.json and/or a sibling .mcp.json

Codex scans (mirrors the Claude Code shapes wherever the two tools overlap):
  - Personal skills:      ~/.codex/skills/**/SKILL.md (includes skills/.system/*)
  - Personal agents:      ~/.codex/agents/<name>.md
  - Config-only agents:   ~/.codex/config.toml [agents.<name>] tables with no
                           matching agents/<name>.md (e.g. explorer, reviewer)
  - Commands (prompts):   ~/.codex/prompts/<name>.md (no frontmatter -- a
                           heading + a "Source:" line + body; description is
                           mined from the first paragraph of body text)
  - Plugins:              ~/.codex/config.toml [plugins."<name>@<marketplace>"]
                           + ~/.codex/plugins/cache/<marketplace>/<name>/*/.codex-plugin/plugin.json
  - Plugin skills/agents/commands/MCP: same sub-layout as Claude Code plugins,
                           just under a ".codex-plugin" manifest dir instead
                           of ".claude-plugin"
  - Global MCP servers:   ~/.codex/config.toml [mcp_servers.<name>] (not tied
                           to any single plugin)
"""
import json
import re
import tomllib
from datetime import datetime, timezone
from pathlib import Path

CLAUDE_HOME = Path.home() / ".claude"
SKILLS_DIR = CLAUDE_HOME / "skills"
INSTALLED_PLUGINS_JSON = CLAUDE_HOME / "plugins" / "installed_plugins.json"
SETTINGS_JSON = CLAUDE_HOME / "settings.json"
SETTINGS_LOCAL_JSON = CLAUDE_HOME / "settings.local.json"

CODEX_HOME = Path.home() / ".codex"
CODEX_SKILLS_DIR = CODEX_HOME / "skills"
CODEX_AGENTS_DIR = CODEX_HOME / "agents"
CODEX_PROMPTS_DIR = CODEX_HOME / "prompts"
CODEX_CONFIG_TOML = CODEX_HOME / "config.toml"
CODEX_PLUGINS_CACHE = CODEX_HOME / "plugins" / "cache"

PROJECT_ROOT = Path(__file__).resolve().parent
OUT_SKILLS = PROJECT_ROOT / "data" / "skills-index.json"
OUT_HEALTH = PROJECT_ROOT / "data" / "session-health.json"

# Plugins known to run background workers / keep local SQLite state, with
# their actual documented repair commands. Verify against the plugin's own
# docs before trusting this table for a plugin not already listed here --
# never invent a generic "wipe lockfiles" fix.
KNOWN_BACKGROUND_WORKER_PLUGINS = {
    "claude-mem": {
        "repairCommand": "npx claude-mem repair",
        "docsUrl": "https://github.com/thedotmack/claude-mem",
    },
    "claude-brain": {
        "repairCommand": "npx claude-brain doctor",
        "docsUrl": "https://github.com/claude-brain/claude-brain",
    },
}

# category -> substrings matched case-insensitively against the description.
# First match wins. This is a heuristic, not an ontology -- anything that
# doesn't hit one of these falls back to "uncategorized" and relies on
# keyword-overlap edges instead of a shared category edge.
CATEGORY_TAXONOMY = [
    ("code-review", ["code review", "pull request", "confidence-based scoring"]),
    ("code-quality", ["simplif", "refin", "maintainability", "dead code", "clarity"]),
    ("git-vcs", ["git ", "commit", "push", "github"]),
    ("feature-dev", ["feature development", "architecture", "codebase exploration", "codebase onboarding"]),
    ("docs-lookup", ["documentation", "docs", "code examples"]),
    ("browser-testing", ["chrome", "devtools", "puppeteer", "playwright", "browser automation", "e2e", "end-to-end"]),
    ("project-memory", ["claude.md", "project memory", "audit quality", "persistent memory", "session context"]),
    ("knowledge-graph", ["knowledge graph", "community detection", "graphrag", "navigable"]),
    ("security", ["security", "vulnerab", "exploit", "phi compliance", "hipaa"]),
    ("testing-tdd", ["tdd", "test-driven", "unit test", "test coverage"]),
    ("agent-orchestration", ["multi-agent", "agent harness", "autonomous", "orchestrat", "sub-agent", "agent loop"]),
    ("ui-design", ["design system", "accessibility", "wcag", "motion", "animation", "liquid glass", "ux", "gsap"]),
    ("frontend-web", ["react", "vue", "angular", "svelte", "next.js", "nextjs", "nuxt", "vite", "tailwind"]),
    ("mobile-native", ["swiftui", "jetpack compose", "android", "react native", "ios app", "flutter", "dart"]),
    ("languages-python", ["python", "django", "fastapi", "pep 8"]),
    ("languages-jvm", ["java ", "kotlin", "spring boot", "quarkus", " jvm"]),
    ("languages-systems", ["rust ", "golang", "go build", " cpp", "c++"]),
    ("languages-dotnet", [".net", "c#", "wpf", "winui", "avalonia", "uwp"]),
    ("languages-web-backend", ["laravel", "php", "node.js", "nestjs", "express"]),
    ("database-storage", ["postgres", "mysql", "redis", "clickhouse", "prisma", "database migration", "sql "]),
    ("devops-infra", ["docker", "kubernetes", "deployment", "ci/cd", "continuous integration"]),
    ("network-infra", ["network", "homelab", "cisco", "bgp", "vpn", "dns", "vlan", "ssh automation"]),
    ("healthcare", ["healthcare", "clinical", "emr", "ehr", "cdss", "medical"]),
    ("finance-trading", ["finance", "billing", "trading", "defi", "blockchain", "crypto", "prediction market", "token"]),
    ("marketing-content", ["marketing", "seo", "brand", "copywriting", "social media", "content calendar"]),
    ("video-media", ["video editing", "remotion", "manim", "media processing"]),
    ("ml-data", ["machine learning", "pytorch", "recommender system", "recsys", " ml ", "model training"]),
    ("research-analysis", ["research", "literature review", "competitive analysis", "market research", "scholar"]),
    ("productivity-ops", ["email", "google workspace", "jira", "slack", "calendar", "notifications"]),
    ("performance", ["performance", "latency", "benchmark", "throughput", "optimization"]),
]

STOPWORDS = {
    "with", "using", "into", "your", "that", "from", "have", "this", "that's",
    "these", "those", "about", "which", "their", "would", "there", "where",
    "based", "across", "against", "through", "plugin", "claude",
}

MAX_KEYWORDS = 8


def parse_frontmatter(md_text: str) -> dict:
    """Minimal flat 'key: value' YAML frontmatter parser (name/description
    focus), with support for block-scalar values (`>-`, `>`, `|`, `|-`) since
    several skills wrap long descriptions across indented continuation lines.
    """
    result = {}
    parts = md_text.split("---", 2)
    if len(parts) < 3:
        return result
    lines = parts[1].splitlines()
    i, n = 0, len(lines)
    while i < n:
        raw_line = lines[i]
        line = raw_line.strip()
        i += 1
        if not line or ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip()
        if re.match(r"^[>|][+-]?$", value):
            folded = value.startswith(">")
            base_indent = len(raw_line) - len(raw_line.lstrip())
            collected = []
            while i < n:
                cont_raw = lines[i]
                if not cont_raw.strip():
                    i += 1
                    continue
                cont_indent = len(cont_raw) - len(cont_raw.lstrip())
                if cont_indent <= base_indent:
                    break
                collected.append(cont_raw.strip())
                i += 1
            value = " ".join(collected) if folded else "\n".join(collected)
        else:
            value = value.strip('"').strip("'")
        result[key] = value
    return result


def extract_heuristic_keywords(description: str) -> list:
    words = re.findall(r"[a-zA-Z']+", description.lower())
    seen = []
    for w in words:
        if len(w) >= 5 and w not in STOPWORDS and w not in seen:
            seen.append(w)
    return seen


def categorize(description: str, explicit_keywords: list = None) -> tuple:
    desc_lower = (description or "").lower()
    category = "uncategorized"
    hit_keywords = []
    for cat_name, substrings in CATEGORY_TAXONOMY:
        hits = [s for s in substrings if s in desc_lower]
        if hits:
            category = cat_name
            hit_keywords = hits
            break

    keywords = []
    if explicit_keywords:
        keywords = [k.lower() for k in explicit_keywords]
    else:
        keywords = list(hit_keywords)
        for w in extract_heuristic_keywords(description or ""):
            if len(keywords) >= MAX_KEYWORDS:
                break
            if w not in keywords:
                keywords.append(w)

    return category, keywords[:MAX_KEYWORDS]


def scan_skill_dir(skills_dir: Path, plugin_name: str = None) -> list:
    """Scan a directory of skill subfolders, each containing a SKILL.md.
    Used for both ~/.claude/skills (personal, plugin_name=None) and each
    plugin's own skills/ directory (plugin_name=<plugin>)."""
    entries = []
    if not skills_dir.is_dir():
        return entries
    for skill_dir in sorted(skills_dir.iterdir()):
        skill_md = skill_dir / "SKILL.md"
        if not skill_md.is_file():
            continue
        fm = parse_frontmatter(skill_md.read_text(encoding="utf-8", errors="replace"))
        name = fm.get("name", skill_dir.name)
        description = fm.get("description", "")
        if plugin_name:
            entry_id = f"skill:{plugin_name}:{skill_dir.name}"
            display_name = f"{plugin_name}:{name}"
        else:
            entry_id = f"skill:{skill_dir.name}"
            display_name = name
        entries.append({
            "id": entry_id,
            "name": display_name,
            "description": description,
            "source": "skill",
            "plugin": plugin_name,
            "sourcePath": str(skill_md),
        })
    return entries


def scan_agent_dir(agents_dir: Path, plugin_name: str) -> list:
    entries = []
    if not agents_dir.is_dir():
        return entries
    for md_file in sorted(agents_dir.glob("*.md")):
        fm = parse_frontmatter(md_file.read_text(encoding="utf-8", errors="replace"))
        name = fm.get("name", md_file.stem)
        description = fm.get("description", "")
        entries.append({
            "id": f"agent:{plugin_name}:{md_file.stem}",
            "name": f"{plugin_name}:{name}",
            "description": description,
            "source": "agent",
            "plugin": plugin_name,
            "sourcePath": str(md_file),
        })
    return entries


def scan_command_dir(commands_dir: Path, plugin_name: str) -> list:
    entries = []
    if not commands_dir.is_dir():
        return entries
    for md_file in sorted(commands_dir.glob("*.md")):
        fm = parse_frontmatter(md_file.read_text(encoding="utf-8", errors="replace"))
        description = fm.get("description", "")
        entries.append({
            "id": f"command:{plugin_name}:{md_file.stem}",
            "name": f"{plugin_name}:{md_file.stem}",
            "description": description,
            "source": "command",
            "plugin": plugin_name,
            "sourcePath": str(md_file),
        })
    return entries


def load_installed_plugins() -> dict:
    """Returns {'<name>@<marketplace>': {'installPath': ..., 'version': ..., 'enabled': bool}}"""
    if not INSTALLED_PLUGINS_JSON.is_file():
        return {}
    data = json.loads(INSTALLED_PLUGINS_JSON.read_text(encoding="utf-8"))
    enabled_map = {}
    if SETTINGS_JSON.is_file():
        settings = json.loads(SETTINGS_JSON.read_text(encoding="utf-8"))
        enabled_map = settings.get("enabledPlugins", {})

    result = {}
    for key, installs in data.get("plugins", {}).items():
        if not installs:
            continue
        latest = installs[0]
        result[key] = {
            "installPath": latest.get("installPath"),
            "version": latest.get("version"),
            "enabled": bool(enabled_map.get(key, False)),
        }
    return result


def normalize_server_map(raw: dict) -> dict:
    """Both {'mcpServers': {...}} and bare {'<server>': {...}} shapes occur on disk."""
    if "mcpServers" in raw and isinstance(raw["mcpServers"], dict):
        return raw["mcpServers"]
    return {k: v for k, v in raw.items() if isinstance(v, dict) and "command" in v}


def scan_plugins_and_mcp_tools(installed: dict, manifest_dir_name: str = ".claude-plugin") -> tuple:
    """Generic across CLIs: Claude Code plugins keep manifests under
    '.claude-plugin/plugin.json'; Codex plugins use the same skills/agents/
    commands/.mcp.json sub-layout but a '.codex-plugin/plugin.json' manifest.
    """
    plugin_entries = []
    mcp_entries = []
    skill_entries = []
    agent_entries = []
    command_entries = []

    for key, info in installed.items():
        if not info["enabled"]:
            continue
        name, _, marketplace = key.partition("@")
        install_path = info.get("installPath")
        if not install_path:
            continue
        install_dir = Path(install_path)
        manifest_path = install_dir / manifest_dir_name / "plugin.json"
        if not manifest_path.is_file():
            continue

        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue

        description = manifest.get("description", "")
        plugin_entries.append({
            "id": f"plugin:{name}",
            "name": manifest.get("name", name),
            "description": description,
            "source": "plugin",
            "plugin": name,
            "sourcePath": str(manifest_path),
            "_explicitKeywords": manifest.get("keywords"),
        })

        skill_entries.extend(scan_skill_dir(install_dir / "skills", plugin_name=name))
        agent_entries.extend(scan_agent_dir(install_dir / "agents", name))
        command_entries.extend(scan_command_dir(install_dir / "commands", name))

        # MCP servers: inline in plugin.json, and/or a sibling .mcp.json file.
        server_map = normalize_server_map(manifest)

        mcp_json_path = install_dir / ".mcp.json"
        mcp_source_path = manifest_path
        if mcp_json_path.is_file():
            try:
                mcp_data = json.loads(mcp_json_path.read_text(encoding="utf-8"))
                server_map = {**server_map, **normalize_server_map(mcp_data)}
                mcp_source_path = mcp_json_path
            except (json.JSONDecodeError, OSError):
                pass

        for server_name, server_cfg in server_map.items():
            command = server_cfg.get("command", "")
            args = server_cfg.get("args", [])
            args_str = " ".join(str(a) for a in args)
            mcp_entries.append({
                "id": f"mcp-tool:{name}:{server_name}",
                "name": server_name,
                "description": f"MCP tool server for {name} ({command} {args_str})".strip(),
                "source": "mcp-tool",
                "plugin": name,
                "sourcePath": str(mcp_source_path),
                "_explicitKeywords": None,
            })

    return plugin_entries, mcp_entries, skill_entries, agent_entries, command_entries


# ─────────────────────────── Codex-specific scanning ───────────────────────

def load_codex_config() -> dict:
    if not CODEX_CONFIG_TOML.is_file():
        return {}
    try:
        return tomllib.loads(CODEX_CONFIG_TOML.read_text(encoding="utf-8"))
    except (tomllib.TOMLDecodeError, OSError):
        return {}


def resolve_codex_install_dir(marketplace: str, name: str):
    """Codex plugin content lives at plugins/cache/<marketplace>/<name>/<version-or-hash>/.
    Pick the most recently modified subdir that actually has a manifest."""
    base = CODEX_PLUGINS_CACHE / marketplace / name
    if not base.is_dir():
        return None
    candidates = [d for d in base.iterdir() if d.is_dir() and (d / ".codex-plugin" / "plugin.json").is_file()]
    if not candidates:
        return None
    candidates.sort(key=lambda d: d.stat().st_mtime, reverse=True)
    return candidates[0]


def load_installed_codex_plugins(config: dict) -> dict:
    """Returns {'<name>@<marketplace>': {'installPath': ..., 'enabled': bool}}
    for plugins config.toml marks enabled AND whose content we can locate."""
    result = {}
    for key, info in config.get("plugins", {}).items():
        if not isinstance(info, dict) or not info.get("enabled", False):
            continue
        name, _, marketplace = key.partition("@")
        if not marketplace:
            continue
        install_dir = resolve_codex_install_dir(marketplace, name)
        if not install_dir:
            continue
        result[key] = {"installPath": str(install_dir), "enabled": True}
    return result


def scan_codex_personal_skills() -> list:
    """~/.codex/skills/**/SKILL.md -- flat personal skills plus the nested
    skills/.system/<name>/SKILL.md bundled-system-skill group."""
    entries = []
    if not CODEX_SKILLS_DIR.is_dir():
        return entries
    for skill_md in sorted(CODEX_SKILLS_DIR.rglob("SKILL.md")):
        fm = parse_frontmatter(skill_md.read_text(encoding="utf-8", errors="replace"))
        rel = skill_md.parent.relative_to(CODEX_SKILLS_DIR)
        slug = str(rel).replace("\\", "/")
        entries.append({
            "id": f"skill:{slug}",
            "name": fm.get("name", skill_md.parent.name),
            "description": fm.get("description", ""),
            "source": "skill",
            "plugin": None,
            "sourcePath": str(skill_md),
        })
    return entries


def scan_codex_personal_agents() -> tuple:
    """~/.codex/agents/<name>.md -- returns (entries, set of covered stems) so
    scan_codex_config_agents can skip names already covered by a real file."""
    entries = []
    covered = set()
    if not CODEX_AGENTS_DIR.is_dir():
        return entries, covered
    for md_file in sorted(CODEX_AGENTS_DIR.glob("*.md")):
        fm = parse_frontmatter(md_file.read_text(encoding="utf-8", errors="replace"))
        covered.add(md_file.stem)
        entries.append({
            "id": f"agent:{md_file.stem}",
            "name": fm.get("name", md_file.stem),
            "description": fm.get("description", ""),
            "source": "agent",
            "plugin": None,
            "sourcePath": str(md_file),
        })
    return entries, covered


def scan_codex_config_agents(config: dict, covered_stems: set) -> list:
    """config.toml [agents.<name>] tables (e.g. explorer, reviewer,
    docs_researcher) that reference a separate *.toml config file and have no
    matching agents/<name>.md of their own."""
    entries = []
    for key, val in config.get("agents", {}).items():
        if not isinstance(val, dict) or "description" not in val or key in covered_stems:
            continue
        entries.append({
            "id": f"agent:{key}",
            "name": key,
            "description": val.get("description", ""),
            "source": "agent",
            "plugin": None,
            "sourcePath": str(CODEX_CONFIG_TOML),
        })
    return entries


PROMPT_TITLE_PREFIXES = [
    "ECC Command Prompt: ",
    "Claude Code Plugin Prompt: ",
    "Codex Command Prompt: ",
]


def parse_codex_prompt(text: str) -> tuple:
    """~/.codex/prompts/*.md files have no YAML frontmatter -- just a leading
    '# <title>' heading, an optional 'Source: ...' line, then body text. Mine
    a display title and a description from the first body paragraph."""
    lines = text.splitlines()
    n = len(lines)
    i = 0
    while i < n and not lines[i].strip():
        i += 1
    title = ""
    if i < n and lines[i].lstrip().startswith("#"):
        title = lines[i].lstrip("#").strip()
        i += 1
    for prefix in PROMPT_TITLE_PREFIXES:
        if title.startswith(prefix):
            title = title[len(prefix):].strip()
            break
    while i < n:
        line = lines[i].strip()
        if not line or line.lower().startswith("source:"):
            i += 1
            continue
        break
    desc_lines = []
    while i < n and lines[i].strip():
        desc_lines.append(lines[i].strip())
        i += 1
    return title, " ".join(desc_lines).strip()


def scan_codex_prompts() -> list:
    entries = []
    if not CODEX_PROMPTS_DIR.is_dir():
        return entries
    for md_file in sorted(CODEX_PROMPTS_DIR.glob("*.md")):
        text = md_file.read_text(encoding="utf-8", errors="replace")
        title, description = parse_codex_prompt(text)
        entries.append({
            "id": f"command:{md_file.stem}",
            "name": title or md_file.stem,
            "description": description,
            "source": "command",
            "plugin": None,
            "sourcePath": str(md_file),
        })
    return entries


def scan_codex_global_mcp_servers(config: dict) -> list:
    """config.toml [mcp_servers.<name>] -- servers not tied to any one plugin
    (node_repl, chrome-devtools, mcp-search, etc.)."""
    entries = []
    for name, cfg in config.get("mcp_servers", {}).items():
        if not isinstance(cfg, dict):
            continue
        command = cfg.get("command", "")
        args = cfg.get("args", [])
        args_str = " ".join(str(a) for a in args)
        entries.append({
            "id": f"mcp-tool:{name}",
            "name": name,
            "description": f"MCP tool server ({command} {args_str})".strip(),
            "source": "mcp-tool",
            "plugin": None,
            "sourcePath": str(CODEX_CONFIG_TOML),
            "_explicitKeywords": None,
        })
    return entries


def build_codex_entries(config: dict) -> list:
    installed = load_installed_codex_plugins(config)
    plugins, mcp_tools, plugin_skills, plugin_agents, plugin_commands = scan_plugins_and_mcp_tools(
        installed, manifest_dir_name=".codex-plugin")
    personal_skills = scan_codex_personal_skills()
    personal_agents, covered_stems = scan_codex_personal_agents()
    config_agents = scan_codex_config_agents(config, covered_stems)
    prompts = scan_codex_prompts()
    global_mcp = scan_codex_global_mcp_servers(config)

    all_entries = (personal_skills + plugin_skills + personal_agents + config_agents +
                   plugin_agents + prompts + plugin_commands + plugins + mcp_tools + global_mcp)
    for entry in all_entries:
        explicit_keywords = entry.pop("_explicitKeywords", None)
        category, keywords = categorize(entry["description"], explicit_keywords)
        entry["category"] = category
        entry["keywords"] = keywords
        entry["origin"] = "codex"
        entry["id"] = f"codex:{entry['id']}"
    return all_entries


def build_index() -> list:
    installed = load_installed_plugins()
    personal_skills = scan_skill_dir(SKILLS_DIR)
    plugins, mcp_tools, plugin_skills, agents, commands = scan_plugins_and_mcp_tools(installed)

    claude_entries = personal_skills + plugin_skills + agents + commands + plugins + mcp_tools
    for entry in claude_entries:
        explicit_keywords = entry.pop("_explicitKeywords", None)
        category, keywords = categorize(entry["description"], explicit_keywords)
        entry["category"] = category
        entry["keywords"] = keywords
        entry["origin"] = "claude-code"

    codex_entries = build_codex_entries(load_codex_config())

    all_entries = claude_entries + codex_entries
    OUT_SKILLS.parent.mkdir(parents=True, exist_ok=True)
    OUT_SKILLS.write_text(json.dumps(all_entries, indent=2), encoding="utf-8")
    return all_entries


def detect_background_worker(installed: dict) -> dict:
    for key in installed:
        name = key.split("@")[0]
        if name in KNOWN_BACKGROUND_WORKER_PLUGINS:
            info = KNOWN_BACKGROUND_WORKER_PLUGINS[name]
            return {
                "detected": True,
                "pluginName": name,
                "repairCommand": info["repairCommand"],
                "docsUrl": info["docsUrl"],
                "note": f"{name} is installed and known to run a background worker/local state store. "
                        f"Use its documented repair command if the session looks stuck or corrupted.",
            }
    return {
        "detected": False,
        "pluginName": None,
        "repairCommand": None,
        "docsUrl": None,
        "note": "No known background-worker plugin (e.g. claude-mem, claude-brain) detected on this "
                "machine. Recovery steps are plugin-specific -- consult that plugin's own documentation.",
    }


def snapshot_codex_health(config: dict) -> dict:
    """Codex's equivalent config/plugin state: it has no hooks.json-style
    event-hook system like Claude Code's settings.json, so this section
    covers configured plugins, global MCP servers, and config-defined
    sub-agents instead -- the state Codex actually exposes."""
    installed = load_installed_codex_plugins(config)

    plugins_list = [
        {
            "name": key.split("@")[0],
            "marketplace": key.split("@")[1] if "@" in key else "unknown",
            "enabled": bool(info.get("enabled", False)),
        }
        for key, info in sorted(config.get("plugins", {}).items())
        if isinstance(info, dict)
    ]
    mcp_servers = sorted(config.get("mcp_servers", {}).keys())
    configured_agents = sorted(
        key for key, val in config.get("agents", {}).items()
        if isinstance(val, dict) and "description" in val
    )

    return {
        "available": bool(config),
        "configPath": str(CODEX_CONFIG_TOML) if CODEX_CONFIG_TOML.is_file() else None,
        "plugins": plugins_list,
        "mcpServers": mcp_servers,
        "configuredAgents": configured_agents,
        "backgroundWorker": detect_background_worker(installed),
        "note": "Codex has no hooks.json/settings-hook system equivalent to Claude Code's "
                "SessionStart/Stop hooks -- this section reflects configured plugins, global MCP "
                "servers, and config.toml sub-agents instead.",
    }


def snapshot_session_health() -> dict:
    settings = {}
    settings_local = {}
    if SETTINGS_JSON.is_file():
        settings = json.loads(SETTINGS_JSON.read_text(encoding="utf-8"))
    if SETTINGS_LOCAL_JSON.is_file():
        settings_local = json.loads(SETTINGS_LOCAL_JSON.read_text(encoding="utf-8"))

    hooks = {**settings.get("hooks", {}), **settings_local.get("hooks", {})}
    installed = load_installed_plugins()

    plugins_list = [
        {
            "name": key.split("@")[0],
            "marketplace": key.split("@")[1] if "@" in key else "unknown",
            "version": info.get("version", "unknown"),
            "enabled": info.get("enabled", False),
        }
        for key, info in sorted(installed.items())
    ]

    snapshot = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "hooksConfigured": bool(hooks),
        "hooks": hooks,
        "plugins": plugins_list,
        "backgroundWorker": detect_background_worker(installed),
        "safeExit": [
            "Use /exit rather than force-killing the terminal.",
            "Avoid killing background worker processes mid-write.",
            "Avoid rapid /clear + immediate relaunch loops while a background worker is active.",
        ],
        "codex": snapshot_codex_health(load_codex_config()),
    }

    OUT_HEALTH.parent.mkdir(parents=True, exist_ok=True)
    OUT_HEALTH.write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
    return snapshot


def main():
    entries = build_index()
    health = snapshot_session_health()

    by_origin = {}
    by_source = {}
    for e in entries:
        by_origin[e["origin"]] = by_origin.get(e["origin"], 0) + 1
        by_source[e["source"]] = by_source.get(e["source"], 0) + 1

    print("Biblioteca rescan complete.")
    print(f"  Index entries: {len(entries)} ({', '.join(f'{v} {k}' for k, v in by_origin.items())})")
    print(f"    by source: {', '.join(f'{v} {k}' for k, v in by_source.items())}")
    print(f"  -> {OUT_SKILLS}")
    print(f"  Claude Code -- hooks configured: {health['hooksConfigured']}")
    print(f"  Claude Code -- enabled plugins: {sum(1 for p in health['plugins'] if p['enabled'])}/{len(health['plugins'])}")
    print(f"  Claude Code -- background worker plugin detected: {health['backgroundWorker']['detected']}")
    codex_health = health["codex"]
    print(f"  Codex -- enabled plugins: {sum(1 for p in codex_health['plugins'] if p['enabled'])}/{len(codex_health['plugins'])}")
    print(f"  Codex -- global MCP servers: {len(codex_health['mcpServers'])}")
    print(f"  -> {OUT_HEALTH}")


if __name__ == "__main__":
    main()
