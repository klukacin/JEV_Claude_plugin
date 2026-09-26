// lib/gate-signals.mjs — cheap text scan that decides whether a Bash command is worth a Jev call.
// The prefilter answers "provably read-only?"; this answers "could anything here destroy data, kill
// processes, change shared state, run arbitrary code, or reach outside the machine?". Commands with no
// signal skip the Jev round trip. The families were derived from six days of real gate scores; when in
// doubt a pattern belongs here, because a false positive costs one Jev call and a false negative skips
// the gate.

const SYSTEM_BIN_DIRS = ['/bin/', '/usr/bin/', '/usr/local/bin/', '/opt/homebrew/bin/', '/sbin/', '/usr/sbin/'];
const INTERPRETERS = new Set(['python', 'python3', 'node', 'ruby', 'perl', 'php', 'deno', 'bun', 'tsx', 'ts-node', 'bash', 'sh', 'zsh', 'ksh', 'fish', 'osascript', 'Rscript', 'lua', 'groovy', 'swift']);
const PREFIX_WORDS = new Set(['sudo', 'doas', 'time', 'env', 'nohup', 'exec', 'command', 'builtin', 'nice', 'caffeinate', 'then', 'do', 'else', 'if', 'while', 'until', '!']);
const SCRIPT_FILE = /\.(py|mjs|cjs|js|ts|mts|cts|rb|pl|php|sh|bash|zsh|lua|r|swift|groovy|applescript|scpt)$/i;

const FAMILIES = [
  ['process_kill', /\b(kill|pkill|killall)\b/],
  ['fs_delete', /\b(rm|rmdir|unlink|shred|truncate|srm)\b|\brmtree\b|\.unlink(Sync)?\(|\bfs\.(rm|rmdir|rmSync|rmdirSync)\b|\bos\.remove\(|\.remove\(/],
  ['fs_move_copy', /\b(mv|cp|rsync|ditto|dd)\b|\bshutil\.(move|copytree)\b/],
  ['fs_perms', /\b(chmod|chown|chgrp|chflags|xattr|setfacl)\b/],
  ['fs_inplace', /\bsed\b[^|;&]*\s-[a-zA-Z]*i|--in-place\b|\bperl\b[^|;&]*\s-[a-zA-Z]*i/],
  // Writes inside the project (relative paths, Python/Node file writes) are what the Edit and Write
  // tools do anyway and are not gated; only redirects that land outside the project count.
  ['redirect_outside', /(^|[^0-9&>])>{1,2}\|?\s*["']?(~|\$HOME|\/(?!dev\/null\b|tmp\/|private\/tmp\/|var\/folders\/)|[^\s&|;]*\.\.\/)|\btee\b[^|;&]*\s(~|\$HOME|\/(?!dev\/null\b|tmp\/|private\/tmp\/))/],
  ['disk', /\b(mkfs|diskutil|fdisk|parted|newfs|mount|umount|hdiutil)\b/],
  ['git_mutate', /\bgit\b[^|;&]*\b(push|reset|clean|rebase|merge|restore|switch|revert|cherry-pick|filter-branch|filter-repo|update-ref|gc|prune|am|apply)\b|\bgit\b[^|;&]*\bcheckout\b[^|;&]*(\s--(\s|$)|\s-f\b|\s\.(\s|$))|\bgit\b[^|;&]*\bbranch\b[^|;&]*\s-[a-zA-Z]*[dDmM]\b|\bgit\b[^|;&]*\btag\b[^|;&]*\s-d\b|\bgit\b[^|;&]*\bstash\b[^|;&]*\b(drop|clear|pop)\b|\bgit\b[^|;&]*\bworktree\b[^|;&]*\b(remove|prune)\b|\bgit\b[^|;&]*\breflog\b[^|;&]*\bexpire\b|\bgit\b[^|;&]*\bcommit\b[^|;&]*--amend\b|\bgit\b[^|;&]*\bremote\b[^|;&]*\b(add|remove|rm|set-url|rename)\b|\bgit\b[^|;&]*\bconfig\b[^|;&]*\s(--global|--system|--unset\S*|--add|--replace-all)\b/],
  ['db_client', /\b(psql|mysql|mariadb|sqlite3|mongosh?|redis-cli|pg_dump|pg_restore|pg_dumpall|dropdb|createdb|dropuser|createuser|clickhouse-client|cqlsh)\b/],
  ['db_url', /\b(postgres(ql)?|mysql|mariadb|mongodb(\+srv)?|rediss?|amqps?|clickhouse):\/\/|\b\w*(DATABASE|_DB)_URL=/i],
  ['sql_write', /\b(drop|truncate|alter|grant|revoke|vacuum|reindex|pg_terminate_backend)\b|\bdelete\s+from\b|\bupdate\s+[\w."]+\s+set\b|\binsert\s+into\b|\bcreate\s+(database|schema|role|user|table|extension)\b/i],
  ['destructive_word', /\b(deploy|release|publish|migrate|migration|seed|reset|destroy|purge|wipe|prune|nuke|teardown|rollback|uninstall|erase)\b/i],
  ['container', /\bdocker\b[^|;&]*\b(rm|rmi|kill|stop|down|prune|restart|volume|system|network|run|build|push|login|compose|cp|exec)\b|\b(podman|nerdctl)\b|\b(kubectl|helm|kustomize|terraform|tofu|pulumi|ansible(-playbook)?|vagrant|packer)\b/],
  ['network_write', /\bcurl\b[^|;&]*(\s-X\s*(POST|PUT|PATCH|DELETE)|\s--request\s+(POST|PUT|PATCH|DELETE)|\s(-d|--data[\w-]*|-F|--form|-T|--upload-file)\b)|\bwget\b[^|;&]*--(post|method|body)|\b(http|https|xh)\s+(POST|PUT|PATCH|DELETE)\b/i],
  ['remote_access', /\b(ssh|scp|sftp|ftp|telnet|nc|ncat|socat|mosh)\b/],
  ['cloud_cli', /\b(aws|gcloud|gsutil|az|doctl|flyctl|vercel|netlify|heroku|firebase|wrangler|supabase|railway|stripe|twilio)\b|\bfly\s+(deploy|apps|secrets|ssh|scale|machine|volumes)\b|\bgh\s+(pr|issue|release|repo|api|secret|workflow|run|gist|auth|ssh-key)\b|\bnpm\s+(publish|unpublish|deprecate|owner|token|login)\b/],
  ['package_system', /\bsudo\b|\bdoas\b|\bbrew\s+(install|uninstall|remove|upgrade|reinstall|link|unlink|tap|services)\b|\bpip3?\s+(install|uninstall)\b|\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|uninstall|update|upgrade)\b[^|;&]*\s(-g|--global)\b|\bnpx\s+(-y|--yes)\b|\b(gem|cargo)\s+install\b/],
  ['system_config', /\b(launchctl|crontab|systemctl|scutil|networksetup|pmset|softwareupdate|shutdown|reboot|halt|osascript|dscl|spctl|csrutil|nvram|tmutil|mdutil)\b|\bsecurity\s+(add|delete|set|import|export|find)-|\bdefaults\s+(write|delete)\b/],
  ['secrets', /\b(env|printenv)\b|(^|[\s/'"])\.env(\.[\w-]+)?\b|\bid_(rsa|ed25519|ecdsa)\b|\.ssh\/|\.aws\/|\.claude\/settings|keychain|secret|\btoken\b|password/i],
  ['eval_exec', /\beval\b|\bexec\b|\bxargs\b|\bnohup\b|\bdisown\b|\bsetsid\b/],
];

// Split a command into segments and return the command word of each segment (after env assignments
// and wrapper words), with the words that follow it.
function commandHeads(text) {
  const heads = [];
  for (const raw of text.split(/\|\||&&|[;|&\n(){}`]|\$\(/)) {
    const words = raw.trim().split(/\s+/).filter(Boolean);
    while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || PREFIX_WORDS.has(words[0]))) words.shift();
    if (words.length) heads.push(words);
  }
  return heads;
}

// Heredoc bodies are data for the command that reads them (python, psql, cat), not shell commands;
// the content families above still scan them, but they must not be parsed for command heads.
function stripHeredocBodies(text) {
  return text.replace(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, '<<HEREDOC');
}

// Quoted strings are arguments, never command separators; mask them so `}` or `;` inside a sed
// program or a grep pattern cannot start a fake command head. Command substitution nested inside
// double quotes is masked too; the content families above still scan the raw text.
function maskQuotes(text) {
  return text.replace(/'[^']*'/g, "'Q'").replace(/"(?:[^"\\]|\\.)*"/g, '"Q"');
}

function runsArbitraryCode(text) {
  for (const words of commandHeads(maskQuotes(stripHeredocBodies(text)))) {
    const [bin, ...rest] = words;
    if (/^(\.{1,2}|~)\//.test(bin)) return 'local_script';
    if (bin.startsWith('/') && !SYSTEM_BIN_DIRS.some((d) => bin.startsWith(d))) return 'local_script';
    if (bin === 'source' || bin === '.') return 'local_script';
    const base = bin.split('/').pop();
    const args = base === 'npx' || base === 'bunx' ? rest.slice(rest.findIndex((a) => !a.startsWith('-')) + 1) : rest;
    const tool = base === 'npx' || base === 'bunx' ? rest.find((a) => !a.startsWith('-')) : base;
    if (tool && INTERPRETERS.has(tool.split('/').pop())) {
      const target = args.find((a) => !a.startsWith('-'));
      if (target && target !== '-' && (target.includes('/') || SCRIPT_FILE.test(target))) return 'interpreter_file';
    }
  }
  return null;
}

// Returns the first matching family name, or null when the command carries no risk signal.
export function riskSignal(command) {
  const text = String(command ?? '');
  if (!text.trim()) return null;
  for (const [name, re] of FAMILIES) {
    if (re.test(text)) return name;
  }
  return runsArbitraryCode(text);
}

export function hasRiskSignal(command) {
  return riskSignal(command) !== null;
}

export const SIGNAL_FAMILIES = [...FAMILIES.map(([name]) => name), 'local_script', 'interpreter_file'];
