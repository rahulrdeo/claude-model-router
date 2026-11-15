// Subagent router, handoff and cache clock: the pure logic, then through the engine.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  asksOneHourCache,
  buildTranscript,
  cacheTtlMs,
  decideAgentModel,
  formatCountdown,
  handoffMessages,
  isOtherModel,
  nativeHome,
  newChatLink,
  nextPingAt,
  shouldAutoWarm,
  openLinkCommands,
  parseAgentPick,
  redactSecrets,
  ttlEvidence,
} from '../hooks/extras-core'
import { DEFAULT_CONFIG, mergeConfig, parseRouteCommand } from '../hooks/router-core'
import { keepWarmCosts } from '../hooks/savings-core'

const cfg = DEFAULT_CONFIG

describe('subagent picks', () => {
  test('a JSON reply is read, with a percentage confidence too', () => {
    expect(parseAgentPick('{"tier":"haiku","confidence":0.92,"reason":"file lookup"}')).toEqual({ tier: 'haiku', confidence: 0.92, reason: 'file lookup', risk: null })
    expect(parseAgentPick('Sure: {"tier":"Sonnet","confidence":85}')?.confidence).toBe(0.85)
    expect(parseAgentPick('{"tier":"gpt","confidence":0.9}')).toBe(null)
    expect(parseAgentPick('no json')).toBe(null)
  })

  test('a lookup goes to Haiku, a defined job to Sonnet, a hard job stays on Opus', () => {
    expect(decideAgentModel({ tier: 'haiku', confidence: 0.9, reason: '', risk: null }, 'claude-opus-5-5', cfg).model).toBe('haiku')
    expect(decideAgentModel({ tier: 'sonnet', confidence: 0.8, reason: '', risk: null }, 'claude-opus-5-5', cfg).model).toBe('sonnet')
    const hard = decideAgentModel({ tier: 'opus', confidence: 0.9, reason: '', risk: null }, 'claude-opus-5-5', cfg)
    expect(hard.model).toBe(undefined)
    expect(hard.tier).toBe('opus')
  })

  test('low confidence or no answer keeps the parent model', () => {
    expect(decideAgentModel({ tier: 'haiku', confidence: 0.4, reason: '', risk: null }, 'claude-opus-5-5', cfg).model).toBe(undefined)
    expect(decideAgentModel(null, 'claude-opus-5-5', cfg).model).toBe(undefined)
  })

  test('a pick above the parent is capped unless upgrades are allowed', () => {
    expect(decideAgentModel({ tier: 'opus', confidence: 0.9, reason: '', risk: null }, 'claude-sonnet-5-5', cfg).model).toBe(undefined)
    const up = mergeConfig({ subagents: { allowUpgrade: true } }).config
    expect(decideAgentModel({ tier: 'opus', confidence: 0.9, reason: '', risk: null }, 'claude-sonnet-5-5', up).model).toBe('opus')
  })
})

describe('handoff transcript', () => {
  const msgs = Array.from({ length: 40 }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    text: `message ${i}`,
    toolUses: i % 2 === 1 ? [{ tool: 'Bash', input: { command: 'ls' }, text: 'x'.repeat(20000) }] : [],
  }))

  test('everything fits when short', () => {
    const t = buildTranscript(msgs.slice(0, 4), 1_000_000)
    expect(t.omitted).toBe(0)
    expect(t.text).toContain('message 0')
    expect(t.text).toContain('[tool call: Bash')
  })

  test('long tool output is trimmed before any message is left out', () => {
    const t = buildTranscript(msgs, 60_000)
    expect(t.text.length <= 60_000).toBe(true)
    expect(t.trimmed).toBe(true)
    expect(t.omitted).toBe(0)
    expect(t.text).toContain('message 39')
  })

  test('the first request and the latest messages always survive', () => {
    const t = buildTranscript(msgs, 2_000)
    expect(t.text).toContain('message 0')
    expect(t.text).toContain('message 39')
    expect(t.omitted > 0).toBe(true)
  })

  test('start new chat leaves the handoff and an acknowledgement', () => {
    const m = handoffMessages('## Goal\nShip it')
    expect(m.length).toBe(2)
    expect(m[0]?.text).toContain('## Goal')
  })
})

describe('cache clock', () => {
  test('the lifetime is detected or configured', () => {
    expect(cacheTtlMs(cfg, null)).toBe(5 * 60_000)
    expect(cacheTtlMs(cfg, '1h')).toBe(60 * 60_000)
    expect(cacheTtlMs(mergeConfig({ cacheClock: { ttlMinutes: 15 } }).config, '1h')).toBe(15 * 60_000)
    expect(asksOneHourCache('{"cache_control":{"type":"ephemeral","ttl":"1h"}}')).toBe(true)
    expect(asksOneHourCache('{"cache_control":{"type":"ephemeral"}}')).toBe(false)
  })

  test('countdown and ping timing', () => {
    expect(formatCountdown(245_000)).toBe('4:05')
    expect(formatCountdown(3_720_000)).toBe('1:02:00')
    expect(nextPingAt(100_000, 0, cfg)).toBe(70_000)
    expect(nextPingAt(100_000, cfg.cacheClock.maxPings, cfg)).toBe(null)
  })

  test('commands and config', () => {
    expect(parseRouteCommand('agents off')).toEqual({ kind: 'feature', feature: 'agents', enabled: false })
    expect(parseRouteCommand('clock')).toEqual({ kind: 'feature', feature: 'clock' })
    expect(mergeConfig({ handoff: { autoAtTokens: 'lots' } }).warnings.length).toBe(1)
  })
})

describe('fixes', () => {
  test('a Git Bash or Cygwin home becomes a Windows path; other systems are left alone', () => {
    expect(nativeHome('/c/Users/ana', true)).toBe('C:\\Users\\ana')
    expect(nativeHome('/cygdrive/d/home/ana/', true)).toBe('D:\\home\\ana')
    expect(nativeHome('C:/Users/ana', true)).toBe('C:\\Users\\ana')
    expect(nativeHome('/Users/ana', false)).toBe('/Users/ana')
  })

  test('the log size limit stays within what the engine can read back', () => {
    expect(mergeConfig({ logging: { maxBytes: 50_000_000 } }).config.logging.maxBytes).toBe(DEFAULT_CONFIG.logging.maxBytes)
    expect(mergeConfig({ logging: { maxBytes: 3_000_000 } }).config.logging.maxBytes).toBe(3_000_000)
  })

  test('an alias and its id are one model; another tier is a pick', () => {
    expect(isOtherModel('claude-opus-5-5', 'opus', cfg)).toBe(false)
    expect(isOtherModel('claude-opus-5-5[1m]', 'claude-opus-5-5', cfg)).toBe(false)
    expect(isOtherModel('claude-sonnet-5-5', 'claude-opus-5-5', cfg)).toBe(true)
  })

  test('the cache lifetime is proven by a cache hit after a long pause', () => {
    expect(ttlEvidence(10 * 60_000, { cache_read_input_tokens: 90_000, cache_creation_input_tokens: 300 })).toBe('1h')
    expect(ttlEvidence(10 * 60_000, { cache_read_input_tokens: 0, cache_creation_input_tokens: 90_000 })).toBe('5m')
    expect(ttlEvidence(2 * 60_000, { cache_read_input_tokens: 90_000, cache_creation_input_tokens: 0 })).toBe(null)
    expect(ttlEvidence(2 * 60 * 60_000, { cache_read_input_tokens: 0, cache_creation_input_tokens: 90_000 })).toBe(null)
  })
})

describe('handoff extras', () => {
  test('known secret formats are blanked, ordinary text is not', () => {
    const r = redactSecrets([
      'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123',
      'aws AKIAIOSFODNN7EXAMPLE',
      'db postgres://app:hunter22secret@db.local/main',
      'DB_PASSWORD="correct-horse-battery"',
      'Authorization: Bearer abcdefghijklmnop0123456789',
      'the password field must be validated',
    ].join('\n'))
    expect(r.count).toBe(5)
    expect(r.text).not.toContain('abcdefghijklmnopqrstuvwxyz0123')
    expect(r.text).not.toContain('hunter22secret')
    expect(r.text).not.toContain('correct-horse-battery')
    expect(r.text).toContain('postgres://app:[redacted URL password]@db.local')
    expect(r.text).toContain('the password field must be validated')
  })

  test('a new-chat link carries the whole handoff, or a pointer when too long', () => {
    const short = newChatLink('## Goal\nShip it', { cwd: 'C:\\work', maxLength: 8000 })
    expect(short.isWhole).toBe(true)
    expect(short.url.startsWith('claude://code/new?q=')).toBe(true)
    expect(decodeURIComponent(short.url)).toContain('## Goal')
    const long = newChatLink('x'.repeat(20_000), { file: 'C:\\h.md', maxLength: 8000 })
    expect(long.isWhole).toBe(false)
    expect(long.url.length <= 8000).toBe(true)
    expect(decodeURIComponent(long.url)).toContain('C:\\h.md')
  })

  test('links open through the system on each platform', () => {
    expect(openLinkCommands('claude://x', true)[0]?.[0]).toBe('rundll32.exe')
    expect(openLinkCommands('claude://x', false)[0]).toEqual(['open', 'claude://x'])
  })
})

// ---------------------------------------------------------------------------
// Through the engine.

const HOME = '/home/tester'
type World = { files: Map<string, string>; toasts: string[]; completes: { model: string; system?: string; prompt?: string }[]; forks: number; opened: string[]; compacted: { instructions?: string }[]; appended: string[]; runs: string[][]; stepUsage?: Record<string, number> }

function world(on: On, o: { model?: string; pick?: string; handoff?: string; tokens?: number; fork?: { cached: number }; env?: Record<string, string>; messages?: unknown[]; config?: string; runExit?: number } = {}) {
  const w: World = { files: new Map(), toasts: [], completes: [], forks: 0, opened: [], compacted: [], appended: [], runs: [] }
  if (o.config) w.files.set(`${HOME}/.claude/model-router/config.jsonc`, o.config)
  mock.store(on)
  mock.env(on, o.env ?? { HOME })
  on('process.run', (_, e) => {
    w.runs.push([...e.argv])
    return { value: { exitCode: o.runExit ?? 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('ui.copy', () => ({ value: { isCopied: true } }) as never)
  on('turn.step', async function* (_, e) {
    const result = { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: w.stepUsage ? { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...w.stepUsage, model: e.model } : null } as never
    if (e.index < 0) yield undefined as never
    return result
  })
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  on('session.model', () => ({ value: o.model ?? 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 5 }))
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: HOME }))
  on('session.messages', () => ({ value: o.messages ?? [{ role: 'user', text: 'build the thing', toolUses: [] }, { role: 'assistant', text: 'done part one', toolUses: [] }] }) as never)
  on('session.usage', () => ({ value: { context: { tokens: o.tokens ?? 1000, window: 1_000_000 }, rateLimits: [], startedAt: 0 } }) as never)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', (_, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.toast', (_, e) => {
    w.toasts.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: w.files.has(e.path) }))
  on('fs.write', (_, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => ({ value: w.files.get(e.path) ?? '' }))
  on('fs.stat', (_, e) => ({ value: { kind: 'file', size: (w.files.get(e.path) ?? '').length, mtimeMs: 1, isLink: false } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('model.complete', (_, e) => {
    w.completes.push({ model: e.model, system: typeof e.system === 'string' ? e.system : undefined, prompt: typeof e.prompt === 'string' ? e.prompt : undefined })
    const isHandoff = typeof e.system === 'string' && e.system.includes('handoff')
    const text = isHandoff ? o.handoff : o.pick
    return { value: text === undefined ? { isAnswered: false, reason: 'aborted', usage: null } : { isAnswered: true, text, usage: null } } as never
  })
  on('model.fork', () => {
    w.forks += 1
    return { value: { isAnswered: true, text: 'OK', usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: o.fork?.cached ?? 120000, cache_creation_input_tokens: 0 } } } as never
  })
  on('session.append', async (_, e, next) => {
    w.appended.push(JSON.stringify(e))
    return next(e)
  })
  on('session.compact', (_, e) => {
    w.compacted.push(e)
    return { messages: [{ role: 'user', text: 'engine summary', toolUses: [] }] } as never
  })
  on('agent.spawn', (_, e) => ({ model: e.model ?? 'inherit', agentId: `a-${e.tool_use_id}` }))
  return { w, clock }
}

const start = ($: Engine) => $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
const spawn = ($: Engine, extra: Record<string, unknown> = {}) =>
  $.agent.spawn({
    tool_use_id: 'tu1',
    prompt: 'Find every file that imports the auth module and list them.',
    description: 'find auth imports',
    subagentType: 'Explore',
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
    ...extra,
  } as never)
const command = ($: Engine, name: string, args = '') =>
  $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)
const endTurn = async ($: Engine, turnId = 't1') => {
  await $.turn.start({ text: 'hi', turnId } as never)
  for await (const _ of $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1, effort: 'high' } as never)) {
    // drain
  }
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId, reason: 'answer' } as never)
}
const band = { plugin: 'model-router', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 4, bodyColumns: 100 } } as const
const handoffPane = { plugin: 'model-router', surface: 'desktop', component: 'Pane', requestId: 'model-router-handoff', props: { title: 'Handoff', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } } as const

test('a simple lookup subagent runs on Haiku and shows in the pane with its confidence', async ($, on) => {
  const { w } = world(on, { pick: '{"tier":"haiku","confidence":0.91,"reason":"plain file search"}' })
  await start($)
  const r = await spawn($)
  expect((r as { model: string }).model).toBe('haiku')
  expect(w.completes[0]?.model).toBe('haiku')
  expect(w.opened).toContain('model-router-agents')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'model-router', surface, component: 'Pane', requestId: 'model-router-agents', props: { title: 'Subagent models', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } } as never)
    expect((await ui.find({ type: 'Text', text: /Explore/ }))?.text).toContain('91%')
    await ui.unmount()
  }
})

test('a hard job stays on the parent Opus; an unsure pick keeps the parent', async ($, on) => {
  const { w } = world(on, { pick: '{"tier":"opus","confidence":0.88,"reason":"subtle bug"}' })
  await start($)
  expect((await spawn($) as { model: string }).model).toBe('inherit')
  expect(w.completes.length).toBe(1)
})

test('a model the caller named, a fork and off mode are left alone', async ($, on) => {
  const { w } = world(on, { pick: '{"tier":"haiku","confidence":0.95}' })
  await start($)
  expect((await spawn($, { model: 'sonnet' }) as { model: string }).model).toBe('sonnet')
  expect((await spawn($, { fork: true, tool_use_id: 'tu2' }) as { model: string }).model).toBe('inherit')
  await command($, 'route', 'off')
  expect((await spawn($, { tool_use_id: 'tu3' }) as { model: string }).model).toBe('inherit')
  expect(w.completes.length).toBe(0)
})

test('/route agents off stops the subagent router', async ($, on) => {
  const { w } = world(on, { pick: '{"tier":"haiku","confidence":0.95}' })
  await start($)
  await command($, 'route', 'agents off')
  expect((await spawn($) as { model: string }).model).toBe('inherit')
  expect(w.completes.length).toBe(0)
})

test('/handoff writes a handoff on Sonnet; Start new chat replaces the conversation with it', async ($, on) => {
  const { w, clock } = world(on, { handoff: '## Goal\nFinish the thing' })
  await start($)
  await command($, 'handoff')
  await clock.settle()
  expect(w.completes.some(c => c.model === 'sonnet')).toBe(true)
  expect([...w.files.keys()].some(k => k.includes('/.claude/model-router/handoffs/'))).toBe(true)
  const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'Pane', requestId: 'model-router-handoff', props: { title: 'Handoff', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } } as never)
  expect((await ui.find({ type: 'Text', text: /Finish the thing/ }))?.text).toContain('## Goal')
  await ui.press({ key: 'fresh' } as never)
  await ui.unmount()
  expect(w.toasts.some(t => t.startsWith('Started fresh'))).toBe(true)
  // Compacted to a one-line note, then the handoff added as the next message the model reads.
  expect(w.compacted[0]?.instructions).toContain('handoff')
  expect(w.appended.some(a => a.includes('Finish the thing'))).toBe(true)
})

test('a handoff is written automatically once the chat passes 250k tokens, once', async ($, on) => {
  const { w, clock } = world(on, { handoff: 'handoff text', tokens: 260_000 })
  await start($)
  await endTurn($, 't1')
  await clock.settle()
  await endTurn($, 't2')
  await clock.settle()
  expect(w.completes.filter(c => c.model === 'sonnet').length).toBe(1)
  expect(w.toasts.some(t => t.includes('handoff is ready'))).toBe(true)
})

test('the cache clock counts down after a reply, and Keep warm pings before it runs out', async ($, on) => {
  const { w, clock } = world(on, { tokens: 120_000 })
  await start($)
  await endTurn($)
  let ui = await $.ui.mount(band as never)
  expect((await ui.find({ type: 'Text', text: /Cache warm 5:00/ }))).toBeTruthy()
  await ui.press({ key: 'keep-warm' } as never)
  await ui.unmount()
  // 4:30 in, the ping is due (30 s before the 5 min run out).
  await clock.advance(270_000)
  expect(w.forks).toBe(1)
  ui = await $.ui.mount(band as never)
  expect((await ui.find({ type: 'Text', text: /Cache warm 5:00/ }))).toBeTruthy()
  await ui.unmount()
})

test('without Keep warm the band says the cache went cold', async ($, on) => {
  const { w, clock } = world(on, { tokens: 120_000 })
  await start($)
  await endTurn($)
  await clock.advance(301_000)
  const ui = await $.ui.mount({ plugin: 'model-router', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 4, bodyColumns: 100 } } as never)
  expect((await ui.find({ type: 'Text', text: /Cache cold/ }))).toBeTruthy()
  expect(w.forks).toBe(0)
  await ui.unmount()
})

test('on Windows the config goes under the profile folder, not a Git Bash HOME', async ($, on) => {
  const { w } = world(on, { env: { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\tester', HOME: '/c/Users/tester' } })
  await start($)
  // The kit runs on Linux and files a Windows path under its working folder; what counts is
  // the path the mod asked for.
  const written = [...w.files.keys()]
  expect(written.length).toBe(1)
  expect(written[0]?.endsWith('C:\\Users\\tester\\.claude\\model-router\\config.jsonc')).toBe(true)
  expect(written[0]?.includes('/c/Users')).toBe(false)
})

test('secrets in the chat never reach the handoff helper or the handoff', async ($, on) => {
  const { w, clock } = world(on, {
    handoff: 'Use key sk-ant-api03-zzzzzzzzzzzzzzzzzzzzzzzz to deploy',
    messages: [{ role: 'user', text: 'deploy with sk-ant-api03-abcdefghijklmnopqrstuvwxyz', toolUses: [] }],
  })
  await start($)
  await command($, 'handoff')
  await clock.settle()
  const sent = w.completes.find(c => c.model === 'sonnet')?.prompt ?? ''
  expect(sent).not.toContain('abcdefghijklmnopqrstuvwxyz')
  expect(sent).toContain('[redacted Anthropic key]')
  const saved = [...w.files.entries()].find(([k]) => k.includes('/handoffs/'))?.[1] ?? ''
  expect(saved).not.toContain('zzzzzzzzzzzz')
  const ui = await $.ui.mount(handoffPane as never)
  expect((await ui.find({ type: 'Text', text: /secrets blanked out/ }))).toBeTruthy()
  await ui.unmount()
})

test('Start new chat opens the desktop app with the handoff typed in', async ($, on) => {
  const { w, clock } = world(on, { handoff: '## Goal\nFinish the thing' })
  await start($)
  await command($, 'handoff')
  await clock.settle()
  const r = await command($, 'handoff', 'new')
  expect((r as { text: string }).text).toContain('A new chat opened')
  const url = w.runs.at(-1)?.at(-1) ?? ''
  expect(url.startsWith('claude://code/new?q=')).toBe(true)
  expect(decodeURIComponent(url)).toContain('Finish the thing')
})

test('on Windows the new chat opens through rundll32 with a short link', async ($, on) => {
  const { w, clock } = world(on, { handoff: 'y'.repeat(30_000), env: { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\tester' } })
  await start($)
  await command($, 'handoff')
  await clock.settle()
  const r = await command($, 'handoff', 'new')
  const run = w.runs.at(-1) ?? []
  expect(run[0]).toBe('rundll32.exe')
  expect((run.at(-1) ?? '').length <= 8000).toBe(true)
  expect((r as { text: string }).text).toContain('Handoff copied')
})

test('without the desktop app the handoff is copied instead', async ($, on) => {
  const { w, clock } = world(on, { handoff: 'h', runExit: 1 })
  await start($)
  await command($, 'handoff')
  await clock.settle()
  const r = await command($, 'handoff', 'new')
  expect((r as { text: string }).text).toContain('Could not open a new chat')
  expect((r as { text: string }).text).toContain('Handoff copied')
  expect(w.runs.length).toBe(2)
})

test('keep warm stops at its time limit', async ($, on) => {
  const { w, clock } = world(on, { tokens: 120_000, config: '{ "cacheClock": { "maxMinutes": 2 } }' })
  await start($)
  await endTurn($)
  let ui = await $.ui.mount(band as never)
  await ui.press({ key: 'keep-warm' } as never)
  await ui.unmount()
  await clock.advance(270_000)
  expect(w.forks).toBe(0)
  ui = await $.ui.mount(band as never)
  expect((await ui.find({ type: 'Text', text: /maxMinutes/ }))).toBeTruthy()
  await ui.unmount()
})

test('a cache hit after a 10-minute pause proves a one-hour cache, and it is remembered', async ($, on) => {
  const { w, clock } = world(on, { tokens: 120_000 })
  await start($)
  await endTurn($, 't1')
  await clock.advance(10 * 60_000)
  w.stepUsage = { cache_read_input_tokens: 100_000, cache_creation_input_tokens: 500 }
  await endTurn($, 't2')
  const ui = await $.ui.mount(band as never)
  expect((await ui.find({ type: 'Text', text: /Cache warm 1:00:00/ }))).toBeTruthy()
  await ui.unmount()
})

test('a big chat that went cold offers a handoff', async ($, on) => {
  const { clock } = world(on, { tokens: 200_000 })
  await start($)
  await endTurn($)
  await clock.advance(301_000)
  const ui = await $.ui.mount(band as never)
  expect((await ui.find({ type: 'Text', text: /may cost less/ }))).toBeTruthy()
  await ui.unmount()
})

// ---------------------------------------------------------------------------
// Keep warm follows the session the person is typing in.

const WARM = `${HOME}/.claude/model-router/keepwarm.json`
const ACTIVE = `${HOME}/.claude/model-router/active.json`
const type = ($: Engine) => $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } } as never)
const pressKeepWarm = async ($: Engine) => {
  const ui = await $.ui.mount(band as never)
  await ui.press({ key: 'keep-warm' } as never)
  await ui.unmount()
}
const bandText = async ($: Engine, re: RegExp) => {
  const ui = await $.ui.mount(band as never)
  const found = await ui.find({ type: 'Text', text: re })
  await ui.unmount()
  return found
}

test('parse: /route warm', () => {
  expect(parseRouteCommand('warm')).toEqual({ kind: 'warm' })
  expect(parseRouteCommand('warm on')).toEqual({ kind: 'warm', enabled: true })
  expect(parseRouteCommand('keepwarm off')).toEqual({ kind: 'warm', enabled: false })
  expect(parseRouteCommand('warm maybe').kind).toBe('error')
})

test('Keep warm is one setting: after pressing it once, the next reply starts it without pressing again', async ($, on) => {
  const { w, clock } = world(on, { tokens: 120_000 })
  await start($)
  await endTurn($, 't1')
  await pressKeepWarm($)
  expect(w.files.get(WARM)).toContain('"on":true')
  await endTurn($, 't2')
  await clock.advance(270_000)
  expect(w.forks).toBe(1)
})

test('a new session starts Keep warm by itself after its first reply when the setting is on', async ($, on) => {
  const { w, clock } = world(on, { tokens: 120_000 })
  w.files.set(WARM, '{"on":true}')
  await start($)
  await type($)
  await endTurn($)
  await clock.advance(270_000)
  expect(w.forks).toBe(1)
})

test('typing records that this session is the one in use', async ($, on) => {
  const { w } = world(on)
  await start($)
  await type($)
  expect(JSON.parse(w.files.get(ACTIVE) ?? '{}')).toMatchObject({ session: 's1' })
})

test('a session you have left stops before pinging: no ping is sent to an idle chat', async ($, on) => {
  const { w, clock } = world(on, { tokens: 120_000 })
  await start($)
  await type($)
  await endTurn($)
  await pressKeepWarm($)
  // Later the person types in another session.
  w.files.set(ACTIVE, JSON.stringify({ session: 's2', at: clock.now() + 60_000 }))
  await clock.advance(270_000)
  expect(w.forks).toBe(0)
  expect(await bandText($, /moved to another session/)).toBeTruthy()
})

test('older activity in another session does not stop the session you are typing in', async ($, on) => {
  const { w, clock } = world(on, { tokens: 120_000 })
  w.files.set(ACTIVE, JSON.stringify({ session: 's2', at: clock.now() - 60_000 }))
  await start($)
  await type($)
  await endTurn($)
  await pressKeepWarm($)
  await clock.advance(270_000)
  expect(w.forks).toBe(1)
})

test('Keep warm does not start after a reply in a session you have already left', async ($, on) => {
  const { w, clock } = world(on, { tokens: 120_000 })
  w.files.set(WARM, '{"on":true}')
  await start($)
  await type($)
  w.files.set(ACTIVE, JSON.stringify({ session: 's2', at: clock.now() + 1_000 }))
  await endTurn($)
  await clock.advance(270_000)
  expect(w.forks).toBe(0)
  expect(await bandText($, /costs full price/)).toBeTruthy()
})

test('switching Keep warm off stops it in every session', async ($, on) => {
  const { w, clock } = world(on, { tokens: 120_000 })
  w.files.set(WARM, '{"on":true}')
  await start($)
  await type($)
  await endTurn($)
  w.files.set(WARM, '{"on":false}')
  await clock.advance(270_000)
  expect(w.forks).toBe(0)
  expect(await bandText($, /switched off/)).toBeTruthy()
})

test('/route warm on and off', async ($, on) => {
  const { w, clock } = world(on, { tokens: 120_000 })
  await start($)
  await endTurn($)
  const onText = ((await command($, 'route', 'warm on')) as { text: string }).text
  expect(onText).toContain('Keep warm on')
  expect(onText).toContain('follows you')
  expect(w.files.get(WARM)).toContain('"on":true')
  // The cache was warm, so it starts at once.
  await clock.advance(270_000)
  expect(w.forks).toBe(1)
  const offText = ((await command($, 'route', 'warm off')) as { text: string }).text
  expect(offText).toContain('Keep warm off')
  expect(w.files.get(WARM)).toContain('"on":false')
  await clock.advance(270_000)
  expect(w.forks).toBe(1)
  expect(((await command($, 'route', 'status')) as { text: string }).text).toContain('Keep warm:   off')
})

// ---------------------------------------------------------------------------
// Keep warm budget and costs

test('keep-warm costs: a ping reads the cached chat, going cold writes it all again', () => {
  const c = keepWarmCosts(200_000, 'claude-opus-5-5', cfg.savings.prices)
  expect(c.ping).toBeGreaterThan(0)
  expect(c.cold).toBeGreaterThan(c.ping ?? 0)
  expect(keepWarmCosts(undefined, 'claude-opus-5-5', cfg.savings.prices)).toEqual({ ping: null, cold: null })
  expect(keepWarmCosts(200_000, 'mystery-model', cfg.savings.prices)).toEqual({ ping: null, cold: null })
})

test('Keep warm starts by itself only for chats of at least autoStartMinTokens', () => {
  expect(cfg.cacheClock.autoStartMinTokens).toBe(50_000)
  expect(shouldAutoWarm(49_999, cfg)).toBe(false)
  expect(shouldAutoWarm(50_000, cfg)).toBe(true)
  expect(shouldAutoWarm(undefined, cfg)).toBe(false)
})

test('a small chat does not start Keep warm by itself, and says why', async ($, on) => {
  const { w, clock } = world(on, { tokens: 10_000 })
  w.files.set(WARM, '{"on":true}')
  await start($)
  await type($)
  await endTurn($)
  await clock.advance(270_000)
  expect(w.forks).toBe(0)
  expect(await bandText($, /not started: chat under 50k tokens/)).toBeTruthy()
})

test('Keep warm sends at most 2 pings per pause by default', async ($, on) => {
  const { w, clock } = world(on, { tokens: 120_000 })
  w.files.set(WARM, '{"on":true}')
  await start($)
  await type($)
  await endTurn($)
  await clock.advance(270_000)
  expect(w.forks).toBe(1)
  await clock.advance(300_000)
  expect(w.forks).toBe(2)
  await clock.advance(600_000)
  expect(w.forks).toBe(2)
})

test('the band warns while the cache is warm once the chat is big, and names /handoff', async ($, on) => {
  world(on, { tokens: 160_000 })
  await start($)
  await endTurn($)
  expect(await bandText($, /every turn re-reads all of it: \/handoff/)).toBeTruthy()
})

test('no warning below handoff.warnAtTokens', async ($, on) => {
  world(on, { tokens: 100_000 })
  await start($)
  await endTurn($)
  expect(await bandText($, /re-reads all of it/)).toBeFalsy()
})

test('the turn log holds the token totals of each turn', async ($, on) => {
  const { w } = world(on)
  await start($)
  await command($, 'route', 'log on')
  await $.turn.start({ text: 'hi', turnId: 'tl' } as never)
  for await (const _ of $.turn.step({ turnId: 'tl', index: 0, model: 'claude-opus-5-5', messageCount: 1, effort: 'high' } as never)) {
    // drain
  }
  const usage = { input_tokens: 5, output_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'tl', reason: 'answer', usage } as never)
  const turn = (w.files.get(`${HOME}/.claude/model-router/routing.log`) ?? '').trim().split('\n').map(l => JSON.parse(l)).find(l => l.event === 'turn')
  expect(turn).toBeTruthy()
  expect(turn.totals).toEqual({ input: 5, output: 100, cacheRead: 2000, cacheWrite: 0, total: 2105 })
})

test('the band shows what a ping and going cold cost', async ($, on) => {
  const { w } = world(on, { tokens: 120_000 })
  await start($)
  await endTurn($)
  const idle = await bandText($, /a ping ~\$/)
  expect(idle?.text).toContain('going cold ~$')
  await pressKeepWarm($)
  expect(await bandText($, /keeping warm, ping 0\/2 at ~\$/)).toBeTruthy()
  expect(w.forks).toBe(0)
})

test('a ping with no known price is still recorded in the cost ledger', async ($, on) => {
  const { w, clock } = world(on, { tokens: 120_000, model: 'mystery-model' })
  w.files.set(WARM, '{"on":true}')
  await start($)
  // Routing off: the turn, and so the ping, run on the session's own (unpriced) model.
  await command($, 'route', 'off')
  await type($)
  await $.turn.start({ text: 'hi', turnId: 'tm' } as never)
  for await (const _ of $.turn.step({ turnId: 'tm', index: 0, model: 'mystery-model', messageCount: 1 } as never)) {
    // drain
  }
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'tm', reason: 'answer' } as never)
  await clock.advance(270_000)
  expect(w.forks).toBe(1)
  const ledger = [...w.files.entries()].find(([k]) => k.endsWith('cost-ledger.jsonl'))?.[1] ?? ''
  expect(ledger).toContain('"what":"keepWarm"')
  expect(ledger).toContain('no price for')
})
