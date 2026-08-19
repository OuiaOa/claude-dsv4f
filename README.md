# dsv4shim

Claude Code driven by **DeepSeek V4 Flash 0731** instead of Anthropic models, with per-task
thinking effort, image support, spend tracking and daily caps.

Your normal `claude` is untouched — this installs a separate profile under `~/.dsv4shim`
and never reads your Anthropic credentials.

## Install

Three commands per platform — download, unpack, install. `dsv4shim setup` prompts for your
DeepSeek API key and finishes the rest.

**Linux / macOS / WSL**

```bash
cd ~/Downloads
curl -L -o dsv4shim.zip https://github.com/OuiaOa/dsv4shim/archive/refs/heads/main.zip
unzip -q dsv4shim.zip && cd dsv4shim-main
./install.sh
dsv4shim setup
```

**Windows 11 (PowerShell)**

```powershell
cd $HOME\Downloads
curl.exe -L -o dsv4shim.zip https://github.com/OuiaOa/dsv4shim/archive/refs/heads/main.zip
tar -xf dsv4shim.zip
cd dsv4shim-main
powershell -ExecutionPolicy Bypass -File .\install.ps1
# open a new terminal so PATH updates
dsv4shim setup
```

**macOS GUI alternative** — `Finder` double-click on `install.command` does the same as the
three shell lines above.

**Prerequisites** — Node 20+ (`node --version`) and the Claude Code CLI already installed
(`claude --version`). `dsv4shim setup` will prompt you to install either automatically if they're
missing and the installer can reach npm. Full step-by-step with troubleshooting is in
[INSTALL.md](INSTALL.md).

Optionally `dsv4shim key deepinfra` to enable screenshots — DeepSeek's endpoint cannot accept
images, so they are transcribed by a vision model first.

## Use

```
dsv4shim run                      launch Claude Code
dsv4shim run --effort ultracode   full fan-out
dsv4shim status                   shim state and stored keys
dsv4shim-usage                    spend, burn rate, balance
dsv4shim cap 10                   daily DeepSeek cap
dsv4shim cap vision 3             daily vision cap
```

On first `dsv4shim run` your existing memories, session transcripts and permissions are imported
from `~/.claude`. The walk is recursive: subagent transcripts (`<session>/subagents/*.jsonl`)
and tool-result blobs (`<session>/tool-results/*`) come across too, so subagent sessions
appear in `--resume`. Transcripts are scrubbed of thinking-block signatures (which DeepSeek
cannot validate) and image blocks (unsupported), without which old sessions cannot be resumed.
Re-run manually any time with `dsv4shim-import --force`. If `~/.claude` is missing or lives
elsewhere, run `dsv4shim-import --source <path>` (or pass `--source` through `dsv4shim run`).

Sessions are keyed by directory, so `cd` into a project and `dsv4shim run --resume` finds its
history — including sessions originally created by the Claude Code desktop app, which writes
to the same `~/.claude/projects` tree.

## How it works

Claude Code is pointed at a local shim on `127.0.0.1:8788` rather than at Anthropic. The shim:

- **translates effort levels.** Claude Code emits `low|medium|high|xhigh`; the endpoint accepts
  `low|medium|high|xhigh|ultra|max` (measured, not documented). Ultracode means `xhigh`, which
  DeepSeek treats as an unknown variant, so it is rewritten to `max` — that rewrite is what
  makes ultracode work at all.
- **chooses effort per task.** Background calls (titles, summaries) run with thinking off;
  routine turns at `high`; detected-hard turns at `ultra`; `ultrathink` or ultracode at `max`.
  A level you set explicitly is never overridden.
- **routes images.** Image blocks are swapped for text descriptions from a vision model.
  Descriptions are cached by image hash and replayed byte-identically, which both avoids
  re-describing and keeps the prompt prefix stable for DeepSeek's 50x cache-hit discount.
  Say what you need from a screenshot, or write `VISION: <what to look for>`.
- **keeps the ledger.** Neither provider exposes a usage API, so per-request cost is computed
  locally, per provider, and enforced against separate daily caps.
- **holds the key.** The real API key never enters Claude Code's environment; Claude Code
  authenticates to the shim with a locally generated sentinel.

## Claude Desktop / Cowork

The shim also works as a Gateway for Claude Desktop and Cowork — it's the same
Anthropic-compatible `/v1/messages` endpoint the CLI already uses, so no separate mode or
process is needed. In Desktop's Gateway settings:

- **Gateway URL**: `http://127.0.0.1:8788` (or your configured `port`/`bind`)
- **Auth**: either `Authorization: Bearer <sentinel>` or `x-api-key: <sentinel>` — the sentinel
  is the same one at `~/.config/dsv4shim/sentinel` the CLI profile already uses.
- **Discover Models**: `GET /v1/models` returns four logical tiers — Fable, Opus, Sonnet,
  Haiku — each a Claude-looking model ID (`claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`,
  `claude-haiku-4-5-20251001` by default; see `desktop.tierModelIds` below to change them).

All four tiers resolve to the single configured `model` only — the shim force-sets the
outgoing model on every request regardless of tier, so there is no path to a different or
pricier upstream model. Reasoning defaults per tier (used only when Desktop doesn't send its
own explicit effort/thinking preference — an explicit one always wins): Fable and Opus default
to `max`, Sonnet to `high`, Haiku to thinking-disabled. See `effort.tierDefaults` below.

Everything else — streaming, tool calls, images (via the same vision sidecar), long contexts —
works exactly as it does for the CLI, since Desktop and the CLI share this one endpoint.

## Files

| | |
|---|---|
| `~/.config/dsv4shim/` | keys (0600), `config.json`, caps, probe results |
| `~/.local/share/dsv4shim/` | code, `usage.jsonl` ledger, vision cache |
| `~/.dsv4shim/` | the isolated Claude Code profile |

## Is your vision setup any good?

```bash
node vision-bench/bench.mjs
```

Nine locally-generated fixtures covering fine print, low contrast, a photographed form at an
angle, spatial overlap, orientation and partial occlusion. About a cent and 90 seconds. See
[vision-bench/README.md](vision-bench/README.md), including how to score your own images.

## Tests

```bash
node test-shim.mjs        # unit tests against a mock endpoint, no spend
./e2e/run-e2e.sh all      # real sessions against the real API (costs a few cents)
```

## Configuration

`~/.config/dsv4shim/config.json`. Every key below is read at shim start; restart after
editing (`dsv4shim stop && dsv4shim start`, or `systemctl --user restart dsv4shim-shim`).

| key | meaning |
|---|---|
| `port` | shim listen port (loopback only). `DSV4SHIM_PORT` overrides. |
| `model` | the only model allowed. Anything else is refused, so a stray config cannot bill a pricier model. |
| `modelSlots` | maps the sentinel model ids Claude Code sends to a slot: `main`, `subagent`, `background`. |
| `denyModelPatterns` | hard-refused substrings. Ships with `deepseek-v4-pro`. |
| `effort.slotDefaults` | effort per slot. Background is `none` (thinking off). |
| `effort.translate` | Claude Code's vocabulary → the endpoint's. `xhigh → max` is what makes ultracode work. |
| `effort.autoLevel` | the level treated as "no preference". Claude Code sends a level on *every* request, so explicit-vs-default is otherwise unobservable. |
| `effort.heuristic` | scoring for auto-escalation; `enabled: false` turns it off entirely. |
| `rates` | USD per million tokens, with the cache-hit/miss split. |
| `peakSurcharge` | DeepSeek announced 2× peak pricing but has not activated it. Enable if it goes live. |
| `trafficPolicy` | Local concurrency, pacing and helper output limits that keep ultracode/swarm fan-out bounded on pay-as-you-go DeepSeek. |
| `cap.dailyUsd` | DeepSeek daily cap. Overridden by the `cap` file / `dsv4shim cap`. |

### Sibling-safe ports

`port` is the preferred port. At startup dsv4shim checks whether it is live or reserved by
another local service and walks upward to the next usable port when necessary. It remembers the
selected port in `~/.local/share/dsv4shim/active-port.json`, so the profile, statusline and
updater keep following an automatic shift.

Installed sibling configs with a numeric `port` in `~/.config`, `~/.local/share`, or the local
Codex workspace are treated as reservations even when the sibling is stopped. Every shim also
records its claim in the shared `~/.config/codex-port-reservations.json` registry; future local
programs can participate by writing an entry with their name and port. Set
`CODEX_SHIM_PORT_REGISTRY` only when testing or intentionally using a separate registry.
| `vision.*` | model, endpoint, rates, `dailyCapUsd`, and `promptVersion` — bumping the last invalidates every cached description. |
| `desktop.tierModelIds` | external Claude-looking model IDs Desktop discovers via `/v1/models`, one per logical tier (`opus`/`sonnet`/`fable`/`haiku`). Optional — omitting it falls back to the same IDs built into `shim.mjs`. |
| `effort.tierDefaults` | reasoning-effort default per Desktop tier, used only when the client sends no explicit effort of its own. Optional, same fallback pattern as above. |

## Troubleshooting

**`shim is not responding`** — `dsv4shim status`, then `dsv4shim start`. On Linux with systemd:
`journalctl --user -u dsv4shim-shim -n 50`. Otherwise the log is
`~/.local/share/dsv4shim/shim.log`.

**Images say "description unavailable"** — no DeepInfra key on this machine. `dsv4shim key
deepinfra`, or ignore it if this box does not need screenshots.

**`daily cap reached`** — `dsv4shim cap 10` to raise it. Note `0` means *disabled*, not zero.

**A session will not resume** — transcripts imported from `~/.claude` are scrubbed of thinking
signatures and images, but a session created by a much older client may still not replay.
Starting fresh in the same directory always works; your code and `CLAUDE.md` are what matter.

**Costs look wrong** — `dsv4shim-usage --reconcile` cross-checks the local ledger against actual
balance drawdown and derives your real cache-hit ratio. Neither provider exposes a usage API,
so the ledger is the only per-request record.

## Known limitations

- **No image *generation*, and no document blocks.** DeepSeek's Anthropic-compatible endpoint
  accepts neither; images are transcribed to text, documents are dropped with a note.
- **`/cost` inside Claude Code reports $0.** It prices from an embedded table keyed on model
  name, which a `deepseek-*` id misses. Use `dsv4shim-usage`, or the statusline.
- **Only `/v1/messages` is proxied.** Other paths are refused rather than forwarded, because
  anything forwarded would bill your key without appearing in the ledger or the cap.
- **Web search** is an Anthropic server-side tool and is not available.
- **Caps are per machine.** Four machines at $5/day is a $20/day ceiling in aggregate.

## Development

```bash
node test-shim.mjs        # 77 unit tests against mock endpoints — no network, no spend
./e2e/run-e2e.sh all      # real sessions against the real API (a few cents)
./e2e/run-e2e.sh tools    # tool coverage only, no vision
./package.sh out.tar.gz   # build a portable archive
```

The shim calibrates itself from `probe-results.json`, written by `probe.mjs` during setup —
the endpoint's real effort enum, whether the usage object reports the cache split, and whether
`count_tokens` exists were all determined by measurement, because the published documentation
contradicts itself on two of them and is silent on the third.

## Licence

MIT — see [LICENSE](LICENSE).

By Ouia Oa.
