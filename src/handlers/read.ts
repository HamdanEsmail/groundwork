import { Hono } from "hono";
import { isAdmin } from "../auth";
import { getDossier, listPublicDossiers, listPublicDossiersOf, listPublicOpas, PUBLIC_OPAS_SQL } from "../db/dossiers";
import { listEvents, listEventsForOpa } from "../db/events";
import { getSections } from "../db/sections";
import { toDossierDocument } from "../dossier/document";
import type { Env } from "../env";
import { SECTIONS } from "../sections/index";

export const readRouter = new Hono<{Bindings:Env}>();

readRouter.get("/api/events", async c => {
  const since = c.req.query("since"), address = c.req.query("address");
  if (since && !Number.isFinite(Date.parse(since))) return c.json({error:"invalid_since"},400);
  let opa: string | undefined;
  if (address) {
    const row = await c.env.DB.prepare("SELECT opa_account FROM parcels WHERE opa_account=? OR UPPER(address_resolved)=UPPER(?) LIMIT 1").bind(address,address).first<{opa_account:string}>();
    if (!row) return c.json({events:[]}); opa = row.opa_account;
  }
  const events = await listEvents(c.env.DB,{since,opa,limit:500});
  if (isAdmin(c)) return c.json({events});
  const allowed = await listPublicOpas(c.env.DB);
  return c.json({events: events.filter((e) => e.opa_account !== null && allowed.has(e.opa_account))});
});
readRouter.get("/api/addresses/:opa/history", async c => {
  const opa=c.req.param("opa"), admin=isAdmin(c);
  if (!admin && !(await listPublicOpas(c.env.DB)).has(opa)) return c.json({dossiers:[],events:[]});
  let rows;
  if (admin) {
    const ids=await c.env.DB.prepare("SELECT id FROM dossiers WHERE opa_account=? ORDER BY created_at DESC").bind(opa).all<{id:string}>();
    rows=[]; for (const row of ids.results) { const d=await getDossier(c.env.DB,row.id); if(d) rows.push(d); }
  } else rows=await listPublicDossiersOf(c.env.DB,opa);
  const dossiers=[]; for (const d of rows) dossiers.push(toDossierDocument(d,await getSections(c.env.DB,d.id),c.env.PUBLIC_BASE_URL));
  return c.json({dossiers,events:await listEventsForOpa(c.env.DB,opa)});
});
readRouter.get("/api/sources", async c => {
  const rows=await c.env.DB.prepare("SELECT section_id, MAX(checked_at) AS last_success_at FROM sections WHERE status IN ('ok','empty') GROUP BY section_id").all<{section_id:string;last_success_at:string}>();
  return c.json({sources:SECTIONS.map(s=>({id:s.id,label:s.label,agency:s.agency,method:s.method,monitorable:s.monitorable,last_success_at:rows.results.find(r=>r.section_id===s.id)?.last_success_at ?? null}))});
});
readRouter.get("/api/export.json", async c => {
  const dossiers=[]; for (const d of await listPublicDossiers(c.env.DB)) dossiers.push({...toDossierDocument(d,await getSections(c.env.DB,d.id),c.env.PUBLIC_BASE_URL),events:d.opa_account ? await listEventsForOpa(c.env.DB,d.opa_account) : []});
  return c.json({dossiers});
});
function block(address:string|null):string|null {
  const match=address?.trim().toUpperCase().match(/^(\d+)\s+([^,]+?)(?:,|$)/);
  return match ? `${Math.floor(Number(match[1])/100)} ${match[2]!.trim().replace(/\s+/g," ")}` : null;
}
readRouter.get("/api/dossiers/:id/nearby", async c => {
  const d=await getDossier(c.env.DB,c.req.param("id")); if(!d) return c.json({error:"not_found"},404);
  const target=block(d.address_resolved); if(!target) return c.json({events:[]});
  const parcels=await c.env.DB.prepare(`SELECT p.opa_account,p.address_resolved FROM parcels p WHERE p.opa_account != ? AND p.opa_account IN (${PUBLIC_OPAS_SQL})`).bind(d.opa_account).all<{opa_account:string;address_resolved:string|null}>();
  const accounts=new Set(parcels.results.filter(p=>block(p.address_resolved)===target).map(p=>p.opa_account));
  const events=(await Promise.all([...accounts].map(opa=>listEventsForOpa(c.env.DB,opa)))).flat();
  events.sort((a,b)=>(b.at ?? "").localeCompare(a.at ?? ""));
  return c.json({events:events.slice(0,500)});
});
