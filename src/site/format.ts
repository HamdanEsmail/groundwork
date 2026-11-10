// Ways of writing dates, counts and money on the pages. Dates are read as UTC
// and never shifted into another calendar day.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function utcParts(iso: string): { y: number; m: number; d: number; hh: number; mm: number } | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const dt = new Date(t);
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth(),
    d: dt.getUTCDate(),
    hh: dt.getUTCHours(),
    mm: dt.getUTCMinutes(),
  };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "17 Sep 1993". Missing or unreadable values print "not stated". */
export function day(iso: string | null | undefined): string {
  if (iso == null || iso.trim() === "") return "not stated";
  const p = utcParts(iso);
  if (p === null) return "not stated";
  return `${p.d} ${MONTHS[p.m]} ${p.y}`;
}

/** "9 Nov 2026, 17:34 UTC". */
export function stamp(iso: string | null | undefined): string {
  if (iso == null || iso.trim() === "") return "not stated";
  const p = utcParts(iso);
  if (p === null) return "not stated";
  return `${p.d} ${MONTHS[p.m]} ${p.y}, ${pad(p.hh)}:${pad(p.mm)} UTC`;
}

/** "723,780". */
export function int(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "not stated";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}

/** "$148,232,900" for whole dollars; "$0.008" for a TinyFish spend figure. */
/** What a dossier cost: under a dollar to the tenth of a cent, as TinyFish bills it; from a dollar up, with its cents. */
export function cost(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "not stated";
  return Math.abs(n) >= 1 ? `$${n.toFixed(2)}` : usd(n);
}

export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "not stated";
  const abs = Math.abs(n);
  let digits = 0;
  if (abs > 0 && abs < 1) digits = 3;
  else if (!Number.isInteger(n) && abs < 1000) digits = 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

/** Cut at a word on `max` characters (150 for an appeal's free text). */
export function words(text: string, max = 150): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > 0 ? cut.slice(0, sp) : cut).trimEnd();
}

/** First letter upper, rest lower. */
export function sentence(text: string): string {
  const t = text.trim();
  if (t === "") return "not stated";
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

/** A missing city field prints "not stated". */
export function stated(value: string | number | null | undefined): string {
  if (value == null) return "not stated";
  const t = String(value).trim();
  return t === "" ? "not stated" : t;
}

/** Only http: and https: URLs become hrefs. */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    if (u.protocol === "http:" || u.protocol === "https:") return u.href;
  } catch {
    /* not a URL */
  }
  return null;
}

/**
 * A waiting clock: minutes and seconds since something was started, as "2:15". Never negative; null when
 * there is no start time. The page's script counts it on between reloads.
 */
export function waitClock(startedAt: string | null | undefined, now: Date): string | null {
  const at = startedAt ? Date.parse(startedAt) : NaN;
  if (Number.isNaN(at)) return null;
  const seconds = Math.max(0, Math.floor((now.getTime() - at) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
