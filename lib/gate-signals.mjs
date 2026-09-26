// lib/gate-signals.mjs — cheap text scan that decides whether a Bash command is worth a Jev call.
// The prefilter answers "provably read-only?"; this answers "could anything here destroy data, kill
// processes, change shared state, run arbitrary or downloaded code, leak secrets, or reach outside the
// machine?". Commands with no signal skip the Jev round trip. The families were derived from six days
// of real gate scores and an adversarial review; when in doubt a pattern belongs here, because a false
// positive costs one Jev call and a false negative skips the gate.
import { allHeads, maskQuotes } from './shell-words.mjs';

const MAX_SCAN = 32768;
const SPAN = String.raw`[^|;&\n]{0,300}`; // bounded "same segment" span; unbounded spans made some inputs quadratic
const SYSTEM_BIN_DIRS = ['/bin/', '/usr/bin/', '/usr/local/bin/', '/opt/homebrew/bin/', '/sbin/', '/usr/sbin/'];
const INTERPRETERS = new Set(['python', 'python3', 'node', 'ruby', 'perl', 'php', 'deno', 'bun', 'tsx', 'ts-node', 'bash', 'sh', 'zsh', 'ksh', 'dash', 'fish', 'osascript', 'Rscript', 'lua', 'groovy', 'swift']);
const SCRIPT_FILE = /\.(py|mjs|cjs|js|ts|mts|cts|rb|pl|php|sh|bash|zsh|lua|r|swift|groovy|applescript|scpt)$/i;
const SAFE_PYTHON_MODULES = new Set(['pytest', 'unittest', 'pip', 'venv', 'json.tool', 'mypy', 'black', 'ruff', 'isort', 'flake8', 'pylint', 'coverage', 'doctest', 'py_compile', 'compileall', 'timeit', 'pydoc', 'site', 'this', 'calendar', 'tokenize', 'ast', 'dis']);
const NPX_KNOWN = new Set(['tsc', 'tsx', 'ts-node', 'eslint', 'prettier', 'vitest', 'jest', 'playwright', 'biome', 'knip', 'turbo', 'nx', 'next', 'vite', 'astro', 'svelte-check', 'vue-tsc', 'stylelint', 'markdownlint', 'cspell', 'depcheck', 'madge', 'c8', 'nyc', 'mocha', 'ava', 'tap', 'size-limit', 'publint']);
const SEARCH_HEADS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);
// Destinations whose modification changes behaviour outside the edited code: dotfiles, system paths,
// git hooks and config, CI, agent configuration.
const OUTSIDE = String.raw`(~|\$HOME|\/(?!dev\/null\b|tmp\/|private\/tmp\/|var\/folders\/)|[^\s&|;]*\.\.\/|\.git\/(hooks|config)|\.husky\/|\.mcp\.json|\.envrc|\.claude\/|\.github\/workflows\/)`;
// Word match in which "_" also separates, so `reset_db` and `seed_demo` still match.
const W = (words) => String.raw`(?<![A-Za-z0-9])(${words})(?![A-Za-z0-9])`;
const re = (source, flags = '') => new RegExp(source.replaceAll('%S', SPAN).replaceAll('%O', OUTSIDE), flags);

const FAMILIES = [
  ['pipe_to_shell', re(String.raw`\|\s*(sudo\s+)?(env\s+[^|;&\n]{0,80}\s)?\S*?\b((ba|z|k|da|fi|c|tc)?sh|python[0-9.]*|node|perl|ruby|php|bun|deno|osascript)\b|<\(\s*(curl|wget|fetch)\b|\b(ba|z|k|da|fi)?sh\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*c\b|\b(ba|z|k|da)?sh\s*<<|\b(source|\.)\s+<\(`)],
  ['process_kill', re(String.raw`\b(kill|pkill|killall)\b|\bfuser\b%S\s-k\b|\bpm2\s+(delete|stop|kill|restart|flush)\b|\bpg_ctl(cluster)?\b%S\b(stop|restart|kill)\b|\bsupervisorctl\s+(stop|restart|shutdown)\b|\bscreen\b%S-X\s+quit\b|\btmux\s+kill-|\bservice\s+\S+\s+(stop|restart)\b|\bbrew\s+services\s+(stop|restart)\b`)],
  ['fs_delete', re(String.raw`\b(rm|rmdir|unlink|shred|truncate|srm|trash)\b|rm_rf|rm_r\b|remove_dir|rmtree|\.unlink(Sync)?\(|\.(rm|rmdir)(Sync)?\(|\brm(dir)?Sync\(|\bos\.remove\(|\.remove\(|\bfind\b%S\s-(delete|exec|execdir|ok|okdir)\b`)],
  ['fs_move_copy', re(String.raw`\b(mv|cp|rsync|ditto|dd|rclone)\b|\bshutil\.(move|copytree)\b`)],
  ['fs_perms', re(String.raw`\b(chmod|chown|chgrp|chflags|xattr|setfacl)\b`)],
  ['fs_inplace', re(String.raw`\bsed\b%S\s-[a-zA-Z]*i|--in-place\b|\bperl\b%S\s-[a-zA-Z]*i`)],
  ['redirect_outside', re(String.raw`(?:^|[^<>])(?:\d|&)?>{1,2}\|?\s*["']?%O|\btee\b%S\s["']?%O`)],
  ['disk', re(String.raw`\b(mkfs|diskutil|fdisk|parted|newfs|mount|umount|hdiutil)\b`)],
  ['git_mutate', re(String.raw`\bgit\b%S\b(push|pull|reset|clean|rebase|merge|restore|switch|revert|cherry-pick|filter-branch|filter-repo|update-ref|gc|prune|am|apply|submodule|send-email|checkout|config|rm|mv)\b|\bgit\b%S\bbranch\b%S\s(-[a-zA-Z]*[dDmMfcC]\b|--(delete|move|force|copy)\b)|\bgit\b%S\btag\b%S\s(-[a-zA-Z]*[df]\b|--(delete|force)\b)|\bgit\b%S\bstash\b%S\b(drop|clear|pop)\b|\bgit\b%S\bworktree\b%S\b(remove|prune)\b|\bgit\b%S\breflog\b%S\bexpire\b|\bgit\b%S\bcommit\b%S--amend\b|\bgit\b%S\bremote\b%S\b(add|remove|rm|set-url|rename)\b|\bgit\s+(-c|--config-env)\b`)],
  ['db_client', re(String.raw`\b(psql|mysql|mariadb|sqlite3|mongosh?|redis-cli|pg_dump|pg_restore|pg_dumpall|dropdb|createdb|dropuser|createuser|clickhouse-client|cqlsh)\b`)],
  ['db_url', re(String.raw`\b(postgres(ql)?|mysql|mariadb|mongodb(\+srv)?|rediss?|amqps?|clickhouse):\/\/|\b\w*(DATABASE|_DB)_URL=`, 'i')],
  ['db_destructive', re(String.raw`\bdb\s+push\b|--accept-data-loss|--force-reset|\bdrizzle-kit\s+(push|drop|migrate)\b|\bdowngrade\b|\bflush(all|db)?\b|schema:load|\bdb:(drop|reset|schema|seed|setup|migrate|rollback|create|prepare)\b|destroy_all|delete_all|\bflyway\s+(clean|migrate|repair|undo)\b|\bdotnet\s+ef\s+database\b|\bknex\s+migrate|\bsequelize\s+db:|\btypeorm\s+(schema:drop|migration:run)\b|\brails\s+runner\b|\bmanage\.py\s+(flush|migrate|loaddata|sqlflush)\b`)],
  ['sql_write', re(String.raw`${W('drop|truncate|alter|grant|revoke|vacuum|reindex|pg_terminate_backend')}|\bdelete\s+from\b|\bupdate\s+[\w."]+\s+set\b|\binsert\s+into\b|\bcreate\s+(database|schema|role|user|table|extension)\b`, 'i')],
  ['destructive_word', re(W('deploy|release|publish|migrate|migration|seed|reset|destroy|purge|wipe|prune|nuke|teardown|rollback|uninstall|erase|delete|remove|terminate'), 'i')],
  ['container', re(String.raw`\bdocker\b%S\b(rm|rmi|kill|stop|down|prune|restart|volume|system|network|run|build|push|login|cp|exec|update|commit|load|import|save)\b|\bdocker[\s-]compose\b%S\b(up|down|rm|stop|kill|restart|run|exec|build|push|pull|create|cp)\b|\b(podman|nerdctl)\b|\b(kubectl|helm|kustomize|terraform|tofu|pulumi|ansible(-playbook)?|vagrant|packer)\b`)],
  ['network_write', re(String.raw`\bcurl\b%S(\s-X\s*|\s--request[=\s]\s*)(POST|PUT|PATCH|DELETE)\b|\bcurl\b%S\s(-d|--data[\w-]*|-F|--form|-T|--upload-file|--json)\b|\bcurl\b%S\s-H\s*["']?@|\b(curl|wget)\b%S(\$\(|\x60)|\bwget\b%S--(post|method|body)|\b(http|https|xh)\s+(POST|PUT|PATCH|DELETE)\b|\bcurl\b%S\s(-o|--output)\s*["']?%O|\bwget\b%S\s(-O|--output-document)\s*["']?%O`, 'i')],
  ['remote_access', re(String.raw`\b(ssh|scp|sftp|ftp|telnet|nc|ncat|socat|mosh)\b`)],
  ['cloud_cli', re(String.raw`\b(aws|gcloud|gsutil|az|doctl|flyctl|vercel|netlify|heroku|firebase|wrangler|supabase|railway|stripe|twilio|s3cmd|hcloud|serverless|sls)\b|\bfly\s+(deploy|apps|secrets|ssh|scale|machine|volumes)\b|\bgh\s+(pr\s+(create|merge|close|reopen|edit|comment|review|ready)|issue\s+(create|close|reopen|edit|comment|delete|transfer)|release\s+(create|delete|edit|upload)|repo\s+(create|delete|edit|fork|rename|archive|sync)|secret|variable|workflow\s+(run|enable|disable)|run\s+(rerun|cancel|delete)|gist\s+(create|edit|delete)|auth|ssh-key|label\s+(create|edit|delete))\b|\bgh\s+api\b%S\s(-X|--method|-f|-F|--field|--raw-field|--input)\b|\bnpm\s+(publish|unpublish|deprecate|owner|token|login)\b`)],
  ['remote_package', re(String.raw`\b(bunx|uvx)\b|\b(pnpm|yarn)\s+dlx\b|\bpipx\s+run\b|\b(deno|bun)\s+run\b%Shttps?:\/\/|\bnpx\s+(-y|--yes|-p|--package)\b`)],
  ['package_system', re(String.raw`\bsudo\b|\bdoas\b|\bbrew\s+(install|uninstall|remove|upgrade|reinstall|link|unlink|tap|services)\b|\bpip3?\s+(install|uninstall)\b|\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|uninstall|update|upgrade)\b%S\s(-g|--global)\b|\b(gem|cargo)\s+install\b`)],
  ['system_config', re(String.raw`\b(launchctl|crontab|systemctl|scutil|networksetup|pmset|softwareupdate|shutdown|reboot|halt|osascript|dscl|spctl|csrutil|nvram|tmutil|mdutil)\b|\bsecurity\s+(add|delete|set|import|export|find)-|\bdefaults\s+(write|delete)\b`)],
  ['secrets', re(String.raw`(?:^|[;&|(\n]\s*)(?:printenv\b|env\s*(?:$|[;&|)\n]))|(^|[\s/'"=])\.env(\.[\w-]+)?\b|\bid_(rsa|ed25519|ecdsa)\b|\.ssh\/|\.aws\/|\.claude\/settings|keychain|secret|\btoken\b|password|\.npmrc|\.netrc|\.pgpass|\.git-credentials|\.docker\/config\.json|\.kube\/config|gh\/hosts\.yml|\$\{?\w*(API_KEY|_KEY|TOKEN|SECRET|PASSWORD)\b`, 'i')],
  ['eval_exec', re(String.raw`\beval\b|\bexec\b|\bnohup\b|\bdisown\b|\bsetsid\b|\bos\.system\(|\bsubprocess\.|child_process|\bexecSync\(|\bspawnSync\(|\bKernel\.system\b`)],
];

// Commit and PR messages are prose; words like "reset" or "apply" in them are not actions.
function maskMessages(text) {
  return text
    .replace(/(\s(?:-m|--message|--title|--body|--notes))\s+"\$\(cat\s+<<-?\s*'?(\w+)'?\n[\s\S]*?\n\2\s*\)"/g, '$1 "Q"')
    .replace(/(\s(?:-m|--message|--title|--body|--notes))(=|\s+)("(?:[^"\\]|\\.)*"|'[^']*')/g, '$1$2"Q"');
}

// Search patterns are data: `grep -rn "reset\|clear"` or `rg 'token|secret'` perform no action.
// Only a line that is a single pipeline starting with a search tool is masked.
function maskSearchPatterns(text) {
  return text.split('\n').map((line) => {
    const trimmed = line.trim().replace(/^([A-Za-z_]\w*=\S*\s+)+/, '');
    const head = (trimmed.split(/\s+/)[0] || '').split('/').pop();
    const isSearch = SEARCH_HEADS.has(head) || /^git\s+(grep|log)\b/.test(trimmed);
    if (!isSearch || /[;&]|\$\(|`/.test(maskQuotes(line))) return line;
    return maskQuotes(line);
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
  if (/^python/.test(name) && args[0] === '-m' && args[1] && !SAFE_PYTHON_MODULES.has(args[1])) return 'interpreter_file';
  const target = args.find((a) => !a.startsWith('-'));
  if (target && target !== '-' && (target.includes('/') || SCRIPT_FILE.test(target))) return 'interpreter_file';
  return null;
}

// Returns the first matching family name, or null when the command carries no risk signal.
export function riskSignal(command) {
  const text = String(command ?? '');
  if (!text.trim()) return null;
  if (text.length > MAX_SCAN) return 'oversized';
  const scan = maskSearchPatterns(maskMessages(text));
  for (const [name, pattern] of FAMILIES) {
    if (pattern.test(scan)) return name;
  }
  for (const words of allHeads(text)) {
    const s = headSignal(words);
    if (s) return s;
  }
  return null;
}

// Every matching family, for tests and diagnostics (riskSignal stops at the first).
export function riskSignals(command) {
  const text = String(command ?? '');
  if (!text.trim()) return [];
  if (text.length > MAX_SCAN) return ['oversized'];
  const scan = maskSearchPatterns(maskMessages(text));
  const found = FAMILIES.filter(([, pattern]) => pattern.test(scan)).map(([name]) => name);
  for (const words of allHeads(text)) {
    const s = headSignal(words);
    if (s && !found.includes(s)) found.push(s);
  }
  return found;
}

export function hasRiskSignal(command) {
  return riskSignal(command) !== null;
}

export const SIGNAL_FAMILIES = [...FAMILIES.map(([name]) => name), 'local_script', 'interpreter_file', 'obfuscated', 'remote_package', 'oversized'];
