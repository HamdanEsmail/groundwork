// Facts and tables for one sheet, in the manner of the four in the dossier comp.
import type { Child } from "hono/jsx";
import type { DossierDocument } from "../dossier/document";
import { getSection, manualUrlFor } from "../sections/index";
import type { DeedsData, LicensesInspectionsData, PropertyData, SectionId, SectionStatus, ZoningData } from "../sections/types";
import { Evidence, Facts, RecordTable, shownLabel, StatusWord } from "./components";
import { day, int, safeHttpUrl, sentence, stamp, stated, usd, words } from "./format";
import { gapReason } from "./notes";

type SectionDoc = DossierDocument["sections"][keyof DossierDocument["sections"]];

type Json = Record<string, unknown>;

// The Agent parsers store these shapes; they are not on the adapter type yet.
interface YearRow {
  year: number | null;
  market_value_usd: number | null;
  taxable_land_usd: number | null;
  taxable_improvement_usd: number | null;
  exempt_land_usd: number | null;
  exempt_improvement_usd: number | null;
  raw?: Json;
}
interface TaxData {
  balance_usd: number | null;
  delinquent: boolean | null;
  as_of: string | null;
  raw?: Json;
}
interface FloodData {
  flood_zone?: string | null;
  firm_panel?: string | null;
  effective_date?: string | null;
}
interface SchoolRow {
  level: string;
  name: string;
  address?: string | null;
  distance_miles?: number | null;
}
interface DeepList {
  count: number | null;
  rows: { date?: string | null; number?: string; case?: string; type?: string; status?: string }[];
  truncated?: boolean;
}

const REST_BLURB: Record<string, { title: string; blurb: string }> = {
  assessment_history: {
    title: "Assessment history",
    blurb: "The assessed value, year by year. Office of Property Assessment.",
  },
  tax: { title: "Real estate tax", blurb: "The real estate tax balance and any amount overdue. Department of Revenue." },
  flood: { title: "Flood zone", blurb: "The FEMA flood zone of the lot. FEMA." },
  schools: { title: "Catchment schools", blurb: "The catchment schools for the address. School District of Philadelphia." },
  li_deep: {
    title: "Permit and violation history",
    blurb: "Every permit and violation on file, not the latest five. Department of Licenses & Inspections.",
  },
};

function otherMore(shown: number, count: number | null, href: string | null | undefined, extra?: string): Child {
  if (count == null || shown >= count) return extra && safeHttpUrl(href) ? <p class="more">{extra}</p> : null;
  const url = safeHttpUrl(href);
  const n = count - shown;
  if (!url) return null;
  return (
    <p class="more">
      The other {n} are on <a href={url}>the city's own page</a>.{extra ? ` ${extra}` : ""}
    </p>
  );
}

function openWord(status: string): Child {
  const word = sentence(status);
  if (/^(open|failed)$/i.test(status.trim())) return <span class="open">{word}</span>;
  return word;
}

function asJson(data: unknown): Json {
  return data && typeof data === "object" ? (data as Json) : {};
}

export function SheetBody(props: { id: SectionId; sec: SectionDoc }) {
  const data = props.sec.data;
  switch (props.id) {
    case "property":
      return PropertyBody(data as PropertyData | null);
    case "zoning":
      return ZoningBody(data as ZoningData | null, props.sec.source_url);
    case "licenses_inspections":
      return LiBody(data as LicensesInspectionsData | null);
    case "deeds":
      return DeedsBody(data as DeedsData | null, props.sec.source_url);
    case "assessment_history":
      return AssessmentBody(asJson(data));
    case "tax":
      return TaxBody(asJson(data) as unknown as TaxData);
    case "flood":
      return FloodBody(asJson(data) as FloodData);
    case "schools":
      return SchoolsBody(asJson(data));
    case "li_deep":
      return DeepBody(asJson(data));
    default:
      return null;
  }
}

function PropertyBody(d: PropertyData | null): Child {
  const owners = d?.owners?.length ? d.owners.join(", ") : "not stated";
  const mailing = d?.mailing_address?.length ? d.mailing_address.join(", ") : "not stated";
  const sale =
    d?.sale_date != null
      ? `${day(d.sale_date)}, for ${usd(d.sale_price_usd)}`
      : "not stated";
  const homestead = d?.homestead === true ? "Yes" : d?.homestead === false ? "None" : "not stated";
  const area = d?.improvement_area_sqft != null ? `${int(d.improvement_area_sqft)} sq ft` : "not stated";
  return (
    <Facts
      items={[
        { label: "Assessed value", value: usd(d?.assessed_value_usd), kind: "big" },
        { label: "Last sale", value: sale, kind: "big" },
        { label: "Owner", value: owners },
        { label: "Building", value: stated(d?.building_description) },
        { label: "Year built", value: d?.year_built != null ? String(d.year_built) : "not stated" },
        { label: "Building area", value: area },
        { label: "Homestead exemption", value: homestead },
        { label: "Mailing address", value: mailing },
      ]}
    />
  );
}

function floodplainLine(d: ZoningData): string {
  if (d.floodplain_overlay === true) return "Yes";
  const shown = d.overlays?.length ?? 0;
  const total = d.counts?.overlays ?? null;
  if (total !== null && shown < total) return `Not among the ${shown} overlays shown`;
  if (d.floodplain_overlay === false) return "No";
  return "not stated";
}

function ZoningBody(d: ZoningData | null, sourceUrl: string | null): Child {
  const overlays = d?.overlays ?? [];
  const bills = d?.pending_bills ?? [];
  const appeals = d?.appeals ?? [];
  const rcos = d?.rcos ?? [];
  const overlayCount = d?.counts?.overlays ?? overlays.length;
  return (
    <>
      <Facts
        items={[
          { label: "Base district", value: stated(d?.base_district), kind: "big" },
          { label: "District name", value: stated(d?.base_district_name), kind: "big" },
          { label: "Parcels at this address", value: d?.active_parcels != null ? int(d.active_parcels) : "not stated" },
          { label: "Floodplain overlay", value: d ? floodplainLine(d) : "not stated" },
        ]}
      />
      <RecordTable
        heading="Overlays"
        shown={shownLabel(overlays.length, overlayCount)}
        columns={[{ name: "Overlay" }, { name: "Code section", num: true }]}
        rows={overlays.map((o) => [o.name, o.code_section])}
        more={otherMore(overlays.length, overlayCount, sourceUrl)}
      />
      <RecordTable
        heading="Pending bills"
        shown={shownLabel(bills.length, d?.counts?.pending_bills ?? bills.length)}
        columns={[{ name: "Bill", num: true }, { name: "Type" }, { name: "Current zoning", labelled: true }]}
        rows={bills.map((b) => [b.bill, sentence(b.bill_type), b.current_zoning])}
      />
      <RecordTable
        heading="Zoning appeals"
        shown={shownLabel(appeals.length, d?.counts?.appeals ?? appeals.length)}
        columns={[
          { name: "Processed", num: true },
          { name: "Appeal", num: true },
          { name: "Description", labelled: true },
          { name: "Status", labelled: true },
        ]}
        rows={appeals.map((a) => [day(a.processed_date), a.id, words(a.description), sentence(a.status)])}
      />
      <RecordTable
        heading="Registered community organizations"
        shown={shownLabel(rcos.length, d?.counts?.rcos ?? rcos.length)}
        columns={[{ name: "Organization" }]}
        rows={rcos.map((r) => [r.name])}
      />
    </>
  );
}

function LiBody(d: LicensesInspectionsData | null): Child {
  const first = d?.buildings?.[0];
  const viol = d?.violations;
  const openShown = viol && viol.open_count != null ? `${viol.open_count}` : "not stated";
  const allUrl = d?.permits?.all_url ?? null;
  const sheet9 = "Sheet 9 of this dossier reads them all.";
  return (
    <>
      <Facts
        items={[
          { label: "Buildings at this address", value: d?.buildings_count != null ? int(d.buildings_count) : "not stated" },
          { label: "Height, first building", value: first?.height_ft != null ? `${int(first.height_ft)} ft` : "not stated" },
          {
            label: `Open, among the latest ${viol?.open_count_of ?? viol?.recent.length ?? 0} shown`,
            value: viol ? <span class="open">{openShown}</span> : "not stated",
          },
          {
            label: "Footprint, first building",
            value: first?.footprint_sqft != null ? `${int(first.footprint_sqft)} sq ft` : "not stated",
          },
        ]}
      />
      <RecordTable
        heading="Violations"
        shown={shownLabel(viol?.recent?.length ?? 0, viol?.count ?? null)}
        columns={[
          { name: "Date", num: true },
          { name: "Case", num: true },
          { name: "Violation", labelled: true },
          { name: "Status", labelled: true },
        ]}
        rows={(viol?.recent ?? []).map((r) => [day(r.date), r.id, r.description, openWord(r.status)])}
        more={otherMore(viol?.recent?.length ?? 0, viol?.count ?? null, allUrl, sheet9)}
      />
      <RecordTable
        heading="Permits"
        shown={shownLabel(d?.permits?.recent.length ?? 0, d?.permits?.count ?? null)}
        columns={[
          { name: "Date", num: true },
          { name: "Permit", num: true },
          { name: "Work", labelled: true },
          { name: "Status", labelled: true },
        ]}
        rows={(d?.permits?.recent ?? []).map((r) => [day(r.date), r.id, r.description, sentence(r.status)])}
        more={otherMore(d?.permits?.recent.length ?? 0, d?.permits?.count ?? null, allUrl, sheet9)}
      />
      <RecordTable
        heading="Inspections"
        shown={shownLabel(d?.inspections?.recent.length ?? 0, d?.inspections?.count ?? null)}
        columns={[
          { name: "Date", num: true },
          { name: "Case", num: true },
          { name: "Inspection", labelled: true },
          { name: "Result", labelled: true },
        ]}
        rows={(d?.inspections?.recent ?? []).map((r) => [day(r.date), r.id, r.description, openWord(r.status)])}
        more={otherMore(d?.inspections?.recent.length ?? 0, d?.inspections?.count ?? null, allUrl, sheet9)}
      />
      <RecordTable
        heading="Appeals"
        shown={shownLabel(d?.appeals?.recent.length ?? 0, d?.appeals?.count ?? null)}
        columns={[
          { name: "Date", num: true },
          { name: "Appeal", num: true },
          { name: "Type", labelled: true },
          { name: "Status", labelled: true },
        ]}
        rows={(d?.appeals?.recent ?? []).map((r) => [day(r.date), r.id, words(r.type), sentence(r.status)])}
      />
      <RecordTable
        heading="Building certifications"
        shown={shownLabel(d?.certifications?.recent.length ?? 0, d?.certifications?.count ?? null)}
        columns={[
          { name: "Inspected", num: true },
          { name: "Certification" },
          { name: "Result", labelled: true },
          { name: "Expires", num: true, labelled: true },
        ]}
        rows={(d?.certifications?.recent ?? []).map((r) => [day(r.date_inspected), r.type, sentence(r.result), day(r.expiration_date)])}
        more={otherMore(d?.certifications?.recent.length ?? 0, d?.certifications?.count ?? null, allUrl)}
      />
      <RecordTable
        heading="Business licences"
        shown={shownLabel(d?.business_licenses?.recent.length ?? 0, d?.business_licenses?.count ?? null)}
        columns={[
          { name: "Issued", num: true },
          { name: "Licence", num: true },
          { name: "Holder", labelled: true },
          { name: "Status", labelled: true },
        ]}
        rows={(d?.business_licenses?.recent ?? []).map((r) => [day(r.date), r.license_number, r.name, sentence(r.status)])}
        more={otherMore(d?.business_licenses?.recent.length ?? 0, d?.business_licenses?.count ?? null, allUrl)}
      />
    </>
  );
}

function DeedsBody(d: DeedsData | null, sourceUrl: string | null): Child {
  const docs = d?.documents;
  return (
    <>
      <Facts
        items={[
          { label: "Lot area", value: d?.area_sqft != null ? `${int(d.area_sqft)} sq ft` : "not stated", kind: "big" },
          { label: "Perimeter", value: d?.perimeter_ft != null ? `${int(d.perimeter_ft)} ft` : "not stated", kind: "big" },
          { label: "Map registry", value: stated(d?.map_registry), kind: "mono" },
          { label: "Parcel status", value: stated(d?.parcel_status) },
          { label: "Parcel originated", value: day(d?.origination_date) },
          { label: "Condominium", value: d?.is_condo === true ? "Yes" : d?.is_condo === false ? "No" : "not stated" },
        ]}
      />
      <RecordTable
        heading="Recorded documents"
        shown={shownLabel(docs?.recent?.length ?? 0, docs?.count ?? null)}
        columns={[
          { name: "Date", num: true },
          { name: "Document", num: true },
          { name: "Type", labelled: true },
          { name: "Grantor", labelled: true },
          { name: "Grantee", labelled: true },
        ]}
        rows={(docs?.recent ?? []).map((r) => [day(r.date), r.id, sentence(r.type), r.grantor, r.grantee])}
        more={otherMore(docs?.recent?.length ?? 0, docs?.count ?? null, sourceUrl)}
      />
    </>
  );
}

function AssessmentBody(d: Json): Child {
  const years = (d.years as YearRow[] | undefined) ?? [];
  return (
    <RecordTable
      heading="Valuation by year"
      shown={shownLabel(years.length, years.length)}
      columns={[
        { name: "Year", num: true },
        { name: "Market" },
        { name: "Taxable land" },
        { name: "Taxable improvement" },
        { name: "Exempt land" },
        { name: "Exempt improvement" },
      ]}
      rows={years.map((y) => [
        y.year != null ? String(y.year) : "not stated",
        usd(y.market_value_usd),
        usd(y.taxable_land_usd),
        usd(y.taxable_improvement_usd),
        usd(y.exempt_land_usd),
        usd(y.exempt_improvement_usd),
      ])}
    />
  );
}

function TaxBody(d: TaxData): Child {
  return (
    <Facts
      items={[
        { label: "Balance", value: usd(d.balance_usd), kind: "big" },
        { label: "Delinquent", value: d.delinquent === true ? "Yes" : d.delinquent === false ? "No" : "not stated" },
        { label: "As of", value: day(d.as_of) },
      ]}
    />
  );
}

function FloodBody(d: FloodData): Child {
  return (
    <Facts
      items={[
        { label: "Flood zone", value: stated(d.flood_zone), kind: "big" },
        { label: "FIRM panel", value: stated(d.firm_panel) },
        { label: "Effective", value: day(d.effective_date ?? null) },
      ]}
    />
  );
}

function SchoolsBody(d: Json): Child {
  const rows = (d.catchment as SchoolRow[] | undefined) ?? [];
  return (
    <RecordTable
      heading="Catchment"
      shown={shownLabel(rows.length, rows.length)}
      columns={[{ name: "Level" }, { name: "School" }, { name: "Address" }, { name: "Distance" }]}
      rows={rows.map((s) => [
        sentence(s.level),
        s.name,
        stated(s.address),
        s.distance_miles != null ? `${s.distance_miles} mi` : "not stated",
      ])}
    />
  );
}

function DeepBody(d: Json): Child {
  const blocks: { key: "permits" | "violations" | "inspections"; heading: string }[] = [
    { key: "permits", heading: "Permits" },
    { key: "violations", heading: "Violations" },
    { key: "inspections", heading: "Inspections" },
  ];
  return (
    <>
      {blocks.map((b) => {
        const list = d[b.key] as DeepList | undefined;
        if (!list) return null;
        const rows = list.rows ?? [];
        return (
          <RecordTable
            heading={b.heading}
            shown={shownLabel(rows.length, list.count)}
            columns={[
              { name: "Date", num: true },
              { name: "ID", num: true },
              { name: "Type", labelled: true },
              { name: "Status", labelled: true },
            ]}
            rows={rows.map((r) => [day(r.date ?? null), r.number ?? r.case ?? "", stated(r.type), openWord(r.status ?? "")])}
          />
        );
      })}
    </>
  );
}

function headerLine(sec: SectionDoc, ctx: { address: string; opa: string }, id: SectionId): Child {
  const adapter = getSection(id);
  const method = sec.method === "agent" ? "Agent" : "Fetch";
  const source = safeHttpUrl(sec.source_url);
  if (sec.status === "pending") {
    return (
      <p>
        {sec.source}. Being read.
      </p>
    );
  }
  if (sec.status === "ok" || sec.status === "empty") {
    return (
      <p>
        {sec.source}. Read {stamp(sec.checked_at)} with TinyFish {method}.{" "}
        {source ? <a href={source}>Open the source page</a> : null}
      </p>
    );
  }
  const manual = safeHttpUrl((sec as { manual_url?: string }).manual_url ?? (adapter ? manualUrlFor(adapter, ctx) : null));
  return (
    <p>
      {sec.source}. {source ? <a href={source}>Open the source page</a> : null}
      {manual ? (
        <>
          {" "}
          <a href={manual}>Check by hand</a>
        </>
      ) : null}
    </p>
  );
}

export function SheetArticle(props: {
  n: number;
  id: SectionId;
  sec: SectionDoc;
  ctx: { address: string; opa: string };
  delay?: string;
}) {
  const adapter = getSection(props.id);
  const label = adapter?.label ?? props.id;
  const gap = props.sec.status === "error" || props.sec.status === "unavailable";
  return (
    <article class={gap ? "sh gap rise" : "sh rise"} id={props.id} style={props.delay ? `--d:${props.delay}` : undefined}>
      <header>
        <p class="no">Sheet {props.n} of 9</p>
        <h2>{label}</h2>
        <StatusWord status={props.sec.status as SectionStatus} />
        {headerLine(props.sec, props.ctx, props.id)}
      </header>
      {props.sec.status === "pending" ? (
        <p>Being read from {props.sec.source}.</p>
      ) : props.sec.status === "error" || props.sec.status === "unavailable" ? (
        <p>{gapReason((props.sec as { reason?: string }).reason)}</p>
      ) : (
        <>
          {SheetBody({ id: props.id, sec: props.sec })}
          {props.sec.status === "ok" || props.sec.status === "empty" ? (
            <Evidence url={props.sec.evidence_url} label={label} readAt={props.sec.checked_at} />
          ) : null}
        </>
      )}
    </article>
  );
}

export function RestSheet(props: {
  skipped: { id: SectionId; sec: SectionDoc }[];
  ctx: { address: string; opa: string };
  canUpgrade: boolean;
  dossierId: string;
}) {
  if (props.skipped.length === 0) return null;
  const n = props.skipped.length;
  const first = 10 - n;
  const heading = n === 5 ? "Five sheets not read yet" : n === 1 ? "One sheet not read yet" : `${n} sheets not read yet`;
  return (
    <article class="sh rest rise" id="rest">
      <header>
        <p class="no">{n === 5 ? "Sheets 5 to 9" : `Sheets ${first} to 9`}</p>
        <h2>{heading}</h2>
        <span class="state wait">Not read</span>
        <p>These sources have no simple page, so TinyFish Agent opens each one. Nothing below is filled in until it has been read.</p>
      </header>
      <ul>
        {props.skipped.map(({ id, sec }) => {
          const meta = REST_BLURB[id];
          const adapter = getSection(id);
          const manual = safeHttpUrl((sec as { manual_url?: string }).manual_url ?? (adapter ? manualUrlFor(adapter, props.ctx) : null));
          return (
            <li>
              <b>{meta?.title ?? adapter?.label}</b>
              <span>{meta?.blurb}</span>
              {manual ? <a href={manual}>Check by hand</a> : <span />}
            </li>
          );
        })}
      </ul>
      {props.canUpgrade ? (
        <div class="go">
          <form method="post" action={`/d/${props.dossierId}/upgrade`}>
            <button class="btn" type="submit" data-busy="Starting…">
              Read four more sheets
            </button>
          </form>
          <p>Up to $0.90 in TinyFish calls for the four standard sheets. The full permit history is one more read, up to $0.22.</p>
        </div>
      ) : null}
    </article>
  );
}

