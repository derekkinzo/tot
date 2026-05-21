# tot-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP Server](https://img.shields.io/badge/MCP-Server-purple)](https://modelcontextprotocol.io)

**Structured hypothesis tree reasoning for AI agents** — with real-time browser visualization.

Agents decompose problems into hypothesis trees, gather evidence, eliminate dead ends systematically, and confirm root causes — all visible live in your browser.

![tot-mcp demo](https://raw.githubusercontent.com/derekkinzo/tot/main/docs/demo.gif)

## Why

AI agents debugging complex problems tend to reason linearly — they follow the first plausible lead, get stuck in rabbit holes, and lose track of what they've already investigated. Tree of Thought reasoning fixes this by maintaining a structured hypothesis tree that agents explore systematically.

**tot-mcp** is an MCP server that gives agents this structured reasoning capability with:

- **Hypothesis trees** — decompose problems into competing hypotheses at multiple levels
- **Evidence tracking** — typed evidence (supports/refutes/neutral) attached to each hypothesis
- **Systematic elimination** — mark dead ends with documented reasoning
- **Live visualization** — watch the tree build in real-time at `localhost:6274`
- **MECE guidance** — structural checks help ensure decompositions don't overlap or miss gaps
- **Adaptive signals** — tool responses prompt agents to seek refuting evidence and avoid confirmation bias

## Quick Start

```json
{
  "mcpServers": {
    "tot": {
      "command": "npx",
      "args": ["tot-mcp"]
    }
  }
}
```

Open `http://localhost:6274` to see the visualization.

<details>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add tot -- npx tot-mcp
```
</details>

<details>
<summary><strong>Kiro CLI / Other MCP Clients</strong></summary>

Add to your MCP configuration:
```json
{
  "mcpServers": {
    "tot": {
      "type": "stdio",
      "command": "npx",
      "args": ["tot-mcp"]
    }
  }
}
```
</details>

## Tools

| Tool | Purpose |
|------|---------|
| `create_tree` | Start a new reasoning session with a problem statement |
| `decompose` | Split a hypothesis into MECE sub-hypotheses |
| `add_hypothesis` | Add a missed hypothesis to the tree |
| `add_evidence` | Attach supporting/refuting/neutral evidence |
| `eliminate_hypothesis` | Mark a hypothesis as a dead end (with reason) |
| `confirm_hypothesis` | Mark as the confirmed root cause |
| `score_hypothesis` | Set confidence (0-1) based on evidence |
| `get_tree` | View the current tree structure |
| `get_status` | Progress summary + stagnation detection |
| `validate_decomposition` | Check structural properties of a decomposition |

## How It Works

1. Agent calls `create_tree` with a problem statement
2. Agent calls `decompose` to break it into competing hypotheses
3. For each hypothesis, the agent gathers evidence to **refute** it
4. Hypotheses that fail the evidence test are **eliminated**
5. Surviving hypotheses are decomposed further (deeper levels)
6. When one hypothesis remains with strong evidence, it's **confirmed**

The tool responses guide the agent through this process — prompting for refuting evidence, flagging confirmation bias, and suggesting discriminating tests.

## Visualization

The browser UI at `localhost:6274` shows:

- **Live tree updates** via Server-Sent Events (no polling)
- **Color-coded status** — pending (blue), exploring (yellow), eliminated (dimmed), confirmed (green)
- **Path highlighting** — click a node to see the path from root
- **Evidence detail panel** — click any node to see all attached evidence
- **Follow mode** — auto-tracks agent activity (press F to toggle)
- **Export** — download tree as Markdown

## Comparison

| Feature | sequential-thinking | code-reasoning | tot-mcp |
|---------|-------------------|----------------|---------|
| Real tree structure | Flat sequence | Flat sequence | **Yes** |
| Live browser visualization | No | No | **Yes** |
| Typed evidence tracking | No | No | **Yes** |
| Hypothesis elimination | No | No | **Yes** |
| MECE decomposition guidance | No | No | **Yes** |
| Confidence scoring | No | No | **Yes** |
| Stagnation detection | No | No | **Yes** |
| Adaptive response signals | No | No | **Yes** |

## Architecture

A global daemon process serves all projects:

```
MCP Client (Claude, Kiro, Cursor) → shim (stdio) → daemon (TCP IPC) → TreeManager
                                                    ↓
Browser (localhost:6274) ← SSE events ← HTTP server ←┘
```

- **One port** (6274) for all projects — no port hunting
- **Shim** auto-starts daemon on first use
- **Daemon** survives agent disconnect (browser stays connected)
- **JSONL persistence** in `{project}/.tot/sessions/`
- **Offline viewing**: `tot-mcp serve`

## CLI

```bash
tot-mcp              # Start MCP shim (what clients spawn)
tot-mcp serve        # Start daemon for offline viewing
tot-mcp status       # Show daemon + session info
tot-mcp stop         # Stop daemon
tot-mcp --help       # Usage
```

## Research Background

This tool implements concepts from:

- Yao, S. et al. (2023). *Tree of Thoughts: Deliberate Problem Solving with Large Language Models.* NeurIPS 2023. [arXiv:2305.10601](https://arxiv.org/abs/2305.10601)
- Heuer, R. (1999). *Psychology of Intelligence Analysis* — Analysis of Competing Hypotheses (ACH) methodology
- Popper, K. (1959). *The Logic of Scientific Discovery* — falsification-first approach
- Lightman, H. et al. (2023). *Let's Verify Step by Step.* [arXiv:2305.20050](https://arxiv.org/abs/2305.20050) — process supervision

## License

MIT
