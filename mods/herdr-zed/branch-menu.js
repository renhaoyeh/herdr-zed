import { div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { props, closeOverlay, shared, notify } from 'herdr';
import { execShell } from './shell.js';
import { extensionCatalog } from './extensions.js';
import { credentialArgsFor } from './git-credentials.js';
import { DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator } from './components/dropdown-menu.js';
import { glyph } from './components/icon.js';

const SCRIPT = 'cd "$1" || exit 2; git for-each-ref --sort=-committerdate --format="%(refname)%09%(committerdate:relative)" refs/heads refs/remotes';
// The Git panel's runner: credential `-c` pairs go before the git arguments.
const GIT = 'cd "$1" || exit 2; shift; GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never git "$@"';

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
  const result = await execShell(['-c', SCRIPT, 'herdr-zed-branches', folder], { on });
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'Cannot read branches.');
  return parseBranches(result.stdout);
}

// A local row switches to its branch. A remote row switches to the local branch of the same name when one exists,
// and otherwise creates that branch tracking the remote one. `branch` is the local branch the row ends on.
export function switchPlan(kind, name, localNames) {
  if (kind === 'local') return { branch: name, args: ['switch', name] };
  const branch = name.slice(name.indexOf('/') + 1);
  return localNames.includes(branch) ? { branch, args: ['switch', branch] } : { branch, args: ['switch', '--track', name] };
}

// The project's branches under the header's branch name, like Zed's branch picker.
export class BranchMenu {
  init(cx) {
    this.handle = cx.focus_handle(); this.handle.focus();
    this.branches = null; this.error = null; this.busy = false;
    const { folder, machine } = props();
    cx.spawn(async cx => {
      try { this.branches = await readBranches(folder, machine || null); }
      catch (error) { this.error = error.message; }
      cx.notify();
    });
  }

  // Switches the project's checkout to the row's branch. A dirty checkout is refused and the menu stays open.
  async choose(kind, branch, cx) {
    const project = props(), current = project.branch;
    const localNames = (this.branches?.local || []).map(item => item.name);
    const plan = switchPlan(kind, branch.name, localNames);
    if (this.busy || plan.branch === current) return;
    const on = project.machine || null;
    const credentialArgs = credentialArgsFor(extensionCatalog().resolved?.gitCredentials,
      { folder: project.folder, machine: on }, shared, message => notify({ title: 'Git credentials ignored', body: message, level: 'error' }));
    this.busy = true; cx.notify();
    try {
      const status = await execShell(['-c', GIT, 'herdr-zed-git', project.folder, ...credentialArgs, 'status', '--porcelain'], { on });
      if (status.code !== 0) throw new Error(status.stderr.trim() || 'Cannot read changes.');
      if (status.stdout.trim()) {
        notify({ title: 'Commit or stash changes before switching branches', level: 'error' });
        return;
      }
      const result = await execShell(['-c', GIT, 'herdr-zed-git', project.folder, ...credentialArgs, ...plan.args], { on });
      if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || 'Could not switch branch.');
      closeOverlay(project.overlay);
    } catch (error) {
      closeOverlay(project.overlay);
      notify({ title: 'Could not switch branch', body: error.message, level: 'error' });
    } finally {
      this.busy = false; cx.notify();
    }
  }

  render(t) {
    const current = props().branch;
    const { local = [], remote = [] } = this.branches || {};
    const localNames = local.map(item => item.name);
    const message = this.error || (this.branches ? null : 'Loading…');
    // The current branch is checked and inert; so is a remote whose local branch is the current one.
    const row = (kind, branch) => {
      const inert = switchPlan(kind, branch.name, localNames).branch === current;
      return h_flex().id(`branch-${kind}-${branch.name}`).h(32).flex_none().px(8).gap(8).items_center()
        .when(!inert, el => el.cursor_pointer().hover(el => el.bg(t.hover)).on_click((_event, cx) => this.choose(kind, branch, cx)))
        .child(glyph('branch').text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(branch.name))
        .child(div().flex_none().text_size(11).text_color(t.muted).child(branch.when))
        .child(div().size(14).flex_none().when(kind === 'local' && branch.name === current, el => el.child(glyph('check'))));
    };
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
