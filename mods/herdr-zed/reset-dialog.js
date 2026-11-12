import { Input } from './components/input.js';
import { div } from 'gpui-kit';
import { v_flex, InputState } from 'gpui-base';
import { appHome, props, shared, setShared, spaces, exec, readTextFile, run, openOverlay, closeOverlay, window } from 'herdr';
import { Button } from './components/button.js';
import { AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from './components/alert-dialog.js';

export const openDataReset = () => {
  const settings = shared('herdr-zed.settings.overlay');
  if (settings) { closeOverlay(settings); setShared('herdr-zed.settings.overlay', null); }
  return openOverlay({ mod: 'herdr-zed', kind: 'dialog', frame: 'none', modal: true,
    width: 440, height: 620, props: { view: 'reset-data' } });
};
const authorizationKey = 'herdr-zed.reset-authorization';
const helper = () => `${appHome()}/mods/herdr-zed/reset-data.js`;

export class ResetData {
  init(cx) {
    this.target = props() || {};
    this.handle = cx.focus_handle(); this.handle.focus();
    this.executing = this.target.phase === 'execute';
    if (this.executing) {
      try { this.original = JSON.parse(this.target.originalSource); }
      catch { this.error = 'Could not read the saved layout. No data has been cleared.'; return; }
      const authorization = shared(authorizationKey);
      this.authorized = Boolean(authorization?.token === this.target.token && authorization.expiresAt > Date.now());
      setShared(authorizationKey, null);
      if (!this.authorized) { this.error = 'Reset was interrupted. Return to Herdr Zed to start again.'; return; }
      // The previous layout and Settings dialog have been removed. Allow their bounded
      // native close handlers to finish before touching account files or shared state.
      this.busy = true;
      cx.timer.after(350, cx => { this.busy = false; this.clear(cx); });
      return;
    }
    this.input = InputState.new({ placeholder: 'HERDR ZED' });
    this.input.on('change', (_event, cx) => cx.notify());
    this.input.on('submit', (_event, cx) => this.begin(cx));
    this.loading = true;
    cx.spawn(async cx => {
      try {
        this.source = await readTextFile(`${appHome()}/layouts/herdr-zed.json`);
        this.original = JSON.parse(this.source);
        const result = await exec('node', [helper(), 'inspect', appHome()]);
        if (result.code !== 0) throw new Error(result.stderr?.trim() || 'Could not inspect Herdr Zed data.');
        this.plan = JSON.parse(result.stdout);
      } catch (error) { this.error = error.message; }
      this.loading = false; cx.notify();
    });
  }

  ready() { return !this.loading && !this.busy && !this.error && Boolean(this.plan) && this.input?.value() === 'HERDR ZED'; }

  begin(cx) {
    if (!this.ready()) return;
    this.busy = true; cx.notify();
    cx.spawn(async cx => {
      try {
        if (shared('layout') !== 'herdr-zed') throw new Error('Switch to the Herdr Zed layout before clearing data.');
        const result = await exec('herdr-app', ['status']);
        if (result.code !== 0) throw new Error('Could not check open dialogs.');
        const status = JSON.parse(result.stdout);
        if (status.overlays?.length !== 1 || status.overlays.some(name => name !== 'herdr-zed'))
          throw new Error('Close other dialogs and windows before clearing data.');
        if (await readTextFile(`${appHome()}/layouts/herdr-zed.json`) !== this.source)
          throw new Error('The layout changed. Close this dialog and start again.');
        const token = `reset:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        setShared(authorizationKey, { token, expiresAt: Date.now() + 10000 });
        run('layout.set', { layout: { id: 'herdr-zed-reset-root', type: 'block', theme: this.original.theme,
          // Keep the saved tree as text: nesting the real layout inside these props
          // exceeds Herdr's 16-level host argument limit before reset can start.
          content: { mod: 'herdr-zed', props: { view: 'reset-data', phase: 'execute', token, originalSource: this.source } } } });
        // No old Herdr Zed provider or dialog may remain alive and repopulate cleared data.
        run('overlay.close');
      } catch (error) { this.error = error.message; this.busy = false; cx.notify(); }
    });
  }

  clear(cx) {
    if (this.busy || this.complete || !this.authorized) return;
    this.busy = true; this.error = null; cx.notify();
    cx.spawn(async cx => {
      try {
        this.closing = true; cx.notify();
        for (const project of spaces()) {
          const reply = await exec('herdr-app', ['do', 'space.close', '--id', project.id, '--confirmed', 'true']);
          if (reply.code !== 0) throw new Error(`Could not close project ${project.name || project.id}. No account files were removed; Retry to try again.`);
        }
        if (spaces().length) await new Promise((resolve, reject) => {
          const deadline = Date.now() + 15000;
          const check = cx => {
            if (!spaces().length) return resolve();
            if (Date.now() >= deadline) return reject(new Error('Projects are still closing. No account files were removed; Retry to try again.'));
            cx.timer.after(100, check);
          };
          check(cx);
        });
        this.closing = false; cx.notify();
        const result = await exec('node', [helper(), 'clear', appHome(), 'HERDR ZED'], { timeout: 600000 });
        if (result.code !== 0) throw new Error(result.stderr?.trim() || 'Could not clear all Herdr Zed data.');
        const { sharedKeys } = JSON.parse(result.stdout);
        if (!Array.isArray(sharedKeys) || sharedKeys.some(key => typeof key !== 'string' || !key.startsWith('herdr-zed.')))
          throw new Error('Invalid reset result.');
        for (const key of sharedKeys) setShared(key, null);
        setShared(authorizationKey, null);
        this.complete = true;
      } catch (error) { this.error = error.message; }
      this.closing = false; this.busy = false; cx.notify();
    });
  }

  restore() {
    if (!this.busy && this.original) {
      run('layout.set', { layout: this.original });
      // End the old native module contexts too; their session-only caches must not
      // survive a complete reset. The next app launch starts the restored layout.
      if (this.complete) run(window()?.platform === 'macos' ? 'app.quit' : 'window.close');
    }
  }

  render(t) {
    const done = () => { if (!this.busy) this.executing ? this.restore() : closeOverlay(this.target.overlay); };
    const content = AlertDialogContent('reset-herdr-zed-dialog', t).accessibility_label('Clear all Herdr Zed data')
      .track_focus(this.handle).on_key_down((event, cx) => {
        if (event.key === 'escape') { cx.stop_propagation(); if (!this.busy) done(); }
      })
      .child(AlertDialogTitle().flex_none().child(this.complete ? 'Herdr Zed data cleared' : 'Clear all Herdr Zed data?'))
      .child(v_flex().id('reset-data-body').flex_1().min_h(0).gap(16).overflow_y_scroll()
      .child(AlertDialogDescription(t).flex_none().child(this.complete
        ? 'Herdr Zed data has been cleared. Close Herdr, then open it again to start with new defaults.'
        : 'Permanently delete all Herdr Zed settings, pasted images, saved accounts and their sign-ins, conversations, plugins and skills, Tasks, Calendar events, source connections, Rules, shared MCP settings and caches.'))
      .child(div().text_size(13).text_color(t.muted).child('Devkits data, project files and external default Claude/Codex sign-ins and history are kept. Herdr Zed integrations in default accounts are removed.'))
      .when(!this.executing, el => el
        .child(div().text_size(13).text_color(t.muted).child(this.loading ? 'Checking Herdr Zed data…'
          : `${this.plan?.accounts ?? 0} dedicated account directories. This cannot be undone.`))
        .child(div().text_size(13).text_color(t.muted).child('This closes all open projects and stops their sessions and any Herdr Zed account sessions. Type HERDR ZED to confirm.'))
        .child(Input.new(this.input, t).id('reset-herdr-zed-confirmation').accessibility_label('Type HERDR ZED to confirm')
          ))
      .when(Boolean(this.error), el => el.child(div().id('reset-herdr-zed-error').text_size(12).text_color(t.destructive || t.ansi1)
        .child(`${this.error}${this.executing && this.authorized ? ' Reset is incomplete.' : ''}`)))
      )
      .child(AlertDialogFooter().flex_none()
        .child(AlertDialogCancel('reset-herdr-zed-cancel', t).disabled(Boolean(this.busy)).on_click(done)
          .child(this.complete ? 'Close Herdr' : this.executing ? 'Return to Herdr Zed' : 'Cancel'))
        .when(!this.complete && (!this.executing || this.authorized), el => el
          .child(Button('reset-herdr-zed-clear', t, { variant: 'destructive' })
            .disabled(this.executing ? Boolean(this.busy) : !this.ready())
            .opacity((this.executing ? this.busy : !this.ready()) ? 0.45 : 1)
            .on_click((_event, cx) => this.executing ? this.clear(cx) : this.begin(cx))
            .child(this.busy ? this.closing ? 'Closing projects…' : 'Clearing…' : this.executing ? 'Retry' : 'Clear all Herdr Zed data'))));
    return this.executing ? v_flex().size_full().items_center().justify_center().bg(t.canvas)
      .child(v_flex().w(440).h(620).child(content)) : content;
  }
}
