import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTail, parseEntries, currentTurn, analyzeTurn, handbackReport, turnCwd } from '../lib/transcript.mjs';

const CWD = '/work/app';
const user = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const userBlocks = (text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
const result = (id = 't') => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const tool = (name, input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name, input }] } });
const edit = (file) => tool('Edit', { file_path: path.join(CWD, file), old_string: 'a', new_string: 'b' });
const bash = (command) => tool('Bash', { command });
const say = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

test('readTail and parseEntries tolerate missing files, partial first lines, and junk', () => {
  assert.equal(readTail('/nonexistent/transcript.jsonl'), '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-transcript-'));
  const file = path.join(dir, 't.jsonl');
  const lines = [user('first'), edit('src/a.ts'), 'not json', bash('npm test')].map((l) => (typeof l === 'string' ? l : JSON.stringify(l)));
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  assert.equal(parseEntries(readTail(file)).length, 3);
  const size = fs.statSync(file).size;
  const tail = readTail(file, size - 5);
  assert.ok(!tail.startsWith('{"type":"user"'), 'partial first line is dropped');
  assert.equal(parseEntries(tail).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('currentTurn starts after the last human text message and ignores tool results and meta entries', () => {
  const entries = [user('old request'), edit('src/old.ts'), result(), user('new request'), edit('src/a.ts'), result(), { ...userBlocks('<system-reminder>x</system-reminder>'), isMeta: true }, bash('ls')];
  const turn = currentTurn(entries);
  assert.equal(turn.length, 4);
  assert.deepEqual(analyzeTurn(turn, { cwd: CWD }).edits, ['src/a.ts']);
  assert.equal(currentTurn([userBlocks('only text blocks'), edit('src/b.ts')]).length, 1);
  assert.deepEqual(currentTurn([]), []);
});

test('analyzeTurn finds project code edits and whether verification ran after the last one', () => {
  const unverified = analyzeTurn([edit('src/a.ts'), result(), edit('src/b.ts'), say('done')], { cwd: CWD });
  assert.deepEqual(unverified, { edits: ['src/a.ts', 'src/b.ts'], verifiedAfterEdit: false, verification: null });

  assert.equal(analyzeTurn([edit('src/a.ts'), bash('npm test 2>&1 | tail -5')], { cwd: CWD }).verification, 'bash');
  assert.equal(analyzeTurn([edit('src/a.ts'), bash('cd api && npx vitest run')], { cwd: CWD }).verifiedAfterEdit, true);
  assert.equal(analyzeTurn([edit('src/a.ts'), bash('go test ./...')], { cwd: CWD }).verifiedAfterEdit, true);
  assert.equal(analyzeTurn([edit('src/a.ts'), bash('npm run typecheck')], { cwd: CWD }).verifiedAfterEdit, true);
  assert.equal(analyzeTurn([edit('src/a.ts'), bash('curl -s localhost:3000/health')], { cwd: CWD }).verifiedAfterEdit, true);
  assert.equal(analyzeTurn([edit('db/60-purchasing.sql'), bash('docker exec -i db psql -U u -d scratch -v ON_ERROR_STOP=1 < db/60-purchasing.sql')], { cwd: CWD }).verifiedAfterEdit, true);
  assert.equal(analyzeTurn([edit('db/x.sql'), bash('sqlite3 test.db < db/x.sql')], { cwd: CWD }).verifiedAfterEdit, true);
  assert.equal(analyzeTurn([edit('src/a.ts'), tool('mcp__Claude_Browser__navigate', { url: 'http://localhost:5173' })], { cwd: CWD }).verification, 'browser');
  assert.equal(analyzeTurn([edit('src/a.ts'), tool('Agent', { prompt: 'run the tests', subagent_type: 'general-purpose' })], { cwd: CWD }).verification, 'delegated');

  const testThenEdit = analyzeTurn([edit('src/a.ts'), bash('npm test'), edit('src/a.ts')], { cwd: CWD });
  assert.deepEqual(testThenEdit, { edits: ['src/a.ts'], verifiedAfterEdit: false, verification: null });
  assert.equal(analyzeTurn([edit('src/a.ts'), bash('ls -la && git status')], { cwd: CWD }).verifiedAfterEdit, false);
});

test('handbackReport and turnCwd read the subagent report and working directory', () => {
  const hb = { type: 'assistant', cwd: '/work/app/.claude/worktrees/agent-1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'h', name: 'SubagentHandback', input: { message: 'All tests pass.' } }] } };
  assert.equal(handbackReport([edit('src/a.ts'), hb]), 'All tests pass.');
  assert.equal(handbackReport([edit('src/a.ts')]), null);
  assert.equal(turnCwd([{ ...edit('src/a.ts'), cwd: '/work/app' }, hb]), '/work/app/.claude/worktrees/agent-1');
  assert.equal(turnCwd([edit('src/a.ts')]), null);
});

test('docs-only edits and files outside the project do not count', () => {
  const docs = analyzeTurn([edit('README.md'), edit('docs/guide.mdx'), tool('Write', { file_path: '/tmp/scratch/x.ts', content: '' })], { cwd: CWD });
  assert.deepEqual(docs.edits, []);
  const write = analyzeTurn([tool('Write', { file_path: path.join(CWD, 'src/new.ts'), content: 'x' }), tool('NotebookEdit', { notebook_path: path.join(CWD, 'nb.ipynb') })], { cwd: CWD });
  assert.deepEqual(write.edits, ['src/new.ts', 'nb.ipynb']);
  assert.deepEqual(analyzeTurn([edit('../other/src/a.ts')], { cwd: CWD }).edits, []);
});
