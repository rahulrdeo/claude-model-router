// Pure routing logic for the model-router mod.
import { DEFAULT_PRICES, mergePrices, type Family, type Price } from './savings-core'
// No engine calls, no I/O: everything here is deterministic and unit-tested.

export type Tier = 'haiku' | 'sonnet' | 'opus'
/**
 * auto: analyse and apply. recommend: analyse, then you accept or change.
 * manual: no analysis; you choose (session model, /route next, effort lock).
 * off: router does nothing but /route next. lock: one model, router picks effort.
 */
export type Mode = 'auto' | 'recommend' | 'manual' | 'off' | 'lock'
export type TaskType = 'architecture' | 'build' | 'debugging' | 'code' | 'writing' | 'quick-qa' | 'general'
export type OutputSize = 'small' | 'medium' | 'large'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type EffortMode = 'auto' | 'lock'
export type Combo = { tier: Tier; effort: Effort }

export const TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus']
export const MODES: readonly Mode[] = ['auto', 'recommend', 'manual', 'off', 'lock']
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const CONFIG_VERSION = 2

export type EffortBand = { from: number; level: Effort }

export type KeywordGroup = { weight: number; keywords: string[] }

export type RouterConfig = {
  /** Scoring limits: how far structure and task type can move the score. */
  scoring: {
    /** The bullets, file names, code blocks and stack traces together add at most this. */
    structureCap: number
    /** The highest score a task type can reach. Types left out are uncapped. */
    taskCeilings: Partial<Record<TaskType, number>>
  }
  /** 2 for this format; a file without it is read as version 1 ("manual" meant today's "recommend"). */
  configVersion: number
  /** Mode used when none has been chosen with /route yet. */
  defaultMode: Mode
  /** Model used by `/route lock` with no argument. */
  defaultLockModel: Tier
  /** What each tier is sent to the API as: an alias or a full model id. */
  models: Record<Tier, string>
  thresholds: {
    /** Scores below this go to haiku. */
    haikuMax: number
    /** Scores at or above this go to opus. */
    opusMin: number
    /** Points a score must clear a boundary by before switching away (stickiness). */
    switchMargin: number
    /** Prompts to stay on a model after a switch, unless the jump is two tiers. */
    minPromptsBetweenSwitches: number
  }
  context: {
    /** How many earlier prompts feed the context score. */
    historySize: number
    /** Weight of earlier conversation for an ordinary prompt (0-1). */
    weight: number
    /** Weight of earlier conversation for a detected follow-up (0-1). */
    followUpWeight: number
    /** Prompts with at most this many words can count as follow-ups. */
    followUpMaxWords: number
    followUpKeywords: string[]
  }
  /** Keyword groups: each match adds the group's weight (negative lowers the score). */
  taskTypes: Record<Exclude<TaskType, 'general'>, KeywordGroup>
  complexityBoosters: KeywordGroup
  simplifiers: KeywordGroup
  largeOutputKeywords: string[]
  logging: {
    enabled: boolean
    /** Rotate the log to routing.log.1 past this many bytes. */
    maxBytes: number
    /** Store a short excerpt of each prompt in the log. Off by default for privacy. */
    includePromptExcerpt: boolean
  }
  /** Ask in recommend mode only when the recommendation differs from the current model and effort. */
  manualAskOnlyOnChange: boolean
  effort: {
    /** Effort mode used until you choose one with /route effort. */
    defaultMode: EffortMode
    /** Level for "/route effort lock" with no argument. */
    defaultLockLevel: Effort
    /** Per model: the effort for a score, the last band whose `from` the score reaches. */
    bands: Record<Tier, EffortBand[]>
    /** Highest level the router picks for each model (uncertainty bumps stop here). */
    maxLevel: Record<Tier, Effort>
    /** A score this close below a model or effort boundary counts as uncertain: effort goes up one level. */
    uncertaintyMargin: number
    /** "low" is used only when the prompt's own score is at most this and nothing is uncertain. */
    lowMaxScore: number
    /** Points a score must clear an effort boundary by before effort changes (stickiness). */
    switchMargin: number
  }
  classifier: {
    /** Ask a small model to read each new message with the last exchange. */
    enabled: boolean
    model: string
    effort: Effort
    timeoutMs: number
    /** Points added to the task's score by each negative feedback message. */
    negativeBump: number
    /**
     * The score range each complexity the classifier reports maps to, for a new task. The
     * rules' score is held inside it, so the classifier sets the level and the rules only
     * place the prompt within it.
     */
    bands: Record<Complexity, { min: number; max: number }>
  }
  /** Subagent model router: Haiku reads each subagent's task and picks its model. */
  subagents: {
    enabled: boolean
    /** Keep the model the Agent call already named (the caller chose on purpose). */
    keepCallerModel: boolean
    /** Let a pick go above the parent's model (off: subagents only get cheaper). */
    allowUpgrade: boolean
    /** Below this confidence (0-1) the subagent keeps the parent's model. */
    minConfidence: number
    timeoutMs: number
    /** Open the subagent pane on the first pick of a session. */
    openPane: boolean
    /** Send a task Haiku rates as risky to Opus, even above the parent's model. */
    riskyToOpus: boolean
    /** The risk (0-1) from which a task counts as risky. */
    riskyAt: number
  }
  /** The cost-savings estimate: a ledger file and the Savings pane. */
  savings: {
    enabled: boolean
    /** Also write each priced turn to cost-ledger.jsonl next to the config. */
    ledger: boolean
    /** $ per million tokens by model family. */
    prices: Record<Family, Price>
  }
  /** Handoff for long chats: a helper writes a detailed prompt to carry on in a fresh chat. */
  handoff: {
    enabled: boolean
    /** Write a handoff once the context reaches this many tokens (0: only with /handoff). */
    autoAtTokens: number
    /** Show a note under the prompt once the chat reaches this many tokens (0: never). */
    warnAtTokens: number
    model: string
    effort: Effort
    maxTokens: number
    timeoutMs: number
    /** The most transcript text sent to the helper; long tool output is trimmed first. */
    maxInputChars: number
    /** Also save each handoff as a Markdown file next to the config. */
    saveToFile: boolean
  }
  /** Cache clock: a countdown to when the chat's prompt cache goes cold. */
  cacheClock: {
    enabled: boolean
    /** Cache lifetime in minutes; 0 detects it (60 when requests ask for a 1-hour cache, else 5). */
    ttlMinutes: number
    /** Keep warm pings this many seconds before the cache would expire. */
    pingLeadSeconds: number
    /** Most pings per idle stretch, so a forgotten chat does not ping forever. */
    maxPings: number
    /** Keep warm starts by itself only when the chat is at least this many tokens. */
    autoStartMinTokens: number
    /** Keep warm also stops this many minutes after it was switched on. */
    maxMinutes: number
  }
  escalation: {
    enabled: boolean
    /** Escalation raises effort up to this level on a model, then moves to the next model. */
    raiseEffortUpTo: Record<Tier, Effort>
    /** A short next prompt containing one of these means the last result was poor. */
    feedbackKeywords: string[]
    feedbackMaxWords: number
    /** A Bash command containing one of these is a test or build run. */
    testCommandPatterns: string[]
    /** Output containing one of these (when the command did not already fail) means it failed. */
    failurePatterns: string[]
  }
}

export const DEFAULT_CONFIG: RouterConfig = {
  configVersion: CONFIG_VERSION,
  // 70 is the top of the Opus medium band: build, code and writing never reach Opus xhigh on their own.
  scoring: { structureCap: 20, taskCeilings: { build: 70, code: 70, writing: 70 } },
  classifier: {
    enabled: true,
    model: 'haiku',
    effort: 'low',
    timeoutMs: 3000,
    negativeBump: 10,
    // Architecture: Opus at medium. Higher levels come from escalation, /route next or an effort lock.
    bands: {
      simple: { min: 0, max: 29 },
      moderate: { min: 30, max: 64 },
      complex: { min: 48, max: 74 },
      architecture: { min: 65, max: 74 },
    },
  },
  subagents: { enabled: true, keepCallerModel: true, allowUpgrade: false, minConfidence: 0.6, timeoutMs: 4000, openPane: true, riskyToOpus: true, riskyAt: 0.75 },
  savings: { enabled: true, ledger: true, prices: DEFAULT_PRICES },
  handoff: {
    enabled: true,
    autoAtTokens: 250000,
    warnAtTokens: 150000,
    model: 'sonnet',
    effort: 'medium',
    maxTokens: 8000,
    timeoutMs: 240000,
    maxInputChars: 600000,
    saveToFile: true,
  },
  cacheClock: { enabled: true, ttlMinutes: 0, pingLeadSeconds: 30, maxPings: 2, maxMinutes: 90, autoStartMinTokens: 50_000 },
  defaultMode: 'recommend',
  defaultLockModel: 'sonnet',
  models: { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus' },
  thresholds: { haikuMax: 30, opusMin: 65, switchMargin: 8, minPromptsBetweenSwitches: 2 },
  context: {
    historySize: 5,
    weight: 0.25,
    followUpWeight: 0.6,
    followUpMaxWords: 25,
    followUpKeywords: [
      'it', 'that', 'this', 'those', 'these', 'again', 'also', 'continue', 'go on', 'go ahead',
      'do it', 'same', 'instead', 'next', 'what about', 'and then', 'now', 'ok', 'okay', 'yes',
      'try', 'still', 'retry', 'above', 'previous',
    ],
  },
  taskTypes: {
    architecture: {
      weight: 35,
      keywords: [
        'architecture', 'architect', 'system design', 'design a system', 'scalab', 'migrate',
        'migration', 'trade-off', 'tradeoff', 'from scratch', 'end-to-end', 'distributed',
        'microservice', 'data model', 'schema design', 'rewrite the', 'overhaul', 'roadmap',
      ],
    },
    build: {
      weight: 20,
      keywords: [
        'webapp', 'web app', 'web application', 'website', 'web page', 'webpage', 'landing page',
        'single-page', 'dashboard', 'frontend', 'front-end', 'full-stack', 'fullstack', 'self-contained',
        'self contained', 'prototype', 'mvp', 'an app', 'app that', 'app for', 'mobile app', 'desktop app',
        'cli tool', 'command-line tool', 'browser extension', 'chrome extension', 'game', 'ui for',
        'user interface',
      ],
    },
    debugging: {
      weight: 22,
      keywords: [
        'debug', 'bug', 'error', 'exception', 'stack trace', 'traceback', 'crash', 'fails',
        'failing', 'not working', "doesn't work", 'broken', 'race condition', 'memory leak',
        'segfault', 'deadlock', 'flaky', 'regression', 'root cause',
      ],
    },
    code: {
      weight: 14,
      keywords: [
        'implement', 'function', 'class', 'refactor', 'code', 'script', 'api', 'endpoint',
        'unit test', 'tests', 'regex', 'sql', 'component', 'module', 'library', 'compile',
        'build', 'typescript', 'python', 'java', 'golang', 'rust',
      ],
    },
    writing: {
      weight: 4,
      keywords: [
        'draft', 'email', 'blog', 'essay', 'summarize', 'summarise', 'summary', 'rephrase',
        'proofread', 'translate', 'readme', 'documentation', 'cover letter', 'announcement',
      ],
    },
    'quick-qa': {
      weight: -18,
      keywords: [
        'what is', "what's", 'how do i', 'define', 'meaning of', 'quick question', 'briefly',
        'tl;dr', 'one line', 'yes or no', 'which is', 'remind me', 'syntax for',
      ],
    },
  },
  complexityBoosters: {
    weight: 10,
    keywords: [
      'step by step', 'thorough', 'in depth', 'in-depth', 'comprehensive', 'production',
      'enterprise', 'security', 'performance', 'optimi', 'concurren', 'across the codebase',
      'entire', 'every file', 'all files', 'multi-step', 'complex', 'robust',
    ],
  },
  simplifiers: {
    weight: -10,
    keywords: ['typo', 'rename', 'reformat', 'lint', 'simple', 'small', 'tiny', 'trivial', 'one-liner', 'quick fix'],
  },
  largeOutputKeywords: [
    'full', 'complete', 'entire', 'whole', 'all files', 'multiple files', 'project', 'app',
    'application', 'report', 'detailed', 'comprehensive', 'every',
  ],
  logging: { enabled: false, maxBytes: 1_000_000, includePromptExcerpt: false },
  manualAskOnlyOnChange: true,
  effort: {
    defaultMode: 'auto',
    defaultLockLevel: 'high',
    bands: {
      haiku: [
        { from: 0, level: 'low' },
        { from: 15, level: 'medium' },
        { from: 45, level: 'high' },
      ],
      sonnet: [
        { from: 0, level: 'low' },
        { from: 15, level: 'medium' },
        { from: 48, level: 'high' },
        { from: 85, level: 'xhigh' },
      ],
      opus: [
        { from: 0, level: 'medium' },
        { from: 75, level: 'high' },
        { from: 90, level: 'xhigh' },
      ],
    },
    maxLevel: { haiku: 'high', sonnet: 'xhigh', opus: 'max' },
    uncertaintyMargin: 4,
    lowMaxScore: 12,
    switchMargin: 5,
  },
  escalation: {
    enabled: true,
    raiseEffortUpTo: { haiku: 'medium', sonnet: 'high', opus: 'max' },
    feedbackKeywords: [
      'still failing', 'still fails', 'still broken', 'still not', "doesn't work", 'does not work',
      "didn't work", 'did not work', 'not working', "that's wrong", 'that is wrong', 'wrong answer',
      'incorrect', 'not right', 'poor', 'bad result', 'try again', 'same error', 'not what i asked',
      'you broke', 'worse',
    ],
    feedbackMaxWords: 40,
    testCommandPatterns: [
      'test', 'pytest', 'jest', 'vitest', 'mocha', 'rspec', 'phpunit', 'tox', 'go vet', 'cargo build',
      'cargo check', 'tsc', 'mvn', 'gradle', 'dotnet build', 'make',
    ],
    failurePatterns: [
      'failed', 'failing', 'failure', 'error:', 'errors:', 'traceback', 'assertionerror', 'npm err!',
      'build failed', 'panicked',
    ],
  },
}

// ---------------------------------------------------------------------------
// Config parsing: JSON with comments and trailing commas, BOM and CRLF safe.

/** Strips // and /* *\/ comments and trailing commas, leaving strings untouched. */
export function stripJsonc(text: string): string {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    const d = text[i + 1]
    if (c === '"') {
      let j = i + 1
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === '/' && d === '/') {
      while (i < n && text[i] !== '\n') i++
    } else if (c === '/' && d === '*') {
      i += 2
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
    } else {
      out += c
      i++
    }
  }
  // Trailing commas: a comma followed only by whitespace before } or ].
  return out.replace(/,(\s*[}\]])/g, '$1')
}

export function parseJsonc(text: string): unknown {
  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  return JSON.parse(stripJsonc(clean))
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isTier = (v: unknown): v is Tier => typeof v === 'string' && (TIERS as readonly string[]).includes(v)
const isMode = (v: unknown): v is Mode => typeof v === 'string' && (MODES as readonly string[]).includes(v)
export const isEffort = (v: unknown): v is Effort => typeof v === 'string' && (EFFORTS as readonly string[]).includes(v)

/**
 * Overlays a user config on the defaults, field by field. Any invalid field is
 * dropped with a warning and its default kept, so a typo never breaks routing.
 */
export function mergeConfig(user: unknown): { config: RouterConfig; warnings: string[] } {
  const warnings: string[] = []
  const config: RouterConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG))
  if (user === undefined) return { config, warnings }
  if (!isObj(user)) return { config, warnings: ['config is not a JSON object; using defaults'] }

  const num = (v: unknown, path: string, min: number, max: number): number | undefined => {
    if (v === undefined) return undefined
    if (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max) return v
    warnings.push(`${path} must be a number from ${min} to ${max}; using default`)
    return undefined
  }
  const strs = (v: unknown, path: string): string[] | undefined => {
    if (v === undefined) return undefined
    if (Array.isArray(v) && v.every(s => typeof s === 'string')) return v.map(s => s.toLowerCase())
    warnings.push(`${path} must be a list of strings; using default`)
    return undefined
  }
  const group = (v: unknown, path: string, base: KeywordGroup): KeywordGroup => {
    if (v === undefined) return base
    if (!isObj(v)) {
      warnings.push(`${path} must be an object; using default`)
      return base
    }
    return {
      weight: num(v.weight, `${path}.weight`, -100, 100) ?? base.weight,
      keywords: strs(v.keywords, `${path}.keywords`) ?? base.keywords,
    }
  }

  // A file without configVersion was written by 1.x, where "manual" meant what "recommend" means now.
  config.configVersion = typeof user.configVersion === 'number' ? user.configVersion : 1
  if (user.defaultMode !== undefined) {
    if (config.configVersion < 2 && user.defaultMode === 'manual') config.defaultMode = 'recommend'
    else if (isMode(user.defaultMode)) config.defaultMode = user.defaultMode
    else warnings.push(`defaultMode must be one of ${MODES.join(', ')}; using default`)
  }
  if (user.defaultLockModel !== undefined) {
    if (isTier(user.defaultLockModel)) config.defaultLockModel = user.defaultLockModel
    else warnings.push(`defaultLockModel must be one of ${TIERS.join(', ')}; using default`)
  }
  if (isObj(user.models)) {
    for (const t of TIERS) {
      const v = user.models[t]
      if (v === undefined) continue
      if (typeof v === 'string' && v.trim() !== '') config.models[t] = v.trim()
      else warnings.push(`models.${t} must be a non-empty string; using default`)
    }
  }
  if (isObj(user.thresholds)) {
    const t = user.thresholds
    config.thresholds.haikuMax = num(t.haikuMax, 'thresholds.haikuMax', 0, 100) ?? config.thresholds.haikuMax
    config.thresholds.opusMin = num(t.opusMin, 'thresholds.opusMin', 0, 100) ?? config.thresholds.opusMin
    config.thresholds.switchMargin = num(t.switchMargin, 'thresholds.switchMargin', 0, 50) ?? config.thresholds.switchMargin
    config.thresholds.minPromptsBetweenSwitches =
      num(t.minPromptsBetweenSwitches, 'thresholds.minPromptsBetweenSwitches', 0, 50) ??
      config.thresholds.minPromptsBetweenSwitches
    if (config.thresholds.haikuMax >= config.thresholds.opusMin) {
      warnings.push('thresholds.haikuMax must be below thresholds.opusMin; using default thresholds')
      config.thresholds.haikuMax = DEFAULT_CONFIG.thresholds.haikuMax
      config.thresholds.opusMin = DEFAULT_CONFIG.thresholds.opusMin
    }
  }
  if (isObj(user.context)) {
    const c = user.context
    config.context.historySize = num(c.historySize, 'context.historySize', 0, 50) ?? config.context.historySize
    config.context.weight = num(c.weight, 'context.weight', 0, 1) ?? config.context.weight
    config.context.followUpWeight = num(c.followUpWeight, 'context.followUpWeight', 0, 1) ?? config.context.followUpWeight
    config.context.followUpMaxWords = num(c.followUpMaxWords, 'context.followUpMaxWords', 0, 1000) ?? config.context.followUpMaxWords
    config.context.followUpKeywords = strs(c.followUpKeywords, 'context.followUpKeywords') ?? config.context.followUpKeywords
  }
  if (isObj(user.taskTypes)) {
    for (const k of Object.keys(config.taskTypes) as (keyof RouterConfig['taskTypes'])[]) {
      config.taskTypes[k] = group(user.taskTypes[k], `taskTypes.${k}`, config.taskTypes[k])
    }
  }
  config.complexityBoosters = group(user.complexityBoosters, 'complexityBoosters', config.complexityBoosters)
  config.simplifiers = group(user.simplifiers, 'simplifiers', config.simplifiers)
  config.largeOutputKeywords = strs(user.largeOutputKeywords, 'largeOutputKeywords') ?? config.largeOutputKeywords
  if (isObj(user.logging)) {
    const l = user.logging
    if (typeof l.enabled === 'boolean') config.logging.enabled = l.enabled
    else if (l.enabled !== undefined) warnings.push('logging.enabled must be true or false; using default')
    // The engine reads files of up to 4 MiB, and the log is read back to append to it.
    config.logging.maxBytes = num(l.maxBytes, 'logging.maxBytes', 10_000, 4_000_000) ?? config.logging.maxBytes
    if (typeof l.includePromptExcerpt === 'boolean') config.logging.includePromptExcerpt = l.includePromptExcerpt
  }
  if (typeof user.manualAskOnlyOnChange === 'boolean') config.manualAskOnlyOnChange = user.manualAskOnlyOnChange
  if (isObj(user.scoring)) {
    const sc = user.scoring
    config.scoring.structureCap = num(sc.structureCap, 'scoring.structureCap', 0, 100) ?? config.scoring.structureCap
    if (sc.taskCeilings !== undefined) {
      if (!isObj(sc.taskCeilings)) {
        warnings.push('scoring.taskCeilings must be an object; using default')
      } else {
        const next: Partial<Record<TaskType, number>> = {}
        for (const [k, v] of Object.entries(sc.taskCeilings)) {
          if (!['architecture', 'build', 'debugging', 'code', 'writing', 'quick-qa', 'general'].includes(k)) {
            warnings.push(`scoring.taskCeilings.${k} is not a task type; ignored`)
          } else if (typeof v === 'number' && v >= 0 && v <= 100) {
            next[k as TaskType] = v
          } else {
            warnings.push(`scoring.taskCeilings.${k} must be a number from 0 to 100; ignored`)
          }
        }
        config.scoring.taskCeilings = next
      }
    }
  }

  const level = (v: unknown, path: string): Effort | undefined => {
    if (v === undefined) return undefined
    if (isEffort(v)) return v
    warnings.push(`${path} must be one of ${EFFORTS.join(', ')}; using default`)
    return undefined
  }
  const perTier = (v: unknown, path: string, base: Record<Tier, Effort>): Record<Tier, Effort> => {
    const out = { ...base }
    if (v === undefined) return out
    if (!isObj(v)) {
      warnings.push(`${path} must be an object; using default`)
      return out
    }
    for (const t of TIERS) out[t] = level(v[t], `${path}.${t}`) ?? out[t]
    return out
  }
  if (isObj(user.effort)) {
    const e = user.effort
    if (e.defaultMode !== undefined) {
      if (e.defaultMode === 'auto' || e.defaultMode === 'lock') config.effort.defaultMode = e.defaultMode
      else warnings.push('effort.defaultMode must be "auto" or "lock"; using default')
    }
    config.effort.defaultLockLevel = level(e.defaultLockLevel, 'effort.defaultLockLevel') ?? config.effort.defaultLockLevel
    if (isObj(e.bands)) {
      for (const t of TIERS) {
        const b = e.bands[t]
        if (b === undefined) continue
        const valid =
          Array.isArray(b) &&
          b.length > 0 &&
          b.every((x, i) => isObj(x) && typeof x.from === 'number' && isEffort(x.level) && (i === 0 || x.from > (b[i - 1] as { from: number }).from))
        if (valid) config.effort.bands[t] = (b as EffortBand[]).map(x => ({ from: x.from, level: x.level }))
        else warnings.push(`effort.bands.${t} must be a non-empty list of { "from": number, "level": effort } in rising order; using default`)
      }
    } else if (e.bands !== undefined) warnings.push('effort.bands must be an object; using default')
    config.effort.maxLevel = perTier(e.maxLevel, 'effort.maxLevel', config.effort.maxLevel)
    config.effort.uncertaintyMargin = num(e.uncertaintyMargin, 'effort.uncertaintyMargin', 0, 50) ?? config.effort.uncertaintyMargin
    config.effort.lowMaxScore = num(e.lowMaxScore, 'effort.lowMaxScore', 0, 100) ?? config.effort.lowMaxScore
    config.effort.switchMargin = num(e.switchMargin, 'effort.switchMargin', 0, 50) ?? config.effort.switchMargin
  }
  if (isObj(user.classifier)) {
    const k = user.classifier
    if (typeof k.enabled === 'boolean') config.classifier.enabled = k.enabled
    else if (k.enabled !== undefined) warnings.push('classifier.enabled must be true or false; using default')
    if (typeof k.model === 'string' && k.model.trim() !== '') config.classifier.model = k.model.trim()
    else if (k.model !== undefined) warnings.push('classifier.model must be a non-empty string; using default')
    if (isEffort(k.effort)) config.classifier.effort = k.effort
    else if (k.effort !== undefined) warnings.push(`classifier.effort must be one of ${EFFORTS.join(', ')}; using default`)
    config.classifier.timeoutMs = num(k.timeoutMs, 'classifier.timeoutMs', 500, 10000) ?? config.classifier.timeoutMs
    config.classifier.negativeBump = num(k.negativeBump, 'classifier.negativeBump', 0, 50) ?? config.classifier.negativeBump
    if (isObj(k.bands)) {
      for (const c of COMPLEXITIES) {
        const b = k.bands[c]
        if (b === undefined) continue
        const min = isObj(b) ? b.min : undefined
        const max = isObj(b) ? b.max : undefined
        if (typeof min === 'number' && typeof max === 'number' && min >= 0 && max <= 100 && min <= max) {
          config.classifier.bands[c] = { min, max }
        } else {
          warnings.push(`classifier.bands.${c} must be { "min": n, "max": n } with 0 <= min <= max <= 100; using default`)
        }
      }
    } else if (k.bands !== undefined) warnings.push('classifier.bands must be an object; using default')
  }
  const bool = (v: unknown, path: string): boolean | undefined => {
    if (v === undefined) return undefined
    if (typeof v === 'boolean') return v
    warnings.push(`${path} must be true or false; using default`)
    return undefined
  }
  const str = (v: unknown, path: string): string | undefined => {
    if (v === undefined) return undefined
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
    warnings.push(`${path} must be a non-empty string; using default`)
    return undefined
  }
  if (isObj(user.subagents)) {
    const a = user.subagents
    const c = config.subagents
    c.enabled = bool(a.enabled, 'subagents.enabled') ?? c.enabled
    c.keepCallerModel = bool(a.keepCallerModel, 'subagents.keepCallerModel') ?? c.keepCallerModel
    c.allowUpgrade = bool(a.allowUpgrade, 'subagents.allowUpgrade') ?? c.allowUpgrade
    c.minConfidence = num(a.minConfidence, 'subagents.minConfidence', 0, 1) ?? c.minConfidence
    c.timeoutMs = num(a.timeoutMs, 'subagents.timeoutMs', 500, 30000) ?? c.timeoutMs
    c.openPane = bool(a.openPane, 'subagents.openPane') ?? c.openPane
    c.riskyToOpus = bool(a.riskyToOpus, 'subagents.riskyToOpus') ?? c.riskyToOpus
    c.riskyAt = num(a.riskyAt, 'subagents.riskyAt', 0, 1) ?? c.riskyAt
  } else if (user.subagents !== undefined) warnings.push('subagents must be an object; using default')
  if (isObj(user.savings)) {
    const v = user.savings
    config.savings.enabled = bool(v.enabled, 'savings.enabled') ?? config.savings.enabled
    config.savings.ledger = bool(v.ledger, 'savings.ledger') ?? config.savings.ledger
    config.savings.prices = mergePrices(v.prices, warnings)
  } else if (user.savings !== undefined) warnings.push('savings must be an object; using default')
  if (isObj(user.handoff)) {
    const h = user.handoff
    const c = config.handoff
    c.enabled = bool(h.enabled, 'handoff.enabled') ?? c.enabled
    c.autoAtTokens = num(h.autoAtTokens, 'handoff.autoAtTokens', 0, 10_000_000) ?? c.autoAtTokens
    c.warnAtTokens = num(h.warnAtTokens, 'handoff.warnAtTokens', 0, 10_000_000) ?? c.warnAtTokens
    c.model = str(h.model, 'handoff.model') ?? c.model
    if (isEffort(h.effort)) c.effort = h.effort
    else if (h.effort !== undefined) warnings.push(`handoff.effort must be one of ${EFFORTS.join(', ')}; using default`)
    c.maxTokens = num(h.maxTokens, 'handoff.maxTokens', 500, 64000) ?? c.maxTokens
    c.timeoutMs = num(h.timeoutMs, 'handoff.timeoutMs', 10000, 900000) ?? c.timeoutMs
    c.maxInputChars = num(h.maxInputChars, 'handoff.maxInputChars', 20000, 4_000_000) ?? c.maxInputChars
    c.saveToFile = bool(h.saveToFile, 'handoff.saveToFile') ?? c.saveToFile
  } else if (user.handoff !== undefined) warnings.push('handoff must be an object; using default')
  if (isObj(user.cacheClock)) {
    const k = user.cacheClock
    const c = config.cacheClock
    c.enabled = bool(k.enabled, 'cacheClock.enabled') ?? c.enabled
    c.ttlMinutes = num(k.ttlMinutes, 'cacheClock.ttlMinutes', 0, 1440) ?? c.ttlMinutes
    c.pingLeadSeconds = num(k.pingLeadSeconds, 'cacheClock.pingLeadSeconds', 5, 600) ?? c.pingLeadSeconds
    c.maxPings = num(k.maxPings, 'cacheClock.maxPings', 0, 100) ?? c.maxPings
    c.autoStartMinTokens = num(k.autoStartMinTokens, 'cacheClock.autoStartMinTokens', 0, 10_000_000) ?? c.autoStartMinTokens
    c.maxMinutes = num(k.maxMinutes, 'cacheClock.maxMinutes', 1, 1440) ?? c.maxMinutes
  } else if (user.cacheClock !== undefined) warnings.push('cacheClock must be an object; using default')
  if (isObj(user.escalation)) {
    const x = user.escalation
    if (typeof x.enabled === 'boolean') config.escalation.enabled = x.enabled
    else if (x.enabled !== undefined) warnings.push('escalation.enabled must be true or false; using default')
    config.escalation.raiseEffortUpTo = perTier(x.raiseEffortUpTo, 'escalation.raiseEffortUpTo', config.escalation.raiseEffortUpTo)
    config.escalation.feedbackKeywords = strs(x.feedbackKeywords, 'escalation.feedbackKeywords') ?? config.escalation.feedbackKeywords
    config.escalation.feedbackMaxWords = num(x.feedbackMaxWords, 'escalation.feedbackMaxWords', 0, 1000) ?? config.escalation.feedbackMaxWords
    config.escalation.testCommandPatterns = strs(x.testCommandPatterns, 'escalation.testCommandPatterns') ?? config.escalation.testCommandPatterns
    config.escalation.failurePatterns = strs(x.failurePatterns, 'escalation.failurePatterns') ?? config.escalation.failurePatterns
  }

  return { config, warnings }
}

// ---------------------------------------------------------------------------
// Prompt analysis.

export type HistoryEntry = { score: number; type: TaskType }

export type Analysis = {
  /** The prompt's own score, 0-100. */
  ownScore: number
  /** The score after blending in recent conversation, 0-100. */
  score: number
  type: TaskType
  complexity: 'low' | 'medium' | 'high'
  output: OutputSize
  isFollowUp: boolean
  /** True once a classifier verdict has set the score: the classifier has judged the work, so no uncertainty bump. */
  classified?: boolean
  /** How many keyword and structure signals the prompt itself gave; 0 means the analysis is guessing. */
  signals: number
  words: number
  /** The tier the score maps to, before stickiness. */
  tier: Tier
  /** Short reason, for the status line and the manual-mode dialog. */
  reason: string
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n))

/** Whole-word-ish match: keywords match at word starts, so "api" does not match "capital". */
function countMatches(text: string, keywords: readonly string[]): number {
  let hits = 0
  for (const k of keywords) {
    if (!k) continue
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(^|[^a-z0-9])${escaped}`, 'i').test(text)) hits++
  }
  return hits
}

const wordCount = (text: string) => (text.trim() === '' ? 0 : text.trim().split(/\s+/).length)

export function tierForScore(score: number, cfg: RouterConfig): Tier {
  if (score < cfg.thresholds.haikuMax) return 'haiku'
  if (score >= cfg.thresholds.opusMin) return 'opus'
  return 'sonnet'
}

export function analyse(prompt: string, history: readonly HistoryEntry[], cfg: RouterConfig): Analysis {
  const text = prompt.toLowerCase().replace(/\r\n?/g, '\n')
  const words = wordCount(text)

  // Length: a rough proxy for how much the task asks.
  let score = words < 8 ? 8 : words < 30 ? 18 : words < 120 ? 30 : words < 400 ? 42 : 52

  // Task type: the group with the largest weighted pull wins; every group still adds.
  let type: TaskType = 'general'
  let best = 0
  let signals = 0
  for (const [name, g] of Object.entries(cfg.taskTypes) as [Exclude<TaskType, 'general'>, KeywordGroup][]) {
    const hits = countMatches(text, g.keywords)
    if (hits === 0) continue
    signals += hits
    // Diminishing returns: first hit counts fully, later ones half.
    score += g.weight * (1 + (hits - 1) * 0.5)
    const pull = Math.abs(g.weight) * hits
    if (pull > best) {
      best = pull
      type = name
    }
  }

  const boosts = countMatches(text, cfg.complexityBoosters.keywords)
  score += Math.min(3, boosts) * cfg.complexityBoosters.weight
  const simple = countMatches(text, cfg.simplifiers.keywords)
  score += Math.min(2, simple) * cfg.simplifiers.weight
  signals += boosts + simple

  // Structure: code blocks, stack-trace lines, file paths and enumerated requirements.
  // Together they add at most `scoring.structureCap`, so a long bulleted spec cannot
  // stack four separate maxima into a 100.
  const codeBlocks = Math.floor((text.match(/```/g) ?? []).length / 2)
  let structure = 0
  if (codeBlocks > 0) structure += 8 + Math.min(2, codeBlocks - 1) * 3
  if (/^\s+at .+\(.+:\d+/m.test(text) || /traceback \(most recent call last\)/.test(text)) structure += 8
  const files = (text.match(/[\w-]+\.(tsx?|jsx?|py|go|rs|java|kt|cs|cpp|c|h|rb|php|sql|ya?ml|json|md)\b/g) ?? []).length
  structure += Math.min(15, files * 3)
  const listItems = (text.match(/^\s*(?:[-*]|\d+[.)])\s+/gm) ?? []).length
  structure += Math.min(20, listItems * 2)
  score += Math.min(cfg.scoring.structureCap, structure)
  signals += (codeBlocks > 0 ? 1 : 0) + (files > 0 ? 1 : 0) + (listItems > 0 ? 1 : 0)

  const ownScore = Math.round(clamp(score))

  // Context: a short prompt that leans on earlier turns is judged with them.
  // Time is deliberately ignored: a follow-up after a long pause is still a follow-up.
  const isFollowUp =
    history.length > 0 &&
    words <= cfg.context.followUpMaxWords &&
    (countMatches(text, cfg.context.followUpKeywords) > 0 || words <= 4)
  const recent = history.slice(-cfg.context.historySize)
  let blended = ownScore
  if (recent.length > 0) {
    // Most recent weighs most (decay 0.6 per step back).
    let sum = 0
    let wsum = 0
    recent.forEach((h, i) => {
      const w = Math.pow(0.6, recent.length - 1 - i)
      sum += h.score * w
      wsum += w
    })
    const ctx = sum / wsum
    const w = isFollowUp ? cfg.context.followUpWeight : cfg.context.weight
    blended = ownScore * (1 - w) + ctx * w
    if (isFollowUp && type === 'general') type = recent[recent.length - 1]?.type ?? type
  }
  // A build, code or writing request is capped below the xhigh band unless it reads as
  // architecture or debugging: a long spec for a simple app is not a hard problem.
  const ceiling = cfg.scoring.taskCeilings[type as keyof typeof cfg.scoring.taskCeilings]
  const finalScore = Math.round(clamp(ceiling === undefined ? blended : Math.min(blended, ceiling)))

  const output: OutputSize =
    countMatches(text, cfg.largeOutputKeywords) >= 2 || finalScore >= cfg.thresholds.opusMin
      ? 'large'
      : finalScore < cfg.thresholds.haikuMax && type !== 'code'
        ? 'small'
        : 'medium'
  const complexity = finalScore >= cfg.thresholds.opusMin ? 'high' : finalScore < cfg.thresholds.haikuMax ? 'low' : 'medium'
  const tier = tierForScore(finalScore, cfg)

  const bits = [`${type}`, `${complexity} complexity`, `${output} output`]
  if (isFollowUp) bits.push('follow-up')
  return {
    ownScore,
    score: finalScore,
    type,
    complexity,
    output,
    isFollowUp,
    signals,
    words,
    tier,
    reason: `${bits.join(', ')} (score ${finalScore})`,
  }
}

// ---------------------------------------------------------------------------
// Stickiness.

export type Decision = {
  /** The tier the score maps to. */
  recommended: Tier
  /** The tier to run on after stickiness: either `current` or `recommended`. */
  target: Tier
  /** True when `target` differs from `current`. */
  isSwitch: boolean
  /** Why a recommended switch was held back, when it was. */
  heldBecause?: string
}

const tierIndex = (t: Tier) => TIERS.indexOf(t)

/**
 * Applies hysteresis: leave the current tier only when the score clears the
 * boundary by `switchMargin`, and not within `minPromptsBetweenSwitches` of
 * the last switch unless the jump spans two tiers.
 */
export function decide(
  analysis: Pick<Analysis, 'score' | 'tier'>,
  current: Tier,
  promptsSinceSwitch: number,
  cfg: RouterConfig,
): Decision {
  const recommended = analysis.tier
  if (recommended === current) return { recommended, target: current, isSwitch: false }

  const { haikuMax, opusMin, switchMargin, minPromptsBetweenSwitches } = cfg.thresholds
  const up = tierIndex(recommended) > tierIndex(current)
  // The boundary crossed when leaving `current` in that direction.
  const boundary = up ? (current === 'haiku' ? haikuMax : opusMin) : current === 'opus' ? opusMin : haikuMax
  const clearance = up ? analysis.score - boundary : boundary - 1 - analysis.score
  if (clearance < switchMargin) {
    return {
      recommended,
      target: current,
      isSwitch: false,
      heldBecause: `score ${analysis.score} is within ${switchMargin} of the ${current} boundary`,
    }
  }
  const bigJump = Math.abs(tierIndex(recommended) - tierIndex(current)) >= 2
  if (!bigJump && promptsSinceSwitch < minPromptsBetweenSwitches) {
    return {
      recommended,
      target: current,
      isSwitch: false,
      heldBecause: `switched ${promptsSinceSwitch} prompt(s) ago; waiting ${minPromptsBetweenSwitches}`,
    }
  }
  return { recommended, target: recommended, isSwitch: true }
}

// ---------------------------------------------------------------------------
// Models and commands.

/** Maps any model string (alias or full id) to a tier, or undefined (e.g. a non-Claude model). */
export function tierOf(model: string | undefined, cfg: RouterConfig = DEFAULT_CONFIG): Tier | undefined {
  if (!model) return undefined
  const m = model.toLowerCase()
  for (const t of TIERS) if (cfg.models[t].toLowerCase() === m) return t
  for (const t of TIERS) if (m.includes(t)) return t
  return undefined
}

// ---------------------------------------------------------------------------
// Effort: chosen with the model as one decision.

const effortIndex = (e: Effort) => EFFORTS.indexOf(e)
const higher = (a: Effort, b: Effort): Effort => (effortIndex(a) >= effortIndex(b) ? a : b)
const lower = (a: Effort, b: Effort): Effort => (effortIndex(a) <= effortIndex(b) ? a : b)

/** The band level for a score on a model, before uncertainty and caps. */
export function bandEffort(tier: Tier, score: number, cfg: RouterConfig): Effort {
  const bands = cfg.effort.bands[tier]
  let level: Effort = bands[0]?.level ?? 'medium'
  for (const b of bands) if (score >= b.from) level = b.level
  return level
}

/** The lowest and highest level the router picks on a model. */
export function effortRange(tier: Tier, cfg: RouterConfig): [Effort, Effort] {
  const levels = cfg.effort.bands[tier].map(b => b.level)
  const min = levels.reduce(lower, levels[0] ?? 'medium')
  return [min, higher(min, cfg.effort.maxLevel[tier])]
}

/**
 * Whether the analysis is unsure: the prompt gave no signals to go on, or its
 * score sits just under a model or effort boundary. Quality first: unsure means more effort.
 */
export function isUncertain(a: Pick<Analysis, 'score' | 'signals' | 'isFollowUp' | 'words' | 'classified'>, tier: Tier, cfg: RouterConfig): boolean {
  if (a.classified) return false
  if (a.signals === 0 && !a.isFollowUp && a.words >= 6) return true
  const m = cfg.effort.uncertaintyMargin
  const boundaries = [cfg.thresholds.haikuMax, cfg.thresholds.opusMin, ...cfg.effort.bands[tier].map(b => b.from)]
  return boundaries.some(b => a.score < b && b - a.score <= m)
}

/** The recommended effort for a prompt on a model. */
export function recommendEffort(
  a: Pick<Analysis, 'score' | 'ownScore' | 'signals' | 'isFollowUp' | 'words' | 'classified'>,
  tier: Tier,
  cfg: RouterConfig,
): { effort: Effort; uncertain: boolean } {
  const uncertain = isUncertain(a, tier, cfg)
  const [min, max] = effortRange(tier, cfg)
  let e = bandEffort(tier, a.score, cfg)
  if (uncertain) e = EFFORTS[effortIndex(e) + 1] ?? e
  // Low effort only for clearly simple tasks.
  if (e === 'low' && (uncertain || a.ownScore > cfg.effort.lowMaxScore)) e = 'medium'
  e = lower(higher(e, min), max)
  return { effort: e, uncertain }
}

export type EffortDecision = { recommended: Effort; target: Effort; isSwitch: boolean; heldBecause?: string }

/**
 * Stickiness for effort: changing effort rewrites the prompt cache like a model
 * switch, so it changes only when the score clears the boundary by
 * `effort.switchMargin` and the cool-down has passed (a two-level jump skips it).
 * After a model switch the cache is new anyway, so the recommendation applies.
 */
export function decideEffort(
  a: Pick<Analysis, 'score' | 'ownScore' | 'signals' | 'isFollowUp' | 'words' | 'classified'>,
  tier: Tier,
  current: Effort | null,
  promptsSinceEffortSwitch: number,
  modelSwitched: boolean,
  cfg: RouterConfig,
): EffortDecision {
  const { effort: recommended } = recommendEffort(a, tier, cfg)
  if (current === null || modelSwitched) return { recommended, target: recommended, isSwitch: current !== recommended }
  if (recommended === current) return { recommended, target: current, isSwitch: false }
  const up = effortIndex(recommended) > effortIndex(current)
  const m = cfg.effort.switchMargin
  // Clearance is judged on the bands alone, so an uncertainty bump cannot defeat stickiness.
  const shifted = bandEffort(tier, Math.max(0, Math.min(100, a.score + (up ? -m : m))), cfg)
  const clear = up ? effortIndex(shifted) > effortIndex(current) : effortIndex(shifted) < effortIndex(current)
  if (!clear) {
    return { recommended, target: current, isSwitch: false, heldBecause: `score ${a.score} is within ${m} of the ${current}-effort boundary` }
  }
  const bigJump = Math.abs(effortIndex(recommended) - effortIndex(current)) >= 2
  if (!bigJump && promptsSinceEffortSwitch < cfg.thresholds.minPromptsBetweenSwitches) {
    return {
      recommended,
      target: current,
      isSwitch: false,
      heldBecause: `effort changed ${promptsSinceEffortSwitch} prompt(s) ago; waiting ${cfg.thresholds.minPromptsBetweenSwitches}`,
    }
  }
  return { recommended, target: recommended, isSwitch: true }
}

/** Orders combos by capability: the model first, then effort. */
export const comboRank = (c: Combo) => tierIndex(c.tier) * 10 + effortIndex(c.effort)
export const maxCombo = (a: Combo, b: Combo): Combo => (comboRank(b) > comboRank(a) ? b : a)
export const sameCombo = (a: Combo | null, b: Combo | null) => a !== null && b !== null && a.tier === b.tier && a.effort === b.effort

/**
 * One step up after a failure: more effort on the same model up to
 * `escalation.raiseEffortUpTo`, then the next model at no less than high effort.
 * `lockedTier` keeps the model and raises effort only. Null at the top.
 */
export function escalate(from: Combo, cfg: RouterConfig, lockedTier?: Tier): Combo | null {
  const cap = lockedTier ? 'max' : cfg.escalation.raiseEffortUpTo[from.tier]
  const nextEffort = EFFORTS[effortIndex(from.effort) + 1]
  if (nextEffort && effortIndex(from.effort) < effortIndex(cap)) return { tier: from.tier, effort: nextEffort }
  if (lockedTier) return null
  const nextTier = TIERS[tierIndex(from.tier) + 1]
  if (!nextTier) return null
  const [min, max] = effortRange(nextTier, cfg)
  return { tier: nextTier, effort: lower(higher(higher(from.effort, 'high'), min), higher(max, 'high')) }
}

/** True when a short prompt says the last result was poor. */
export function isNegativeFeedback(prompt: string, cfg: RouterConfig): boolean {
  if (!cfg.escalation.enabled) return false
  const text = prompt.toLowerCase()
  return wordCount(text) <= cfg.escalation.feedbackMaxWords && countMatches(text, cfg.escalation.feedbackKeywords) > 0
}

/** True when a Bash run looks like a test or build run. */
export function isTestCommand(command: string, cfg: RouterConfig): boolean {
  return countMatches(command.toLowerCase(), cfg.escalation.testCommandPatterns) > 0
}

/** True when a test or build run failed: it errored, or its output reports failures (not "0 failed"). */
export function runFailed(isError: boolean, output: string, cfg: RouterConfig): boolean {
  if (isError) return true
  const text = output.toLowerCase().replace(/\b0 (failed|failing|failures?|errors?)\b/g, '')
  return cfg.escalation.failurePatterns.some(p => p !== '' && text.includes(p))
}

export const formatCombo = (c: { tier: Tier; effort: Effort | null }) =>
  `${c.tier.charAt(0).toUpperCase()}${c.tier.slice(1)} · ${c.effort ?? 'default'}`

/** Reads "opus high", "Sonnet · medium (recommended)", "high" etc. Missing parts stay undefined. */
export function parseCombo(text: string): { tier?: Tier; effort?: Effort } {
  const lower_ = text.toLowerCase()
  const tier = TIERS.find(t => new RegExp(`\\b${t}\\b`).test(lower_))
  // Check longer names first so "xhigh" is not read as "high".
  const effort = (['xhigh', 'max', 'medium', 'high', 'low'] as Effort[]).find(e => new RegExp(`\\b${e}\\b`).test(lower_))
  return { tier, effort }
}

export type RouteCommand =
  | { kind: 'mode'; mode: Exclude<Mode, 'lock'> }
  | { kind: 'lock'; model: Tier }
  | { kind: 'next'; tier?: Tier; effort?: Effort }
  | { kind: 'next-clear' }
  | { kind: 'effort-auto' }
  | { kind: 'effort-lock'; level: Effort }
  | { kind: 'status' }
  | { kind: 'reload' }
  | { kind: 'log'; enabled: boolean }
  | { kind: 'feature'; feature: 'agents' | 'handoff' | 'clock'; enabled?: boolean }
  | { kind: 'warm'; enabled?: boolean }
  | { kind: 'resume' }
  | { kind: 'savings'; reset?: boolean }
  | { kind: 'help' }
  | { kind: 'error'; message: string }

export function parseRouteCommand(args: string, cfg: RouterConfig = DEFAULT_CONFIG): RouteCommand {
  const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const [head, arg, arg2] = parts
  switch (head) {
    case undefined:
    case 'status':
      return { kind: 'status' }
    case 'auto':
    case 'recommend':
    case 'manual':
    case 'off':
      return { kind: 'mode', mode: head }
    case 'lock': {
      if (arg === undefined) return { kind: 'lock', model: cfg.defaultLockModel }
      const t = tierOf(arg, cfg)
      return t && TIERS.includes(arg as Tier)
        ? { kind: 'lock', model: t }
        : { kind: 'error', message: `Unknown model "${arg}". Use one of: ${TIERS.join(', ')}.` }
    }
    case 'next': {
      if (arg === 'clear' || arg === 'cancel') return { kind: 'next-clear' }
      const rest = parts.slice(1)
      if (rest.length === 0 || rest.length > 2) {
        return { kind: 'error', message: 'Use /route next <haiku|sonnet|opus> [low|medium|high|xhigh|max], /route next <effort>, or /route next clear.' }
      }
      let tier: Tier | undefined
      let effort: Effort | undefined
      for (const word of rest) {
        if ((TIERS as readonly string[]).includes(word) && !tier) tier = word as Tier
        else if (isEffort(word) && !effort) effort = word
        else return { kind: 'error', message: `"${word}" is not a model (${TIERS.join(', ')}) or an effort level (${EFFORTS.join(', ')}).` }
      }
      return { kind: 'next', tier, effort }
    }
    case 'effort':
      if (arg === undefined || arg === 'status') return { kind: 'status' }
      if (arg === 'auto') return { kind: 'effort-auto' }
      if (arg === 'lock') {
        if (arg2 === undefined) return { kind: 'effort-lock', level: cfg.effort.defaultLockLevel }
        return isEffort(arg2)
          ? { kind: 'effort-lock', level: arg2 }
          : { kind: 'error', message: `Unknown effort "${arg2}". Use one of: ${EFFORTS.join(', ')}.` }
      }
      return { kind: 'error', message: 'Use /route effort auto or /route effort lock <level>.' }
    case 'reload':
      return { kind: 'reload' }
    case 'resume':
      return { kind: 'resume' }
    case 'savings':
    case 'saved':
      if (arg === undefined || arg === 'show') return { kind: 'savings' }
      if (arg === 'reset') return { kind: 'savings', reset: true }
      return { kind: 'error', message: 'Use /route savings to show the Savings pane, or /route savings reset to start the all-time total again.' }
    case 'log':
      if (arg === 'on') return { kind: 'log', enabled: true }
      if (arg === 'off') return { kind: 'log', enabled: false }
      return { kind: 'error', message: 'Use /route log on or /route log off.' }
    case 'agents':
    case 'subagents':
    case 'handoff':
    case 'clock':
    case 'cache': {
      const feature = head === 'subagents' ? 'agents' : head === 'cache' ? 'clock' : head
      if (arg === undefined || arg === 'show' || arg === 'status') return { kind: 'feature', feature }
      if (arg === 'on' || arg === 'off') return { kind: 'feature', feature, enabled: arg === 'on' }
      return { kind: 'error', message: `Use /route ${head} on, /route ${head} off, or /route ${head} to show it.` }
    }
    case 'warm':
    case 'keepwarm': {
      if (arg === undefined || arg === 'show' || arg === 'status') return { kind: 'warm' }
      if (arg === 'on' || arg === 'off') return { kind: 'warm', enabled: arg === 'on' }
      return { kind: 'error', message: `Use /route ${head} on, /route ${head} off, or /route ${head} to show it.` }
    }
    case 'help':
      return { kind: 'help' }
    default:
      return { kind: 'error', message: `Unknown option "${head}". Try /route help.` }
  }
}

export const HELP_TEXT = [
  'Model router — picks Haiku, Sonnet or Opus and an effort level for each prompt.',
  '',
  '  /route                       show status',
  '  /route auto                  analyse and apply model + effort automatically',
  '  /route recommend             analyse, then you accept or change (one click)',
  '  /route manual                no analysis; you choose (session model, next, effort lock)',
  '  /route off                   stop routing; use the session model and effort',
  '  /route lock <model>          always use haiku, sonnet or opus (router picks effort)',
  '  /route next <model> [effort] use these for the next prompt only, e.g. /route next opus high',
  '  /route next <effort>         next prompt only, effort alone; /route next clear cancels',
  '  /route effort auto           router picks the effort level',
  '  /route effort lock <level>   always use low, medium, high, xhigh or max',
  '  /route log on|off            turn the decision log on or off',
  '  /route reload                re-read the config file',
  '  /route resume                let the router choose again after you picked a model or effort yourself',
  '  /route agents [on|off]       subagent model router: show its pane, or turn it on/off',
  '  /route handoff [on|off]      automatic handoff for long chats; /handoff writes one now',
  '  /route clock [on|off]        cache clock: countdown to when the chat cache goes cold',
  '  /route warm [on|off]         Keep warm: follows the session you type in, stops in ones you left',
  '  /route savings [reset]       what the router saved, this session and all time'
].join('\n')

export type StatusInput = {
  mode: Mode
  /** What runs now (after locks), or null for the session's own. */
  current: { tier: Tier | null; effort: Effort | null }
  base: string
  effortMode: EffortMode
  last?: { recommended: Combo; reason: string; heldBecause?: string }
  next?: { tier?: Tier; effort?: Effort }
  /** Pending escalation: auto shows it as applied next, others as a suggestion. */
  escalation?: { reason: string; to: Combo | null }
}

export function statusLine(s: StatusInput): string {
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)
  const model = s.current.tier ? cap(s.current.tier) : s.base
  const now = `${model} · ${s.current.effort ?? 'default'}${s.effortMode === 'lock' ? ' (effort locked)' : ''}`
  const head =
    s.mode === 'off'
      ? `Router off · ${s.base}`
      : s.mode === 'lock'
        ? `Router locked · ${now}`
        : `Router ${s.mode} · ${now}${s.current.tier && tierOf(s.base) !== s.current.tier ? ` (base ${s.base})` : ''}`
  const parts = [head]
  if ((s.mode === 'auto' || s.mode === 'recommend' || s.mode === 'lock') && s.last) {
    const held = s.last.heldBecause && !sameCombo(s.last.recommended, { tier: s.current.tier ?? s.last.recommended.tier, effort: s.current.effort ?? s.last.recommended.effort }) ? ' · held' : ''
    parts.push(`rec ${formatCombo(s.last.recommended)}${held}`, s.last.reason)
  }
  if (s.next) parts.push(`next: ${s.next.tier ? cap(s.next.tier) : model} · ${s.next.effort ?? 'same'}`)
  if (s.escalation) {
    const to = s.escalation.to ? formatCombo(s.escalation.to) : 'already at the top'
    parts.push(s.mode === 'auto' || s.mode === 'lock' ? `escalating to ${to} (${s.escalation.reason})` : `suggest ${to} (${s.escalation.reason})`)
  }
  return parts.join(' · ')
}

// ---------------------------------------------------------------------------
// Classifier verdict: a small model reads the message with the last exchange.

export type Complexity = 'simple' | 'moderate' | 'complex' | 'architecture'
export type Sentiment = 'approve' | 'neutral' | 'negative'
export type Verdict = { complexity: Complexity; sentiment: Sentiment; isFeedback: boolean }
export const COMPLEXITIES: readonly Complexity[] = ['simple', 'moderate', 'complex', 'architecture']
export const SENTIMENTS: readonly Sentiment[] = ['approve', 'neutral', 'negative']

/** Reads the classifier's JSON reply. Anything unexpected is null, and the rules decide alone. */
export function parseVerdict(text: string): Verdict | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  let raw: unknown
  try {
    raw = JSON.parse(m[0])
  } catch {
    return null
  }
  if (!isObj(raw)) return null
  const { complexity, sentiment, isFeedback } = raw
  if (!COMPLEXITIES.includes(complexity as Complexity)) return null
  if (!SENTIMENTS.includes(sentiment as Sentiment)) return null
  if (typeof isFeedback !== 'boolean') return null
  return { complexity: complexity as Complexity, sentiment: sentiment as Sentiment, isFeedback }
}

/**
 * Applies a verdict to the rules' analysis.
 * - Feedback on the last task: the task's score carries over, and negative feedback
 *   raises it by `classifier.negativeBump`, so repeated complaints keep climbing.
 * - A new task: the rules' score held inside the band for the classifier's complexity,
 *   still under the task type's ceiling.
 */
export function applyVerdict(a: Analysis, v: Verdict, memory: { taskScore: number | null }, cfg: RouterConfig): Analysis {
  const c = cfg.classifier
  let score: number
  let reason: string
  if (v.isFeedback && memory.taskScore !== null) {
    const bump = v.sentiment === 'negative' ? c.negativeBump : 0
    score = Math.round(clamp(memory.taskScore + bump))
    reason = bump > 0 ? `feedback: last result was not right, +${bump} on ${memory.taskScore}` : `feedback on the last task (${memory.taskScore})`
  } else {
    const band = c.bands[v.complexity]
    score = Math.min(band.max, Math.max(band.min, a.score))
    const ceiling = cfg.scoring.taskCeilings[a.type]
    if (ceiling !== undefined) score = Math.min(score, ceiling)
    score = Math.round(clamp(score))
    reason = `${v.complexity} task (classifier), ${a.reason}`
  }
  return {
    ...a,
    score,
    tier: tierForScore(score, cfg),
    complexity: score >= cfg.thresholds.opusMin ? 'high' : score < cfg.thresholds.haikuMax ? 'low' : 'medium',
    classified: true,
    reason,
  }
}

