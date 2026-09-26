// lib/shell-words.mjs — just enough shell parsing to find the command word of every segment.
// Used by the gate (does this run arbitrary code?) and by the claim check (did this run the tests?).
// It is deliberately approximate: callers treat anything odd as "look closer", never as "safe".

// Words that run the command that follows them.
const WRAPPERS = new Set(['sudo', 'doas', 'time', 'env', 'nohup', 'exec', 'command', 'builtin', 'nice', 'caffeinate', 'then', 'do', 'else', 'if', 'while', 'until', '!', 'timeout', 'gtimeout', 'stdbuf', 'unbuffer', 'dotenv', 'xargs', 'watch', 'chronic', 'ionice', 'taskpolicy', 'arch']);
// Two-word wrappers: `uv run python x.py`, `bundle exec rake`, `pnpm exec tsx x.ts`.
const TWO_WORD_WRAPPERS = [['uv', 'run'], ['poetry', 'run'], ['pipenv', 'run'], ['pdm', 'run'], ['hatch', 'run'], ['rye', 'run'], ['conda', 'run'], ['bundle', 'exec'], ['pnpm', 'exec'], ['yarn', 'exec'], ['npm', 'exec']];

// Replace heredoc bodies (data for the command that reads them) while keeping the rest of the
// opening line, so `cat <<'X' && ./run.sh` still exposes `./run.sh`.
export function stripHeredocBodies(text) {
  return String(text ?? '').replace(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1([^\n]*)\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, '<<HEREDOC$3');
}

// Quoted strings are arguments, never separators or command words.
export function maskQuotes(text) {
  return String(text ?? '').replace(/'[^']*'/g, "'Q'").replace(/"(?:[^"\\]|\\.)*"/g, '"Q"');
}

// The inner text of every $(...) and `...`, analysed as commands of their own.
export function substitutions(text) {
  const inner = [];
  for (const m of String(text ?? '').matchAll(/\$\(([^()]*)\)/g)) inner.push(m[1]);
  for (const m of String(text ?? '').matchAll(/`([^`]*)`/g)) inner.push(m[1]);
  return inner;
}

function skipWrapperArgs(word, words) {
  // timeout [-s SIG] [-k D] DURATION cmd; stdbuf -oL cmd; dotenv [-e file] -- cmd; xargs [-flags] cmd
  while (words.length && words[0].startsWith('-')) {
    const flag = words.shift();
    if (['-s', '-k', '-e', '-I', '-n', '-P', '-L', '-d', '-c', '--signal', '--kill-after'].includes(flag) && words.length) words.shift();
    if (flag === '--') break;
  }
  if ((word === 'timeout' || word === 'gtimeout') && words.length && /^\d+(\.\d+)?[smhd]?$/.test(words[0])) words.shift();
  if (word === 'watch' && words.length && /^\d/.test(words[0])) words.shift();
}

// Split masked text into segments and return, for each, the command word followed by its arguments,
// with environment assignments and wrapper words removed.
export function commandHeads(text) {
  const heads = [];
  for (const raw of String(text ?? '').split(/\|\||&&|[;|&\n(){}`]|\$\(/)) {
    const words = raw.trim().split(/\s+/).filter(Boolean);
    let changed = true;
    while (words.length && changed) {
      changed = false;
      while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) { words.shift(); changed = true; }
      if (words.length && WRAPPERS.has(words[0])) { const w = words.shift(); skipWrapperArgs(w, words); changed = true; }
      const pair = TWO_WORD_WRAPPERS.find(([a, b]) => words[0] === a && words[1] === b);
      if (pair) { words.splice(0, 2); skipWrapperArgs(pair[0], words); changed = true; }
    }
    if (words.length) heads.push(words);
  }
  return heads;
}

// All command heads of a command line: the top level plus every command substitution.
export function allHeads(command) {
  const stripped = stripHeredocBodies(command);
  const heads = commandHeads(maskQuotes(stripped));
  for (const inner of substitutions(stripped)) heads.push(...commandHeads(maskQuotes(inner)));
  return heads;
}
