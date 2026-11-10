import { div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { props, closeOverlay } from 'herdr';
import { execShell } from './shell.js';
import { DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator } from './components/dropdown-menu.js';
import { glyph } from './components/icon.js';

const SCRIPT = 'cd "$1" || exit 2; git for-each-ref --sort=-committerdate --format="%(refname)%09%(committerdate:relative)" refs/heads refs/remotes';

// Local branches, then remote ones, most recently committed first; a remote's HEAD alias is left out.
export function parseBranches(text) {
  const local = [], remote = [];
  for (const line of text.split('\n')) {
    const [ref, when = ''] = line.split('\t');
    if (ref.startsWith('refs/heads/')) local.push({ name: ref.slice(11), when });
    else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) remote.push({ name: ref.slice(13), when });
  }
  return { local, remote };
}

export async function readBranches(folder, on) {
  const result = await execShell(['-c', SCRIPT, 'devkits-branches', folder], { on });
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'Cannot read branches.');
  return parseBranches(result.stdout);
}

// The project's branches under the header's branch name, like Zed's branch picker, read only for now.
export class BranchMenu {
  init(cx) {
    this.handle = cx.focus_handle(); this.handle.focus();
    this.branches = null; this.error = null;
    const { folder, machine } = props();
    cx.spawn(async cx => {
      try { this.branches = await readBranches(folder, machine || null); }
      catch (error) { this.error = error.message; }
      cx.notify();
    });
  }

  render(t) {
    const current = props().branch;
    const { local = [], remote = [] } = this.branches || {};
    const message = this.error || (this.branches ? null : 'Loading…');
    // Rows are not choices yet: no hover or pointer, only the current branch's check.
    const row = (kind, branch) => h_flex().id(`branch-${kind}-${branch.name}`).h(32).flex_none().px(8).gap(8).items_center()
      .child(glyph('branch').text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().child(branch.name))
      .child(div().flex_none().text_size(11).text_color(t.muted).child(branch.when))
      .child(div().size(14).flex_none().when(kind === 'local' && branch.name === current, el => el.child(glyph('check'))));
    const height = 10 + (message ? 30 : 28 + local.length * 32 + (remote.length ? 9 + 28 + remote.length * 32 : 0));
    return DropdownMenuContent('branch-menu', Math.min(420, height), t)
      .track_focus(this.handle)
      .on_key_down(event => { if (event.key === 'escape') closeOverlay(props().overlay); })
      .when(Boolean(message), el => el.child(div().h(30).flex_none().px(8).flex().items_center().text_size(12).text_color(t.muted).child(message)))
      .when(!message, el => el.child(v_flex().id('branch-list').flex_1().min_h(0).overflow_y_scrollbar()
        .child(DropdownMenuLabel(t).child('LOCAL'))
        .children(local.map(branch => row('local', branch)))
        .when(remote.length > 0, el => el.child(DropdownMenuSeparator(t)).child(DropdownMenuLabel(t).child('REMOTE'))
          .children(remote.map(branch => row('remote', branch))))));
  }
}
