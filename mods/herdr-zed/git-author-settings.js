import { Input } from './components/input.js';
import { div } from 'gpui-kit';
import { InputState, h_flex, v_flex } from 'gpui-base';
import { Autosave } from './components/autosave.js';
import { readGitAuthor, saveGitAuthor } from './git-author.js';
import { openOverlay, closeOverlay, props } from 'herdr';
import { DialogContent, DialogHeader, DialogDescription } from './components/dialog.js';

// Changes opens this editor for its selected repository. The captured context never follows later project switches.
export function openGitAuthor(project) {
  if (!project?.folder || project.allRepositories) return null;
  return openOverlay({ mod: 'herdr-zed', kind: 'dialog', frame: 'none', modal: true, width: 760, height: 400,
    props: { view: 'commit-author', context: { folder: project.folder, machine: project.machine || null, name: project.name || project.folder } } });
}

export class GitAuthorDialog {
  init(cx) { this.target = props(); this.form = new GitAuthorSettings(this.target.context); this.form.init(cx); this.handle = cx.focus_handle(); this.handle.focus(); }
  close() { this.form.close(); }
  render(t) {
    // design.md, Saving: edits save themselves; closing writes any still waiting, then closes.
    const close = () => { this.form.auto.flush().finally(() => closeOverlay(this.target.overlay)); };
    return DialogContent('commit-author', t).min_h(0).track_focus(this.handle)
      .on_key_down((event, cx) => { if (event.key === 'escape') { cx.stop_propagation(); close(); } })
      .child(v_flex().id('commit-author-header').flex_none().gap(6)
        .child(DialogHeader(t, 'Commit author', { id: 'commit-author-close', label: 'Close commit author', onClose: () => close() }))
        .child(DialogDescription(t).child('Name and email for future commits in this repository. Changes save automatically.'))
        .child(div().text_size(12).text_color(t.muted).truncate().child(this.target.context.folder)))
      .child(this.form.render(t));
  }
}

// Repository-local identity form. Provider accounts (GitHub) have their own configuration. It saves itself shortly after
// the last edit (design.md, Saving); an empty name or email is never written.
export class GitAuthorSettings {
  constructor(target) { this.target = target; }

  init(cx) {
    this.loading = true;
    this.name = InputState.new({ placeholder: 'Name' });
    this.email = InputState.new({ placeholder: 'Email' });
    for (const input of [this.name, this.email]) input.on('change', (_event, cx) => cx.notify());
    this.auto = new Autosave({
      snapshot: () => JSON.stringify([this.name.value(), this.email.value()]),
      valid: () => Boolean(this.name.value().trim() && this.email.value().trim()),
      save: () => saveGitAuthor(this.target.folder, this.target.machine, { name: this.name.value(), email: this.email.value() }),
    });
    this.auto.attach(cx);
    cx.spawn(async cx => {
      try {
        const author = await readGitAuthor(this.target.folder, this.target.machine);
        if (this.closed) return;
        this.name.set_value(author.name); this.email.set_value(author.email); this.loaded = true;
        this.auto.reset();
      } catch (error) { this.error = error.message; }
      finally { this.loading = false; if (!this.closed) cx.notify(); }
    });
  }

  close() { this.closed = true; this.name?.release(); this.email?.release(); }

  render(t) {
    const field = (key, label, state) => v_flex().gap(6)
      .child(div().text_size(12).child(label))
      .child(Input.new(state, t).id(`git-author-${key}`).h(32).px(8).text_size(13)
        .bg(t.background).border_b(1).border_color(t.input).text_color(t.foreground)
        .disabled(this.loading || !this.loaded).accessibility_label(label));
    // One fixed status line under the fields: loading, saving, saved or the error, so the form never shifts.
    const error = this.error || this.auto.error;
    const incomplete = this.loaded && !this.auto.valid();
    const status = error || (this.loading ? 'Loading commit author…' : incomplete ? 'Name and email are required' : this.auto.status());
    return v_flex().flex_1().min_h(0).gap(12)
      .child(h_flex().id('commit-author-body').flex_1().min_h(0).gap(12).items_start()
        .child(div().flex_1().min_w(0).child(field('name', 'Name', this.name)))
        .child(div().flex_1().min_w(0).child(field('email', 'Email', this.email))))
      .child(div().id('commit-author-status').h(20).flex_none().truncate().text_size(12).text_color(error || incomplete ? t.ansi1 : t.muted)
        .when(Boolean(error), el => el.tooltip(error)).child(status));
  }
}
