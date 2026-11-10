// Serves stored evidence with its original content type and a one-day public cache.
import { Hono } from "hono";
import type { Env } from "../env";

const EVIDENCE_CACHE_SECONDS = 24 * 60 * 60;

export const objectsRouter = new Hono<{ Bindings: Env }>();
objectsRouter.get("/evidence/*", async (c) => {
  let key: string;
  try { key = decodeURIComponent(new URL(c.req.url).pathname.slice("/evidence/".length)); }
  catch { return c.json({ error: "invalid_key" }, 400); }
  // Reject traversal and backslashes so evidence requests stay within the evidence prefix.
  if (!key || key.includes("..") || key.includes("\\")) return c.json({ error: "invalid_key" }, 400);
  const object = await c.env.STORE.get(`evidence/${key}`);
  if (!object) return c.json({ error: "not_found" }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("cache-control", `public, max-age=${EVIDENCE_CACHE_SECONDS}`);
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", "sandbox");
  return new Response(object.body, { headers });
});
