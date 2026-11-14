// The commented config file written to <claude config dir>/model-router/config.jsonc
// on first run. A unit test checks it parses to exactly DEFAULT_CONFIG.

export const CONFIG_TEMPLATE = `// Model router configuration.
// JSON with comments: // and /* */ comments and trailing commas are allowed.
// Changes apply on the next prompt (or run /route reload). An invalid value is
// ignored with a warning and its default kept; delete this file to restore all defaults.
{
  // Format version of this file. Leave it at 2.
  "configVersion": 2,

  // Mode used until you pick one with /route:
  //   "auto"      analyse each prompt and apply the model + effort
  //   "recommend" analyse, show the recommendation, you accept or change it
  //   "manual"    no analysis; you choose (/model, /route next, /route effort lock)
  //   "off"       do nothing (except /route next)
  //   "lock"      always the defaultLockModel; the router still picks the effort
  // After that, your last choice is remembered across sessions.
  "defaultMode": "recommend",

  // Model used by "/route lock" with no argument.
  "defaultLockModel": "sonnet",

  // What each tier is sent as: an alias ("haiku", "sonnet", "opus") or a full model id.
  "models": {
    "haiku": "haiku",
    "sonnet": "sonnet",
    "opus": "opus"
  },

  "thresholds": {
    // Scores run 0-100. Below haikuMax -> Haiku; at or above opusMin -> Opus; else Sonnet.
    "haikuMax": 30,
    "opusMin": 65,
    // Stickiness: a score must clear a boundary by this many points before switching,
    // so small changes never cost you the prompt cache.
    "switchMargin": 8,
    // Prompts to stay on a model after a switch (ignored for a two-tier jump).
    "minPromptsBetweenSwitches": 2
  },

  "context": {
    // How many earlier prompts feed the context score.
    "historySize": 5,
    // How much earlier conversation counts for an ordinary prompt (0-1).
    "weight": 0.25,
    // How much it counts for a follow-up such as "now do the same for X" (0-1).
    "followUpWeight": 0.6,
    // Only prompts with at most this many words can count as follow-ups.
    "followUpMaxWords": 25,
    "followUpKeywords": [
      "it", "that", "this", "those", "these", "again", "also", "continue", "go on", "go ahead",
      "do it", "same", "instead", "next", "what about", "and then", "now", "ok", "okay", "yes",
      "try", "still", "retry", "above", "previous"
    ]
  },

  // Each matching keyword adds the group's weight (the first match fully, later ones half).
  // The group with the strongest pull names the task type.
  "taskTypes": {
    "architecture": {
      "weight": 35,
      "keywords": [
        "architecture", "architect", "system design", "design a system", "scalab", "migrate",
        "migration", "trade-off", "tradeoff", "from scratch", "end-to-end", "distributed",
        "microservice", "data model", "schema design", "rewrite the", "overhaul", "roadmap"
      ]
    },
    // Building an app, site, tool or UI: more than a function, usually less than architecture.
    "build": {
      "weight": 20,
      "keywords": [
        "webapp", "web app", "web application", "website", "web page", "webpage", "landing page",
        "single-page", "dashboard", "frontend", "front-end", "full-stack", "fullstack", "self-contained",
        "self contained", "prototype", "mvp", "an app", "app that", "app for", "mobile app", "desktop app",
        "cli tool", "command-line tool", "browser extension", "chrome extension", "game", "ui for",
        "user interface"
      ]
    },
    "debugging": {
      "weight": 22,
      "keywords": [
        "debug", "bug", "error", "exception", "stack trace", "traceback", "crash", "fails",
        "failing", "not working", "doesn't work", "broken", "race condition", "memory leak",
        "segfault", "deadlock", "flaky", "regression", "root cause"
      ]
    },
    "code": {
      "weight": 14,
      "keywords": [
        "implement", "function", "class", "refactor", "code", "script", "api", "endpoint",
        "unit test", "tests", "regex", "sql", "component", "module", "library", "compile",
        "build", "typescript", "python", "java", "golang", "rust"
      ]
    },
    "writing": {
      "weight": 4,
      "keywords": [
        "draft", "email", "blog", "essay", "summarize", "summarise", "summary", "rephrase",
        "proofread", "translate", "readme", "documentation", "cover letter", "announcement"
      ]
    },
    "quick-qa": {
      "weight": -18,
      "keywords": [
        "what is", "what's", "how do i", "define", "meaning of", "quick question", "briefly",
        "tl;dr", "one line", "yes or no", "which is", "remind me", "syntax for"
      ]
    }
  },

  // Up to 3 matches count.
  "complexityBoosters": {
    "weight": 10,
    "keywords": [
      "step by step", "thorough", "in depth", "in-depth", "comprehensive", "production",
      "enterprise", "security", "performance", "optimi", "concurren", "across the codebase",
      "entire", "every file", "all files", "multi-step", "complex", "robust"
    ]
  },

  // Up to 2 matches count.
  "simplifiers": {
    "weight": -10,
    "keywords": ["typo", "rename", "reformat", "lint", "simple", "small", "tiny", "trivial", "one-liner", "quick fix"]
  },

  // Two or more matches mark the expected output as large.
  "largeOutputKeywords": [
    "full", "complete", "entire", "whole", "all files", "multiple files", "project", "app",
    "application", "report", "detailed", "comprehensive", "every"
  ],

  "logging": {
    // Write each routing decision to routing.log (JSON lines) next to this file.
    // "/route log on|off" overrides this and is remembered.
    "enabled": false,
    // Rotate to routing.log.1 past this size.
    "maxBytes": 1000000,
    // Also log the first 80 characters of each prompt. Off for privacy.
    "includePromptExcerpt": false
  },

  // Recommend mode: ask only when the recommendation differs from the current model or effort.
  // false asks on every prompt.
  "manualAskOnlyOnChange": true,

  // Limits on how far the score can climb.
  "scoring": {
    // The bullets, file names, code blocks and stack traces of a request together add at most this.
    // A long spec is more text, not a harder task.
    "structureCap": 20,
    // The highest score each task type can reach (0-100). Types left out are uncapped.
    // 70 is the top of the Opus medium band: build, code and writing requests stop there,
    // so xhigh is for architecture and debugging. Raise a number to allow more.
    "taskCeilings": { "build": 70, "code": 70, "writing": 70 }
  },

  // Effort level, chosen together with the model as one decision.
  "effort": {
    // "auto": the router picks the effort; "lock": always defaultLockLevel.
    // "/route effort auto" and "/route effort lock <level>" override this and are remembered.
    "defaultMode": "auto",
    "defaultLockLevel": "high",

    // Per model, the effort for a score (0-100): the last band whose "from" the score reaches.
    // The model itself still comes from "thresholds", so in auto mode Haiku sees scores
    // below 30, Sonnet 30-64 and Opus 65+. The other bands apply when a model is locked or
    // escalated. There is no low band for Opus: a task in that range gets Sonnet at high
    // effort instead of Opus at low effort.
    "bands": {
      "haiku":  [ { "from": 0, "level": "low" }, { "from": 15, "level": "medium" }, { "from": 45, "level": "high" } ],
      "sonnet": [ { "from": 0, "level": "low" }, { "from": 15, "level": "medium" }, { "from": 48, "level": "high" }, { "from": 85, "level": "xhigh" } ],
      "opus":   [ { "from": 0, "level": "medium" }, { "from": 75, "level": "high" }, { "from": 90, "level": "xhigh" } ]
    },

    // Highest level the router picks per model (uncertainty bumps stop here).
    "maxLevel": { "haiku": "high", "sonnet": "xhigh", "opus": "max" },

    // Quality first: a score this close below a model or effort boundary, or a prompt
    // that gives no signals at all, counts as uncertain and gets one level more effort.
    "uncertaintyMargin": 4,

    // "low" is used only when the prompt's own score is at most this and nothing is uncertain.
    "lowMaxScore": 12,

    // Stickiness for effort: changing effort rewrites the prompt cache like a model switch,
    // so the score must clear an effort boundary by this many points. The cool-down is
    // thresholds.minPromptsBetweenSwitches.
    "switchMargin": 5
  },

  // A small model reads each new message with the last exchange, and judges its complexity,
  // its sentiment and whether it is feedback on the last result. Feedback inherits the task's
  // level; negative feedback raises it. The message and an excerpt of the last answer are sent
  // to this model. If it fails or times out, the rules decide alone.
  "classifier": {
    "enabled": true,
    "model": "haiku",
    "effort": "low",
    // Give up after this many milliseconds (500-10000).
    "timeoutMs": 3000,
    // Points added by each negative feedback message.
    "negativeBump": 10,
    // The score range each complexity maps to for a new task (0-100). The rules' score is held
    // inside it, so the classifier sets the level and the rules place the prompt within it.
    // On the default ladder: simple = Haiku; moderate = Sonnet; complex = Sonnet high to Opus
    // medium; architecture = Opus medium. Higher levels come from escalation, /route next or
    // an effort lock. Raise "max" to let a complexity go higher (75-89 is Opus high, 90+ xhigh).
    "bands": {
      "simple":       { "min": 0,  "max": 29 },
      "moderate":     { "min": 30, "max": 64 },
      "complex":      { "min": 48, "max": 74 },
      "architecture": { "min": 65, "max": 74 }
    }
  },

  // Escalation after a failure: an API error or refusal, a test/build run that was still
  // failing when the turn ended, or a short next prompt saying the result was poor.
  // Auto and lock modes apply the higher setting to your next prompt; recommend mode
  // recommends it; manual and off modes suggest it in a toast.
  "escalation": {
    "enabled": true,
    // Raise effort on the same model up to this level, then move to the next model (at least high).
    "raiseEffortUpTo": { "haiku": "medium", "sonnet": "high", "opus": "max" },
    "feedbackKeywords": [
      "still failing", "still fails", "still broken", "still not", "doesn't work", "does not work",
      "didn't work", "did not work", "not working", "that's wrong", "that is wrong", "wrong answer",
      "incorrect", "not right", "poor", "bad result", "try again", "same error", "not what i asked",
      "you broke", "worse"
    ],
    // Only prompts with at most this many words are read as feedback.
    "feedbackMaxWords": 40,
    // A Bash command containing one of these is a test or build run.
    "testCommandPatterns": [
      "test", "pytest", "jest", "vitest", "mocha", "rspec", "phpunit", "tox", "go vet", "cargo build",
      "cargo check", "tsc", "mvn", "gradle", "dotnet build", "make"
    ],
    // Its output containing one of these means it failed ("0 failed" is ignored).
    "failurePatterns": [
      "failed", "failing", "failure", "error:", "errors:", "traceback", "assertionerror", "npm err!",
      "build failed", "panicked"
    ]
  }
}
`
