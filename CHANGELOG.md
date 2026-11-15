# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-11-15

### Added
- **Chat-size note.** While the cache is warm, the band under the prompt says once the chat
  reaches `handoff.warnAtTokens` (150,000 by default; 0 turns it off): every turn re-reads the
  whole chat, so a fresh chat with `/handoff` is cheaper. It is not shown while the cache is cold,
  where the existing handoff button already appears for big chats.
- **Token totals per turn.** Each `turn` line in `routing.log` has a `totals` object: input,
  output, cache reads, cache writes and their sum, so Haiku and Opus turns can be compared
  with the session percentage directly.

## [1.0.0] - 2026-11-14

The first consolidated release. It covers all changes from the original build through the
earlier 2.x numbering (up to and including 2.9.0). Earlier per-version notes were not kept.

### Added
- **Routing.** Each prompt is routed to Haiku, Sonnet or Opus with an effort level. Modes:
  `auto`, `recommend`, `manual`, `off` and `lock <model>`. `/route next <model> [effort]`
  covers one prompt only, and `/route effort auto|lock <level>` sets effort.
- **Classifier.** A Haiku classifier (low effort) reads each new message with the last exchange
  and judges its complexity, sentiment and whether it is feedback. Feedback inherits the task's
  level; negative feedback raises it. Complexity maps to a score band (`classifier.bands`):
  simple 0–29 (Haiku), moderate 30–64 (Sonnet), complex 48–74, architecture 65–74 (Opus medium).
  Opus high and xhigh come only from negative feedback, `/route next` or an effort lock.
- **Task types.** Build (webapps, sites, dashboards, tools), code, writing and general types,
  with a structure cap (bullets, file names, code blocks and stack traces add at most 20 points)
  and per-type ceilings (build, code and writing cap at 70, Opus medium at most).
- **Stickiness and escalation.** Model and effort stay put to protect the prompt cache, with a
  cool-down that starts only after a routed switch. Failed tests or API errors escalate the next
  prompt; the router falls back to the session model after a routed model fails.
- **Subagent router.** Subagent runs are routed too. A risk rule sends risky tasks (for example
  anything that could lose data or touch production, credentials or payments) to Opus at
  `subagents.riskyAt` (75%).
- **Savings.** Each answer and subagent run is priced from its real token counts, on the model
  that ran and on the one it replaced. The Savings pane (`/route savings`, with `reset`) shows
  the net saving for the session and all time, with the router's own calls taken off. The
  per-item ledger is `cost-ledger.jsonl`.
- **Cache clock.** A countdown under the prompt to when the chat's prompt cache goes cold, with
  the cost of a keep-warm ping and of going cold. The band shows the session's saving once
  something is priced (`savings.enabled` and the cache clock must be on).
- **Keep warm.** One setting, switched from the band or `/route warm [on|off]`, that follows the
  session you type in. It sends up to `cacheClock.maxPings` (2) pings per pause, starts by itself
  only for chats of at least `cacheClock.autoStartMinTokens` (50,000), and stops after
  `cacheClock.maxMinutes`. Every ping is recorded in the savings ledger.
- **Handoffs.** `/handoff` writes a detailed prompt for a fresh chat, with a Handoff pane offering
  Start new chat, Copy and Continue here. It is written automatically at `handoff.autoAtTokens`
  (250,000 by default). Secrets are redacted before anything is sent to the helper.
- **Recommend mode.** A dialog asks which model and effort should run a prompt. Every choice is
  logged (`accepted`, `picked`, `declined` or `dismissed`).
- **Configuration and logging.** A commented JSONC config at `~/.claude/model-router/config.jsonc`
  with defaults for every setting, a status line, `/route status`, and an optional decision log
  (`routing.log`, JSON lines) switched with `/route log on|off`.

### Changed
- The earlier `manual` mode (ask before a switch) is now `recommend`. A saved `manual` setting is
  migrated, and a config without a `configVersion` is read as the earlier format.

### Removed
- An unused earlier copy of the hooks module. It caused a type warning in `claude plugin validate`.

### Fixed
- The log's `ms` field no longer includes the time a recommend dialog was open.
- A session you had left kept pinging its cache until its limits ran out. Each session now records
  when you last typed (`active.json`) and checks it before every ping.
