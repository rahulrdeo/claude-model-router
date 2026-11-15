import { describe, expect, test } from 'claude-code/testing'

import { CONFIG_TEMPLATE } from '../hooks/config-template'
import { joinPath } from '../hooks/register'
import {
  analyse,
  bandEffort,
  decide,
  decideEffort,
  escalate,
  isNegativeFeedback,
  isTestCommand,
  parseCombo,
  applyVerdict,
  parseVerdict,
  recommendEffort,
  runFailed,
  DEFAULT_CONFIG,
  mergeConfig,
  parseJsonc,
  parseRouteCommand,
  statusLine,
  stripJsonc,
  tierForScore,
  tierOf,
} from '../hooks/router-core'
import { isContinuation } from '../hooks/router-core'

const cfg = DEFAULT_CONFIG

describe('config', () => {
  test('the shipped template parses to exactly the defaults', () => {
    const { config, warnings } = mergeConfig(parseJsonc(CONFIG_TEMPLATE))
    expect(warnings).toEqual([])
    expect(config).toStrictEqual(DEFAULT_CONFIG)
  })

  test('comments, trailing commas, BOM and CRLF are accepted', () => {
    const text = '\uFEFF{\r\n  // a comment\r\n  "defaultMode": "auto", /* block */\r\n  "models": { "opus": "claude-opus-x", },\r\n}\r\n'
    const { config, warnings } = mergeConfig(parseJsonc(text))
    expect(warnings).toEqual([])
    expect(config.defaultMode).toBe('auto')
    expect(config.models.opus).toBe('claude-opus-x')
    expect(config.models.haiku).toBe('haiku')
  })

  test('comment markers inside strings are kept', () => {
    expect(stripJsonc('{"url": "https://x.dev/a"}')).toBe('{"url": "https://x.dev/a"}')
  })

  test('invalid fields fall back to defaults with a warning', () => {
    const { config, warnings } = mergeConfig({
      defaultMode: 'turbo',
      thresholds: { haikuMax: 80, opusMin: 40 },
      context: { weight: 3 },
      logging: { enabled: 'yes' },
    })
    expect(config.defaultMode).toBe(DEFAULT_CONFIG.defaultMode)
    expect(config.thresholds.haikuMax).toBe(DEFAULT_CONFIG.thresholds.haikuMax)
    expect(config.thresholds.opusMin).toBe(DEFAULT_CONFIG.thresholds.opusMin)
    expect(config.context.weight).toBe(DEFAULT_CONFIG.context.weight)
    expect(config.logging.enabled).toBe(false)
    expect(warnings.length).toBe(4)
  })

  test('a non-object config is refused whole', () => {
    expect(mergeConfig([1, 2]).warnings.length).toBe(1)
    expect(mergeConfig(undefined).warnings).toEqual([])
  })
})

describe('analysis', () => {
  test('a quick question goes to haiku', () => {
    const a = analyse('What is a closure?', [], cfg)
    expect(a.type).toBe('quick-qa')
    expect(a.tier).toBe('haiku')
  })

  test('a typical coding task goes to sonnet', () => {
    const a = analyse('Implement a function that parses ISO dates in utils/date.ts and add unit tests for it', [], cfg)
    expect(a.type).toBe('code')
    expect(a.tier).toBe('sonnet')
  })

  test('architecture work goes to opus', () => {
    const a = analyse(
      'Design the architecture for migrating our monolith to microservices. Cover the data model, trade-offs, and a step by step migration roadmap for production.',
      [],
      cfg,
    )
    expect(a.type).toBe('architecture')
    expect(a.tier).toBe('opus')
    expect(a.output).toBe('large')
  })

  test('debugging with a stack trace scores above plain debugging', () => {
    const plain = analyse('The login test is failing', [], cfg)
    const trace = analyse('The login test is failing:\n```\nTypeError: x is undefined\n    at login (src/auth.ts:42:7)\n```', [], cfg)
    expect(plain.type).toBe('debugging')
    expect(trace.score).toBeGreaterThan(plain.score)
  })

  test('keywords match at word starts only', () => {
    // "capital" must not count as "api".
    expect(analyse('What is the capital of France?', [], cfg).type).toBe('quick-qa')
  })

  test('a short follow-up inherits the earlier conversation', () => {
    const history = [{ score: 80, type: 'architecture' as const }]
    const alone = analyse('now do the same for billing', [], cfg)
    const followUp = analyse('now do the same for billing', history, cfg)
    expect(followUp.isFollowUp).toBe(true)
    expect(followUp.type).toBe('architecture')
    expect(followUp.score).toBeGreaterThan(alone.score)
    expect(followUp.tier).not.toBe('haiku')
  })

  test('a long, self-contained prompt is not a follow-up', () => {
    const history = [{ score: 80, type: 'architecture' as const }]
    const a = analyse('What is the difference between let and const in JavaScript, and when should each be used in modern code bases?', history, cfg)
    expect(a.isFollowUp).toBe(false)
  })

  test('scores stay in 0-100', () => {
    const huge = analyse('architecture migration distributed microservice production security performance '.repeat(50), [], cfg)
    const tiny = analyse('what is tl;dr briefly', [], cfg)
    expect(huge.score).toBeLessThanOrEqual(100)
    expect(tiny.score).toBeGreaterThanOrEqual(0)
  })

  test('tier boundaries follow the thresholds', () => {
    expect(tierForScore(29, cfg)).toBe('haiku')
    expect(tierForScore(30, cfg)).toBe('sonnet')
    expect(tierForScore(64, cfg)).toBe('sonnet')
    expect(tierForScore(65, cfg)).toBe('opus')
  })
})

describe('stickiness', () => {
  test('no switch when the recommendation matches', () => {
    expect(decide({ score: 50, tier: 'sonnet' }, 'sonnet', 0, cfg)).toEqual({ recommended: 'sonnet', target: 'sonnet', isSwitch: false })
  })

  test('a score just over the boundary is held', () => {
    const d = decide({ score: 67, tier: 'opus' }, 'sonnet', 10, cfg)
    expect(d.isSwitch).toBe(false)
    expect(d.target).toBe('sonnet')
    expect(d.heldBecause).toContain('within')
  })

  test('a score clearly over the boundary switches', () => {
    const d = decide({ score: 80, tier: 'opus' }, 'sonnet', 10, cfg)
    expect(d).toEqual({ recommended: 'opus', target: 'opus', isSwitch: true })
  })

  test('downward switches need the same clearance', () => {
    expect(decide({ score: 60, tier: 'sonnet' }, 'opus', 10, cfg).isSwitch).toBe(false)
    expect(decide({ score: 50, tier: 'sonnet' }, 'opus', 10, cfg).isSwitch).toBe(true)
    expect(decide({ score: 25, tier: 'haiku' }, 'sonnet', 10, cfg).isSwitch).toBe(false)
    expect(decide({ score: 15, tier: 'haiku' }, 'sonnet', 10, cfg).isSwitch).toBe(true)
  })

  test('a recent switch holds a one-tier change but not a two-tier jump', () => {
    expect(decide({ score: 85, tier: 'opus' }, 'sonnet', 1, cfg).heldBecause).toContain('switched')
    expect(decide({ score: 85, tier: 'opus' }, 'haiku', 0, cfg).isSwitch).toBe(true)
  })
})

describe('models and commands', () => {
  test('tierOf maps aliases and full ids', () => {
    expect(tierOf('claude-opus-5-5')).toBe('opus')
    expect(tierOf('sonnet')).toBe('sonnet')
    expect(tierOf('claude-haiku-5-5')).toBe('haiku')
    expect(tierOf('claude-fable-5-2')).toBeUndefined()
    expect(tierOf(undefined)).toBeUndefined()
  })

  test('tierOf honours custom model ids', () => {
    const custom = mergeConfig({ models: { sonnet: 'my-gateway-model' } }).config
    expect(tierOf('my-gateway-model', custom)).toBe('sonnet')
  })

  test('parseRouteCommand covers every form', () => {
    expect(parseRouteCommand('')).toEqual({ kind: 'status' })
    expect(parseRouteCommand('  AUTO ')).toEqual({ kind: 'mode', mode: 'auto' })
    expect(parseRouteCommand('manual')).toEqual({ kind: 'mode', mode: 'manual' })
    expect(parseRouteCommand('recommend')).toEqual({ kind: 'mode', mode: 'recommend' })
    expect(parseRouteCommand('off')).toEqual({ kind: 'mode', mode: 'off' })
    expect(parseRouteCommand('lock opus')).toEqual({ kind: 'lock', model: 'opus' })
    expect(parseRouteCommand('lock')).toEqual({ kind: 'lock', model: 'sonnet' })
    expect(parseRouteCommand('lock gpt').kind).toBe('error')
    expect(parseRouteCommand('log on')).toEqual({ kind: 'log', enabled: true })
    expect(parseRouteCommand('log off')).toEqual({ kind: 'log', enabled: false })
    expect(parseRouteCommand('log maybe').kind).toBe('error')
    expect(parseRouteCommand('reload')).toEqual({ kind: 'reload' })
    expect(parseRouteCommand('help')).toEqual({ kind: 'help' })
    expect(parseRouteCommand('fast').kind).toBe('error')
  })

  test('statusLine shows mode, current model and effort, and the recommendation', () => {
    const text = statusLine({
      mode: 'recommend',
      current: { tier: 'sonnet', effort: 'high' },
      base: 'claude-opus-5-5',
      effortMode: 'auto',
      last: { recommended: { tier: 'opus', effort: 'high' }, reason: 'architecture, high complexity', heldBecause: 'score 67 is within 8' },
    })
    expect(text).toContain('Router recommend · Sonnet · high (base claude-opus-5-5)')
    expect(text).toContain('rec Opus · high · held')
    expect(statusLine({ mode: 'off', current: { tier: null, effort: null }, base: 'opus', effortMode: 'auto' })).toBe('Router off · opus')
    expect(statusLine({ mode: 'lock', current: { tier: 'haiku', effort: 'low' }, base: 'opus', effortMode: 'auto' })).toBe('Router locked · Haiku · low')
  })

  test('manual mode shows no recommendation, even if one is known', () => {
    const text = statusLine({
      mode: 'manual',
      current: { tier: 'opus', effort: null },
      base: 'claude-opus-5-5',
      effortMode: 'auto',
      last: { recommended: { tier: 'haiku', effort: 'low' }, reason: 'quick-qa' },
    })
    expect(text).toBe('Router manual · Opus · default')
  })

  test('statusLine shows a pending next-prompt override and escalation', () => {
    const base = { current: { tier: 'sonnet' as const, effort: 'medium' as const }, base: 'sonnet', effortMode: 'auto' as const }
    expect(statusLine({ ...base, mode: 'auto', next: { tier: 'opus', effort: 'high' } })).toContain('next: Opus · high')
    expect(statusLine({ ...base, mode: 'auto', escalation: { reason: 'tests failing', to: { tier: 'sonnet', effort: 'high' } } })).toContain(
      'escalating to Sonnet · high (tests failing)',
    )
    expect(statusLine({ ...base, mode: 'manual', escalation: { reason: 'tests failing', to: { tier: 'sonnet', effort: 'high' } } })).toContain(
      'suggest Sonnet · high',
    )
    expect(statusLine({ ...base, mode: 'auto', effortMode: 'lock' })).toContain('Sonnet · medium (effort locked)')
  })

  test('joinPath uses the platform separator of the base', () => {
    expect(joinPath('/Users/me', '.claude', 'model-router')).toBe('/Users/me/.claude/model-router')
    expect(joinPath('C:\\Users\\me', '.claude', 'model-router')).toBe('C:\\Users\\me\\.claude\\model-router')
    expect(joinPath('C:/Users/me/', 'x')).toBe('C:\\Users\\me\\x')
    expect(joinPath('\\\\server\\share\\home', 'x')).toBe('\\\\server\\share\\home\\x')
  })
})

describe('config 2.x', () => {
  test('a 1.x file saying "manual" means recommend', () => {
    expect(mergeConfig({ defaultMode: 'manual' }).config.defaultMode).toBe('recommend')
    expect(mergeConfig({ defaultMode: 'manual' }).config.configVersion).toBe(1)
  })

  test('a 2.x file saying "manual" means the new manual mode', () => {
    expect(mergeConfig({ configVersion: 2, defaultMode: 'manual' }).config.defaultMode).toBe('manual')
  })

  test('effort settings are validated field by field', () => {
    const { config, warnings } = mergeConfig({
      configVersion: 2,
      effort: {
        defaultMode: 'sometimes',
        defaultLockLevel: 'turbo',
        bands: { opus: [{ from: 50, level: 'high' }, { from: 10, level: 'max' }], sonnet: [{ from: 0, level: 'high' }] },
        maxLevel: { haiku: 'max' },
      },
      escalation: { enabled: 'yes', raiseEffortUpTo: { sonnet: 'xhigh' } },
    })
    expect(config.effort.defaultMode).toBe('auto')
    expect(config.effort.defaultLockLevel).toBe('high')
    expect(config.effort.bands.opus).toEqual(DEFAULT_CONFIG.effort.bands.opus) // not rising: refused
    expect(config.effort.bands.sonnet).toEqual([{ from: 0, level: 'high' }])
    expect(config.effort.maxLevel.haiku).toBe('max')
    expect(config.escalation.enabled).toBe(true)
    expect(config.escalation.raiseEffortUpTo.sonnet).toBe('xhigh')
    expect(warnings.length).toBe(4)
  })
})

describe('effort selection', () => {
  const sig = { signals: 2, isFollowUp: false, words: 10 }

  test('clearly simple tasks get Haiku at low effort', () => {
    const a = analyse('What is a closure?', [], cfg)
    expect(a.tier).toBe('haiku')
    expect(recommendEffort(a, a.tier, cfg).effort).toBe('low')
  })

  test('model and effort are one ladder: coding is Sonnet at medium, hard coding Sonnet at high', () => {
    expect(recommendEffort({ ...sig, score: 38, ownScore: 38 }, 'sonnet', cfg).effort).toBe('medium')
    expect(recommendEffort({ ...sig, score: 58, ownScore: 58 }, 'sonnet', cfg).effort).toBe('high')
  })

  test('Opus never runs at low effort; its range starts at medium', () => {
    expect(recommendEffort({ ...sig, score: 0, ownScore: 0 }, 'opus', cfg).effort).toBe('medium')
    expect(recommendEffort({ ...sig, score: 70, ownScore: 70 }, 'opus', cfg).effort).toBe('medium')
    expect(recommendEffort({ ...sig, score: 80, ownScore: 80 }, 'opus', cfg).effort).toBe('high')
    expect(recommendEffort({ ...sig, score: 95, ownScore: 95 }, 'opus', cfg).effort).toBe('xhigh')
  })

  test('quality first: a score just under a boundary gets the higher effort', () => {
    // 45 is within 4 of the sonnet high band at 48.
    const r = recommendEffort({ ...sig, score: 45, ownScore: 45 }, 'sonnet', cfg)
    expect(r.uncertain).toBe(true)
    expect(r.effort).toBe('high')
  })

  test('quality first: a prompt with no signals gets more effort', () => {
    const r = recommendEffort({ signals: 0, isFollowUp: false, words: 12, score: 18, ownScore: 18 }, 'haiku', cfg)
    expect(r.uncertain).toBe(true)
    expect(r.effort).toBe('high')
  })

  test('low is used only when the prompt itself is clearly simple', () => {
    // Blended score is low, but the prompt's own score is above lowMaxScore.
    expect(recommendEffort({ ...sig, score: 5, ownScore: 20 }, 'haiku', cfg).effort).toBe('medium')
  })

  test('the router never goes past maxLevel', () => {
    const capped = mergeConfig({ configVersion: 2, effort: { maxLevel: { opus: 'high' } } }).config
    expect(recommendEffort({ ...sig, score: 99, ownScore: 99 }, 'opus', capped).effort).toBe('high')
  })

  test('bandEffort reads the last band reached', () => {
    expect(bandEffort('sonnet', 47, cfg)).toBe('medium')
    expect(bandEffort('sonnet', 48, cfg)).toBe('high')
  })
})

describe('effort stickiness', () => {
  const sig = { signals: 2, isFollowUp: false, words: 10 }

  test('effort holds near a boundary and changes when the score is clearly past it', () => {
    expect(decideEffort({ ...sig, score: 50, ownScore: 50 }, 'sonnet', 'medium', 10, false, cfg)).toMatchObject({ target: 'medium', isSwitch: false })
    expect(decideEffort({ ...sig, score: 60, ownScore: 60 }, 'sonnet', 'medium', 10, false, cfg)).toMatchObject({ target: 'high', isSwitch: true })
    expect(decideEffort({ ...sig, score: 32, ownScore: 32 }, 'sonnet', 'high', 10, false, cfg)).toMatchObject({ target: 'medium', isSwitch: true })
  })

  test('a recent effort change holds a one-level step', () => {
    expect(decideEffort({ ...sig, score: 60, ownScore: 60 }, 'sonnet', 'medium', 0, false, cfg).heldBecause).toContain('effort changed')
  })

  test('after a model switch the recommended effort applies at once', () => {
    expect(decideEffort({ ...sig, score: 50, ownScore: 50 }, 'sonnet', 'medium', 0, true, cfg)).toMatchObject({ target: 'high' })
  })

  test('an unknown current effort takes the recommendation', () => {
    expect(decideEffort({ ...sig, score: 60, ownScore: 60 }, 'sonnet', null, 0, false, cfg).target).toBe('high')
  })
})

describe('escalation', () => {
  test('raises effort first, then the model', () => {
    expect(escalate({ tier: 'haiku', effort: 'low' }, cfg)).toEqual({ tier: 'haiku', effort: 'medium' })
    expect(escalate({ tier: 'haiku', effort: 'medium' }, cfg)).toEqual({ tier: 'sonnet', effort: 'high' })
    expect(escalate({ tier: 'sonnet', effort: 'medium' }, cfg)).toEqual({ tier: 'sonnet', effort: 'high' })
    expect(escalate({ tier: 'sonnet', effort: 'high' }, cfg)).toEqual({ tier: 'opus', effort: 'high' })
    expect(escalate({ tier: 'opus', effort: 'high' }, cfg)).toEqual({ tier: 'opus', effort: 'xhigh' })
    expect(escalate({ tier: 'opus', effort: 'max' }, cfg)).toBeNull()
  })

  test('a locked model only gains effort', () => {
    expect(escalate({ tier: 'sonnet', effort: 'high' }, cfg, 'sonnet')).toEqual({ tier: 'sonnet', effort: 'xhigh' })
    expect(escalate({ tier: 'haiku', effort: 'max' }, cfg, 'haiku')).toBeNull()
  })

  test('feedback is read only from short prompts', () => {
    expect(isNegativeFeedback("That didn't work, still failing", cfg)).toBe(true)
    expect(isNegativeFeedback('Great, thanks! Now add logging', cfg)).toBe(false)
    expect(isNegativeFeedback('try again '.repeat(30), cfg)).toBe(false)
    expect(isNegativeFeedback('try again', mergeConfig({ configVersion: 2, escalation: { enabled: false } }).config)).toBe(false)
  })

  test('test runs and failures are recognised', () => {
    expect(isTestCommand('npm test -- --watch=false', cfg)).toBe(true)
    expect(isTestCommand('python -m pytest tests/', cfg)).toBe(true)
    expect(isTestCommand('ls -la', cfg)).toBe(false)
    expect(runFailed(true, '', cfg)).toBe(true)
    expect(runFailed(false, 'Tests: 2 failed, 10 passed', cfg)).toBe(true)
    expect(runFailed(false, '12 passed, 0 failed', cfg)).toBe(false)
    expect(runFailed(false, 'All tests passed', cfg)).toBe(false)
  })
})

describe('combos and commands 2.x', () => {
  test('parseCombo reads labels and free text', () => {
    expect(parseCombo('Sonnet · high (recommended)')).toEqual({ tier: 'sonnet', effort: 'high' })
    expect(parseCombo('opus xhigh')).toEqual({ tier: 'opus', effort: 'xhigh' })
    expect(parseCombo('just haiku')).toEqual({ tier: 'haiku', effort: undefined })
    expect(parseCombo('max please')).toEqual({ tier: undefined, effort: 'max' })
  })

  test('/route next takes a model, an effort, or both', () => {
    expect(parseRouteCommand('next opus high')).toEqual({ kind: 'next', tier: 'opus', effort: 'high' })
    expect(parseRouteCommand('next high opus')).toEqual({ kind: 'next', tier: 'opus', effort: 'high' })
    expect(parseRouteCommand('next sonnet')).toEqual({ kind: 'next', tier: 'sonnet', effort: undefined })
    expect(parseRouteCommand('next max')).toEqual({ kind: 'next', tier: undefined, effort: 'max' })
    expect(parseRouteCommand('next clear')).toEqual({ kind: 'next-clear' })
    expect(parseRouteCommand('next').kind).toBe('error')
    expect(parseRouteCommand('next gpt high').kind).toBe('error')
    expect(parseRouteCommand('next opus high extra').kind).toBe('error')
  })

  test('/route effort auto and lock', () => {
    expect(parseRouteCommand('effort auto')).toEqual({ kind: 'effort-auto' })
    expect(parseRouteCommand('effort lock xhigh')).toEqual({ kind: 'effort-lock', level: 'xhigh' })
    expect(parseRouteCommand('effort lock')).toEqual({ kind: 'effort-lock', level: 'high' })
    expect(parseRouteCommand('effort lock turbo').kind).toBe('error')
    expect(parseRouteCommand('effort')).toEqual({ kind: 'status' })
    expect(parseRouteCommand('effort sometimes').kind).toBe('error')
  })
})

describe('build tasks', () => {
  test('a self-contained webapp request is Sonnet at high effort', () => {
    const a = analyse('Create a self contained webapp for reviewing all files in Download folder.', [], cfg)
    expect(a.type).toBe('build')
    expect(a.tier).toBe('sonnet')
    expect(recommendEffort(a, a.tier, cfg).effort).toBe('high')
  })

  test('a single build signal is Sonnet; build plus architecture reaches Opus', () => {
    expect(analyse('Build a dashboard for our sales numbers', [], cfg).tier).toBe('sonnet')
    expect(
      analyse('Design the architecture for a full-stack web application with a distributed backend, data model and migration roadmap for production', [], cfg).tier,
    ).toBe('opus')
  })

  test('build keywords do not fire on words that merely start the same', () => {
    // "apply", "approach" and "gamut" must not count as "an app" or "game".
    expect(analyse('What is the best approach to apply the gamut of options?', [], cfg).type).not.toBe('build')
  })
})

describe('scoring limits', () => {
  const plain = 'I want to create a self contained webapp that does your life prediction based on date of birth.'
  const spec = `I want to create a self contained webapp that does life prediction based on date of birth.
- Full app with a complete UI
- Show every milestone for the entire lifespan
- Include detailed charts and a report
- Handle all files: index.html, app.js, styles.css, data.json
- Make it production ready and robust, with security and performance in mind
- Step by step explanation of the algorithm`

  test('a simple webapp request goes to Sonnet at high effort', () => {
    const a = analyse(plain, [], cfg)
    expect(a.type).toBe('build')
    expect(a.tier).toBe('sonnet')
    expect(recommendEffort(a, a.tier, cfg).effort).toBe('high')
  })

  test('the same request with a bulleted spec stays at Opus medium, not xhigh', () => {
    const a = analyse(spec, [], cfg)
    expect(a.type).toBe('build')
    expect(a.score).toBe(cfg.scoring.taskCeilings.build)
    expect(a.tier).toBe('opus')
    expect(recommendEffort(a, a.tier, cfg).effort).toBe('medium')
  })

  test('structure adds at most the structure cap, however many bullets there are', () => {
    // Compare with filler of the same word count, so only the structure differs.
    const bullets = `Explain this list.\n${Array.from({ length: 40 }, (_, i) => `- item ${i}`).join('\n')}`
    const words = bullets.trim().split(/\s+/).length
    const filler = Array.from({ length: words }, () => 'word').join(' ')
    const withBullets = analyse(bullets, [], cfg)
    const without = analyse(filler, [], cfg)
    expect(withBullets.score - without.score).toBeLessThanOrEqual(cfg.scoring.structureCap)
    expect(withBullets.score - without.score).toBeGreaterThan(0)
  })

  test('architecture is not capped: a hard architecture request can reach xhigh', () => {
    const a = analyse(
      'Design the architecture for migrating our monolith to microservices.\n- data model\n- trade-offs\n- rollout roadmap\n- performance and security\n- every service boundary, step by step, production',
      [],
      cfg,
    )
    expect(a.type).toBe('architecture')
    expect(a.score).toBeGreaterThanOrEqual(90)
    expect(recommendEffort(a, a.tier, cfg).effort).toBe('xhigh')
  })

  test('the ceilings come from config and can be changed; unknown types are refused', () => {
    const { config, warnings } = mergeConfig({ configVersion: 2, scoring: { taskCeilings: { build: 95, bogus: 5 }, structureCap: 'many' } })
    expect(config.scoring.taskCeilings).toEqual({ build: 95 })
    expect(config.scoring.structureCap).toBe(DEFAULT_CONFIG.scoring.structureCap)
    expect(warnings.length).toBe(2)
  })
})

describe('classifier verdicts', () => {
  test('parseVerdict reads JSON inside prose and refuses unknown values', () => {
    expect(parseVerdict('Sure: {"complexity":"complex","sentiment":"negative","isFeedback":true}')).toEqual({
      complexity: 'complex',
      sentiment: 'negative',
      isFeedback: true,
    })
    expect(parseVerdict('{"complexity":"huge","sentiment":"neutral","isFeedback":false}')).toBeNull()
    expect(parseVerdict('{"complexity":"simple","sentiment":"neutral"}')).toBeNull()
    expect(parseVerdict('no json here')).toBeNull()
    expect(parseVerdict('{not json')).toBeNull()
  })

  test('a new task is held inside the band for its complexity, and capped by the type', () => {
    const a = analyse('Write a function that adds two numbers', [], cfg) // a code task, low rules score
    const v = { complexity: 'architecture' as const, sentiment: 'neutral' as const, isFeedback: false }
    const out = applyVerdict(a, v, { taskScore: null }, cfg)
    // The rules' low score is raised to the bottom of the architecture band.
    expect(a.score).toBeLessThan(cfg.classifier.bands.architecture.min)
    expect(out.score).toBe(cfg.classifier.bands.architecture.min)
    expect(out.tier).toBe('opus')
    // The type's ceiling still applies on top.
    const capped = mergeConfig({ configVersion: 2, scoring: { taskCeilings: { code: 50 } } }).config
    expect(applyVerdict(a, v, { taskScore: null }, capped).score).toBe(50)
    const simple = applyVerdict(analyse('Explain closures', [], cfg), { complexity: 'simple', sentiment: 'neutral', isFeedback: false }, { taskScore: null }, cfg)
    expect(simple.tier).toBe('haiku')
  })

  test('feedback carries the task score; negative feedback adds the bump', () => {
    const a = analyse('Thanks, looks good', [], cfg)
    const approve = applyVerdict(a, { complexity: 'simple', sentiment: 'approve', isFeedback: true }, { taskScore: 77 }, cfg)
    expect(approve.score).toBe(77)
    const angry = applyVerdict(a, { complexity: 'simple', sentiment: 'negative', isFeedback: true }, { taskScore: 77 }, cfg)
    expect(angry.score).toBe(77 + cfg.classifier.negativeBump)
    expect(angry.tier).toBe('opus')
  })

  test('feedback with no task to refer to is treated as a new task', () => {
    const a = analyse('Still wrong', [], cfg)
    const out = applyVerdict(a, { complexity: 'simple', sentiment: 'negative', isFeedback: true }, { taskScore: null }, cfg)
    expect(out.reason).toContain('simple task')
  })

  test('the classifier config is validated field by field', () => {
    const { config, warnings } = mergeConfig({
      configVersion: 2,
      classifier: { enabled: 'maybe', timeoutMs: 50, bands: { complex: { min: 80, max: 50 }, architecture: { min: 75, max: 89 } } },
    })
    expect(config.classifier.enabled).toBe(true)
    expect(config.classifier.timeoutMs).toBe(DEFAULT_CONFIG.classifier.timeoutMs)
    expect(config.classifier.bands.complex).toEqual(DEFAULT_CONFIG.classifier.bands.complex) // min > max: refused
    expect(config.classifier.bands.architecture).toEqual({ min: 75, max: 89 })
    expect(warnings.length).toBe(3)
  })
})

describe('architecture and effort after a verdict', () => {
  const arch = { complexity: 'architecture' as const, sentiment: 'neutral' as const, isFeedback: false }
  const user = 'Design the architecture for migrating our monolith to services, with a roadmap'

  test('a typical architecture request lands on Opus medium, not xhigh', () => {
    const out = applyVerdict(analyse(user, [], cfg), arch, { taskScore: null }, cfg)
    expect(out.tier).toBe('opus')
    expect(recommendEffort(out, out.tier, cfg).effort).toBe('medium')
  })

  test('a verdict is not unsure: no uncertainty bump on top of it', () => {
    // Score 72 sits 3 under the 75 boundary: unsure by rules, not by a verdict.
    const plain = analyse(user, [], cfg)
    const verdicted = { ...plain, score: 72, tier: 'opus' as const, classified: true }
    const unverdicted = { ...plain, score: 72, tier: 'opus' as const, classified: undefined }
    expect(recommendEffort(verdicted, 'opus', cfg).uncertain).toBe(false)
    expect(recommendEffort(unverdicted, 'opus', cfg).uncertain).toBe(true)
  })

  test('even a very large architecture request stays at Opus medium on its own', () => {
    const huge = analyse('Design the architecture for migrating our monolith to microservices.\n- data model\n- trade-offs\n- rollout roadmap\n- performance and security\n- every service boundary, step by step, production', [], cfg)
    expect(huge.score).toBe(100) // the rules saturate on long architecture prompts
    const out = applyVerdict(huge, arch, { taskScore: null }, cfg)
    expect(out.score).toBe(cfg.classifier.bands.architecture.max)
    expect(recommendEffort(out, out.tier, cfg).effort).toBe('medium')
  })

  test('negative feedback is what moves architecture up: medium, then high, then xhigh', () => {
    const a = analyse('Still wrong', [], cfg)
    const neg = { complexity: 'simple' as const, sentiment: 'negative' as const, isFeedback: true }
    let task = cfg.classifier.bands.architecture.max // 74: Opus medium
    const levels: string[] = []
    for (let i = 0; i < 2; i++) {
      const out = applyVerdict(a, neg, { taskScore: task }, cfg)
      levels.push(recommendEffort(out, out.tier, cfg).effort)
      task = out.score
    }
    expect(levels).toEqual(['high', 'xhigh'])
  })

  test('the rules alone (no classifier answer) can still reach xhigh for architecture', () => {
    const huge = analyse('Design the architecture for migrating our monolith to microservices.\n- data model\n- trade-offs\n- rollout roadmap\n- performance and security\n- every service boundary, step by step, production', [], cfg)
    expect(recommendEffort(huge, huge.tier, cfg).effort).toBe('xhigh')
  })
})

describe('continuations', () => {
  test('short "continue" messages are continuations; longer or unrelated ones are not', () => {
    expect(isContinuation('Continue', cfg)).toBe(true)
    expect(isContinuation('go on please', cfg)).toBe(true)
    expect(isContinuation('Yes, do it', cfg)).toBe(true)
    expect(isContinuation('What is a closure?', cfg)).toBe(false)
    expect(isContinuation('continue with the database migration plan and then the rollout', cfg)).toBe(false)
  })

  test('a continuation inherits the task score even when the verdict says new and simple', () => {
    const a = analyse('Continue', [], cfg)
    const out = applyVerdict(a, { complexity: 'simple', sentiment: 'neutral', isFeedback: false }, { taskScore: 70, continues: true }, cfg)
    expect(out.score).toBe(70)
    expect(out.tier).toBe('opus')
    expect(out.reason).toContain('continues the last task')
  })
})
