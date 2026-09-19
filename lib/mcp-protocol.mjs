// lib/mcp-protocol.mjs — the subset of MCP a tools-only stdio server needs. Newline-delimited JSON-RPC 2.0.
// Stdout carries only protocol frames; anything human-readable goes to stderr.
import readline from 'node:readline';

export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

export function toToolResult(value) {
  if (value && typeof value === 'object' && Array.isArray(value.content)) return value;
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

export function createServer({ name, version, instructions = '', tools = [] }) {
  const byName = new Map(tools.map((t) => [t.name, t]));

  async function handleOne(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return rpcError(null, -32600, 'Invalid Request');
    const { id, method, params } = msg;
    if (typeof method !== 'string') return null;
    if (id === undefined || id === null) return null;
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        const result = {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: { name, version },
        };
        if (instructions) result.instructions = instructions;
        return rpcResult(id, result);
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, {
          tools: tools.map(({ name: toolName, description, inputSchema, annotations }) => ({
            name: toolName, description, inputSchema, ...(annotations ? { annotations } : {}),
          })),
        });
      case 'tools/call': {
        const tool = byName.get(params?.name);
        if (!tool) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
        try {
          return rpcResult(id, toToolResult(await tool.handler(params?.arguments ?? {})));
        } catch (err) {
          return rpcResult(id, { content: [{ type: 'text', text: `Error: ${err?.message || err}` }], isError: true });
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  return {
    name,
    version,
    instructions,
    tools,
    async handle(msg) {
      if (Array.isArray(msg)) {
        const out = (await Promise.all(msg.map(handleOne))).filter(Boolean);
        return out.length ? out : null;
      }
      return handleOne(msg);
    },
  };
}

export function serve(server, { input = process.stdin, output = process.stdout, onEnd = () => process.exit(0) } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const write = (obj) => { if (obj) output.write(`${JSON.stringify(obj)}\n`); };
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      write(rpcError(null, -32700, 'Parse error'));
      return;
    }
    server.handle(msg).then(write, (err) => write(rpcError(msg?.id ?? null, -32603, `Internal error: ${err?.message || err}`)));
  });
  rl.on('close', onEnd);
  return rl;
}
