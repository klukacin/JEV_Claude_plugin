// lib/gate-prefilter.mjs — decides which Bash commands are so obviously read-only that
// asking Jev would only add latency. Conservative by design: when unsure, return false.

const SAFE_BINARIES = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'pwd', 'which', 'type', 'echo', 'printf',
  'printenv', 'date', 'uname', 'whoami', 'id', 'file', 'stat', 'du', 'df', 'tree', 'jq', 'cut', 'tr', 'basename',
  'dirname', 'realpath', 'readlink', 'true', 'false', 'test', '[', 'diff', 'cmp', 'md5', 'md5sum', 'shasum', 'sha256sum',
  'pytest',
]);

const GIT_QUERIES = new Set(['status', 'diff', 'log', 'show', 'blame', 'rev-parse', 'describe', 'ls-files', 'ls-tree', 'shortlog', 'cat-file', 'count-objects']);
const GIT_BRANCH_FLAGS = new Set(['-a', '--all', '-r', '--remotes', '-v', '-vv', '--list', '-l', '--show-current', '--merged', '--no-merged']);
const GIT_BRANCH_PREFIXES = ['--sort=', '--format=', '--contains', '--merged=', '--no-merged=', '--points-at'];
const GIT_TAG_FORBIDDEN = new Set(['-d', '--delete', '-a', '--annotate', '-s', '--sign', '-f', '--force', '-m', '-F', '-u']);
const NPM_QUERIES = new Set(['--version', '-v', 'ls', 'list', 'll', 'la', 'view', 'info', 'show', 'v', 'outdated', 'why', 'explain', 'root', 'prefix', 'ping', 'search', 'help']);
const NPM_RUN_SAFE = new Set(['test', 'build', 'lint', 'typecheck', 'check', 'format:check', 'lint:check', 'test:unit']);
const CARGO_SAFE = new Set(['test', 'build', 'check', 'clippy', '--version', '-V', 'tree', 'metadata']);
const GO_SAFE = new Set(['test', 'build', 'vet', 'version', 'env', 'list']);
const PIP_SAFE = new Set(['list', 'show', '--version', '-V', 'index', 'freeze', 'check']);
const FIND_FORBIDDEN = /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/;

function hasUnsafeRedirect(cmd) {
  const re = /\d*(>>|&>|>)\s*(&?\S*)/g;
  let m;
  while ((m = re.exec(cmd))) {
    const target = m[2];
    if (target === '&1' || target === '&2' || target === '/dev/null') continue;
    return true;
  }
  return false;
}

function tokenize(segment) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment))) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}

function gitIsSafe(args) {
  const [sub, ...rest] = args;
  if (!sub) return false;
  if (GIT_QUERIES.has(sub)) return !rest.some((a) => a.startsWith('--output'));
  if (sub === 'branch') return rest.every((a) => GIT_BRANCH_FLAGS.has(a) || GIT_BRANCH_PREFIXES.some((p) => a.startsWith(p)));
  if (sub === 'stash') return rest[0] === 'list' || rest[0] === 'show';
  if (sub === 'remote') return rest.length === 0 || rest[0] === '-v' || rest[0] === 'show' || rest[0] === 'get-url';
  if (sub === 'tag') {
    if (rest.length === 0) return true;
    if (rest.some((a) => GIT_TAG_FORBIDDEN.has(a))) return false;
    return rest.includes('-l') || rest.includes('--list');
  }
  if (sub === 'reflog') return rest.length === 0 || rest[0] === 'show';
  if (sub === 'config') {
    if (rest.some((a) => ['--unset', '--unset-all', '--add', '--replace-all', '--edit', '-e', '--remove-section', '--rename-section'].includes(a))) return false;
    if (rest.includes('--list') || rest.includes('-l') || rest.some((a) => a.startsWith('--get'))) return true;
    return rest.filter((a) => !a.startsWith('-')).length === 1;
  }
  return false;
}

function segmentIsSafe(segment) {
  const tokens = tokenize(segment);
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
    const name = tokens[0].split('=')[0];
    if (/^(LD_|DYLD_|GIT_)/.test(name) ||
        /^(PAGER|EDITOR|VISUAL|PATH|NODE_OPTIONS)$/.test(name) ||
        /_OPTIONS$/.test(name)) {
      return false;
    }
    tokens.shift();
  }
  if (tokens.length === 0) return false;
  const [bin, ...args] = tokens;
  const base = bin.replace(/^.*\//, '');
  switch (base) {
    case 'cd': return true;
    case 'env': return args.length === 0;
    case 'git': return gitIsSafe(args);
    case 'find': return !args.some((a) => FIND_FORBIDDEN.test(a));
    case 'sed':
      if (args[0] !== '-n' || args.length < 2 || !/^\d+(,\d+)?p$/.test(args[1])) return false;
      // Reject -i, --in-place, and any other -- flags except --quiet/--silent
      if (args.some((a) => /^-i/.test(a) || /^--in-place(=|$)/.test(a))) return false;
      for (let i = 2; i < args.length; i++) {
        if (args[i].startsWith('-') && args[i] !== '--quiet' && args[i] !== '--silent') return false;
      }
      return true;
    case 'awk': return !/system\s*\(/.test(segment) && !/\bgetline\b/.test(segment);
    case 'sort': return !args.some((a) => /^-o/.test(a) || a.startsWith('--output'));
    case 'uniq': return args.filter((a) => !a.startsWith('-')).length <= 1;
    case 'npm':
      if (args[0] === 'test' || args[0] === 't') return true;
      if (args[0] === 'run' || args[0] === 'run-script') return NPM_RUN_SAFE.has(args[1]);
      if (args[0] === 'audit') return args[1] !== 'fix';
      return NPM_QUERIES.has(args[0]);
    case 'npx':
      if (args[0] === 'tsc' || args[0] === 'jest') return true;
      if (args[0] === 'eslint') return !args.some((a) => /^--fix(=|$)/.test(a));
      if (args[0] === 'prettier') {
        // Reject if any write flags are present
        if (args.some((a) => /^(--write|-w|--fix)(=|$)/.test(a))) return false;
        // Only safe if --check is present
        return args.some((a) => /^--check(=|$)/.test(a) || a === '-c' || /^-c(=|$)/.test(a));
      }
      if (args[0] === 'vitest') return args[1] === 'run';
      return false;
    case 'node': return ['--version', '-v', '--test', '--check', '-c'].includes(args[0]);
    case 'python':
    case 'python3': return ['--version', '-V'].includes(args[0]) || (args[0] === '-m' && args[1] === 'pytest');
    case 'cargo': return CARGO_SAFE.has(args[0]);
    case 'go':
      if (args[0] === 'env') {
        // go env: allow only -json/--json flags or bare variable names (A-Z_*)
        return args.slice(1).every((a) =>
          a === '-json' || a === '--json' ||
          a.startsWith('-json=') || a.startsWith('--json=') ||
          /^[A-Z][A-Z0-9_]*$/.test(a)
        );
      }
      return GO_SAFE.has(args[0]);
    case 'pip':
    case 'pip3': return PIP_SAFE.has(args[0]);
    case 'bun': return args[0] === '--version' || args[0] === 'test';
    case 'claude': return args[0] === '--version';
    default: return SAFE_BINARIES.has(base);
  }
}

export function isProvablySafe(command) {
  const cmd = String(command ?? '').trim();
  if (!cmd) return false;
  if (/\$\(|`|<\(|>\(/.test(cmd)) return false;
  if (/(^|\s)(sudo|doas)(\s|$)/.test(cmd)) return false;
  if (hasUnsafeRedirect(cmd)) return false;
  if (/&\s*$/.test(cmd)) return false;
  let segments = cmd.split(/\|\|?|&&|&(?!&|>)|;|\n/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  // Post-process to rejoin segments incorrectly split on & in redirects (e.g. 2>&1 split into 2> and 1)
  const rejoinedSegments = [];
  for (let i = 0; i < segments.length; i++) {
    if (i > 0 && rejoinedSegments.length > 0 && rejoinedSegments[rejoinedSegments.length - 1].match(/>$/) && /^[0-9&]+$/.test(segments[i])) {
      rejoinedSegments[rejoinedSegments.length - 1] += '&' + segments[i];
    } else {
      rejoinedSegments.push(segments[i]);
    }
  }
  segments = rejoinedSegments;
  // Trailing & indicates background execution, which is unsafe
  for (const seg of segments) {
    if (/&$/.test(seg)) return false;
  }
  return segments.every(segmentIsSafe);
}
