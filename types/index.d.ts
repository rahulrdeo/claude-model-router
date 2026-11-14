export type Tier = 'haiku' | 'sonnet' | 'opus'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Combo = { tier: Tier; effort: Effort }

export type HistoryItem = {
  score: number
  type: 'architecture' | 'build' | 'debugging' | 'code' | 'writing' | 'quick-qa' | 'general'
}

export type LastDecision = {
  recommended: Combo
  chosen: { tier: Tier | null; effort: Effort | null }
  reason: string
  heldBecause?: string
}

/** The router's per-session state, kept across hot reloads of the module. */
export type RouterSession = {
  /** The tier the main loop runs on now; null for the session's own (or unknown). */
  effective: Tier | null
  /** The effort the router set; null for the session's own. */
  effort?: Effort | null
  /** Routed prompts since the last model switch. */
  promptsSinceSwitch: number
  /** Routed prompts since the last effort change. */
  promptsSinceEffortSwitch?: number
  /** Recent prompt scores, oldest first. */
  history: HistoryItem[]
  last: LastDecision | null
  /** Set when the override failed at the API; routing then stays off for the session. */
  disabledReason: string | null
  /** A one-prompt override waiting for the next prompt (/route next). */
  pendingNext?: { tier?: Tier; effort?: Effort } | null
  /** Score of the last new task (not feedback): what feedback on it inherits. */
  taskScore?: number | null
  /** The last new task's message, excerpt, for the classifier. */
  lastTask?: string
  /** The last answer, excerpt, for the classifier. */
  lastAnswer?: string
  /** A failure seen on the last turn, to escalate from on the next prompt. */
  escalation?: { reason: string; from: Combo } | null
  /**
   * A model or effort the person picked themselves (the app's menu, /model) after the
   * session started. The router keeps it, still recommends, and /route resume lets go.
   */
  personPick?: { model?: string; effort?: Effort } | null
}

/** One subagent the router looked at, for the subagent pane. */
export type AgentPickRow = {
  /** The Agent tool call's id. */
  id: string
  at: number
  description: string
  agentType: string
  /** What Haiku picked; null when it gave no usable answer. */
  pick: Tier | null
  /** How sure Haiku was, 0-1; null when it gave no answer. */
  confidence: number | null
  /** Haiku's reason, a few words. */
  reason: string
  /** What the router did with the pick. */
  note: string
  /** What the subagent was sent to run on ("inherit" for the parent's). */
  model: string
  status: 'picking' | 'running' | 'done' | 'denied' | 'skipped'
  agentId?: string
  /** How long the pick took, ms. */
  ms?: number
  /** Haiku's risk rating, 0-1; null when it gave none. */
  risk?: number | null
  /** True when the risk rule sent the task to Opus. */
  risky?: boolean
  /** The model it would have run on without the router. */
  insteadOf?: string
  /** What its run cost, and would have cost on `insteadOf`, once it ended. */
  usd?: number
  insteadOfUsd?: number
}

/** Running cost totals: what routed work cost and would have cost without the router. */
export type SavingsBucket = { count: number; moved: number; usd: number; insteadOfUsd: number }
export type SavingsTotals = {
  since: number
  main: SavingsBucket
  subagents: SavingsBucket
  overhead: { classifier: number; picks: number; handoff: number; keepWarm: number }
  riskExtra: number
  unpriced: number
}
export type SavingsItem =
  | { at: number; kind: 'main' | 'subagent'; ranOn: string; insteadOf: string; usd: number; insteadOfUsd: number; label: string; risky?: boolean }
  | { at: number; kind: 'overhead'; what: 'classifier' | 'picks' | 'handoff' | 'keepWarm'; usd: number; label: string }
  | { at: number; kind: 'unpriced'; ranOn: string; label: string }

/** The handoff for long chats, as the handoff pane shows it. */
export type HandoffState = {
  status: 'idle' | 'writing' | 'ready' | 'failed' | 'applied'
  text: string
  /** When it was started or finished. */
  at: number
  /** Context size when it was written. */
  tokens?: number
  /** What went wrong, or how it was written (trimmed, messages left out). */
  detail?: string
  /** Where it was saved, if it was. */
  file?: string
  /** Set once the automatic handoff fired, so it fires once per long chat. */
  autoFired: boolean
  /** How many secrets were blanked out of the transcript and the handoff. */
  redacted?: number
}

/** The cache clock: when the last main-loop answer ended and when its cache lapses. */
export type CacheClockState = {
  /** null before the first answer, and while a turn runs. */
  expiresAt: number | null
  ttlMs: number
  /** Context size at the last answer: what a cold message re-reads at full price. */
  tokens?: number
  keepWarm: boolean
  /** When Keep warm was switched on, for its time limit. */
  warmSince?: number
  pings: number
  /** The last ping's outcome, a few words. */
  lastPing?: string
}

declare module 'claude-code' {
  interface PluginState {
    'model-router': {
      session: RouterSession
      agentPicks: Shaped<AgentPickRow[]>
      handoff: Shaped<HandoffState>
      cacheClock: Shaped<CacheClockState>
      /** The clock's "now", ticked once a second while a countdown runs. */
      now: number
      /** Cost totals for this session, and since the person started (or reset) counting. */
      savingsSession: Shaped<SavingsTotals>
      savingsAll: Shaped<SavingsTotals>
      /** The latest priced items, newest last. */
      savingsRecent: Shaped<SavingsItem[]>
    }
  }
}
