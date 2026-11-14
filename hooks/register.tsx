// model-router: picks Haiku, Sonnet or Opus and an effort level for each prompt.
//
// How the switch works: a `turn.step` hook rewrites the model and effort of each
// main-loop request. The session's own /model and effort settings are never
// touched, so `/route off` returns to them exactly. Subagent requests are left alone
// by that hook; the subagent router (`agent.spawn`) picks each subagent's model instead.
//
// Also here: the handoff for long chats (/handoff, a pane) and the cache clock (a band
// above the prompt with a countdown and a Keep warm button).
//
// Failure policy: every routing step is wrapped; on any error the prompt goes
// through unchanged on the current model and effort, and the error is logged.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AgentPickRow, CacheClockState, HandoffState, RouterSession, SavingsItem, SavingsTotals } from '../types'
import { CONFIG_TEMPLATE } from './config-template'
import { addItem, emptyTotals, familyOf, insteadOfTokens, netSaved, priceOf, savedShare, usd, type CostItem, type Tokens } from './savings-core'
import {
  AGENT_PICK_SYSTEM,
  agentPickPrompt,
  asksOneHourCache,
  buildTranscript,
  cacheTtlMs,
  cap as capWord,
  decideAgentModel,
  formatCountdown,
  formatTokens,
  isOtherModel,
  nativeHome,
  newChatLink,
  openLinkCommands,
  redactSecrets,
  ttlEvidence,
  type CacheTtl,
  HANDOFF_SYSTEM,
  HANDOFF_COMPACT_INSTRUCTIONS,
  handoffMessages,
  handoffPrompt,
  KEEP_WARM_PROMPT,
  nextPingAt,
  parseAgentPick,
  pct,
  type AgentPick,
} from './extras-core'
import {
  analyse,
  applyVerdict,
  bandEffort,
  decide,
  decideEffort,
  DEFAULT_CONFIG,
  escalate,
  formatCombo,
  HELP_TEXT,
  isEffort,
  isNegativeFeedback,
  isTestCommand,
  maxCombo,
  mergeConfig,
  parseCombo,
  parseJsonc,
  parseRouteCommand,
  parseVerdict,
  recommendEffort,
  runFailed,
  sameCombo,
  statusLine,
  tierOf,
  TIERS,
  type Analysis,
  type Combo,
  type Decision,
  type Effort,
  type EffortMode,
  type Mode,
  type Verdict,
  type RouterConfig,
  type Tier,
} from './router-core'

/** A prompt count past any cool-down: used where no routed switch has happened yet. */
const NO_RECENT_SWITCH = 99

const INITIAL: RouterSession = {
  effective: null,
  effort: null,
  // No switch has happened yet, so no cool-down applies to the first one.
  promptsSinceSwitch: NO_RECENT_SWITCH,
  promptsSinceEffortSwitch: NO_RECENT_SWITCH,
  history: [],
  last: null,
  disabledReason: null,
  pendingNext: null,
  escalation: null,
  taskScore: null,
  lastTask: '',
  lastAnswer: '',
}
const session = atom({ plugin: 'model-router', key: 'session' } as const, INITIAL)

const AGENTS_PANE = 'model-router-agents'
const HANDOFF_PANE = 'model-router-handoff'
const HANDOFF_INITIAL: HandoffState = { status: 'idle', text: '', at: 0, autoFired: false }
const CLOCK_INITIAL: CacheClockState = { expiresAt: null, ttlMs: 5 * 60_000, keepWarm: false, pings: 0 }
// Change a tag when its value's fields change: it declines what an earlier version stored.
const agentPicks = atom({ plugin: 'model-router', key: 'agentPicks' } as const, [], { shape: 'agent-picks-1' })
const handoffState = atom({ plugin: 'model-router', key: 'handoff' } as const, HANDOFF_INITIAL, { shape: 'handoff-1' })
const cacheClock = atom({ plugin: 'model-router', key: 'cacheClock' } as const, CLOCK_INITIAL, { shape: 'cache-clock-1' })
const clockNow = atom({ plugin: 'model-router', key: 'now' } as const, 0)
const SAVINGS_PANE = 'model-router-savings'
const savingsSession = atom({ plugin: 'model-router', key: 'savingsSession' } as const, emptyTotals(0), { shape: 'savings-1' })
const savingsAll = atom({ plugin: 'model-router', key: 'savingsAll' } as const, emptyTotals(0), { shape: 'savings-1' })
const savingsRecent = atom({ plugin: 'model-router', key: 'savingsRecent' } as const, [], { shape: 'savings-items-1' })

/** Prompt origins that are a person typing (terminal, Desktop app, phone bridge). */
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'unclassified'])

/** Bumped when stored values change meaning. 2: "manual" became "recommend". */
const STORE_VERSION = 2

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

// ---------------------------------------------------------------------------
// Paths: Windows and macOS/Linux alike.

/** Joins path parts with the separator the base already uses. */
export function joinPath(base: string, ...parts: string[]): string {
  const isWindows = /^[A-Za-z]:/.test(base) || (base.includes('\\') && !base.includes('/'))
  const sep = isWindows ? '\\' : '/'
  const trimmed = (isWindows ? base.replace(/\//g, '\\') : base).replace(/[\\/]+$/, '')
  return [trimmed, ...parts.map(p => p.replace(/^[\\/]+|[\\/]+$/g, ''))].join(sep)
}

/** Fills fields a 1.x session stored without, and drops a 1.x `last` whose shape changed. */
function normalize(s: RouterSession): Required<RouterSession> {
  const last = s.last && typeof s.last.recommended === 'object' ? s.last : null
  return {
    ...INITIAL,
    ...s,
    effort: s.effort ?? null,
    promptsSinceEffortSwitch: s.promptsSinceEffortSwitch ?? NO_RECENT_SWITCH,
    pendingNext: s.pendingNext ?? null,
    escalation: s.escalation ?? null,
    taskScore: s.taskScore ?? null,
    lastTask: s.lastTask ?? '',
    lastAnswer: s.lastAnswer ?? '',
    personPick: s.personPick ?? null,
    last,
  } as Required<RouterSession>
}

// Module state: rebuilt by register() and session.start (a hot reload re-runs both).
let cfg: RouterConfig = DEFAULT_CONFIG
let cfgStamp = ''
let cfgWarnings: string[] = []
let dir = ''
let mode: Mode = DEFAULT_CONFIG.defaultMode
let lockModel: Tier = DEFAULT_CONFIG.defaultLockModel
let effortMode: EffortMode = DEFAULT_CONFIG.effort.defaultMode
let effortLock: Effort = DEFAULT_CONFIG.effort.defaultLockLevel
let logOverride: boolean | undefined
let baseModel = ''
/** The session's own effort, as last seen on a main-loop request; null until seen. */
let baseEffort: Effort | null = null
/** What turn.step sends for main-loop requests; undefined = the session's own. */
let override: string | undefined
let effortOverride: Effort | undefined
/** A /route next override for one prompt: bound to its turn at turn.start, cleared at turn.complete. */
let once: { model?: string; effort?: Effort; tier?: Tier; turnId?: string } | null = null
/** Whether the last test or build run of the current turn failed. */
let lastRunFailed = false
/** Whether this process has sent a main-loop request yet (after which a prompt cache exists). */
let sawMainRequest = false
let logQueue: Promise<void> = Promise.resolve()
/** /route agents|handoff|clock on|off, kept in the store; undefined = the config's setting. */
let agentsOverride: boolean | undefined
let handoffOverride: boolean | undefined
let clockOverride: boolean | undefined
/** The cache lifetime the last main-loop request asked for; null until one is seen. */
let askedTtl: CacheTtl | null = null
/** The lifetime the chat's own behaviour proved: this session's, else one remembered from before. */
let provenTtl: CacheTtl | null = null
let provenThisSession = false
/** When the last main-loop answer ended, and on which model, for the cache evidence. */
let lastAnswerAt = 0
let lastAnswerModel = ''
/** True on Windows (OS=Windows_NT). */
let onWindows = false
/** The model family the last priced main-chat turn ran on, to see a switch. */
let lastPricedFamily: string | undefined
/** Set by a main-loop turn.step; the next engine model request is that one. */
let mainRequestPending = false
let tickTimer: Timer | null = null
let pingTimer: Timer | null = null
/** True while a keep-warm ping runs, so its own events do not reset the clock. */
let pinging = false
let agentPaneOpened = false

/** The best evidence of the cache lifetime: proven this session, asked for, proven before. */
const ttlEvidenceNow = (): CacheTtl | null => (provenThisSession ? provenTtl : null) ?? askedTtl ?? provenTtl
const agentsOn = () => (agentsOverride ?? cfg.subagents.enabled) && mode !== 'off'
const handoffOn = () => handoffOverride ?? cfg.handoff.enabled
const clockOn = () => clockOverride ?? cfg.cacheClock.enabled
/** The largest file the engine's $.fs.read returns. */
const MAX_READ_BYTES = 4 * 1024 * 1024
const configPath = () => joinPath(dir, 'config.jsonc')
const logPath = () => joinPath(dir, 'routing.log')
const loggingOn = () => logOverride ?? cfg.logging.enabled

function debug($: EngineInterface, text: string): void {
  $.ui.log(`model-router: ${text}`, { to: 'debug' })
}

/** The model to send for a tier, or undefined when it is the session's own (keeps its cache). */
const modelFor = (t: Tier | null): string | undefined =>
  t === null || tierOf(baseModel, cfg) === t ? undefined : cfg.models[t]

/** The effort to send, or undefined when it is the session's own. */
const effortFor = (e: Effort | null | undefined): Effort | undefined =>
  e === null || e === undefined || e === baseEffort ? undefined : e

/** What runs now, as far as the router knows. */
function currentCombo(s: Required<RouterSession>): { tier: Tier | null; effort: Effort | null } {
  return { tier: s.effective ?? tierOf(baseModel, cfg) ?? null, effort: s.effort ?? baseEffort }
}

async function resolveDir($: EngineInterface): Promise<string> {
  onWindows = (await $.env.get('OS').catch(() => undefined)) === 'Windows_NT'
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  if (configured) return joinPath(nativeHome(configured, onWindows), 'model-router')
  // On Windows the profile folder is the reliable one: HOME, when set at all, may be a
  // Git Bash spelling such as /c/Users/you.
  const profile = await $.env.get('USERPROFILE')
  const unixHome = await $.env.get('HOME')
  const home = onWindows ? profile || unixHome : unixHome || profile
  if (!home) throw new Error('cannot find the home directory (HOME / USERPROFILE unset)')
  return joinPath(nativeHome(home, onWindows), '.claude', 'model-router')
}

/** Loads the config, creating it from the template on first run. Cheap when unchanged. */
async function loadConfig($: EngineInterface, force = false): Promise<void> {
  if (!dir) return
  const path = configPath()
  try {
    if (!(await $.fs.exists(path))) {
      await $.fs.write(path, CONFIG_TEMPLATE)
    }
    const st = await $.fs.stat(path)
    const stamp = `${st.mtimeMs}:${st.size}`
    if (!force && stamp === cfgStamp) return
    const merged = mergeConfig(parseJsonc(await $.fs.read(path)))
    cfg = merged.config
    cfgWarnings = merged.warnings
    cfgStamp = stamp
    if (cfgWarnings.length > 0) $.ui.toast(`model-router config: ${cfgWarnings[0]}${cfgWarnings.length > 1 ? ` (+${cfgWarnings.length - 1} more, see /route)` : ''}`)
  } catch (err) {
    // Keep whatever config was last good (defaults on first load).
    cfgWarnings = [`could not read ${path}: ${errText(err)}; using ${cfgStamp ? 'last good' : 'default'} settings`]
    cfgStamp = ''
    debug($, cfgWarnings[0] ?? 'config error')
  }
}

/** Appends one JSON line to the log, rotating past maxBytes. Never throws. */
function writeLog($: EngineInterface, entry: Record<string, unknown>): Promise<void> {
  if (!loggingOn() || !dir) return Promise.resolve()
  return appendJsonLine($, logPath(), entry, cfg.logging.maxBytes)
}

/** Appends one JSON line (with time and session) to a file, rotating it to `.1` past maxBytes. Never throws. */
function appendJsonLine($: EngineInterface, path: string, entry: Record<string, unknown>, maxBytes: number): Promise<void> {
  logQueue = logQueue
    .then(async () => {
      const session = await $.session.id().catch(() => 'unknown')
      const line = JSON.stringify({ ts: new Date(await $.clock.now()).toISOString(), session, ...entry }) + '\n'
      let existing = ''
      if (await $.fs.exists(path)) {
        const st = await $.fs.stat(path)
        if (st.size > MAX_READ_BYTES) {
          // Too big for the engine to read back (an older version, or edited by hand):
          // start a new log rather than lose every line from now on.
          await $.fs.write(`${path}.1`, `{"note":"the file was over ${MAX_READ_BYTES} bytes and could not be rotated; a new one was started"}\n`)
        } else if (st.size + line.length > maxBytes) {
          await $.fs.write(`${path}.1`, await $.fs.read(path))
        } else {
          existing = await $.fs.read(path)
        }
      }
      await $.fs.write(path, existing + line)
    })
    .catch(err => debug($, `write to ${path} failed: ${errText(err)}`))
  return logQueue
}

// ---------------------------------------------------------------------------
// Cost savings: every priced item goes to this session's totals, the all-time totals (kept in
// the store) and, when on, the ledger file. Never throws.

const ledgerPath = () => joinPath(dir, 'cost-ledger.jsonl')

async function recordCost($: EngineInterface, item: CostItem): Promise<void> {
  if (!cfg.savings.enabled) return
  try {
    await update($, savingsSession, (t): SavingsTotals => addItem(t, item))
    const all = await update($, savingsAll, (t): SavingsTotals => addItem(t, item))
    await $.store.set('savingsTotals', all)
    // The panel's list shows work and spending you chose; the router's own small calls are in the totals.
    if (item.kind !== 'overhead' || item.what === 'handoff' || item.what === 'keepWarm') {
      await update($, savingsRecent, (l): SavingsItem[] => [...l, item].slice(-40))
    }
    if (cfg.savings.ledger && dir) await appendJsonLine($, ledgerPath(), { ...item }, 4_000_000)
  } catch (err) {
    debug($, `savings record failed: ${errText(err)}`)
  }
}

/** Records a helper call's tokens (classifier, subagent pick, handoff, keep-warm) as spending. */
function recordCall($: EngineInterface, what: 'classifier' | 'picks' | 'handoff' | 'keepWarm', model: string, tokens: Tokens | null | undefined, label: string): Promise<void> {
  const cost = priceOf(tokens, model, cfg.savings.prices)
  if (cost === null) return Promise.resolve()
  return $.clock.now().then(at => recordCost($, { at, kind: 'overhead', what, usd: cost, label }))
}

const famName = (model: string) => capWord(familyOf(model) ?? model)

/** Where an escalation from the last turn would go, for the current mode. */
function escalationTarget(from: Combo): Combo | null {
  const to = escalate(from, cfg, mode === 'lock' ? lockModel : undefined)
  if (to === null || effortMode !== 'lock') return to
  // Effort is locked: only the model can go up.
  if (to.tier === from.tier) return mode === 'lock' ? null : escalate({ tier: from.tier, effort: 'max' }, cfg)
  return { tier: to.tier, effort: effortLock }
}

async function refreshStatus($: EngineInterface): Promise<void> {
  const s = normalize(await read($, session))
  const cur = currentCombo(s)
  let text = statusLine({
    mode,
    current: mode === 'off' ? { tier: null, effort: null } : cur,
    base: baseModel || 'session model',
    effortMode,
    last: s.last ? { recommended: s.last.recommended, reason: s.last.reason, heldBecause: s.last.heldBecause } : undefined,
    next: s.pendingNext ?? (once ? { tier: once.tier, effort: once.effort } : undefined),
    escalation: s.escalation && mode !== 'off' ? { reason: s.escalation.reason, to: escalationTarget(s.escalation.from) } : undefined,
  })
  if (s.disabledReason && mode !== 'off') text = `Router paused (${s.disabledReason}) · ${baseModel}`
  else if (s.personPick && (mode === 'auto' || mode === 'recommend' || mode === 'lock')) {
    text += ` · keeping your ${[s.personPick.model ? 'model' : '', s.personPick.effort ? 'effort' : ''].filter(Boolean).join(' and ')} (/route resume)`
  }
  $.ui.status(text)
}

/** Applies a mode change: overrides, persisted choice, status. */
async function applyMode($: EngineInterface, next: Mode, lock?: Tier): Promise<void> {
  mode = next
  // Choosing a mode hands the choice back to the router.
  await update($, session, s => ({ ...normalize(s), personPick: null }))
  if (lock) lockModel = lock
  await $.store.set('mode', mode)
  await $.store.set('lockModel', lockModel)
  const base = tierOf(baseModel, cfg) ?? null
  if (mode === 'off') {
    override = undefined
    effortOverride = undefined
    await update($, session, s => ({ ...normalize(s), effective: base, effort: null, promptsSinceSwitch: NO_RECENT_SWITCH, disabledReason: null, escalation: null }))
  } else if (mode === 'manual') {
    // You choose: the session's /model, plus any effort lock.
    override = undefined
    const effort = effortMode === 'lock' ? effortLock : null
    effortOverride = effortFor(effort)
    await update($, session, s => ({ ...normalize(s), effective: base, effort, promptsSinceSwitch: NO_RECENT_SWITCH, disabledReason: null }))
  } else if (mode === 'lock') {
    override = modelFor(lockModel)
    await update($, session, s => ({ ...normalize(s), effective: lockModel, promptsSinceSwitch: NO_RECENT_SWITCH, disabledReason: null }))
  } else {
    // auto/recommend keep whatever runs now; the next prompt decides.
    await update($, session, s => ({ ...normalize(s), disabledReason: null }))
  }
  await refreshStatus($)
  await writeLog($, { event: 'mode', mode, lockModel: mode === 'lock' ? lockModel : undefined })
}

async function applyEffortMode($: EngineInterface, next: EffortMode, level?: Effort): Promise<void> {
  effortMode = next
  await update($, session, s => {
    const p = normalize(s)
    return { ...p, personPick: p.personPick?.model ? { model: p.personPick.model } : null }
  })
  if (level) effortLock = level
  await $.store.set('effortMode', effortMode)
  await $.store.set('effortLock', effortLock)
  if (mode !== 'off') {
    if (effortMode === 'lock') {
      effortOverride = effortFor(effortLock)
      await update($, session, s => ({ ...normalize(s), effort: effortLock, promptsSinceEffortSwitch: NO_RECENT_SWITCH }))
    } else if (mode === 'manual') {
      effortOverride = undefined
      await update($, session, s => ({ ...normalize(s), effort: null }))
    }
  }
  await refreshStatus($)
  await writeLog($, { event: 'effort-mode', effortMode, effortLock: effortMode === 'lock' ? effortLock : undefined })
}

/** Turns a pending /route next into this prompt's override. */
function activateOnce(next: { tier?: Tier; effort?: Effort }): void {
  once = {
    tier: next.tier,
    effort: next.effort,
    model: next.tier ? (tierOf(baseModel, cfg) === next.tier ? baseModel : cfg.models[next.tier]) : undefined,
  }
}

/** Asks which model and effort to use. Resolves to the choice, or null to keep what runs now. */
async function askRecommend(
  $: EngineInterface,
  rec: Combo,
  cur: { tier: Tier | null; effort: Effort | null },
  a: Analysis,
  reason: string,
): Promise<{ tier: Tier; effort: Effort } | null> {
  const labels = [`${formatCombo(rec)} (recommended)`]
  const curKnown = cur.tier !== null && !sameCombo(rec, cur as Combo)
  if (cur.tier !== null && curKnown) labels.push(`Keep ${formatCombo(cur as { tier: Tier; effort: Effort | null })} (current)`)
  const up = escalate(rec, cfg)
  if (up && !labels.some(l => l.startsWith(formatCombo(up)) || l.includes(formatCombo(up)))) labels.push(formatCombo(up))
  for (const t of TIERS) {
    if (labels.length >= 4) break
    if (t === rec.tier || t === cur.tier || (up && t === up.tier)) continue
    labels.push(formatCombo({ tier: t, effort: recommendEffort(a, t, cfg).effort }))
  }
  const where = cur.tier ? `You're on ${formatCombo(cur as { tier: Tier; effort: Effort | null })}.` : ''
  const answer = await $.ui.ask(`${where} Recommended: ${formatCombo(rec)} — ${reason}. Which model and effort should run this prompt?`, {
    options: labels,
    header: 'Model',
  })
  if (/\bkeep\b/i.test(answer)) return null
  const picked = parseCombo(answer)
  if (!picked.tier && !picked.effort) return null
  const tier = picked.tier ?? rec.tier
  const effort = picked.effort ?? (tier === rec.tier ? rec.effort : recommendEffort(a, tier, cfg).effort)
  return { tier, effort }
}

const CLASSIFIER_SYSTEM = `You classify one message from a person to an AI coding assistant, given the previous task and the assistant's last answer. Reply with JSON only, no other text: {"complexity":"simple|moderate|complex|architecture","sentiment":"approve|neutral|negative","isFeedback":true|false}
complexity: how hard the work the message asks for is. simple: a quick question or a small edit. moderate: one feature or fix. complex: a multi-part build or debugging across files. architecture: system design or a large refactor.
isFeedback: true when the message reacts to the last answer ("still wrong", "perfect, thanks", "now make the chart red") rather than starting an unrelated task.
sentiment: how the person feels about the last answer: approve, neutral, or negative (frustrated, or says it is wrong or broken).
Judge the work the message asks for, not its length: a short message can still ask for hard work.`

/** Asks the classifier model about one message. Null when it does not answer usably. */
async function classify($: EngineInterface, text: string, s: Required<RouterSession>): Promise<Verdict | null> {
  const c = cfg.classifier
  const prompt = [
    `Previous task: ${s.lastTask || '(none yet)'}`,
    `Last answer (excerpt): ${s.lastAnswer || '(none yet)'}`,
    `Message: ${text}`,
  ].join('\n\n')
  const r = await $.model.complete({ model: c.model, system: CLASSIFIER_SYSTEM, prompt, maxTokens: 80, effort: c.effort, timeoutMs: c.timeoutMs })
  await recordCall($, 'classifier', c.model, r.usage, 'prompt classifier')
  if (!r.isAnswered) {
    debug($, `classifier gave no answer (${r.reason}); rules decide alone`)
    return null
  }
  return parseVerdict(r.text)
}

/** Runs the classifier for a prompt that will be analysed. Never throws; `ms` is what it took. */
async function classifyPrompt($: EngineInterface, text: string, s: Required<RouterSession>, pending: boolean): Promise<{ verdict: Verdict | null; ms: number }> {
  if (!cfg.classifier.enabled || pending || mode === 'manual' || mode === 'off') return { verdict: null, ms: 0 }
  const started = await $.clock.now()
  try {
    const verdict = await classify($, text, s)
    return { verdict, ms: (await $.clock.now()) - started }
  } catch (err) {
    debug($, `classifier failed, rules decide alone: ${errText(err)}`)
    return { verdict: null, ms: (await $.clock.now()) - started }
  }
}

/**
 * The person moved the main chat's model or effort themselves (the app's menu, /model,
 * /effort). Their choice runs from the next request on; the router keeps recommending but
 * no longer switches that part until /route resume or a /route mode command.
 */
async function notePersonPick($: EngineInterface, pick: { model?: string; effort?: Effort }): Promise<void> {
  if (pick.model) {
    baseModel = pick.model
    override = undefined
  }
  if (pick.effort) {
    baseEffort = pick.effort
    effortOverride = undefined
  }
  const routing = mode === 'auto' || mode === 'recommend' || mode === 'lock'
  await update($, session, prev => {
    const p = normalize(prev)
    return {
      ...p,
      effective: pick.model ? (tierOf(pick.model, cfg) ?? null) : p.effective,
      effort: pick.effort ?? p.effort,
      personPick: routing ? { ...(p.personPick ?? {}), ...pick } : p.personPick,
    }
  })
  if (routing) {
    const what = [pick.model ? capWord(tierOf(pick.model, cfg) ?? pick.model) : '', pick.effort ? `${pick.effort} effort` : ''].filter(Boolean).join(' at ')
    $.ui.toast(`model-router: you chose ${what}, so that is what runs. The router still shows its recommendation; /route resume lets it switch again.`)
  }
  await writeLog($, { event: 'your-pick', model: pick.model, effort: pick.effort, mode })
  await refreshStatus($).catch(() => undefined)
}

/** Auto, recommend and lock: analyse a prompt and set the model and effort. Throws on failure. */
async function route($: EngineInterface, text: string, hasOnce: boolean, classified: { verdict: Verdict | null; ms: number }): Promise<void> {
  const s = normalize(await read($, session))
  if (s.disabledReason) return
  const started = await $.clock.now()
  // Time the recommend dialog was open: waiting for you, not routing work. Left out of `ms`.
  let dialogMs = 0
  let a = analyse(text, s.history, cfg)
  // Feedback on the last task does not count as a task of its own: it neither enters the
  // history nor replaces the task's level, unless it is negative (then the level climbs).
  const isNewTask = !(classified.verdict?.isFeedback === true && s.taskScore !== null)
  if (classified.verdict) a = applyVerdict(a, classified.verdict, { taskScore: s.taskScore }, cfg)
  const cur = currentCombo(s)

  // Model, with stickiness.
  // The first prompt of a brand-new conversation has no prompt cache to protect,
  // so stickiness does not apply to it.
  const isFresh = !sawMainRequest && (await $.session.turns().catch(() => 2)) <= 1
  const d: Decision =
    mode === 'lock'
      ? { recommended: lockModel, target: lockModel, isSwitch: cur.tier !== lockModel }
      : cur.tier && !isFresh
        ? decide(a, cur.tier, s.promptsSinceSwitch, cfg)
        : { recommended: a.tier, target: a.tier, isSwitch: a.tier !== cur.tier }
  // Effort, as part of the same decision, with its own stickiness.
  const recommendedEffort = effortMode === 'lock' ? effortLock : recommendEffort(a, d.recommended, cfg).effort
  const ed =
    effortMode === 'lock'
      ? { recommended: effortLock, target: effortLock, isSwitch: cur.effort !== effortLock, heldBecause: undefined }
      : decideEffort(a, d.target, isFresh ? null : cur.effort, s.promptsSinceEffortSwitch, d.target !== cur.tier, cfg)

  let recommended: Combo = { tier: d.recommended, effort: recommendedEffort }
  let target: Combo = { tier: d.target, effort: ed.target }
  let heldBecause = d.heldBecause ?? ed.heldBecause
  let reason = a.reason

  // Escalation from a failed last turn: at least one step up, past stickiness.
  const escTo = s.escalation ? escalationTarget(s.escalation.from) : null
  if (s.escalation && escTo) {
    recommended = maxCombo(recommended, escTo)
    target = maxCombo(target, escTo)
    heldBecause = undefined
    reason = `escalated: ${s.escalation.reason}; ${a.reason}`
  }

  // What the person picked themselves stays: the recommendation is shown, not applied.
  const held = s.personPick
  if (held?.model && cur.tier) target = { ...target, tier: cur.tier }
  if (held?.effort && cur.effort) target = { ...target, effort: cur.effort }
  if ((held?.model || held?.effort) && !sameCombo(target, recommended)) heldBecause = 'you picked it'

  let chosen: { tier: Tier | null; effort: Effort | null } = cur
  let how = 'kept'
  if (hasOnce) {
    // /route next decides this prompt; the active mode resumes after it.
    how = 'next-override'
  } else if (mode === 'auto' || mode === 'lock') {
    chosen = target
    how = !sameCombo(target, cur as Combo) ? (escTo ? 'escalated' : 'auto-switch') : heldBecause ? 'held' : 'kept'
  } else if (mode === 'recommend') {
    const modelChange = target.tier !== cur.tier
    const effortChange = cur.effort !== null && target.effort !== cur.effort
    if (modelChange || effortChange || escTo || !cfg.manualAskOnlyOnChange) {
      const askStarted = await $.clock.now()
      try {
        const picked = await askRecommend($, target, cur, a, reason)
        chosen = picked ?? cur
        how = picked === null ? 'declined' : sameCombo(picked, target) ? 'accepted' : 'picked'
      } catch {
        // Dismissed, or no one to ask (headless): keep what runs now.
        chosen = cur
        how = 'dismissed'
      } finally {
        dialogMs += (await $.clock.now()) - askStarted
      }
    } else {
      // Same model, effort not known yet: set the recommended effort without asking.
      chosen = { tier: cur.tier ?? target.tier, effort: cur.effort ?? target.effort }
      how = heldBecause ? 'held' : 'kept'
    }
  }

  const modelSwitched = chosen.tier !== cur.tier
  const effortSwitched = chosen.effort !== cur.effort
  if (!hasOnce) {
    override = modelFor(chosen.tier)
    effortOverride = effortFor(chosen.effort)
  }
  await update($, session, prev => {
    const p = normalize(prev)
    return {
      ...p,
      effective: hasOnce ? p.effective : chosen.tier,
      effort: hasOnce ? p.effort : chosen.effort,
      promptsSinceSwitch: !hasOnce && modelSwitched ? 0 : p.promptsSinceSwitch + 1,
      promptsSinceEffortSwitch: !hasOnce && effortSwitched ? 0 : p.promptsSinceEffortSwitch + 1,
      history: isNewTask ? [...p.history, { score: a.score, type: a.type }].slice(-Math.max(1, cfg.context.historySize)) : p.history,
      taskScore: isNewTask || classified.verdict?.sentiment === 'negative' ? a.score : p.taskScore,
      lastTask: isNewTask ? text.slice(0, 400) : p.lastTask,
      // The recommendation before stickiness, so the status line can show "held".
      last: { recommended, chosen, reason, heldBecause },
      // An escalation is used once: applied, offered, or replaced by your /route next.
      escalation: null,
    }
  })
  await writeLog($, {
    event: 'route',
    mode,
    effortMode,
    score: a.score,
    ownScore: a.ownScore,
    words: a.words,
    type: a.type,
    complexity: a.complexity,
    output: a.output,
    followUp: a.isFollowUp,
    from: cur,
    recommended,
    target,
    chosen: hasOnce ? { tier: once?.tier ?? cur.tier, effort: once?.effort ?? cur.effort } : chosen,
    decision: how,
    held: heldBecause,
    escalation: s.escalation?.reason,
    verdict: classified.verdict ? `${classified.verdict.complexity}/${classified.verdict.sentiment}/${classified.verdict.isFeedback ? 'feedback' : 'task'}` : undefined,
    classifierMs: classified.ms,
    model: (hasOnce ? once?.model : undefined) ?? override ?? baseModel,
    effort: (hasOnce ? once?.effort : undefined) ?? effortOverride ?? baseEffort ?? 'default',
    ms: (await $.clock.now()) - started - dialogMs,
    prompt: cfg.logging.includePromptExcerpt ? text.slice(0, 80) : undefined,
  })
}

/** Records a failed turn so the next prompt can escalate (or, in manual mode, suggest). */
async function noteFailure($: EngineInterface, reason: string, announce = true): Promise<void> {
  if (!cfg.escalation.enabled || mode === 'off') return
  const s = normalize(await read($, session))
  const tier = once?.tier ?? currentCombo(s).tier
  if (!tier) return
  const effort = once?.effort ?? currentCombo(s).effort ?? bandEffort(tier, s.history.at(-1)?.score ?? 50, cfg)
  const from: Combo = { tier, effort }
  await update($, session, p => ({ ...normalize(p), escalation: { reason, from } }))
  const to = escalationTarget(from)
  if (announce && (mode === 'manual' || mode === 'recommend')) {
    $.ui.toast(
      to
        ? `model-router: ${reason}. To retry stronger: /route next ${to.tier} ${to.effort}`
        : `model-router: ${reason}. Already at the strongest setting.`,
    )
  }
  await writeLog($, { event: 'failure', reason, from, suggested: to })
}

// ---------------------------------------------------------------------------
// Subagent router.

async function patchPick($: EngineInterface, id: string, patch: Partial<AgentPickRow>): Promise<void> {
  await update($, agentPicks, list => list.map(r => (r.id === id ? { ...r, ...patch } : r)))
}

/** Asks Haiku which model a subagent task needs. Null when it gives no usable answer. */
async function pickAgentModel($: EngineInterface, e: { description: string; subagentType: string; prompt: string }): Promise<AgentPick | null> {
  try {
    const r = await $.model.complete({
      model: cfg.classifier.model,
      system: AGENT_PICK_SYSTEM,
      prompt: agentPickPrompt(e),
      maxTokens: 120,
      effort: cfg.classifier.effort,
      timeoutMs: cfg.subagents.timeoutMs,
    })
    await recordCall($, 'picks', cfg.classifier.model, r.usage, 'subagent pick')
    if (!r.isAnswered) {
      debug($, `subagent classifier gave no answer (${r.reason}); parent model kept`)
      return null
    }
    return parseAgentPick(r.text)
  } catch (err) {
    debug($, `subagent classifier failed; parent model kept: ${errText(err)}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// Handoff.

async function writeHandoff($: EngineInterface, why: 'auto' | 'command'): Promise<void> {
  const current = await read($, handoffState)
  if (current.status === 'writing') return
  const startedAt = await $.clock.now()
  await update($, handoffState, (p): HandoffState => ({ ...p, status: 'writing', at: startedAt, detail: undefined, file: undefined, autoFired: p.autoFired || why === 'auto' }))
  void $.ui.open({ id: HANDOFF_PANE, title: 'Handoff' }).catch(() => undefined)
  try {
    const messages = await $.session.messages()
    const tokens = (await $.session.usage().catch(() => null))?.context.tokens
    const cwd = await $.session.cwd().catch(() => '')
    const t = buildTranscript(messages, cfg.handoff.maxInputChars)
    // Known secret formats never reach the helper, and never land in the handoff.
    const clean = redactSecrets(t.text)
    const r = await $.model.complete({
      model: cfg.handoff.model,
      system: HANDOFF_SYSTEM,
      prompt: handoffPrompt(clean.text, { tokens, cwd, omitted: t.omitted }),
      maxTokens: cfg.handoff.maxTokens,
      effort: cfg.handoff.effort,
      timeoutMs: cfg.handoff.timeoutMs,
    })
    if (!r.isAnswered) {
      const status = (r as { status?: number }).status
      throw new Error(r.reason === 'api-error' ? `API error${status ? ` ${status}` : ''}` : r.reason === 'aborted' ? 'timed out or cancelled' : String(r.reason))
    }
    await recordCall($, 'handoff', cfg.handoff.model, r.usage, `handoff written on ${cfg.handoff.model}`)
    const out = redactSecrets(r.text.trim())
    const text = out.text
    const redacted = clean.count + out.count
    let file: string | undefined
    if (cfg.handoff.saveToFile && dir) {
      try {
        const id = await $.session.id().catch(() => 'session')
        file = joinPath(dir, 'handoffs', `${id}-${new Date(await $.clock.now()).toISOString().replace(/[:.]/g, '-')}.md`)
        await $.fs.write(file, text + '\n')
      } catch (err) {
        debug($, `could not save the handoff: ${errText(err)}`)
        file = undefined
      }
    }
    const notes = [
      `written on ${cfg.handoff.model} from ${formatTokens(tokens)}`,
      t.trimmed ? 'long tool output trimmed' : '',
      t.omitted > 0 ? `${t.omitted} middle messages left out for length` : '',
      redacted > 0 ? `${redacted} secret${redacted === 1 ? '' : 's'} blanked out` : '',
    ].filter(Boolean)
    await update($, handoffState, (p): HandoffState => ({ ...p, status: 'ready', text, at: startedAt, tokens, detail: notes.join(' · '), file, redacted }))
    $.ui.toast(why === 'auto'
      ? `model-router: this chat passed ${formatTokens(cfg.handoff.autoAtTokens)}. A handoff is ready in the Handoff pane: copy it or start a new chat.`
      : 'model-router: handoff ready in the Handoff pane.')
    await writeLog($, { event: 'handoff', why, tokens, chars: text.length, ms: (await $.clock.now()) - startedAt, omitted: t.omitted, redacted })
  } catch (err) {
    await update($, handoffState, (p): HandoffState => ({ ...p, status: 'failed', detail: errText(err) }))
    $.ui.toast(`model-router: the handoff could not be written (${errText(err)}).`)
    await writeLog($, { event: 'error', where: 'handoff', error: errText(err) })
  }
}

/** Starts the handoff outside the calling hook, so a long write never holds a turn or a command. */
function startHandoff($: EngineInterface, why: 'auto' | 'command'): void {
  $.clock.after(0, () => void writeHandoff($, why).catch(err => debug($, `handoff failed: ${errText(err)}`)))
}

/**
 * Starts the chat afresh from the handoff: the conversation is compacted to a one-line note,
 * then the handoff is added as a message the model reads. The next prompt carries on from it.
 */
async function startFromHandoff($: EngineInterface): Promise<string> {
  const h = await read($, handoffState)
  if (h.status !== 'ready' || !h.text) return 'There is no handoff ready yet.'
  const r = await $.session.compact({ instructions: HANDOFF_COMPACT_INSTRUCTIONS })
  if ('skip' in r && r.skip) return `Could not start fresh: ${r.skip}`
  const [first] = handoffMessages(h.text)
  const added = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: first?.text ?? h.text }] } })
  if (added.deny) return `The chat was compacted, but the handoff could not be added (${added.deny}). Use Copy and paste it as your next message.`
  await update($, handoffState, (p): HandoffState => ({ ...p, status: 'applied', autoFired: false }))
  await stopClock($)
  await writeLog($, { event: 'handoff-applied' })
  return 'Started fresh from the handoff. Your next message continues from it.'
}

/** Puts the handoff on the clipboard. Says where it is saved when the copy does not take. */
async function copyHandoff($: EngineInterface, surface?: Parameters<EngineInterface['ui']['copy']>[0]['surface']): Promise<string> {
  const h = await read($, handoffState)
  if (!h.text) return 'There is no handoff yet. Type /handoff to write one.'
  const r = await $.ui.copy(surface ? { text: h.text, surface } : { text: h.text }).catch(() => ({ isCopied: false }))
  return r.isCopied ? 'Handoff copied. Paste it as the first message of a new chat.' : `Could not copy here${h.file ? `; the handoff is saved at ${h.file}` : ''}.`
}

/**
 * Opens a new chat in the Claude desktop app with the handoff typed in, ready to send.
 * Without the desktop app (or where the link cannot be opened) it copies the handoff instead.
 */
async function openInNewChat($: EngineInterface): Promise<string> {
  const h = await read($, handoffState)
  if (!h.text || (h.status !== 'ready' && h.status !== 'applied')) return 'There is no handoff ready yet. Type /handoff to write one.'
  const cwd = await $.session.cwd().catch(() => '')
  // Windows caps a whole command line at 32,767 characters; stay well under it.
  const link = newChatLink(h.text, { cwd, file: h.file, maxLength: onWindows ? 8_000 : 60_000 })
  let opened = false
  for (const argv of openLinkCommands(link.url, onWindows)) {
    const r = await $.process.run(argv, { timeoutMs: 15_000 }).catch(() => null)
    if (r && r.exitCode === 0) {
      opened = true
      break
    }
  }
  await writeLog($, { event: 'handoff-new-chat', opened, whole: link.isWhole, chars: link.url.length })
  if (!opened) {
    const copied = await copyHandoff($)
    return `Could not open a new chat in the Claude desktop app. ${copied}`
  }
  if (link.isWhole) return 'A new chat opened with the handoff typed in. Check it and press Enter there.'
  const copied = await copyHandoff($)
  return `A new chat opened with the start of the handoff (the whole one is too long for a link) and a pointer to the saved file. ${copied}`
}

// ---------------------------------------------------------------------------
// Cache clock.

/** Reads a turn's first request for proof of the cache lifetime (see ttlEvidence). */
async function learnTtl($: EngineInterface, index: number, model: string, usage: Parameters<typeof ttlEvidence>[1]): Promise<void> {
  try {
    if (index !== 0 || !lastAnswerAt || model !== lastAnswerModel) return
    const proof = ttlEvidence((await $.clock.now()) - lastAnswerAt, usage)
    if (!proof) return
    provenThisSession = true
    if (proof !== provenTtl) {
      provenTtl = proof
      await $.store.set('cacheTtl', proof)
      await writeLog($, { event: 'cache-ttl', proven: proof })
    }
  } catch (err) {
    debug($, `cache lifetime check failed: ${errText(err)}`)
  }
}

/** Whether a stored value is a totals object this version can add to. */
function isTotals(v: unknown): v is SavingsTotals {
  const t = v as SavingsTotals | null
  return !!t && typeof t === 'object' && typeof t.since === 'number' && typeof t.main?.usd === 'number' && typeof t.subagents?.usd === 'number' && typeof t.overhead?.classifier === 'number'
}

function cancelTimers(): void {
  tickTimer?.cancel()
  tickTimer = null
  pingTimer?.cancel()
  pingTimer = null
}

async function stopClock($: EngineInterface): Promise<void> {
  cancelTimers()
  await update($, cacheClock, (p): CacheClockState => ({ ...p, expiresAt: null, keepWarm: false, pings: 0, lastPing: undefined }))
}

async function tick($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, clockNow, () => now)
  const st = await read($, cacheClock)
  // Once cold with nothing keeping it warm, the band shows "cold" and the ticking stops.
  if (st.expiresAt === null || (now >= st.expiresAt && !st.keepWarm)) {
    tickTimer?.cancel()
    tickTimer = null
  }
}

function startTicking($: EngineInterface): void {
  if (tickTimer) return
  tickTimer = $.clock.every(1000, () => void tick($).catch(() => undefined))
}

async function schedulePing($: EngineInterface): Promise<void> {
  pingTimer?.cancel()
  pingTimer = null
  const st = await read($, cacheClock)
  if (!st.keepWarm || st.expiresAt === null) return
  const now = await $.clock.now()
  if (st.warmSince !== undefined && now - st.warmSince >= cfg.cacheClock.maxMinutes * 60_000) {
    await update($, cacheClock, (p): CacheClockState => ({ ...p, keepWarm: false, lastPing: `stopped after ${cfg.cacheClock.maxMinutes} min (cacheClock.maxMinutes)` }))
    return
  }
  const at = nextPingAt(st.expiresAt, st.pings, cfg)
  if (at === null) {
    await update($, cacheClock, (p): CacheClockState => ({ ...p, keepWarm: false, lastPing: `stopped after ${p.pings} pings (cacheClock.maxPings)` }))
    return
  }
  const delay = Math.max(0, at - now)
  pingTimer = $.clock.after(delay, () => void ping($).catch(err => debug($, `keep-warm ping failed: ${errText(err)}`)))
}

/** One keep-warm ping: a tiny question over the chat's own cached transcript. */
async function ping($: EngineInterface): Promise<void> {
  const st = await read($, cacheClock)
  if (!st.keepWarm || st.expiresAt === null) return
  // The time limit is checked again here: it may have passed while this ping waited.
  if (st.warmSince !== undefined && (await $.clock.now()) - st.warmSince >= cfg.cacheClock.maxMinutes * 60_000) {
    await update($, cacheClock, (p): CacheClockState => ({ ...p, keepWarm: false, lastPing: `stopped after ${cfg.cacheClock.maxMinutes} min (cacheClock.maxMinutes)` }))
    return
  }
  pinging = true
  let r: Awaited<ReturnType<EngineInterface['model']['fork']>>
  try {
    r = await $.model.fork({ prompt: KEEP_WARM_PROMPT })
  } finally {
    pinging = false
  }
  const now = await $.clock.now()
  const hhmm = new Date(now).toISOString().slice(11, 16)
  if (!r.isAnswered) {
    await update($, cacheClock, (p): CacheClockState => ({ ...p, keepWarm: false, lastPing: `ping failed (${r.isAnswered ? '' : r.reason}); stopped` }))
    await writeLog($, { event: 'keep-warm', ok: false, reason: r.isAnswered ? undefined : r.reason })
    return
  }
  await recordCall($, 'keepWarm', lastAnswerModel || baseModel, r.usage, 'keep-warm ping')
  const cached = r.usage?.cache_read_input_tokens ?? 0
  if (cached > 0) {
    const ttlMs = cacheTtlMs(cfg, ttlEvidenceNow())
    await update($, cacheClock, (p): CacheClockState => ({ ...p, expiresAt: now + ttlMs, ttlMs, pings: p.pings + 1, lastPing: `pinged ${hhmm} UTC, ${formatTokens(cached)} kept warm` }))
  } else {
    await update($, cacheClock, (p): CacheClockState => ({ ...p, expiresAt: now, keepWarm: false, pings: p.pings + 1, lastPing: 'the cache had already gone cold; stopped' }))
  }
  await writeLog($, { event: 'keep-warm', ok: true, cached, usage: r.usage ?? null })
  startTicking($)
  await schedulePing($)
}

const TIER_COLOR = { haiku: 'success', sonnet: 'suggestion', opus: 'claude' } as const

export const register: Register = on => {
  cfg = DEFAULT_CONFIG
  cfgStamp = ''
  cfgWarnings = []
  dir = ''
  mode = DEFAULT_CONFIG.defaultMode
  lockModel = DEFAULT_CONFIG.defaultLockModel
  effortMode = DEFAULT_CONFIG.effort.defaultMode
  effortLock = DEFAULT_CONFIG.effort.defaultLockLevel
  logOverride = undefined
  baseModel = ''
  baseEffort = null
  override = undefined
  effortOverride = undefined
  once = null
  lastRunFailed = false
  sawMainRequest = false
  logQueue = Promise.resolve()
  agentsOverride = undefined
  handoffOverride = undefined
  clockOverride = undefined
  askedTtl = null
  provenTtl = null
  provenThisSession = false
  lastAnswerAt = 0
  lastAnswerModel = ''
  onWindows = false
  lastPricedFamily = undefined
  mainRequestPending = false
  tickTimer = null
  pingTimer = null
  pinging = false
  agentPaneOpened = false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try {
      dir = await resolveDir($)
      baseModel = await $.session.model()
      await loadConfig($, true)
      const storedMode = await $.store.get('mode')
      const storedVersion = await $.store.get('storeVersion')
      const storedLock = await $.store.get('lockModel')
      const storedLog = await $.store.get('logging')
      const storedEffortMode = await $.store.get('effortMode')
      const storedEffortLock = await $.store.get('effortLock')
      // 1.x stored "manual" for what is now "recommend".
      const migrated = storedMode === 'manual' && storedVersion !== STORE_VERSION ? 'recommend' : storedMode
      mode = typeof migrated === 'string' && ['auto', 'recommend', 'manual', 'off', 'lock'].includes(migrated) ? (migrated as Mode) : cfg.defaultMode
      if (storedVersion !== STORE_VERSION) {
        if (storedMode !== undefined) await $.store.set('mode', mode)
        await $.store.set('storeVersion', STORE_VERSION)
      }
      lockModel = typeof storedLock === 'string' && (TIERS as readonly string[]).includes(storedLock) ? (storedLock as Tier) : cfg.defaultLockModel
      logOverride = typeof storedLog === 'boolean' ? storedLog : undefined
      effortMode = storedEffortMode === 'auto' || storedEffortMode === 'lock' ? storedEffortMode : cfg.effort.defaultMode
      effortLock = isEffort(storedEffortLock) ? storedEffortLock : cfg.effort.defaultLockLevel
      const storedAgents = await $.store.get('subagents')
      const storedHandoff = await $.store.get('handoff')
      const storedClock = await $.store.get('cacheClock')
      const storedTtl = await $.store.get('cacheTtl')
      const now0 = await $.clock.now()
      const storedTotals = await $.store.get('savingsTotals')
      const allTime = isTotals(storedTotals) ? storedTotals : emptyTotals(now0)
      await update($, savingsAll, (): SavingsTotals => allTime)
      await update($, savingsSession, (t): SavingsTotals => (t.since ? t : emptyTotals(now0)))
      provenTtl = storedTtl === '1h' || storedTtl === '5m' ? storedTtl : null
      agentsOverride = typeof storedAgents === 'boolean' ? storedAgents : undefined
      handoffOverride = typeof storedHandoff === 'boolean' ? storedHandoff : undefined
      clockOverride = typeof storedClock === 'boolean' ? storedClock : undefined
      // After a hot reload, carry on with what the session was already routed to.
      const s = normalize(await read($, session))
      if (mode === 'off' || s.disabledReason) {
        override = undefined
        effortOverride = undefined
      } else {
        override = mode === 'lock' ? modelFor(lockModel) : mode === 'manual' ? undefined : modelFor(s.effective)
        effortOverride = effortFor(effortMode === 'lock' ? effortLock : mode === 'manual' ? null : s.effort)
      }
    } catch (err) {
      debug($, `startup failed, routing stays off this session: ${errText(err)}`)
      override = undefined
      effortOverride = undefined
      mode = 'off'
    }
    try {
      await $.command.register({
        name: 'route',
        description: 'Model router: auto, recommend, manual, off, lock <model>, next <model> [effort], effort auto|lock <level>',
        argumentHint: '[auto|recommend|manual|off|lock <model>|next <model> [effort]|effort auto|effort lock <level>|status|log on|off|reload|help]',
        immediate: true,
      })
      await $.command.register({
        name: 'handoff',
        description: 'Write a detailed handoff prompt (on Sonnet) to carry this chat on in a fresh one',
        argumentHint: '[new|here|copy]',
        immediate: true,
      })
    } catch (err) {
      debug($, `could not register /route or /handoff: ${errText(err)}`)
    }
    // After a hot reload: carry on with a countdown or keep-warm that was running.
    try {
      const st = await read($, cacheClock)
      if (st.expiresAt !== null && clockOn()) {
        const now = await $.clock.now()
        await update($, clockNow, () => now)
        startTicking($)
        if (st.keepWarm) await schedulePing($)
      }
    } catch (err) {
      debug($, `cache clock restore failed: ${errText(err)}`)
    }
    await refreshStatus($).catch(() => undefined)
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || !PERSON_ORIGINS.has(e.origin.kind)) {
      return next(e)
    }
    try {
      await loadConfig($)
      // A model picked in the app or with /model since the last prompt: the person's choice wins.
      const sessionModel = await $.session.model().catch(() => '')
      if (baseModel && sessionModel && isOtherModel(sessionModel, baseModel, cfg)) await notePersonPick($, { model: sessionModel })
      const s = normalize(await read($, session))
      // A /route next waiting for this prompt.
      once = null
      const pending = s.pendingNext
      if (pending) {
        activateOnce(pending)
        await update($, session, p => ({ ...normalize(p), pendingNext: null, escalation: null }))
        await writeLog($, { event: 'next', tier: pending.tier, effort: pending.effort })
      }
      // "That didn't work": escalate from what ran last.
      if (mode !== 'off' && !pending && !s.escalation && s.last && isNegativeFeedback(e.text, cfg)) {
        // Recommend mode shows it in the dialog that follows; manual mode gets a toast.
        await noteFailure($, 'you said the last result was poor', mode === 'manual')
      }
      if (mode === 'auto' || mode === 'recommend' || mode === 'lock') {
        const classified = await classifyPrompt($, e.text, s, pending !== null)
        await route($, e.text, pending !== null, classified)
      } else if (mode === 'manual') {
        // No analysis. A pending escalation was already suggested; it is not applied.
        await update($, session, p => ({ ...normalize(p), escalation: null }))
      }
      await refreshStatus($)
    } catch (err) {
      // Never block the prompt: keep the current model and carry on.
      debug($, `routing failed, keeping the current model: ${errText(err)}`)
      await writeLog($, { event: 'error', where: 'route', error: errText(err) })
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // never block a prompt, even if the hook overruns

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && !pinging) {
      // A turn refreshes the cache: the countdown restarts when it ends.
      await stopClock($).catch(() => undefined)
    }
    if (e.agentId === undefined) {
      lastRunFailed = false
      if (once && once.turnId === undefined) once = { ...once, turnId: e.turnId }
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || pinging) return yield* next(e)
    // `e` is the session's own model and effort, before any rewrite of ours: a change since
    // the last request means the person picked something in the app.
    if (baseModel && isOtherModel(e.model, baseModel, cfg)) await notePersonPick($, { model: e.model }).catch(() => undefined)
    if (isEffort(e.effort)) {
      if (baseEffort !== null && e.effort !== baseEffort) await notePersonPick($, { effort: e.effort }).catch(() => undefined)
      else baseEffort = e.effort
    }
    sawMainRequest = true
    mainRequestPending = true
    const isOnce = once !== null && once.turnId === e.turnId
    const model = (isOnce ? once?.model : undefined) ?? override
    const effort = (isOnce ? once?.effort : undefined) ?? effortOverride
    const rewrite = { ...e }
    let changed = false
    if (model !== undefined && model !== e.model) {
      rewrite.model = model
      changed = true
    }
    if (effort !== undefined && effort !== e.effort) {
      rewrite.effort = effort
      changed = true
    }
    const sentModel = rewrite.model
    if (!changed) {
      const result = yield* next(e)
      await learnTtl($, e.index, sentModel, result?.usage)
      return result
    }
    const stream = next(rewrite)
    let hasOutput = false
    try {
      while (true) {
        const step = await stream.next()
        if (step.done) {
          await learnTtl($, e.index, sentModel, step.value?.usage)
          return step.value
        }
        hasOutput = true
        yield step.value
      }
    } catch (err) {
      if (hasOutput) throw err
      // The routed model or effort was refused before anything streamed (unknown alias,
      // no access on this provider...). Pause routing and run on the session's own.
      const reason = `${model ?? e.model}${effort ? ` · ${effort}` : ''} unavailable`
      override = undefined
      effortOverride = undefined
      once = null
      await update($, session, s => ({ ...normalize(s), effective: tierOf(baseModel, cfg) ?? null, effort: null, disabledReason: reason })).catch(() => undefined)
      await writeLog($, { event: 'error', where: 'turn.step', model, effort, error: errText(err) })
      $.ui.toast(`model-router: ${reason} (${errText(err)}); using the session's own model and effort. /route reload resumes.`)
      await refreshStatus($).catch(() => undefined)
      return yield* next(e)
    }
  })

  // Watches test and build runs for escalation. Read-only: it never changes a call.
  const seen = new WeakMap<object, unknown>()
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    seen.set(e, result)
    try {
      if (isTestCommand(e.command, cfg)) {
        const r = result as { result?: { stdout?: unknown; stderr?: unknown }; isError?: boolean }
        const out = `${String(r.result?.stdout ?? '')}\n${String(r.result?.stderr ?? '')}`
        lastRunFailed = runFailed(r.isError === true, out, cfg)
      }
    } catch {
      // Watching for failures must never affect the tool call.
    }
    return result
  }).catch(($, e, next) => {
    // Never run a command twice: hand back the result already obtained.
    const done = seen.get(e)
    if (done !== undefined) return done as never
    return next.called ? { deny: 'model-router could not read this result' } : next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) {
      // A subagent finished: mark its row in the subagent pane.
      const agentId = e.agentId
      await update($, agentPicks, list => list.map(r => (r.agentId === agentId && r.status === 'running' ? { ...r, status: 'done' } : r))).catch(() => undefined)
      // Its cost on the model it ran on, and on the one it would otherwise have used.
      try {
        const row = (await read($, agentPicks)).find(r => r.agentId === agentId)
        if (row && row.insteadOf && e.usage && cfg.savings.enabled) {
          const ranOn = e.usage.model || row.model
          const cost = priceOf(e.usage, ranOn, cfg.savings.prices)
          const instead = priceOf(e.usage, row.insteadOf, cfg.savings.prices)
          const at = await $.clock.now()
          const label = `${row.agentType || 'subagent'}: ${row.description || 'task'}`.slice(0, 80)
          if (cost === null || instead === null) await recordCost($, { at, kind: 'unpriced', ranOn, label })
          else {
            await update($, agentPicks, list => list.map(r => (r.agentId === agentId ? { ...r, usd: cost, insteadOfUsd: instead } : r)))
            await recordCost($, { at, kind: 'subagent', ranOn, insteadOf: row.insteadOf, usd: cost, insteadOfUsd: instead, label, risky: row.risky })
          }
        }
      } catch (err) {
        debug($, `subagent cost failed: ${errText(err)}`)
      }
      return result
    }
    if (pinging) return result
    // Cost: this turn on the model it ran on, and on the session's own model.
    try {
      if (cfg.savings.enabled && e.usage) {
        const at = await $.clock.now()
        const ranOn = e.usage.model || (override ?? baseModel)
        const insteadOf = baseModel || ranOn
        const family = familyOf(ranOn)
        // Had the session's model kept running, its cache would still be warm when the last
        // answer came recently; a turn that switched model rebuilt that cache instead.
        const idle = lastAnswerAt > 0 ? at - (e.durationMs ?? 0) - lastAnswerAt : Number.POSITIVE_INFINITY
        const switched = lastPricedFamily !== undefined && family !== lastPricedFamily
        const wouldHit = switched && idle < cacheTtlMs(cfg, ttlEvidenceNow())
        const cost = priceOf(e.usage, ranOn, cfg.savings.prices)
        const instead = priceOf(insteadOfTokens(e.usage, wouldHit), insteadOf, cfg.savings.prices)
        const label = familyOf(ranOn) === familyOf(insteadOf) ? `${famName(ranOn)}, your model${wouldHit ? ' (switched back)' : ''}` : `${famName(ranOn)} instead of ${famName(insteadOf)}${wouldHit ? ' (cache rebuilt)' : ''}`
        if (cost === null || instead === null) await recordCost($, { at, kind: 'unpriced', ranOn, label })
        else await recordCost($, { at, kind: 'main', ranOn, insteadOf, usd: cost, insteadOfUsd: instead, label })
        lastPricedFamily = family
      }
    } catch (err) {
      debug($, `turn cost failed: ${errText(err)}`)
    }
    // Cache clock: the answer just written is cached from now.
    try {
      lastAnswerAt = await $.clock.now()
      lastAnswerModel = override ?? baseModel
      if (clockOn()) {
        const now = await $.clock.now()
        const ttlMs = cacheTtlMs(cfg, ttlEvidenceNow())
        const tokens = (await $.session.usage().catch(() => null))?.context.tokens
        cancelTimers()
        await update($, cacheClock, (): CacheClockState => ({ expiresAt: now + ttlMs, ttlMs, tokens, keepWarm: false, pings: 0 }))
        await update($, clockNow, () => now)
        startTicking($)
      }
    } catch (err) {
      debug($, `cache clock failed: ${errText(err)}`)
    }
    // Handoff: once per long chat, when the context passes the threshold.
    try {
      if (handoffOn() && cfg.handoff.autoAtTokens > 0) {
        const tokens = (await $.session.usage().catch(() => null))?.context.tokens
        const h = await read($, handoffState)
        if (tokens !== undefined && tokens >= cfg.handoff.autoAtTokens && !h.autoFired && h.status !== 'writing') {
          startHandoff($, 'auto')
        } else if (tokens !== undefined && tokens < cfg.handoff.autoAtTokens / 2 && h.autoFired) {
          // The chat was compacted or restarted: arm it again.
          await update($, handoffState, (p): HandoffState => ({ ...p, autoFired: false }))
        }
      }
    } catch (err) {
      debug($, `handoff check failed: ${errText(err)}`)
    }
    try {
      const failure =
        e.reason === 'error'
          ? 'the last response ended in an API error'
          : e.reason === 'refusal'
            ? 'the last response was refused'
            : e.reason === 'answer' && lastRunFailed
              ? 'tests or the build were still failing at the end of the last turn'
              : null
      // Per-turn cost, so the log can show what each effort level spends.
      if (loggingOn()) {
        await writeLog($, {
          event: 'turn',
          turnId: e.turnId,
          reason: e.reason,
          model: override ?? baseModel,
          effort: effortOverride ?? baseEffort ?? 'default',
          durationMs: e.durationMs,
          usage: e.usage ?? null,
        })
      }
      // The answer the next prompt is read against, for the classifier.
      await update($, session, p => ({ ...normalize(p), lastAnswer: String(e.answer ?? '').slice(0, 600) }))
      if (failure) await noteFailure($, failure)
      lastRunFailed = false
      if (once && (once.turnId === undefined || once.turnId === e.turnId)) once = null
      await refreshStatus($)
    } catch (err) {
      debug($, `turn end handling failed: ${errText(err)}`)
    }
    return result
  })

  on('command.run', { command: 'route' }, async ($, e) => {
    const cmd = parseRouteCommand(e.args, cfg)
    try {
      switch (cmd.kind) {
        case 'help':
          return { text: HELP_TEXT }
        case 'error':
          return { text: `${cmd.message}\n\n${HELP_TEXT}` }
        case 'mode': {
          await applyMode($, cmd.mode)
          const what: Record<string, string> = {
            off: `Routing off. Using the session model (${baseModel}) and effort.`,
            auto: 'Routing set to auto. Model and effort switch automatically.',
            recommend: 'Routing set to recommend. You will be asked before a change.',
            manual: 'Routing set to manual. No analysis: use /model, /route next or /route effort lock.',
          }
          return { text: what[cmd.mode] ?? `Routing set to ${cmd.mode}.` }
        }
        case 'lock':
          await applyMode($, 'lock', cmd.model)
          return { text: `Locked to ${cap(cmd.model)} (${cfg.models[cmd.model]}). Effort: ${effortMode === 'lock' ? effortLock : 'picked per prompt'}.` }
        case 'next': {
          const pending = { tier: cmd.tier, effort: cmd.effort }
          await update($, session, s => ({ ...normalize(s), pendingNext: pending }))
          await refreshStatus($)
          const parts = [cmd.tier ? cap(cmd.tier) : 'the current model', cmd.effort ? `${cmd.effort} effort` : 'the current effort']
          return { text: `Next prompt only: ${parts.join(' at ')}. Then back to ${mode}.` }
        }
        case 'next-clear':
          await update($, session, s => ({ ...normalize(s), pendingNext: null }))
          await refreshStatus($)
          return { text: 'Next-prompt override cleared.' }
        case 'effort-auto':
          await applyEffortMode($, 'auto')
          return { text: mode === 'manual' ? 'Effort: the session\'s own (manual mode runs no analysis).' : 'Effort is now picked per prompt.' }
        case 'effort-lock':
          await applyEffortMode($, 'lock', cmd.level)
          return { text: `Effort locked to ${cmd.level}${mode === 'off' ? ' (applies once routing is on)' : ''}.` }
        case 'log':
          logOverride = cmd.enabled
          await $.store.set('logging', cmd.enabled)
          if (cmd.enabled) await writeLog($, { event: 'log-on' })
          return { text: `Routing log ${cmd.enabled ? `on: ${logPath()}` : 'off'}.` }
        case 'reload': {
          await loadConfig($, true)
          await update($, session, s => ({ ...normalize(s), disabledReason: null }))
          if (mode === 'lock') override = modelFor(lockModel)
          if (effortMode === 'lock' && mode !== 'off') effortOverride = effortFor(effortLock)
          await refreshStatus($)
          return { text: cfgWarnings.length ? `Reloaded with warnings:\n- ${cfgWarnings.join('\n- ')}` : `Reloaded ${configPath()}.` }
        }
        case 'savings': {
          if (cmd.reset) {
            const now = await $.clock.now()
            await update($, savingsAll, (): SavingsTotals => emptyTotals(now))
            await $.store.set('savingsTotals', emptyTotals(now))
            await writeLog($, { event: 'savings-reset' })
          }
          void $.ui.open({ id: SAVINGS_PANE, title: 'Savings' }).catch(() => undefined)
          const ses = await read($, savingsSession)
          const all = await read($, savingsAll)
          return {
            text: `${cmd.reset ? 'All-time savings reset. ' : ''}Saved ${usd(netSaved(ses))} this session and ${usd(netSaved(all))} in all. Details in the Savings pane.${cfg.savings.enabled ? '' : ' (Savings tracking is off: savings.enabled in the config.)'}`,
          }
        }
        case 'resume': {
          const s = normalize(await read($, session))
          await update($, session, p => ({ ...normalize(p), personPick: null }))
          await refreshStatus($)
          return { text: s.personPick ? 'The router chooses again from your next prompt.' : 'Nothing to resume: the router was not holding a pick of yours.' }
        }
        case 'feature': {
          const key = cmd.feature === 'agents' ? 'subagents' : cmd.feature === 'handoff' ? 'handoff' : 'cacheClock'
          if (cmd.enabled !== undefined) {
            if (cmd.feature === 'agents') agentsOverride = cmd.enabled
            else if (cmd.feature === 'handoff') handoffOverride = cmd.enabled
            else clockOverride = cmd.enabled
            await $.store.set(key, cmd.enabled)
            if (cmd.feature === 'clock' && !cmd.enabled) await stopClock($)
            await writeLog($, { event: 'feature', feature: cmd.feature, enabled: cmd.enabled })
          }
          if (cmd.feature === 'agents') {
            if (cmd.enabled !== false) void $.ui.open({ id: AGENTS_PANE, title: 'Subagent models' }).catch(() => undefined)
            const rows = await read($, agentPicks)
            const on_ = agentsOn()
            return { text: `Subagent router ${on_ ? 'on' : `off${mode === 'off' ? ' (routing is off)' : ''}`}. ${rows.length} subagent${rows.length === 1 ? '' : 's'} seen this session.${cmd.enabled !== false ? ' Pane: Subagent models.' : ''}` }
          }
          if (cmd.feature === 'handoff') {
            if (cmd.enabled === undefined) void $.ui.open({ id: HANDOFF_PANE, title: 'Handoff' }).catch(() => undefined)
            return { text: `Automatic handoff ${handoffOn() ? `on: written once the chat reaches ${formatTokens(cfg.handoff.autoAtTokens)}` : 'off'}. /handoff writes one any time.` }
          }
          return { text: `Cache clock ${clockOn() ? 'on' : 'off'}. Cache lifetime: ${cfg.cacheClock.ttlMinutes > 0 ? `${cfg.cacheClock.ttlMinutes} min (config)` : `${ttlEvidenceNow() === '1h' ? 60 : 5} min (detected)`}.` }
        }
        case 'status': {
          await loadConfig($)
          const s = normalize(await read($, session))
          const cur = currentCombo(s)
          const lines = [
            `Mode:        ${mode}${mode === 'lock' ? ` (${lockModel})` : ''}`,
            `Effort:      ${effortMode === 'lock' ? `locked at ${effortLock}` : mode === 'manual' || mode === 'off' ? "session's own" : 'picked per prompt'}`,
            `Session:     ${baseModel} · ${baseEffort ?? 'default'}`,
            `Running on:  ${override ?? baseModel} · ${effortOverride ?? baseEffort ?? 'default'}`,
            s.pendingNext ? `Next only:   ${s.pendingNext.tier ?? 'same model'} · ${s.pendingNext.effort ?? 'same effort'}` : '',
            s.last
              ? `Last:        recommended ${formatCombo(s.last.recommended)}, ran ${formatCombo({ tier: s.last.chosen.tier ?? cur.tier ?? 'sonnet', effort: s.last.chosen.effort })} — ${s.last.reason}${s.last.heldBecause ? ` (held: ${s.last.heldBecause})` : ''}`
              : 'Last:        no prompt routed yet',
            s.escalation ? `Escalation:  ${s.escalation.reason}` : '',
            s.disabledReason ? `Paused:      ${s.disabledReason}` : '',
            `Config:      ${configPath()}${cfg.configVersion < 2 ? ' (1.x format: effort settings use defaults; delete the file to get the new commented template)' : ''}`,
            `Log:         ${loggingOn() ? logPath() : 'off'}`,
            `Subagents:   ${agentsOn() ? `routed by Haiku${cfg.subagents.riskyToOpus ? `, risky tasks (${pct(cfg.subagents.riskyAt)}+) to Opus` : ''} (/route agents shows the pane)` : 'off'}`,
            `Saved:       ${cfg.savings.enabled ? `${usd(netSaved(await read($, savingsSession)))} this session, ${usd(netSaved(await read($, savingsAll)))} in all (/route savings)` : 'not tracked'}`,
            `Handoff:     ${handoffOn() ? `automatic at ${formatTokens(cfg.handoff.autoAtTokens)}` : 'automatic off'}; /handoff any time`,
            `Cache clock: ${clockOn() ? `on (${cfg.cacheClock.ttlMinutes > 0 ? cfg.cacheClock.ttlMinutes : ttlEvidenceNow() === '1h' ? 60 : 5} min cache)` : 'off'}`,
            cfgWarnings.length ? `Warnings:\n- ${cfgWarnings.join('\n- ')}` : '',
            '',
            HELP_TEXT,
          ]
          return { text: lines.filter(l => l !== '').join('\n') }
        }
      }
    } catch (err) {
      return { text: `model-router: ${errText(err)}` }
    }
  })

  // -------------------------------------------------------------------------
  // Subagent router: Haiku reads each subagent's task and picks its model.
  on('agent.spawn', async ($, e, next) => {
    // Forks always inherit; resumes and teammates keep what they started with.
    if (!agentsOn() || e.fork || e.resume || e.isTeammate) return next(e)
    await loadConfig($)
    const now = await $.clock.now()
    const id = e.tool_use_id || `agent-${now}`
    const row: AgentPickRow = {
      id,
      at: now,
      description: e.description ?? '',
      agentType: e.subagentType ?? '',
      pick: null,
      confidence: null,
      reason: '',
      note: 'Haiku is reading the task',
      model: '',
      status: 'picking',
      // Without the router it runs on the model the call named, else its parent's.
      insteadOf: e.model || e.parentModel,
    }
    if (e.model && cfg.subagents.keepCallerModel) {
      row.note = `the call asked for ${e.model}; kept`
      row.model = e.model
      row.status = 'skipped'
    }
    await update($, agentPicks, list => [...list, row].slice(-200))
    if (cfg.subagents.openPane && !agentPaneOpened) {
      agentPaneOpened = true
      void $.ui.open({ id: AGENTS_PANE, title: 'Subagent models' }).catch(() => undefined)
    }
    let rewrite = e
    if (row.status === 'picking') {
      const pick = await pickAgentModel($, e)
      const d = decideAgentModel(pick, e.parentModel, cfg)
      const ms = (await $.clock.now()) - now
      await patchPick($, id, {
        pick: pick?.tier ?? null,
        confidence: pick?.confidence ?? null,
        reason: pick?.reason ?? '',
        note: d.note,
        model: d.model ?? 'inherit',
        status: 'running',
        ms,
        risk: pick?.risk ?? null,
        risky: d.risky,
      })
      await writeLog($, {
        event: 'subagent',
        agentType: e.subagentType,
        parentModel: e.parentModel,
        pick: pick?.tier ?? null,
        confidence: pick?.confidence ?? null,
        risk: pick?.risk ?? null,
        risky: d.risky,
        model: d.model ?? 'inherit',
        note: d.note,
        ms,
        prompt: cfg.logging.includePromptExcerpt ? e.prompt.slice(0, 80) : undefined,
      })
      if (d.model !== undefined) rewrite = { ...e, model: d.model }
    }
    let result
    try {
      result = await next(rewrite)
    } catch (err) {
      if (rewrite === e) throw err
      // The picked model was refused before the subagent started: run it on the parent's.
      debug($, `subagent model ${rewrite.model} refused (${errText(err)}); parent model used`)
      await patchPick($, id, { note: `${rewrite.model} unavailable; parent model used`, model: 'inherit' })
      result = await next(e)
    }
    if ('deny' in result && result.deny) {
      await patchPick($, id, { status: 'denied', note: `not started: ${String(result.deny)}` })
    } else if ('model' in result) {
      await patchPick($, id, { agentId: result.agentId, model: String(result.model), status: row.status === 'skipped' ? 'skipped' : 'running' })
    }
    return result
  }).catch(($, e, next) => next(e)) // never block a subagent: on any failure it starts as asked

  on('ui.render', { component: 'Pane', requestId: AGENTS_PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const rows = await read($, agentPicks)
    const room = Math.max(2, Math.floor(((e.viewport?.rows ?? 24) - 4) / 2))
    const routed = rows.filter(r => r.pick !== null)
    const count = (t: Tier) => rows.filter(r => r.pick === t).length
    return (
      <Box flexDirection="column">
        <Text dimColor>
          {agentsOn() ? 'Haiku picks each subagent\'s model.' : 'Subagent router is off (/route agents on).'}{' '}
          {rows.length} seen · Haiku {count('haiku')} · Sonnet {count('sonnet')} · Opus {count('opus')}
          {routed.length > 0 ? ` · avg confidence ${pct(routed.reduce((a, r) => a + (r.confidence ?? 0), 0) / routed.length)}` : ''}
        </Text>
        {rows.length === 0 && <Text dimColor>No subagents yet. Each one appears here with Haiku's pick and how sure it was.</Text>}
        {rows
          .slice(-room)
          .reverse()
          .map(r => (
            <Box flexDirection="column">
              <Text>
                <Text color={r.pick ? TIER_COLOR[r.pick] : undefined} bold>
                  {r.status === 'picking' ? 'picking…' : r.pick ? capWord(r.pick) : r.status === 'skipped' ? 'caller' : 'parent'}
                </Text>
                {r.confidence !== null ? ` ${pct(r.confidence)}` : ''}  {r.agentType || 'agent'} · {r.description || '(no description)'}
              </Text>
              <Text dimColor>
                {'   '}
                {[
                  r.reason,
                  r.note,
                  r.risk !== null && r.risk !== undefined && !r.risky ? `risk ${pct(r.risk)}` : '',
                  r.model && r.model !== 'inherit' ? `runs on ${r.model}` : r.model === 'inherit' ? 'runs on the parent model' : '',
                  r.status === 'done' ? 'done' : r.status === 'denied' ? '' : r.status === 'running' ? 'running' : '',
                  r.usd !== undefined && r.insteadOfUsd !== undefined
                    ? r.insteadOfUsd - r.usd >= 0
                      ? `saved ${usd(r.insteadOfUsd - r.usd)}`
                      : `cost ${usd(r.usd - r.insteadOfUsd)} more`
                    : '',
                  r.ms !== undefined ? `${(r.ms / 1000).toFixed(1)}s to pick` : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </Box>
          ))}
      </Box>
    )
  })

  // -------------------------------------------------------------------------
  // Savings pane: what the routing cost, against what the same work would have cost.
  on('ui.render', { component: 'Pane', requestId: SAVINGS_PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const ses = await read($, savingsSession)
    const all = await read($, savingsAll)
    const recent = await read($, savingsRecent)
    const day = (ms: number) => (ms ? new Date(ms).toISOString().slice(0, 10) : 'today')
    const share = (t: SavingsTotals) => {
      const s = savedShare(t)
      return s === null ? '' : ` (${Math.round(s * 100)}%)`
    }
    const bucket = (name: string, b: SavingsTotals['main'], unit: string) => (
      <Text>
        {name}: {b.count} {unit}
        {b.count === 1 ? '' : 's'}, {b.moved} on another model · cost {usd(b.usd)} instead of {usd(b.insteadOfUsd)} ·{' '}
        <Text color={b.insteadOfUsd - b.usd >= 0 ? 'success' : 'warning'}>
          {b.insteadOfUsd - b.usd >= 0 ? 'saved' : 'extra'} {usd(Math.abs(b.insteadOfUsd - b.usd))}
        </Text>
      </Text>
    )
    const room = Math.max(3, (e.viewport?.rows ?? 30) - 17)
    return (
      <Box flexDirection="column">
        <Text>
          <Text bold color={netSaved(ses) >= 0 ? 'success' : 'warning'}>
            {netSaved(ses) >= 0 ? 'Saved' : 'Extra'} {usd(Math.abs(netSaved(ses)))}
          </Text>{' '}
          this session{share(ses)} · {usd(netSaved(all))} in all{share(all)} since {day(all.since)}
        </Text>
        {!cfg.savings.enabled && <Text color="warning">Tracking is off: set savings.enabled in the config.</Text>}
        <Text bold>This session</Text>
        {bucket('Main chat', ses.main, 'turn')}
        {bucket('Subagents', ses.subagents, 'run')}
        {ses.riskExtra > 0 && <Text dimColor>   Risky tasks sent to Opus cost {usd(ses.riskExtra)} more (counted above).</Text>}
        <Text dimColor>
          Router's own calls, taken off the saving: prompt classifier {usd(ses.overhead.classifier)}, subagent picks {usd(ses.overhead.picks)}
        </Text>
        <Text dimColor>
          Spending you chose, not taken off: handoffs {usd(ses.overhead.handoff)}, keep-warm pings {usd(ses.overhead.keepWarm)}
        </Text>
        {ses.unpriced > 0 && <Text dimColor>{ses.unpriced} turn{ses.unpriced === 1 ? '' : 's'} on a model with no price were left out.</Text>}
        <Text bold>All time</Text>
        {bucket('Main chat', all.main, 'turn')}
        {bucket('Subagents', all.subagents, 'run')}
        <Text bold>Latest</Text>
        {recent.length === 0 && <Text dimColor>Nothing priced yet. Each answer and each subagent run appears here when it ends.</Text>}
        {recent
          .slice(-room)
          .reverse()
          .map(item => {
            const time = new Date(item.at).toISOString().slice(11, 16)
            if (item.kind === 'overhead') return <Text dimColor>{time} {item.label} · {usd(item.usd)}</Text>
            if (item.kind === 'unpriced') return <Text dimColor>{time} {item.label} · no price for {item.ranOn}</Text>
            const d = item.insteadOfUsd - item.usd
            return (
              <Text>
                {time} {item.kind === 'subagent' ? 'subagent ' : ''}
                {item.label}
                {item.risky ? ' (risky)' : ''} ·{' '}
                <Text color={d >= 0 ? 'success' : 'warning'}>
                  {d >= 0 ? 'saved' : 'extra'} {usd(Math.abs(d))}
                </Text>
              </Text>
            )
          })}
        <Text dimColor>
          Estimates: each turn's real token counts at list prices, on the model that ran and on the one that would have run (your session's model, or a subagent's parent). A model switch that rebuilt the cache is charged to the router. Effort changes are not priced. Prices: savings.prices in the config. /route savings reset starts the all-time total again.
        </Text>
      </Box>
    )
  })

  // -------------------------------------------------------------------------
  // Handoff for long chats.
  on('command.run', { command: 'handoff' }, async ($, e) => {
    try {
      await loadConfig($)
      const arg = e.args.trim().toLowerCase()
      if (arg === 'new' || arg === 'open') return { text: await openInNewChat($) }
      if (arg === 'here' || arg === 'start') {
        const ready = await read($, handoffState)
        if (ready.status !== 'ready') return { text: 'There is no handoff ready yet. Type /handoff to write one.' }
        // Compacting cannot happen inside this command's own dispatch: right after it.
        $.clock.after(0, () => void startFromHandoff($).then(t => $.ui.toast(t), err => $.ui.toast(`Could not start fresh: ${errText(err)}`)))
        return { text: 'Restarting this chat from the handoff…' }
      }
      if (arg === 'copy') return { text: await copyHandoff($) }
      const h = await read($, handoffState)
      void $.ui.open({ id: HANDOFF_PANE, title: 'Handoff' }).catch(() => undefined)
      if (h.status === 'writing') return { text: 'A handoff is already being written; it will appear in the Handoff pane.' }
      startHandoff($, 'command')
      return { text: `Writing a handoff on ${cfg.handoff.model}. It reads the whole chat, so it can take a minute; it will appear in the Handoff pane.` }
    } catch (err) {
      return { text: `model-router: ${errText(err)}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: HANDOFF_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const ho = await read($, handoffState)
    const surface = e.surface
    const write = () => startHandoff($, 'command')
    return (
      <Box flexDirection="column">
        {ho.status === 'idle' && (
          <Box flexDirection="column">
            <Text dimColor>
              No handoff yet. Type /handoff, or one is written automatically once the chat reaches {formatTokens(cfg.handoff.autoAtTokens)}
              {handoffOn() ? '' : ' (automatic handoff is off)'}.
            </Text>
            <Button key="write" label="Write handoff now" onPress={write} />
          </Box>
        )}
        {ho.status === 'writing' && <Text dimColor>Writing a handoff on {cfg.handoff.model}: it reads the whole chat, which can take a minute…</Text>}
        {ho.status === 'failed' && (
          <Box flexDirection="column">
            <Text color="error">The handoff could not be written: {ho.detail ?? 'unknown error'}</Text>
            <Button key="retry" label="Try again" onPress={write} />
          </Box>
        )}
        {(ho.status === 'ready' || ho.status === 'applied') && (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Button
                key="new-chat"
                label="Start new chat"
                onPress={async () => {
                  $.ui.toast(await openInNewChat($).catch(err => `Could not open a new chat: ${errText(err)}`))
                }}
              />
              <Button key="copy" label="Copy" onPress={async () => $.ui.toast(await copyHandoff($, surface))} />
              {ho.status === 'ready' && (
                <Button
                  key="fresh"
                  label="Continue here"
                  onPress={async () => {
                    $.ui.toast(await startFromHandoff($).catch(err => `Could not start fresh: ${errText(err)}`))
                  }}
                />
              )}
              <Button key="rewrite" label="Rewrite" onPress={write} />
            </Box>
            <Text dimColor>
              {ho.status === 'applied' ? 'This chat was restarted from this handoff. ' : ''}
              {ho.detail ?? ''}
              {ho.file ? ` · saved to ${ho.file}` : ''}
            </Text>
            <Text>{ho.text}</Text>
          </Box>
        )}
      </Box>
    )
  })

  // -------------------------------------------------------------------------
  // Cache clock: learns the cache lifetime the main loop asks for. Read-only.
  on('http.fetch', async ($, e, next) => {
    if (mainRequestPending && next.origin.plugin === 'engine' && /\/v1\/messages/.test(e.url)) {
      mainRequestPending = false
      const body = e.init?.body
      if (typeof body === 'string') askedTtl = asksOneHourCache(body) ? '1h' : '5m'
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // read-only: never touches a request

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!clockOn() || e.props.hasSurvey || e.props.isWorking) return next(e)
    const st = await read($, cacheClock)
    if (st.expiresAt === null) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await read($, clockNow)
    const left = st.expiresAt - now
    if (left <= 0) {
      // A big chat that went cold costs the same to resume as to restart small from a handoff.
      const big = handoffOn() && st.tokens !== undefined && st.tokens >= Math.max(50_000, cfg.handoff.autoAtTokens / 2)
      return (
        <Box flexDirection="row" gap={1}>
          <Text>
            <Text color="warning">Cache cold</Text>
            <Text dimColor>
              {' '}· your next message re-reads {formatTokens(st.tokens)} at full price{st.lastPing ? ` · ${st.lastPing}` : ''}
              {big ? ' · a handoff to a short new chat may cost less' : ''}
            </Text>
          </Text>
          {big && <Button key="cold-handoff" label="Write handoff" onPress={() => startHandoff($, 'command')} />}
        </Box>
      )
    }
    const color = left < 60_000 ? 'warning' : 'success'
    return (
      <Box flexDirection="row" gap={1}>
        <Text>
          <Text color={color}>Cache warm {formatCountdown(left)}</Text>
          <Text dimColor>
            {' '}
            {st.keepWarm
              ? `· keeping warm, ping ${st.pings}/${cfg.cacheClock.maxPings}${st.lastPing ? ` · ${st.lastPing}` : ''}`
              : `· then your next message costs full price (${formatTokens(st.tokens)})${st.lastPing ? ` · keep warm ${st.lastPing}` : ''}`}
          </Text>
        </Text>
        {st.keepWarm ? (
          <Button
            key="stop-warm"
            label="Stop"
            onPress={async () => {
              pingTimer?.cancel()
              pingTimer = null
              await update($, cacheClock, (p): CacheClockState => ({ ...p, keepWarm: false }))
            }}
          />
        ) : (
          <Button
            key="keep-warm"
            label="Keep warm"
            onPress={async () => {
              const since = await $.clock.now()
              await update($, cacheClock, (p): CacheClockState => ({ ...p, keepWarm: true, warmSince: since, lastPing: undefined }))
              await schedulePing($)
            }}
          />
        )}
      </Box>
    )
  })

}
