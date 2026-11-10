// Every timestamp the repositories store or compare goes through here. SQL compares the stored
// ISO strings as text, which orders them as time only when they all have the same shape. TinyFish
// reports times to the second ("2026-11-03T09:22:34Z"); ours have milliseconds, and as text
// "...34Z" sorts after "...34.500Z", so a later read could look earlier. Writing every time as
// `toISOString()` (always "YYYY-MM-DDTHH:mm:ss.sssZ", UTC) keeps text order and time order equal.

/** The same instant as `new Date(value).toISOString()`. Throws a RangeError when `value` is not a time. */
export function isoTime(value: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new RangeError(`not a timestamp: ${JSON.stringify(value)}`);
  return new Date(ms).toISOString();
}

/** `isoTime` for a nullable column: null and undefined stay null. */
export function isoTimeOrNull(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : isoTime(value);
}
