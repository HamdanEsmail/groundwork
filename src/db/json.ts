// The one place JSON columns are written and read. A JSON column holds text produced by
// JSON.stringify; the Worker is the only writer, so a value that does not parse is a damaged row.

/** The text to store in a JSON column: SQL NULL for null or undefined, else `JSON.stringify(value)`. */
export function toJson(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/**
 * The parsed value of a stored JSON column; null when the column is NULL or its text does not parse. A
 * failed parse is logged with the column's name (`table.column`), never its value: the text can hold
 * owner names and other record data.
 */
export function parseJsonColumn<T>(text: string | null, column: string): T | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    console.error("stored JSON failed to parse", column);
    return null;
  }
}
