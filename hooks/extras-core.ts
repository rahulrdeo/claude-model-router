// Pure logic for the subagent router, the handoff and the cache clock.
// No engine calls, no I/O: deterministic and unit-tested.

import { TIERS, tierOf, type RouterConfig, type Tier } from './router-core'

// ---------------------------------------------------------------------------
// Subagent model router.

export type AgentPick = { tier: Tier; confidence: number; reason: string; risk: number | null }

export const AGENT_PICK_SYSTEM = `You choose the cheapest Claude model that will still do a subagent's task well. The task was written by a coding assistant for a helper agent. Reply with JSON only, no other text: {"tier":"haiku|sonnet|opus","confidence":0.0-1.0,"risk":0.0-1.0,"reason":"at most 12 words"}
haiku: a simple lookup. Find files or symbols, grep, read and report what is there, list things, answer a factual question, summarise a short file. No judgement calls.
sonnet: a well-defined job. Implement or fix something that is clearly specified, write tests, review a diff against stated criteria, a focused multi-step search or investigation.
opus: a hard job. Open-ended design or architecture, subtle or unexplained bugs, research that needs judgement across many sources, large refactors, security review, anything ambiguous or high-stakes.
confidence: how sure you are that this tier is right (1.0 = certain). When torn between two tiers, pick the higher one with lower confidence.
risk: how much harm a subtle mistake in this task could do, whatever its difficulty. 0.0: read-only, easy to check or redo. 0.5: changes code that tests will check. 0.8 and above: could lose or corrupt data, touch production, credentials, payments, security, database migrations or deletions, or act in a way that cannot be undone.`

/** Builds the classifier prompt for one subagent task. The task is cut to keep the call small. */
export function agentPickPrompt(task: { description: string; subagentType: string; prompt: string }, maxChars = 6000): string {
  const body = task.prompt.length > maxChars ? `${task.prompt.slice(0, maxChars)}\n[... ${task.prompt.length - maxChars} more characters]` : task.prompt
  return [`Agent type: ${task.subagentType || 'general-purpose'}`, `Short description: ${task.description || '(none)'}`, `Task:\n${body}`].join('\n\n')
}

/** Reads the classifier's JSON reply. Anything unexpected is null: the subagent keeps the parent's model. */
export function parseAgentPick(text: string): AgentPick | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  let raw: unknown
  try {
    raw = JSON.parse(m[0])
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const tier = typeof r.tier === 'string' ? r.tier.toLowerCase().trim() : ''
  if (!(TIERS as readonly string[]).includes(tier)) return null
  let confidence = typeof r.confidence === 'number' ? r.confidence : typeof r.confidence === 'string' ? Number.parseFloat(r.confidence) : Number.NaN
  if (!Number.isFinite(confidence)) return null
  // Some replies give a percentage.
  if (confidence > 1 && confidence <= 100) confidence /= 100
  confidence = Math.min(1, Math.max(0, confidence))
  const reason = typeof r.reason === 'string' ? r.reason.trim().slice(0, 160) : ''
  // Risk is optional: an answer without a readable one counts as no risk rating, never as risky.
  let risk = typeof r.risk === 'number' ? r.risk : typeof r.risk === 'string' ? Number.parseFloat(r.risk) : Number.NaN
  if (risk > 1 && risk <= 100) risk /= 100
  return { tier: tier as Tier, confidence, reason, risk: Number.isFinite(risk) && risk >= 0 && risk <= 1 ? risk : null }
}

export type AgentDecision = {
  /** The tier the subagent runs on; null when it keeps the parent's (no rewrite). */
  tier: Tier | null
  /** What to send as the Agent call's model; undefined = leave the call as it is. */
  model: string | undefined
  /** Why, in a few words, for the pane and the log. */
  note: string
  /** True when the risk rule decided. */
  risky: boolean
}

const rank = (t: Tier) => TIERS.indexOf(t)

/**
 * Turns a pick into the subagent's model. Low confidence or no answer keeps the
 * parent's model; a pick above the parent's is held at the parent's unless
 * `allowUpgrade` (subagents only ever get cheaper by default).
 */
export function decideAgentModel(pick: AgentPick | null, parentModel: string, cfg: RouterConfig): AgentDecision {
  const parent = tierOf(parentModel, cfg) ?? null
  if (pick === null) return { tier: null, model: undefined, note: 'no usable answer from the classifier; parent model kept', risky: false }
  // Risky work goes to Opus whatever the tier, the confidence or the upgrade setting: a wrong
  // cheap answer here costs more than the stronger model does.
  if (cfg.subagents.riskyToOpus && pick.risk !== null && pick.risk >= cfg.subagents.riskyAt) {
    const note = `risky (${pct(pick.risk)}): Opus`
    return parent === 'opus' ? { tier: 'opus', model: undefined, note: `${note}, as the parent`, risky: true } : { tier: 'opus', model: cfg.models.opus, note, risky: true }
  }
  if (pick.confidence < cfg.subagents.minConfidence) {
    return { tier: null, model: undefined, note: `unsure (${pct(pick.confidence)} < ${pct(cfg.subagents.minConfidence)}); parent model kept`, risky: false }
  }
  let tier = pick.tier
  let note = 'routed'
  if (parent !== null && rank(tier) > rank(parent) && !cfg.subagents.allowUpgrade) {
    tier = parent
    note = `capped at the parent's ${cap(parent)}`
  }
  if (parent !== null && tier === parent) return { tier: parent, model: undefined, note: note === 'routed' ? 'same as the parent' : note, risky: false }
  return { tier, model: cfg.models[tier], note, risky: false }
}

export const pct = (c: number) => `${Math.round(c * 100)}%`
export const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)

// ---------------------------------------------------------------------------
// Handoff.

export const HANDOFF_SYSTEM = `You write handoff prompts. You are given the transcript of a long working session between a person and an AI coding assistant. Write the prompt the person will paste as the FIRST message of a brand-new chat, so a fresh assistant with no memory of this one can carry on without losing anything that matters.

Write it in the second person, to the new assistant, in Markdown, with these sections:
1. Goal: what the person is ultimately trying to achieve, in their terms.
2. Current state: what has been done and works, with file paths, commands, branch names, versions and URLs exactly as they appear.
3. Decisions and constraints: choices made and why, the person's stated preferences, things they rejected, rules to follow.
4. Open problems: what is unfinished, failing or uncertain, with the exact error messages that matter.
5. Next steps: an ordered list of what to do next, starting with the very next action.
6. Key context: short code excerpts, data, names or numbers the new assistant will need and could not easily rediscover.

Be detailed and specific; prefer exact identifiers over paraphrase. Leave out chit-chat, dead ends that no longer matter, and anything secret (keys, tokens, passwords). Output only the handoff prompt itself, nothing before or after it.`

export type TranscriptMessage = {
  role: 'user' | 'assistant'
  text: string
  toolUses?: readonly { name?: string; tool?: string; input?: unknown; text?: string; isError?: boolean }[]
  toolResults?: readonly { text?: string; isError?: boolean }[]
}

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - 40))}\n[... ${s.length - max + 40} characters trimmed]`)

function inputSummary(input: unknown, max: number): string {
  if (input === undefined || input === null) return ''
  try {
    return clip(typeof input === 'string' ? input : JSON.stringify(input), max)
  } catch {
    return ''
  }
}

/** One message as plain text, tool input and output held to `toolMax` characters each. */
function renderMessage(m: TranscriptMessage, toolMax: number): string {
  const parts: string[] = []
  if (m.text.trim()) parts.push(m.text.trim())
  for (const u of m.toolUses ?? []) {
    const name = u.name ?? u.tool ?? 'tool'
    const input = inputSummary(u.input, Math.min(toolMax, 1500))
    parts.push(`[tool call: ${name}${input ? ` ${input}` : ''}]`)
    if (u.text) parts.push(`[${u.isError ? 'tool error' : 'tool result'}: ${clip(u.text, toolMax)}]`)
  }
  // Results are usually shown on the tool use already; only add those that were not.
  if (!(m.toolUses ?? []).some(u => u.text)) {
    for (const r of m.toolResults ?? []) if (r.text) parts.push(`[${r.isError ? 'tool error' : 'tool result'}: ${clip(r.text, toolMax)}]`)
  }
  if (parts.length === 0) return ''
  return `### ${m.role === 'user' ? 'Person' : 'Assistant'}\n${parts.join('\n')}`
}

/**
 * The whole chat as text for the handoff helper, at most `maxChars`. Everything the person
 * and the assistant wrote is kept; long tool output is trimmed first (older output harder),
 * and only if that is not enough are messages from the middle left out, never the first
 * request or the latest exchanges.
 */
export function buildTranscript(messages: readonly TranscriptMessage[], maxChars: number): { text: string; omitted: number; trimmed: boolean } {
  const n = messages.length
  const recentFrom = Math.floor(n * 0.7)
  for (const [oldMax, newMax] of [[4000, 8000], [1200, 4000], [300, 1500], [120, 600], [0, 300]] as const) {
    const rendered = messages.map((m, i) => renderMessage(m, i >= recentFrom ? newMax : oldMax)).filter(Boolean)
    const text = rendered.join('\n\n')
    if (text.length <= maxChars) return { text, omitted: 0, trimmed: oldMax < 4000 }
  }
  // Still too long: keep the opening messages and as many of the latest as fit.
  const rendered = messages.map((m, i) => renderMessage(m, i >= recentFrom ? 300 : 0)).filter(Boolean)
  const head: string[] = []
  let used = 0
  for (const r of rendered.slice(0, 3)) {
    const piece = clip(r, Math.floor(maxChars * 0.15))
    head.push(piece)
    used += piece.length + 2
  }
  const tail: string[] = []
  for (let i = rendered.length - 1; i >= head.length; i--) {
    const r = rendered[i] as string
    if (used + r.length + 2 > maxChars - 200) break
    tail.unshift(r)
    used += r.length + 2
  }
  const omitted = rendered.length - head.length - tail.length
  const text = [...head, omitted > 0 ? `[... ${omitted} messages from the middle of the chat left out for length ...]` : '', ...tail].filter(Boolean).join('\n\n')
  return { text, omitted, trimmed: true }
}

export function handoffPrompt(transcript: string, info: { tokens?: number; cwd?: string; omitted: number }): string {
  return [
    info.cwd ? `Working directory: ${info.cwd}` : '',
    info.tokens ? `The chat is about ${Math.round(info.tokens / 1000)}k tokens long.` : '',
    info.omitted > 0 ? `Note: ${info.omitted} messages from the middle were left out for length.` : '',
    'Transcript (long tool output trimmed):',
    '<transcript>',
    transcript,
    '</transcript>',
    'Write the handoff prompt now.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** What the compaction before a "Start new chat" is told: the handoff that follows carries the context. */
export const HANDOFF_COMPACT_INSTRUCTIONS =
  'This conversation is being restarted from a detailed handoff prompt that will be added right after this summary and carries all the context. Write only one short sentence saying the earlier chat was replaced by that handoff. Do not summarise the conversation.'

/** The two messages a "Start new chat" leaves the conversation as. */
export function handoffMessages(handoff: string): { role: 'user' | 'assistant'; text: string; toolUses: [] }[] {
  return [
    {
      role: 'user',
      text: `This chat was restarted from a handoff written at the end of a long earlier chat. Treat it as the full context and carry on from its next steps.\n\n${handoff}`,
      toolUses: [],
    },
    { role: 'assistant', text: 'Understood. I have the handoff and will carry on from the next steps it lists.', toolUses: [] },
  ]
}

// ---------------------------------------------------------------------------
// Cache clock.

export type CacheTtl = '1h' | '5m'

/** The cache lifetime in ms: the configured one, else the best evidence, else five minutes. */
export function cacheTtlMs(cfg: RouterConfig, evidence: CacheTtl | null): number {
  const minutes = cfg.cacheClock.ttlMinutes > 0 ? cfg.cacheClock.ttlMinutes : evidence === '1h' ? 60 : 5
  return minutes * 60_000
}

/**
 * What a turn's first request says about the cache lifetime, from how long the chat sat idle
 * before it and what the cache still held. A chat idle past five minutes that is still read
 * from the cache can only have a one-hour entry; one that had to be written again had a
 * five-minute one. Anything else proves nothing (null). Only valid on the same model as the
 * last answer, since a cache entry belongs to one model.
 */
export function ttlEvidence(idleMs: number, usage: { cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | null | undefined): CacheTtl | null {
  if (!usage || idleMs < 5.5 * 60_000 || idleMs > 58 * 60_000) return null
  const read = usage.cache_read_input_tokens ?? 0
  const written = usage.cache_creation_input_tokens ?? 0
  if (read >= 2048 && read >= written) return '1h'
  if (written >= 2048 && read < written / 10) return '5m'
  return null
}

/** Whether a model request body asks for a one-hour cache entry. */
export function asksOneHourCache(body: string): boolean {
  return /"ttl"\s*:\s*"1h"/.test(body)
}

/** "4:05", "0:09", "1:02:00". */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export const formatTokens = (n: number | undefined) =>
  n === undefined ? 'the whole chat' : n >= 1000 ? `${Math.round(n / 1000)}k tokens` : `${n} tokens`

/** When the next keep-warm ping is due, or null when none should be scheduled. */
export function nextPingAt(expiresAt: number, pings: number, cfg: RouterConfig): number | null {
  if (pings >= cfg.cacheClock.maxPings) return null
  return expiresAt - cfg.cacheClock.pingLeadSeconds * 1000
}

/** Whether Keep warm should start by itself after a reply: only for chats big enough to matter. */
export function shouldAutoWarm(tokens: number | undefined, cfg: RouterConfig): boolean {
  return tokens !== undefined && tokens >= cfg.cacheClock.autoStartMinTokens
}

export const KEEP_WARM_PROMPT =
  'Cache keep-alive ping from the model-router mod. You have no tools. Reply with the single word OK and nothing else, straight away, without thinking it over.'

// ---------------------------------------------------------------------------
// Secrets: blanked out of what the handoff helper reads and of what it writes.

const SECRET_PATTERNS: readonly { kind: string; re: RegExp; keep?: number }[] = [
  { kind: 'private key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { kind: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { kind: 'API key', re: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'AWS key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g },
  { kind: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: 'Google key', re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { kind: 'Stripe key', re: /\b[rsp]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // Credentials inside a URL: keep the user and host, blank the password.
  { kind: 'URL password', re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]{3,}(?=@)/gi, keep: 1 },
  { kind: 'bearer token', re: /(\bBearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g, keep: 1 },
  // key = value / "key": "value" for names that usually hold a secret.
  {
    kind: 'secret value',
    // A name may end a longer one (DB_PASSWORD, GITHUB_TOKEN-style names are covered by suffix).
    re: /((?<![A-Za-z0-9])(?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|private[_-]?key)["']?\s*[:=]\s*["']?)(?!\[redacted)[^\s"'`,;]{6,}/gi,
    keep: 1,
  },
]

/** Blanks known secret formats. Returns the text and how many were blanked. */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0
  let out = text
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p.re, (...m: unknown[]) => {
      count += 1
      const kept = p.keep ? String(m[1] ?? '') : ''
      return `${kept}[redacted ${p.kind}]`
    })
  }
  return { text: out, count }
}

// ---------------------------------------------------------------------------
// A new chat in the Claude desktop app, typed in with the handoff.

const NEW_CHAT = 'claude://code/new'

/**
 * The link that opens a new desktop-app chat with `text` typed in. When the whole handoff
 * would make the link longer than `maxLength` (Windows caps a command line), the chat gets
 * a short opening that points to the saved file instead, plus as much of the handoff as fits.
 */
export function newChatLink(text: string, opts: { cwd?: string; file?: string; maxLength: number }): { url: string; isWhole: boolean } {
  const folder = opts.cwd ? `&folder=${encodeURIComponent(opts.cwd)}` : ''
  const make = (q: string) => `${NEW_CHAT}?q=${encodeURIComponent(q)}${folder}`
  const whole = make(text)
  if (whole.length <= opts.maxLength) return { url: whole, isWhole: true }
  const lead = opts.file
    ? `Carry on from the handoff of a long earlier chat. Read ${opts.file} first: it is the full handoff. The start of it follows.\n\n`
    : 'Carry on from the handoff of a long earlier chat. I will paste the full handoff next; the start of it follows.\n\n'
  // The longest start of the handoff that still fits.
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (make(`${lead}${text.slice(0, mid)}\n[...]`).length <= opts.maxLength) lo = mid
    else hi = mid - 1
  }
  return { url: make(lo > 0 ? `${lead}${text.slice(0, lo)}\n[...]` : lead.trim()), isWhole: false }
}

/** How to ask the operating system to open a link. */
export function openLinkCommands(url: string, isWindows: boolean): string[][] {
  // rundll32 hands the link to the registered app with no shell in between, so the
  // characters in it need no quoting.
  return isWindows ? [['rundll32.exe', 'url.dll,FileProtocolHandler', url]] : [['open', url], ['xdg-open', url]]
}

// ---------------------------------------------------------------------------
// Paths.

/**
 * A home folder as the engine's file calls want it. On Windows a Git Bash or Cygwin spelling
 * (/c/Users/you, /cygdrive/c/Users/you) becomes C:\Users\you.
 */
export function nativeHome(path: string, isWindows: boolean): string {
  if (!isWindows) return path
  const m = path.match(/^\/(?:cygdrive\/|mnt\/)?([a-zA-Z])(?:\/(.*))?$/)
  const p = m ? `${(m[1] as string).toUpperCase()}:\\${(m[2] ?? '').replace(/\//g, '\\')}` : path.replace(/\//g, '\\')
  return p.replace(/\\+$/, '') || p
}

/** Whether the person moved the main chat to another model (an alias and its id are the same model). */
export function isOtherModel(now: string, before: string, cfg: RouterConfig): boolean {
  if (!now || !before || now === before) return false
  const a = tierOf(now, cfg)
  const b = tierOf(before, cfg)
  return a !== undefined && b !== undefined ? a !== b : now.replace(/\[.*\]$/, '') !== before.replace(/\[.*\]$/, '')
}
