import { test } from 'node:test';
import assert from 'node:assert/strict';
import { riskSignal, hasRiskSignal, SIGNAL_FAMILIES } from '../lib/gate-signals.mjs';

// Shapes taken from six days of real gate traffic; every one of these was scored >= 2.0 by Jev
// or is destructive by construction, so the gate must keep sending it to Jev.
const MUST_SIGNAL = [
  ['rm -rf dist', 'fs_delete'],
  ['pkill -f "tsx watch src/index.ts"; sleep 2', 'process_kill'],
  ['lsof -ti tcp:3009 | xargs -r kill -9; sleep 1', 'process_kill'],
  ['docker exec noscoapp-db-1 psql -U nosco -d postgres -c "DROP DATABASE marijachi_rv24"', 'db_client'],
  ['docker exec -i noscoapp-db-1 psql -U nosco -d marijachi_pay2 -v ON_ERROR_STOP=1 -q < db/88-payroll-2.sql', 'db_client'],
  ['DB_CONTAINER=noscoapp-db-1 ./scripts/setup-db.sh marijachi_cash 2>&1 | tail -25', 'local_script'],
  ['cd api && DATABASE_URL=postgres://app:devpassword@localhost:5433/db npx tsx src/index.ts', 'db_url'],
  ['git worktree remove --force .claude/worktrees/agent-af91', 'git_mutate'],
  ['git push --force origin main', 'git_mutate'],
  ['git reset --hard HEAD~3', 'git_mutate'],
  ['git checkout -- .', 'git_mutate'],
  ['git branch -D feature', 'git_mutate'],
  ["sed -i '' 's/a/b/' scripts/setup-db.sh", 'fs_inplace'],
  ['echo "export X=1" >> ~/.zshrc', 'redirect_outside'],
  ['cat config > /etc/hosts', 'redirect_outside'],
  ['mv build /Users/martin/backup', 'fs_move_copy'],
  ['chmod -R 777 .', 'fs_perms'],
  ['curl -X POST https://api.example.com/v1/items -d @payload.json', 'network_write'],
  ['ssh prod "systemctl restart app"', 'remote_access'],
  ['kubectl delete pod web-1', 'container'],
  ['docker compose down -v', 'container'],
  ['npm publish', 'destructive_word'],
  ['npm run db:migrate', 'destructive_word'],
  ['sudo launchctl unload x.plist', 'package_system'],
  ['defaults write com.apple.finder AppleShowAllFiles YES', 'system_config'],
  ['printenv TYPESAFE_API_KEY', 'secrets'],
  ['cat .env', 'secrets'],
  ['python3 /private/tmp/scratch/setup_rows.py', 'interpreter_file'],
  ['npx tsx api/scripts/seed-demo.ts', 'destructive_word'],
  ['node scripts/rebuild.mjs', 'interpreter_file'],
  ['bash deploy.sh', 'destructive_word'],
  ["python3 - <<'PY'\nimport shutil\nshutil.rmtree('build')\nPY", 'fs_delete'],
  ["docker exec -i db psql -U u -d app <<'SQL'\nDELETE FROM exchange_rate WHERE source = 'hnb';\nSQL", 'db_client'],
  ['sqlite3 app.db "UPDATE users SET role = \'admin\'"', 'db_client'],
  ['for w in a b; do git worktree remove --force .claude/worktrees/$w; done', 'git_mutate'],
];

// Common benign shapes that the prefilter could not prove read-only (quotes, pipes, parentheses,
// heredocs) but that carry no risk signal; these must no longer pay the Jev round trip.
const MUST_NOT_SIGNAL = [
  'grep -rn "exchange_rate\\|fx_rate" api/src | head -40',
  "grep -E 'TODO|FIXME' -r src | wc -l",
  'cd /Users/martin/projects/marijachi && git diff --stat HEAD~1',
  'cd api && npm run typecheck 2>&1 | tail -20',
  'npm test 2>&1 | grep -E "^(ok|not ok)" | tail -5',
  "sed -n '/^export function/,/^}/p' lib/questions.mjs",
  "awk -F, '{ s += $3 } END { print s }' data.csv",
  'for f in db/*.sql; do echo "$f"; head -3 "$f"; done',
  'until curl -s localhost:3197/health >/dev/null; do sleep 1; done; echo up',
  "python3 - <<'PY'\nimport pathlib\np = pathlib.Path('README.md'); s = p.read_text()\np.write_text(s.replace('a', 'b'))\nPY",
  "cat > src/new-file.ts <<'EOF'\nexport const x = 1;\nEOF",
  'npm run build > /tmp/build.log 2>&1; tail -5 /tmp/build.log',
  'git add -A && git commit -m "feat: add thing"',
  'git log --oneline --format="%h %s" -20',
  'ls -la node_modules/.bin | head',
  'echo "$(date) done"',
  'jq ".dependencies" package.json',
  'node -e "console.log(process.version)"',
  "python3 -c 'import json; print(json.load(open(\"package.json\"))[\"version\"])'",
  'mkdir -p src/lib && touch src/lib/index.ts',
];

test('dangerous commands carry the expected risk signal', () => {
  for (const [cmd, family] of MUST_SIGNAL) {
    assert.equal(riskSignal(cmd), family, `expected ${family} for: ${cmd}`);
  }
});

test('benign commands carry no risk signal', () => {
  for (const cmd of MUST_NOT_SIGNAL) {
    assert.equal(riskSignal(cmd), null, `expected no signal for: ${cmd} (got ${riskSignal(cmd)})`);
  }
});

test('empty input, helper, and family list', () => {
  assert.equal(riskSignal(''), null);
  assert.equal(riskSignal('   '), null);
  assert.equal(riskSignal(undefined), null);
  assert.equal(hasRiskSignal('rm x'), true);
  assert.equal(hasRiskSignal('ls'), false);
  for (const f of ['process_kill', 'db_client', 'local_script', 'interpreter_file']) assert.ok(SIGNAL_FAMILIES.includes(f), f);
});
