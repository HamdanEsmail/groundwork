// "Change only the fields I give you" as one fixed SQL text per table. A field left out of the
// object (undefined) keeps its stored value; a field given as null is cleared. Each column gets
// a value parameter and a "given" flag parameter, and the statement picks between the new value
// and the stored one with CASE, so no column name is ever built from a caller's value and the
// text is the same for every call.
import { toJson } from "./json";
import { isoTimeOrNull } from "./time";

/** How a value is written to its column. */
export type Encode = (value: never) => string | number | null;

export interface Field {
  readonly name: string;
  readonly encode: Encode;
  /** The column is never NULL: a null given for it is rejected (a TypeError), and an insert must give it. */
  readonly required: boolean;
  /** A literal SQL value (not a caller's) an upsert inserts when the field is not given, so a new row never has NULL here. */
  readonly insertDefault?: string;
}

/** Text, numbers and ids as they are; null for null. */
export const plain: Encode = (value: string | number | null) => value;
/** A timestamp, stored as millisecond ISO. Throws a RangeError on text that is not a time. */
export const time: Encode = (value: string | null) => isoTimeOrNull(value);
/** A JSON column: `JSON.stringify` of the value, SQL NULL for null. */
export const json: Encode = (value: unknown) => toJson(value);

export const field = (name: string, encode: Encode = plain, opts: { required?: boolean; insertDefault?: string } = {}): Field => ({
  name,
  encode,
  required: opts.required ?? false,
  ...(opts.insertDefault === undefined ? {} : { insertDefault: opts.insertDefault }),
});

/**
 * `UPDATE <table> SET c = CASE WHEN <given> THEN <value> ELSE c END, ... WHERE <key> = ?1`.
 * ?1 is the key, ?2.. the values, then one flag per field.
 */
export function updateSql(table: string, keyColumn: string, fields: readonly Field[]): string {
  const n = fields.length;
  const sets = fields.map((f, i) => `${f.name} = CASE WHEN ?${2 + n + i} THEN ?${2 + i} ELSE ${f.name} END`);
  return `UPDATE ${table} SET ${sets.join(", ")} WHERE ${keyColumn} = ?1`;
}

/**
 * Insert a row with the given fields (the rest NULL), or, when the key exists, change only the given
 * fields. ?1..?k are the key columns, then the values, then one flag per field.
 */
export function upsertSql(table: string, keyColumns: readonly string[], fields: readonly Field[]): string {
  const k = keyColumns.length;
  const n = fields.length;
  const columns = [...keyColumns, ...fields.map((f) => f.name)];
  const values = columns.map((_, i) => {
    const insertDefault = i < k ? undefined : fields[i - k]!.insertDefault;
    return insertDefault === undefined ? `?${1 + i}` : `COALESCE(?${1 + i}, ${insertDefault})`;
  });
  const sets = fields.map((f, i) => `${f.name} = CASE WHEN ?${1 + k + n + i} THEN excluded.${f.name} ELSE ${table}.${f.name} END`);
  return (
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${values.join(", ")}) ` +
    `ON CONFLICT (${keyColumns.join(", ")}) DO UPDATE SET ${sets.join(", ")}`
  );
}

/**
 * The encoded values of `given`, in the order of `fields` (null where a field is not given). Throws when
 * `given` has a key that is not one of `fields`, so a misspelt or forbidden column fails loudly instead of
 * being dropped; `what` names the operation and `verb` is the word the message uses ("patchable" for an
 * update, "writable" for an insert or upsert).
 */
export function encodeValues(
  fields: readonly Field[],
  given: object,
  what: string,
  verb: "patchable" | "writable",
): (string | number | null)[] {
  const names = new Set(fields.map((f) => f.name));
  for (const key of Object.keys(given)) {
    if (!names.has(key)) throw new TypeError(`${what}: "${key}" is not ${verb}`);
  }
  const record = given as Record<string, unknown>;
  for (const f of fields) {
    if (f.required && record[f.name] === null) throw new TypeError(`${what}: "${f.name}" cannot be null`);
  }
  return fields.map((f) => (record[f.name] === undefined ? null : (f.encode as (v: unknown) => string | number | null)(record[f.name])));
}

/** For an insert: throws when a required field with no default is missing from `given`. */
export function requireGiven(fields: readonly Field[], given: object, what: string): void {
  const record = given as Record<string, unknown>;
  for (const f of fields) {
    if (f.required && f.insertDefault === undefined && record[f.name] === undefined) {
      throw new TypeError(`${what}: "${f.name}" cannot be null`);
    }
  }
}

/** The bind values for `updateSql` / `upsertSql`: the keys, the encoded values, then one given flag per field. */
export function bindFields(
  keys: readonly (string | number)[],
  fields: readonly Field[],
  given: object,
  what: string,
  verb: "patchable" | "writable",
): (string | number | null)[] {
  const values = encodeValues(fields, given, what, verb);
  const record = given as Record<string, unknown>;
  const flags = fields.map((f) => (record[f.name] === undefined ? 0 : 1));
  return [...keys, ...values, ...flags];
}
