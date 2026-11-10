// TinyAgent: one capped run per page. Groundwork's Workflow starts a run, polls it by id until
// it ends, and reads it once more for the step screenshots from which the evidence image is
// picked. Every run uses the standard browser profile (`lite`). Agent steps are billed when the
// run ends, from `num_of_steps`; runAgentToCompletion writes that one spend row.
import { AGENT_MAX_DURATION_SECONDS, AGENT_MAX_STEPS } from "../core/limits";
import { PRICES, bookAgentRunSpend } from "../core/spend";
import type { Env } from "../env";
import { RATE_LIMIT_RETRIES, RATE_LIMIT_WAIT_MS, readJson, TinyFishError, tinyfishFetch } from "./client";

const RUN_ASYNC_API = "https://agent.tinyfish.ai/v1/automation/run-async";
const RUNS_API = "https://agent.tinyfish.ai/v1/runs";

const MAX_ERROR_CHARS = 300;

export type StartRunInput = {
  /** The page the run starts on. */
  url: string;
  goal: string;
  /** JSON Schema for the run's `result`. */
  outputSchema: object;
  /** Fewer steps than AGENT_MAX_STEPS, for a page that is known to answer in a few or not at all. */
  maxSteps?: number;
  /** TinyFish calls this when the run ends. It holds the webhook secret, so it is never logged. Leave it out to poll instead. */
  callbackUrl?: string;
};

/**
 * Starts a run capped at AGENT_MAX_STEPS steps and AGENT_MAX_DURATION_SECONDS seconds, on the
 * standard browser profile. Any 429 waits 60 s and retries up to 3 times (the account's
 * concurrent runs are shared with other builds); after that it throws a TinyFishError with
 * code `busy`. Without a `callbackUrl` no webhook is registered.
 */
export async function startRun(
  env: Env,
  p: StartRunInput,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ runId: string }> {
  const res = await tinyfishFetch(env, RUN_ASYNC_API, {
    method: "POST",
    body: JSON.stringify({
      url: p.url,
      goal: p.goal,
      browser_profile: "lite",
      agent_config: {
        max_steps: Math.min(p.maxSteps ?? AGENT_MAX_STEPS, AGENT_MAX_STEPS),
        max_duration_seconds: AGENT_MAX_DURATION_SECONDS,
      },
      output_schema: p.outputSchema,
      ...(p.callbackUrl ? { webhook_url: p.callbackUrl } : {}),
    }),
    retryRateLimit: true,
    sleep: opts.sleep,
  });
  const json = await readJson<{ run_id?: unknown }>(res);
  if (typeof json.run_id !== "string" || json.run_id === "") {
    throw new TinyFishError(502, "no_run_id", "TinyFish accepted the Agent run but returned no run_id");
  }
  return { runId: json.run_id };
}

export type AgentStep = {
  id: string;
  /** What the step did, in TinyFish's words ("Expand permits section to see details"). */
  action: string | null;
  /** A screenshot URL; only present when the run was read with `screenshots: "url"`. */
  screenshot: string | null;
};

/** What a run looks like to the rest of the Worker. Missing fields are null, never absent. */
export type AgentRun = {
  status: string;
  result: unknown;
  num_of_steps: number | null;
  finished_at: string | null;
  /** The failure, as text (a string, or the message or code of an error object); null when none. */
  error: string | null;
  steps: AgentStep[];
};

function optionalString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function runErrorText(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  if (typeof error === "string") return error === "" ? null : error.slice(0, MAX_ERROR_CHARS);
  if (typeof error === "object") {
    const o = error as { message?: unknown; code?: unknown };
    for (const v of [o.message, o.code]) if (typeof v === "string" && v !== "") return v.slice(0, MAX_ERROR_CHARS);
  }
  return "agent_error";
}

function readSteps(steps: unknown): AgentStep[] {
  if (!Array.isArray(steps)) return [];
  const out: AgentStep[] = [];
  for (const s of steps as unknown[]) {
    if (s === null || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    if (typeof o.id !== "string" || o.id === "") continue;
    out.push({ id: o.id, action: optionalString(o.action), screenshot: optionalString(o.screenshot) });
  }
  return out;
}

/**
 * Reads a run. `screenshots: "url"` adds a screenshot URL to each step that has one (those URLs
 * are not the API-key endpoint; use downloadStepScreenshot for the bytes); "none" is cheaper
 * and enough to poll the status and read the result. `opts.timeoutMs` aborts the request after
 * that long (a hung read then fails like any network error); without it the request is not timed.
 */
export async function getRun(
  env: Env,
  runId: string,
  screenshots: "url" | "none",
  opts: { timeoutMs?: number } = {},
): Promise<AgentRun> {
  const res = await tinyfishFetch(env, `${RUNS_API}/${encodeURIComponent(runId)}?screenshots=${screenshots}&html=none`, {
    method: "GET",
    ...(opts.timeoutMs !== undefined ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
  });
  const json = await readJson<Record<string, unknown>>(res);
  return {
    status: typeof json.status === "string" ? json.status : "UNKNOWN",
    result: json.result ?? null,
    num_of_steps: typeof json.num_of_steps === "number" ? json.num_of_steps : null,
    finished_at: optionalString(json.finished_at),
    error: runErrorText(json.error),
    steps: readSteps(json.steps),
  };
}

/**
 * The bytes of one step's screenshot (a JPEG). This is the API-key endpoint, which has the
 * `/v1` prefix; the `screenshot` URLs inside `steps[]` do not and are not fetchable with the key.
 * The image is part of the step already billed, so there is no spend row. Throws a TinyFishError
 * on an HTTP error, on an answer that is not an image, and on an empty one. The read is limited to
 * POLL_TIMEOUT_MS; a timeout is an evidence failure for the caller, not a section failure.
 */
export async function downloadStepScreenshot(env: Env, runId: string, stepId: string): Promise<ArrayBuffer> {
  const res = await tinyfishFetch(
    env,
    `${RUNS_API}/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/screenshot`,
    { method: "GET", signal: AbortSignal.timeout(POLL_TIMEOUT_MS) },
  );
  if (!(res.headers.get("content-type") ?? "").toLowerCase().startsWith("image/")) {
    throw new TinyFishError(502, "not_an_image", "TinyFish step screenshot was not an image");
  }
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength === 0) throw new TinyFishError(502, "empty_image", "TinyFish step screenshot was empty");
  return bytes;
}

// The Groundwork pages (a property history, an assessment table, a tax balance, a school list, a
// flood result) are each read in a few steps: open the page, fill its search form, then expand,
// read or extract the result. The evidence is the screen that shows that result.
//
// A step shows it when its action reads something: a verb such as extract, read, expand, view or
// check, or a word for what these pages hold (history, balance, permits, violations, schools,
// flood, details...)...
const READS_RESULT = new RegExp(
  `\\b(?:${[
    ...["extract", "read", "expand", "view", "review", "check", "scroll"].map((v) => `${v}(?:s|ed|ing)?`),
    "history",
    "balance",
    "assessments?",
    "permits?",
    "violations?",
    "inspections?",
    "zoning",
    "flood",
    "schools?",
    "catchment",
    "details?",
    "records?",
  ].join("|")})\\b`,
  "i",
);
// ...unless the step is about the search form or the way out: going to the page, entering,
// typing or submitting the address, pressing search, picking a suggestion, waiting for a search,
// a cookie banner, going back, returning the answer, the list of search results, counting the
// results. A step that returns the answer shows whatever screen came before it, and a page that
// was left shows its list. The words are kept narrow, because the data itself uses some of them:
// "type" is only the verb (type the address; a permit's type is data), "closed" is a violation
// status, a "count" is a number on the page unless it counts results, and "wait for the table to
// load" is a result step.
const LEAVES_RESULT = new RegExp(
  `\\b(?:${[
    "navigat\\w*",
    "go(?:es)? to",
    "enter(?:s|ed|ing)?",
    "typ(?:ing|ed)",
    "type\\s+(?:the|an?|in|into|your|this|that|its|\\d|[\"'])",
    "fill(?:s|ed|ing)?",
    "input(?:s|ted|ting)?",
    "submit(?:s|ted|ting)?",
    "press(?:es|ed|ing)?",
    "click(?:s|ed|ing)? (?:on )?(?:the )?search",
    "search(?:es|ed|ing)? (?:for|form|page|box|field|button)",
    "select(?:s|ed|ing)? (?:the )?(?:address|suggestion|first)",
    "accept\\w*",
    "dismiss\\w*",
    "clos(?:e|es|ing)",
    "cookies?",
    "banner",
    "captcha",
    "back",
    "return(?:s|ed|ing)?",
    "search results?",
    "results? (?:list|page)",
    "count(?:s|ed|ing)? (?:the )?(?:number of )?(?:[\\w-]+ ){0,2}results?",
    "wait(?:s|ed|ing)? for (?:the )?(?:\\w+ )?search",
  ].join("|")})\\b`,
  "i",
);

/**
 * The step whose screenshot is the evidence: the LAST step that has a screenshot and whose
 * action reads a result (READS_RESULT) without being about the search form or the way out
 * (LEAVES_RESULT); when there is none, the last step with a screenshot; null when no step has
 * one. On the recorded L&I property-history run that is "Check for licenses and appeals
 * sections" (the history page with the permit and violation lists open), not "Return search
 * results for ...".
 */
export function pickEvidenceStep(run: { steps: readonly AgentStep[] }): string | null {
  let lastWithScreenshot: string | null = null;
  let lastOnResult: string | null = null;
  for (const step of run.steps) {
    if (step.screenshot === null || step.screenshot === "") continue;
    lastWithScreenshot = step.id;
    const action = step.action ?? "";
    if (READS_RESULT.test(action) && !LEAVES_RESULT.test(action)) lastOnResult = step.id;
  }
  return lastOnResult ?? lastWithScreenshot;
}

// --- Run to completion (the Workflow's Agent steps) -------------------------------------------

/** The run states after which nothing more happens (the spikes poll on exactly these). */
const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/** True when TinyFish will not change this run any further. */
export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** How long one poll (or the screenshot read) may take before it is aborted and counts as a transient failure. */
export const POLL_TIMEOUT_MS = 30_000;
/** Consecutive transient poll failures that are retried; the next one gives up. */
const POLL_FAILURES_TOLERATED = 3;

export type RunResult = {
  runId: string;
  status: string;
  result: unknown;
  numOfSteps: number | null;
  /** The failure as text; null when the run did not fail. */
  error: string | null;
  /** The steps, with screenshot URLs when the screenshot read succeeded. */
  steps: AgentStep[];
  finishedAt: string | null;
};

/** Where runAgentToCompletion failed: before a run existed, while polling it, or by running out of time. */
export type AgentPhase = "start" | "poll" | "timeout";

/**
 * Every failure of runAgentToCompletion. `runId` is null exactly when no run exists (`phase` is
 * "start"); otherwise it is the live run's id. `status` and `code` are the client's own
 * (`busy`, `no_run_id`, `INVALID_INPUT`, `http_503`...), `agent_timeout` with 504 for a timeout,
 * and `network_error` with 0 when the request never got an answer.
 */
export class AgentRunError extends TinyFishError {
  readonly runId: string | null;
  readonly phase: AgentPhase;

  constructor(status: number, code: string, message: string, runId: string | null, phase: AgentPhase) {
    super(status, code, message);
    this.name = "AgentRunError";
    this.runId = runId;
    this.phase = phase;
  }
}

/**
 * The longest one runAgentToCompletion call can hold the Agent slot, in milliseconds: the three
 * 60 s waits of a rate-limited start, `maxWaitMs`, one poll interval (the last poll starts that
 * long after the previous one ended, just under the deadline) and two request timeouts (that last
 * poll, then the screenshot read). It leaves out the start requests themselves and the D1 writes,
 * which answer in milliseconds. Task 7 asserts it stays below AGENT_SLOT_STALE_MS, so a hold
 * that was left in place is only taken over after the run is certainly over.
 */
export function agentHoldBudgetMs(o: { pollEveryMs: number; maxWaitMs: number; pollTimeoutMs?: number }): number {
  return RATE_LIMIT_RETRIES * RATE_LIMIT_WAIT_MS + o.maxWaitMs + o.pollEveryMs + 2 * (o.pollTimeoutMs ?? POLL_TIMEOUT_MS);
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A failed poll worth another try: a 429, a 5xx, a 200 that is not JSON, or no answer at all (network error, abort, timeout). */
function isTransientPollError(err: unknown): boolean {
  if (err instanceof TinyFishError) return err.status === 429 || err.status >= 500 || err.code === "bad_json";
  return true;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/**
 * The code for a request that never got an answer. The platform refuses a request once an
 * invocation has made its allowed number of them ("Too many subrequests"); that case gets its own
 * fixed code, so a section that fails for it says so. Nothing else of the message is kept.
 */
function unansweredCode(err: unknown): "subrequest_limit" | "network_error" {
  return err instanceof Error && /subrequest/i.test(err.message) ? "subrequest_limit" : "network_error";
}

/** A start that failed. No run exists, as far as the response says. */
function startFailure(err: unknown): AgentRunError {
  if (err instanceof TinyFishError) return new AgentRunError(err.status, err.code, err.message, null, "start");
  // Only the error's name: its message can carry request details.
  return new AgentRunError(0, unansweredCode(err), `TinyFish start failed: ${errorName(err)}`, null, "start");
}

/** A poll that gave up. The run is live (or finished and unread). */
function pollFailure(runId: string, err: unknown): AgentRunError {
  if (err instanceof TinyFishError) {
    return new AgentRunError(err.status, err.code, `${err.message} (polling run ${runId})`, runId, "poll");
  }
  return new AgentRunError(0, unansweredCode(err), `TinyFish poll failed: ${errorName(err)} (polling run ${runId})`, runId, "poll");
}

function timeoutFailure(runId: string, maxWaitMs: number): AgentRunError {
  return new AgentRunError(504, "agent_timeout", `TinyFish agent_timeout: run ${runId} not finished after ${maxWaitMs} ms`, runId, "timeout");
}

/**
 * Starts a run, polls it (without screenshots) every `pollEveryMs` until it is COMPLETED, FAILED
 * or CANCELLED, then reads it once more with screenshot URLs. Resolves with a RunResult, or
 * rejects with an AgentRunError.
 *
 * THE SLOT RULE (Task 7 follows it). A caller holding the Agent slot (src/db/inflight.ts)
 * releases it only after a RunResult, or after an AgentRunError with phase "start" (`runId` is
 * null: no run exists). On phase "poll" or "timeout" a run is live at TinyFish: leave the slot to
 * go stale after AGENT_SLOT_STALE_MS (10 minutes, which outlasts the 170 s run cap and
 * agentHoldBudgetMs) and keep `runId` for reconciliation; releasing it would let a second run
 * start next to a live one. `opts.onStarted(runId)` is called as soon as the id is known, so
 * the caller can store it before the first poll; an error it throws is logged by name and
 * ignored (the run is paid for and must not be abandoned). One case no phase can tell: if the
 * start request itself gets no answer (phase "start", code `network_error`), TinyFish may still
 * have created a run whose id was lost.
 *
 * Polling. A poll that fails with a 429, a 5xx, a 200 that is not JSON, or no answer (network
 * error, or no reply within `pollTimeoutMs`, default POLL_TIMEOUT_MS) is retried at the normal
 * interval; the fourth consecutive failure gives up with phase "poll", and a poll that works
 * resets the count. Any other 4xx gives up at once. Failed polls still count toward the
 * deadline, so `maxWaitMs` stays a bound.
 *
 * Spend: when the run is terminal, ONE `agent_step` row of `num_of_steps` x PRICES.agent_step,
 * rounded to 6 decimals, ref the run id. A failed or cancelled run is billed for its steps too;
 * a run with 0 steps or no step count writes no row. A failed ledger write is logged (kind and
 * run id) and does not lose the result. A phase "poll" or "timeout" failure records no spend:
 * the run may still be going, and its steps are not known.
 *
 * Timeout: `maxWaitMs` runs from the moment the run exists (the 60 s waits of a rate-limited
 * start are not part of it). A run still going when the poll that falls at or after the deadline
 * has been answered (or has failed) throws phase "timeout", code `agent_timeout`: the 170 s cap
 * on TinyFish's side should have ended it first, so callers pass a `maxWaitMs` above that. A
 * run that finishes on that last poll is returned, not timed out. If only the screenshot read
 * fails, the paid-for result is still returned, with the steps of the last poll (no URLs).
 */
export async function runAgentToCompletion(
  env: Env,
  p: StartRunInput,
  opts: {
    pollEveryMs: number;
    maxWaitMs: number;
    /** Request timeout for each poll and for the screenshot read. Default POLL_TIMEOUT_MS. */
    pollTimeoutMs?: number;
    onStarted?: (runId: string) => void | Promise<void>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<RunResult> {
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const pollTimeoutMs = opts.pollTimeoutMs ?? POLL_TIMEOUT_MS;

  let runId: string;
  try {
    ({ runId } = await startRun(env, p, { sleep }));
  } catch (err) {
    throw startFailure(err);
  }
  const startedAt = now();

  if (opts.onStarted) {
    try {
      await opts.onStarted(runId);
    } catch (err) {
      console.error("agent onStarted failed", errorName(err));
    }
  }

  return pollRunToCompletion(env, runId, {
    pollEveryMs: opts.pollEveryMs,
    maxWaitMs: opts.maxWaitMs,
    pollTimeoutMs,
    sleep,
    now,
    startedAt,
  });
}

/** Options shared by a fresh poll and a retry that resumes an already-started run. */
export type PollRunOpts = {
  pollEveryMs: number;
  maxWaitMs: number;
  pollTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** When set, the deadline is measured from this instant rather than from the first poll. */
  startedAt?: number;
};

/**
 * Polls an existing run until it is terminal, then finalizes it (spend once, screenshot URLs).
 * The same deadline and transient-failure rule as runAgentToCompletion.
 */
export async function pollRunToCompletion(env: Env, runId: string, opts: PollRunOpts): Promise<RunResult> {
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const pollTimeoutMs = opts.pollTimeoutMs ?? POLL_TIMEOUT_MS;
  const startedAt = opts.startedAt ?? now();

  let failures = 0;
  for (;;) {
    await sleep(opts.pollEveryMs);
    let polled: AgentRun;
    try {
      polled = await getRun(env, runId, "none", { timeoutMs: pollTimeoutMs });
      failures = 0;
    } catch (err) {
      failures += 1;
      if (!isTransientPollError(err) || failures > POLL_FAILURES_TOLERATED) throw pollFailure(runId, err);
      if (now() - startedAt >= opts.maxWaitMs) throw timeoutFailure(runId, opts.maxWaitMs);
      continue;
    }
    if (isTerminalStatus(polled.status)) return finalizeAgentRun(env, runId, polled, pollTimeoutMs);
    if (now() - startedAt >= opts.maxWaitMs) throw timeoutFailure(runId, opts.maxWaitMs);
  }
}

/**
 * Books this run's spend once (replacing a ceiling booked under the same run id) and reads
 * screenshot URLs. Used both after a successful poll and when a retry finds the run already terminal.
 */
export async function finalizeAgentRun(
  env: Env,
  runId: string,
  polled: AgentRun,
  pollTimeoutMs: number = POLL_TIMEOUT_MS,
): Promise<RunResult> {
  const stepsBilled = polled.num_of_steps ?? 0;
  try {
    // Rounded to 6 decimals: 9 x 0.016 is 0.144, not 0.14400000000000002.
    await bookAgentRunSpend(env.DB, runId, Math.round(stepsBilled * PRICES.agent_step * 1e6) / 1e6);
  } catch {
    // The run is over and paid for; losing its result because the ledger write failed is worse.
    console.error("spend write failed", "agent_step", runId);
  }

  let steps = polled.steps;
  try {
    steps = (await getRun(env, runId, "url", { timeoutMs: pollTimeoutMs })).steps;
  } catch (err) {
    // Only the error's name is logged: its message can carry request details.
    console.error("agent screenshot read failed", errorName(err));
  }
  return {
    runId,
    status: polled.status,
    result: polled.result,
    numOfSteps: polled.num_of_steps,
    error: polled.error,
    steps,
    finishedAt: polled.finished_at,
  };
}
