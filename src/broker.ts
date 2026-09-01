import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { Session, Message } from './types.js';

export class MessageBroker {
  private sessions = new Map<string, Session>();
  private queues = new Map<string, Message[]>();
  private sentMessages = new Map<string, Message>();
  private replyWaiters = new Map<string, {
    resolve: (msg: Message) => void;
    reject: (err: Error) => void;
  }>();
  private inboxWaiters = new Map<string, {
    resolve: (msg: Message) => void;
    reject: (err: Error) => void;
  }>();
  private sseClients = new Map<string, Response>();

  // ── SSE stream management ─────────────────────────────────────────────────

  addSSEClient(sessionName: string, res: Response): void {
    this.sseClients.set(sessionName, res);
    // Flush any queued messages that arrived before the stream connected
    const q = this.queues.get(sessionName) ?? [];
    if (q.length > 0) {
      this.queues.set(sessionName, []);
      for (const msg of q) this.pushSSE(res, 'message', msg);
    }
  }

  removeSSEClient(sessionName: string): void {
    this.sseClients.delete(sessionName);
  }

  private pushSSE(res: Response, event: string, data: unknown): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  registerSession(name: string): void {
    this.sessions.set(name, {
      name,
      registeredAt: Date.now(),
      lastSeen: Date.now(),
    });
    if (!this.queues.has(name)) {
      this.queues.set(name, []);
    }
  }

  unregisterSession(name: string): void {
    this.sessions.delete(name);
  }

  listSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  sendMessage(from: string, to: string, content: string): Message {
    const msg: Message = {
      id: randomUUID(),
      from,
      to,
      content,
      sentAt: Date.now(),
    };
    this.sentMessages.set(msg.id, msg);
    // Prefer SSE push, then long-poll waiter, then queue
    const sseClient = this.sseClients.get(to);
    if (sseClient) {
      this.pushSSE(sseClient, 'message', msg);
    } else {
      const inboxWaiter = this.inboxWaiters.get(to);
      if (inboxWaiter) {
        this.inboxWaiters.delete(to);
        inboxWaiter.resolve(msg);
      } else {
        const q = this.queues.get(to) ?? [];
        q.push(msg);
        this.queues.set(to, q);
      }
    }
    return msg;
  }

  replyToMessage(
    from: string,
    messageId: string,
    content: string,
  ): { success: boolean; queued: boolean } {
    const original = this.sentMessages.get(messageId);

    const reply: Message = {
      id: randomUUID(),
      from,
      to: original?.from ?? 'unknown',
      content,
      sentAt: Date.now(),
      replyTo: messageId,
    };

    // If the sender is blocked waiting for a reply, unblock them immediately
    const waiter = this.replyWaiters.get(messageId);
    if (waiter) {
      this.replyWaiters.delete(messageId);
      waiter.resolve(reply);
      return { success: true, queued: false };
    }

    // Otherwise deliver to the original sender's inbox (SSE → long-poll → queue)
    if (original) {
      const sseClient = this.sseClients.get(original.from);
      if (sseClient) {
        this.pushSSE(sseClient, 'reply', reply);
        return { success: true, queued: false };
      }
      const inboxWaiter = this.inboxWaiters.get(original.from);
      if (inboxWaiter) {
        this.inboxWaiters.delete(original.from);
        inboxWaiter.resolve(reply);
        return { success: true, queued: false };
      }
      const q = this.queues.get(original.from) ?? [];
      q.push(reply);
      this.queues.set(original.from, q);
      return { success: true, queued: true };
    }

    return { success: false, queued: false };
  }

  pollMessages(sessionName: string): Message[] {
    this.updateLastSeen(sessionName);
    const messages = this.queues.get(sessionName) ?? [];
    this.queues.set(sessionName, []);
    return messages;
  }

  waitForMessage(sessionName: string, timeoutMs = 60_000): Promise<Message> {
    this.updateLastSeen(sessionName);
    // If something is already queued, return it immediately
    const q = this.queues.get(sessionName) ?? [];
    if (q.length > 0) {
      const msg = q.shift()!;
      this.queues.set(sessionName, q);
      return Promise.resolve(msg);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inboxWaiters.delete(sessionName);
        reject(new Error(`No message received within ${timeoutMs}ms`));
      }, timeoutMs);
      this.inboxWaiters.set(sessionName, {
        resolve: (msg) => { clearTimeout(timer); resolve(msg); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
    });
  }

  waitForReply(messageId: string, timeoutMs = 30_000): Promise<Message> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.replyWaiters.delete(messageId);
        reject(new Error(`No reply after ${timeoutMs}ms`));
      }, timeoutMs);

      this.replyWaiters.set(messageId, {
        resolve: (msg) => { clearTimeout(timer); resolve(msg); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
    });
  }

  updateLastSeen(name: string): void {
    const s = this.sessions.get(name);
    if (s) s.lastSeen = Date.now();
  }
}

// Singleton shared across all MCP connections in this process
export const broker = new MessageBroker();
