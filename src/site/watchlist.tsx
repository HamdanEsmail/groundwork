// Watched addresses: curated and public watches only. A public one-off lookup
// never appears here.
import { int } from "./format";
import { InnerPage, SheetBlock } from "./inner";
import type { WatchlistData } from "./query";

export function WatchlistPage(props: { data: WatchlistData; pageUrl: string; base: string }) {
  const d = props.data;
  return (
    <InnerPage
      heading="WATCHLIST"
      sentence="Addresses TinyFish Monitor reads twice a day."
      title="Watchlist: Groundwork"
      description="Addresses TinyFish Monitor reads twice a day."
      pageUrl={props.pageUrl}
      base={props.base}
      block={[
        { label: "Watches active", value: int(d.active) },
        { label: "Public slots", value: d.publicSlots },
        { label: "Checks so far", value: int(d.checks) },
        { label: "Changes recorded", value: int(d.changes) },
      ]}
      close
    >
      <SheetBlock title="Watched addresses">
        {d.rows.length === 0 ? (
          <p>No address is watched yet. Open a dossier and choose Watch this address.</p>
        ) : (
          <table class="rec">
            <thead>
              <tr>
                <th>Address</th>
                <th>Sheets</th>
                <th>Last check</th>
                <th>Last change</th>
                <th>Ends</th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((row) => (
                <tr>
                  <td data-l="Address">
                    {row.href ? <a href={row.href}>{row.address}</a> : row.address}
                  </td>
                  <td data-l="Sheets">{row.sheets}</td>
                  <td class="num" data-l="Last check">
                    {row.lastCheck}
                  </td>
                  <td class="num" data-l="Last change">
                    {row.lastChange}
                  </td>
                  <td class="num" data-l="Ends">
                    {row.ends ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SheetBlock>
      <SheetBlock title="What changed">
        {d.events.length === 0 ? (
          <p>No change has been recorded yet. Monitor reads each watched page twice a day.</p>
        ) : (
          <table class="rec">
            <thead>
              <tr>
                <th>Date</th>
                <th>Address</th>
                <th>What changed</th>
                <th>The sheet</th>
              </tr>
            </thead>
            <tbody>
              {d.events.map((e) => (
                <tr>
                  <td class="num" data-l="Date">
                    {e.at}
                  </td>
                  <td data-l="Address">{e.address}</td>
                  <td data-l="What changed">{e.summary}</td>
                  <td data-l="The sheet">{e.sheet}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SheetBlock>
    </InnerPage>
  );
}
