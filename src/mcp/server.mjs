import { TOOLS } from './tools.mjs';

/**
 * A Model Context Protocol server over stdio, hand-rolled.
 *
 * Why not the official SDK: this tool has one exact-pinned runtime dependency
 * and intends to keep it that way (AGENTS.md rule 8). The surface here is
 * three methods and five read-only tools and will not grow, so the protocol
 * is written out rather than imported. The version is pinned below and the
 * conformance is covered by tests that speak the wire format.
 *
 * JSON-RPC 2.0 framing: one message per line (newline-delimited JSON), which
 * is what stdio transports use. A notification (no `id`) is never answered.
 */
export const PROTOCOL_VERSION = '2025-06-18';

const ERROR = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603 };

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });

/** Everything an agent may ask for, with the version stamped onto each call. */
export function handle(message, { version = '0.0.0' } = {}) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return err(null, ERROR.invalidRequest, 'a request must be a JSON object');
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      return isNotification ? null : ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        // Read-only: no prompts, no resources, no sampling. Saying so is part
        // of the contract — nothing here can change a claims file.
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'testguard', version },
        instructions: 'Read testguard_status first: it carries the one next action. Run the command it names in your own terminal — these tools never run a probe, because a probe is long-running, budgeted, and the person should see it happen.',
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return isNotification ? null : ok(id, {});

    case 'tools/list':
      return isNotification ? null : ok(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } })) });

    case 'tools/call': {
      if (isNotification) return null;
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return err(id, ERROR.invalidParams, `unknown tool: ${params?.name}`);
      try {
        const result = tool.handler({ ...(params?.arguments ?? {}), __version: version });
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false });
      } catch (e) {
        // A tool failure is a tool result, not a protocol error: the agent
        // should read the reason and act, not lose the connection.
        return ok(id, { content: [{ type: 'text', text: `${tool.name} failed: ${e.message}` }], isError: true });
      }
    }

    default:
      return isNotification ? null : err(id, ERROR.methodNotFound, `unknown method: ${method}`);
  }
}

/**
 * Speak the protocol on a pair of streams. Resolves when input ends, so the
 * caller can await a clean shutdown.
 */
export function serve({ input = process.stdin, output = process.stdout, version = '0.0.0' } = {}) {
  return new Promise((resolveDone) => {
    let buffer = '';
    const write = (msg) => {
      if (msg) output.write(JSON.stringify(msg) + '\n');
    };
    input.setEncoding?.('utf8');
    input.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          write(err(null, ERROR.parse, 'invalid JSON'));
          continue;
        }
        try {
          write(handle(message, { version }));
        } catch (e) {
          // The server outlives any single bad request.
          write(err(message?.id ?? null, ERROR.internal, e.message));
        }
      }
    });
    input.on('end', () => resolveDone(0));
    input.on('close', () => resolveDone(0));
  });
}
