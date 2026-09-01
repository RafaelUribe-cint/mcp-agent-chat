/**
 * Server-app: SSE receiver that spawns Claude CLI to handle messages.
 *
 * Flow per message:
 *   1. Immediately reply "Accepted — processing…"
 *   2. Spawn `claude -p "<content>"`
 *   3. Every STATUS_INTERVAL_MS send a status update to the sender
 *   4. On exit: send the final Claude output (or error)
 *
 * Env vars:
 *   BROKER_URL          — broker base URL (default: http://localhost:3456)
 *   SESSION_NAME        — session name to register as (default: claude-server)
 *   API_KEY             — broker API key (optional)
 *   STATUS_INTERVAL_MS  — ms between status pings (default: 10000)
 *   CLAUDE_SYSTEM       — system prompt passed to `claude --system` (optional)
 */

import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';

interface Message {
  id: string;
  from: string;
  to: string;
  content: string;
  sentAt: number;
  replyTo?: string;
}

const BROKER_URL = (process.env.BROKER_URL ?? 'http://localhost:3456').replace(/\/$/, '');
const SESSION_NAME = process.env.SESSION_NAME ?? 'claude-server';
const API_KEY = process.env.API_KEY ?? '';
const STATUS_INTERVAL_MS = parseInt(process.env.STATUS_INTERVAL_MS ?? '10000', 10);
const CLAUDE_SYSTEM = process.env.CLAUDE_SYSTEM ?? '';
const PROJECT_DIR = process.env.PROJECT_DIR ?? process.cwd();

const HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
};

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function post(path: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL(BROKER_URL + path);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: { ...HEADERS, 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function reply(messageId: string, content: string): Promise<void> {
  await post('/reply', { from: SESSION_NAME, messageId, content });
}

// ── Claude CLI invocation ─────────────────────────────────────────────────────

function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['--print', prompt];
    if (CLAUDE_SYSTEM) args.unshift('--system', CLAUDE_SYSTEM);

    const child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: PROJECT_DIR });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `claude exited with code ${code}`));
      }
    });

    child.on('error', (err) => reject(new Error(`Failed to start claude: ${err.message}`)));
  });
}

// ── Message handler ───────────────────────────────────────────────────────────

async function handleMessage(msg: Message): Promise<void> {
  const start = Date.now();
  console.error(`[server-app] Message from "${msg.from}": ${msg.content.slice(0, 80)}`);

  await reply(msg.id, 'Accepted — processing your request...');

  const interval = setInterval(async () => {
    const elapsed = Math.round((Date.now() - start) / 1000);
    await reply(msg.id, `Still working... (${elapsed}s elapsed)`).catch(() => {});
  }, STATUS_INTERVAL_MS);

  try {
    const result = await runClaude(msg.content);
    clearInterval(interval);
    await reply(msg.id, result);
    console.error(`[server-app] Done (${Math.round((Date.now() - start) / 1000)}s)`);
  } catch (err) {
    clearInterval(interval);
    const message = err instanceof Error ? err.message : String(err);
    await reply(msg.id, `Error: ${message}`);
    console.error(`[server-app] Error:`, message);
  }
}

// ── SSE connection ────────────────────────────────────────────────────────────

function connectSSE(): void {
  const url = new URL(`${BROKER_URL}/events/${encodeURIComponent(SESSION_NAME)}`);
  const lib = url.protocol === 'https:' ? https : http;

  console.error(`[server-app] Connecting to ${url.href}`);

  const req = lib.request(
    {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'GET',
      headers: { Accept: 'text/event-stream', ...HEADERS },
    },
    (res) => {
      if (res.statusCode !== 200) {
        console.error(`[server-app] SSE connect failed: HTTP ${res.statusCode}`);
        scheduleReconnect();
        return;
      }

      console.error(`[server-app] Connected as "${SESSION_NAME}"`);

      let buf = '';
      let currentEvent = '';

      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            const raw = line.slice(5).trim();
            try {
              const msg = JSON.parse(raw) as Message;
              if (currentEvent === 'message') {
                handleMessage(msg).catch((err) =>
                  console.error('[server-app] Unhandled error:', err),
                );
              }
            } catch { /* ignore malformed */ }
            currentEvent = '';
          }
        }
      });

      res.on('end', () => {
        console.error('[server-app] SSE stream ended, reconnecting...');
        scheduleReconnect();
      });

      res.on('error', (err: Error) => {
        console.error('[server-app] SSE stream error:', err.message);
        scheduleReconnect();
      });
    },
  );

  req.on('error', (err: Error) => {
    console.error('[server-app] Connection error:', err.message);
    scheduleReconnect();
  });

  req.end();
}

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleReconnect(ms = 3_000): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSSE();
  }, ms);
}

// ── Boot ──────────────────────────────────────────────────────────────────────

console.error(`[server-app] Starting — session: "${SESSION_NAME}", interval: ${STATUS_INTERVAL_MS}ms`);
connectSSE();

process.on('SIGINT', () => {
  console.error('\n[server-app] Shutting down');
  process.exit(0);
});
