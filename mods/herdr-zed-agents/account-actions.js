import { Input } from './components/input.js';
import { div } from 'gpui-kit';
import { InputState } from 'gpui-base';
import { shared, setShared, props, openOverlay, closeOverlay } from 'herdr';
import { accountLabel, removeAccountProfile, renameAccountProfile } from './account-login.js';
import { Button } from './components/button.js';
import { DialogContent, DialogHeader, DialogDescription } from './components/dialog.js';
import { Autosave } from './components/autosave.js';
import { AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from './components/alert-dialog.js';

// Account actions opened from Settings: add, rename and remove. Each stacks a modal above Settings and closes
// only itself, like the profile editor; Settings reloads its accounts when profile-revision changes. Mixed into the Devkits view.
export const accountActions = {
  // Rename saves itself shortly after the last edit (design.md, Saving); Enter or closing writes it at once.
  initRenameAccount(cx) {
    this.renameInput = InputState.new({ placeholder: 'Account name' });
    this.renameInput.set_value(accountLabel((props() || {}).account.name));
    this.renameInput.on('change', (_event, cx) => cx.notify());
    this.renameAuto = new Autosave({ snapshot: () => this.renameInput.value(), valid: () => Boolean(this.renameInput.value().trim()),
      save: async () => {
        await renameAccountProfile((props() || {}).account.key, this.renameInput.value());
        setShared('herdr-zed.agent-cache', {});
        setShared('herdr-zed.profile-revision', (shared('herdr-zed.profile-revision') || 0) + 1);
      } });
    this.renameAuto.reset(); this.renameAuto.attach(cx);
    this.renameInput.on('submit', (_event, cx) => this.closeRename(cx));
    this.renameInput.focus();
  },

  closeRename(cx) { this.renameAuto.flush(cx).finally(() => this.finishRename()); },

  addAccount(provider) {
    openOverlay({ mod: 'herdr-zed-agents', kind: 'dialog', frame: 'none', modal: true, width: 560, height: 520,
      props: { view: 'account-login', provider } });
  },

  renameAccount(account) {
    const target = props();
    openOverlay({ mod: 'herdr-zed-agents', kind: 'dialog', frame: 'none', modal: true, width: 560,
      props: { view: 'rename-account', account: { key: account.key, name: account.name }, space: target.space } });
  },

  finishRename() {
    if (this.renaming) return;
    closeOverlay((props() || {}).overlay);
  },

  renameAccountPrompt(t) {
    const auto = this.renameAuto, empty = !this.renameInput.value().trim();
    return DialogContent('rename-account-dialog', t).accessibility_label('Rename account')
      .track_focus(this.handle).on_key_down((event, cx) => {
        if (event.key !== 'escape') return;
        cx.stop_propagation(); this.closeRename(cx);
      })
      .child(DialogHeader(t, 'Rename account', { id: 'close-rename-account', label: 'Close', onClose: (_event, cx) => this.closeRename(cx) }))
      .child(DialogDescription(t).child('Choose a display name for this account. It saves as you type.'))
      .child(Input.new(this.renameInput, t).id('rename-account-name').accessibility_label('Account name'))
      // One fixed status line: this dialog sizes to its content and must not grow.
      .child(div().id('rename-account-status').h(20).truncate().text_size(12).text_color(auto.error || empty ? t.destructive || t.ansi1 : t.muted)
        .when(Boolean(auto.error), el => el.tooltip(auto.error)).child(empty ? 'A name is required' : auto.status()));
  },

  confirmRemoveAccount(account) {
    const target = props();
    openOverlay({ mod: 'herdr-zed-agents', kind: 'dialog', frame: 'none', modal: true, width: 440,
      props: { view: 'remove-account', account: { key: account.key, name: account.name }, space: target.space } });
  },

  removeAccountPrompt(t) {
    const target = props();
    const back = () => {
      if (this.removing) return;
      closeOverlay(target.overlay);
    };
    const confirm = cx => {
      if (this.removing) return;
      this.removing = true; this.removeError = null; cx.notify();
      cx.spawn(async cx => {
        try {
          await removeAccountProfile(target.account.key);
          setShared('herdr-zed.agent-cache', {});
          const configs = shared('herdr-zed.agent-configs') || [];
          const removed = new Set([target.account.key, ...configs.filter(item => item.profileKey === target.account.key).map(item => item.key)]);
          setShared('herdr-zed.agent-configs', configs.filter(item => !removed.has(item.key)));
          setShared('herdr-zed.hidden-usage-profiles', (shared('herdr-zed.hidden-usage-profiles') || []).filter(item => !removed.has(item)));
          const key = `agent:${target.account.key}`;
          for (const setting of ['herdr-zed.hidden-launchers', 'herdr-zed.launcher-order']) {
            setShared(setting, (shared(setting) || []).filter(item => item !== key && !removed.has(item.slice(6))));
          }
          for (const setting of ['herdr-zed.codex-permissions', 'herdr-zed.profile-sessions']) {
            const saved = { ...(shared(setting) || {}) };
            for (const item of removed) delete saved[item];
            setShared(setting, saved);
          }
          setShared('herdr-zed.profile-revision', (shared('herdr-zed.profile-revision') || 0) + 1);
          this.removing = false; back();
        } catch (error) { this.removing = false; this.removeError = error.message; cx.notify(); }
      });
    };
    return AlertDialogContent('remove-account-dialog', t).accessibility_label(`Remove ${target.account.name}?`)
      .track_focus(this.handle).on_key_down((event, cx) => {
        if (event.key === 'escape') back();
        else if (event.key === 'enter') confirm(cx);
        else return;
        cx.stop_propagation();
      })
      .child(AlertDialogTitle().child(`Remove ${target.account.name}?`))
      .child(AlertDialogDescription(t).child('This signs out this saved account and removes it from the menu. History and project files are kept. Running sessions stay open but may need to sign in again.'))
      .when(Boolean(this.removeError), el => el.child(div().id('remove-account-error').text_size(12).text_color(t.destructive || t.foreground).child(this.removeError)))
      .child(AlertDialogFooter().children([
        AlertDialogCancel('cancel-remove-account', t).disabled(Boolean(this.removing)).on_click(back).child('Cancel'),
        Button('confirm-remove-account', t, { variant: 'destructive' }).disabled(Boolean(this.removing))
          .on_click((_event, cx) => confirm(cx)).child(this.removing ? 'Removing…' : 'Remove'),
      ]));
  },
};
