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
  // Git's MSYS shell truncates long -c arguments on Windows. Carry the literal
  // script in a process-local environment variable instead, retaining terminal stdin.
  // Encode whitespace so the short eval command's word splitting is lossless.
  const escapes = { '\\': '\\\\', "'": "\\'", '"': '\\x22', ' ': '\\x20', '\t': '\\t', '\r': '\\r', '\n': '\\n', '‘': '\\xE2\\x80\\x98', '’': '\\xE2\\x80\\x99' };
  const script = argv.map(arg => `$'${arg.replace(/[\\'" \t\r\n‘’]/g, char => escapes[char])}'`).join(' ');
  return ['powershell.exe', '-NoProfile', '-Command', WINDOWS_SHELL_PREFIX + `'unset HERDR_ZED_COMMAND; exec ${script.replace(/'/g, "''")}'` + WINDOWS_SHELL_SUFFIX];
}

const WINDOWS_SHELL_PREFIX = '$env:HERDR_ZED_COMMAND = ';
const WINDOWS_SHELL_SUFFIX = "; & (Join-Path (& git --exec-path) '../../../usr/bin/sh.exe') '-c' 'eval $HERDR_ZED_COMMAND'";

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
        else if (script.startsWith('x20', offset)) { parts.push(' '); offset += 3; }
        else if (script.startsWith('xE2\\x80\\x98', offset) || script.startsWith('xE2\\x80\\x99', offset)) {
          parts.push(script.startsWith('xE2\\x80\\x98', offset) ? '‘' : '’'); offset += 11;
        }
        else if (escape === '\\' || escape === "'" || escape === 'r' || escape === 'n' || escape === 't') {
          parts.push(escape === 'r' ? '\r' : escape === 'n' ? '\n' : escape === 't' ? '\t' : escape); offset++;
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
      if (typeof script === 'string' && script.startsWith(WINDOWS_SHELL_PREFIX) && script.endsWith(WINDOWS_SHELL_SUFFIX)) {
        const literal = launcherWords(script.slice(WINDOWS_SHELL_PREFIX.length, -WINDOWS_SHELL_SUFFIX.length));
        const prefix = 'unset HERDR_ZED_COMMAND; exec ';
        const words = literal?.length === 1 && literal[0].startsWith(prefix) && launcherWords(literal[0].slice(prefix.length), true);
        if (!words?.length) break;
        argv = words; continue;
      }
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
