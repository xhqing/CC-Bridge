<div align="center">
  <img src="assets/logo.svg" alt="CC-Bridge" width="640">
</div>

# CC-Bridge — Claude Code upstream bridge framework

> [简体中文](README.zh-CN.md)

<div align="center">

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Built with Claude Code](https://img.shields.io/badge/Built%20with-Claude%20Code-19C37D)
![Type: Project](https://img.shields.io/badge/Type-Project-lightgrey)
<img src="https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/xhqing/xhqing/main/traffic/badges/CC-BRIDGE.json" alt="Visits/day (14d)" />

</div>

A local transparent bridge that lets **Claude Code talk to third-party model
upstreams** (GLM / DeepSeek / MiMo / Agnes …) through a single local endpoint. Each upstream
lives in its own adapter module under a `<name>-bridge/` directory and shares the
same framework (`core/`). Thinking fields pass through verbatim — the upstream
interprets Claude Code's `/effort` tier by its own official mapping (see
[Thinking level passthrough](#thinking-level-passthrough)). It also supports
**multiple API keys with automatic failover**.

> **Currently implemented:** `glm` (GLM-5.3 on z.ai / Zhipu bigmodel.cn), `ds`
> (DeepSeek-V4), `mimo` (Xiaomi MiMo), `agnes` (Agnes AI 2.5 — Anthropic-
> compatible endpoint; free promotional flash tier as of 2026-09). `kimi` / `qwen`
> are reserved placeholders — see [Adding a new upstream](#adding-a-new-upstream).

Install it once and start it from **any directory** with a single command:
`cc-bridge`.

## Why a bridge?

Claude Code can be pointed at a custom endpoint with plain config
(`ANTHROPIC_BASE_URL` + `ANTHROPIC_MODEL` in `~/.claude/settings.json`) — so why
run a bridge in between? Because config alone can't reconcile the two sides'
conflicting requirements on the request's `model` field:

- **Claude Code only accepts model IDs from its own whitelist** (`claude-opus-4-8`,
  `claude-haiku-4-5`, …). Point `ANTHROPIC_MODEL` at a real third-party model
  name (`glm-5.3`, `deepseek-v4`, …) and Claude Code rejects or ignores it.
- **The upstream routes by the `model` field** and only recognises its own real
  model names. Send it `claude-opus-4-8` and it has no model to serve.

So the client demands a Claude-style ID while the upstream demands a real one —
and there is only one `model` field. The bridge feeds Claude Code a whitelisted
spoof ID (`MODEL_MAP`, e.g. `claude-opus-4-8->glm-5.3`) and rewrites
`body.model` to the real target before forwarding. Message structure, tool
calls, and SSE events pass through verbatim.

Beyond making the two ends meet, the bridge adds things plain config can't
give you:

- **Multi-key failover** across accounts and endpoints (see
  [Multi-key failover](#multi-key-failover)).
- **Thinking passthrough** — `/effort` tiers are forwarded verbatim and the
  upstream applies its official tier mapping (GLM: xhigh/max → max; DeepSeek:
  max → max, xhigh → high; see each bridge's config template).
- **Request-body passthrough** — apart from the model rewrite and a couple of
  functional fixes, request bodies are forwarded exactly as Claude Code sent
  them (same shape as a direct connection); `max_tokens` is clamped to the
  model's real cap, and `API_KEY_n_HIDE_USER_ID=1` blanks `metadata.user_id`
  for keys where you prefer device identifiers not to leave your machine.
- **Safety-classifier routing** (`glm`) — Claude Code's auto-mode security
  monitor fires ~3× per agent turn at full model rates; route it to a free
  model or answer it locally at zero cost (`CLASSIFIER_MODE`).
- **modelUsage injection** — the bridge injects the real context window into
  responses: per-target values from the adapter's official-docs table by
  default, overridable via `CONTEXT_WINDOW` / `MAX_OUTPUT_TOKENS`, so the
  client's context display matches the actual model instead of the spoofed
  one.
- **Usage stats** (terminal + local dashboard) persisted across restarts.

## Available upstreams

| upstream | status | adapter | target model |
|----------|--------|---------|--------------|
| `glm` | ✅ implemented | [glm-bridge/](glm-bridge/) | GLM-5.3 (z.ai / Zhipu bigmodel.cn) |
| `ds` | ✅ implemented | [ds-bridge/](ds-bridge/) | DeepSeek-V4 (pro / flash) |
| `mimo` | ✅ implemented | [mimo-bridge/](mimo-bridge/) | MiMo-V2.5-Pro (Xiaomi) |
| `agnes` | ✅ implemented | [agnes-bridge/](agnes-bridge/) | Agnes-2.5 (flash / pro / pro-beta) |
| `hybrid` | ✅ implemented | [hybrid-bridge/](hybrid-bridge/) | multi-provider mix (per-model routing) |
| `kimi` | 🚧 reserved | [kimi-bridge/](kimi-bridge/) | — |
| `qwen` | 🚧 reserved | [qwen-bridge/](qwen-bridge/) | — |

## What it does

- **Framework + per-upstream adapters.** All upstream-agnostic logic (HTTP
  server, multi-key failover, model rewriting, modelUsage injection, daemon) lives
  in [`core/`](core/). Each upstream's specifics (model caps, functional body
  fixes) live in its `<name>-bridge/adapter.js`. Adding an upstream
  touches only one new file + one registry line.
- **Hybrid multi-provider upstream.** The `hybrid` upstream serves several
  providers behind one port. Its config lists one section per member provider
  (`GLM_BASES` / `GLM_API_KEY_1` / `DS_BASE` / `DS_API_KEY_1` … — any
  implemented upstream can be a member), and `MODEL_MAP` targets carry a
  `provider:` prefix (`claude-opus-4-8->glm:glm-5.3,claude-haiku-4-5->ds:deepseek-v4-flash`;
  the prefix can be omitted when exactly one configured provider knows the
  model). Each request routes to its target's provider — keys rotate and fail
  over within that provider only (cross-provider failover would just 400), and
  each member adapter's body fixes still apply. See
  [hybrid-bridge/README.md](hybrid-bridge/README.md).
- **Request-body passthrough.** Each adapter's job is minimal: rewrite
  `body.model` (spoof → target), clamp `max_tokens` to the model's real cap,
  and apply genuinely functional fixes only (e.g. DeepSeek's tool-sequence
  repair — the endpoint's validator would 400 otherwise). Everything else —
  `context_management`, `cache_control`, Anthropic-only system blocks,
  `metadata.user_id`, thinking fields — is forwarded exactly as the client
  sent it, matching the shape of a direct connection (see each
  `<name>-bridge/README.md`).
- **Safety-classifier routing (GLM).** Claude Code's auto mode runs a security
  monitor that fires before every tool call (~3× the main conversation's request
  count) at full model rates — measured at ~70% of a z.ai Coding Plan quota.
  `CLASSIFIER_MODE` in `~/.cc-bridge/glm.env` routes these requests to a free
  model (`on`) or answers them locally with a canned allow (`off`, the default —
  zero cost, no safety judgment). See
  [glm-bridge/README.md](glm-bridge/README.md).
- **Thinking passthrough.** The bridge rewrites nothing about thinking —
  `/effort` tiers are forwarded verbatim and each upstream applies its
  official tier mapping (GLM: xhigh/max → max; DeepSeek: max → max, xhigh →
  high; MiMo: any thinking tier = deep thinking on). (See
  [Thinking level passthrough](#thinking-level-passthrough).)
- **Multi-key failover.** Configure multiple keys as numbered variables
  (`API_KEY_1=…`, `API_KEY_2=…`, … — one per line, so each can carry its own
  comment and be disabled by commenting out the line; legacy comma-separated
  `API_KEY=k1,k2` still works). When a key returns `401`/`403` (rejected /
  exhausted), the bridge marks it blocked for 60 s and immediately retries with
  the next key. Transient errors (`429`/`5xx`/network) are first retried on the
  same key, then fall over. Keys are tried in `API_KEY_n_PRIORITY` order
  (highest first, numeric order as fallback), so a primary key is used until it
  trips its breaker and backups only serve as failover. The URL never changes —
  only the key rotates. (See [Multi-key failover](#multi-key-failover).)
- **Per-upstream isolation.** Each upstream has its own config
  (`~/.cc-bridge/<upstream>.env`), pid file, and log file, so several upstreams
  can run as daemons side by side (use different `PROXY_PORT`s).
- **modelUsage injection (real context window).** The bridge injects a
  `modelUsage` entry into every response (both under the spoof ID and the
  target), so the client's context-window display matches the actual model —
  without it, the client would show the spoofed model's window. Context-window
  values come from each adapter's official-docs table per target model
  (e.g. glm-5.3 = 1M, glm-4.6 = 200K), so a multi-pair `MODEL_MAP` gets each
  window right; explicitly setting `CONTEXT_WINDOW` / `MAX_OUTPUT_TOKENS` in
  the upstream's env overrides the table.
- **Usage stats in the terminal + a local dashboard.** `cc-bridge stats`
  prints terminal tables aggregated by key-name and by model across all
  upstreams, with a hint pointing at the richer view. `cc-bridge dashboard`
  opens a local browser dashboard (127.0.0.1, one-time token) where you pick a
  start/end time — or a quick window (today / last 7 days / last 30 days /
  all) — and get the full detail: overview cards (requests / input / cache-hit
  / hit rate / cache-created / output), an hourly trend chart by upstream
  (requests / input / output switchable, auto day-merging past 48 buckets),
  and detail tables by upstream, by key-name and by model, merged across all
  upstreams. Usage is persisted in hourly buckets
  (`~/.cc-bridge/stats-<upstream>.json`, 30-day rolling retention, survives
  daemon restarts), so the dashboard works even when the daemon is stopped.
  The dashboard is built to grow — the usage-stats module is its first block
  and later features will join it as sibling modules.
- **Zero runtime dependencies.** Node ≥ 14 built-ins only.

## How it works

```
                              ┌── KEY #1 ──┐
Claude Code ──POST /v1/messages──▶  cc-bridge (127.0.0.1:8787)
  model = <spoof ID>                · rewrite body.model → real target   ├── KEY #2 ──┤  upstream · target
                                    · adapter.adaptRequestBody(body)     │  (failover)│
                                    · on 401/403 → rotate to next key   └────────────┘
                                    · inject modelUsage into the response
                                      (real context window for the client)
```

The upstream is chosen by the `<upstream>` argument (default `ds`). The bridge
loads `core/adapter.js` → the upstream's `adapter.js`, and applies that adapter's
`adaptRequestBody` to every forwarded request.

## Prerequisites

- **Node.js ≥ 14** and **npm**, reachable from your PATH.
  - Homebrew users: if `which node` prints nothing, the keg isn't linked. Run
    `brew link --overwrite node@22`, and make sure `/opt/homebrew/bin` is on your
    PATH (add `export PATH="/opt/homebrew/bin:$PATH"` to your shell rc if missing).

## Install

CC-Bridge is distributed as a build tarball on GitHub Releases (the repo is
public, so download with `gh` or `curl`):

```bash
gh release download v2.0.0 --pattern 'cc-bridge-2.0.0.tgz' --dir /tmp --clobber
npm install -g /tmp/cc-bridge-2.0.0.tgz
```

> Permission denied? Either `sudo npm install -g …`, or set a user-writable
> prefix once (`npm config set prefix ~/.local`, ensure `~/.local/bin` is on
> PATH) and re-run without sudo.

After install, `cc-bridge` is on your PATH from any directory. The install
automatically prepares `~/.cc-bridge/ds.env` (a copy of `ds.env.example`) for
the default upstream — fill in your API key and you're ready to
`cc-bridge start`. If the file already exists, it is left untouched.

## Configure

Each upstream's config lives at `~/.cc-bridge/<upstream>.env` (user-level, found
from any working directory). For GLM:

```bash
cc-bridge glm config        # opens ~/.cc-bridge/glm.env in $EDITOR (template generated on first run)
cc-bridge glm config show   # prints current values (API_KEYs masked)
cc-bridge glm config path   # prints the config file path
cc-bridge glm config --import /path/to/.env   # migrate an existing .env
```

```ini
# ~/.cc-bridge/glm.env  — GLM (z.ai international + Zhipu bigmodel.cn)
# Multiple endpoints: bind each key to its provider; key rotation fails over
# across endpoints (a dead z.ai key switches to the Zhipu key automatically).
API_BASES=zai->https://api.z.ai/api/anthropic,cn->https://open.bigmodel.cn/api/anthropic
# One key per numbered line — comment each with its account, or comment out a
# line to disable that key. Legacy comma-separated API_KEY=k1,k2 still works,
# and a single API_BASE=url is still accepted (one-endpoint setups).
# KEY_NAME  = display name for per-key usage stats (cc-bridge stats); must be
#            unique within the config — the key itself is never shown or stored.
# KEY_BASE  = which API_BASES endpoint this key uses (default: the first one).
# KEY_PRIORITY = non-negative integer; the highest-priority key is used first,
#            lower ones only kick in when it trips its breaker (failover order).
#            Omit everywhere to keep the numeric order (legacy behavior).
# account A (z.ai Coding Plan, primary)
API_KEY_1=your_zai_key_1
API_KEY_1_NAME=zai-work
API_KEY_1_BASE=zai
API_KEY_1_PRIORITY=10
# account B (Zhipu bigmodel.cn, backup)
API_KEY_2=your_zhipu_key_2
API_KEY_2_NAME=zhipu-cn
API_KEY_2_BASE=cn
# MODEL_MAP: spoof->target pairs (comma-separated). opus is Claude Code's main model,
# haiku its fast one — both routed to glm-5.3. First pair is the "main" pair (the
# default model when launching claude). Legacy single-pair SPOOF_MODEL/TARGET_MODEL
# still work.
MODEL_MAP=claude-opus-4-8->glm-5.3,claude-haiku-4-5->glm-5.3
PROXY_PORT=8787
PROXY_LOG=1                             # 0 to silence per-request logging
```

> **Routing:** `MODEL_MAP` maps one or more spoof IDs to real target models
> (`spoof->target` pairs). An incoming `model` matching a spoof is rewritten to that
> pair's target; one already equal to a target is passed through unchanged. Anything
> else is **rejected with HTTP 400** — never silently rewritten. The legacy
> single-pair `SPOOF_MODEL` / `TARGET_MODEL` keys still work (equivalent to one pair).

## Usage

```bash
cc-bridge start           # default upstream (ds), background (detached)
cc-bridge daemon          # alias for 'start' (background)
cc-bridge claude [args]   # start bridge + launch claude pointed at it
cc-bridge stop            # stop the background service
cc-bridge restart         # restart the background service (stop + start)
cc-bridge status          # show running status
cc-bridge stats           # terminal usage stats for ALL upstreams (aggregated)
cc-bridge <upstream> stats  # terminal stats for one upstream
cc-bridge dashboard       # open the local usage dashboard in your browser (time window,
                          # trend chart, by upstream / key & model detail)
cc-bridge stats --gui     # alias of 'dashboard'
cc-bridge logs            # tail the bridge log (Ctrl-C to exit)
cc-bridge health          # probe /health
cc-bridge set default upstream [name]  # show / set the default upstream
cc-bridge help            # full help

cc-bridge glm start       # explicit upstream
cc-bridge kimi start      # reserved upstream → reports "not implemented"

cc-bridge set default upstream glm  # make glm the default for bare commands
cc-bridge set default upstream      # show the current default
cc-bridge set default upstream --reset  # restore the built-in default (ds)
```

> **Default upstream:** bare commands (`cc-bridge start`, `cc-bridge restart`, …)
> target the default upstream. The built-in default is `ds`; `set default upstream`
> persists your choice at `~/.cc-bridge/default-upstream` (only implemented
> upstreams are accepted) and every subsequent bare command follows it. `--reset`
> clears the file and restores the built-in default.

`cc-bridge claude` exports the bridge env for that `claude` process only and
cleans the bridge up on exit:

```bash
cc-bridge claude -p "hello"
cc-bridge claude -- -p "hello"   # "--" separator also accepted
```

### Making `claude` use the bridge persistently

`cc-bridge` (start / daemon) only runs the service in the background — your normal `claude`
won't use it automatically. Pick one:

- **One session:** `cc-bridge claude` (handles env + cleanup for you).
- **Manual, with the service running:**
  ```bash
  export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
  export ANTHROPIC_API_KEY="$(grep -E '^API_KEY' ~/.cc-bridge/glm.env | head -1 | cut -d= -f2- | cut -d, -f1 | tr -d '\"')"
  export ANTHROPIC_MODEL=claude-opus-4-8
  claude
  ```
  (The bridge rotates its own configured keys; `ANTHROPIC_API_KEY` here just
  needs to be non-empty so the `claude` CLI is willing to send requests.)
- **Persistent:** set `ANTHROPIC_BASE_URL` and `ANTHROPIC_MODEL` in the `env`
  block of `~/.claude/settings.json`. (`claude` then only works while the bridge
  is running.)

No thinking config is needed — the bridge forwards Claude Code's `/effort`
tier verbatim and the upstream applies its official mapping (see
[Thinking level passthrough](#thinking-level-passthrough); for max thinking on
GLM pick xhigh or max, on DeepSeek pick max). The bridge logs each
request, including the key in use:

```
[bridge 2026-07-24T03:00:00.000Z] POST /v1/messages  model=claude-opus-4-8 → glm-5.3  effort=xhigh  stream=true  key=#1/2
[bridge …]   ← 200  812ms  ct=text/event-stream  key=#1
```

(The `effort` field in the log records the tier the client sent — it is
forwarded verbatim to the upstream.)

## Multi-key failover

Configure multiple keys as numbered variables (`API_KEY_1=…`, `API_KEY_2=…`,
`API_KEY_3=…` — one per line; legacy comma-separated `API_KEY=k1,k2,k3` also
works). They share one `API_BASE`. The bridge decides when to rotate per request:

| upstream signal                          | bridge action                                                   |
|------------------------------------------|-----------------------------------------------------------------|
| `401` / `403` (key invalid / exhausted)  | block this key for 60 s, **immediately** retry with the next key |
| `429` / `5xx` / network transient        | retry on the **same** key (up to 2×, 200 ms / 500 ms backoff); if still failing, rotate to the next key |
| `400` / `404` (non-transient business error) | forward to the client as-is — rotating keys won't help      |
| every key exhausted                      | return the last error to the client (401/403 → `authentication_error`, else `api_error`) |

- **Block is a soft optimization, not a hard gate.** A key blocked by `401`/`403`
  is skipped for 60 s so each request doesn't pay the cost of re-hitting a known
  dead key. After 60 s it's retried. If all keys happen to be blocked, the
  least-bad one is still tried.
- **Transient errors don't block keys.** A `5xx` or network blip is the gateway's
  problem, not the key's — no key is penalized.
- **Key priority.** Each key may carry `API_KEY_n_PRIORITY` (a non-negative
  integer). Keys are tried highest-priority-first; ties keep the numeric order,
  and keys without a priority act as `0`. This makes the rotation order a
  primary/backup arrangement: the top key serves all traffic until it trips its
  breaker, and once its 60 s block expires the bridge returns to it
  automatically. Omit `PRIORITY` everywhere to keep the plain numeric order.
- **Bounded retries.** Each request tries at most `keys × (1 + 2 retries)` calls,
  so failover always terminates.
- **Per-key privacy option.** Each key may carry `API_KEY_n_HIDE_USER_ID=1` —
  requests forwarded with that key blank `metadata.user_id` (the device /
  session identifier Claude Code attaches automatically). Unset or `0` keeps
  the field verbatim. Useful when you'd rather device identifiers not leave
  your machine; set per key independently.

## Thinking level passthrough

The bridge does not rewrite thinking fields. Claude Code's `/effort` tier
(`thinking` / `output_config.effort` in the request body) is forwarded
verbatim, and each upstream interprets it by its own official mapping:

- **GLM-5.3** (docs.bigmodel.cn): low/medium/high → high; xhigh/max/ultracode
  → max. Default tier is max.
- **DeepSeek-V4** (V4-Flash-0731 / V4-Pro-0813, api-docs.deepseek.com): the
  mapping is identical for both models — low → low; medium/high/xhigh → high;
  max → max. Claude Code-style agent requests are auto-set to max by the
  endpoint. ⚠️ `none` is not accepted (400).
- **MiMo**: thinking is on/off only; any thinking tier (low and above) turns
  deep thinking on.
- **Agnes-2.5** (wiki.agnes-ai.com): the Anthropic-compatible endpoint accepts
  the `thinking` field (`{type: "enabled", budget_tokens}`); the gateway
  outputs thinking blocks **by default** (observed even when not requested —
  Claude Code handles them fine). No official `/effort` tier mapping is
  published; thinking fields pass through verbatim. The endpoint is overseas —
  set `UPSTREAM_PROXY` in the env file if a proxy is required to reach it.

Mappings are as of 2026-08 and may change per model version — check the
official docs (links in each `<name>-bridge/<name>.env.example`).

## Adding a new upstream

CC-Bridge is built to grow. To add an upstream (e.g. `kimi`):

1. **Create the adapter** at `kimi-bridge/adapter.js`, implementing the adapter
   interface (see [glm-bridge/adapter.js](glm-bridge/adapter.js) and the comments
   in [core/adapter.js](core/adapter.js)):
   - `name`, `displayName`, `defaultTarget`, `defaultSpoof`
   - `modelMaxTokens` (`{ modelId: maxOutputTokens }`)
   - `adaptRequestBody(obj, ctx)` — adapt the Anthropic request body for this
     upstream; `ctx = { target }`
2. **Register it** in [core/adapter.js](core/adapter.js): set `implemented: true`
   for `kimi`.
3. **Document it** in `kimi-bridge/README.md` and add a config template if needed.

That's it — the framework, CLI, multi-key failover, and daemon all work
unchanged. Users then run `cc-bridge kimi start`, edit `~/.cc-bridge/kimi.env`,
etc.

To serve several providers behind one port instead of adding another
single-provider adapter, use the built-in `hybrid` upstream — it composes any
implemented adapters with per-model routing and needs no new adapter code (see
[hybrid-bridge/README.md](hybrid-bridge/README.md)).

## Files

| path                     | purpose                                            |
|--------------------------|----------------------------------------------------|
| `bin/cc-bridge.js`       | CLI entry — `[upstream] <command>` dispatch        |
| `core/server.js`         | the bridge server: model rewrite, multi-key failover, modelUsage injection, hourly-bucket usage stats |
| `core/adapter.js`        | upstream registry + adapter loader                 |
| `core/config.js`         | per-upstream config find / edit / import / show    |
| `core/stats.js`          | usage-stats snapshot reader + time-window aggregation (CLI text & dashboard) |
| `core/gui.js` + `core/gui.html` | local dashboard (module 1: usage stats): 127.0.0.1 one-time-token server + browser page |
| `core/daemon.js`         | background process management (per-upstream pid + log) |
| `core/claude.js`         | start bridge + launch `claude` through it          |
| `core/util.js`           | port cleanup / health probe / readiness wait       |
| `glm-bridge/adapter.js`  | GLM (z.ai / Zhipu bigmodel.cn) adapter — body adaptation, model caps |
| `ds-bridge/adapter.js`   | DeepSeek (DeepSeek-V4) adapter — body adaptation, tool-sequence repair |
| `mimo-bridge/adapter.js` | MiMo (Xiaomi MiMo-V2.5-Pro) adapter — body adaptation, model caps |
| `agnes-bridge/adapter.js` | Agnes AI (Agnes-2.5) adapter — model caps; overseas endpoint, optional `UPSTREAM_PROXY` |
| `hybrid-bridge/adapter.js` | hybrid multi-provider adapter — per-model routing across providers (composes the concrete adapters) |
| `kimi-bridge/`, `qwen-bridge/` | reserved placeholders (adapter + README)    |
| `<name>-bridge/<name>.env.example` | per-upstream config template (GLM / DeepSeek / MiMo / Agnes / Hybrid filled; Kimi/Qwen reserved) |
| `~/.cc-bridge/<upstream>.env` | real config (yours, gitignored, never packaged) |
| `~/.cc-bridge/stats-<upstream>.json` | usage stats snapshot (hourly buckets, survives restarts; feeds `cc-bridge stats` / `cc-bridge dashboard`) |
| `~/.cc-bridge/default-upstream` | user-set default upstream (created by `set default upstream`; absent = built-in `ds`) |

## Notes / caveats

- Only `POST /v1/messages` (excluding `/v1/messages/count_tokens`) gets its
  `model` rewritten. Other paths (`/v1/models`, …) are forwarded unchanged.
- **Unknown models are rejected with HTTP 400, not silently rewritten.**
- `package.json` `files` excludes `.env`; real keys are never packaged into the
  global install.
- Thinking fields are forwarded verbatim; how the upstream interprets the
  `/effort` tier is up to the upstream (official mappings per model in each
  config template).
- Request bodies are forwarded in the same shape a direct connection would
  send, apart from the model rewrite and the functional fixes listed in each
  bridge's README. This is a design choice, not a compliance claim — how any
  upstream treats bridged traffic is entirely up to the upstream and its
  terms of service.

## Versioning

This project follows [Semantic Versioning](https://semver.org/). The current
version lives in [VERSION](VERSION); all changes are recorded in
[CHANGELOG.md](CHANGELOG.md).

## Development

This directory is the **development workspace** — the source you edit and push to
git. End users install a published build tarball. The flow is: edit here → test →
bump version → publish → install.

```bash
git clone <repo> && cd CC-Bridge
node --check core/*.js bin/cc-bridge.js glm-bridge/adapter.js   # syntax check after edits
cc-bridge glm start                                             # run from source (background)
```

### Cutting a release

1. Bump `VERSION` and `package.json` `version` (keep them in sync).
2. Add a `## [X.Y.Z] - YYYY-MM-DD` entry at the top of `CHANGELOG.md`.
3. `git commit -a -m "release vX.Y.Z"` then `git tag vX.Y.Z`.
4. `npm pack` → upload `cc-bridge-<ver>.tgz` to the GitHub Release.
5. Install from the Release on the target machine (see [Install](#install)).

## License & Attribution

CC-Bridge is released under the **MIT License** — see [LICENSE.md](LICENSE.md).

Copyright (c) 2026 **All Contributors**.

**Attribution:** If you find CC-Bridge useful, an acknowledgement is appreciated (but not required). Please preserve the copyright notice and license file in any copy or derivative, and link back to the source: https://github.com/xhqing/CC-Bridge.
