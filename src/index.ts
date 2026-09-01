import express from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from './server.js';
import { broker } from './broker.js';

const PORT = parseInt(process.env.PORT ?? '3456', 10);
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error('[broker] WARNING: API_KEY is not set — server is open to anyone');
}

const app = express();
app.use(express.json());

// Auth middleware — skip /health so Railway's health checks still work
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!API_KEY) return next(); // no key configured → open (dev mode)
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${API_KEY}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
});

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

// ── SSE inbox stream ──────────────────────────────────────────────────────────
// The server app connects here once and receives all inbound messages as events.
app.get('/events/:session', (req, res) => {
  const { session } = req.params;
  broker.registerSession(session);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  broker.addSSEClient(session, res);
  console.error(`[broker] SSE client connected: ${session}`);

  // Keepalive ping every 25 s to prevent proxy timeouts
  const keepalive = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(keepalive);
    broker.removeSSEClient(session);
    console.error(`[broker] SSE client disconnected: ${session}`);
  });
});

// ── HTTP register / reply — used by the server app without MCP ───────────────
app.post('/sessions', (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name) { res.status(400).json({ error: 'name required' }); return; }
  broker.registerSession(name);
  res.json({ ok: true, name });
});

app.post('/send', (req, res) => {
  const { from, to, content } = req.body as { from?: string; to?: string; content?: string };
  if (!from || !to || !content) {
    res.status(400).json({ error: 'from, to, and content are required' });
    return;
  }
  const msg = broker.sendMessage(from, to, content);
  res.json({ ok: true, id: msg.id });
});

app.post('/reply', (req, res) => {
  const { from, messageId, content } = req.body as {
    from?: string; messageId?: string; content?: string;
  };
  if (!from || !messageId || !content) {
    res.status(400).json({ error: 'from, messageId, and content are required' });
    return;
  }
  const result = broker.replyToMessage(from, messageId, content);
  if (!result.success) {
    res.status(404).json({ error: `Message "${messageId}" not found` });
    return;
  }
  res.json({ ok: true, queued: result.queued });
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
