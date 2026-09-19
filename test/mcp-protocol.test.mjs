import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createServer, serve, toToolResult, SUPPORTED_PROTOCOLS } from '../lib/mcp-protocol.mjs';

const tools = [
  { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { x: { type: 'string' } } }, annotations: { readOnlyHint: true }, handler: async ({ x }) => ({ x }) },
  { name: 'boom', description: 'boom', inputSchema: { type: 'object' }, handler: async () => { throw new Error('kaboom'); } },
  { name: 'raw', description: 'raw', inputSchema: { type: 'object' }, handler: async () => ({ content: [{ type: 'text', text: 'already shaped' }] }) },
];
const server = createServer({ name: 'jev', version: '0.1.0', instructions: 'use me', tools });
const req = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

test('initialize echoes a supported protocol version and advertises tools', async () => {
  const res = await server.handle(req(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'c', version: '1' } }));
  assert.deepEqual(res, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'jev', version: '0.1.0' }, instructions: 'use me' } });
  const other = await server.handle(req(2, 'initialize', { protocolVersion: '1999-01-01' }));
  assert.equal(other.result.protocolVersion, SUPPORTED_PROTOCOLS[0]);
});

test('ping, tools/list, notifications', async () => {
  assert.deepEqual(await server.handle(req(3, 'ping')), { jsonrpc: '2.0', id: 3, result: {} });
  const list = await server.handle(req(4, 'tools/list'));
  assert.deepEqual(list.result.tools.map((t) => t.name), ['echo', 'boom', 'raw']);
  assert.deepEqual(list.result.tools[0].annotations, { readOnlyHint: true });
  assert.equal(list.result.tools[1].annotations, undefined);
  assert.equal(list.result.tools[0].handler, undefined);
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await server.handle({ jsonrpc: '2.0', id: 9, result: {} }), null);
});

test('tools/call success, tool error, unknown tool, unknown method, invalid request', async () => {
  const ok = await server.handle(req(5, 'tools/call', { name: 'echo', arguments: { x: 'hi' } }));
  assert.deepEqual(ok.result, { content: [{ type: 'text', text: JSON.stringify({ x: 'hi' }, null, 2) }] });
  const err = await server.handle(req(6, 'tools/call', { name: 'boom', arguments: {} }));
  assert.deepEqual(err.result, { content: [{ type: 'text', text: 'Error: kaboom' }], isError: true });
  const raw = await server.handle(req(7, 'tools/call', { name: 'raw' }));
  assert.equal(raw.result.content[0].text, 'already shaped');
  assert.equal((await server.handle(req(8, 'tools/call', { name: 'nope' }))).error.code, -32602);
  assert.equal((await server.handle(req(9, 'resources/list'))).error.code, -32601);
  assert.equal((await server.handle('junk')).error.code, -32600);
});

test('batch arrays are answered element by element', async () => {
  const res = await server.handle([req(10, 'ping'), { jsonrpc: '2.0', method: 'notifications/initialized' }, req(11, 'ping')]);
  assert.deepEqual(res.map((r) => r.id), [10, 11]);
  assert.equal(await server.handle([{ jsonrpc: '2.0', method: 'notifications/initialized' }]), null);
});

test('toToolResult wraps plain values', () => {
  assert.deepEqual(toToolResult('text'), { content: [{ type: 'text', text: 'text' }] });
  assert.deepEqual(toToolResult({ a: 1 }), { content: [{ type: 'text', text: '{\n  "a": 1\n}' }] });
});

test('serve reads lines and writes responses, reports parse errors', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let closed = false;
  serve(server, { input, output, onEnd: () => { closed = true; } });
  const lines = [];
  output.on('data', (chunk) => { for (const l of String(chunk).split('\n')) if (l.trim()) lines.push(JSON.parse(l)); });
  input.write(`${JSON.stringify(req(1, 'ping'))}\n`);
  input.write('this is not json\n');
  input.write('\n');
  input.write(`${JSON.stringify(req(2, 'tools/call', { name: 'echo', arguments: { x: 'y' } }))}\n`);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(lines.find((l) => l.id === 1), { jsonrpc: '2.0', id: 1, result: {} });
  assert.equal(lines.find((l) => l.id === null).error.code, -32700);
  assert.equal(JSON.parse(lines.find((l) => l.id === 2).result.content[0].text).x, 'y');
  input.end();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(closed, true);
});
