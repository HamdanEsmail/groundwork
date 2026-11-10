// One sheet per office, in registry order. Last success uses the same query as
// GET /api/sources. Only http and https URLs become links.
import { AGENT_SECTION_MAX_USD } from "../core/limits";
import { SECTIONS, manualUrlFor } from "../sections/index";
import type { SectionId } from "../sections/types";
import { Facts } from "./components";
import { safeHttpUrl, stamp, usd } from "./format";
import { InnerPage, SheetBlock } from "./inner";

const HOLDS: Record<SectionId, string> = {
  property: "Owner, building, assessed value, last sale",
  zoning: "Zoning district, overlays, pending bills, appeals",
  licenses_inspections: "Recent permits, inspections, violations, appeals, licences",
  deeds: "Parcel, area, recorded deed documents",
  assessment_history: "Assessed value, year by year",
  tax: "Real estate tax balance",
  flood: "Flood zone",
  schools: "Catchment schools",
  li_deep: "Every permit and violation on file",
};

const FLOOD_NOTE =
  "FEMA's map centre refuses automated access with the standard browser. Groundwork does not get around that: the sheet says so and links the manual lookup.";

const HAND = { address: "Philadelphia", opa: "" };

/** The office's own entry page: the atlas home, or the lookup page without the placeholder query. */
function officeHome(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === "atlas.phila.gov") return `${u.origin}/`;
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

export function SourcesPage(props: { lastSuccess: Map<string, string | null>; pageUrl: string; base: string }) {
  return (
    <InnerPage
      heading="NINE SOURCES"
      sentence="Where every sheet comes from, and how it is read."
      title="Nine sources: Groundwork"
      description="Where every sheet comes from, and how it is read."
      pageUrl={props.pageUrl}
      base={props.base}
    >
      {SECTIONS.map((s, i) => {
        const last = props.lastSuccess.get(s.id);
        const href = safeHttpUrl(officeHome(manualUrlFor(s, HAND)));
        const how =
          s.method === "fetch" ? "Fetch at no cost" : `Agent, up to ${usd(AGENT_SECTION_MAX_USD)}`;
        return (
          <SheetBlock title={s.label} no={`Sheet ${i + 1} of 9`}>
            <Facts
              items={[
                { label: "Office", value: s.agency },
                { label: "What it holds", value: HOLDS[s.id] },
                { label: "How it is read", value: how },
                { label: "Monitor", value: s.monitorable ? "Watched" : "Not watched" },
                { label: "Last read", value: last ? stamp(last) : "not read yet" },
                {
                  label: "Look up by hand",
                  value: href ? <a href={href}>{href}</a> : "not stated",
                  kind: "wide",
                },
              ]}
            />
            {s.id === "flood" ? <p>{FLOOD_NOTE}</p> : null}
          </SheetBlock>
        );
      })}
      <SheetBlock title="Not used">
        <p>The atlas Nearby tab is not read: it is JavaScript only, replaced by the events-based nearby view.</p>
        <p>Philly311 is not read: requests are private by policy.</p>
        <p>PhilaDox non-watermarked deeds are not read: they need a paid subscription.</p>
      </SheetBlock>
    </InnerPage>
  );
}
