import { serve } from '../mcp/server.mjs';

export async function mcpCommand({ values, version }, io) {
  if (values.json) {
    // Not a JSON command: it is a long-lived server on stdio, and printing
    // anything to stdout would corrupt the protocol stream.
    io.err('mcp speaks JSON-RPC on stdin/stdout; there is no --json mode');
    return 3;
  }
  await serve({ version });
  return 0;
}
