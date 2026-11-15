// The risk rule for subagents and the cost-savings estimate: pure logic, then through the engine.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { decideAgentModel, parseAgentPick } from '../hooks/extras-core'
import { DEFAULT_CONFIG, mergeConfig, parseRouteCommand } from '../hooks/router-core'
import { addItem, emptyTotals, familyOf, insteadOfTokens, mergePrices, netSaved, priceOf, savedShare, tokenTotals, usd, DEFAULT_PRICES } from '../hooks/savings-core'

const cfg = DEFAULT_CONFIG

describe('risk rule', () => {
  test('a risk rating is read, as a fraction or a percentage, and is optional', () => {
    expect(parseAgentPick('{"tier":"haiku","confidence":0.9,"risk":0.85}')?.risk).toBe(0.85)
    expect(parseAgentPick('{"tier":"haiku","confidence":0.9,"risk":80}')?.risk).toBe(0.8)
    expect(parseAgentPick('{"tier":"haiku","confidence":0.9}')?.risk).toBe(null)
    expect(parseAgentPick('{"tier":"haiku","confidence":0.9,"risk":"high"}')?.risk).toBe(null)
  })

  test('a risky task goes to Opus whatever the tier, the confidence or the parent', () => {
    const d = decideAgentModel({ tier: 'haiku', confidence: 0.3, reason: '', risk: 0.9 }, 'claude-sonnet-5-5', cfg)
    expect(d.model).toBe('opus')
    expect(d.risky).toBe(true)
    expect(d.note).toContain('risky (90%)')
  })

  test('on an Opus parent a risky task keeps the parent exact model', () => {
    const d = decideAgentModel({ tier: 'haiku', confidence: 0.9, reason: '', risk: 0.8 }, 'claude-opus-5-5[1m]', cfg)
    expect(d.model).toBe(undefined)
    expect(d.tier).toBe('opus')
  })

  test('below the bar, or with the rule off, the normal pick stands', () => {
    expect(decideAgentModel({ tier: 'haiku', confidence: 0.9, reason: '', risk: 0.5 }, 'claude-opus-5-5', cfg).model).toBe('haiku')
    const off = mergeConfig({ subagents: { riskyToOpus: false } }).config
    expect(decideAgentModel({ tier: 'haiku', confidence: 0.9, reason: '', risk: 0.95 }, 'claude-opus-5-5', off).model).toBe('haiku')
  })
})

describe('pricing', () => {
  test('families, including ids, aliases and Mythos', () => {
    expect(familyOf('claude-opus-5-5[1m]')).toBe('opus')
    expect(familyOf('haiku')).toBe('haiku')
    expect(familyOf('claude-mythos-5-2')).toBe('fable')
    expect(familyOf('gpt-x')).toBe(undefined)
  })

  test('a million tokens of each kind at list price', () => {
    const p = DEFAULT_PRICES
    expect(priceOf({ input_tokens: 1_000_000 }, 'claude-opus-5-5', p)).toBe(4)
    expect(priceOf({ output_tokens: 1_000_000 }, 'claude-sonnet-5-5', p)).toBe(10)
    expect(priceOf({ cache_read_input_tokens: 1_000_000 }, 'claude-opus-5-5', p)).toBe(0.2)
    expect(priceOf({ input_tokens: 1 }, 'unknown-model', p)).toBe(null)
  })

  test('a switch that rebuilt the cache is priced as cache reads on the other side', () => {
    const t = insteadOfTokens({ input_tokens: 10, cache_creation_input_tokens: 500, cache_read_input_tokens: 100 }, true)
    expect(t).toEqual({ input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 600 })
    expect(insteadOfTokens({ cache_creation_input_tokens: 5 }, false)).toEqual({ cache_creation_input_tokens: 5 })
  })

  test('totals: savings less the router own calls; chosen spending is not taken off', () => {
    let t = emptyTotals(0)
    t = addItem(t, { at: 1, kind: 'main', ranOn: 'sonnet', insteadOf: 'opus', usd: 1, insteadOfUsd: 2, label: '' })
    t = addItem(t, { at: 2, kind: 'subagent', ranOn: 'opus', insteadOf: 'sonnet', usd: 0.5, insteadOfUsd: 0.25, label: '', risky: true })
    t = addItem(t, { at: 3, kind: 'overhead', what: 'classifier', usd: 0.05, label: '' })
    t = addItem(t, { at: 4, kind: 'overhead', what: 'handoff', usd: 0.4, label: '' })
    expect(t.main.moved).toBe(1)
    expect(t.riskExtra).toBe(0.25)
    expect(Math.abs(netSaved(t) - (1 - 0.25 - 0.05)) < 1e-9).toBe(true)
    expect(Math.abs((savedShare(t) ?? 0) - 0.7 / 2.25) < 1e-9).toBe(true)
  })

  test('money and price overrides', () => {
    expect(usd(0.4234)).toBe('$0.423')
    expect(usd(-0.05)).toBe('-$0.050')
    expect(usd(0.0031)).toBe('$0.0031')
    expect(usd(12.4)).toBe('$12.40')
    const warnings: string[] = []
    expect(mergePrices({ opus: { input: 3 } }, warnings).opus.input).toBe(3)
    mergePrices({ gpt: { input: 1 } }, warnings)
    expect(warnings.length).toBe(1)
    expect(parseRouteCommand('savings reset')).toEqual({ kind: 'savings', reset: true })
  })
})

// ---------------------------------------------------------------------------
// Through the engine.

const HOME = '/home/tester'
type World = { files: Map<string, string>; pick?: string }

function world(on: On, pick?: string) {
  const w: World = { files: new Map(), pick }
  mock.store(on)
  mock.env(on, { HOME })
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 5 }))
  on('session.id', () => ({ value: 's1' }))
  on('session.usage', () => ({ value: { context: { tokens: 1000, window: 1_000_000 }, rateLimits: [], startedAt: 0 } }) as never)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.exists', (_, e) => ({ value: w.files.has(e.path) }))
  on('fs.write', (_, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => ({ value: w.files.get(e.path) ?? '' }))
  on('fs.stat', (_, e) => ({ value: { kind: 'file', size: (w.files.get(e.path) ?? '').length, mtimeMs: 1, isLink: false } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('model.complete', () => ({ value: w.pick === undefined ? { isAnswered: false, reason: 'aborted', usage: null } : { isAnswered: true, text: w.pick, usage: { input_tokens: 400, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) as never)
  on('agent.spawn', (_, e) => ({ model: e.model ?? 'claude-opus-5-5', agentId: `a-${e.tool_use_id}` }))
  return { w, clock }
}

const start = ($: Engine) => $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
const command = ($: Engine, args: string) =>
  $.command.run({ command: 'route', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)
const spawn = ($: Engine, extra: Record<string, unknown> = {}) =>
  $.agent.spawn({ tool_use_id: 'tu1', prompt: 'List the files in src/', description: 'list files', subagentType: 'Explore', parentModel: 'claude-opus-5-5', background: false, fork: false, ...extra } as never)
const finish = ($: Engine, turnId: string, usage: Record<string, unknown>, agentId?: string) =>
  $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId, reason: 'answer', agentId, usage } as never)
const pane = { plugin: 'model-router', surface: 'desktop', component: 'Pane', requestId: 'model-router-savings', props: { title: 'Savings', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const

test('a risky subagent goes to Opus even under a Sonnet parent, and its extra cost is shown', async ($, on) => {
  const { w } = world(on, '{"tier":"haiku","confidence":0.95,"risk":0.9,"reason":"drops a production table"}')
  await start($)
  const r = await spawn($, { parentModel: 'claude-sonnet-5-5' })
  expect((r as { model: string }).model).toBe('opus')
  await finish($, 'st1', { input_tokens: 100_000, output_tokens: 10_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }, 'a-tu1')
  const ui = await $.ui.mount(pane as never)
  expect((await ui.find({ type: 'Text', text: /Risky tasks sent to Opus cost/ }))).toBeTruthy()
  await ui.unmount()
  expect(w.files.get(`${HOME}/.claude/model-router/cost-ledger.jsonl`) ?? '').toContain('"risky":true')
})

test('a subagent moved to Haiku shows its saving in the Savings pane and the ledger', async ($, on) => {
  const { w } = world(on, '{"tier":"haiku","confidence":0.95,"risk":0.1,"reason":"file listing"}')
  await start($)
  await spawn($)
  // 100k in, 10k out: Haiku $0.015 against Opus $0.60.
  await finish($, 'st1', { input_tokens: 100_000, output_tokens: 10_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-haiku-5-5' }, 'a-tu1')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane, surface } as never)
    expect((await ui.find({ type: 'Text', text: /^Subagents: 1 run/ }))?.text).toContain('saved $0.585')
    await ui.unmount()
  }
  const ledger = w.files.get(`${HOME}/.claude/model-router/cost-ledger.jsonl`) ?? ''
  expect(ledger).toContain('"kind":"subagent"')
  expect(ledger).not.toContain('List the files')
})

test('main-chat turns: a cheaper model saves; switching back charges the rebuilt cache', async ($, on) => {
  world(on)
  await start($)
  // Routed to Sonnet: 10k in, 1k out = $0.03 against Opus $0.06.
  await finish($, 't1', { input_tokens: 10_000, output_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-sonnet-5-5' })
  // Back on Opus a moment later: it rebuilds 50k of cache ($0.25) that Opus alone would have read ($0.01).
  await finish($, 't2', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 50_000, model: 'claude-opus-5-5' })
  const ui = await $.ui.mount(pane as never)
  expect((await ui.find({ type: 'Text', text: /switched back/ }))?.text).toContain('extra $0.240')
  expect((await ui.find({ type: 'Text', text: /Sonnet instead of Opus/ }))?.text).toContain('saved $0.030')
  await ui.unmount()
})

test('/route savings shows totals; reset starts the all-time count again', async ($, on) => {
  world(on)
  await start($)
  await finish($, 't1', { input_tokens: 10_000, output_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-sonnet-5-5' })
  expect(((await command($, 'savings')) as { text: string }).text).toContain('Saved $0.030 this session and $0.030 in all')
  expect(((await command($, 'savings reset')) as { text: string }).text).toContain('$0.030 this session and $0.00 in all')
})

const band = { plugin: 'model-router', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 4, bodyColumns: 100 } } as const

test('the cache band shows what routing saved this session, once a turn is priced', async ($, on) => {
  world(on)
  await start($)
  await finish($, 't1', { input_tokens: 10_000, output_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-sonnet-5-5' })
  const ui = await $.ui.mount(band as never)
  expect((await ui.find({ type: 'Text', text: /saved \$0\.030 this session/ }))).toBeTruthy()
  await ui.unmount()
})

test('tokenTotals adds the four counts of a turn, and is null without usage', () => {
  expect(tokenTotals(null)).toBeNull()
  expect(tokenTotals({ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 4000 })).toEqual({
    input: 10,
    output: 20,
    cacheRead: 300,
    cacheWrite: 4000,
    total: 4330,
  })
  expect(tokenTotals({ output_tokens: null })?.total).toBe(0)
})

test('the warning threshold is read from the config and defaults to 150,000 tokens', () => {
  expect(DEFAULT_CONFIG.handoff.warnAtTokens).toBe(150000)
  expect(mergeConfig({ handoff: { warnAtTokens: 0 } }).config.handoff.warnAtTokens).toBe(0)
  expect(mergeConfig({ handoff: { warnAtTokens: 'many' } }).warnings.length).toBe(1)
})
