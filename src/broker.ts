import { randomUUID } from 'node:crypto';
import type { Session, Message } from './types.js';

export class MessageBroker {
  private sessions = new Map<string, Session>();
  private queues = new Map<string, Message[]>();
  private sentMessages = new Map<string, Message>();
  private replyWaiters = new Map<string, {
    resolve: (msg: Message) => void;
    reject: (err: Error) => void;
  }>();

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
    const q = this.queues.get(to) ?? [];
    q.push(msg);
    this.queues.set(to, q);
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

    // Otherwise drop the reply into the original sender's inbox
    if (original) {
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
