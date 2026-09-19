import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

test('plugin manifest is valid', () => {
  const m = readJson('.claude-plugin/plugin.json');
  assert.equal(m.name, 'jev');
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.ok(m.description.length > 20);
  assert.equal(m.license, 'MIT');
});

test('marketplace lists the plugin at the repo root', () => {
  const m = readJson('.claude-plugin/marketplace.json');
  assert.equal(m.name, 'jev');
  assert.equal(m.plugins.length, 1);
  assert.equal(m.plugins[0].name, 'jev');
  assert.equal(m.plugins[0].source, './');
});

test('package.json is ESM with no dependencies and no lockfile', () => {
  const p = readJson('package.json');
  assert.equal(p.type, 'module');
  assert.equal(p.dependencies, undefined);
  assert.equal(p.devDependencies, undefined);
  assert.equal(fs.existsSync(path.join(ROOT, 'package-lock.json')), false);
});
