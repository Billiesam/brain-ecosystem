# Brain Ecosystem

[![GitHub stars](https://img.shields.io/github/stars/timmeck/brain-ecosystem?style=social)](https://github.com/timmeck/brain-ecosystem)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**A family of self-learning MCP servers that give Claude Code persistent memory.**

Brain gives Claude Code a persistent, self-learning memory — it remembers your errors, learns from your patterns, and gets smarter with every session.

## Packages

| Package | Version | Description | Ports |
|---------|---------|-------------|-------|
| [@timmeck/brain](packages/brain) | [![npm](https://img.shields.io/npm/v/@timmeck/brain)](https://www.npmjs.com/package/@timmeck/brain) | Error memory, code intelligence & persistent context | 7777 / 7778 |
| [@timmeck/trading-brain](packages/trading-brain) | [![npm](https://img.shields.io/npm/v/@timmeck/trading-brain)](https://www.npmjs.com/package/@timmeck/trading-brain) | Adaptive trading intelligence with memory & sessions | 7779 / 7780 |
| [@timmeck/marketing-brain](packages/marketing-brain) | [![npm](https://img.shields.io/npm/v/@timmeck/marketing-brain)](https://www.npmjs.com/package/@timmeck/marketing-brain) | Content strategy & engagement with memory & sessions | 7781 / 7782 / 7783 |
| [@timmeck/brain-core](packages/brain-core) | [![npm](https://img.shields.io/npm/v/@timmeck/brain-core)](https://www.npmjs.com/package/@timmeck/brain-core) | Shared infrastructure (IPC, MCP, REST, CLI, math, synapses, memory) | — |

## Quick Start

Install any brain globally:

```bash
npm install -g @timmeck/brain
brain setup
```

```bash
npm install -g @timmeck/trading-brain
trading setup
```

```bash
npm install -g @timmeck/marketing-brain
marketing setup
```

Each brain runs as a background daemon and registers itself as an MCP server for Claude Code, Cursor, Windsurf, Cline, and Continue.

## Development

```bash
git clone https://github.com/timmeck/brain-ecosystem.git
cd brain-ecosystem
npm install          # installs all workspace dependencies
npm run build        # builds all packages (brain-core first)
npm test             # runs all tests across all packages
```

### Workspace Commands

```bash
npm run build                    # build all packages
npm test                         # test all packages
npm run lint                     # lint all packages
npm run build:core               # build brain-core only
npm run build:brain              # build brain only
npm run build:trading            # build trading-brain only
npm run build:marketing          # build marketing-brain only
```

### Package Dependencies

```
brain-core          (no internal deps)
   ^
   |
   +-- brain        (depends on brain-core)
   +-- trading-brain (depends on brain-core)
   +-- marketing-brain (depends on brain-core)
```

Build `brain-core` first when making changes to shared infrastructure.

## Cross-Brain Communication

All brains discover and query each other at runtime via IPC named pipes. When one brain learns something, peers are notified automatically. Use `brain peers`, `trading peers`, or `marketing peers` to see online peers.

## Architecture

Each brain follows the same architecture:
- **MCP Server** (stdio) — For Claude Code
- **MCP HTTP/SSE** — For Cursor, Windsurf, Cline, Continue
- **REST API** — For browser, CI/CD, custom integrations
- **Hebbian Synapse Network** — Weighted graph where connections strengthen with use
- **Learning Engine** — Extracts patterns and generates rules
- **Research Engine** — Automated trend analysis, gap detection, synergy mapping
- **SQLite** — Fast, embedded database with WAL mode

Visit the [Brain Hub](https://timmeck.github.io/brain-hub/) for the full ecosystem overview.

## Support

If Brain helps you, consider giving it a star — it helps others discover the project and keeps development going.

[![Star this repo](https://img.shields.io/github/stars/timmeck/brain-ecosystem?style=social)](https://github.com/timmeck/brain-ecosystem)
[![Sponsor](https://img.shields.io/badge/Sponsor-Support%20Development-ea4aaa)](https://github.com/sponsors/timmeck)

## License

[MIT](LICENSE)
