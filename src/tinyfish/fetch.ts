// TinyFetch: one page as markdown or cleaned HTML. Free (within 1,000 URLs a day),
// but each call still appends a $0 spend row.
import { FETCH_RETRY_DELAY_MS, FETCH_RETRY_ON_LOADING } from "../core/limits";
import { PRICES } from "../core/spend";
import type { Env } from "../env";
import { isSeparatorRow, tableCells } from "../sections/markdown";
import { TinyFishError, tinyfishFetch } from "./client";

const FETCH_API = "https://api.fetch.tinyfish.ai";
const PER_URL_TIMEOUT_MS = 45_000;

export type FetchPageResult =
  | { ok: true; text: string; title: string | null; finalUrl: string }
  | { ok: false; error: string; status?: number };

type FetchBody = {
  results?: { text?: unknown; title?: unknown; final_url?: unknown }[];
  errors?: { error?: unknown }[];
};

function errorText(entry: { error?: unknown } | undefined): string {
  const e = entry?.error;
  if (typeof e === "string" && e !== "") return e;
  if (e !== null && typeof e === "object") {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") return code;
  }
  return "fetch_error";
}

export async function fetchPage(env: Env, url: string, format: "markdown" | "html"): Promise<FetchPageResult> {
  let body: FetchBody;
  try {
    const res = await tinyfishFetch(env, FETCH_API, {
      method: "POST",
      body: JSON.stringify({
        urls: [url],
        format,
        ttl: 0,
        include_etag_and_last_modified: true,
        per_url_timeout_ms: PER_URL_TIMEOUT_MS,
      }),
      spend: { kind: "fetch", amountUsd: PRICES.fetch, ref: url },
    });
    body = (await res.json()) as FetchBody;
  } catch (err) {
    if (err instanceof TinyFishError) return { ok: false, error: err.code, status: err.status };
    throw err;
  }

  if (body.errors && body.errors.length > 0) return { ok: false, error: errorText(body.errors[0]) };
  const first = body.results?.[0];
  if (!first || typeof first.text !== "string") return { ok: false, error: "no_result" };
  return {
    ok: true,
    text: first.text,
    title: typeof first.title === "string" ? first.title : null,
    finalUrl: typeof first.final_url === "string" && first.final_url !== "" ? first.final_url : url,
  };
}

// --- Atlas reads (Groundwork) ---------------------------------------------------------------

export type AtlasTab = "property" | "li" | "zoning" | "deeds" | "condos";

export type AtlasFetchResult = { ok: true; text: string; url: string } | { ok: false; error: string; url: string };

/** `https://atlas.phila.gov/<encoded address>/<tab>`: the URL fetchAtlas reads and the section adapters show. */
export function atlasUrl(address: string, tab: AtlasTab): string {
  return `https://atlas.phila.gov/${encodeURIComponent(address)}/${tab}`;
}

// "Loading", then optional words, then an optional ellipsis ("Loading buildings", "Loading permits...").
// Words may not hold a period, so a sentence such as "Loading dock repairs were permitted." is not a match.
/** Source of the placeholder line rule; the screenshot settle check evaluates this in the page. */
export const LOADING_PLACEHOLDER = "^loading(?:\\s+[^|.…]+)?\\s*(?:\\.{3}|…)?$";
const LOADING = new RegExp(LOADING_PLACEHOLDER, "i");

/**
 * True when an atlas page was read before its tables loaded: a Loading placeholder, or a
 * "## Name (N)" header with N > 0 and no table data rows before the next "##" header.
 * A placeholder is "Loading <words>" on a line of its own, or a table row whose first cell is
 * that and whose other cells are empty; the word inside a filled row (LOADING DOCK ALTERATION)
 * is data.
 */
export function isIncomplete(text: string): boolean {
  const lines = text.split("\n");
  let counted: { dataRows: number; tableRows: number } | null = null;
  const closeSection = () => counted !== null && counted.dataRows === 0;

  for (const line of lines) {
    if (LOADING.test(line.trim())) return true;
    const cells = tableCells(line);
    if (cells !== null && LOADING.test(cells[0]!) && cells.slice(1).every((c) => c === "")) return true;

    if (/^##\s/.test(line)) {
      if (closeSection()) return true;
      const m = /^##\s+.*\(([\d,]+)\)\s*$/.exec(line.trim());
      counted = m !== null && Number(m[1]!.replace(/,/g, "")) > 0 ? { dataRows: 0, tableRows: 0 } : null;
    } else if (counted !== null && cells !== null) {
      // the first table row is the column header and the next is the "| --- |" separator
      counted.tableRows += 1;
      if (counted.tableRows > 1 && !isSeparatorRow(cells)) counted.dataRows += 1;
    }
  }
  return closeSection();
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Transient TinyFetch failures are retried like an incomplete page: these codes, a timeout
 * code, HTTP 429 or 500 and above, and a thrown network error. A definite answer (a 4xx
 * other than 429, target_unreachable, an unknown code) is returned at once.
 */
const TRANSIENT_FETCH_CODES = new Set(["empty_content", "no_result", "fetch_failed", "bad_json"]);

function isTransientFetchFailure(error: string, status?: number): boolean {
  if (error === "target_unreachable") return false;
  if (status === 429 || (status !== undefined && status >= 500)) return true;
  if (TRANSIENT_FETCH_CODES.has(error)) return true;
  return /timeout/i.test(error);
}

/**
 * One atlas tab as markdown, re-read while it is incomplete or the read failed transiently:
 * up to FETCH_RETRY_ON_LOADING retries, FETCH_RETRY_DELAY_MS apart (four reads in all),
 * one shared count so the worst case does not grow. Still incomplete after the last read is
 * `incomplete_after_retries`; a last transient failure is that error. A definite error is
 * returned at once. `opts.sleep` lets tests skip the waits. With `opts.emptyIsFinal`, an
 * `empty_content` answer is returned at once too: while an address is being resolved it means
 * "no such address in this spelling", not a page that was briefly empty. With
 * `opts.retryUnreachable`, `target_unreachable` is read again as well: for a page of an address
 * the atlas has just served, it is a passing failure. With `opts.holds`, a page that was read
 * and does not hold what the caller expects counts as incomplete.
 */
export async function fetchAtlas(
  env: Env,
  address: string,
  tab: AtlasTab,
  opts: { sleep?: (ms: number) => Promise<void>; emptyIsFinal?: boolean; retryUnreachable?: boolean; holds?: (text: string) => boolean } = {},
): Promise<AtlasFetchResult> {
  const url = atlasUrl(address, tab);
  const sleep = opts.sleep ?? sleepMs;
  let lastError = "incomplete_after_retries";
  for (let retries = 0; ; retries++) {
    let res: FetchPageResult;
    try {
      res = await fetchPage(env, url, "markdown");
    } catch (err) {
      // A network failure or an unreadable body: reported like any other read error, never thrown.
      // Only the error's name is logged: its message can carry request details.
      console.error("fetchAtlas: read threw", err instanceof Error ? err.name : typeof err);
      res = { ok: false, error: "fetch_failed" };
    }
    if (res.ok) {
      if (!isIncomplete(res.text) && (opts.holds?.(res.text) ?? true)) return { ok: true, text: res.text, url };
      lastError = "incomplete_after_retries";
    } else if (
      (isTransientFetchFailure(res.error, res.status) || (opts.retryUnreachable === true && res.error === "target_unreachable")) &&
      !(opts.emptyIsFinal && res.error === "empty_content")
    ) {
      lastError = res.error;
    } else {
      return { ok: false, error: res.error, url };
    }
    if (retries >= FETCH_RETRY_ON_LOADING) return { ok: false, error: lastError, url };
    await sleep(FETCH_RETRY_DELAY_MS);
  }
}
