# model-router for Claude Code

A Claude Code mod that recommends **Haiku, Sonnet or Opus** for each prompt and, if you want, switches to it for you.

- **Auto mode**: each prompt is analysed and runs on the recommended model, no questions asked.
- **Manual mode**: when the recommendation differs from the model you're on, a dialog shows the recommendation and a short reason. Accept it with one click or pick another model.
- **Lock / off**: pin one model, or turn routing off and use the session's own model.
- **Sticky by design**: it only switches when the difference is clear, so you don't keep losing the prompt cache.
- **Transparent**: the status line always shows the mode, the model you're running on, the recommendation and why.

Works the same on **Windows and macOS**, in the **terminal** and in the **Desktop app's Code tab**. It's a pure mod: no bash or PowerShell scripts, no Node install, nothing to compile.

---

## How it works

| Step | What happens |
|---|---|
| 1. Prompt submitted | A `prompt.submit` hook scores the prompt from 0 to 100: length, task type (architecture, debugging, code, writing, quick Q&A), complexity keywords, code blocks, stack traces, file names and numbered requirements. |
| 2. Context | The score is blended with recent prompts in the session. A short follow-up such as *"now do the same for billing"* is mostly judged by the conversation it continues, however long ago that was. |
| 3. Tier | `< haikuMax` → Haiku, `≥ opusMin` → Opus, anything else → Sonnet. |
| 4. Stickiness | A switch happens only if the score clears the boundary by `switchMargin` points and at least `minPromptsBetweenSwitches` prompts have passed since the last switch. A two-tier jump (Haiku ↔ Opus) skips the wait. |
| 5. Mode | Auto applies the result. Manual asks only when it would change the model. |
| 6. Switch | A `turn.step` hook sends each main-loop request of the turn to the chosen model. Subagents keep their own models. |

Analysis is local and deterministic (well under a millisecond), so there's no noticeable delay and no extra API call.

**Good to know**

- The router never changes your `/model` setting. It overrides the model per request, so `/model` and the Desktop model picker keep showing the **session (base) model**. The router's status line shows the model actually in use, for example `Router auto · Sonnet (base claude-opus-5-5)`.
- When the recommendation equals the session model, no override is sent, so the session's own prompt cache keeps working.
- Each model has its own prompt cache, so the first prompt after a switch pays to write the cache for the new model. That's why stickiness exists.

---

## Requirements

- Claude Code **2.1.325 or newer** (the version whose mod API this was built and tested against), in a terminal or the Claude Desktop app (Code tab).
- Access to the models you route to. If you're on Bedrock, Vertex or a gateway, set `models` in the config to the IDs your provider uses (see Configuration).

---

## Install

### Option A: from GitHub (after you push this repo)

In a Claude Code terminal session:

```
/plugin install model-router --marketplace rahulrdeo/claude-model-router
```

or from a shell (Windows PowerShell, cmd, or macOS Terminal: the same command):

```bash
claude plugin install model-router --marketplace rahulrdeo/claude-model-router
```

**Desktop app (Code tab):** click **+** next to the prompt box → **Plugins** → **Add marketplace**, enter `rahulrdeo/claude-model-router`, then **Add plugin**. A plugin installed from a terminal at user scope also loads in the Desktop app's Code tab sessions.

### Option B: from the zip

1. Unzip `claude-model-router.zip` somewhere permanent, for example:
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
3. Start a new Claude Code session (or run `/reload-plugins` in an open one). The status line shows `Router manual · …`.

Claude Code reads the mod straight from that folder, so keep the folder where it is. To update, replace the files and run `/reload-plugins`.

---

## Usage

| Command | What it does |
|---|---|
| `/route` or `/route status` | Shows the mode, base model, model in use, last decision and reason, config and log paths, and any config warnings |
| `/route auto` | Switch models automatically |
| `/route manual` | Ask before a switch (one click to accept) |
| `/route off` | Stop routing; use the session model |
| `/route lock <haiku\|sonnet\|opus>` | Always use that model (`/route lock` alone uses `defaultLockModel`) |
| `/route log on` / `/route log off` | Turn the decision log on or off (remembered) |
| `/route reload` | Re-read the config now, and resume routing if it was paused after a model error |
| `/route help` | List the commands |

Your last mode, lock model and log setting are **remembered across sessions**. Until you choose one, `defaultMode` from the config is used (out of the box: `manual`).

### Auto mode

```
/route auto
```

Type your prompts as usual. The status line updates on each prompt:

```
Router auto · Haiku (base claude-opus-5-5) · rec Haiku · quick-qa, low complexity, small output (score 0)
```

`· held` means the router saw a different recommendation but kept the current model because of stickiness.

### Manual mode

```
/route manual
```

When the recommendation differs from the current model, a dialog appears before the prompt runs:

> You're on Opus. Recommended: Haiku — quick-qa, low complexity, small output (score 0). Which model should run this prompt?
> 1. Haiku (recommended)
> 2. Sonnet
> 3. Keep Opus (current)

Press **Enter** or **1** to accept, or pick another option. **Esc** keeps the current model and the prompt still runs. If the current model already fits, there's no dialog. Set `"manualAskOnlyOnChange": false` to be asked every time.

In a non-interactive run (`claude -p`, SDK) nobody can answer, so manual mode keeps the current model.

---

## Configuration

The config file is created with defaults on the first run:

| OS | Path |
|---|---|
| macOS | `~/.claude/model-router/config.jsonc` |
| Windows | `%USERPROFILE%\.claude\model-router\config.jsonc` |

If you set `CLAUDE_CONFIG_DIR`, it's `$CLAUDE_CONFIG_DIR/model-router/config.jsonc` instead.

It's JSON with comments (`//`, `/* */` and trailing commas are fine), and every field is documented inline. Edits take effect on the next prompt. Use `/route reload` to apply them immediately and see any warnings. An invalid value is ignored with a warning and its default kept, so a typo never breaks routing. Delete the file to restore every default.

| Key | Default | Meaning |
|---|---|---|
| `defaultMode` | `"manual"` | Mode used until you choose one with `/route` |
| `defaultLockModel` | `"sonnet"` | Model for `/route lock` with no argument |
| `models.haiku` / `.sonnet` / `.opus` | aliases | What's sent to the API: an alias or a full model ID, e.g. a Bedrock or Vertex ID |
| `thresholds.haikuMax` | `30` | Scores below this → Haiku |
| `thresholds.opusMin` | `65` | Scores at or above this → Opus |
| `thresholds.switchMargin` | `8` | How far past a boundary a score must go before switching |
| `thresholds.minPromptsBetweenSwitches` | `2` | Cool-down after a switch (skipped for Haiku ↔ Opus) |
| `context.historySize` | `5` | Earlier prompts used as context |
| `context.weight` / `followUpWeight` | `0.25` / `0.6` | How much earlier conversation counts for normal prompts and for follow-ups |
| `context.followUpMaxWords` / `followUpKeywords` | `25` / list | How follow-ups are detected |
| `taskTypes.<type>.weight` / `.keywords` | see file | Keyword groups that set the task type and move the score |
| `complexityBoosters`, `simplifiers` | see file | Keywords that raise or lower the score |
| `largeOutputKeywords` | see file | Signals of a long expected answer |
| `logging.enabled` | `false` | Write the decision log (`/route log on\|off` overrides it) |
| `logging.maxBytes` | `1000000` | Rotate to `routing.log.1` past this size |
| `logging.includePromptExcerpt` | `false` | Also log the first 80 characters of each prompt |
| `manualAskOnlyOnChange` | `true` | Manual mode: ask only when the model would change |

**Tuning tips:** if you get too many switches, raise `switchMargin` or `minPromptsBetweenSwitches`. If too much goes to Opus, raise `opusMin`. To bias toward cheaper models, raise `haikuMax`.

### Decision log

With logging on, each decision is one JSON line in `routing.log`, next to the config:

```json
{"ts":"2026-11-14T10:02:11.000Z","event":"route","mode":"auto","score":0,"ownScore":0,"type":"quick-qa","complexity":"low","output":"small","followUp":false,"from":"opus","recommended":"haiku","chosen":"haiku","decision":"auto-switch","model":"haiku","ms":0}
```

`decision` is one of `auto-switch`, `held`, `kept`, `accepted`, `picked`, `declined` or `dismissed`. Prompt text is **not** logged unless `includePromptExcerpt` is `true`. Lines end in `\n` on every OS.

---

## Error handling

- **Never blocks a prompt.** If analysis, config reading or logging fails, the prompt goes through on the current model and the error goes to the debug log (`claude --debug`). The hook also has a `.catch` that lets the prompt through if it overruns its time budget.
- **Bad config:** the last good settings are kept (defaults on the first load), and `/route status` shows the error.
- **Routed model refused** (unknown ID, no access on your provider): the turn is retried on the session model, a toast explains what happened, and routing pauses for the session (`Router paused` in the status line). Fix `models` in the config, then run `/route reload`, `/route auto` or `/route manual` to resume.

---

## Uninstall

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

Your `/model` setting was never changed, so nothing else needs restoring.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| No `Router …` status line | Run `claude plugin list` and check that `model-router` shows **enabled**. Start a new session or run `/reload-plugins`. Run `claude --debug` and look for lines starting with `model-router:`. |
| `/route` is not recognised | Same as above. The command is registered when the session starts. |
| `Router paused (… unavailable)` | Your provider refused that model ID. Set `models.<tier>` in the config to an ID you can use, then run `/route reload`. |
| Too many switches, or never switches | Adjust `switchMargin`, `minPromptsBetweenSwitches`, `haikuMax` or `opusMin`. Turn the log on to see each score. |
| `/model` shows a different model than the status line | Expected. `/model` shows the session's base model; the router overrides it per request. `/route off` goes back to it. |
| Manual dialog never appears | It only appears when the model would change. Set `manualAskOnlyOnChange: false` to be asked every time. In `claude -p` and SDK runs there's no dialog. |
| Config edits are ignored | Run `/route reload` and check the warnings. On Windows, make sure the file is saved as UTF-8 (a BOM is fine). |
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
│   ├── register.ts          # engine wiring: hooks, /route, config, log, status line
│   ├── router-core.ts       # pure routing logic: config, analysis, stickiness, commands
│   └── config-template.ts   # the commented default config file
├── types/index.d.ts         # $.state contract
├── tests/
│   ├── router-core.test.ts  # unit tests: config, analysis, stickiness, commands, paths
│   └── modes.test.ts        # engine tests: modes, persistence, routing, logging, fallbacks
├── tsconfig.json
├── README.md  CHANGELOG.md  LICENSE  .gitignore
```

```bash
claude plugin validate .
claude plugin test .
```

To try local edits live, run `claude --plugin-dir /path/to/claude-model-router`. The folder is watched, and saving a file reloads the mod.

## License

MIT. See [LICENSE](LICENSE).
