import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertReadOnlySql } from './guard.js';

test('accepts a plain SELECT', () => {
  assert.doesNotThrow(() => assertReadOnlySql('SELECT * FROM messages LIMIT 5'));
});

test('accepts a WITH … SELECT', () => {
  assert.doesNotThrow(() =>
    assertReadOnlySql('WITH t AS (SELECT ts FROM messages) SELECT count(*) FROM t'));
});

test('accepts leading whitespace and trailing semicolon', () => {
  assert.doesNotThrow(() => assertReadOnlySql('  select 1;  '));
});

test('accepts SQL comments before the statement', () => {
  assert.doesNotThrow(() => assertReadOnlySql('-- peek\nSELECT 1'));
  assert.doesNotThrow(() => assertReadOnlySql('/* peek */ SELECT 1'));
});

test('rejects INSERT / UPDATE / DELETE / DDL', () => {
  for (const sql of [
    "INSERT INTO messages VALUES (1)",
    "UPDATE messages SET body = 'x'",
    'DELETE FROM messages',
    'DROP TABLE messages',
    'CREATE TABLE t (x INT)',
    'ALTER TABLE messages ADD COLUMN x INT',
  ]) {
    assert.throws(() => assertReadOnlySql(sql), /read-only/i, sql);
  }
});

test('rejects ATTACH / COPY / PRAGMA / SET / EXPORT / INSTALL / LOAD / CALL', () => {
  for (const sql of [
    "ATTACH 'other.db' AS other",
    "COPY messages TO '/tmp/out.csv'",
    'PRAGMA database_list',
    "SET memory_limit='1GB'",
    "EXPORT DATABASE '/tmp/x'",
    'INSTALL httpfs',
    'LOAD httpfs',
    'CALL pragma_database_list()',
  ]) {
    assert.throws(() => assertReadOnlySql(sql), /read-only/i, sql);
  }
});

test('rejects multiple statements', () => {
  assert.throws(() => assertReadOnlySql('SELECT 1; SELECT 2'), /single/i);
  assert.throws(() => assertReadOnlySql("SELECT 1; DROP TABLE messages"), /single/i);
});

test('semicolons inside string literals do not count as statement breaks', () => {
  assert.doesNotThrow(() => assertReadOnlySql("SELECT * FROM messages WHERE body = 'a;b'"));
});

test('rejects empty input', () => {
  assert.throws(() => assertReadOnlySql(''), /empty/i);
  assert.throws(() => assertReadOnlySql('   '), /empty/i);
});
