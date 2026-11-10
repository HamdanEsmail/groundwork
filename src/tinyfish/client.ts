// The one place every TinyFish HTTP call goes through. It adds the API key,
// records spend after a 2xx, and turns a non-2xx into a TinyFishError. The key
// is read here and nowhere else, and never appears in an error or a log.
import type { Env } from "../env";
import { recordSpend, type SpendKind } from "../core/spend";

export class TinyFishError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "TinyFishError";
    this.status = status;
    this.code = code;
  }
}

export type SpendNote = { kind: SpendKind; amountUsd: number; ref: string };

/** The Agent API allows few concurrent runs and shares them with other builds: after a 429, wait this long... */
export const RATE_LIMIT_WAIT_MS = 60_000;
/** ...and try again at most this many times (so at most four attempts) before giving up as `busy`. */
export const RATE_LIMIT_RETRIES = 3;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function pickString(...values: unknown[]): string | null {
  for (const v of values) if (typeof v === "string" && v !== "") return v;
  return null;
}

/** An upstream error code is a short token. Anything else (a sentence that echoes our request,
 *  a webhook URL with its secret) is not trusted and never reaches a code, a message or a log. */
const ERROR_CODE_SHAPE = /^[A-Za-z0-9_.-]{1,64}$/;

/** `value` when it is a string in the shape of an error code, else null. */
export function errorCodeOrNull(value: unknown): string | null {
  return typeof value === "string" && ERROR_CODE_SHAPE.test(value) ? value : null;
}

// Reads an error response tolerantly: JSON with `error.code` / `code` in the shape of a code,
// else `http_<status>`. The message carries the status and the code and nothing else from the response: an
// upstream body can echo what we sent (a rejected webhook_url holds the webhook secret),
// and error messages end up in logs.
async function errorFrom(res: Response): Promise<TinyFishError> {
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON: there is no code in it
  }
  const obj = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const inner = obj.error !== null && typeof obj.error === "object" ? (obj.error as Record<string, unknown>) : {};
  const code = errorCodeOrNull(pickString(inner.code, obj.code)) ?? `http_${res.status}`;
  return new TinyFishError(res.status, code, `TinyFish HTTP ${res.status} ${code}`);
}

/**
 * Reads a 2xx body as JSON. A body that is not JSON (an HTML maintenance page answered with
 * 200) becomes a TinyFishError with code `bad_json` instead of a bare SyntaxError. Nothing from
 * the body is carried into the error.
 */
export async function readJson<T = unknown>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new TinyFishError(res.status, "bad_json", `TinyFish HTTP ${res.status} bad_json`);
  }
}

export type TinyFishInit = RequestInit & {
  /** Appended to the spend ledger after a 2xx. */
  spend?: SpendNote;
  /**
   * Opt-in, for the Agent start only: on ANY 429 (with or without the `RATE_LIMIT_EXCEEDED`
   * code), wait 60 s and send the same request again, up to 3 retries; still limited after that,
   * throw a TinyFishError with code `busy`. Any other error (a 400, a 500) is thrown at once.
   */
  retryRateLimit?: boolean;
  /** Replaces the real wait (tests). */
  sleep?: (ms: number) => Promise<void>;
};

export async function tinyfishFetch(env: Env, url: string, init: TinyFishInit = {}): Promise<Response> {
  const { spend, retryRateLimit, sleep = realSleep, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("X-API-Key", env.TINYFISH_API_KEY);
  headers.set("Content-Type", "application/json");

  let res = await fetch(url, { ...rest, headers });
  for (let retries = 0; !res.ok; retries++) {
    const err = await errorFrom(res);
    if (!retryRateLimit || err.status !== 429) throw err;
    // The caller turns `busy` into a check `error: "busy"`; there is no response text to carry.
    if (retries >= RATE_LIMIT_RETRIES) throw new TinyFishError(429, "busy", "TinyFish HTTP 429 busy");
    await sleep(RATE_LIMIT_WAIT_MS);
    res = await fetch(url, { ...rest, headers });
  }

  if (spend) {
    // A 2xx is billed and may have created something (a Monitor); a failed ledger write must
    // not discard the response. Only the kind is logged: no key, url or error text.
    try {
      await recordSpend(env.DB, spend.kind, spend.amountUsd, spend.ref);
    } catch {
      console.error("spend write failed", spend.kind);
    }
  }
  return res;
}
