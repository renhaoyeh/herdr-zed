import { Input } from './components/input.js';
import { div } from 'gpui-kit';
import { InputState, h_flex, v_flex } from 'gpui-base';
import { Button } from './components/button.js';
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
  init(cx) { this.target = props(); this.form = new GitAuthorSettings(this.target.context); this.form.init(cx); }
  close() { this.form.close(); }
  render(t) {
    return DialogContent('commit-author', t)
      .child(DialogHeader(t, 'Commit author', { id: 'commit-author-close', label: 'Close commit author',
        onClose: () => closeOverlay(this.target.overlay) }))
      .child(DialogDescription(t).child('Name and email for future commits in this repository. Save to apply.'))
      .child(div().text_size(12).text_color(t.muted).truncate().child(this.target.context.folder))
      .child(this.form.render(t));
  }
}

// Repository-local identity form. Provider accounts (GitHub) have their own configuration.
export class GitAuthorSettings {
  constructor(target) { this.target = target; }

  init(cx) {
    this.loading = true;
    this.name = InputState.new({ placeholder: 'Name' });
    this.email = InputState.new({ placeholder: 'Email' });
    for (const input of [this.name, this.email]) input.on('change', (_event, cx) => { this.saved = false; cx.notify(); });
    cx.spawn(async cx => {
      try {
        const author = await readGitAuthor(this.target.folder, this.target.machine);
        if (this.closed) return;
        this.name.set_value(author.name); this.email.set_value(author.email); this.loaded = true;
      } catch (error) { this.error = error.message; }
      finally { this.loading = false; if (!this.closed) cx.notify(); }
    });
  }

  close() { this.closed = true; this.name?.release(); this.email?.release(); }

  save(cx) {
    if (!this.loaded || this.saving || !this.name.value().trim() || !this.email.value().trim()) return;
    const author = { name: this.name.value(), email: this.email.value() };
    this.saving = true; this.saved = false; this.error = null; cx.notify();
    cx.spawn(async cx => {
      try {
        await saveGitAuthor(this.target.folder, this.target.machine, author);
        if (!this.closed) this.saved = true;
      } catch (error) { this.error = error.message; }
      finally { this.saving = false; if (!this.closed) cx.notify(); }
    });
  }

  render(t) {
    const field = (key, label, state) => v_flex().gap(6)
      .child(div().text_size(12).child(label))
      .child(Input.new(state, t).id(`git-author-${key}`).h(32).px(8).text_size(13)
        .bg(t.background).border_b(1).border_color(t.input).text_color(t.foreground)
        .disabled(this.loading || this.saving || !this.loaded).accessibility_label(label));
    return v_flex().gap(12)
      .child(h_flex().gap(12).items_start()
        .child(div().flex_1().min_w(0).child(field('name', 'Name', this.name)))
        .child(div().flex_1().min_w(0).child(field('email', 'Email', this.email))))
      .when(this.loading, el => el.child(div().text_size(12).text_color(t.muted).child('Loading commit author…')))
      .when(Boolean(this.error), el => el.child(div().text_size(12).text_color(t.ansi1).child(this.error)))
      .child(h_flex().gap(8).justify_end().items_center()
        .when(this.saved && !this.saving, el => el.child(div().text_size(12).text_color(t.muted).child('Saved.')))
        .child(Button('git-author-save', t).disabled(!this.loaded || this.saving || !this.name.value().trim() || !this.email.value().trim())
          .on_click((_event, cx) => this.save(cx)).child(this.saving ? 'Saving…' : 'Save')));
  }
}
