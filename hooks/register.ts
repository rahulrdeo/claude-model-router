// model-router: picks Haiku, Sonnet or Opus and an effort level for each prompt.
//
// How the switch works: a `turn.step` hook rewrites the model and effort of each
// main-loop request. The session's own /model and effort settings are never
// touched, so `/route off` returns to them exactly. Subagent requests are left alone.
//
// Failure policy: every routing step is wrapped; on any error the prompt goes
// through unchanged on the current model and effort, and the error is logged.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RouterSession } from '../types'
import { CONFIG_TEMPLATE } from './config-template'
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
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  if (configured) return joinPath(configured, 'model-router')
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  if (!home) throw new Error('cannot find the home directory (HOME / USERPROFILE unset)')
  return joinPath(home, '.claude', 'model-router')
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
  logQueue = logQueue
    .then(async () => {
      const session = await $.session.id().catch(() => 'unknown')
      const line = JSON.stringify({ ts: new Date(await $.clock.now()).toISOString(), session, ...entry }) + '\n'
      const path = logPath()
      let existing = ''
      if (await $.fs.exists(path)) {
        const st = await $.fs.stat(path)
        if (st.size + line.length > cfg.logging.maxBytes) {
          await $.fs.write(`${path}.1`, await $.fs.read(path))
        } else {
          existing = await $.fs.read(path)
        }
      }
      await $.fs.write(path, existing + line)
    })
    .catch(err => debug($, `log write failed: ${errText(err)}`))
  return logQueue
}

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
  $.ui.status(text)
}

/** Applies a mode change: overrides, persisted choice, status. */
async function applyMode($: EngineInterface, next: Mode, lock?: Tier): Promise<void> {
  mode = next
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
    } catch (err) {
      debug($, `could not register /route: ${errText(err)}`)
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
    if (e.agentId === undefined) {
      lastRunFailed = false
      if (once && once.turnId === undefined) once = { ...once, turnId: e.turnId }
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    // The session's own effort, before any rewrite of ours.
    if (isEffort(e.effort)) baseEffort = e.effort
    sawMainRequest = true
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
    if (!changed) return yield* next(e)
    const stream = next(rewrite)
    let hasOutput = false
    try {
      while (true) {
        const step = await stream.next()
        if (step.done) return step.value
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
    if (e.agentId !== undefined) return result
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
}
