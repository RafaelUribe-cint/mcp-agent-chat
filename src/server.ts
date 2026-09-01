import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { broker } from './broker.js';

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'mcp-agent-chat', version: '1.0.0' });

  server.registerTool('register_session', {
    description:
      'Register this Claude session with a unique name so others can find and message you. ' +
      'Call this before using any other tool.',
    inputSchema: {
      name: z.string().describe('Unique session name (e.g. "researcher", "coder", "session-A")'),
    },
  }, async ({ name }) => {
    broker.registerSession(name);
    return {
      content: [{
        type: 'text' as const,
        text: `Session "${name}" registered. Others can now send you messages.`,
      }],
    };
  });

  server.registerTool('unregister_session', {
    description: 'Unregister this session from the broker when you are done.',
    inputSchema: {
      name: z.string().describe('Your session name'),
    },
  }, async ({ name }) => {
    broker.unregisterSession(name);
    return { content: [{ type: 'text' as const, text: `Session "${name}" unregistered.` }] };
  });

  server.registerTool('list_sessions', {
    description: 'List all currently registered sessions.',
    inputSchema: {},
  }, async () => {
    const sessions = broker.listSessions();
    if (sessions.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No sessions currently registered.' }] };
    }
    const text = sessions
      .map((s) => `• ${s.name} — last seen ${new Date(s.lastSeen).toLocaleTimeString()}`)
      .join('\n');
    return { content: [{ type: 'text' as const, text: `Active sessions:\n${text}` }] };
  });

  server.registerTool('send_message', {
    description:
      'Send a message to another registered session. ' +
      'Set wait_for_reply=true to block until the recipient calls reply_message (or until timeout_ms).',
    inputSchema: {
      from: z.string().describe('Your session name'),
      to: z.string().describe('Recipient session name'),
      content: z.string().describe('Message content'),
      wait_for_reply: z
        .boolean()
        .optional()
        .describe('If true, block until the recipient replies. Default: false'),
      timeout_ms: z
        .number()
        .optional()
        .describe('Timeout in ms when wait_for_reply=true. Default: 30000'),
    },
  }, async ({ from, to, content, wait_for_reply = false, timeout_ms = 30_000 }) => {
    const msg = broker.sendMessage(from, to, content);

    if (!wait_for_reply) {
      return {
        content: [{
          type: 'text' as const,
          text: [
            `Message delivered to "${to}" inbox.`,
            `Message ID: ${msg.id}`,
            '',
            `The recipient can call poll_messages to read it,`,
            `then reply_message(message_id="${msg.id}") to respond.`,
            `You can also poll_messages to pick up any non-blocking replies later.`,
          ].join('\n'),
        }],
      };
    }

    try {
      const reply = await broker.waitForReply(msg.id, timeout_ms);
      return {
        content: [{
          type: 'text' as const,
          text: `Reply from "${reply.from}":\n\n${reply.content}`,
        }],
      };
    } catch {
      return {
        isError: true,
        content: [{
          type: 'text' as const,
          text: `No reply within ${timeout_ms}ms. Message was delivered (ID: ${msg.id}); ` +
                `any late reply will land in your inbox — use poll_messages to check.`,
        }],
      };
    }
  });

  server.registerTool('poll_messages', {
    description:
      'Check your inbox for new messages. Clears the queue after reading. ' +
      'Also picks up replies to send_message calls where wait_for_reply was false.',
    inputSchema: {
      session_name: z.string().describe('Your session name'),
    },
  }, async ({ session_name }) => {
    const messages = broker.pollMessages(session_name);
    if (messages.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No new messages.' }] };
    }
    const divider = '─'.repeat(40);
    const text = messages
      .map((m) => {
        const lines = [
          `From:    ${m.from}`,
          `ID:      ${m.id}`,
          m.replyTo ? `Reply to: ${m.replyTo}` : null,
          `Time:    ${new Date(m.sentAt).toLocaleTimeString()}`,
          '',
          m.content,
        ].filter(Boolean) as string[];
        return lines.join('\n');
      })
      .join(`\n\n${divider}\n\n`);
    return {
      content: [{
        type: 'text' as const,
        text: `${messages.length} message(s):\n\n${text}`,
      }],
    };
  });

  server.registerTool('reply_message', {
    description:
      'Reply to a specific message by its ID. ' +
      'If the sender called send_message with wait_for_reply=true, they will be unblocked immediately.',
    inputSchema: {
      from: z.string().describe('Your session name'),
      message_id: z.string().describe('ID of the message to reply to (from poll_messages output)'),
      content: z.string().describe('Reply content'),
    },
  }, async ({ from, message_id, content }) => {
    const result = broker.replyToMessage(from, message_id, content);
    if (!result.success) {
      return {
        isError: true,
        content: [{
          type: 'text' as const,
          text: `Message ID "${message_id}" not found. It may have expired or never existed.`,
        }],
      };
    }
    const detail = result.queued
      ? 'Sender was not blocking — reply queued in their inbox.'
      : 'Sender was waiting — unblocked immediately.';
    return { content: [{ type: 'text' as const, text: `Reply sent. ${detail}` }] };
  });

  return server;
}
