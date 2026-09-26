// lib/gate-signals.mjs — cheap text scan that decides whether a Bash command is worth a Jev call.
// The prefilter answers "provably read-only?"; this answers "could anything here destroy data, kill
// processes, change shared state, run arbitrary or downloaded code, leak secrets, or reach outside the
// machine?". Commands with no signal skip the Jev round trip. The families were derived from six days
// of real gate scores and two adversarial reviews; when in doubt a pattern belongs here, because a
// false positive costs one Jev call and a false negative skips the gate.
//
// Scanning is layered so that noise reduction can never hide an action:
//   - command-shaped families scan the raw text;
//   - prose-prone families (words like reset, delete, token) scan a copy in which commit/PR messages
//     and search patterns are masked;
//   - every family scans the inner text of each $(...) and `...` substitution separately.
import { allHeads, maskQuotes, quotedSpans, stripHeredocBodies, substitutions } from './shell-words.mjs';

const MAX_SCAN = 32768;
const SPAN = String.raw`[^|;&\n]{0,300}`; // bounded "same segment" span; unbounded spans made some inputs quadratic
const SYSTEM_BIN_DIRS = ['/bin/', '/usr/bin/', '/usr/local/bin/', '/opt/homebrew/bin/', '/sbin/', '/usr/sbin/'];
const INTERPRETERS = new Set(['python', 'python3', 'node', 'ruby', 'perl', 'php', 'deno', 'bun', 'tsx', 'ts-node', 'bash', 'sh', 'zsh', 'ksh', 'dash', 'fish', 'osascript', 'Rscript', 'lua', 'groovy', 'swift', 'pwsh']);
const SUBCOMMANDS = { bun: new Set(['test', 'install', 'i', 'add', 'remove', 'rm', 'update', 'outdated', 'pm', 'build', 'upgrade', 'init', 'create', 'link', 'unlink', 'info', 'repl', 'x']), deno: new Set(['test', 'fmt', 'lint', 'check', 'info', 'doc', 'bench', 'cache', 'compile', 'coverage', 'upgrade', 'types', 'repl', 'task', 'add', 'install']), swift: new Set(['build', 'test', 'package', 'run']) };
const SAFE_PYTHON_MODULES = new Set(['pytest', 'unittest', 'pip', 'venv', 'json.tool', 'mypy', 'black', 'ruff', 'isort', 'flake8', 'pylint', 'coverage', 'doctest', 'py_compile', 'compileall', 'timeit', 'pydoc', 'site', 'this', 'calendar', 'tokenize', 'ast', 'dis']);
const NPX_KNOWN = new Set(['tsc', 'tsx', 'ts-node', 'eslint', 'prettier', 'vitest', 'jest', 'playwright', 'biome', 'knip', 'turbo', 'nx', 'next', 'vite', 'astro', 'svelte-check', 'vue-tsc', 'stylelint', 'markdownlint', 'cspell', 'depcheck', 'madge', 'c8', 'nyc', 'mocha', 'ava', 'tap', 'size-limit', 'publint']);
const SEARCH_HEADS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);
const READ_ONLY_STAGES = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'less', 'more', 'cat', 'column', 'nl', 'fold', 'rev']);
// Destinations whose modification changes behaviour outside the edited code: dotfiles, system paths,
// git hooks and config, CI, agent configuration.
const OUTSIDE = String.raw`(~|\$HOME\b|\$\{HOME\}|\$\{?XDG_\w+|\/(?!dev\/null\b|tmp\/|private\/tmp\/|var\/folders\/)|[^\s&|;]*\.\.\/|(\.\/)?\.git\/(hooks|config)|(\.\/)?\.husky\/|(\.\/)?\.mcp\.json|(\.\/)?\.envrc|(\.\/)?\.claude\/|(\.\/)?\.github\/workflows\/)`;
// Word match in which "_" also separates, so `reset_db` and `seed_demo` still match.
const W = (words) => String.raw`(?<![A-Za-z0-9])(${words})(?![A-Za-z0-9])`;
const re = (source, flags = '') => new RegExp(source.replaceAll('%S', SPAN).replaceAll('%O', OUTSIDE), flags);
const PIPE_WRAPPERS = String.raw`((\/usr\/bin\/)?(sudo|env|command|nice|time|nohup|exec|busybox|stdbuf|unbuffer|timeout|caffeinate)\b(\s+(-[^\s|;&]+|\d+[smhd]?|[A-Za-z_]\w*=\S*))*\s+)*`;
const SHELLS = String.raw`((ba|z|k|da|fi|c|tc)?sh|pwsh|powershell|python[0-9.]*|node|perl|ruby|php|bun|deno|osascript)`;
// Environment variables whose value is a command (or code) that the next program runs.
const COMMAND_VARS = 'LESSOPEN|LESSCLOSE|GIT_EXTERNAL_DIFF|GIT_PAGER|PAGER|MANPAGER|GIT_SSH_COMMAND|GIT_SSH|GIT_EDITOR|GIT_SEQUENCE_EDITOR|EDITOR|VISUAL|GIT_ASKPASS|SSH_ASKPASS|LD_PRELOAD|DYLD_INSERT_LIBRARIES|BASH_ENV|PROMPT_COMMAND|PERL5OPT|RUBYOPT|PYTHONSTARTUP';
// Assignments that only change formatting, allowed in front of a masked search line.
const HARMLESS_ASSIGNMENT = /^(LC_\w+|LANG|LANGUAGE|TERM|NO_COLOR|FORCE_COLOR|GREP_COLORS?|COLUMNS|TZ)=/;
// Options whose next argument is inline code, which the families scan as text.
const INLINE_CODE_FLAG = /^-[a-zA-Z]*[ceEpr]$|^--(eval|print|command)$|^-Command$/;

// Families whose patterns match commands, flags, and paths; they scan the raw text.
const COMMAND_FAMILIES = [
  ['pipe_to_shell', re(String.raw`\|\s*${PIPE_WRAPPERS}["']?\S*?\b${SHELLS}\b|\|\s*(uv\s+run|npx|bunx|pnpm\s+dlx)\b|<\(\s*(curl|wget|fetch)\b|\b(ba|z|k|da|fi)?sh\b[^|;&\n]{0,120}\s-[a-zA-Z]*c\b|\b(ba|z|k|da|fi)?sh\b[^|;&\n<]{0,120}<<|\b(source|\.)\s+<\(|\b(xargs|parallel)\b[^|;&\n]{0,160}\b(${SHELLS}|curl|wget)\b`)],
  ['fs_delete', re(String.raw`\b(rm|rmdir|unlink|shred|truncate|srm|trash)\b|rm_rf|rm_r\b|remove_dir|rmtree|removedirs|\.unlink(Sync)?\(|\.(rm|rmdir)(Sync)?\(|\brm(dir)?Sync\(|\bos\.remove\(|\.remove\(|\bfind\b%S\s-(delete|exec|execdir|ok|okdir)\b`)],
  ['fs_move_copy', re(String.raw`\b(mv|cp|rsync|ditto|dd|rclone)\b|\bshutil\.(move|copytree)\b|\bln\b%S\s["']?%O|\btar\b%S\s-C\s*["']?%O|\bunzip\b%S\s-d\s*["']?%O|(^|[\s;&|(])install\b%S\s["']?%O`)],
  ['fs_perms', re(String.raw`\b(chmod|chown|chgrp|chflags|xattr|setfacl)\b`)],
  ['fs_inplace', re(String.raw`\bsed\b%S\s-[a-zA-Z]*i|--in-place\b|\bperl\b%S\s-[a-zA-Z]*i`)],
  ['redirect_outside', re(String.raw`(?:^|[^<>])(?:\d|&)?>{1,2}\|?\s*["']?%O|\btee\b%S\s["']?%O|\bgit\b%S(--output[=\s]|\s-o\s*)["']?%O|\bsort\b%S\s(-[a-zA-Z]*o\s*|--output[=\s]\s*)["']?%O|\buniq\b%S\s["']?%O`)],
  ['disk', re(String.raw`\b(mkfs|diskutil|fdisk|parted|newfs|mount|umount|hdiutil)\b`)],
  ['db_client', re(String.raw`\b(psql|mysql|mariadb|sqlite3|mongosh?|redis-cli|pg_dump|pg_restore|pg_dumpall|dropdb|createdb|dropuser|createuser|clickhouse-client|cqlsh|liquibase|goose|atlas|flyway)\b`)],
  ['db_url', re(String.raw`\b(postgres(ql)?|mysql|mariadb|mongodb(\+srv)?|rediss?|amqps?|clickhouse):\/\/|\b\w*(DATABASE|_DB)_URL=`, 'i')],
  ['container', re(String.raw`\bdocker\b%S\b(rm|rmi|kill|stop|down|prune|restart|volume|system|network|run|build|push|login|cp|exec|update|commit|load|import|save)\b|\bdocker[\s-]compose\b%S\b(up|down|rm|stop|kill|restart|run|exec|build|push|pull|create|cp)\b|\b(podman|nerdctl)\b|\b(kubectl|helm|kustomize|terraform|tofu|pulumi|ansible(-playbook)?|vagrant|packer)\b`)],
  ['network_write', re(String.raw`\bcurl\b%S(\s-X\s*|\s--request[=\s]\s*)(POST|PUT|PATCH|DELETE)\b|\bcurl\b%S\s(-d|--data[\w-]*|-F|--form|-T|--upload-file|--json)\b|\bcurl\b%S\s-H\s*["']?@|\b(curl|wget)\b%S(\$\(|\x60)|\bwget\b%S--(post|method|body)|\b(http|https|xh)\s+(POST|PUT|PATCH|DELETE)\b|\bcurl\b%S\s(-[a-zA-Z]*o|--output)\s*["']?%O|\bwget\b%S\s(-O|--output-document|-P|--directory-prefix)\s*["']?%O`, 'i')],
  ['remote_access', re(String.raw`\b(ssh|scp|sftp|ftp|telnet|nc|ncat|socat|mosh)\b`)],
  ['cloud_cli', re(String.raw`\b(aws|gcloud|gsutil|az|doctl|flyctl|vercel|netlify|heroku|firebase|wrangler|supabase|railway|stripe|twilio|s3cmd|hcloud|serverless|sls)\b|\bfly\s+(deploy|apps|secrets|ssh|scale|machine|volumes)\b|\bgh\s+(pr\s+(create|merge|close|reopen|edit|comment|review|ready)|issue\s+(create|close|reopen|edit|comment|delete|transfer)|release\s+(create|delete|edit|upload)|repo\s+(create|delete|edit|fork|rename|archive|sync)|secret|variable|workflow\s+(run|enable|disable)|run\s+(rerun|cancel|delete)|gist\s+(create|edit|delete)|auth|ssh-key|label\s+(create|edit|delete))\b|\bgh\s+api\b%S\s(-X|--method|-f|-F|--field|--raw-field|--input)\b|\bnpm\s+(publish|unpublish|deprecate|owner|token|login)\b`)],
  ['remote_package', re(String.raw`\b(bunx|uvx)\b|\b(pnpm|yarn)\s+dlx\b|\bpipx\s+run\b|\b(deno|bun)\s+run\b%Shttps?:\/\/|\bnpx\s+(-y|--yes|-p|--package)\b|\bnpm\s+(x|exec)\b`)],
  ['package_system', re(String.raw`\bsudo\b|\bdoas\b|\bbrew\s+(install|uninstall|remove|upgrade|reinstall|link|unlink|tap|services)\b|\bpip3?\s+(install|uninstall)\b|\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|uninstall|update|upgrade)\b%S\s(-g|--global)\b|\b(gem|cargo)\s+install\b`)],
  ['system_config', re(String.raw`\b(launchctl|crontab|systemctl|scutil|networksetup|pmset|softwareupdate|shutdown|reboot|halt|osascript|dscl|spctl|csrutil|nvram|tmutil|mdutil)\b|\bsecurity\s+(add|delete|set|import|export|find)-|\bdefaults\s+(write|delete)\b`)],
  ['eval_exec', re(String.raw`\beval\b|\bexec\b|\bnohup\b|\bdisown\b|\bsetsid\b|\bos\.system\(|\bsubprocess\.|child_process|\bexecSync\(|\bspawnSync\(|\bKernel\.system\b|\b(rg|ripgrep)\b%S--pre\b|\bgit\b%S\bgrep\b%S(\s-O|--open-files-in-pager)|\back\b%S--pager\b|\b(${COMMAND_VARS})=(?!(cat|less|more|true)?(\s|$))|\bNODE_OPTIONS=[^\n;&|]{0,200}(--require|--import|--loader|--experimental-loader)\b`)],
];

// Families built on words that also appear in prose (commit messages, search patterns).
const WORD_FAMILIES = [
  ['process_kill', re(String.raw`\b(kill|pkill|killall)\b|\bfuser\b%S\s-k\b|\bpm2\s+(delete|stop|kill|restart|flush)\b|\bpg_ctl(cluster)?\b%S\b(stop|restart|kill)\b|\bsupervisorctl\s+(stop|restart|shutdown)\b|\bscreen\b%S-X\s+quit\b|\btmux\s+kill-|\bservice\s+\S+\s+(stop|restart)\b|\bbrew\s+services\s+(stop|restart)\b`)],
  ['git_mutate', re(String.raw`\bgit\b%S\b(push|pull|reset|clean|rebase|merge|restore|switch|revert|cherry-pick|filter-branch|filter-repo|update-ref|update-index|symbolic-ref|read-tree|replace|gc|prune|am|apply|submodule|send-email|checkout|config|rm|mv|archive|format-patch)\b|\bgit\b%S\bfetch\b%S\s\+|\bgit\b%S\bbranch\b%S\s(-[a-zA-Z]*[dDmMfcC]\b|--(delete|move|force|copy)\b)|\bgit\b%S\btag\b%S\s(-[a-zA-Z]*[df]\b|--(delete|force)\b)|\bgit\b%S\bstash\b%S\b(drop|clear|pop)\b|\bgit\b%S\bworktree\b%S\b(remove|prune)\b|\bgit\b%S\breflog\b%S\bexpire\b|\bgit\b%S\bcommit\b%S--amend\b|\bgit\b%S\bremote\b%S\b(add|remove|rm|set-url|rename)\b|\bgit\s+(-c|--config-env)\b`)],
  ['db_destructive', re(String.raw`\bdb\s+push\b|--accept-data-loss|--force-reset|\bdrizzle-kit\s+(push|drop|migrate)\b|\bdowngrade\b|\bflush(all|db)?\b|schema:load|\bdb:(drop|reset|schema|seed|setup|migrate|rollback|create|prepare)\b|destroy_all|delete_all|\bflyway\b%S\b(clean|migrate|repair|undo)\b|\bliquibase\b%S\b(dropAll|update|rollback)\b|\bgoose\b%S\b(down|reset|up|redo)\b|\batlas\b%S\b(apply|migrate)\b|\bdotnet\s+ef\s+database\b|\bknex\s+migrate|\bsequelize\s+db:|\btypeorm\s+(schema:drop|migration:run)\b|\brails\s+(r|runner)\b|\bmanage\.py\s+(flush|migrate|loaddata|sqlflush)\b|reset\w*db\b|\bdb\w*reset\b`, 'i')],
  ['sql_write', re(String.raw`${W('drop|truncate|alter|grant|revoke|vacuum|reindex|pg_terminate_backend')}|\bdelete\s+from\b|\bupdate\s+[\w."]+\s+set\b|\binsert\s+into\b|\bcreate\s+(database|schema|role|user|table|extension)\b`, 'i')],
  ['destructive_word', re(W('deploy|release|publish|migrate|migration|seed|reset|destroy|purge|wipe|prune|nuke|teardown|rollback|uninstall|erase|delete|remove|terminate'), 'i')],
  ['secrets', re(String.raw`(?:^|[;&|(\n]\s*)(?:printenv\b|env\s*(?:$|[;&|)\n]))|(^|[\s/'"=])\.env(\.[\w-]+)?\b|\bid_(rsa|ed25519|ecdsa)\b|\.ssh\/|\.aws\/|\.claude\/settings|keychain|secret|\btoken\b|password|\.npmrc|\.netrc|\.pgpass|\.git-credentials|\.docker\/config\.json|\.kube\/config|gh\/hosts\.yml|\$\{?\w*(API_KEY|_KEY|TOKEN|SECRET|PASSWORD)\b`, 'i')],
];

function insideSpan(spans, index) {
  return spans.some(([a, b]) => index > a && index < b);
}

// Commit and PR messages are prose. Masked only when they cannot hide a command: single-quoted, or
// double-quoted without substitutions, or the standard `-m "$(cat <<'EOF' ... EOF\n)"` form with a
// quoted delimiter that closes the substitution immediately. A flag inside another quoted string
// (`echo ' -m "'`) is not a flag and is left alone; so is any text with escaped quotes.
function maskMessages(text) {
  if (/\\['"]/.test(text)) return text;
  const heredocForm = /(\s(?:-m|--message|--title|--body|--notes))\s+"\$\(cat\s+<<-?\s*'(\w+)'\n((?:(?!\n\2\n)[\s\S])*?)\n\2\n\s*\)"/g;
  const outer = quotedSpans(text);
  let out = text.replace(heredocForm, (m, flag, _d, _body, offset) => (insideSpan(outer, offset) ? m : `${flag} "Q"`));
  const spans = quotedSpans(out);
  out = out.replace(/(\s(?:-m|--message|--title|--body|--notes))(=|\s+)('[^']*'|"(?:[^"\\`$]|\\.|\$(?!\())*")/g,
    (m, flag, sep, _value, offset) => (insideSpan(spans, offset) ? m : `${flag}${sep}"Q"`));
  return out;
}

// Search patterns are data: `grep -rn "reset\|clear"` or `rg 'token|secret'` perform no action. A line
// is masked only when it is a single pipeline of read-only stages with no substitution, redirect, or
// option that runs commands.
function maskSearchPatterns(text) {
  return text.split('\n').map((line) => {
    if (/\$\(|`|>|--pre\b|\s-O|--open-files-in-pager|--output|--pager/.test(line)) return line;
    const masked = maskQuotes(line);
    if (/[;&]/.test(masked)) return line;
    const stages = [];
    for (const stage of masked.split('|')) {
      const words = stage.trim().split(/\s+/);
      while (words.length && /^[A-Za-z_]\w*=/.test(words[0])) {
        if (!HARMLESS_ASSIGNMENT.test(words[0])) return line; // LESSOPEN=… or GIT_EXTERNAL_DIFF=… runs a command
        words.shift();
      }
      stages.push(words.join(' '));
    }
    const first = stages[0];
    const firstHead = (first.split(/\s+/)[0] || '').split('/').pop();
    if (!SEARCH_HEADS.has(firstHead) && !/^git\s+(grep|log)\b/.test(first)) return line;
    const rest = stages.slice(1).every((st) => READ_ONLY_STAGES.has((st.split(/\s+/)[0] || '').split('/').pop()));
    return rest ? masked : line;
  }).join('\n');
}

function headSignal(words) {
  const [bin, ...rest] = words;
  if (/^[$"'`]/.test(bin) || /\\|''|""/.test(bin) || /'Q'|"Q"/.test(bin)) return 'obfuscated';
  if (/^(\.{1,2}|~)\//.test(bin)) return 'local_script';
  if (bin.includes('/') && !SYSTEM_BIN_DIRS.some((d) => bin.startsWith(d))) return 'local_script';
  if (bin === 'source' || bin === '.') return 'local_script';
  const base = bin.split('/').pop();
  if (base === 'printenv' || (base === 'env' && rest.length === 0)) return 'secrets';
  let tool = base;
  let args = rest;
  if (base === 'npx' || base === 'bunx') {
    const i = args.findIndex((a) => !a.startsWith('-'));
    tool = i >= 0 ? args[i] : null;
    if (tool && !NPX_KNOWN.has(tool.split('/').pop()) && !INTERPRETERS.has(tool)) return 'remote_package';
    args = i >= 0 ? args.slice(i + 1) : [];
  } else if ((base === 'pnpm' || base === 'yarn') && args[0] && INTERPRETERS.has(args[0])) {
    tool = args[0];
    args = args.slice(1);
  }
  if (!tool || !INTERPRETERS.has(tool.split('/').pop())) return null;
  const name = tool.split('/').pop();
  if (name === 'node' && args[0] === '--test') return null;
  if ((name === 'bun' || name === 'deno') && args[0] === 'run') args = args.slice(1);
  else if (SUBCOMMANDS[name]?.has(args[0])) return null;
  if (/^python/.test(name) && args[0] === '-m') return args[1] && !SAFE_PYTHON_MODULES.has(args[1]) ? 'interpreter_file' : null;
  // Any script target counts, with or without an extension or quotes (`sh install`, `node "x"`).
  // Quoted inline code (`python3 -c '…'`, `node -e '…'`) is scanned as text by the families instead.
  const i = args.findIndex((a) => !a.startsWith('-') && !/^(\d|&)?[<>]/.test(a));
  if (i < 0) return null;
  if (/^'Q'$|^"Q"$/.test(args[i]) && i > 0 && INLINE_CODE_FLAG.test(args[i - 1])) return null;
  return 'interpreter_file';
}

// Every matching family, for tests and diagnostics; riskSignal returns the first.
export function riskSignals(command) {
  const text = String(command ?? '');
  if (!text.trim()) return [];
  if (text.length > MAX_SCAN) return ['oversized'];
  const found = new Set();
  const prose = maskSearchPatterns(maskMessages(text));
  for (const [name, pattern] of COMMAND_FAMILIES) if (pattern.test(text)) found.add(name);
  for (const [name, pattern] of WORD_FAMILIES) if (pattern.test(prose)) found.add(name);
  // Substitutions run as commands of their own; scan them with every family. Heredoc bodies inside
  // them are data (a commit message body), so they are stripped first.
  for (const inner of substitutions(stripHeredocBodies(text)).concat(substitutions(text))) {
    const body = stripHeredocBodies(inner);
    for (const [name, pattern] of [...COMMAND_FAMILIES, ...WORD_FAMILIES]) if (pattern.test(body)) found.add(name);
    const head = (maskQuotes(body).trim().split(/\s+/)[0] || '').split('/').pop();
    if (head === 'curl' || head === 'wget' || head === 'fetch') found.add('pipe_to_shell');
  }
  for (const words of allHeads(text)) {
    const s = headSignal(words);
    if (s) found.add(s);
  }
  return [...found];
}

// Returns the first matching family name, or null when the command carries no risk signal.
export function riskSignal(command) {
  return riskSignals(command)[0] ?? null;
}

export function hasRiskSignal(command) {
  return riskSignal(command) !== null;
}

export const SIGNAL_FAMILIES = [...COMMAND_FAMILIES, ...WORD_FAMILIES].map(([name]) => name).concat(['local_script', 'interpreter_file', 'obfuscated', 'remote_package', 'oversized']);
