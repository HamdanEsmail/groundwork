// Admin authentication. The admin token lifts the public rate limits and opens
// the /api/admin routes. It travels as `Authorization: Bearer <ADMIN_TOKEN>`.
import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "./env";

const encoder = new TextEncoder();

/**
 * Compares two strings without stopping at the first differing byte: it always
 * walks the longer one's full length, and a length mismatch only sets a bit.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  const length = Math.max(x.length, y.length);
  for (let i = 0; i < length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** True when the request carries `Authorization: Bearer <ADMIN_TOKEN>`. False when ADMIN_TOKEN is unset or empty. */
export function isAdmin(c: Context<{ Bindings: Env }>): boolean {
  const expected = c.env.ADMIN_TOKEN;
  if (!expected) return false;
  const header = c.req.header("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  return constantTimeEqual(header.slice("Bearer ".length), expected);
}

/** The visitor's IP for the public rate limits, never stored in the clear: SHA-256 (hex) of
 *  `CF-Connecting-IP` (or "unknown") salted with WEBHOOK_SECRET. */
export async function visitorHash(env: Env, ip: string | undefined): Promise<string> {
  const bytes = encoder.encode(`${env.WEBHOOK_SECRET}|${ip === undefined || ip === "" ? "unknown" : ip}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Rejects the request with 401 `{"error": "admin_required"}` unless it carries the admin token. */
export const adminOnly: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (!isAdmin(c)) return c.json({ error: "admin_required" }, 401);
  await next();
};
