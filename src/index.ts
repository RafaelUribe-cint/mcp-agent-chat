import express from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from './server.js';

const PORT = parseInt(process.env.PORT ?? '3456', 10);
const app = express();
app.use(express.json());

type AnyTransport = StreamableHTTPServerTransport | SSEServerTransport;
const transports = new Map<string, AnyTransport>();

// ── StreamableHTTP — new MCP protocol (2025-11-25) ──────────────────────────
app.all('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (sessionId) {
    // Resume existing session
    const t = transports.get(sessionId);
    if (!(t instanceof StreamableHTTPServerTransport)) {
      res.status(400).json({ error: 'Session not found or uses SSE transport' });
      return;
    }
    await t.handleRequest(req, res, req.body);
    return;
  }

  // New session — must be an initialize request
  if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
    res.status(400).json({ error: 'Expected initialize request to start a session' });
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      transports.set(sid, transport);
      console.error(`[broker] StreamableHTTP session started: ${sid}`);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) {
      transports.delete(transport.sessionId);
      console.error(`[broker] StreamableHTTP session ended: ${transport.sessionId}`);
    }
  };

  await createMcpServer().connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// ── SSE — legacy MCP protocol (2024-11-05), for older clients ───────────────
app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  transports.set(transport.sessionId, transport);
  console.error(`[broker] SSE session started: ${transport.sessionId}`);

  res.on('close', () => {
    transports.delete(transport.sessionId);
    console.error(`[broker] SSE session ended: ${transport.sessionId}`);
  });

  await createMcpServer().connect(transport);
});

app.post('/messages', async (req, res) => {
  const sessionId = req.query['sessionId'] as string;
  const transport = transports.get(sessionId);

  if (!(transport instanceof SSEServerTransport)) {
    res.status(404).json({ error: `SSE session "${sessionId}" not found` });
    return;
  }

  await transport.handlePostMessage(req, res, req.body);
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', activeSessions: transports.size });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.error(`
╔══════════════════════════════════════════════════════╗
║           MCP Agent Chat Broker — running            ║
╠══════════════════════════════════════════════════════╣
║  StreamableHTTP : http://localhost:${PORT}/mcp          ║
║  SSE (legacy)  : http://localhost:${PORT}/sse          ║
║  Health        : http://localhost:${PORT}/health       ║
╠══════════════════════════════════════════════════════╣
║  Add to .mcp.json to use from Claude Code:           ║
╚══════════════════════════════════════════════════════╝
`);
  console.error(JSON.stringify({
    mcpServers: {
      'agent-chat': {
        type: 'streamable-http',
        url: `http://localhost:${PORT}/mcp`,
      },
    },
  }, null, 2));
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.error('\n[broker] Shutting down...');
  for (const [id, t] of transports) {
    try { await t.close(); } catch { /* ignore */ }
    transports.delete(id);
  }
  process.exit(0);
});
