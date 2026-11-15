# model-router for Claude Code

A Claude Code mod that picks **Haiku, Sonnet or Opus** and an **effort level** (low, medium, high, xhigh, max) for each prompt, and can switch to them for you.

- **Auto mode**: each prompt is analysed and runs on the recommended model and effort, no questions asked.
- **Recommend mode**: when the recommendation differs from what you're running, a dialog shows it with a short reason. Accept it with one click or pick another.
- **Manual mode**: no analysis and no recommendation. You choose the model and effort yourself.
- **Next prompt only**: `/route next opus high` uses Opus at high effort for your next prompt, then goes back to your mode. Works in any mode.
- **Escalation**: if a response fails (an API error, tests still failing, or you say it's wrong), the next prompt gets more effort or a stronger model. Auto applies it; the other modes suggest it.
- **Sticky by design**: model and effort change only when the difference is clear, so you don't keep losing the prompt cache.
- **Transparent**: the status line shows the mode, the model and effort in use, and (in auto and recommend) the recommendation and why.
- **Subagent Model Router (cheaper subagents)**: before a subagent starts, Haiku reads its task and picks the model. A simple lookup goes to Haiku, a well-defined job to Sonnet, and hard jobs stay on Opus. A side pane shows each pick and how sure Haiku was.
- **Handoff (long chats)**: at 250,000 tokens, or when you type `/handoff`, a helper on Sonnet reads the whole chat and writes a detailed handoff prompt, with keys and passwords blanked out. Copy it, or click **Start new chat** and carry on fresh without losing context.
- **Risky subagent tasks run on Opus**: Haiku also rates how much harm a subtle mistake could do; a task rated risky (data loss, production, credentials, migrations...) runs on Opus whatever else it says.
- **Savings pane**: every answer and every subagent run is priced from its real token counts, on the model that ran and on the one that would have run without the router. `/route savings` shows what you saved this session and in all, with the router's own costs taken off.
- **Your pick wins**: if you change the model or effort yourself (the app's menu, `/model`), the router keeps your choice and only recommends until you type `/route resume`.
- **Cache Clock (cold chats)**: after each reply, a countdown above the prompt shows how long until the chat's cache goes cold and the next message costs full price. Click **Keep warm** and it pings the cache just before it runs out.

Works the same on **Windows and macOS**, in the **terminal** and in the **Desktop app's Code tab**. It's a pure mod: no bash or PowerShell scripts, no Node install, nothing to compile.

---

## How it works

| Step | What happens |
|---|---|
| 0. Classifier | A small model (Haiku, low effort) reads the new message with the previous task and the last answer, and returns its complexity, its sentiment and whether it is feedback on the last result. Feedback inherits the level of the task it refers to; negative feedback raises it. If the classifier fails or times out, the rules decide alone. |
| 1. Prompt submitted | A `prompt.submit` hook scores the prompt from 0 to 100: length, task type (architecture, build, debugging, code, writing, quick Q&A), complexity keywords, code blocks, stack traces, file names and numbered requirements. |
| 2. Context | The score is blended with recent prompts in the session. A short follow-up such as *"now do the same for billing"* is mostly judged by the conversation it continues, however long ago that was. |
| 3. Model | `< haikuMax` → Haiku, `≥ opusMin` → Opus, anything else → Sonnet. |
| 4. Effort | Each model has effort bands over the same score (see [Effort levels](#effort-levels)), so model and effort are one decision. |
| 4a. Limits | Structure (bullets, file names, code blocks) adds at most `scoring.structureCap` points, and build, code and writing requests stop at their `taskCeilings`. A long spec for a simple app therefore lands on Opus medium, not xhigh. |
| 5. Quality first | When the analysis is unsure (the score sits just under a boundary, or the prompt gives nothing to go on), effort goes up one level. Low effort is only used for clearly simple prompts. |
| 6. Stickiness | Model and effort change only when the score clears a boundary by a margin, and not again until a few prompts after a routed switch. The first prompt of a brand-new conversation has no cache to protect, so it is routed without stickiness. |
| 7. Mode | Auto applies the result. Recommend asks only when it would change something. Manual skips steps 1–6 entirely. |
| 8. Switch | A `turn.step` hook sends each main-loop request of the turn with the chosen model and effort. Subagents are routed separately (see [Subagent Model Router](#subagent-model-router-cheaper-subagents)). |

Analysis is local and deterministic (well under a millisecond), so there's no noticeable delay and no extra API call.

**Good to know**

- The router never changes your `/model` or effort settings. It overrides them per request, so `/model` and the Desktop model picker keep showing the **session (base) model**, and the status line shows what is actually used, for example `Router auto · Sonnet · high (base claude-opus-5-5)`.
- Changing the model *or the effort* makes Claude Code rewrite the prompt cache. That's why both are sticky. If you're on the first-party API and want effort changes to keep the cache, set `CLAUDE_CODE_MODEL_CAPABILITIES=per_turn_effort` in your environment (a Claude Code setting, not part of this mod).
- A model that doesn't support an effort level gets the nearest level it does support, or none at all. Claude Code handles that.

---

## Requirements

- Claude Code **2.1.325 or newer** (the version whose mod API this was built and tested against), in a terminal or the Claude Desktop app (Code tab).
- Access to the models you route to. If you're on Bedrock, Vertex or a gateway, set `models` in the config to the IDs your provider uses (see [Configuration](#configuration)).

---

## Install

The easiest way is to give Claude Code the zip and let it install the mod for you. It works the same on Windows and macOS, in a terminal or in the Desktop app's Code tab.

### Recommended: let Claude Code install it

1. **Download** `claude-model-router.zip` from this repository (the file in the repo, or the latest release).
2. **Open Claude Code** in any folder: a terminal session, or a session in the Desktop app's Code tab.
3. **Give Claude the zip.** Drag it into the prompt box if your Claude Code accepts file attachments. Otherwise, put the zip's full path in the prompt below.
4. **Paste this prompt** (replace the path if you didn't attach the zip):

```text
Install the Claude Code mod in claude-model-router.zip (attached, or at: <full path to the zip>).

1. Unzip it into a folder that will stay where it is:
   - macOS / Linux: ~/claude-mods/claude-model-router
   - Windows: %USERPROFILE%\claude-mods\claude-model-router
   If that folder already exists, show me what's in it and ask before replacing it.
2. Before installing, read .claude-plugin/plugin.json and hooks/register.tsx and tell me in a
   few lines what the mod does, which files it reads and writes, and what it sends anywhere.
3. Install it for my user from that folder:
   claude plugin install model-router --marketplace <that folder>
   If the claude command isn't on my PATH, use the Claude Code executable that is running
   this session.
4. Run "claude plugin list" and confirm model-router is enabled, with its version.
5. Tell me to start a new session to load it.
```

5. **Start a new session.** The status line under the prompt shows `Router recommend · …`.
6. **Check and choose a mode** in the new session:

```text
/route status
```

```text
/route recommend
```

Use `/route auto` instead if you want switches without being asked, or `/route manual` for no analysis. To keep a log of each decision and its token use, also run `/route log on`.

Claude Code reads the mod from the folder in step 1, so **don't move or delete that folder**.

### Update to a new version

Download the new zip, open Claude Code, attach the zip (or use its path), and paste:

```text
Update my model-router Claude Code mod from the new claude-model-router.zip (attached, or at:
<full path to the zip>).

1. Run "claude plugin list" and find the folder model-router is read from ("Read from").
2. Replace that folder's contents with the zip's claude-model-router folder. Show me the old
   and new version from .claude-plugin/plugin.json first, and ask before replacing.
3. Don't touch my settings and logs in ~/.claude/model-router (Windows:
   %USERPROFILE%\.claude\model-router).
4. Run "claude plugin update model-router" and tell me the version it now reports.
5. Tell me to start a new session.
```

Read the CHANGELOG for what changed. Your config file keeps working across versions; new settings use their defaults until you add them.

### Uninstall

```text
Uninstall the model-router Claude Code mod.

1. Run "claude plugin uninstall model-router" and "claude plugin marketplace remove model-router".
2. Show me the folder it was installed from and ask before deleting it.
3. Ask me separately before deleting ~/.claude/model-router (Windows:
   %USERPROFILE%\.claude\model-router), which holds my config and logs.
```

The router never changed your `/model` or effort settings, so nothing else needs restoring.

### If something doesn't work

```text
My model-router Claude Code mod isn't working. Run "claude plugin list" and show me the
model-router entry, run "claude plugin validate" on the folder it's read from, and show me
the last 20 lines of ~/.claude/model-router/routing.log if it exists. Then tell me what's wrong.
```

See also [Troubleshooting](#troubleshooting).

### Install by hand (no prompts)

1. Unzip `claude-model-router.zip` somewhere permanent:
   - macOS: `~/claude-mods/claude-model-router`
   - Windows: `C:\Users\<you>\claude-mods\claude-model-router`
2. Install from that folder:

   macOS:
   ```bash
   claude plugin install model-router --marketplace ~/claude-mods/claude-model-router
   ```
   Windows (PowerShell or cmd):
   ```
   claude plugin install model-router --marketplace C:\Users\<you>\claude-mods\claude-model-router
   ```
3. Start a new Claude Code session, or run `/reload-plugins` in an open one.

### Install straight from GitHub

This only works if the repository holds the **unzipped** mod: `.claude-plugin/` must be at the top of the repository. It won't work if the repository only holds the zip.

```bash
claude plugin install model-router --marketplace rahulrdeo/claude-model-router
```

**In the Desktop app:** click **+** next to the prompt box, then **Plugins** → **Add marketplace**. Enter `rahulrdeo/claude-model-router`, then click **Add plugin**.

### Upgrading from 1.x

- 1.x's **manual** mode (ask before a switch) is now called **recommend**. A saved `manual` mode and a 1.x config file's `"defaultMode": "manual"` are both read as `recommend`, so nothing you see changes. **manual** now means no analysis at all.
- Your existing `config.jsonc` keeps working. The new effort and escalation settings use their defaults until you add them. To get the new commented template, rename or delete the file and start a session. `/route status` tells you when the file is in the 1.x format.
- The dialog and status line now show model **and effort**, e.g. `Sonnet · high`.

---

## The three modes

| | Auto | Recommend | Manual |
|---|---|---|---|
| Analyses each prompt | yes | yes | no |
| Shows a recommendation | in the status line | in the status line and a dialog | no |
| Changes model / effort | automatically | after your click | only when you say so |
| `/route next` | yes | yes | yes |
| On a failed response | applies the higher setting to your next prompt | recommends it in the next dialog | suggests it in a notification |

Your last mode is **remembered across sessions**. Until you choose one, `defaultMode` from the config is used (out of the box: `recommend`).

### Auto

```
/route auto
```

Type your prompts as usual. The status line updates on each prompt:

```
Router auto · Sonnet · high (base claude-opus-5-5) · rec Sonnet · high · code, medium complexity, medium output (score 56)
```

`· held` means the router recommended something else but kept the current setting because of stickiness.

### Recommend

```
/route recommend
```

When the recommendation differs from what you're running, a dialog appears before the prompt runs:

> You're on Opus · high. Recommended: Haiku · low — quick-qa, low complexity, small output (score 0). Which model and effort should run this prompt?
> 1. Haiku · low (recommended)
> 2. Keep Opus · high (current)
> 3. Haiku · medium
> 4. Sonnet · low

- **Accept:** press **Enter** or **1**.
- **Choose another:** pick an option, or type under **Other**, e.g. `opus xhigh`, `sonnet`, or just `high`. A missing part is filled in sensibly.
- **Esc** keeps what you're running, and the prompt still runs.

If nothing would change, there's no dialog. Set `"manualAskOnlyOnChange": false` to be asked every time. In non-interactive runs (`claude -p`, SDK) nobody can answer, so nothing changes.

### Manual

```
/route manual
```

No analysis, no recommendation, no dialog. You choose:
- **Model:** Claude Code's own `/model` (the router stops overriding it).
- **Effort:** the session's own, or `/route effort lock <level>`.
- **One prompt:** `/route next <model> [effort]`.

### Off and lock (unchanged from 1.x)

- `/route off`: the router does nothing except `/route next`. The session's own model and effort are used.
- `/route lock <haiku|sonnet|opus>`: always that model. The router still picks the **effort** per prompt within that model's range (for example Opus at medium for a quick question, high or xhigh for hard work), unless you also run `/route effort lock`.

---

## Next prompt only

```
/route next opus high     # Opus at high effort
/route next sonnet        # Sonnet; effort as usual
/route next max           # current model at max effort
/route next clear         # cancel
```

The override applies to every request of your next prompt's turn, including tool steps, and then your mode takes over again. It works in every mode, including off, and skips the recommend dialog. The status line shows `next: Opus · high` until it's used.

---

## Effort levels

```
/route effort auto            # the router picks the effort (default)
/route effort lock high       # always low, medium, high, xhigh or max
```

Both are remembered across sessions. An effort lock applies in auto, recommend, manual and lock modes; off mode ignores it.

**Default ladder** (auto mode; scores 0–100):

| Score | Model · effort |
|---|---|
| 0–14 | Haiku · low (only when clearly simple; otherwise medium) |
| 15–29 | Haiku · medium |
| 30–47 | Sonnet · medium |
| 48–64 | Sonnet · high |
| 65–74 | Opus · medium |
| 75–89 | Opus · high |
| 90–100 | Opus · xhigh |

The ladder never uses Opus at low effort: a task that would get it runs on Sonnet at high effort instead. Bands for the other scores (for example Haiku · high, Sonnet · xhigh) are used when a model is locked or escalated. Everything here is in the config file.

**Quality first:** when a score is within `uncertaintyMargin` (4) of a model or effort boundary, or the prompt gives no signals at all, the effort goes up one level, up to `maxLevel` for that model.

---

## Escalation after a failure

A response counts as failed when:
- the turn ended in an **API error** or a **refusal**;
- a **test or build run** (`npm test`, `pytest`, `cargo build`, `tsc`, `make` …; configurable) was **still failing** at the end of the turn. A failure that Claude fixed later in the same turn doesn't count;
- your next prompt is a **short complaint** (*"that's wrong"*, *"still failing"*, *"try again"* …; configurable).

The next step up is more effort on the same model (up to `raiseEffortUpTo`), then the next model at high effort or more:

`Haiku · low → Haiku · medium → Sonnet · high → Opus · high → Opus · xhigh → Opus · max`

| Mode | What happens |
|---|---|
| Auto, lock | Your next prompt runs one step up, past stickiness. The status line shows `escalating to … (reason)`. Lock mode only raises the effort. |
| Recommend | The next dialog recommends the higher setting, with the reason. You decide. |
| Manual | A notification suggests it with a ready command, e.g. `/route next opus xhigh`. Nothing changes unless you run it. |
| Off | Ignored. |

The mod never re-sends a prompt by itself. The higher setting applies to the prompt you send next.

---

## When you pick a model or effort yourself

The router overrides each request; it never changes your settings. So when you choose a model in the app's menu or with `/model`, or change the effort, the router notices on the next request (or at your next prompt) and steps back:

- Your choice runs from that request on. A notification says so, and the status line ends with `keeping your model (/route resume)`.
- The router still analyses each prompt and shows its recommendation, but doesn't switch what you picked. If you only changed the effort, it can still pick the model, and the other way round.
- `/route resume`, or choosing a mode (`/route auto`, `/route recommend`, ...), lets it switch again. `/route effort auto|lock` hands back the effort.
- `opus` and `claude-opus-5-5` (or a `[1m]` variant) count as the same model, so a different spelling isn't mistaken for a pick.

## Subagent Model Router (cheaper subagents)

Every subagent normally runs on the same model as your main chat. With this mod, before a subagent starts, Haiku reads its task (type, short description and prompt) and picks the model:

| Haiku's pick | Typical task | What runs |
|---|---|---|
| Haiku | a simple lookup: find files, grep, read and report, list things | Haiku |
| Sonnet | a well-defined job: implement or fix something specified, write tests, a focused investigation | Sonnet |
| Opus | a hard job: design, subtle bugs, judgement-heavy research, large refactors | stays on Opus |

- **Risk.** Haiku also rates how much harm a subtle mistake in the task could do (0–100%): read-only work is low; changing code that tests check is middling; anything that could lose data or touch production, credentials, payments, security, migrations or deletions is high. From `subagents.riskyAt` (75%) the task runs on **Opus**, whatever the tier, the confidence or `allowUpgrade` says, so it can cost more than without the router. Under an Opus main chat it keeps that exact model (a `[1m]` variant stays as it is). The pane marks it "risky", and the Savings pane shows what the rule added. Turn it off with `subagents.riskyToOpus: false`.
- **Confidence.** Haiku also says how sure it is (0–100%). Below `subagents.minConfidence` (60%) the subagent keeps the main chat's model.
- **Only cheaper by default.** A pick above the main chat's model is capped at it (`subagents.allowUpgrade: false`).
- **Left alone:** a subagent whose Agent call already names a model (`keepCallerModel`), forks (they always inherit), resumed agents, teammates, and everything while `/route off` is on. If Haiku fails or times out (4 s), the subagent starts on the main chat's model, as before. If the picked model is refused, the subagent starts on the main chat's model.
- **The pane.** "Subagent models" opens beside the chat on the first subagent of a session (or with `/route agents`). Each row shows the pick, Haiku's confidence, the agent type and description, Haiku's reason, what it runs on, and whether it is running or done. The header counts picks per model and the average confidence.
- `/route agents off` turns it off (remembered); `/route agents on` turns it back on. It works in auto, recommend, manual and lock modes.

## Savings

Type `/route savings` to open the **Savings** pane.

The cache clock band under the prompt also shows a running line, "saved $X this session" (or "extra $X"), once something has been priced. It needs the cache clock and `savings.enabled` on.

- **What is priced.** When each main-chat answer and each subagent run ends, Claude Code reports its real token counts (input, output, cache reads, cache writes). The mod prices them at list price twice: on the model that actually ran, and on the model that would have run without the router. For the main chat that's your session's model; for a subagent, the model its Agent call named, else its parent's.
- **Honest about switches.** A model switch makes the new model rebuild the chat's cache, which your own model would simply have read. When that happens, those tokens are priced as cache reads on the "without the router" side, so the switch's cost is charged to the router. A switch back to your model can therefore show as **extra**.
- **What is taken off.** The router's own calls (the prompt classifier and Haiku's subagent picks) are subtracted from the saving. Handoffs and keep-warm pings are listed as spending you chose, and not subtracted.
- **The pane shows:**
  - the net saving and its share, for this session and in all since you started (or reset)
  - main chat and subagents separately: how many, how many moved to another model, the cost, what it would have cost, and the difference
  - the extra cost of risky tasks sent to Opus
  - the latest items, each with its saving or extra
- **The ledger.** `~/.claude/model-router/cost-ledger.jsonl` gets one JSON line per priced item: time, session, kind, the model that ran and the one it replaced, both costs, and a short label. It holds no prompt text. Turn it off with `savings.ledger: false`.
- `/route savings reset` starts the all-time total again. `savings.enabled: false` stops the tracking.
- **Limits, plainly:**
  - These are estimates at list prices, not your bill. Change `savings.prices` for Bedrock, Vertex or a discount.
  - Effort changes aren't priced, because what a different effort would have produced is unknown.
  - Haiku's higher rate for prompts over 100K tokens isn't applied.
  - A subagent type with its own model in its definition is compared with its parent's model.

## Handoff (long chats)

When a chat gets long, every message re-reads all of it. The handoff lets you continue in a fresh, short chat without losing the thread.

- **When:** automatically once the context reaches 250,000 tokens (`handoff.autoAtTokens`; once per long chat), or any time you type `/handoff`.
- **Warning:** while the cache is warm, the band under the prompt says once the chat reaches 150,000 tokens (`handoff.warnAtTokens`; 0 turns it off), since every turn re-reads the whole chat.
- **How:** a helper on **Sonnet** (`handoff.model`) reads the whole chat and writes a detailed handoff prompt: goal, current state with exact paths and commands, decisions and constraints, open problems, ordered next steps and key context. Long tool output is trimmed first; only if the chat is still larger than `handoff.maxInputChars` are messages from the middle left out (never the first request or the latest exchanges). It runs in the background, so your chat isn't blocked.
- **Secrets stay out.** Known key and password formats (API keys, cloud and GitHub tokens, private keys, JWTs, passwords in URLs and `password=` style settings) are blanked out of the transcript before the helper reads it, and out of the handoff before it is saved, copied or opened. The pane says how many were blanked. This catches common formats, not every secret, so read the handoff before you share it.
- **The Handoff pane** shows the prompt with four buttons:
  - **Start new chat**: opens a new chat in the Claude desktop app with the handoff already typed in; check it and press Enter. A handoff too long for a link (about 8,000 characters on Windows) opens with its beginning and a pointer to the saved file, and the whole handoff is also put on your clipboard. Without the desktop app, the handoff is copied instead.
  - **Copy**: puts it on your clipboard. Paste it as the first message of a new chat.
  - **Continue here**: restarts this same chat from the handoff. The conversation is compacted to a one-line note and the handoff is added as the message the model reads next. Works everywhere, including the terminal.
  - **Rewrite**: writes it again.
- Typed equivalents: `/handoff new`, `/handoff copy` and `/handoff here`.
- Each handoff is also saved as Markdown in `~/.claude/model-router/handoffs/` (`handoff.saveToFile`).
- `/route handoff off` turns the automatic handoff off (remembered); `/handoff` still works.

## Cache Clock (cold chats)

Claude Code caches the chat between messages. While the cache is warm, your next message re-reads the chat at the cheap cache-read price; once it goes cold, the whole chat is read again at full price.

- After each reply, a band above the prompt shows **Cache warm 4:12 · then your next message costs full price (180k tokens)**. It turns amber in the last minute and shows **Cache cold** once it has run out.
- **Keep warm** pings the cache `cacheClock.pingLeadSeconds` (30 s) before it runs out: one tiny question ("reply OK") over the chat's own cached transcript, which refreshes the cache. It stops after `cacheClock.maxPings` (2) pings or `cacheClock.maxMinutes` (90) minutes, whichever comes first, when you send a message, or when you click **Stop**.
- **Keep warm follows you.** It is one setting for all your sessions, not a button per session. Click **Keep warm** (or run `/route warm on`) once, and from then on it starts by itself after each reply in the session you are typing in. When you start typing in another session, the first one stops: each session notes when you last typed (in `~/.claude/model-router/active.json`) and checks it right before every ping, so no ping is sent to a chat you have left. **Stop** (or `/route warm off`) switches it off in every session. If you walk away from the session you are in, the limits above still apply.
- **What keep warm costs.** Each ping re-reads the whole cached chat (about a tenth of the normal input price per token) and thinks at the session's effort level. It is wasted if you don't come back during the pause. The band shows the estimate. On a 120k-token Opus chat at the default prices, that's **a ping ~$0.024, going cold ~$0.600** while idle, and **keeping warm, ping 1/2 at ~$0.024 each** while warming. These are cache costs before any thinking, at the prices in `savings.prices`. Every ping is also recorded in the savings ledger, with a note when its price is not known.
- **Only for chats where it matters.** Keep warm starts by itself after a reply only when the chat is at least `cacheClock.autoStartMinTokens` (50,000) tokens; below that a cold restart is cheap, and the band says **not started: chat under 50k tokens**. Clicking **Keep warm** starts it at any size.
- **A big chat that went cold** (over half the handoff threshold) gets a **Write handoff** button: resuming it costs a full re-read anyway, so a short new chat from a handoff may be cheaper.
- **Cache lifetime** is worked out, best evidence first: a reply after a pause of more than 5 minutes that was still served from the cache proves a one-hour cache (one that had to be rebuilt proves five minutes); otherwise what Claude Code's requests ask for; otherwise 5 minutes. What it proves is remembered for later sessions. Set `cacheClock.ttlMinutes` to fix it yourself.
- `/route clock off` hides the band (remembered).

## All commands

| Command | What it does |
|---|---|
| `/route` or `/route status` | Shows mode, effort mode, base and active model and effort, pending next-prompt override, last decision, escalation, config and log paths, and warnings |
| `/route auto` · `/route recommend` · `/route manual` · `/route off` | Switch mode (remembered) |
| `/route lock <haiku\|sonnet\|opus>` | Always use that model (`/route lock` alone uses `defaultLockModel`) |
| `/route next <model> [effort]` · `/route next <effort>` · `/route next clear` | Next prompt only |
| `/route effort auto` · `/route effort lock <level>` | Effort picked per prompt, or pinned (remembered; `lock` alone uses `defaultLockLevel`) |
| `/route log on` · `/route log off` | Decision log on or off (remembered) |
| `/route reload` | Re-read the config now, and resume routing if it was paused after a model error |
| `/route resume` | Let the router switch again after you picked a model or effort yourself |
| `/route agents` · `/route agents on\|off` | Show the subagent pane, or turn the subagent router on or off (remembered) |
| `/handoff` · `/handoff new` · `/handoff copy` · `/handoff here` | Write a handoff now; open it in a new desktop-app chat; copy it; restart this chat from it |
| `/route handoff` · `/route handoff on\|off` | Show the Handoff pane, or turn the automatic handoff on or off (remembered) |
| `/route clock on\|off` | Show or hide the cache clock (remembered) |
| `/route warm [on\|off]` | Keep warm for the session you type in; stops in sessions you left (remembered). Alone, shows the setting |
| `/route savings` · `/route savings reset` | Show the Savings pane; start the all-time total again |
| `/route help` | List the commands |

---

## Configuration

The config file is created with defaults on the first run:

| OS | Path |
|---|---|
| macOS | `~/.claude/model-router/config.jsonc` |
| Windows | `%USERPROFILE%\.claude\model-router\config.jsonc` |

If you set `CLAUDE_CONFIG_DIR`, it's `$CLAUDE_CONFIG_DIR/model-router/config.jsonc` instead.

It's JSON with comments (`//`, `/* */` and trailing commas are fine), and every field is documented inline. Edits take effect on the next prompt. Use `/route reload` to apply them immediately and see any warnings. An invalid value is ignored with a warning and its default kept, so a typo never breaks routing. Delete the file to restore every default.

**Editing on Windows:** Notepad and VS Code both work. Save as UTF-8 (with or without BOM); Windows line endings are fine. Inside JSON strings, write paths with `\\` or `/`.

| Key | Default | Meaning |
|---|---|---|
| `configVersion` | `2` | File format; leave it |
| `defaultMode` | `"recommend"` | `auto`, `recommend`, `manual`, `off` or `lock`, used until you choose with `/route` |
| `defaultLockModel` | `"sonnet"` | Model for `/route lock` with no argument |
| `models.haiku` / `.sonnet` / `.opus` | aliases | What's sent to the API: an alias or a full model ID, e.g. a Bedrock or Vertex ID |
| `thresholds.haikuMax` / `opusMin` | `30` / `65` | Model boundaries on the 0–100 score |
| `thresholds.switchMargin` | `8` | How far past a model boundary a score must go to switch |
| `thresholds.minPromptsBetweenSwitches` | `2` | Cool-down after a routed model or effort change (skipped for two-step jumps; none before the first switch) |
| `context.*` | see file | How earlier conversation and follow-ups count |
| `classifier.enabled` | `true` | Turn the classifier on or off. Off means the rules alone decide, as in 2.2 |
| `classifier.model` / `classifier.effort` | `haiku` / `low` | The model and effort that read each message |
| `classifier.timeoutMs` | `3000` | Give up after this long and fall back to the rules (500–10000) |
| `classifier.negativeBump` | `10` | Points added to the task's level by each negative feedback message |
| `classifier.bands.<complexity>` | simple 0–29, moderate 30–64, complex 48–74, architecture 65–74 | The score range each complexity maps to. The rules' score is held inside it: architecture lands on Opus · medium, and higher levels come from escalation, `/route next` or an effort lock. Raise `max` to allow more (75–89 is Opus high, 90+ xhigh) |
| `scoring.structureCap` | `20` | Bullets, file names, code blocks and stack traces together add at most this; a long spec is more text, not a harder task |
| `scoring.taskCeilings.<type>` | `build`, `code`, `writing`: `70` | Highest score a task type can reach. 70 is the top of the Opus medium band, so these never get xhigh on their own. Architecture and debugging are uncapped. Setting this object replaces the defaults, so list every type you want capped |
| `taskTypes`, `complexityBoosters`, `simplifiers`, `largeOutputKeywords` | see file | Keywords that set the task type and move the score |
| `manualAskOnlyOnChange` | `true` | Recommend mode: ask only when something would change |
| `effort.defaultMode` | `"auto"` | `auto` or `lock`, used until you choose with `/route effort` |
| `effort.defaultLockLevel` | `"high"` | Level for `/route effort lock` with no argument |
| `effort.bands.<model>` | see ladder above | `[{ "from": score, "level": effort }, …]` in rising order |
| `effort.maxLevel.<model>` | haiku `high`, sonnet `xhigh`, opus `max` | Highest level the router picks for each model |
| `effort.uncertaintyMargin` | `4` | How close below a boundary counts as unsure (→ one level more) |
| `effort.lowMaxScore` | `12` | Low effort only when the prompt's own score is at most this |
| `effort.switchMargin` | `5` | How far past an effort boundary a score must go to change effort |
| `escalation.enabled` | `true` | Turn escalation on or off |
| `escalation.raiseEffortUpTo.<model>` | haiku `medium`, sonnet `high`, opus `max` | Raise effort up to this, then move up a model |
| `escalation.feedbackKeywords` / `feedbackMaxWords` | see file / `40` | What counts as "that didn't work" |
| `escalation.testCommandPatterns` / `failurePatterns` | see file | What counts as a test or build run, and as a failure |
| `logging.enabled` / `maxBytes` / `includePromptExcerpt` | `false` / `1000000` / `false` | Decision log |

**Tuning tips**

- **Too many switches:** raise `switchMargin`, `effort.switchMargin` or `minPromptsBetweenSwitches`.
- **More quality:** raise `effort.uncertaintyMargin`, lower the `from` of the higher effort bands, or lower `opusMin`.
- **Lower cost:** raise `haikuMax` and `opusMin`, or lower `effort.maxLevel`.

### Decision log

With logging on, each event is one JSON line in `routing.log`, next to the config: each `turn` line now has a `totals` object (input, output, cache reads, cache writes and their sum) for comparing turns against your session percentage.

```json
{"ts":"2026-11-14T10:02:11.000Z","event":"route","mode":"auto","effortMode":"auto","score":0,"ownScore":0,"type":"quick-qa","complexity":"low","output":"small","followUp":false,"from":{"tier":"opus","effort":"high"},"recommended":{"tier":"haiku","effort":"low"},"chosen":{"tier":"haiku","effort":"low"},"decision":"auto-switch","model":"haiku","effort":"low","ms":0}
```

**Events:**
- `route` (one per prompt)
- `next`
- `failure`
- `mode`
- `effort-mode`
- `error`

**`decision` values:** `auto-switch`, `escalated`, `held`, `kept`, `accepted`, `picked`, `declined`, `dismissed` or `next-override`.

Prompt text is **not** logged unless `includePromptExcerpt` is `true`. Lines end in `\n` on every OS.

---

## Token use and the log

Each turn is logged with its model, effort, duration and the token usage the engine reports (`event: "turn"`). Each line also carries the session ID, so entries from different sessions can be told apart. To compare two settings, group the `turn` lines by `effort` and read `usage` for each.

## Privacy and the classifier

With the classifier on, each new message is sent to the classifier model together with an excerpt of the previous task (400 characters) and the last answer (600 characters). This uses your normal Claude Code model access. It's skipped in manual and off modes, for `/route next` prompts, and when `classifier.enabled` is `false`.

The subagent router sends each subagent's task (up to 6,000 characters) to the classifier model. The handoff sends the chat's transcript, with known secret formats blanked out, to `handoff.model`, and saves the result on your disk. **Start new chat** asks your system to open a `claude://` link (with `open` on macOS, `xdg-open` on Linux, `rundll32` on Windows); the link carries the handoff text to the desktop app on your own computer. Keep warm asks one tiny question over the chat as Claude Code last sent it. All of this uses your normal Claude Code model access and nothing else. To learn the cache lifetime, the mod reads whether Claude Code's own requests ask for a one-hour cache; it changes and stores nothing of them.

## Windows

- Config, logs and handoffs live in `%USERPROFILE%\.claude\model-router`. A Git Bash style `HOME` (`/c/Users/you`) is ignored on Windows, and Git Bash or Cygwin paths in `CLAUDE_CONFIG_DIR` are converted.
- The mod runs no PowerShell or shell scripts. Copying goes through Claude Code itself; the one outside program it starts is `rundll32` to open a `claude://` link for **Start new chat**.
- Handoff file names hold no characters Windows forbids.

## Error handling

- **Never blocks a prompt.** If analysis, config reading or logging fails, the prompt goes through on the current model and effort, and the error goes to the debug log (`claude --debug`). The hooks also have `.catch` handlers that let prompts and tool calls through if a hook fails or overruns.
- **Never re-runs a command.** The test-run watcher only reads results.
- **Log too big to read back** (over 4 MB, e.g. from an older version): a new log is started rather than silently losing every later line. `logging.maxBytes` is capped at 4,000,000.
- **Bad config:** the last good settings are kept (defaults on the first load), and `/route status` shows the error.
- **Routed model or effort refused** (unknown ID, no access on your provider): the turn is retried on the session's own model and effort, a notification explains what happened, and routing pauses for the session (`Router paused` in the status line). Fix the config, then run `/route reload`.

---

## Uninstall

The easiest way is the [uninstall prompt](#uninstall) in Install. To do it by hand:

1. Remove the plugin (same command on Windows and macOS):
   ```bash
   claude plugin uninstall model-router
   ```
   Desktop app: **+** → **Plugins**, then remove **model-router**.
2. Optionally remove the marketplace entry:
   ```bash
   claude plugin marketplace remove model-router
   ```
3. Optionally delete the config and log folder:
   - macOS: `rm -rf ~/.claude/model-router`
   - Windows (PowerShell): `Remove-Item -Recurse -Force "$env:USERPROFILE\.claude\model-router"`

Your `/model` and effort settings were never changed, so nothing else needs restoring.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| No `Router …` status line | Run `claude plugin list` and check that `model-router` shows **enabled**. Start a new session or run `/reload-plugins`. Run `claude --debug` and look for lines starting with `model-router:`. |
| `/route` is not recognised | Same as above. The command is registered when the session starts. |
| `Router paused (… unavailable)` | Your provider refused that model or effort. Set `models.<tier>` to an ID you can use (or lower `effort.maxLevel`), then run `/route reload`. |
| Effort shows `default` | The session's own effort isn't known until the first request of the session. It appears after that. |
| Too many switches, or never switches | Adjust the margins and thresholds above. Turn the log on to see each score. |
| Feedback routed too low | Check that the classifier is on (`classifier.enabled`) and that `/route status` shows no `classifier gave no answer` in `claude --debug`. Without an answer the rules decide alone. |
| Status line says `held` | The router recommends something else but is protecting the prompt cache (score within the margin, or a switch happened a prompt ago). `/route next <model> <effort>` overrides it for one prompt. |
| A build request ("create a webapp…") is rated too low or high | Tune `taskTypes.build` (weight and keywords) in the config. |
| `/model` shows a different model than the status line | Expected. `/model` shows the session's base model; the router overrides it per request. `/route manual` or `/route off` gives control back to `/model`. |
| No dialog in recommend mode | It only appears when something would change. Set `manualAskOnlyOnChange: false` to be asked every time. There's no dialog in `claude -p` or SDK runs. |
| Escalation fires on unrelated commands | Narrow `escalation.testCommandPatterns`, or set `escalation.enabled` to `false`. |
| Config edits are ignored | Run `/route reload` and check the warnings. |
| Windows: path errors | The router builds paths from `USERPROFILE` (or `CLAUDE_CONFIG_DIR`) with `\` separators. `/route status` prints the paths it uses. |

---

## Development

```
claude-model-router/
├── .claude-plugin/
│   ├── plugin.json          # mod manifest
│   └── marketplace.json     # lets the repo (or folder) be installed directly
├── hooks/
│   ├── hooks.json           # names the hooks module
│   ├── register.tsx         # engine wiring: hooks, /route, /handoff, config, log, status line, panes, band
│   ├── router-core.ts       # pure logic: config, analysis, model + effort, stickiness, escalation, commands
│   ├── extras-core.ts       # pure logic: subagent picks and the risk rule, handoff, cache clock, links, paths
│   ├── savings-core.ts      # pure logic: list prices, costing a turn, the savings totals
│   └── config-template.ts   # the commented default config file
├── types/index.d.ts         # $.state contract
├── tests/
│   ├── router-core.test.ts  # unit tests: config, analysis, effort, stickiness, escalation, commands, paths
│   ├── modes.test.ts        # engine tests: all modes, next-prompt override, effort lock, escalation, migration
│   ├── extras.test.tsx      # subagent router, handoff and cache clock: unit and engine tests
│   └── savings.test.tsx     # risk rule and savings: unit and engine tests
├── tsconfig.json
├── README.md  CHANGELOG.md  LICENSE  .gitignore  .gitattributes
```

```bash
claude plugin validate .
claude plugin test .
```

To try local edits live, run `claude --plugin-dir /path/to/claude-model-router`. The folder is watched, and saving a file reloads the mod.

## License

MIT. See [LICENSE](LICENSE).
