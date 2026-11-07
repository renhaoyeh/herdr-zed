import { appHome, readTextFile, writeTextFile, exec, window, notify } from 'herdr';

// One rules file for every Claude and Codex session started from Devkits on this computer.
export const rulesPath = () => `${appHome()}/data/devkits/AGENTS.md`;

const defaultRules = `# Global rules

這些規則會加到每個從 Herdr Devkits 開啟的 Claude 和 Codex session。

## 長時間執行的程序

啟動 app、dev server、模擬器、watch 等不會自己結束的程序時，一律用 Herdr 的 hc 在背景開子終端，讓它顯示在這個 thread 底下：

    hc run --bg --name <短名稱> -- <指令>

- 不要另開 tab（不要用 herdr-app run tab.new），也不要用 \`&\`、nohup 背景執行。
- 名稱只能用 a-z 0-9 - _，例如 run-ios、android-emulator。
- 看輸出用 \`hc read <名稱>\`，等它就緒用 \`hc wait <名稱> --output "<關鍵字>"\`，結束用 \`hc kill <名稱>\`。
`;

// The rules to add to a new session, or null when the file is missing or empty.
export async function sessionRules() {
  const text = await readTextFile(rulesPath());
  return text?.trim() ? { file: rulesPath(), text } : null;
}

// Writes the starting rules once; a file the person emptied stays empty.
export async function ensureRules() {
  if (await readTextFile(rulesPath()) === null) await writeTextFile(rulesPath(), defaultRules, null);
}

export async function editRules() {
  try {
    await ensureRules();
    const path = rulesPath(), platform = window()?.platform;
    const result = platform === 'macos' ? await exec('open', ['-t', path])
      : platform === 'windows' ? await exec('cmd', ['/c', 'start', '', path]) : await exec('xdg-open', [path]);
    if (result.code) throw new Error(result.stderr.trim() || 'No editor opened the rules file.');
  } catch (error) { notify({ title: 'Could not open global rules', body: error.message, level: 'error' }); }
}
