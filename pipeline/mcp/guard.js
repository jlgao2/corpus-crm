// Read-only SQL guard for the MCP `query` escape hatch.
//
// The duckdb connection is opened READ_ONLY anyway; this guard exists so a
// disallowed statement fails with a clear message before touching the engine,
// and so statements that are "read-only-ish" but reach outside the database
// (ATTACH, COPY, INSTALL, LOAD, SET, PRAGMA, CALL, EXPORT) are refused too.

/**
 * Strip SQL comments and split on statement-terminating semicolons, ignoring
 * semicolons inside 'string literals' and "quoted identifiers".
 * Returns the list of non-empty statements.
 */
function splitStatements(sql) {
  const statements = [];
  let current = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      while (i < sql.length && sql[i] !== '\n') i++;
    } else if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (ch === "'" || ch === '"') {
      const quote = ch;
      current += ch; i++;
      while (i < sql.length) {
        current += sql[i];
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { current += sql[++i]; i++; continue; }
          i++; break;
        }
        i++;
      }
    } else if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = ''; i++;
    } else {
      current += ch; i++;
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

/** Throw unless `sql` is a single read-only SELECT/WITH statement. */
export function assertReadOnlySql(sql) {
  const statements = splitStatements(String(sql ?? ''));
  if (statements.length === 0) throw new Error('empty SQL');
  if (statements.length > 1) throw new Error('single statement only');
  const first = statements[0].match(/^[A-Za-z]+/)?.[0]?.toUpperCase();
  if (first !== 'SELECT' && first !== 'WITH') {
    throw new Error(`read-only: only SELECT/WITH statements are allowed (got ${first || 'nothing'})`);
  }
}
