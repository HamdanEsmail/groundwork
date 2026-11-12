// Why a sheet could not be read, in plain words. Every sentence comes from this file: a stored error
// is only ever used to choose one, so nothing an office's page or TinyFish said is printed as is.

const NOT_FINISHED = "The read did not finish. It can be tried again.";

/** What a sheet says when its source was searched and held nothing: that is an answer, but it is not a read record. */
export const NOTHING_FOUND_TEXT = "The source was searched and returned nothing for this address.";

const FIXED: Record<string, string> = {
  blocked: "The office's page turned the automated browser away, or asked it to sign in.",
  unreadable_result: "The page opened, but what came back could not be read as a table.",
  rows_not_read: "The page lists the records, but their rows did not come back in the time allowed.",
  balance_not_read: "The search page was reached, but the read stopped before it got to a balance.",
  "FEMA's map search returned no results in an automated browser": "FEMA's map search gives an automated browser no result.",
  agent_timeout: NOT_FINISHED,
  agent_poll_failed: NOT_FINISHED,
  agent_not_started: NOT_FINISHED,
  agent_start_uncertain: NOT_FINISHED,
  agent_result_store_failed: NOT_FINISHED,
  subrequest_limit: NOT_FINISHED,
  workflow_timeout: NOT_FINISHED,
  workflow_start_failed: NOT_FINISHED,
};

/** What a gap sheet says for a stored section error. */
export function gapReason(error: string | null | undefined): string {
  if (error === "empty_content" || error === "incomplete_after_retries") {
    return "The page did not finish loading in four reads.";
  }
  if (error && /budget pause/i.test(error)) return error;
  if (error && Object.hasOwn(FIXED, error)) return FIXED[error]!;
  if (error && /^agent_(?:failed|cancelled)/.test(error)) return "TinyFish could not finish this read.";
  return "The page could not be read.";
}
