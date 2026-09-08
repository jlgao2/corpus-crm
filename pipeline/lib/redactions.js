// Redactions — messages Demo has asked to keep out of derived output.
//
// These lines stay in messages.duckdb and in the raw exports: the archive is the
// record of what was actually said and is not falsified. What this list controls
// is what gets *carried out* of the database — into extracts, lens corpora,
// portrait prep, and anything fed to an LLM.
//
// Add a pattern here rather than deleting from the database.

/** Plain-text terms mirrored into SQL. Keep in sync with REDACTIONS. */
export const REDACTION_TERMS = ['redacted-topic'];

export const REDACTIONS = [
  // Replace this with your own topics — one line each. The placeholder is
  // kept so the mechanism ships switched on, and is covered by the tests.
  /redacted-topic/i,
];

/** True if this message body must not leave the database. */
export function isRedacted(body) {
  if (!body) return false;
  return REDACTIONS.some((re) => re.test(body));
}

/** Drop redacted rows from a result set. `get` reads the body off a row. */
export function filterRedacted(rows, get = (r) => r.body) {
  return rows.filter((r) => !isRedacted(get(r)));
}

/** A SQL predicate for the same rule, for queries that filter in the database. */
export function redactionSql(column = 'body') {
  const terms = REDACTION_TERMS;
  return terms.map((t) => `${column} NOT ILIKE '%${t}%'`).join(' AND ');
}
