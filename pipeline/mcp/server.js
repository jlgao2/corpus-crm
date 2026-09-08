// MCP tool registration — pure wiring, no I/O of its own. The entry point
// (pipeline/mcp-server.js) constructs corpus/annotations and picks a transport.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { INTERACTION_KINDS } from './annotations.js';

function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function tool(fn) {
  return async (args) => {
    try {
      return jsonResult(await fn(args));
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e.message }] };
    }
  };
}

export function buildServer({ corpus, annotations }) {
  const server = new McpServer({ name: 'crm-mcp', version: '0.1.0' });

  server.registerTool('resolve_person', {
    description: 'Find people in the message corpus by name or alias. Returns canonical_id candidates with sources, message volume, has_portrait, and same_as (ids proposed to be the same human on another platform). One person often has several ids across platforms — gather all of them (same_as plus obvious name matches) and pass the set as person_ids to search_messages; check has_portrait to know which fragment carries the portrait for person_summary.',
    inputSchema: { query: z.string().describe('name fragment, case-insensitive') },
  }, tool((a) => corpus.resolvePerson(a)));

  server.registerTool('search_messages', {
    description: 'Search all messages (iMessage, WhatsApp, Instagram, Messenger, Gmail). Matches whole words in visible text by default (URLs ignored); pass match=substring for raw contains. Long bodies are truncated (body_truncated=true) — use get_conversation_window or query for the full text. Timestamps in results are already sender-local — quote them as-is.',
    inputSchema: {
      query: z.string().describe('word or phrase to find, case-insensitive'),
      person_id: z.string().optional().describe('single canonical_id from resolve_person'),
      person_ids: z.array(z.string()).optional().describe('several canonical_ids — use for one human split across platforms'),
      source: z.string().optional().describe('imessage | whatsapp | instagram | messenger | gmail'),
      after: z.string().optional().describe('ISO date YYYY-MM-DD, inclusive'),
      before: z.string().optional().describe('ISO date YYYY-MM-DD, exclusive'),
      limit: z.number().int().positive().max(200).optional(),
      match: z.enum(['word', 'substring']).optional().describe('default word'),
    },
  }, tool((a) => corpus.searchMessages(a)));

  server.registerTool('get_conversation_window', {
    description: 'Fetch the messages around a moment in one thread — use after search_messages to read a hit in context.',
    inputSchema: {
      thread_id: z.string(),
      around_ts: z.number().describe('unix ms anchor, from a search hit'),
      before: z.number().int().min(0).max(200).optional().describe('messages before the anchor (default 20)'),
      after: z.number().int().min(0).max(200).optional().describe('messages after the anchor (default 20)'),
    },
  }, tool((a) => corpus.getConversationWindow(a)));

  server.registerTool('person_summary', {
    description: 'Identity, corpus stats (sources, threads, first/last contact), and the synthesized portrait for one person.',
    inputSchema: { person_id: z.string().describe('canonical_id from resolve_person') },
  }, tool((a) => corpus.personSummary(a)));

  server.registerTool('on_this_day', {
    description: "Every prior year's messages on a given month-day — who the day was spent with, per year, with sampled quotes in sender-local time. Defaults to today. Use get_conversation_window with a sample's thread_id + ts to read any moment in full.",
    inputSchema: {
      date: z.string().optional().describe('MM-DD or YYYY-MM-DD; defaults to today'),
      person_id: z.string().optional().describe('only years with this person (canonical_id)'),
      limit_per_year: z.number().int().positive().max(50).optional().describe('samples per year, default 8'),
    },
  }, tool((a) => corpus.onThisDay(a)));

  server.registerTool('query', {
    description: 'Read-only SQL (single SELECT/WITH) over the whole corpus duckdb — calls, photos, events, places, youtube, email metadata. Use the schema tool first. NOTE: messages.ts_iso is raw UTC; prefer search/window tools for anything you will quote with a time of day.',
    inputSchema: {
      sql: z.string(),
      limit: z.number().int().positive().max(1000).optional().describe('row cap, default 200'),
    },
  }, tool((a) => corpus.runQuery(a)));

  server.registerTool('schema', {
    description: 'List every table and column in the corpus duckdb.',
    inputSchema: {},
  }, tool(() => corpus.getSchema()));

  server.registerTool('log_interaction', {
    description: 'Record a CRM annotation about a person (note, call, meetup…). Writes to crm.sqlite; the person row is created automatically from the corpus identity.',
    inputSchema: {
      person_id: z.string().describe('canonical_id from resolve_person'),
      kind: z.enum(INTERACTION_KINDS),
      body: z.string().optional(),
      occurred_at: z.union([z.number(), z.string()]).optional().describe('unix ms or ISO date; defaults to now'),
    },
  }, tool((a) => annotations.logInteraction(a)));

  server.registerTool('set_follow_up', {
    description: "Set the follow-up reminder text on a person's CRM record.",
    inputSchema: { person_id: z.string(), text: z.string() },
  }, tool((a) => annotations.setFollowUp(a)));

  return server;
}
