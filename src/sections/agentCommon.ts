// Shared validation and formatting for Agent outputs.
import { usDate } from "./markdown";
import type { AgentSectionData } from "./types";

/** Returns a record for readable objects; arrays and scalar outputs cannot describe a section. */
export function objectResult(value: unknown): AgentSectionData | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as AgentSectionData : null;
}
/** Returns true for optional scalar values of the given types; incorrect types make an output unreadable. */
export function optional(value: unknown, types: string[]): boolean {
  return value == null || types.includes(typeof value);
}
/** Returns whether stop flags have valid types; malformed flags make the source result unreadable. */
export function validStopFlags(data: AgentSectionData): boolean {
  return optional(data.blocked, ["boolean"]) && optional(data.no_results, ["boolean"]);
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** 1 to 12 for a month's full name, its first three letters or "Sept", with or without a full stop. */
function monthNumber(word: string): number | null {
  const w = word.toLowerCase().replace(/\.$/, "");
  const at = MONTHS.findIndex((m) => m === w || m.slice(0, 3) === w || (m === "september" && w === "sept"));
  return at < 0 ? null : at + 1;
}

/**
 * The ISO date of a full date as a page writes it: MM/DD/YYYY, YYYY-MM-DD (the day part of a longer
 * timestamp, as written), "November 3, 2026" or "3 November 2026". Anything less than a full date (a year,
 * a month and a year, a weekday) is null: a day the page did not give is never made up. The page's own
 * words stay available in `raw`.
 */
export function dateValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;
  const stamp = /^(\d{4}-\d{2}-\d{2})[T ]\S/.exec(text);
  if (stamp !== null) return usDate(stamp[1]);
  const named = /^([A-Za-z]+\.?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(text);
  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+\.?),?\s+(\d{4})$/.exec(text);
  const parts = named !== null ? { month: named[1]!, day: named[2]!, year: named[3]! } : dayFirst !== null ? { month: dayFirst[2]!, day: dayFirst[1]!, year: dayFirst[3]! } : null;
  if (parts === null) return usDate(text);
  const month = monthNumber(parts.month);
  return month === null ? null : usDate(`${parts.year}-${String(month).padStart(2, "0")}-${parts.day.padStart(2, "0")}`);
}
/** Returns a numeric page value, or null when it cannot be read without guessing. */
export function numberValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !/^\s*\$?-?[\d,]+(?:\.\d+)?\s*$/.test(value)) return null;
  return Number(value.replace(/[$,\s]/g, ""));
}
/** Returns shared instructions so each source stops on blocked pages and avoids inventing data. */
export function instructions(url: string): string {
  return `Start at ${url}. Do not use any other website. Do not download files or guess values not shown. ` +
    "On an access-denied, captcha or error page stop and return blocked: true and the page's message. " +
    "When the search returns nothing return no_results: true. Return numeric values as shown on the page.";
}
/** Returns common status for blocked and empty outputs; blocked results never masquerade as successful reads. */
export function classify(data: AgentSectionData, empty: boolean): { status: "ok" | "empty" | "unavailable"; reason?: string } {
  if (data.blocked === true) return { status: "unavailable", reason: "blocked" };
  return { status: empty || data.no_results === true ? "empty" : "ok" };
}
/** Returns a JSON schema with common stop flags; source fields carry their own types. */
export function schema(properties: Record<string, object>): object {
  return { type: "object", properties: { blocked: { type: "boolean" }, no_results: { type: "boolean" },
    error_message: { type: "string", nullable: true }, ...properties } };
}
