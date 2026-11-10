// Lanes of dated records from the sheets that were read. A figure or a mark
// is never invented for a sheet that was not read.
import type { DossierDocument } from "../dossier/document";
import type { DeedsData, LicensesInspectionsData, PropertyData, ZoningData } from "../sections/types";
import { day, sentence, usd } from "./format";

export interface Tick {
  at: number;
  left: string;
  say: string;
  hot: boolean;
}

export interface Lane {
  name: string;
  note: string;
  ticks: Tick[];
}

export interface Timeline {
  startYear: number;
  endYear: number;
  years: { label: string; left: string }[];
  lanes: Lane[];
  readout: string;
}

function isoTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function pct(at: number, start: number, end: number): number {
  if (end <= start) return 0;
  return Math.min(100, Math.max(0, ((at - start) / (end - start)) * 100));
}

function shownNote(shown: number, count: number | null, unit: string): string {
  if (count == null) return `${shown} shown`;
  if (shown < count) return unit === "on file" ? `${count} on file, ${shown} shown` : `${count} ${unit} on file, ${shown} shown`;
  return `${count} on file`;
}

export function buildTimeline(doc: DossierDocument, now = new Date()): Timeline | null {
  const property = doc.sections.property?.status === "ok" ? (doc.sections.property.data as PropertyData | null) : null;
  const deeds = doc.sections.deeds?.status === "ok" ? (doc.sections.deeds.data as DeedsData | null) : null;
  const li =
    doc.sections.licenses_inspections?.status === "ok"
      ? (doc.sections.licenses_inspections.data as LicensesInspectionsData | null)
      : null;
  const zoning = doc.sections.zoning?.status === "ok" ? (doc.sections.zoning.data as ZoningData | null) : null;

  const dated: { t: number; lane: string }[] = [];
  if (property?.sale_date) {
    const t = isoTime(property.sale_date);
    if (t) dated.push({ t, lane: "sale" });
  }
  for (const r of deeds?.documents?.recent ?? []) {
    const t = isoTime(r.date);
    if (t) dated.push({ t, lane: "deeds" });
  }
  for (const r of li?.permits?.recent ?? []) {
    const t = isoTime(r.date);
    if (t) dated.push({ t, lane: "permits" });
  }
  for (const r of li?.inspections?.recent ?? []) {
    const t = isoTime(r.date);
    if (t) dated.push({ t, lane: "inspections" });
  }
  for (const r of li?.violations?.recent ?? []) {
    const t = isoTime(r.date);
    if (t) dated.push({ t, lane: "violations" });
  }
  for (const r of li?.appeals?.recent ?? []) {
    const t = isoTime(r.date);
    if (t) dated.push({ t, lane: "appeals" });
  }
  for (const r of zoning?.appeals ?? []) {
    const t = isoTime(r.processed_date);
    if (t) dated.push({ t, lane: "appeals" });
  }

  const startYear = property?.year_built ?? (dated.length ? new Date(Math.min(...dated.map((d) => d.t))).getUTCFullYear() : null);
  if (startYear == null && dated.length === 0) return null;
  const year = startYear ?? now.getUTCFullYear();
  const endYear = now.getUTCFullYear() + 1;
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(endYear, 0, 1);

  const tick = (iso: string | null | undefined, say: string, hot = false): Tick | null => {
    const t = isoTime(iso);
    if (t == null) return null;
    return { at: t, left: `${pct(t, start, end).toFixed(2)}%`, say, hot };
  };

  const lanes: Lane[] = [];
  if (property || deeds) {
    const ticks: Tick[] = [];
    if (property?.sale_date) {
      const t = tick(property.sale_date, `${day(property.sale_date)} · Sale for ${usd(property.sale_price_usd)}`);
      if (t) ticks.push(t);
    }
    for (const r of deeds?.documents?.recent ?? []) {
      const t = tick(r.date, `${day(r.date)} · Deed document ${r.id}, ${sentence(r.type)}`);
      if (t) ticks.push(t);
    }
    const count = deeds?.documents?.count ?? ticks.length;
    lanes.push({
      name: "Sale and deeds",
      note: shownNote(deeds?.documents?.recent.length ?? 0, count, "documents"),
      ticks,
    });
  }
  if (li) {
    const permitTicks = (li.permits?.recent ?? [])
      .map((r) => tick(r.date, `${day(r.date)} · Permit ${r.id}, ${r.description}, ${sentence(r.status)}`))
      .filter((t): t is Tick => t !== null);
    lanes.push({
      name: "Permits",
      note: shownNote(permitTicks.length, li.permits?.count ?? null, "on file"),
      ticks: permitTicks,
    });
    const inspTicks = (li.inspections?.recent ?? [])
      .map((r) =>
        tick(r.date, `${day(r.date)} · Inspection ${r.id}, ${sentence(r.description)}, ${sentence(r.status)}`, /failed/i.test(r.status)),
      )
      .filter((t): t is Tick => t !== null);
    lanes.push({ name: "Inspections", note: shownNote(inspTicks.length, li.inspections?.count ?? null, "on file"), ticks: inspTicks });
    const violTicks = (li.violations?.recent ?? [])
      .map((r) =>
        tick(r.date, `${day(r.date)} · Violation ${r.id}, ${r.description}, ${sentence(r.status)}`, /open/i.test(r.status)),
      )
      .filter((t): t is Tick => t !== null);
    lanes.push({ name: "Violations", note: shownNote(violTicks.length, li.violations?.count ?? null, "on file"), ticks: violTicks });
    const appealTicks: Tick[] = [];
    for (const r of li.appeals?.recent ?? []) {
      const t = tick(r.date, `${day(r.date)} · Appeal ${r.id}, ${sentence(r.status)}`);
      if (t) appealTicks.push(t);
    }
    if (zoning) {
      for (const r of zoning.appeals ?? []) {
        const t = tick(r.processed_date, `${day(r.processed_date)} · Zoning appeal ${r.id}, ${sentence(r.status)}`);
        if (t) appealTicks.push(t);
      }
    }
    const appealCount = (li.appeals?.count ?? 0) + (zoning?.counts?.appeals ?? zoning?.appeals?.length ?? 0);
    lanes.push({ name: "Appeals", note: `${appealCount} on file`, ticks: appealTicks });
  } else if (zoning && (zoning.appeals?.length ?? 0) > 0) {
    const appealTicks = (zoning.appeals ?? [])
      .map((r) => tick(r.processed_date, `${day(r.processed_date)} · Zoning appeal ${r.id}, ${sentence(r.status)}`))
      .filter((t): t is Tick => t !== null);
    lanes.push({
      name: "Appeals",
      note: `${zoning.counts?.appeals ?? zoning.appeals?.length ?? 0} on file`,
      ticks: appealTicks,
    });
  }

  if (lanes.every((l) => l.ticks.length === 0) && property?.year_built == null) return null;

  const years: { label: string; left: string }[] = [{ label: `Built ${year}`, left: "0%" }];
  const nowYear = now.getUTCFullYear();
  for (let y = Math.ceil((year + 1) / 10) * 10; y < nowYear; y += 10) {
    years.push({ label: String(y), left: `${pct(Date.UTC(y, 0, 1), start, end).toFixed(2)}%` });
  }
  years.push({ label: String(nowYear), left: `${pct(Date.UTC(nowYear, 0, 1), start, end).toFixed(2)}%` });

  const all = lanes.flatMap((l) => l.ticks).sort((a, b) => b.at - a.at);
  return { startYear: year, endYear, years, lanes, readout: all[0]?.say ?? "Point at a mark to read it." };
}

export function figures(doc: DossierDocument): { value: string; line: string; alert?: boolean }[] {
  const out: { value: string; line: string; alert?: boolean }[] = [];
  const property = doc.sections.property?.status === "ok" ? (doc.sections.property.data as PropertyData | null) : null;
  const zoning = doc.sections.zoning?.status === "ok" ? (doc.sections.zoning.data as ZoningData | null) : null;
  const li =
    doc.sections.licenses_inspections?.status === "ok"
      ? (doc.sections.licenses_inspections.data as LicensesInspectionsData | null)
      : null;
  if (property?.assessed_value_usd != null) {
    out.push({ value: usd(property.assessed_value_usd), line: "assessed value, Office of Property Assessment" });
  }
  if (property && (property.improvement_area_sqft != null || property.year_built != null)) {
    const area = property.improvement_area_sqft != null ? intFmt(property.improvement_area_sqft) : null;
    const built = property.year_built != null ? `, built ${property.year_built}` : "";
    if (area) out.push({ value: area, line: `square feet of building${built}` });
  }
  if (zoning?.base_district) {
    const overlays = zoning.counts.overlays;
    const extra = overlays != null ? `, with ${overlays} overlay${overlays === 1 ? "" : "s"}` : "";
    out.push({ value: zoning.base_district, line: `${zoning.base_district_name ?? "zoning district"}${extra}` });
  }
  if (li?.permits?.count != null) {
    const latest = li.permits.recent?.[0];
    const when = latest?.date ? `, the latest issued ${day(latest.date)}` : "";
    out.push({ value: intFmt(li.permits.count), line: `permits on file${when}` });
  }
  if (li?.violations && li.violations.open_count != null) {
    const open = li.violations.open_count;
    const of = li.violations.open_count_of ?? li.violations.recent.length;
    const total = li.violations.count;
    out.push({
      value: `${open} open`,
      line: `among the latest ${of} of ${total ?? of} violations on file`,
      alert: open > 0,
    });
  }
  return out;
}

function intFmt(n: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}

export function splitAddress(resolved: string | null | undefined, input: string | null | undefined): { title: string; city: string } {
  const text = resolved ?? input ?? "";
  const comma = text.indexOf(",");
  if (comma === -1) return { title: text, city: "Philadelphia" };
  return { title: text.slice(0, comma).trim(), city: text.slice(comma + 1).trim().replace(/^PHILADELPHIA/i, (s) => "Philadelphia") };
}
