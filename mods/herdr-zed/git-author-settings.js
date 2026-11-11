import { Input } from './components/input.js';
import { div } from 'gpui-kit';
import { InputState, v_flex } from 'gpui-base';
import { props, openOverlay, closeOverlay } from 'herdr';
import { Button } from './components/button.js';
import { DialogContent, DialogTitle, DialogDescription, DialogFooter } from './components/dialog.js';
import { readGitAuthor, saveGitAuthor } from './git-author.js';

// The repository's commit author. Provider accounts (GitHub) live in their own extension dialogs.
export const openGitAuthor = project => openOverlay({ mod: 'herdr-zed', kind: 'dialog', frame: 'none',
  modal: true, width: 480, height: 600, props: { view: 'git-author-settings', folder: project.folder, machine: project.machine } });

export class GitAuthorSettings {
  init(cx) {
    this.target = props(); this.loading = true;
    this.name = InputState.new({ placeholder: 'Name' });
    this.email = InputState.new({ placeholder: 'Email' });
    for (const input of [this.name, this.email]) input.on('change', (_event, cx) => cx.notify());
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
    this.saving = true; this.error = null; cx.notify();
    cx.spawn(async cx => {
      try {
        await saveGitAuthor(this.target.folder, this.target.machine, author);
        if (!this.closed) closeOverlay(this.target.overlay);
      } catch (error) { this.error = error.message; }
      finally { this.saving = false; if (!this.closed) cx.notify(); }
    });
  }

  render(t) {
    const cancel = () => { if (!this.saving) closeOverlay(this.target.overlay); };
    const field = (key, label, state) => v_flex().gap(6)
      .child(div().text_size(12).child(label))
      .child(Input.new(state, t).id(`git-author-${key}`).h(32).px(8).text_size(13)
        .bg(t.background).border_b(1).border_color(t.input).text_color(t.foreground)
        .disabled(this.loading || this.saving || !this.loaded).accessibility_label(label));
    return DialogContent('git-author-settings', t).gap(12).on_key_down((event, cx) => {
      if (event.key === 'escape') { cx.stop_propagation(); cancel(); }
    })
      .child(DialogTitle().child('Commit author'))
      .child(DialogDescription(t)
        .child('Set the name and email for future commits in this repository. Existing commits stay unchanged.'))
      .child(div().text_size(11).text_color(t.muted).child(this.target.folder))
      .child(field('name', 'Name', this.name)).child(field('email', 'Email', this.email))
      .when(this.loading, el => el.child(div().text_size(12).text_color(t.muted).child('Loading commit author…')))
      .when(Boolean(this.error), el => el.child(div().text_size(12).text_color(t.ansi1).child(this.error)))
      .child(DialogFooter()
        .child(Button('git-author-cancel', t, { variant: 'secondary' }).disabled(Boolean(this.saving)).on_click(cancel).child('Cancel'))
        .child(Button('git-author-save', t).disabled(!this.loaded || this.saving || !this.name.value().trim() || !this.email.value().trim())
          .on_click((_event, cx) => this.save(cx)).child(this.saving ? 'Saving…' : 'Save')));
  }
}
