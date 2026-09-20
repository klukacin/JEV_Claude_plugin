// lib/gate-prefilter.mjs — decides which Bash commands are so obviously read-only that
// asking Jev would only add latency. Conservative by design: when unsure, return false.
//
// Backbone: the opaque-token rule. Every denylist below is a string comparison against a
// token, so it only means anything if the token the shell sees is the token we see. A token
// is *plain* when it is an unquoted run of inert characters, or a single whole-token quoted
// string the shell cannot expand. Anything else — a quote that is not at both ends, a
// backslash, `$`, a brace — is *opaque*, and one opaque token makes the whole command
// unsafe, because the flag a denylist looks for may be hiding inside it
// (`-de'lete'`, `-del\ete`, `--out'put'=…`, `${X:--delete}`).

const SAFE_BINARIES = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'pwd', 'which', 'type', 'echo', 'printf',
  'printenv', 'date', 'uname', 'whoami', 'id', 'file', 'stat', 'du', 'df', 'tree', 'jq', 'cut', 'tr', 'basename',
  'dirname', 'realpath', 'readlink', 'true', 'false', 'test', '[', 'diff', 'cmp', 'md5', 'md5sum', 'shasum', 'sha256sum',
]);

// A binary is accepted as a bare name or from one of these directories only; `./ls`,
// `~/bin/ls` and `/tmp/evil/git` must never inherit the trust of the name they borrow.
const BIN_DIRS = new Set(['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']);

// Environment prefixes are an allowlist: anything else can redirect a tool's config or
// preload code (`RIPGREP_CONFIG_PATH=`, `HOME=`, `GOFLAGS=`, `LD_PRELOAD=`).
const ENV_ALLOWED = /^(LC_[A-Z_]+|LANG|TZ|TERM|COLUMNS|LINES|NO_COLOR|FORCE_COLOR|CI)$/;

const GIT_QUERIES = new Set(['status', 'diff', 'log', 'show', 'blame', 'rev-parse', 'describe', 'ls-files', 'ls-tree', 'shortlog', 'cat-file', 'count-objects']);
const GIT_BRANCH_FLAGS = new Set(['-a', '--all', '-r', '--remotes', '-v', '-vv', '--list', '-l', '--show-current', '--merged', '--no-merged']);
const GIT_BRANCH_PREFIXES = ['--sort=', '--format=', '--contains', '--merged=', '--no-merged=', '--points-at'];
const GIT_TAG_FORBIDDEN = new Set(['-d', '--delete', '-a', '--annotate', '-s', '--sign', '-f', '--force', '-m', '-F', '-u']);
const GIT_GLOBAL_OK = new Set(['--no-pager', '-P']);
// git config is an allowlist, not a denylist: git abbreviates long options (`--unset-a`,
// `--remove-s`) and grew an `edit` subcommand, so "not on the forbidden list" proves nothing.
const GIT_CONFIG_FLAGS = new Set([
  '--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l',
  '--show-origin', '--show-scope', '--global', '--local', '--system', '--worktree',
  '-z', '--null', '--name-only',
]);
const GIT_CONFIG_KEY = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/;

const NPM_QUERIES = new Set(['--version', '-v', 'ls', 'list', 'll', 'la', 'view', 'info', 'show', 'v', 'outdated', 'why', 'explain', 'root', 'prefix', 'ping', 'search', 'help']);
const NPM_RUN_SAFE = new Set(['test', 'build', 'lint', 'typecheck', 'check', 'format:check', 'lint:check', 'test:unit']);
const CARGO_SAFE = new Set(['test', 'build', 'check', 'clippy', '--version', '-V', 'tree', 'metadata']);
const GO_SAFE = new Set(['test', 'build', 'vet', 'version', 'env', 'list']);
const PIP_SAFE = new Set(['list', 'show', '--version', '-V', 'index', 'freeze', 'check']);
const FIND_FORBIDDEN = /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/;

// Project runners (tests/builds) are allowed to run without a Jev check, but only with
// arguments that cannot name an output path outside the project.
const RUNNER_ARG = /^[A-Za-z0-9_./:=-]+$/;
const RUNNER_OUTPUT_FLAGS = ['-o', '--out', '--output', '--outFile', '--outDir', '--outputFile', '--basetemp', '--target-dir'];

const REDIRECT_RE = /\d*(>>|&>|>)\s*(&?\S*)/g;

function hasUnsafeRedirect(cmd) {
  const re = new RegExp(REDIRECT_RE.source, 'g');
  let m;
  while ((m = re.exec(cmd))) {
    const target = m[2];
    if (target === '&1' || target === '&2' || target === '/dev/null') continue;
    return true;
  }
  return false;
}

// Characters a token may contain unquoted without the shell doing anything to it.
// Glob characters are allowed: they can only select existing paths, never add a flag.
const PLAIN_RE = /^[A-Za-z0-9_./:=@,+%~^*?[\]-]+$/;

// Split a segment into raw tokens, keeping the quotes attached so the classifier can see
// them. Returns null when quoting is unbalanced (which is itself a reason to give up).
function rawTokens(segment) {
  const tokens = [];
  let cur = '';
  let inToken = false;
  let quote = null;
  for (const ch of segment) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; inToken = true; continue; }
    if (/\s/.test(ch)) {
      if (inToken) { tokens.push(cur); cur = ''; inToken = false; }
      continue;
    }
    cur += ch;
    inToken = true;
  }
  if (quote) return null;
  if (inToken) tokens.push(cur);
  return tokens;
}

// Returns the unquoted value of a plain token, or null when the token is opaque.
function plainValue(raw) {
  if (raw.length >= 2 && raw[0] === "'" && raw.at(-1) === "'") {
    const inner = raw.slice(1, -1);
    return inner.includes("'") ? null : inner;
  }
  if (raw.length >= 2 && raw[0] === '"' && raw.at(-1) === '"') {
    const inner = raw.slice(1, -1);
    return /["$`\\]/.test(inner) ? null : inner;
  }
  return PLAIN_RE.test(raw) ? raw : null;
}

function runnerArgsSafe(args) {
  return args.every((a) => {
    if (!RUNNER_ARG.test(a)) return false;
    if (a.startsWith('/') || a.startsWith('~')) return false;
    // A parent-directory reference, not the Go package pattern `./...`.
    if (a.split('/').includes('..')) return false;
    return !RUNNER_OUTPUT_FLAGS.some((f) => a.startsWith(f));
  });
}

function gitConfigIsSafe(rest) {
  let bare = 0;
  let keys = 0;
  let getRegexp = false;
  for (const a of rest) {
    if (a.startsWith('-')) {
      if (GIT_CONFIG_FLAGS.has(a)) { if (a === '--get-regexp') getRegexp = true; continue; }
      if (/^--type=[A-Za-z0-9_-]+$/.test(a)) continue;
      if (/^--default=[A-Za-z0-9_.:/-]*$/.test(a)) continue;
      return false;
    }
    bare += 1;
    if (bare === 1 && (a === 'list' || a === 'get')) continue;
    if (GIT_CONFIG_KEY.test(a)) { keys += 1; if (keys > 1) return false; continue; }
    if (getRegexp && keys === 0) { keys += 1; continue; }
    return false;
  }
  return true;
}

function gitIsSafe(args) {
  let a = args;
  while (a.length && GIT_GLOBAL_OK.has(a[0])) a = a.slice(1);
  const [sub, ...rest] = a;
  if (!sub) return false;
  if (GIT_QUERIES.has(sub)) return !rest.some((x) => x.startsWith('--output'));
  if (sub === 'branch') return rest.every((x) => GIT_BRANCH_FLAGS.has(x) || GIT_BRANCH_PREFIXES.some((p) => x.startsWith(p)));
  if (sub === 'stash') return rest[0] === 'list' || rest[0] === 'show';
  if (sub === 'remote') {
    if (rest.length === 0) return true;
    if (rest.length === 1 && (rest[0] === '-v' || rest[0] === '--verbose')) return true;
    return rest[0] === 'show' || rest[0] === 'get-url';
  }
  if (sub === 'tag') {
    if (rest.length === 0) return true;
    if (rest.some((x) => GIT_TAG_FORBIDDEN.has(x))) return false;
    return rest.includes('-l') || rest.includes('--list');
  }
  if (sub === 'reflog') return rest.length === 0 || rest[0] === 'show';
  if (sub === 'config') return gitConfigIsSafe(rest);
  return false;
}

function awkIsSafe(args) {
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (!a.startsWith('-') || a === '-') break;
    if (a === '-F') { if (args[i + 1] === undefined) return false; i += 2; continue; }
    if (/^-F./.test(a)) { i += 1; continue; }
    if (a === '-v') { if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[i + 1] ?? '')) return false; i += 2; continue; }
    if (/^-v[A-Za-z_][A-Za-z0-9_]*=/.test(a)) { i += 1; continue; }
    return false; // -f progfile, -l lib, -E, --any: the program is not the one we can see
  }
  const program = args[i];
  if (program === undefined) return false;
  if (!/^\{\s*print\b/.test(program)) return false;
  if (/[(>|]/.test(program)) return false;
  return !/\bsystem\b/.test(program) && !/\bgetline\b/.test(program);
}

function segmentIsSafe(segment) {
  const raw = rawTokens(segment.replace(new RegExp(REDIRECT_RE.source, 'g'), ' '));
  if (raw === null) return false;
  const tokens = [];
  for (const t of raw) {
    const value = plainValue(t);
    if (value === null) return false; // opaque token: the shell sees something we do not
    tokens.push(value);
  }
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
    if (!ENV_ALLOWED.test(tokens[0].slice(0, tokens[0].indexOf('=')))) return false;
    tokens.shift();
  }
  if (tokens.length === 0) return false;
  const [bin, ...args] = tokens;
  if (bin.includes('/')) {
    if (!bin.startsWith('/')) return false;
    if (!BIN_DIRS.has(bin.slice(0, bin.lastIndexOf('/')))) return false;
  }
  const base = bin.replace(/^.*\//, '');
  switch (base) {
    case 'cd': return true;
    case 'env': return args.length === 0;
    case 'git': return gitIsSafe(args);
    case 'find': return !args.some((a) => FIND_FORBIDDEN.test(a));
    case 'grep':
    case 'egrep':
    case 'fgrep':
    case 'rg':
      return !args.some((a) => a.startsWith('--pre') || a.startsWith('--hostname-bin'));
    case 'sed':
      if (args[0] !== '-n' || args.length < 2 || !/^\d+(,\d+)?p$/.test(args[1])) return false;
      // Reject -i, --in-place, and any other -- flags except --quiet/--silent
      if (args.some((a) => /^-i/.test(a) || /^--in-place(=|$)/.test(a))) return false;
      for (let i = 2; i < args.length; i++) {
        if (args[i].startsWith('-') && args[i] !== '--quiet' && args[i] !== '--silent') return false;
      }
      return true;
    case 'awk': return awkIsSafe(args);
    case 'sort': return !args.some((a) => /^-[A-Za-z]*o/.test(a) || /^--o/.test(a));
    case 'uniq': return args.filter((a) => !a.startsWith('-')).length <= 1;
    case 'tree': return !args.some((a) => a.startsWith('-o'));
    case 'file': return !args.some((a) => a.startsWith('-C') || a.startsWith('--compile'));
    case 'npm':
      if (args[0] === 'test' || args[0] === 't') return runnerArgsSafe(args.slice(1));
      if (args[0] === 'run' || args[0] === 'run-script') return NPM_RUN_SAFE.has(args[1]) && runnerArgsSafe(args.slice(2));
      if (args[0] === 'audit') return !args.includes('fix') && runnerArgsSafe(args.slice(1));
      return NPM_QUERIES.has(args[0]) && runnerArgsSafe(args.slice(1));
    case 'npx': {
      const rest = args.slice(1);
      if (!runnerArgsSafe(rest)) return false;
      if (args[0] === 'tsc' || args[0] === 'jest') return true;
      if (args[0] === 'eslint') return !rest.some((a) => /^--fix(=|$)/.test(a));
      if (args[0] === 'prettier') {
        // Reject if any write flags are present
        if (rest.some((a) => /^(--write|-w|--fix)(=|$)/.test(a))) return false;
        // Only safe if --check is present
        return rest.some((a) => /^--check(=|$)/.test(a) || a === '-c' || /^-c(=|$)/.test(a));
      }
      if (args[0] === 'vitest') return rest[0] === 'run';
      return false;
    }
    case 'node':
      if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) return true;
      if (args[0] === '--check' || args[0] === '-c') {
        const rest = args.slice(1);
        // --require/--import preloads run even under --check, so no other flag is allowed.
        return rest.length === 1 && !rest[0].startsWith('-');
      }
      if (args[0] === '--test') return runnerArgsSafe(args.slice(1));
      return false;
    case 'pytest': return runnerArgsSafe(args);
    case 'python':
    case 'python3':
      if (args.length === 1 && (args[0] === '--version' || args[0] === '-V')) return true;
      if (args[0] === '-m' && args[1] === 'pytest') return runnerArgsSafe(args.slice(2));
      return false;
    case 'cargo':
      if (!CARGO_SAFE.has(args[0])) return false;
      if (args[0] === 'clippy' && args.some((a) => a.startsWith('--fix'))) return false;
      return runnerArgsSafe(args.slice(1));
    case 'go':
      if (args[0] === 'env') {
        // go env: allow only -json/--json flags or bare variable names (A-Z_*)
        return args.slice(1).every((a) =>
          a === '-json' || a === '--json' ||
          a.startsWith('-json=') || a.startsWith('--json=') ||
          /^[A-Z][A-Z0-9_]*$/.test(a)
        );
      }
      return GO_SAFE.has(args[0]) && runnerArgsSafe(args.slice(1));
    case 'pip':
    case 'pip3': return PIP_SAFE.has(args[0]) && runnerArgsSafe(args.slice(1));
    case 'bun':
      if (args.length === 1 && args[0] === '--version') return true;
      return args[0] === 'test' && runnerArgsSafe(args.slice(1));
    case 'claude': return args.length === 1 && args[0] === '--version';
    default: return SAFE_BINARIES.has(base);
  }
}

export function isProvablySafe(command) {
  const cmd = String(command ?? '').trim();
  if (!cmd) return false;
  // Global rejects: constructs whose meaning we cannot reconstruct from tokens alone.
  if (/[()]/.test(cmd)) return false;        // $(…), <(…), >(…), zsh =(…), glob qualifiers
  if (cmd.includes('`')) return false;
  if (cmd.includes('${')) return false;
  if (cmd.includes("$'")) return false;
  if (/\{[^}]*,[^}]*\}/.test(cmd)) return false; // brace expansion: -{delete,print}
  if (cmd.includes('\\')) return false;          // escapes hide flags: -del\ete
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
