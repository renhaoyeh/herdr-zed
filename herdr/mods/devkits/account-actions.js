import { div } from 'gpui-kit';
import { v_flex, h_flex, InputState, Input } from 'gpui-base';
import { shared, setShared, props, openOverlay, closeOverlay, exec, appHome, notify } from 'herdr';
import { accountLabel, removeAccountProfile, renameAccountProfile } from './account-login.js';
import { DropdownMenuLabel } from './components/dropdown-menu.js';
import { Button } from './components/button.js';
import { Checkbox } from './components/checkbox.js';
import { DialogContent, DialogTitle, DialogDescription, DialogFooter } from './components/dialog.js';
import { AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from './components/alert-dialog.js';

// Account actions opened from Manage: add, rename, remove and Codex sharing. Mixed into the Devkits view.
export const accountActions = {
  initCodexSharing(cx) {
    this.handle = cx.focus_handle(); this.handle.focus();
    this.sharingItems = []; this.sharingLoading = true;
    cx.spawn(async cx => {
      try {
        const result = await exec('node', [`${appHome()}/mods/devkits/codex-sharing.js`, appHome(), props().agent.key, '--list']);
        const data = JSON.parse(result.stdout);
        if (result.code !== 0 || data.error) throw new Error(data.error || 'Could not read shared items.');
        this.sharingItems = data.items;
      } catch (error) { this.sharingError = error.message; }
      finally { this.sharingLoading = false; cx.notify(); }
    });
  },

  initRenameAccount() {
    this.renameInput = InputState.new({ placeholder: 'Account name' });
    this.renameInput.set_value(accountLabel(props().account.name));
    this.renameInput.on('submit', (_event, cx) => this.saveAccountName(cx));
    this.renameInput.focus();
  },

  openCodexSharing(agent) {
    const target = props(); closeOverlay(target.overlay);
    openOverlay({ mod: 'devkits', kind: 'dialog', frame: 'none', modal: false, width: 640, height: 0.7,
      props: { view: 'codex-sharing', agent, space: target.space } });
  },

  finishCodexSharing() {
    const target = props(); closeOverlay(target.overlay);
    openOverlay({ mod: 'devkits', kind: 'dialog', frame: 'none', modal: false, width: 820, height: 0.8,
      props: { view: 'manage-launchers', space: target.space } });
  },

  sharingDialog(t) {
    const agent = props().agent;
    const available = this.sharingItems.filter(item => !item.unavailable);
    const selected = available.filter(item => item.selected).length;
    return DialogContent('codex-sharing', t).track_focus(this.handle)
      .on_key_down((event, cx) => { if (event.key === 'escape' && !this.sharingBusy) { cx.stop_propagation(); this.finishCodexSharing(); } })
      .child(DialogTitle().child('Shared plugins and skills'))
      .child(DialogDescription(t).child(`Choose what ${accountLabel(agent.name)} shares from ~/.codex. Uncheck an item to stop sharing it.`))
      .child(v_flex().id('sharing-table').flex_1().min_h(0).border(1).border_color(t.border)
        .child(h_flex().id('sharing-table-header').h(32).px(8).gap(8).items_center().flex_none()
          .border_b(1).border_color(t.border).text_size(11).text_color(t.muted)
          .child(Checkbox('share-all', available.length > 0 && selected === available.length, t).w(16).flex_none()
          .disabled(Boolean(this.sharingBusy) || this.sharingLoading || !available.length).accessibility_label('Select all plugins and skills')
          .on_change((checked, cx) => {
            for (const item of available) item.selected = checked;
            cx.notify();
          }))
          .child(div().flex_1().min_w(0).child('NAME'))
          .child(div().w(140).flex_none().child('SOURCE'))
          .child(div().w(108).flex_none().child('STATUS')))
      .child(v_flex().flex_1().min_h(0).overflow_y_scroll()
        .when(this.sharingLoading, el => el.child(div().p(8).text_size(13).text_color(t.muted).child('Checking shared settings…')))
        .children(['plugins', 'skills'].flatMap(kind => {
          const items = this.sharingItems.filter(item => item.kind === kind);
          return items.length ? [DropdownMenuLabel(t).h(28).px(8).bg(t.hover).child(kind.toUpperCase()), ...items.map((item, index) =>
            Checkbox(`share-${kind}-${index}`, item.selected, t).h(36).px(8).flex_none().border_b(1).border_color(t.border)
              .disabled(Boolean(this.sharingBusy) || Boolean(item.unavailable))
              .accessibility_label(`${item.label}${item.detail ? `, ${item.detail}` : ''}`)
              .on_change((checked, cx) => { item.selected = checked; cx.notify(); })
              .child(div().flex_1().min_w(0).truncate().text_size(13).child(item.label))
              .child(div().w(140).flex_none().truncate().text_size(12).text_color(t.muted).child(item.detail || '~/.codex/skills'))
              .child(div().w(108).flex_none().text_size(12)
                .text_color(item.status === 'synced' ? t.done : item.status === 'conflict' ? t.ansi1 : t.muted)
                .child(({ synced: 'Synced', pending: 'Update needed', conflict: 'Conflict', 'not-shared': 'Not shared', 'source-missing': 'Source missing' })[item.status] || '—')))] : [];
        }))
        .when(!this.sharingLoading && !this.sharingError && !this.sharingItems.length, el => el.child(div().p(8).text_size(13).text_color(t.muted).child('No local plugins or custom skills in ~/.codex.')))))
      .child(div().text_size(12).text_color(t.muted).child('Personal skills in ~/.agents/skills are already shared. Remote plugins are managed per account in /plugins.'))
      .when(Boolean(this.sharingError), el => el.child(div().text_size(12).text_color(t.ansi1).child(this.sharingError)))
      .child(DialogFooter()
        .child(Button('sharing-cancel', t, { variant: 'secondary' }).disabled(Boolean(this.sharingBusy)).on_click(() => this.finishCodexSharing()).child('Cancel'))
        .child(Button('sharing-apply', t).disabled(Boolean(this.sharingBusy) || this.sharingLoading || Boolean(this.sharingError && !this.sharingItems.length))
          .on_click((_event, cx) => this.syncCodexSettings(agent, cx)).child(this.sharingBusy ? 'Syncing…' : `Sync ${selected} items`)));
  },

  // Only the selection dialog's explicit action runs synchronization.
  syncCodexSettings(agent, cx) {
    if (this.sharingBusy) return;
    this.sharingBusy = agent.key;
    this.sharingError = null;
    const selection = { plugins: [], skills: [] };
    for (const item of this.sharingItems) if (item.selected && !item.unavailable) selection[item.kind].push(item.key);
    cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await exec('node', [`${appHome()}/mods/devkits/codex-sharing.js`, appHome(), agent.key, JSON.stringify(selection)]);
        let data;
        try { data = JSON.parse(result.stdout); } catch { throw new Error('Could not synchronize settings. Check that Node.js and Codex CLI are installed.'); }
        if (result.code !== 0 || data.error) throw new Error(data.error || 'Could not synchronize settings.');
        notify({ title: 'Shared settings updated', body: data.message });
        this.finishCodexSharing();
      } catch (error) { this.sharingError = error.message; }
      finally { this.sharingBusy = null; cx.notify(); }
    });
  },

  addAccount(provider) {
    const target = props();
    closeOverlay(target.overlay);
    openOverlay({ mod: 'devkits', kind: 'dialog', frame: 'none', modal: true, width: 520, height: 380,
      props: { view: 'account-login', provider, returnTo: { view: 'manage-launchers', space: target.space } } });
  },

  renameAccount(account) {
    const target = props();
    closeOverlay(target.overlay);
    openOverlay({ mod: 'devkits', kind: 'dialog', frame: 'none', modal: true, width: 480, height: 260,
      props: { view: 'rename-account', account: { key: account.key, name: account.name }, space: target.space } });
  },

  finishRename() {
    if (this.renaming) return;
    const target = props();
    closeOverlay(target.overlay);
    openOverlay({ mod: 'devkits', kind: 'dialog', frame: 'none', modal: false, width: 820, height: 0.8,
      props: { view: 'manage-launchers', space: target.space } });
  },

  saveAccountName(cx) {
    if (this.renaming) return;
    this.renaming = true; this.renameError = null; cx.notify();
    const name = this.renameInput.value();
    cx.spawn(async cx => {
      try {
        await renameAccountProfile(props().account.key, name);
        setShared('devkits.agent-cache', {});
        setShared('devkits.profile-revision', (shared('devkits.profile-revision') || 0) + 1);
        this.renaming = false; this.finishRename();
      } catch (error) { this.renaming = false; this.renameError = error.message; cx.notify(); }
    });
  },

  renameAccountPrompt(t) {
    return DialogContent('rename-account-dialog', t).accessibility_label('Rename agent profile')
      .track_focus(this.handle).on_key_down((event, cx) => {
        if (event.key === 'escape') { cx.stop_propagation(); this.finishRename(); }
      })
      .child(DialogTitle().child('Rename agent profile'))
      .child(DialogDescription(t).child('Choose a display name for this account.'))
      .child(Input.new(this.renameInput).id('rename-account-name').accessibility_label('Account name')
        .h(36).px(10).rounded(0).border_b(1).border_color(t.input).text_size(13))
      .when(Boolean(this.renameError), el => el.child(div().id('rename-account-error').text_size(12)
        .text_color(t.destructive || t.foreground).child(this.renameError)))
      .child(DialogFooter().children([
        Button('cancel-rename-account', t, { variant: 'secondary' }).disabled(Boolean(this.renaming)).on_click(() => this.finishRename()).child('Cancel'),
        Button('save-rename-account', t).disabled(Boolean(this.renaming)).on_click((_event, cx) => this.saveAccountName(cx)).child(this.renaming ? 'Saving…' : 'Save'),
      ]));
  },

  confirmRemoveAccount(account) {
    const target = props();
    closeOverlay(target.overlay);
    openOverlay({ mod: 'devkits', kind: 'dialog', frame: 'none', modal: true, width: 480, height: 300,
      props: { view: 'remove-account', account: { key: account.key, name: account.name }, space: target.space } });
  },

  removeAccountPrompt(t) {
    const target = props();
    const back = () => {
      if (this.removing) return;
      closeOverlay(target.overlay);
      openOverlay({ mod: 'devkits', kind: 'dialog', frame: 'none', modal: false, width: 820, height: 0.8,
        props: { view: 'manage-launchers', space: target.space } });
    };
    const confirm = cx => {
      if (this.removing) return;
      this.removing = true; this.removeError = null; cx.notify();
      cx.spawn(async cx => {
        try {
          await removeAccountProfile(target.account.key);
          setShared('devkits.agent-cache', {});
          const key = `agent:${target.account.key}`;
          for (const setting of ['devkits.hidden-launchers', 'devkits.launcher-order']) {
            setShared(setting, (shared(setting) || []).filter(item => item !== key));
          }
          for (const setting of ['devkits.codex-permissions', 'devkits.profile-sessions']) {
            const saved = { ...(shared(setting) || {}) };
            delete saved[target.account.key];
            setShared(setting, saved);
          }
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
        AlertDialogAction('confirm-remove-account', t).disabled(Boolean(this.removing))
          .on_click((_event, cx) => confirm(cx)).child(this.removing ? 'Removing…' : 'Remove'),
      ]));
  },
};
