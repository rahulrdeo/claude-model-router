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
}

declare module 'claude-code' {
  interface PluginState {
    'model-router': { session: RouterSession }
  }
}
