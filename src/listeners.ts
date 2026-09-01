import Anthropic from '@anthropic-ai/sdk';
import { broker } from './broker.js';

interface Listener {
  sessionName: string;
  instructions: string;
  model: string;
  active: boolean;
  messagesHandled: number;
}

const activeListeners = new Map<string, Listener>();

function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set on the broker — cannot run autonomous listener');
  }
  return new Anthropic();
}

export async function startListener(
  sessionName: string,
  instructions: string,
  model = 'claude-opus-5',
): Promise<void> {
  if (activeListeners.has(sessionName)) {
    throw new Error(`Listener already running for "${sessionName}"`);
  }

  broker.registerSession(sessionName);

  const listener: Listener = { sessionName, instructions, model, active: true, messagesHandled: 0 };
  activeListeners.set(sessionName, listener);

  runLoop(listener).catch((err) => {
    console.error(`[listener:${sessionName}] Fatal error:`, err);
    activeListeners.delete(sessionName);
  });
}

async function runLoop(listener: Listener): Promise<void> {
  console.error(`[listener:${listener.sessionName}] Started (model: ${listener.model})`);
  const client = getClient();

  while (listener.active) {
    try {
      const msg = await broker.waitForMessage(listener.sessionName, 60_000);
      if (!listener.active) break;

      console.error(`[listener:${listener.sessionName}] Message from "${msg.from}"`);

      const response = await client.messages.create({
        model: listener.model,
        max_tokens: 8192,
        system: listener.instructions,
        messages: [{ role: 'user', content: `[From: ${msg.from}]\n\n${msg.content}` }],
      });

      const replyText = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');

      broker.replyToMessage(listener.sessionName, msg.id, replyText);
      listener.messagesHandled++;
      console.error(`[listener:${listener.sessionName}] Replied (total: ${listener.messagesHandled})`);

    } catch (err) {
      if (!listener.active) break;
      const error = err as Error;
      if (error.message.includes('No message received')) continue; // timeout, loop again
      console.error(`[listener:${listener.sessionName}] Error:`, error.message);
      await new Promise((r) => setTimeout(r, 2_000)); // brief backoff on API errors
    }
  }

  console.error(`[listener:${listener.sessionName}] Stopped`);
}

export function stopListener(sessionName: string): boolean {
  const listener = activeListeners.get(sessionName);
  if (!listener) return false;
  listener.active = false;
  activeListeners.delete(sessionName);
  return true;
}

export function listListeners(): Array<{ sessionName: string; model: string; messagesHandled: number }> {
  return Array.from(activeListeners.values()).map(({ sessionName, model, messagesHandled }) => ({
    sessionName,
    model,
    messagesHandled,
  }));
}
