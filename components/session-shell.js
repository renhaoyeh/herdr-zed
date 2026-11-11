// Shared: edit components/session-shell.js, then npm run sync:shared.
export const gitShellCommand = args => ['git', '-c', 'alias.herdr-zed-shell=!sh', 'herdr-zed-shell', ...args];

export function commandArgv(argv, platform) {
  if (platform !== 'windows' || !argv?.length ||
      !(argv[0] === 'env' || /(?:^|[/\\])(?:codex|claude)(?:\.exe|\.cmd)?$/i.test(argv[0]))) return argv;
  return gitShellCommand(['-c', 'exec "$@"', 'herdr-zed-command', ...argv]);
}

export function terminalArgv(argv, platform) {
  const command = commandArgv(argv, platform);
  if (platform !== 'windows' || command?.[2] !== 'alias.herdr-zed-shell=!sh') return command;
  // PowerShell 5.1 strips embedded double quotes; let Git's shell decode them instead.
  const escapes = { '\\': '\\\\', "'": "\\'", '"': '\\x22', '\r': '\\r', '\n': '\\n' };
  const script = command.map(arg => `$'${arg.replace(/[\\'"\r\n]/g, char => escapes[char])}'`).join(' ');
  return gitShellCommand(['-c', `exec ${script}`]);
}

// Read only the literal quoting emitted by our Windows launchers; never run shell text.
function launcherWords(script, ansi = false) {
  const words = [], quote = ansi ? "$'" : "'";
  let offset = 0;
  while (offset < script.length) {
    if (!script.startsWith(quote, offset)) return null;
    offset += quote.length;
    const parts = [];
    let start = offset, closed = false;
    let nextQuote = script.indexOf("'", offset), nextEscape = ansi ? script.indexOf('\\', offset) : -1;
    while (offset < script.length) {
      offset = nextEscape >= 0 && (nextQuote < 0 || nextEscape < nextQuote) ? nextEscape : nextQuote;
      if (offset < 0) return null;
      const char = script[offset];
      if (char === "'") {
        parts.push(script.slice(start, offset)); offset++;
        if (!ansi && script[offset] === "'") {
          parts.push("'"); start = ++offset; nextQuote = script.indexOf("'", offset); continue;
        }
        closed = true; break;
      }
      if (ansi && char === '\\') {
        parts.push(script.slice(start, offset));
        const escape = script[++offset];
        if (script.startsWith('x22', offset)) { parts.push('"'); offset += 3; }
        else if (escape === '\\' || escape === "'" || escape === 'r' || escape === 'n') {
          parts.push(escape === 'r' ? '\r' : escape === 'n' ? '\n' : escape); offset++;
        } else return null;
        start = offset;
        nextEscape = script.indexOf('\\', offset);
        if (nextQuote < offset) nextQuote = script.indexOf("'", offset);
        continue;
      }
    }
    if (!closed) return null;
    words.push(parts.join(''));
    if (offset === script.length) break;
    if (script[offset] !== ' ') return null;
    offset++;
  }
  return words;
}

export function unwrapTerminalArgv(argv = []) {
  for (let depth = 0; depth < 4; depth++) {
    if (/(?:^|[/\\])(?:powershell|pwsh)(?:\.exe)?$/i.test(argv[0] || '')) {
      const command = argv.findIndex(arg => /^-command$/i.test(arg));
      const script = command >= 0 && command === argv.length - 2 && argv[command + 1];
      const words = typeof script === 'string' && script.startsWith('& ') && launcherWords(script.slice(2));
      if (!words || words[0] !== 'git' || words[2] !== 'alias.herdr-zed-shell=!sh') break;
      argv = words;
    } else if (argv[0] === 'git' && argv[1] === '-c' && argv[2] === 'alias.herdr-zed-shell=!sh'
        && argv[3] === 'herdr-zed-shell' && argv[4] === '-c') {
      if (argv[5] === 'exec "$@"' && argv[6] === 'herdr-zed-command') argv = argv.slice(7);
      else {
        const words = argv.length === 6 && argv[5]?.startsWith('exec ') && launcherWords(argv[5].slice(5), true);
        if (!words?.length) break;
        argv = words;
      }
    } else break;
  }
  return argv;
}
