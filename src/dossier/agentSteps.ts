// Callable Workflow steps for serial Agent reads and dossier completion.
import type { WorkflowStepConfig } from "cloudflare:workers";
import { AGENT_SECTION_MAX_USD, PUBLIC_AGENT_PAUSE_USD, SPEND_PAUSE_USD } from "../core/limits";
import { bookAgentRunSpend, PRICES, totalSpend } from "../core/spend";
import { getDossier, updateDossier } from "../db/dossiers";
import { acquireAgentSlot, AGENT_SLOT_STALE_MS, releaseAgentSlot, slotHolder } from "../db/inflight";
import { getSections, upsertSection } from "../db/sections";
import type { Env } from "../env";
import { FREE_SECTION_IDS, getSection } from "../sections/index";
import type { AgentSectionData, SectionId } from "../sections/types";
import {
  agentHoldBudgetMs, AgentRunError, downloadStepScreenshot, finalizeAgentRun, getRun,
  isTerminalStatus, pickEvidenceStep, POLL_TIMEOUT_MS, pollRunToCompletion, runAgentToCompletion,
  type AgentRun, type RunResult,
} from "../tinyfish/agent";
import { screenshotSection } from "./build";
import { dossierStatus } from "./status";

// A free-plan invocation may make 50 requests to other hosts. One section's run is one start, a
// poll every POLL_MS for at most RUN_WAIT_MS, and two reads at the end: 24 at these values.
const POLL_MS = 10_000;
const RUN_WAIT_MS = 200_000;
/** How long the Workflow sleeps before asking for the slot again, and how many times it asks (30 minutes). */
const SLOT_WAIT_MS = 20_000;
export const SLOT_WAIT_TURNS = 90;
const CALLBACK_TIMEOUT_MS = 5_000;
const ERROR_LENGTH = 200;
const SPEND_PRECISION = 1_000_000;
if (agentHoldBudgetMs({ pollEveryMs: POLL_MS, maxWaitMs: RUN_WAIT_MS }) >= AGENT_SLOT_STALE_MS) {
  throw new Error("Agent hold exceeds the slot staleness interval");
}
/** Waits for the requested interval and returns; slot checks must be spaced to avoid busy polling. */
const sleepDefault = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Returns only an error name; log messages must not expose upstream details. */
const errorName = (err: unknown) => err instanceof Error ? err.name : typeof err;
/** Test seams retain the production TinyFish functions and avoid network calls in tests. */
export const agentDeps = {
  run: runAgentToCompletion,
  download: downloadStepScreenshot,
  get: getRun,
  poll: pollRunToCompletion,
  finalize: finalizeAgentRun,
};


/** What one try at a section did: "busy" when another section holds the slot and nothing was started. */
export type SectionTurn = "busy" | "done";

/** Stores optional screenshot evidence and returns its key; evidence failures never change the result. */
async function evidence(env: Env, dossierId: string, sectionId: string, run: RunResult): Promise<string | null> {
  const step = pickEvidenceStep(run);
  if (!step) return null;
  try {
    const bytes = await agentDeps.download(env, run.runId, step);
    const key = `evidence/${dossierId}/${sectionId}.jpg`;
    await env.STORE.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
    return key;
  } catch (err) {
    console.error("agent evidence failed", errorName(err));
    return null;
  }
}

/** Returns the verified L&I URL or its fallback; other hosts are not accepted as source evidence. */
function deepSource(data: AgentSectionData, fallback: string): string {
  try {
    const url = new URL(String(data.page_url));
    return url.protocol === "https:" && url.hostname === "li.phila.gov" ? url.href : fallback;
  } catch {
    return fallback;
  }
}

/** Stores the observed depth and returns; unknown counts cannot establish that all rows were returned. */
async function updateDeep(env: Env, id: string, data: AgentSectionData): Promise<void> {
  const lists = [data.permits, data.violations, data.inspections] as {
    count: number | null; rows_returned: number; truncated: boolean;
  }[];
  // Unknown counts cannot prove that every row was returned.
  const extended = lists.some((list) => list.truncated || list.count === null || list.rows_returned < list.count);
  await upsertSection(env.DB, id, "licenses_inspections", {
    depth: extended ? "extended" : "full", rows_returned: lists.reduce((sum, list) => sum + list.rows_returned, 0),
  });
}
/** Returns a finished run's classification; unreadable completed output is an error. */
function classifyRun(sid: SectionId, run: RunResult) {
  if (run.status !== "COMPLETED") {
    const suffix = run.error ? `: ${run.error.slice(0, ERROR_LENGTH)}` : "";
    return { data: null, status: "error" as const, reason: `agent_${run.status.toLowerCase()}${suffix}` };
  }
  const adapter = getSection(sid);
  const data = adapter.parseResult?.(run.result) ?? null;
  if (!data) return { data: null, status: "error" as const, reason: "unreadable_result" };
  const classification = adapter.classifyResult!(data);
  return { data, status: classification.status, reason: classification.reason ?? null };
}

/** Stores the finished result and returns; actual step spend is added even for failed runs. */
async function storeRun(env: Env, id: string, sid: SectionId, run: RunResult, fallback: string): Promise<void> {
  const spend = Math.round((run.numOfSteps ?? 0) * PRICES.agent_step * SPEND_PRECISION) / SPEND_PRECISION;
  const image = await evidence(env, id, sid, run);
  const { data, status, reason } = classifyRun(sid, run);
  let source = fallback;
  if (sid === "li_deep" && data) source = deepSource(data as AgentSectionData, fallback);

  const written = await env.DB.prepare(`UPDATE sections SET status=?1,data=?2,error=?3,run_id=?4,spend_usd=?5,
    evidence_key=?6,checked_at=?7,source_url=?8 WHERE dossier_id=?9 AND section_id=?10 AND status='pending'`)
    .bind(status,data === null ? null : JSON.stringify(data),reason,run.runId,spend,image,
      run.finishedAt ?? new Date().toISOString(),source,id,sid).run();
  if (!written.meta.changes) {
    if (image) await env.STORE.delete(image).catch(() => console.error("late evidence deletion failed"));
    return;
  }

  const dossier = await getDossier(env.DB, id);
  if (dossier) {
    const total = Math.round((dossier.spend_usd + spend) * SPEND_PRECISION) / SPEND_PRECISION;
    await updateDossier(env.DB, id, { spend_usd: total });
  }
  if (sid === "li_deep" && status === "ok" && data) await updateDeep(env, id, data as AgentSectionData);
}

/** Loads a valid Agent section and returns its state; malformed workflow input cannot start a run. */
async function loadAgentSection(env: Env, dossierId: string, sectionId: string) {
  const dossier = await getDossier(env.DB, dossierId);
  const adapter = getSection(sectionId);
  const row = (await getSections(env.DB, dossierId)).find((item) => item.section_id === sectionId);
  if (!dossier || !row || !adapter || adapter.method !== "agent" || !adapter.goal || !adapter.outputSchema ||
    !adapter.parseResult || !adapter.classifyResult) throw new Error("invalid_agent_section");
  return { dossier, adapter, row };
}

/** Returns the applicable pause reason; public requests stop earlier to preserve budget for the free core. */
async function pauseReason(env: Env, addedBy: string): Promise<string | null> {
  const spend = await totalSpend(env.DB);
  if (spend >= SPEND_PAUSE_USD) return "budget_paused";
  if (addedBy === "public" && spend >= PUBLIC_AGENT_PAUSE_USD) {
    return "budget paused for public requests; the free core is complete";
  }
  return null;
}

/**
 * True when a failed start certainly created no run: TinyFish said no (busy, or a 4xx), or the
 * platform refused to send the request because the invocation had used its allowed requests.
 */
function definiteStart(err: AgentRunError): boolean {
  return err.phase === "start"
    && (err.code === "busy" || err.code === "subrequest_limit" || (err.status >= 400 && err.status < 500));
}

/** Returns a failure reason; uncertain starts and polls retain the slot because a paid run may exist. */
function failureReason(err: AgentRunError, definite: boolean): string {
  if (err.phase === "start") return definite ? err.code : "agent_start_uncertain";
  if (err.phase === "poll") return "agent_poll_failed";
  return "agent_timeout";
}

/** Stores an Agent failure and returns; a known run must not be retried after a storage error. */
async function storeFailure(env: Env, id: string, sid: SectionId, err: AgentRunError, definite: boolean) {
  try {
    await env.DB.prepare("UPDATE sections SET status='error',error=?,run_id=?,checked_at=? WHERE dossier_id=? AND section_id=? AND status='pending'")
      .bind(failureReason(err,definite),err.runId,new Date().toISOString(),id,sid).run();
  } catch (writeError) {
    if (!err.runId) throw writeError;
    console.error("agent error storage failed", errorName(writeError));
  }
}

/**
 * Starts and stores one run; the recorded run id prevents a duplicate paid start. Only one run may
 * be in flight: when another section holds the slot this answers "busy" at once and starts nothing.
 * The Workflow sleeps and asks again, so no step sits waiting for the slot.
 */
async function startRun(
  env: Env,
  dossierId: string,
  loaded: Awaited<ReturnType<typeof loadAgentSection>>,
  sleep?: (ms: number) => Promise<void>,
): Promise<SectionTurn> {
  const { adapter } = loaded;
  const holder = `${dossierId}:${adapter.id}:${crypto.randomUUID()}`;
  if (!(await acquireAgentSlot(env.DB, holder))) return "busy";
  await runHeld(env, dossierId, loaded, holder, sleep);
  return "done";
}

/** Runs one section while this holder has the slot, and releases the slot unless a paid run may still be live. */
async function runHeld(
  env: Env,
  dossierId: string,
  loaded: Awaited<ReturnType<typeof loadAgentSection>>,
  holder: string,
  sleep?: (ms: number) => Promise<void>,
): Promise<void> {
  const { dossier, adapter } = loaded;
  const sid = adapter.id;
  let release = false;
  let started = false;
  try {
    const paused = await pauseReason(env, dossier.added_by);
    if (paused) {
      await upsertSection(env.DB, dossierId, sid, {
        status: "unavailable",
        error: paused,
        checked_at: new Date().toISOString(),
      });
      release = true;
      return;
    }
    const current = (await getSections(env.DB, dossierId)).find((item) => item.section_id === sid);
    if (!current || current.status !== "pending" || current.run_id) {
      release = true;
      return;
    }
    const ctx = { address: dossier.address_resolved?.split(",")[0] ?? "", opa: dossier.opa_account ?? "" };
    const source = adapter.url(ctx);
    const result = await agentDeps.run(env, {
      url: source,
      goal: adapter.goal!(ctx),
      outputSchema: adapter.outputSchema!,
      ...(adapter.maxSteps !== undefined ? { maxSteps: adapter.maxSteps } : {}),
    }, {
      pollEveryMs: POLL_MS,
      maxWaitMs: RUN_WAIT_MS,
      sleep,
      onStarted: async (runId) => {
        started = true;
        await upsertSection(env.DB, dossierId, sid, { run_id: runId });
      },
    });
    release = true;
    started = true;
    await storeRun(env, dossierId, sid, result, source);
  } catch (err) {
    if (err instanceof AgentRunError) {
      const definite = definiteStart(err);
      release = definite;
      if (err.code === "busy" && definite) throw err;
      const ctx = { address: dossier.address_resolved?.split(",")[0] ?? "", opa: dossier.opa_account ?? "" };
      const source = adapter.url(ctx);
      if ((err.phase === "poll" || err.phase === "timeout") && err.runId) {
        if (await storeIfTerminal(env, dossierId, sid, err.runId, source)) {
          release = true;
          return;
        }
        // The code is a fixed token, never response text: it says why a paid run went unread.
        console.error("agent run unread", err.phase, err.code);
        await bookAgentRunSpend(env.DB, err.runId, AGENT_SECTION_MAX_USD);
      }
      await storeFailure(env, dossierId, sid, err, definite);
    } else if (!started) {
      // An unclassified start failure may have created a run, so the slot stays held.
      await env.DB.prepare("UPDATE sections SET status='error',error='agent_start_uncertain' WHERE dossier_id=? AND section_id=? AND status='pending'").bind(dossierId,sid).run();
    } else {
      // A retry after a run exists could start a second paid run.
      console.error("agent result storage failed", errorName(err));
      try {
        await env.DB.prepare("UPDATE sections SET status='error',error='agent_result_store_failed' WHERE dossier_id=? AND section_id=? AND status='pending'").bind(dossierId,sid).run();
      } catch (writeError) {
        console.error("agent error storage failed", errorName(writeError));
      }
    }
  } finally {
    if (release) {
      await releaseAgentSlot(env.DB, holder).catch((err) => console.error("agent slot release failed", errorName(err)));
    }
  }
}

/** Reads a run once; stores it when terminal. False when it is still running or the read failed. */
async function storeIfTerminal(
  env: Env,
  dossierId: string,
  sid: SectionId,
  runId: string,
  source: string,
): Promise<boolean> {
  let polled: AgentRun;
  try {
    polled = await agentDeps.get(env, runId, "none", { timeoutMs: POLL_TIMEOUT_MS });
  } catch {
    return false;
  }
  if (!isTerminalStatus(polled.status)) return false;
  const result = await agentDeps.finalize(env, runId, polled, POLL_TIMEOUT_MS);
  await storeRun(env, dossierId, sid, result, source);
  return true;
}

/** Frees the slot when this section still holds it (the holder token includes a per-attempt id). */
async function releaseSectionSlot(env: Env, dossierId: string, sectionId: string): Promise<void> {
  const current = await slotHolder(env.DB);
  const prefix = `${dossierId}:${sectionId}:`;
  if (current?.holder?.startsWith(prefix)) {
    await releaseAgentSlot(env.DB, current.holder)
      .catch((err) => console.error("agent slot release failed", errorName(err)));
  }
}

/** Takes the slot, or reuses it when this section already holds it; null when another section holds it. */
async function holdForSection(env: Env, dossierId: string, sectionId: string): Promise<string | null> {
  const current = await slotHolder(env.DB);
  const prefix = `${dossierId}:${sectionId}:`;
  if (current?.holder?.startsWith(prefix)) return current.holder;
  const holder = `${prefix}${crypto.randomUUID()}`;
  return (await acquireAgentSlot(env.DB, holder)) ? holder : null;
}

/** Resumes a section that already has a TinyFish run id: never starts a second run. */
async function resumeExistingRun(
  env: Env,
  dossierId: string,
  loaded: Awaited<ReturnType<typeof loadAgentSection>>,
  runId: string,
  sleep: (ms: number) => Promise<void>,
): Promise<SectionTurn> {
  const { dossier, adapter } = loaded;
  const sid = adapter.id;
  const ctx = { address: dossier.address_resolved?.split(",")[0] ?? "", opa: dossier.opa_account ?? "" };
  const source = adapter.url(ctx);

  let polled: AgentRun;
  try {
    polled = await agentDeps.get(env, runId, "none", { timeoutMs: POLL_TIMEOUT_MS });
  } catch {
    await upsertSection(env.DB, dossierId, sid, { status: "error", error: "agent_poll_failed" });
    await bookAgentRunSpend(env.DB, runId, AGENT_SECTION_MAX_USD);
    return "done";
  }

  if (isTerminalStatus(polled.status)) {
    const result = await agentDeps.finalize(env, runId, polled, POLL_TIMEOUT_MS);
    await storeRun(env, dossierId, sid, result, source);
    await releaseSectionSlot(env, dossierId, sid);
    return "done";
  }

  // The run is still going and another section holds the slot: look again after the Workflow's sleep.
  const holder = await holdForSection(env, dossierId, sid);
  if (holder === null) return "busy";
  let release = false;
  try {
    const result = await agentDeps.poll(env, runId, {
      pollEveryMs: POLL_MS,
      maxWaitMs: RUN_WAIT_MS,
      sleep,
    });
    release = true;
    await storeRun(env, dossierId, sid, result, source);
  } catch (err) {
    if (err instanceof AgentRunError) {
      if (await storeIfTerminal(env, dossierId, sid, runId, source)) {
        release = true;
        return "done";
      }
      await bookAgentRunSpend(env.DB, runId, AGENT_SECTION_MAX_USD);
      const definite = definiteStart(err);
      release = definite;
      await storeFailure(env, dossierId, sid, err, definite);
    } else {
      throw err;
    }
  } finally {
    if (release) {
      await releaseAgentSlot(env.DB, holder).catch((err) => console.error("agent slot release failed", errorName(err)));
    }
  }
  return "done";
}

/**
 * Makes one try at a pending section. "done" when the section is settled (read, failed, paused or
 * not pending any more); "busy" when another section holds the slot, in which case nothing was
 * started and the caller asks again later. A recorded run is read, never started a second time.
 */
export async function runAgentSection(
  env: Env,
  dossierId: string,
  sectionId: string,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<SectionTurn> {
  const loaded = await loadAgentSection(env, dossierId, sectionId);
  const { dossier, adapter, row } = loaded;
  if (row.status !== "pending") return "done";
  if (row.run_id) return resumeExistingRun(env, dossierId, loaded, row.run_id, opts.sleep ?? sleepDefault);

  const pause = await pauseReason(env, dossier.added_by);
  if (pause) {
    await upsertSection(env.DB, dossierId, adapter.id, {
      status: "unavailable",
      error: pause,
      checked_at: new Date().toISOString(),
    });
    return "done";
  }

  return startRun(env, dossierId, loaded, opts.sleep);
}

/** Finishes a dossier and returns after its best-effort callback; terminal status follows the shared status rule. */
export async function finishAgentSections(env: Env, dossierId: string): Promise<void> {
  const dossier = await getDossier(env.DB, dossierId);
  if (!dossier) throw new Error("dossier_not_found");
  if (dossier.status === "failed") return;
  const state = dossierStatus(dossier.tier, await getSections(env.DB, dossierId));
  // Each section has its own Workflow instance and each one finishes the dossier. Only the one that
  // moves it out of 'partial' goes on to the callback, so the callback is posted once.
  const updated = await env.DB.prepare("UPDATE dossiers SET status=?,completed_at=? WHERE id=? AND status = 'partial'")
    .bind(state.status,state.status === "partial" ? null : new Date().toISOString(),dossierId).run();
  if (!updated.meta.changes) return;
  // A separately requested section or a missing requested row can still leave the dossier partial.
  if (!dossier.callback_url || state.status === "partial") return;
  try {
    const response = await fetch(dossier.callback_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        dossier_id: dossierId,
        status: state.status,
        report_url: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/d/${dossierId}`,
      }),
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error("callback_http_error");
  } catch (err) { console.error("dossier callback failed", errorName(err)); }
}

/** The Workflow operations needed to execute a named step and return after it completes. */
export interface DossierStep {
  do(name: string, config: WorkflowStepConfig, callback: () => Promise<string | void>): Promise<string | void>;
  /** Puts the instance to sleep for `ms` milliseconds; nothing runs and nothing is requested meanwhile. */
  sleep(name: string, ms: number): Promise<void>;
}

/** Marks only a pending row as error and returns; a recorded run must never be started a second time. */
export async function giveUpAgentSection(env: Env, dossierId: string, sectionId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE sections SET status = 'error',
      error = CASE WHEN run_id IS NULL THEN 'agent_not_started' ELSE 'agent_poll_failed' END
      WHERE dossier_id = ? AND section_id = ? AND status = 'pending'`,
  ).bind(dossierId, sectionId).run();
}

/**
 * Runs sections serially and returns after finish; exhausted section retries cannot strand later
 * sections. While another section holds the slot the instance sleeps between tries, so a wait costs
 * no step time and no requests; after SLOT_WAIT_TURNS sleeps the section is given up unstarted.
 */
export async function runDossierSections(
  env: Env,
  payload: { dossierId: string; sections: string[]; evidence?: boolean },
  step: DossierStep,
): Promise<void> {
  if (payload.evidence) {
    for (const id of FREE_SECTION_IDS) {
      try {
        // No retries: a retry could open a second billed browser session.
        await step.do(`evidence:${id}`, {
          retries: { limit: 0, delay: "0 seconds", backoff: "constant" },
          timeout: "2 minutes",
        }, () => screenshotSection(env, payload.dossierId, id));
      } catch {
        // A failed or timed-out screenshot must not stop later evidence or Agent steps.
      }
    }
  }

  for (const id of payload.sections) {
    try {
      for (let turn = 0; ; turn++) {
        const state = await step.do(turn === 0 ? id : `${id}:${turn}`, {
          retries: { limit: 2, delay: "30 seconds", backoff: "constant" },
          timeout: "20 minutes",
        }, () => runAgentSection(env, payload.dossierId, id));
        if (state !== "busy") break;
        if (turn >= SLOT_WAIT_TURNS) throw new Error("agent_slot_wait_expired");
        await step.sleep(`${id}:wait:${turn}`, SLOT_WAIT_MS);
      }
    } catch {
      await step.do(`${id}:give-up`, {}, () => giveUpAgentSection(env, payload.dossierId, id));
    }
  }

  // An evidence-only instance must not run finish: that would move completed_at of a dossier already complete.
  if (payload.sections.length > 0) {
    await step.do("finish", {
      retries: { limit: 2, delay: "30 seconds", backoff: "constant" },
    }, () => finishAgentSections(env, payload.dossierId));
  }
}
