import { div } from 'gpui-kit';
import { v_flex, TextView } from 'gpui-base';
import { appHome, home, props, readTextFile, writeTextFile, closeOverlay } from 'herdr';
import { Button } from './components/button.js';
import { DialogContent, DialogTitle, DialogDescription, DialogFooter } from './components/dialog.js';

// One rules file for every Claude and Codex session started from Devkits on this computer.
export const rulesPath = () => `${appHome()}/data/devkits/AGENTS.md`;

const defaultRules = `# Global rules

These rules are added to every Claude and Codex session started from Herdr Devkits.

## Long-running programs

Start anything that does not exit on its own (an app, a dev server, a simulator, a watcher) as a background child terminal with Herdr's hc, so it appears under this thread:

    hc run --bg --name <short-name> -- <command>

- Do not open a separate tab (no \`herdr-app run tab.new\`), and do not background it with \`&\` or nohup.
- Names use only a-z 0-9 - _, for example run-ios or android-emulator.
- Read its output with \`hc read <name>\`, wait until it is ready with \`hc wait <name> --output "<text>"\`, and stop it with \`hc kill <name>\`.
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

// The rules, read only, in a dialog over the workspace, as Zed shows its rules inside the app.
// It rereads the file every few seconds so edits made elsewhere appear.
export class RulesPreview {
  init(cx) {
    this.handle = cx.focus_handle(); this.handle.focus();
    this.text = undefined;
    const load = async cx => {
      let text = null;
      try { text = await readTextFile(rulesPath()); } catch {}
      if (text !== this.text) { this.text = text; cx.notify(); }
    };
    cx.spawn(load);
    cx.timer.every(3000, cx => cx.spawn(load));
  }

  render(t) {
    const close = () => closeOverlay(props().overlay);
    const path = rulesPath(), shown = path.startsWith(`${home()}/`) ? `~${path.slice(home().length)}` : path;
    return DialogContent('global-rules', t).track_focus(this.handle).accessibility_label('Global rules')
      .on_key_down((event, cx) => { if (event.key === 'escape') { cx.stop_propagation(); close(); } })
      .child(DialogTitle().flex_none().child('Global rules'))
      .child(DialogDescription(t).flex_none().child(`Added to every Claude and Codex session started here. Edit ${shown} to change them.`))
      .child(this.text?.trim()
        ? v_flex().id('rules-markdown').flex_1().min_h(0).overflow_y_scrollbar().border(1).border_color(t.border).p(16)
          .child(TextView.markdown('rules-text', this.text).selectable(true).scrollable(false).w_full())
        : div().flex_1().min_h(0).text_size(12).text_color(t.muted)
          .child(this.text === undefined ? 'Loading rules…' : 'No global rules: new sessions get no extra instructions.'))
      .child(DialogFooter().flex_none().child(Button('global-rules-done', t).on_click(close).child('Done')));
  }
}
