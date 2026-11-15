// Mode switching and routing through the engine: the test's hooks stand in for
// the engine beneath the mod (file system, session model, status line, the
// model request), so each test reads what the mod asked of it.

import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnStepResult } from 'claude-code'

const HOME = '/home/tester'
const DIR = `${HOME}/.claude/model-router`

type World = {
  files: Map<string, string>
  store: Map<string, unknown>
  status: (string | undefined)[]
  models: string[]
  efforts: (string | undefined)[]
  asked: string[]
  toasts: string[]
  /** The model the app's menu shows now; set by a test to stand for the person picking one. */
  sessionModel?: string
  /** What the classifier model answers; undefined = it gives no answer and the rules decide. */
  verdict?: string
}

/** Answers everything the mod reaches beneath it, in memory. */
function world(on: On, opts: { baseModel?: string; baseEffort?: string; store?: Record<string, unknown>; answer?: string; failModel?: string; fresh?: boolean; dialogMs?: number; bash?: { isError: boolean; stdout: string } } = {}): World {
  const w: World = { files: new Map(), store: new Map(Object.entries(opts.store ?? {})), status: [], models: [], efforts: [], asked: [], toasts: [] }
  on('store.get', (_, e) => ({ value: w.store.get(e.key) }))
  on('store.set', (_, e) => {
    w.store.set(e.key, e.value)
    return { value: undefined }
  })
  mock.env(on, { HOME })
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  on('session.model', () => ({ value: w.sessionModel ?? opts.baseModel ?? 'claude-opus-5-5' }))
  // A conversation already under way unless a test says it is brand new.
  on('session.turns', () => ({ value: opts.fresh ? 0 : 5 }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.status', (_, e) => {
    w.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    w.toasts.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('fs.exists', (_, e) => ({ value: w.files.has(e.path) }))
  on('fs.write', (_, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const text = w.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.stat', (_, e) => ({
    value: { kind: 'file', size: (w.files.get(e.path) ?? '').length, mtimeMs: 1, isLink: false },
  }))
  on('tool.call', { tool: 'AskUserQuestion' }, async (_, e) => {
    const q = e.questions[0]
    w.asked.push(`${q?.question ?? ''} | ${(q?.options ?? []).map(o => o.label).join(' / ')}`)
    // The dialog stays open for `dialogMs` of waiting for the person.
    await clock.advance(opts.dialogMs ?? 0)
    if (opts.answer === undefined) return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers: { [q?.question ?? '']: opts.answer } } } as never
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.step', async function* (_, e) {
    w.models.push(e.model)
    w.efforts.push(e.effort === undefined ? undefined : String(e.effort))
    if (opts.failModel && e.model === opts.failModel) throw new Error('model not found')
    const result = { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as unknown as TurnStepResult
    if (result.index < 0) yield undefined as never
    return result
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('model.complete', (_, e) => {
    ;((w as unknown as { classifierPrompts?: string[] }).classifierPrompts ??= []).push(String((e as { prompt?: unknown }).prompt ?? ''))
    return ({
      value: w.verdict === undefined
        ? { isAnswered: false, reason: 'aborted', usage: null }
        : { isAnswered: true, text: w.verdict, usage: null },
    }) as never
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', { tool: 'Bash' }, () => {
    const b = opts.bash ?? { isError: false, stdout: 'ok' }
    return { result: { stdout: b.stdout, stderr: '' }, isError: b.isError } as never
  })
  return w
}

const start = ($: Engine) =>
  $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })

async function step($: Engine, model = 'claude-opus-5-5', agentId?: string, turnId = 't1', effort?: string) {
  const stream = $.turn.step({ turnId, index: 0, model, messageCount: 1, agentId, effort } as never)
  for await (const _ of stream) {
    // drain
  }
}

const route = ($: Engine, args: string) =>
  $.command.run({
    command: 'route',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  } as never)

const submit = ($: Engine, text: string) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)

let turnCounter = 0
/** One whole main-loop turn: prompt, start, two requests (a tool step), optional test run, end. */
async function turn(
  $: Engine,
  text: string,
  o: { base?: string; baseEffort?: string; bash?: string; reason?: 'answer' | 'error' | 'aborted' } = {},
) {
  const turnId = `turn-${++turnCounter}`
  await submit($, text)
  await $.turn.start({ text, turnId } as never)
  await step($, o.base ?? 'claude-opus-5-5', undefined, turnId, o.baseEffort ?? 'high')
  if (o.bash) await $.tool.call({ tool: 'Bash', command: o.bash } as never)
  await step($, o.base ?? 'claude-opus-5-5', undefined, turnId, o.baseEffort ?? 'high')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId, reason: o.reason ?? 'answer' } as never)
  return turnId
}

test('first run writes the commented config file', async ($, on) => {
  const w = world(on)
  await start($)
  expect(w.files.get(`${DIR}/config.jsonc`)).toContain('"defaultMode": "recommend"')
  expect(w.files.get(`${DIR}/config.jsonc`)).toContain('"configVersion": 2')
})

test('mode changes persist and survive a new session', async ($, on) => {
  const w = world(on)
  await start($)
  const r = await route($, 'auto')
  expect(r.text).toContain('auto')
  expect(w.store.get('mode')).toBe('auto')

  await route($, 'lock haiku')
  expect(w.store.get('mode')).toBe('lock')
  expect(w.store.get('lockModel')).toBe('haiku')
  expect(w.status.at(-1)).toBe('Router locked · Haiku · default')
})

test('a stored mode is used at start', async ($, on) => {
  const w = world(on, { store: { mode: 'off' } })
  await start($)
  expect(w.status.at(-1)).toBe('Router off · claude-opus-5-5')
})

test('auto mode routes a quick question to haiku and leaves subagents alone', async ($, on) => {
  const w = world(on, { store: { mode: 'auto' } })
  await start($)
  await submit($, 'What is a closure?')
  await step($)
  await step($, 'claude-sonnet-5-5', 'agent-1')
  expect(w.models).toEqual(['haiku', 'claude-sonnet-5-5'])
  expect(w.status.at(-1)).toContain('Router auto · Haiku')
})

test('auto mode keeps the session model when it already fits', async ($, on) => {
  const w = world(on, { store: { mode: 'auto' } })
  await start($)
  await submit($, 'Design the architecture for migrating our monolith to microservices with a step by step production roadmap and trade-offs.')
  await step($)
  expect(w.models).toEqual(['claude-opus-5-5'])
})

test('off mode never rewrites the model', async ($, on) => {
  const w = world(on, { store: { mode: 'off' } })
  await start($)
  await submit($, 'What is a closure?')
  await step($)
  expect(w.models).toEqual(['claude-opus-5-5'])
})

test('lock mode pins the model on every prompt', async ($, on) => {
  const w = world(on, { store: { mode: 'lock', lockModel: 'sonnet' } })
  await start($)
  await submit($, 'What is a closure?')
  await step($)
  expect(w.models).toEqual(['sonnet'])
})

test('/route off returns to the session model', async ($, on) => {
  const w = world(on, { store: { mode: 'auto' } })
  await start($)
  await submit($, 'What is a closure?')
  await route($, 'off')
  await step($)
  expect(w.models).toEqual(['claude-opus-5-5'])
})

test('slash commands are not routed', async ($, on) => {
  const w = world(on, { store: { mode: 'auto' } })
  await start($)
  await $.prompt.submit({ text: '/compact', wait: false, origin: { kind: 'composer' }, command: { name: 'compact' } } as never).catch(() => undefined)
  await step($)
  expect(w.models).toEqual(['claude-opus-5-5'])
})

test('logging writes JSON lines when switched on', async ($, on) => {
  const w = world(on, { store: { mode: 'auto' } })
  await start($)
  await route($, 'log on')
  await submit($, 'What is a closure?')
  const lines = (w.files.get(`${DIR}/routing.log`) ?? '').trim().split('\n').map(l => JSON.parse(l))
  const entry = lines.find(l => l.event === 'route')
  expect(entry).toMatchObject({
    mode: 'auto',
    recommended: { tier: 'haiku', effort: 'low' },
    chosen: { tier: 'haiku', effort: 'low' },
    decision: 'auto-switch',
    model: 'haiku',
    effort: 'low',
  })
  expect(entry.prompt).toBeUndefined()
})

test('a broken config file keeps defaults and never blocks the prompt', async ($, on) => {
  const w = world(on, { store: { mode: 'auto' } })
  w.files.set(`${DIR}/config.jsonc`, '{ this is not json')
  await start($)
  const r = await submit($, 'What is a closure?')
  expect(r).toMatchObject({ text: 'What is a closure?' })
  const status = await route($, 'status')
  expect(status.text).toContain('could not read')
})

test('unknown /route options answer with help', async ($, on) => {
  world(on)
  await start($)
  const r = await route($, 'turbo')
  expect(r.text).toContain('Unknown option')
  expect(r.text).toContain('/route lock <model>')
})

const RECOMMEND = { mode: 'recommend', storeVersion: 2 }

test('recommend mode asks on a recommended change and one click accepts model and effort', async ($, on) => {
  const w = world(on, { store: RECOMMEND, answer: 'Haiku · low (recommended)' })
  await start($)
  await submit($, 'What is a closure?')
  await step($, 'claude-opus-5-5', undefined, 't1', 'high')
  expect(w.asked).toHaveLength(1)
  expect(w.asked[0]).toContain('Recommended: Haiku · low')
  expect(w.asked[0]).toContain('Haiku · low (recommended) / Keep Opus · default (current) / Haiku · medium')
  expect(w.models).toEqual(['haiku'])
  expect(w.efforts).toEqual(['low'])
})

test('recommend mode lets you pick another model and effort', async ($, on) => {
  const w = world(on, { store: RECOMMEND, answer: 'sonnet high' })
  await start($)
  await submit($, 'What is a closure?')
  await step($, 'claude-opus-5-5', undefined, 't1', 'high')
  expect(w.models).toEqual(['sonnet'])
  expect(w.efforts).toEqual(['high'])
})

test('recommend mode: picking only a model uses the effort the router would pick for it', async ($, on) => {
  const w = world(on, { store: RECOMMEND, answer: 'Opus' })
  await start($)
  await submit($, 'What is a closure?')
  await step($, 'claude-opus-5-5', undefined, 't1', 'high')
  expect(w.models).toEqual(['claude-opus-5-5'])
  expect(w.efforts).toEqual(['medium'])
})

test('recommend mode keeps the current model and effort when the dialog is dismissed', async ($, on) => {
  const w = world(on, { store: RECOMMEND })
  await start($)
  const r = await submit($, 'What is a closure?')
  await step($, 'claude-opus-5-5', undefined, 't1', 'high')
  expect(r).toMatchObject({ text: 'What is a closure?' })
  expect(w.models).toEqual(['claude-opus-5-5'])
  expect(w.efforts).toEqual(['high'])
})

test('recommend mode does not ask when the current model already fits', async ($, on) => {
  const w = world(on, { store: RECOMMEND })
  await start($)
  await submit($, 'Design the architecture for migrating our monolith to microservices with a step by step production roadmap and trade-offs.')
  expect(w.asked).toHaveLength(0)
})

test('a 1.x saved "manual" mode is migrated to recommend', async ($, on) => {
  const w = world(on, { store: { mode: 'manual' }, answer: 'Haiku · low (recommended)' })
  await start($)
  expect(w.store.get('mode')).toBe('recommend')
  expect(w.store.get('storeVersion')).toBe(2)
  await submit($, 'What is a closure?')
  expect(w.asked).toHaveLength(1)
})

test('manual mode runs no analysis, asks nothing and leaves the session model alone', async ($, on) => {
  const w = world(on, { store: { mode: 'manual', storeVersion: 2 }, answer: 'Haiku · low (recommended)' })
  await start($)
  await turn($, 'What is a closure?')
  expect(w.asked).toHaveLength(0)
  expect(w.models).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
  expect(w.efforts).toEqual(['high', 'high'])
  expect(w.status.at(-1)).toBe('Router manual · Opus · high')
})

test('switching to manual drops an auto-routed model', async ($, on) => {
  const w = world(on, { store: { mode: 'auto', storeVersion: 2 } })
  await start($)
  await turn($, 'What is a closure?')
  expect(w.models.at(-1)).toBe('haiku')
  await route($, 'manual')
  await turn($, 'What is a closure?')
  expect(w.models.at(-1)).toBe('claude-opus-5-5')
})

test('a routed model that fails falls back to the session model and pauses routing', async ($, on) => {
  const w = world(on, { store: { mode: 'auto' }, failModel: 'haiku' })
  await start($)
  await submit($, 'What is a closure?')
  await step($)
  expect(w.models).toEqual(['haiku', 'claude-opus-5-5'])
  expect(w.status.at(-1)).toContain('Router paused')
  await submit($, 'What is a closure?')
  await step($)
  expect(w.models.at(-1)).toBe('claude-opus-5-5')
  await route($, 'auto')
  await submit($, 'What is a closure?')
  await step($).catch(() => undefined)
  expect(w.models.at(-2)).toBe('haiku')
})

// ---------------------------------------------------------------------------
// Per-prompt override

test('/route next applies to every request of the next prompt only, then the mode resumes', async ($, on) => {
  const w = world(on, { store: { mode: 'auto', storeVersion: 2 } })
  await start($)
  await route($, 'next opus xhigh')
  expect(w.status.at(-1)).toContain('next: Opus · xhigh')
  await turn($, 'What is a closure?')
  expect(w.models).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
  expect(w.efforts).toEqual(['xhigh', 'xhigh'])
  await turn($, 'What is a closure?')
  expect(w.models.slice(-2)).toEqual(['haiku', 'haiku'])
  expect(w.efforts.slice(-2)).toEqual(['low', 'low'])
})

test('/route next with effort alone keeps the model', async ($, on) => {
  const w = world(on, { store: { mode: 'manual', storeVersion: 2 } })
  await start($)
  await route($, 'next max')
  await turn($, 'Refactor the parser')
  expect(w.models).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
  expect(w.efforts).toEqual(['max', 'max'])
  await turn($, 'Refactor the parser')
  expect(w.efforts.slice(-2)).toEqual(['high', 'high'])
})

test('/route next skips the recommend dialog and works in off mode too', async ($, on) => {
  const w = world(on, { store: RECOMMEND, answer: 'Haiku · low (recommended)' })
  await start($)
  await route($, 'next sonnet medium')
  await turn($, 'What is a closure?')
  expect(w.asked).toHaveLength(0)
  expect(w.models.slice(0, 2)).toEqual(['sonnet', 'sonnet'])
  await route($, 'off')
  await route($, 'next haiku')
  await turn($, 'Explain the design')
  expect(w.models.slice(-2)).toEqual(['haiku', 'haiku'])
})

test('/route next clear cancels the override', async ($, on) => {
  const w = world(on, { store: { mode: 'off' } })
  await start($)
  await route($, 'next haiku low')
  await route($, 'next clear')
  await turn($, 'hello')
  expect(w.models).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
})

test('subagents are not affected by /route next', async ($, on) => {
  const w = world(on, { store: { mode: 'off' } })
  await start($)
  await route($, 'next haiku low')
  await submit($, 'hello')
  await $.turn.start({ text: 'hello', turnId: 'tx' } as never)
  await step($, 'claude-sonnet-5-5', 'agent-7', 'tx', 'medium')
  expect(w.models).toEqual(['claude-sonnet-5-5'])
  expect(w.efforts).toEqual(['medium'])
})

// ---------------------------------------------------------------------------
// Effort

test('auto mode picks model and effort together', async ($, on) => {
  const w = world(on, { store: { mode: 'auto', storeVersion: 2 }, baseModel: 'claude-sonnet-5-5' })
  await start($)
  await turn($, 'Implement a function that parses ISO dates in utils/date.ts and add unit tests for it', { base: 'claude-sonnet-5-5', baseEffort: 'medium' })
  expect(w.models.at(-1)).toBe('claude-sonnet-5-5')
  expect(w.efforts.at(-1)).toBe('high')
  expect(w.status.at(-1)).toContain('Router auto · Sonnet · high')
  expect(w.status.at(-1)).toContain('rec Sonnet · high')
})

test('/route effort lock pins the effort in every mode but off, and is remembered', async ($, on) => {
  const w = world(on, { store: { mode: 'auto', storeVersion: 2 } })
  await start($)
  await route($, 'effort lock xhigh')
  expect(w.store.get('effortMode')).toBe('lock')
  expect(w.store.get('effortLock')).toBe('xhigh')
  await turn($, 'What is a closure?')
  expect(w.models.at(-1)).toBe('haiku')
  expect(w.efforts.at(-1)).toBe('xhigh')
  await route($, 'manual')
  await turn($, 'What is a closure?')
  expect(w.efforts.at(-1)).toBe('xhigh')
  await route($, 'off')
  await turn($, 'What is a closure?')
  expect(w.efforts.at(-1)).toBe('high')
  await route($, 'effort auto')
  expect(w.store.get('effortMode')).toBe('auto')
})

test('lock mode keeps the model and still picks the effort, including medium for Opus', async ($, on) => {
  const w = world(on, { store: { mode: 'lock', lockModel: 'opus', storeVersion: 2 } })
  await start($)
  await turn($, 'What is a closure?')
  expect(w.models.at(-1)).toBe('claude-opus-5-5')
  expect(w.efforts.at(-1)).toBe('medium')
  expect(w.status.at(-1)).toContain('Router locked · Opus · medium')
})

// ---------------------------------------------------------------------------
// Escalation

test('auto: tests still failing at the end of a turn escalate the next prompt', async ($, on) => {
  const w = world(on, { store: { mode: 'auto', storeVersion: 2 }, baseModel: 'claude-sonnet-5-5', bash: { isError: true, stdout: 'Tests: 2 failed' } })
  await start($)
  const prompt = 'Implement a function that parses ISO dates in utils/date.ts and add unit tests for it'
  await turn($, prompt, { base: 'claude-sonnet-5-5', baseEffort: 'medium', bash: 'npm test' })
  expect(w.efforts.at(-1)).toBe('high')
  expect(w.status.at(-1)).toContain('escalating to Opus · high')
  await turn($, prompt, { base: 'claude-sonnet-5-5', baseEffort: 'medium' })
  expect(w.models.at(-1)).toBe('opus')
  expect(w.efforts.at(-1)).toBe('high')
})

test('auto: a passing test run does not escalate', async ($, on) => {
  const w = world(on, { store: { mode: 'auto', storeVersion: 2 }, bash: { isError: false, stdout: '12 passed, 0 failed' } })
  await start($)
  await turn($, 'Implement a function that parses ISO dates in utils/date.ts and add unit tests for it', { bash: 'npm test' })
  expect(w.status.at(-1)).not.toContain('escalating')
})

test('auto: an API error escalates; at the top of a model it moves up a model', async ($, on) => {
  const w = world(on, { store: { mode: 'auto', storeVersion: 2 } })
  await start($)
  await route($, 'next sonnet high')
  await turn($, 'Implement a function that parses ISO dates in utils/date.ts and add unit tests for it', { reason: 'error' })
  await turn($, 'Implement a function that parses ISO dates in utils/date.ts and add unit tests for it')
  expect(w.models.at(-1)).toBe('claude-opus-5-5')
  expect(w.efforts.at(-1)).toBe('high')
})

test('auto: saying the result was poor escalates that prompt', async ($, on) => {
  const w = world(on, { store: { mode: 'auto', storeVersion: 2 } })
  await start($)
  await turn($, 'What is a closure?')
  expect(w.efforts.at(-1)).toBe('low')
  await turn($, "That's wrong, try again")
  expect(w.models.at(-1)).toBe('haiku')
  expect(w.efforts.at(-1)).toBe('medium')
})

test('recommend: an escalation is offered in the dialog, not applied', async ($, on) => {
  const w = world(on, { store: RECOMMEND })
  await start($)
  await route($, 'next sonnet medium')
  await turn($, 'Implement a function that parses ISO dates', { bash: 'pytest', reason: 'answer' })
  await turn($, 'Implement a function that parses ISO dates', { reason: 'error' })
  await turn($, 'Implement a function that parses ISO dates')
  expect(w.asked.at(-1)).toContain('escalated: the last response ended in an API error')
  // Dismissed: nothing applied.
  expect(w.models.at(-1)).toBe('claude-opus-5-5')
})

test('manual: a failure is suggested in a toast with a ready command, never applied', async ($, on) => {
  const w = world(on, { store: { mode: 'manual', storeVersion: 2 }, bash: { isError: true, stdout: 'FAILED' } })
  await start($)
  await turn($, 'Fix the parser', { bash: 'pytest -q' })
  expect(w.toasts.at(-1)).toContain('/route next opus xhigh')
  await turn($, 'Fix the parser')
  expect(w.models.at(-1)).toBe('claude-opus-5-5')
  expect(w.efforts.at(-1)).toBe('high')
})

test('off: failures are ignored', async ($, on) => {
  const w = world(on, { store: { mode: 'off' }, bash: { isError: true, stdout: 'FAILED' } })
  await start($)
  await turn($, 'Fix the parser', { bash: 'pytest -q' })
  expect(w.toasts).toHaveLength(0)
})

// ---------------------------------------------------------------------------
// Cool-down

test('the first prompt of a new conversation is routed without stickiness', async ($, on) => {
  const w = world(on, { store: { mode: 'auto', storeVersion: 2 }, fresh: true })
  await start($)
  await turn($, 'Create a self contained webapp for reviewing all files in Download folder.', { baseEffort: 'xhigh' })
  expect(w.models.at(-1)).toBe('sonnet')
  expect(w.efforts.at(-1)).toBe('high')
})

test('after a routed switch the cool-down still holds a one-step change', async ($, on) => {
  const w = world(on, { store: { mode: 'auto', storeVersion: 2 }, baseModel: 'claude-sonnet-5-5' })
  await start($)
  const opusPrompt = 'Design the architecture for migrating our monolith to microservices with a step by step production roadmap and trade-offs.'
  await turn($, opusPrompt, { base: 'claude-sonnet-5-5', baseEffort: 'high' })
  expect(w.models.at(-1)).toBe('opus')
  await turn($, 'Create a self contained webapp for reviewing all files in Download folder.', { base: 'claude-sonnet-5-5', baseEffort: 'high' })
  // Context from the architecture prompt lifts this one to Opus · medium.
  expect(w.models.at(-1)).toBe('opus')
  expect(w.efforts.at(-1)).toBe('medium')
})

test('a resumed session starts without a cool-down but keeps the margin', async ($, on) => {
  const w = world(on, { store: { mode: 'auto', storeVersion: 2 }, baseModel: 'claude-opus-5-5' })
  await start($)
  // 58 is within the 8-point margin under Opus: an Opus conversation already under way stays.
  await turn($, 'Create a self contained webapp for reviewing all files in Download folder.', { baseEffort: 'xhigh' })
  expect(w.models.at(-1)).toBe('claude-opus-5-5')
  // A clearly smaller prompt moves down at once: no cool-down before the first switch.
  await turn($, 'Refactor the parser', { baseEffort: 'xhigh' })
  expect(w.models.at(-1)).toBe('sonnet')
})

test('after a routed switch the cool-down holds a one-step change', async ($, on) => {
  const w = world(on, { store: { mode: 'auto', storeVersion: 2 }, baseModel: 'claude-sonnet-5-5' })
  await start($)
  await turn($, 'Write a quick regex for emails', { base: 'claude-sonnet-5-5', baseEffort: 'high' })
  await turn($, 'What is a closure?', { base: 'claude-sonnet-5-5', baseEffort: 'high' })
  expect(w.models.at(-1)).toBe('haiku')
  await turn($, 'Implement a function that parses ISO dates in utils/date.ts and add unit tests for it', { base: 'claude-sonnet-5-5', baseEffort: 'high' })
  expect(w.models.at(-1)).toBe('haiku')
  expect(w.status.at(-1)).toContain('held')
})

test('the log ms counts routing work only, not the time a dialog was open', async ($, on) => {
  const w = world(on, { store: { mode: 'recommend', storeVersion: 2, logging: true }, answer: 'Haiku · low (recommended)', dialogMs: 5000 })
  await start($)
  await submit($, 'What is a closure?')
  const entry = (w.files.get(`${DIR}/routing.log`) ?? '').trim().split('\n').map(l => JSON.parse(l)).find(l => l.event === 'route')
  expect(w.asked).toHaveLength(1)
  expect(entry.decision).toBe('accepted')
  expect(entry.ms).toBe(0)
})

// ---------------------------------------------------------------------------
// Classifier and feedback

const ARCH = '{"complexity":"architecture","sentiment":"neutral","isFeedback":false}'
const FEEDBACK_NEG = '{"complexity":"simple","sentiment":"negative","isFeedback":true}'
const FEEDBACK_OK = '{"complexity":"simple","sentiment":"approve","isFeedback":true}'

test('feedback that reads as approval keeps the level of the task it refers to', async ($, on) => {
  const w = world(on, { store: { mode: 'auto', storeVersion: 2 } })
  await start($)
  w.verdict = ARCH
  await turn($, 'Design the architecture for migrating our monolith to services, with a roadmap')
  expect(w.models.at(-1)).toBe('claude-opus-5-5')
  const taskEffort = w.efforts.at(-1)
  w.verdict = FEEDBACK_OK
  await turn($, 'Thanks, that looks good')
  // The rules alone would rate "Thanks, that looks good" as small; the task's level stays.
  expect(w.models.at(-1)).toBe('claude-opus-5-5')
  expect(w.efforts.at(-1)).toBe(taskEffort)
  expect(w.status.at(-1)).toContain('feedback on the last task')
})

test('negative feedback raises the level of the task it refers to', async ($, on) => {
  const w = world(on, { store: { mode: 'auto', storeVersion: 2 } })
  await start($)
  w.verdict = ARCH
  await turn($, 'Design the architecture for migrating our monolith to services, with a roadmap')
  w.verdict = FEEDBACK_NEG
  await turn($, 'Still wrong, the migration plan ignores the database')
  expect(w.models.at(-1)).toBe('claude-opus-5-5')
  expect(w.status.at(-1)).toContain('last result was not right')
})

test('without an answer from the classifier the rules decide alone', async ($, on) => {
  const w = world(on, { store: { mode: 'auto', storeVersion: 2 } })
  await start($)
  await turn($, 'What is a closure?')
  expect(w.models.at(-1)).toBe('haiku')
  expect(w.status.at(-1)).not.toContain('classifier')
})

test('a classified new task is routed by the classifier floor', async ($, on) => {
  const w = world(on, { store: { mode: 'auto', storeVersion: 2 } })
  await start($)
  w.verdict = '{"complexity":"simple","sentiment":"neutral","isFeedback":false}'
  await turn($, 'Explain the design of this module in one line')
  expect(w.models.at(-1)).toBe('haiku')
})

test('the classifier runs in auto, recommend and lock, not in manual or off', async ($, on) => {
  const w = world(on, { store: { mode: 'manual', storeVersion: 2 } })
  await start($)
  w.verdict = ARCH
  await turn($, 'Design the architecture for migrating our monolith to services, with a roadmap')
  expect(w.models.at(-1)).toBe('claude-opus-5-5')
  expect(w.efforts.at(-1)).toBe('high')
  expect(w.status.at(-1)).toBe('Router manual · Opus · high')
})

test('a /route next prompt skips the classifier and keeps its own override', async ($, on) => {
  const w = world(on, { store: { mode: 'auto', storeVersion: 2 } })
  await start($)
  w.verdict = FEEDBACK_NEG
  await route($, 'next haiku low')
  await turn($, 'Still wrong')
  expect(w.models.at(-1)).toBe('haiku')
  expect(w.efforts.at(-1)).toBe('low')
})

test('a typical architecture request routes to Opus medium after a classifier verdict', async ($, on) => {
  const w = world(on, { store: { mode: 'auto', storeVersion: 2 }, fresh: true })
  await start($)
  w.verdict = ARCH
  await turn($, 'Design the architecture for migrating our monolith to services, with a roadmap')
  expect(w.models.at(-1)).toBe('claude-opus-5-5')
  expect(w.efforts.at(-1)).toBe('medium')
})

test('a model the person picks in the app wins over auto routing until /route resume', async ($, on) => {
  const w = world(on, { store: { mode: 'auto', storeVersion: 2 } })
  w.verdict = '{"complexity":"simple","sentiment":"neutral","isFeedback":false}'
  await start($)
  await turn($, 'What is a closure?')
  expect(w.models.at(-1)).toBe('haiku')
  // The person picks Sonnet in the app's menu.
  w.sessionModel = 'claude-sonnet-5-5'
  await turn($, 'What is a closure?', { base: 'claude-sonnet-5-5' })
  expect(w.models.at(-1)).toBe('claude-sonnet-5-5')
  expect(w.toasts.some(t => t.includes('you chose Sonnet'))).toBe(true)
  expect(w.status.at(-1)).toContain('/route resume')
  await turn($, 'What is a closure?', { base: 'claude-sonnet-5-5' })
  expect(w.models.at(-1)).toBe('claude-sonnet-5-5')
  await route($, 'resume')
  await turn($, 'What is a closure?', { base: 'claude-sonnet-5-5' })
  expect(w.models.at(-1)).toBe('haiku')
})

test('an effort the person picks mid-turn is kept, not overwritten', async ($, on) => {
  const w = world(on, { store: { mode: 'auto', storeVersion: 2 } })
  await start($)
  await turn($, 'What is a closure?', { baseEffort: 'high' })
  const routed = w.efforts.at(-1)
  expect(routed).not.toBe('xhigh')
  // The person sets xhigh in the app: the next request carries it as the session's own.
  await turn($, 'What is a closure?', { baseEffort: 'xhigh' })
  expect(w.efforts.at(-1)).toBe('xhigh')
  expect(w.toasts.some(t => t.includes('xhigh effort'))).toBe(true)
})

test('an alias and its full id are not mistaken for a pick', async ($, on) => {
  const w = world(on, { store: { mode: 'auto', storeVersion: 2 }, baseModel: 'opus' })
  await start($)
  await turn($, 'What is a closure?', { base: 'claude-opus-5-5' })
  expect(w.toasts.some(t => t.includes('you chose'))).toBe(false)
})

// ---------------------------------------------------------------------------
// Continuing a task keeps its level

const NEW_SIMPLE = '{"complexity":"simple","sentiment":"neutral","isFeedback":false}'
const BIG_TASK = 'Design the architecture for migrating our monolith to services, with a roadmap'

test('"Continue" after a stopped Opus turn stays on Opus medium (the classifier calls it a new simple task)', async ($, on) => {
  const w = world(on, { store: { mode: 'auto', storeVersion: 2 }, fresh: true })
  await start($)
  w.verdict = ARCH
  await turn($, BIG_TASK, { reason: 'aborted' })
  expect(w.models.at(-1)).toBe('claude-opus-5-5')
  w.verdict = NEW_SIMPLE
  await turn($, 'Continue')
  expect(w.models.at(-1)).toBe('claude-opus-5-5')
  expect(w.efforts.at(-1)).toBe('medium')
  expect(w.status.at(-1)).toContain('continues the last task')
})

test('the classifier is told when the last answer was stopped', async ($, on) => {
  const w = world(on, { store: { mode: 'auto', storeVersion: 2 }, fresh: true })
  await start($)
  w.verdict = ARCH
  await turn($, BIG_TASK, { reason: 'aborted' })
  w.verdict = NEW_SIMPLE
  await turn($, 'Continue')
  const prompts = (w as unknown as { classifierPrompts: string[] }).classifierPrompts
  expect(prompts.at(-1)).toContain('stopped by the person before it finished')
  expect(prompts[0]).not.toContain('stopped by the person')
})

test('"go on" after a finished turn also keeps the task level', async ($, on) => {
  const w = world(on, { store: { mode: 'auto', storeVersion: 2 }, fresh: true })
  await start($)
  w.verdict = ARCH
  await turn($, BIG_TASK)
  w.verdict = NEW_SIMPLE
  await turn($, 'go on')
  expect(w.models.at(-1)).toBe('claude-opus-5-5')
})

test('a short instruction right after a stopped turn continues it', async ($, on) => {
  const w = world(on, { store: { mode: 'auto', storeVersion: 2 }, fresh: true })
  await start($)
  w.verdict = ARCH
  await turn($, BIG_TASK, { reason: 'aborted' })
  w.verdict = NEW_SIMPLE
  await turn($, 'use AWS instead')
  expect(w.models.at(-1)).toBe('claude-opus-5-5')
})

test('a new short question after a finished task is still judged on its own', async ($, on) => {
  const w = world(on, { store: { mode: 'auto', storeVersion: 2 }, fresh: true })
  await start($)
  w.verdict = ARCH
  await turn($, BIG_TASK)
  w.verdict = NEW_SIMPLE
  await turn($, 'What is a closure?')
  expect(w.models.at(-1)).toBe('haiku')
})

test('"Continue" keeps the task level even when the classifier gives no answer', async ($, on) => {
  const w = world(on, { store: { mode: 'auto', storeVersion: 2 }, fresh: true })
  await start($)
  w.verdict = ARCH
  await turn($, BIG_TASK, { reason: 'aborted' })
  w.verdict = undefined
  await turn($, 'Continue')
  expect(w.models.at(-1)).toBe('claude-opus-5-5')
})
