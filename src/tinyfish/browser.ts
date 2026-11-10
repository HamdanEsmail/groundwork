// TinyBrowser: a full-page screenshot over raw Chrome DevTools Protocol, from inside
// a Worker. A straight port of the verified spike (spikes/worker-shot/src/index.js):
// no Playwright, no Node APIs.
import { PRICES } from "../core/spend";
import type { Env } from "../env";
import { LOADING_PLACEHOLDER } from "./fetch";
import { tinyfishFetch } from "./client";

const BROWSER_API = "https://api.browser.tinyfish.ai";
/** Tallest page captured, in CSS pixels; a longer page is cut at this height. */
export const SCREENSHOT_MAX_HEIGHT = 8000;
const COMMAND_TIMEOUT_MS = 45_000;
const SETTLE_DEADLINE_MS = 25_000;
const SETTLE_POLL_MS = 1_000;
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;
/** Below this size a capture is a blank page, not evidence. */
export const MIN_EVIDENCE_BYTES = 12_000;

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** True when document.readyState is complete, visible text is long enough, and no line is only a Loading placeholder. */
const SETTLE_EXPRESSION = `(() => {
  if (document.readyState !== "complete") return false;
  const text = (document.body && document.body.innerText) ? document.body.innerText : "";
  if (text.length < 200) return false;
  const loading = new RegExp(${JSON.stringify(LOADING_PLACEHOLDER)}, "i");
  for (const line of text.split("\\n")) {
    if (loading.test(line.trim())) return false;
  }
  return true;
})()`;

type CdpReply = { id?: number; result?: unknown; error?: unknown };
type Pending = { resolve: (result: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> };

/**
 * Ends a session by its id. A session is billed by the minute from the moment it is made, so one that
 * cannot be driven over its socket is ended here instead of being left to run out. Best effort: it
 * never hides the error that led here. Ending a session that has already ended is not an error.
 */
async function endSession(env: Env, sessionId: string): Promise<void> {
  if (sessionId === "") return;
  try {
    await tinyfishFetch(env, `${BROWSER_API}/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  } catch {
    console.error("TinyBrowser session could not be ended");
  }
}

export async function screenshotFullPage(
  env: Env,
  url: string,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ bytes: ArrayBuffer; height: number; sessionId: string; settled: boolean }> {
  // Session creation is the billed step, so it records the spend row (one browser-minute).
  const created = await tinyfishFetch(env, BROWSER_API, {
    method: "POST",
    body: JSON.stringify({ url }),
    spend: { kind: "screenshot", amountUsd: PRICES.screenshot, ref: url },
  });
  const session = (await created.json()) as { session_id?: unknown; cdp_url?: unknown };
  const sessionId = typeof session.session_id === "string" ? session.session_id : "";
  if (typeof session.cdp_url !== "string" || session.cdp_url === "") {
    await endSession(env, sessionId);
    throw new Error("TinyBrowser returned no cdp_url");
  }

  // The CDP socket lives on the session's own host and needs no API key.
  let ws: WebSocket;
  try {
    const upgrade = await fetch(session.cdp_url.replace(/^ws/, "http"), { headers: { Upgrade: "websocket" } });
    if (!upgrade.webSocket) throw new Error(`TinyBrowser did not upgrade to a websocket (HTTP ${upgrade.status})`);
    ws = upgrade.webSocket;
    ws.accept();
  } catch (err) {
    await endSession(env, sessionId);
    throw err;
  }

  let nextId = 0;
  const pending = new Map<number, Pending>();
  const failAll = (reason: string) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      pending.delete(id);
    }
  };
  ws.addEventListener("message", (m) => {
    let reply: CdpReply;
    try {
      reply = JSON.parse(String(m.data)) as CdpReply;
    } catch {
      return;
    }
    if (typeof reply.id !== "number") return;
    const p = pending.get(reply.id);
    if (!p) return;
    pending.delete(reply.id);
    clearTimeout(p.timer);
    if (reply.error) p.reject(new Error(`CDP error: ${JSON.stringify(reply.error)}`));
    else p.resolve(reply.result);
  });
  ws.addEventListener("close", () => failAll("TinyBrowser closed the connection"));
  ws.addEventListener("error", () => failAll("TinyBrowser connection error"));

  const send = <T>(method: string, params: Record<string, unknown> = {}, cdpSessionId?: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, COMMAND_TIMEOUT_MS);
      pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timer });
      try {
        ws.send(JSON.stringify({ id, method, params, ...(cdpSessionId ? { sessionId: cdpSessionId } : {}) }));
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

  try {
    const { targetInfos } = await send<{ targetInfos: { type: string; targetId: string }[] }>("Target.getTargets");
    let targetId = targetInfos.find((t) => t.type === "page")?.targetId;
    if (!targetId) {
      targetId = (await send<{ targetId: string }>("Target.createTarget", { url: "about:blank" })).targetId;
    }
    const { sessionId: cdpSession } = await send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await send("Page.enable", {}, cdpSession);
    await send(
      "Emulation.setDeviceMetricsOverride",
      { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: false },
      cdpSession,
    );
    await send("Page.navigate", { url }, cdpSession);
    const sleep = opts.sleep ?? sleepMs;
    let consecutive = 0;
    let settled = false;
    for (let elapsed = 0; elapsed < SETTLE_DEADLINE_MS; elapsed += SETTLE_POLL_MS) {
      await sleep(SETTLE_POLL_MS);
      try {
        const evaluated = await send<{ result?: { value?: unknown } }>(
          "Runtime.evaluate",
          { expression: SETTLE_EXPRESSION, returnByValue: true },
          cdpSession,
        );
        consecutive = evaluated.result?.value === true ? consecutive + 1 : 0;
      } catch {
        consecutive = 0;
      }
      if (consecutive >= 2) {
        settled = true;
        break;
      }
    }
    const metrics = await send<{ cssContentSize?: { height?: number }; contentSize?: { height?: number } }>(
      "Page.getLayoutMetrics",
      {},
      cdpSession,
    );
    const height = Math.min(
      Math.ceil(metrics.cssContentSize?.height || metrics.contentSize?.height || VIEWPORT_HEIGHT),
      SCREENSHOT_MAX_HEIGHT,
    );
    const shot = await send<{ data: string }>(
      "Page.captureScreenshot",
      {
        format: "jpeg",
        quality: 80,
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: VIEWPORT_WIDTH, height, scale: 1 },
      },
      cdpSession,
    );
    // Decoding through fetch keeps CPU time tiny; a JS loop over ~1 MB of base64 would not.
    const bytes = await (await fetch(`data:image/jpeg;base64,${shot.data}`)).arrayBuffer();
    return { bytes, height, sessionId, settled };
  } finally {
    // Always close the browser so billing stops, then the socket.
    try {
      await send("Browser.close");
    } catch {
      // The browser may already be gone, or the socket closed first. Ending it by id costs nothing if so.
      await endSession(env, sessionId);
    }
    try {
      ws.close();
    } catch {
      // already closed
    }
  }
}
