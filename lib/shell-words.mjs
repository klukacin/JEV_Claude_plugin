// lib/shell-words.mjs — just enough shell parsing to find the command word of every segment.
// Used by the gate (does this run arbitrary code?) and by the claim check (did this run the tests?).
// It is deliberately approximate: callers treat anything odd as "look closer", never as "safe".

// Words that run the command that follows them, with the options of each that take a value.
const WRAPPER_VALUE_FLAGS = {
  sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U'],
  doas: ['-u', '-C'],
  env: ['-u', '-C', '-P', '-S', '--unset', '--chdir'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  gtimeout: ['-s', '-k', '--signal', '--kill-after'],
  stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'],
  dotenv: ['-e', '-v', '-c'],
  xargs: ['-a', '-E', '-e', '-I', '-i', '-J', '-L', '-l', '-n', '-P', '-R', '-S', '-s', '-d', '--arg-file', '--max-args', '--max-procs', '--max-lines', '--delimiter', '--replace'],
  nice: ['-n', '--adjustment'],
  ionice: ['-c', '-n', '-p'],
  watch: ['-n', '-d', '--interval'],
  time: [],
  nohup: [],
  exec: ['-a'],
  command: [],
  builtin: [],
  caffeinate: ['-t', '-w'],
  chronic: [],
  unbuffer: [],
  taskpolicy: ['-c', '-d', '-g', '-b'],
  arch: [],
  busybox: [],
  then: [], do: [], else: [], if: [], while: [], until: [], '!': [],
};
// Two-word wrappers: `uv run python x.py`, `bundle exec rake`, `pnpm exec tsx x.ts`.
const TWO_WORD_WRAPPERS = {
  'uv run': ['--with', '--with-requirements', '--python', '-p', '--project', '--directory', '--package', '--env-file', '--group', '--extra', '--index', '--index-url'],
  'poetry run': ['-C', '--directory', '-P', '--project'],
  'pipenv run': [],
  'pdm run': ['-p', '--project'],
  'hatch run': ['-e', '--env'],
  'rye run': [],
  'conda run': ['-n', '--name', '-p', '--prefix'],
  'bundle exec': ['--gemfile'],
  'pnpm exec': ['-C', '--dir', '--filter', '-F'],
  'yarn exec': [],
  'npm exec': ['--package', '-p', '-w', '--workspace', '-c', '--call'],
};

// Heredoc bodies are data for the command that reads them. Replace each body that has a matching
// terminator line, keeping the rest of the opening line, so `cat <<'X' && ./run.sh` still exposes
// `./run.sh`. Linear in the number of lines: an opener without a terminator is left alone.
export function stripHeredocBodies(text) {
  const lines = String(text ?? '').split('\n');
  const positions = new Map();
  lines.forEach((line, i) => {
    const key = line.trim();
    if (!/^[A-Za-z_][\w-]*$/.test(key)) return;
    if (!positions.has(key)) positions.set(key, []);
    positions.get(key).push(i);
  });
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/);
    const ends = m ? positions.get(m[2]) : null;
    const end = ends ? ends.find((j) => j > i) : undefined;
    if (m && end !== undefined) {
      out.push(line.slice(0, m.index) + '<<HEREDOC' + line.slice(m.index + m[0].length));
      i = end + 1;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join('\n');
}

// Quoted strings are arguments, never separators or command words. One left-to-right pass, so
// `"a'" ; rm x ; "'"` masks the two double-quoted strings and leaves `rm x` visible.
export function maskQuotes(text) {
  return String(text ?? '').replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (m) => (m[0] === "'" ? "'Q'" : '"Q"'));
}

// Start and end offsets of every quoted span, from the same left-to-right pass.
export function quotedSpans(text) {
  const spans = [];
  for (const m of String(text ?? '').matchAll(/'[^']*'|"(?:[^"\\]|\\.)*"/g)) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

// The inner text of every innermost $(...) and every `...`, analysed as commands of their own.
export function substitutions(text) {
  const inner = [];
  for (const m of String(text ?? '').matchAll(/\$\(([^()]*)\)/g)) inner.push(m[1]);
  for (const m of String(text ?? '').matchAll(/`([^`]*)`/g)) inner.push(m[1]);
  return inner;
}

function skipOptions(words, valueFlags) {
  while (words.length && words[0].startsWith('-')) {
    const flag = words.shift();
    if (flag === '--') break;
    if (!flag.includes('=') && valueFlags.includes(flag) && words.length) words.shift();
  }
}

// Split masked text into segments and return, for each, the command word followed by its arguments,
// with environment assignments and wrapper words (and their options) removed.
export function commandHeads(text) {
  const heads = [];
  for (const raw of String(text ?? '').split(/\|\||&&|[;|&\n(){}`]|\$\(/)) {
    const words = raw.trim().split(/\s+/).filter(Boolean);
    let changed = true;
    while (words.length && changed) {
      changed = false;
      while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) { words.shift(); changed = true; }
      const single = words.length ? words[0].split('/').pop() : null;
      if (single && Object.hasOwn(WRAPPER_VALUE_FLAGS, single) && (single === words[0] || words[0].startsWith('/'))) {
        words.shift();
        skipOptions(words, WRAPPER_VALUE_FLAGS[single]);
        if ((single === 'timeout' || single === 'gtimeout') && words.length && /^\d+(\.\d+)?[smhd]?$/.test(words[0])) words.shift();
        if (single === 'watch' && words.length && /^\d/.test(words[0])) words.shift();
        changed = true;
      }
      const pair = words.length > 1 ? `${words[0]} ${words[1]}` : null;
      if (pair && Object.hasOwn(TWO_WORD_WRAPPERS, pair)) {
        words.splice(0, 2);
        skipOptions(words, TWO_WORD_WRAPPERS[pair]);
        changed = true;
      }
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
