// Streamable-HTTP mode for the crm-mcp server — tailnet serving.
//
// Stateless: each POST /mcp gets a fresh transport + server instance wired to
// the shared corpus/annotations (registration is cheap; the expensive handles
// live in corpus/annotations). Bearer-token auth runs before anything MCP.

import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer } from './server.js';

/**
 * @param {object} opts
 * @param {object} opts.corpus       from createCorpus
 * @param {object} opts.annotations  from createAnnotations
 * @param {string} opts.token        required bearer token
 * @param {number} opts.port         0 = ephemeral
 * @param {string[]} opts.hosts      interfaces to bind (e.g. 127.0.0.1 + tailscale IP)
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export async function startHttpServer({ corpus, annotations, token, port, hosts }) {
  if (!token) throw new Error('MCP_TOKEN is required for HTTP mode');
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.use('/mcp', (req, res, next) => {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${token}`) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  app.post('/mcp', async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => transport.close());
    const server = buildServer({ corpus, annotations });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // Stateless mode has no sessions to GET/DELETE.
  app.get('/mcp', (_req, res) => res.status(405).end());
  app.delete('/mcp', (_req, res) => res.status(405).end());

  const listeners = [];
  let boundPort = port;
  for (const host of hosts) {
    // Don't pass a callback to app.listen — Express invokes it even when the
    // bind fails, resolving with a dead server. Wait for 'listening' instead.
    const l = await new Promise((resolve, reject) => {
      const srv = app.listen(boundPort, host);
      srv.once('listening', () => resolve(srv));
      srv.once('error', reject);
    });
    boundPort = l.address().port; // ephemeral port resolves on first bind, reused for the rest
    listeners.push(l);
    console.error(`[crm-mcp] http://${host}:${boundPort}/mcp`);
  }

  return {
    port: boundPort,
    close: () => Promise.all(listeners.map((l) => new Promise((r) => l.close(r)))),
  };
}
