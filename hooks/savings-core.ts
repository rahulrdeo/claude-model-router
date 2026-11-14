// Pure logic for the cost-savings estimate: list prices, what a turn cost, what it would
// have cost on the model it would otherwise have run on, and the running totals.
// No engine calls, no I/O.

/** US dollars per million tokens. */
export type Price = { input: number; output: number; cacheWrite: number; cacheRead: number }
export type Family = 'haiku' | 'sonnet' | 'opus' | 'fable'
export const FAMILIES: readonly Family[] = ['haiku', 'sonnet', 'opus', 'fable']

/**
 * Anthropic first-party list prices for the current models (published 2026-11). Cache writes
 * are priced at 1.25x input (a five-minute entry); a missing published cache-read price is 1/10
 * of input. Editable in the config as `savings.prices`, e.g. for Bedrock or Vertex rates.
 */
export const DEFAULT_PRICES: Record<Family, Price> = {
  haiku: { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  sonnet: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  opus: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  fable: { input: 8, output: 40, cacheWrite: 10, cacheRead: 0.2 },
}

/** Which price row a model id or alias uses; undefined for one this table cannot price. */
export function familyOf(model: string | undefined): Family | undefined {
  if (!model) return undefined
  const m = model.toLowerCase()
  if (m.includes('mythos') || m.includes('fable')) return 'fable'
  return FAMILIES.find(f => m.includes(f))
}

export type Tokens = {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

/** What these tokens cost on this model, in dollars; null when the model has no price. */
export function priceOf(t: Tokens | null | undefined, model: string | undefined, prices: Record<Family, Price>): number | null {
  const f = familyOf(model)
  if (!t || !f) return null
  const p = prices[f]
  const usd =
    (t.input_tokens ?? 0) * p.input +
    (t.output_tokens ?? 0) * p.output +
    (t.cache_creation_input_tokens ?? 0) * p.cacheWrite +
    (t.cache_read_input_tokens ?? 0) * p.cacheRead
  return usd / 1_000_000
}

/**
 * The same work on the model the chat would otherwise have run on. When the router moved this
 * turn to another model while that model's cache was warm, the turn rebuilt a cache the other
 * model would simply have read, so those tokens are priced as reads on that side. The cost of
 * switching models is then charged to the router, not hidden.
 */
export function insteadOfTokens(t: Tokens, cacheWouldHaveHit: boolean): Tokens {
  if (!cacheWouldHaveHit) return t
  return {
    ...t,
    cache_read_input_tokens: (t.cache_read_input_tokens ?? 0) + (t.cache_creation_input_tokens ?? 0),
    cache_creation_input_tokens: 0,
  }
}

export type Bucket = {
  /** Turns or subagents counted. */
  count: number
  /** How many ran on a model other than the one they would otherwise have used. */
  moved: number
  /** What they cost. */
  usd: number
  /** What they would have cost without the router. */
  insteadOfUsd: number
}

export type Overheads = {
  /** The classifier that reads each prompt. */
  classifier: number
  /** Haiku reading each subagent's task. */
  picks: number
  /** Handoff helper calls (spending you chose; not set against the savings). */
  handoff: number
  /** Keep-warm pings (spending you chose; not set against the savings). */
  keepWarm: number
}

export type Totals = {
  since: number
  main: Bucket
  subagents: Bucket
  overhead: Overheads
  /** Extra spent on subagents the risk rule moved to a stronger model. */
  riskExtra: number
  /** Turns with no price (a model the table does not know). */
  unpriced: number
}

export const emptyBucket = (): Bucket => ({ count: 0, moved: 0, usd: 0, insteadOfUsd: 0 })
export const emptyTotals = (since: number): Totals => ({
  since,
  main: emptyBucket(),
  subagents: emptyBucket(),
  overhead: { classifier: 0, picks: 0, handoff: 0, keepWarm: 0 },
  riskExtra: 0,
  unpriced: 0,
})

/** One priced item, as the ledger and the panel's recent list keep it. */
export type CostItem =
  | { at: number; kind: 'main' | 'subagent'; ranOn: string; insteadOf: string; usd: number; insteadOfUsd: number; label: string; risky?: boolean }
  | { at: number; kind: 'overhead'; what: keyof Overheads; usd: number; label: string }
  | { at: number; kind: 'unpriced'; ranOn: string; label: string }

/** Adds one item to the totals (a new object; the old one is left as it was). */
export function addItem(t: Totals, item: CostItem): Totals {
  const next: Totals = JSON.parse(JSON.stringify(t))
  if (item.kind === 'overhead') {
    next.overhead[item.what] += item.usd
  } else if (item.kind === 'unpriced') {
    next.unpriced += 1
  } else {
    const b = item.kind === 'main' ? next.main : next.subagents
    b.count += 1
    if (familyOf(item.ranOn) !== familyOf(item.insteadOf)) b.moved += 1
    b.usd += item.usd
    b.insteadOfUsd += item.insteadOfUsd
    if (item.risky && item.usd > item.insteadOfUsd) next.riskExtra += item.usd - item.insteadOfUsd
  }
  return next
}

/** Saved by routing: what the work would have cost, less what it cost, less the router's own calls. */
export function netSaved(t: Totals): number {
  return t.main.insteadOfUsd - t.main.usd + (t.subagents.insteadOfUsd - t.subagents.usd) - t.overhead.classifier - t.overhead.picks
}

/** The saving as a share of what the work would have cost. */
export function savedShare(t: Totals): number | null {
  const base = t.main.insteadOfUsd + t.subagents.insteadOfUsd
  return base > 0 ? netSaved(t) / base : null
}

/** "$0.42", "$0.0031", "-$0.05", "$12.40". */
export function usd(n: number): string {
  const sign = n < 0 ? '-' : ''
  const a = Math.abs(n)
  const digits = a === 0 ? 2 : a < 0.01 ? 4 : a < 1 ? 3 : 2
  return `${sign}$${a.toFixed(digits)}`
}

/**
 * What keeping a chat of `tokens` warm costs per ping (a cache read of the whole chat, before
 * any thinking), and what letting it go cold costs (writing the whole chat to the cache again).
 * Null where the model or the size is unknown.
 */
export function keepWarmCosts(tokens: number | undefined, model: string | undefined, prices: Record<Family, Price>): { ping: number | null; cold: number | null } {
  if (tokens === undefined) return { ping: null, cold: null }
  return {
    ping: priceOf({ cache_read_input_tokens: tokens }, model, prices),
    cold: priceOf({ cache_creation_input_tokens: tokens }, model, prices),
  }
}

/** Reads `savings.prices` from a config: any family left out or invalid keeps the default. */
export function mergePrices(user: unknown, warnings: string[]): Record<Family, Price> {
  const out: Record<Family, Price> = JSON.parse(JSON.stringify(DEFAULT_PRICES))
  if (user === undefined) return out
  if (typeof user !== 'object' || user === null || Array.isArray(user)) {
    warnings.push('savings.prices must be an object; using list prices')
    return out
  }
  for (const [name, row] of Object.entries(user as Record<string, unknown>)) {
    const f = FAMILIES.find(x => x === name)
    const r = row as Record<string, unknown> | null
    const ok =
      f !== undefined &&
      typeof r === 'object' &&
      r !== null &&
      (['input', 'output', 'cacheWrite', 'cacheRead'] as const).every(k => r[k] === undefined || (typeof r[k] === 'number' && (r[k] as number) >= 0 && (r[k] as number) <= 1000))
    if (!ok || !f) {
      warnings.push(`savings.prices.${name} must be one of ${FAMILIES.join(', ')} with input, output, cacheWrite, cacheRead in $ per million tokens; using list prices`)
      continue
    }
    out[f] = { ...out[f], ...(r as Partial<Price>) }
  }
  return out
}
