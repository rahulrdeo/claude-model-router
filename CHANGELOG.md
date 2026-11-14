# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## [2.3.2] - 2026-11-14

### Changed
- The classifier now sets a **score band** per complexity (`classifier.bands`), and the
  rules' score is held inside it: simple 0–29 (Haiku), moderate 30–64 (Sonnet),
  complex 48–74 (Sonnet high to Opus medium), architecture 65–74 (**Opus · medium**).
  This replaces `classifier.weight`, `classifier.floors` and `classifier.xhighRulesScore`
  from 2.3.0–2.3.1. The rules saturate on architecture prompts (often 95–100), so the
  2.3.1 "very large request" test still sent ordinary architecture prompts to xhigh.
- After a classifier verdict, Opus high and xhigh come only from negative feedback
  (+10 per message), `/route next` or an effort lock. Without a classifier answer, the
  rules decide alone as before, and they can still choose xhigh.

### Added
- The decision log records the prompt's word count (`words`).

### Documentation
- README: install, update, uninstall and troubleshooting by giving Claude Code the zip,
  with ready-to-paste prompts for Windows and macOS.

## [2.3.1] - 2026-11-14

### Changed
- Architecture requests classified by the classifier default to **Opus · medium**. The
  architecture floor is 65 (was 88), and the verdict is blended with the rules as before.
- xhigh for architecture needs the rules to score it at least `classifier.xhighRulesScore`
  (95), so only very large requests reach it.
- A classifier verdict is not unsure: the quality-first effort bump no longer applies on
  top of it. The bump still applies to the rules alone.

### Added
- Each log line carries the session ID.
- A `turn` event per main-loop turn records model, effort, duration and the engine's
  token usage, so effort levels can be compared on real work.

## [2.3.0] - 2026-11-14

### Added
- **Classifier.** Each new message is read by a small model (Haiku, low effort) together
  with an excerpt of the previous task and the last answer. It returns complexity
  (simple, moderate, complex, architecture), sentiment (approve, neutral, negative) and
  whether the message is feedback on the last result. Configurable as `classifier`.
- **Feedback memory.** Feedback on the last task inherits that task's level, so "thanks,
  looks good" no longer drops the level. Negative feedback raises it by
  `classifier.negativeBump` (10), so repeated complaints keep climbing.
- The decision log records `verdict` and `classifierMs`.

### Changed
- Feedback messages no longer enter the score history, so low-scoring feedback cannot pull
  the next real task down.
- New tasks are scored by the classifier's floor for their complexity, blended with the
  rules (`classifier.weight`, 0.7), still under the task type's ceiling.
- The classifier runs in auto, recommend and lock modes. Manual and off modes, and
  `/route next` prompts, skip it.
- A classifier failure or timeout falls back to the rules, as 2.2 does.

## [2.2.0] - 2026-11-14

### Changed
- **Scoring limits.** Bullets, file names, code blocks and stack traces now add at most
  `scoring.structureCap` (20) points together, instead of stacking to 60+.
- **Task-type ceilings.** Build, code and writing requests cap at `scoring.taskCeilings`
  (70: Opus medium at most). Architecture and debugging stay uncapped, so xhigh is still
  reachable for hard architecture work.
- Result: a plain webapp request goes to Sonnet · high; the same request with a bulleted
  spec goes to Opus · medium. Previously the spec reached Opus · xhigh (score 100).

### Added
- Config: `scoring` section (`structureCap`, `taskCeilings`), with validation.

## [2.1.1] - 2026-11-14

### Fixed
- The decision log's `ms` field now counts only the router's own work. Time that a
  recommend dialog was open, waiting for you, is no longer included.

## [2.1.0] - 2026-11-14

### Added
- **Build task type:** requests to create an app, site, dashboard, tool, game or UI
  ("create a self-contained webapp…") are recognised and scored between code and
  architecture, so a typical one goes to Sonnet at high effort. Configurable as
  `taskTypes.build`.

### Changed
- The cool-down (`minPromptsBetweenSwitches`) now starts only after a routed switch.
  Before, a new session behaved as if it had just switched, holding the first one-step
  change for two prompts.
- The first prompt of a brand-new conversation is routed without stickiness: there is
  no prompt cache to protect yet.
- Switching to off, manual or lock no longer starts a cool-down for the next routed switch.

### Fixed
- The status line's `rec` shows the recommendation before stickiness again, so `held`
  appears when the router keeps the current setting. The decision log has both
  `recommended` and the post-stickiness `target`.

## [2.0.0] - 2026-11-14

### Added
- **Three modes:** `auto` (analyse and apply), `recommend` (analyse, then you accept or
  change in one click) and a new `manual` (no analysis or recommendation; you choose).
  `/route recommend` is new; `off` and `lock` are unchanged.
- **Next prompt only:** `/route next <model> [effort]`, `/route next <effort>` and
  `/route next clear`. The override covers every request of the next prompt's turn, then
  the active mode resumes. Works in every mode and skips the recommend dialog.
- **Effort selection:** an effort level (low, medium, high, xhigh, max) picked with the
  model as one decision, from per-model effort bands over the same score and session
  context. The default ladder never uses Opus at low effort (Sonnet at high instead) and
  includes Opus at medium.
- **Quality first:** effort goes up one level when the analysis is unsure (the score is
  just under a boundary, or the prompt gives no signals); low effort only for clearly
  simple prompts.
- **Effort stickiness:** effort changes need a clear margin and a cool-down, since they
  rewrite the prompt cache like a model switch.
- **Escalation:** after an API error, a refusal, a test or build run still failing at the
  end of a turn, or a short "that didn't work" prompt, the next prompt goes one step up
  (more effort, then a stronger model). Auto and lock apply it; recommend recommends it;
  manual suggests it with a ready `/route next` command. The mod never re-sends a prompt.
- `/route effort auto` and `/route effort lock <level>`, remembered across sessions.
- Lock mode now picks the effort within the locked model's range (unless effort is locked).
- Config: `configVersion`, `effort` and `escalation` sections.
- Status line: mode, model and effort in use, the recommendation (auto and recommend),
  a pending next-prompt override and any escalation.
- Tests for all modes, next-prompt overrides, effort selection, effort stickiness,
  escalation and migration.

### Changed
- 1.x `manual` mode (ask before a switch) is renamed `recommend`. A saved `manual` mode
  and a 1.x config's `"defaultMode": "manual"` are migrated to `recommend` automatically.
- The default mode is now `recommend` (the same behaviour as 1.x's default).
- The recommend dialog and status line show model **and** effort (e.g. `Sonnet · high`).
- Decision log `recommended` and `chosen` fields are now `{ tier, effort }` objects.

## [1.0.0] - 2026-11-14

### Added
- Per-prompt model recommendation (Haiku, Sonnet, Opus) from local, deterministic
  analysis: task type, complexity, expected output size, and recent session context
  (follow-ups are judged with the conversation they continue).
- Modes: `auto`, `manual` (one-click accept or pick another model), `off`, and
  `lock <model>`, switchable at any time with `/route` and remembered across sessions.
- Stickiness: switch margin around tier boundaries plus a cool-down between switches,
  to protect prompt caching.
- Status line showing mode, model in use, base model, recommendation and reason.
- Commented JSONC config at `~/.claude/model-router/config.jsonc` (thresholds,
  keywords, model mappings, default mode, logging), validated field by field.
- Optional JSON-lines decision log with size-based rotation; `/route log on|off`.
- Fail-safe behaviour: routing errors never block a prompt; a refused model falls
  back to the session model and pauses routing.
- Unit tests for routing logic and engine tests for mode switching.
