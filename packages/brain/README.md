# Brain

[![npm version](https://img.shields.io/npm/v/@timmeck/brain)](https://www.npmjs.com/package/@timmeck/brain)
[![npm downloads](https://img.shields.io/npm/dm/@timmeck/brain)](https://www.npmjs.com/package/@timmeck/brain)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/timmeck/brain-ecosystem?style=social)](https://github.com/timmeck/brain-ecosystem)

**Autonomous Error Memory, Code Intelligence & Self-Improving AI for Claude Code — 134 MCP Tools, 60+ Engines**

Brain is an MCP server that gives Claude Code a persistent, self-improving memory. It remembers errors, learns solutions, and runs 60+ autonomous engines in a 40-step feedback cycle. It observes itself, detects anomalies, forms and tests hypotheses, distills principles, reasons in chains, feels emotions, evolves strategies genetically, debates itself, gets curious about knowledge gaps, and modifies its own source code. Multi-provider LLM (Anthropic + Ollama). Autonomous web research missions. Live tech radar scanning. 134 MCP tools. 1401 tests.

## Quick Start

```bash
npm install -g @timmeck/brain
brain setup
```

That's it. One command configures MCP, hooks, and starts the daemon.

## Features

### Error Memory & Code Intelligence
- **Error Memory** — Track errors, match against known solutions with hybrid search (TF-IDF + vector + synapse boost)
- **Code Intelligence** — Register and discover reusable code modules across all projects
- **Proactive Prevention** — Warns before errors occur when code matches known antipatterns
- **Cross-Project Learning** — Solutions from project A help solve errors in project B
- **Auto Error Detection** — PostToolUse hook catches errors in real-time
- **Git Integration** — Links errors to commits, tracks which changes introduced or fixed bugs

### Persistent Memory
- **Memory System** — Remember preferences, decisions, context, facts, goals, and lessons across sessions
- **Session Tracking** — Auto-tracks conversation sessions with goals, summaries, and outcomes
- **Decision History** — Record architecture/design decisions with alternatives and rationale
- **Semantic Search** — Local all-MiniLM-L6-v2 embeddings (23MB, no cloud required)

### LLM Service
- **Multi-Provider** — Anthropic Claude + Ollama local models with auto-routing
- **Smart Caching** — Content-hash cache, avoid duplicate API calls
- **Rate Limiting** — Per-hour and per-day token budgets with automatic throttling
- **Usage Tracking** — Calls, tokens, latency, cache hit rate, cost tracking

### Research Missions
- **5-Phase Pipeline** — Decompose → Gather → Hypothesize → Analyze → Synthesize
- **Web Research** — Brave Search + Jina Reader + Playwright + Firecrawl fallback chain
- **Autonomous** — Brain decides what to research and executes independently

### TechRadar
- **Daily Scanning** — Tracks trending repos, tech news, library updates
- **Repo Watching** — Monitor specific repos for changes
- **LLM Relevance Scoring** — AI judges how relevant each finding is

### 60+ Autonomous Engines

The ResearchOrchestrator runs a 40-step feedback cycle every 5 minutes:

- **Observation** — SelfObserver, AnomalyDetective, DataScout, SignalScanner, TechRadar
- **Understanding** — AttentionEngine, CausalGraph, CrossDomain, PatternEngine
- **Ideas** — HypothesisEngine, CuriosityEngine, DreamEngine, DebateEngine
- **Testing** — ExperimentEngine, AutoExperiment, SimulationEngine, PredictionEngine
- **Knowledge** — KnowledgeDistiller, MemoryPalace, ResearchJournal, ConceptAbstraction
- **Action** — SelfModification, GoalEngine, AdaptiveStrategy, MetaCognition, Evolution, Reasoning, EmotionalModel

### Self-Modification
- **SelfScanner** — Indexes own TypeScript source code with SHA256 change detection
- **SelfModificationEngine** — Generates improvements via Claude API, tests before applying
- **Experiment Ledger** — Tracks hypothesis, risk level, metrics before/after for every modification

### Notifications
- **Discord, Telegram, Email** — Multi-channel alert routing
- **Notification Bridge** — IPC-based cross-brain notification relay
- **Configurable** — All providers optional, graceful fallback

### Dashboards

| Dashboard | Port | What It Shows |
|-----------|------|--------------|
| **Mission Control** | 7788 | 7-tab: Overview, Consciousness Entity, Thoughts, CodeGen, Self-Mod, Engines, Intelligence |
| **Command Center** | 7790 | 7-page: Ecosystem, Learning Pipeline, Trading Flow, Marketing Flow, Cross-Brain & Borg, Activity & Missions, Infrastructure |


**Command Center features:** Brain status cards, health gauge, LLM usage, thought stream, error log, engine dependency flow, knowledge growth chart, self-modification feed, mission tracker with 5-phase progress, quick actions, animated Borg network, peer graph

## MCP Tools (134 tools)

**Error & Code**: brain_report_error, brain_query_error, brain_report_solution, brain_report_attempt, brain_find_reusable_code, brain_register_code, brain_check_code_similarity

**Memory & Sessions**: brain_remember, brain_recall, brain_session_start, brain_session_end, brain_session_history

**Research Engines** (5 tools each): self_observer, anomaly_detective, cross_domain, adaptive_strategy, experiment, knowledge_distiller, research_agenda, counterfactual, journal

**Dream, Consciousness, Prediction, AutoResponder, Attention, Transfer, Narrative, Curiosity, Emergence, Debate, MetaCognition, Evolution, Reasoning, Emotions, Self-Modification, Ecosystem** — full tool suites for each

## CLI Commands

```
brain setup              One-command setup: MCP + hooks + daemon
brain start / stop       Daemon management (with watchdog)
brain status             Stats: errors, solutions, engines, synapses
brain doctor             Health check: daemon, DB, MCP, hooks
brain query <text>       Search for errors and solutions
brain learn              Trigger a learning cycle
brain peers              Show peer brains in the ecosystem
brain dashboard          Generate interactive HTML dashboard
brain export             Export Brain data as JSON
```

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `BRAIN_DATA_DIR` | `~/.brain` | Data directory |
| `BRAIN_LOG_LEVEL` | `info` | Log level |
| `BRAIN_API_PORT` | `7777` | REST API port |
| `BRAIN_MCP_HTTP_PORT` | `7778` | MCP HTTP/SSE port |
| `ANTHROPIC_API_KEY` | — | Enables LLM features, CodeGen, Self-Mod |
| `BRAVE_SEARCH_API_KEY` | — | Enables web research missions |
| `GITHUB_TOKEN` | — | Enables CodeMiner + Signal Scanner |

## Brain Ecosystem

| Brain | Purpose | Ports |
|-------|---------|-------|
| **Brain** (this) | Error memory, code intelligence, full autonomy & self-modification | **7777** / 7778 / 7788 / 7790 |
| [Trading Brain](../trading-brain) | Adaptive trading intelligence with signal learning & paper trading | 7779 / 7780 |
| [Marketing Brain](../marketing-brain) | Content strategy, social engagement & cross-platform optimization | 7781 / 7782 / 7783 |
| [Brain Core](../brain-core) | Shared infrastructure — 60+ engines | — |

## Support

[![Star this repo](https://img.shields.io/github/stars/timmeck/brain-ecosystem?style=social)](https://github.com/timmeck/brain-ecosystem)
[![Sponsor](https://img.shields.io/badge/Sponsor-Support%20Development-ea4aaa)](https://github.com/sponsors/timmeck)

## License

[MIT](LICENSE)
