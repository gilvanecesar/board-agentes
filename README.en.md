# board

[![MIT License](https://img.shields.io/github/license/gilvanecesar/board-agentes?color=b9ed80&labelColor=111413)](LICENSE)
[![Release](https://img.shields.io/github/v/release/gilvanecesar/board-agentes?color=b9ed80&labelColor=111413&label=release)](https://github.com/gilvanecesar/board-agentes/releases)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-b9ed80?logo=docker&logoColor=white&labelColor=111413)](https://github.com/gilvanecesar/board-agentes/pkgs/container/board-agentes)
[![Tests](https://img.shields.io/github/actions/workflow/status/gilvanecesar/board-agentes/testes.yml?branch=main&label=tests&color=b9ed80&labelColor=111413)](https://github.com/gilvanecesar/board-agentes/actions/workflows/testes.yml)
[![Node 20+](https://img.shields.io/badge/node-20%2B-b9ed80?logo=nodedotjs&logoColor=white&labelColor=111413)](https://nodejs.org)
[![npm dependencies: 0](https://img.shields.io/badge/npm%20dependencies-0-b9ed80?labelColor=111413)](package.json)
[![Engines](https://img.shields.io/badge/engines-Claude%20%C2%B7%20Codex%20%C2%B7%20Gemini%20%C2%B7%20opencode-b9ed80?labelColor=111413)](#what-it-does)

[Português](README.md) · **English**

**A local workbench for running AI coding agents across many projects at once, with a memory that doesn't get lost.**

You write a task, it goes into a queue, and an agent (Claude Code, Codex, Gemini or opencode) works in the project's
folder. Before the delivery reaches you, the board checks the work in three steps: the project's own checks, a
reviewer that reads the diff, and a QA that runs it and tries to break it.

And every task starts with the **right memories**: the board treats the agents' memory as a **warehouse (WMS)**,
with aisles, racks, addresses and a picking list, and hands each task only what it needs.

It runs on your machine with plain Node: **zero npm dependencies**. The UI is one HTML file, the server is one `.mjs`
file, and the state lives in a `data/` folder outside git.

> The interface, the commands and the configuration names are in **Brazilian Portuguese**. This page explains them in English.

![How the board works](docs/img/fluxo.svg)

> The screenshots in this repository come from a **demo** board, with fictional projects and memories.

![My board](docs/img/quadro.png)

---

## What it does

| | |
|---|---|
| **Per-project task queue** | Every folder next to the board is a project. Different projects run side by side; the same project runs one task at a time (or in parallel, if you ask). |
| **Review pipeline** | Every task that touches files goes through **agent → gate → reviewer → QA**. A rejection goes back to the agent, in the same session, with the reasons. No readable verdict counts as a rejection. |
| **Four engines** | Claude Code, Codex, Gemini (`agy`) and opencode. When one runs out of quota, another takes over through a **written handoff**: the request, the summary, the last steps and the `git status`. |
| **Warehouse memory** | Aisles (projects), **minds** (subjects) and pallets (memories) with addresses. Graph and Warehouse views. |
| **Picking list** | For each task, the board picks the right memories and sends them along, written into the request. Works with any engine. |
| **"Have I dealt with this?"** | Search shows first what the memory already knows about the subject. |
| **Per-project chat** | One thread per project, like the terminal, to think things through before opening a task. |
| **Parallel agents** | `⚡ em paralelo` gives each task its own agent (`#eng01`, `#eng02`…) in an isolated copy (git worktree). |
| **Delivery** | Straight into the folder, as a Pull Request, or PR + merge + deploy (the last one only with a command you authorized in writing). |
| **Usage and control** | Each engine's plan, spend per role, backups and memory, with alerts. |

---

## Memory as a warehouse

Storing memory is easy. The hard part is **finding and picking the right one at the right time**: an agent's context
is small and expensive, and too much memory hurts as much as too little. A WMS solves exactly that in a warehouse,
and the same discipline works here.

![The memory warehouse](docs/img/galpao-da-memoria.png)

- **Aisle** = project (plus a **common area** that applies to all of them).
- **Rack** = a **mind**, the subject: product, finance, design, engineering, security…
- **Pallet** = one memory, with an address like `R03-P02-N1-02`. The color is its age; level 1 is the most recent.
- **Receiving**: an agent proposes each memory's mind, and the owner checks the uncertain ones before approving.
- **Picking list** (*romaneio*): for each task, the board chooses the minds and picks the memories it asks for.

**Graph**: each dot is a page, each line a link.

![Memory graph](docs/img/memoria-grafo.png)

**Warehouse**: the same memory, laid out as a warehouse.

![Memory warehouse](docs/img/memoria-galpao.png)

Inside a task, the picking list shows up on the timeline (📦), with every memory that was sent:

![A task: picking list, work, gate, reviewer and QA](docs/img/tarefa.png)

**How it works in detail, with every screen (in Portuguese): [docs/MEMORIA.md](docs/MEMORIA.md).**

### Measurement: the same task, with and without the picking list

A real task from the board itself ("the attachment accepts only images and silently rejects everything else"), run 4
times from the **same commit** with the **same model**: 2 without the picking list (A) and 2 with it (B). B's picking
list only carried memories that already existed before the task, so there was no "cheating".

| | Cost | Turns | Time | Output tokens |
|---|---|---|---|---|
| A1 (without) | US$ 1.18 | 39 | 3m21s | 19,080 |
| A2 (without) | US$ 1.35 | 52 | 3m51s | 19,382 |
| B1 (with) | US$ 1.18 | 47 | 2m59s | 15,472 |
| B2 (with) | US$ 1.19 | 45 | 3m23s | 16,525 |
| **Average A** | US$ 1.27 | 45.5 | 3m36s | 19,231 |
| **Average B** | **US$ 1.19 (−6%)** | 46 | **3m11s (−12%)** | **16,000 (−17%)** |

All four deliveries passed the same checks.

**An honest reading:** the trend favors the picking list (cheaper, faster, less generated text), but with 2 runs per
side the difference is still within noise: A1 and A2 alone differed by 13 turns. And this was the worst case for it,
because the memory had nothing about the task's subject. At scale, 6% to 12% is a lot of money and time, which is why
the second measurement used more runs.

### Second measurement: the picking list cost more

Another board task ("search and detail view in the pending list"), 4 runs per side, same commit and same model.
B's picking list carried the owner's core rules plus engineering and UI memories.

| | Cost | Turns | Time | Output tokens |
|---|---|---|---|---|
| **Average A (without)** | US$ 2.04 | 57.5 | 4m51s | 24,948 |
| **Average B (with)** | US$ 2.50 (**+23%**) | 70.3 (**+22%**) | 6m32s (**+35%**) | 30,137 (**+21%**) |
| Cost range | A: 1.72 – 2.39 | B: 2.35 – 2.58 | | |

**Quality: a tie.** All 8 deliveries passed the checks and a functional test in the browser. **Where B spent more:**
all 4 agents with the picking list built a new server route; among those without it, only 1 did (the others reused
what already existed). Hypothesis: the owner's general rules ("do the whole thing", "document everything") push the
agent to do more. And keyword picking missed the rule that mattered most for the task, because the request said the
same thing in other words.

### Third measurement: without the owner's general rules, a tie

Same task, 4 runs per side, but the picking list (C) carried only the task's memories, without the owner's core rules.

| | Cost | Turns | Time | Output tokens |
|---|---|---|---|---|
| **Average A (without)** | US$ 2.26 | 66 | 5m57s | 27,874 |
| **Average C (task memories only)** | US$ 2.23 (−2%) | 62 (−6%) | 6m29s (+9%) | 28,147 (+1%) |
| Cost range | A: 2.00 – 2.44 | C: 1.87 – 2.44 | | |

Quality: a tie again. Dropping the core rules took it from +23% to a tie, which supports the hypothesis that general
rules in every task push the agent to do more. But A itself varied 11% between the 2nd and 3rd measurements: with 4 runs,
"a tie" is all that can be said.

**Conclusion of the three measurements:** there is no proof that the picking list saves anything, and the fixed core
costs extra on small tasks. It can be turned off (`BOARD_ROMANEIO=0`) or used without the core (leave `nucleoDono`
empty in `mentes.json`). Since then the picking list also works **by meaning** (embeddings on a local ollama, `bge-m3`):
on a real memory, with 10 requests written in other words, it found the right memory in 8/10, against 5/10 by keyword
alone. Details in [docs/MEMORIA.md](docs/MEMORIA.md).

### Fourth measurement: the new picking list, WITH the owner's core rules — a tie

Same task, 4 runs per side, now with the picking list by keyword **and meaning** and the project bonus fixed. The owner's
core rules went along (in the 2nd measurement, with the old picking list and the core, it had cost 23% more).

| | Cost | Turns | Time | Output tokens |
|---|---|---|---|---|
| **Average A (without)** | US$ 2.21 | 61.3 | 5m21s | 27,237 |
| **Average D (new picking list, with core)** | US$ 2.19 (−1%) | 61.8 (+1%) | 5m01s (−6%) | 25,927 (−5%) |
| Cost range | A: 1.84 – 2.56 | D: 1.93 – 2.45 | | |

Quality: a tie (8 of 8 on the checks and on the functional test). Swapping 5 loose memories for 5 related to the request
removed the extra cost — core included. With 4 runs per side, **a tie** is all that can be said: none of the four
measurements showed savings, and the last one no longer shows extra cost.

## Board × AI alone (Sep 27, 2026)

The same person asking for the same things: on one side Claude Code alone in the folder; on the other, the board (house
rules, picking list, gate, reviewer, QA). Same model (Opus 5.5), 3 runs per task, and a **hidden answer key** neither side
saw, scored per item (0 to 5).

**Round 1 — small tasks, with the rules WRITTEN in CLAUDE.md:** a tie, 12/12 on both sides. The board cost 4.4× and made a
difference in only 1 case (the reviewer required the timezone test to actually catch the bug).

**Round 2 — bigger tasks, with the rules NOT written** (cancellation with refund, CSV import with Brazilian prices, monthly
commission, login attempt limit):

| | AI alone | Board |
|---|---|---|
| Score on the hidden answer key | 54/60 | **59/60** |
| Perfect deliveries | 9/12 | **11/12** |
| Delivered as "done" but incomplete | 3 | **1** |
| Average cost per task | **US$ 0.25** | US$ 1.06 (4.2×) |
| Average time | **44 s** | 3m41s (5×) |

The whole difference came from the **login**: the AI alone, in all 3 runs, also counted failures per IP and didn't reset the
IP on success — on a shared IP (an office, mobile data), whoever mistypes a password locks everyone out for 15 minutes. The
board got it right 2 out of 3 (the picking list carried the "rate limit by the real IP" lesson from memory), and the **QA
rejected**, in one run, a defect the answer key didn't even test: failing across the window boundary allowed 6 guesses in
1 second without a lock. **Reading:** on small, well-specified tasks the model alone is enough; the board pays off where the
rule isn't written and mistakes are expensive (security, money, production) — and charges ~4× the cost and ~5× the time for it.

---

## Installation

### 1. Requirements

The board **opens and runs tasks** with just the first group. The others turn on parts of it.

**Required**

| Tool | For |
|---|---|
| **Node.js 20+** | the server and the CLI |
| **[Claude Code](https://docs.claude.com/claude-code)** (`claude`), logged in | default engine, reviewer and QA |
| `git` | projects, parallel agents, PRs |

**Recommended** (the full experience)

| Tool | What it enables |
|---|---|
| `tmux` | `board agentes`: one tab per agent, showing the code it writes |
| [`ai-memory`](https://github.com/akitaonrails/ai-memory), by **Fabio Akita** | the shared memory server (Memory and Control menus). Install it from its release; the server, backup and fallback setup is in [`memoria/`](memoria/) |
| [Obsidian](https://obsidian.md) | browse the memory as a vault. The board's graph does **not** depend on the app, only on the mirror that `memoria-obsidian` creates |
| [`gh`](https://cli.github.com), logged in | delivery as a Pull Request |
| `rclone` with a `gdrive_backup` remote | backups to Google Drive and the memory fallback |
| `codex`, `agy`, `opencode` | extra engines and automatic handoff when a quota runs out |
| an always-on server reachable over SSH | where the memory and the backups run. Alias in `BOARD_SERVIDOR` |

**Optional**

| Tool | What it enables |
|---|---|
| `ollama` with `bge-m3` | task search and picking by meaning (`ollama pull bge-m3`). Without it, it goes by keyword, and the UI says so |

### 2. Where to put it

The board treats every folder **next to it** that has a `.git`, a `CLAUDE.md` or a `package.json` as a **project**:

```
~/projects/
├── board/            ← this repository
├── online-store/     ← becomes project "online-store"
└── payments-api/
```

```bash
cd ~/projects
git clone https://github.com/gilvanecesar/board-agentes board
cd board
cp board.env.exemplo board.env    # optional
./board.sh                        # http://localhost:4488, and it keeps itself running
```

There is no `npm install`: the board has no dependencies.

### Or with Docker (everything included: Node, git, tmux and Claude Code)

```bash
docker run -d --name board -p 127.0.0.1:4488:4488 \
  -e CLAUDE_CODE_OAUTH_TOKEN="$(cat ~/.claude-token)" \
  -v ~/projects:/projetos -v board-data:/app/data \
  ghcr.io/gilvanecesar/board-agentes:latest
```

or `docker compose up -d` with the [`docker-compose.yml`](docker-compose.yml). Claude Code inside the container needs
**one** credential: `CLAUDE_CODE_OAUTH_TOKEN` (to use your plan; generate it with `claude setup-token`) or
`ANTHROPIC_API_KEY`. The port is published **only on your machine's 127.0.0.1**, on purpose. Projects are mounted at
`/projetos`; the board and its settings live in the `board-data` volume. Delivery as a PR needs `gh`, which is not in
the image: without it, use direct delivery into the folder.

### 3. The `board` command (optional)

```bash
cp board ~/.local/bin/board        # or any other directory on your PATH
board                              # start it and keep it running
board abrir                        # open it in the browser
```

---

## Terminal usage

```bash
board list                          # the board
board add "text" <project>          # --fila (run now) · --pr (deliver as a PR) · --paralelo (⚡ its own agent)
board show 42                       # the task's timeline
board run 42 · stop 42 · done 42 · rm 42
board say 42 "use the helper that already exists in utils"
board pausar · retomar              # pause / resume the queue
board reiniciar                     # load new code once nothing is running
board agentes                       # tmux: one tab per agent
```

---

## Configuration

### `board.env`

| Variable | Default | What it does |
|---|---|---|
| `BOARD_PORT` | `4488` | UI port |
| `BOARD_MODELO` | CLI default | the agent's model |
| `BOARD_MODELO_REVISOR` / `BOARD_MODELO_QA` | `sonnet` | the reviewers' model |
| `BOARD_PARALELO` / `BOARD_POR_PROJETO` | `4` / `1` | overall cap / agents per folder |
| `BOARD_MOTOR` | `claude` | default engine (`codex`, `gemini`, `opencode`) |
| `BOARD_REVISOR` / `BOARD_QA` | on | `0` turns the step off |
| `BOARD_TIMEOUT_MIN` | `45` | time limit per task |
| `BOARD_PRODUCAO` | — | projects that **always** work in an isolated copy and deliver as a PR |
| `BOARD_DONO` | — | your name, in the rules the agents get |
| `BOARD_ROMANEIO` | on | `0` turns the picking list off |
| `BOARD_SERVIDOR` | `saturno` | SSH alias of the server (Monitoring and Control) |
| `BOARD_ESPELHO_MEMORIA` | `~/Documents/Memoria/ai-memory` | where the memory mirror is |
| `BOARD_BUSCA_PROVEDOR` | `ollama` | `ollama`, `openai`, `cohere` or `lexico` |

### Files in `data/` (outside git)

| File | For |
|---|---|
| `mentes.json` | the minds, each project's mind, the keyword hints, the themes and the approved addressing. Example: [`docs/mentes.exemplo.json`](docs/mentes.exemplo.json) |
| `backups.json` | the backups the Control screen watches. Example: [`docs/backups.exemplo.json`](docs/backups.exemplo.json) |
| `portao.json` | each project's check command: `{"online-store": "npm run check && npm test"}` |
| `deploy.json` | the deploy command. **Empty on purpose:** writing in it is authorizing the board to deploy on its own |
| `modelos.json` | the model for each task size on engines other than Claude |

---

## More screens

**Usage**: each engine's plan, read from its own CLI, and the board's spend per role.

![Usage](docs/img/consumo.png)

**Monitoring**: a map of the whole system with its real state: the 4 engines connected to the memory, the board
copying its data to the server, the databases sending backups, and the server taking everything to Drive. Green, red
or gray (no reading). *(In this screenshot, the database names were changed.)*

![Monitoring](docs/img/monitoramento.png)

**"Have I dealt with this?"**: search shows first what the memory knows.

![Search in memory](docs/img/busca-na-memoria.png)

---

## Security and limits

- **Local.** The UI listens on `127.0.0.1` only. Whoever opens it makes agents run commands in your folders: don't expose the port.
- **The agent never merges or deploys on its own.** PR delivery stops at the PR; deploying requires the command in `data/deploy.json`, a green gate and an approved review.
- **One task opens one PR.** Fix-up rounds continue on the existing PR's branch.
- **No credentials in the repository.** Tokens and keys stay in the CLIs themselves or in `600` files outside the repo.
- **Monitoring and Control** expect a server reachable over SSH (`BOARD_SERVIDOR`) with backup logs in `/var/log/backup-*.log`. Without it, those two screens show "no reading", and everything else works normally.

---

## How it's built

| File | Role |
|---|---|
| `board.mjs` | the entry point: loads `servidor/` and starts the port and the queue |
| `servidor/` | one module per subject: config, state, projects and copies, engines, rules, pipeline, conversation, queue, tasks, usage and quota, memory, control, monitoring, attachments, HTTP |
| `web/` | the UI, no build: `index.html` (skeleton), `estilo.css` and one script per screen in `js/` |
| `board-cli.mjs` | the `board` CLI |
| `busca.mjs` | semantic task search (embeddings), falling back to keyword search |
| `board.sh` | keeps the server running; a restart requested from the UI exits with code 75 and comes back in 1 s |
| `memoria/` | the shared memory setup: server, backup, fallback and mirror |
| `test/` | 145 tests (`npm test`, ~50 s, `node:test` only): the functions that decide on their own, the whole board in an isolated sandbox with fake `claude`, `codex`, `agy`, `opencode`, `ai-memory`, `ssh`, `rclone` and `docker` speaking each one's real format, and the UI in a headless Chrome — no real agent, no cost. Measured coverage: 95% of the server's functions and 94% of the UI's |

**The tests bite:** 61 defects planted on purpose (a verdict that approves with no verdict, production running in the
owner's folder, the gate skipped, the agent's HTML running in the UI, memory deleted without confirmation, a manual backup
counted as automatic…) and all 61 failed. GitHub runs the suite on every PR.
**Refactor without changing anything:** `npm run fotografia` records the content and computed style of 32 screens and 19
routes, with fixed data and a frozen clock; before and after a change, both must come out identical.

License: [MIT](LICENSE).

---

## Credits

- **[ai-memory](https://github.com/akitaonrails/ai-memory)**, by **Fabio Akita** ([@akitaonrails](https://github.com/akitaonrails)), MIT license:
  the long-term memory shared between the agents, with MCP and automatic capture. It is what the board reads to draw
  the graph and the warehouse, build the picking list and check the backups. The board **neither bundles nor modifies**
  ai-memory: it is installed separately, from its official release.
- **Ours:** the board and the setup in [`memoria/`](memoria/) (server, backup, fallback and mirror), and the idea of
  treating memory as a warehouse: minds, addresses, picking list.
- The engines are the vendors' own CLIs: [Claude Code](https://docs.claude.com/claude-code) (Anthropic),
  [Codex](https://github.com/openai/codex) (OpenAI), Antigravity/`agy` (Google) and [opencode](https://github.com/sst/opencode).
  The board only calls them; each has its own account, plan and terms.
