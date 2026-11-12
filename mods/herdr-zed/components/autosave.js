// Shared: edit components/autosave.js, then npm run sync:shared.
// design.md, Saving: a form that saves itself shortly after the last edit, with no Save or Cancel buttons.
// `snapshot()` is what Save would write (any string); `save(cx)` writes it and returns a promise; `valid()` (optional)
// keeps an incomplete form, such as an empty required field, from being written. A timer, never render, triggers the
// write: it waits until the snapshot has been unchanged for `delay` ms and differs from the last saved one.
export class Autosave {
  constructor({ snapshot, save, valid = () => true, delay = 500 }) {
    this.snapshot = snapshot; this.write = save; this.valid = valid; this.delay = delay;
    this.saved = null; this.seen = null; this.failed = null; this.changedAt = 0; this.saving = false; this.error = null; this.done = false;
  }
  // The current values count as saved: call after loading them, so loading is never written back.
  reset() { this.saved = this.seen = this.snapshot(); this.failed = null; this.error = null; this.done = false; }
  // Edits not yet written, including ones still waiting for the delay.
  dirty() { return this.saved !== null && this.snapshot() !== this.saved; }
  attach(cx, every = 100) { cx.timer.every(every, cx => this.tick(cx)); }
  tick(cx, now = Date.now()) {
    if (this.saved === null || this.saving) return;
    const current = this.snapshot();
    if (current !== this.seen) { this.seen = current; this.changedAt = now; this.done = false; cx.notify(); return; }
    // A value that just failed waits for the next edit instead of retrying on every tick.
    if (current !== this.saved && current !== this.failed && now - this.changedAt >= this.delay && this.valid()) return this.flush(cx);
  }
  // Writes now if there are valid edits; closing calls this so nothing typed is lost.
  flush(cx) {
    if (this.saved === null || this.saving || !this.dirty() || !this.valid()) return Promise.resolve();
    const current = this.snapshot();
    this.saving = true; this.error = null; cx?.notify();
    return Promise.resolve(this.write(cx))
      .then(() => { this.saved = current; this.failed = null; this.done = true; })
      .catch(error => { this.failed = current; this.error = error?.message || String(error); })
      .finally(() => { this.saving = false; cx?.notify(); });
  }
  // The footer's status line: Saving…, the error (in red), Saved, or nothing.
  status() { return this.saving ? 'Saving…' : this.error || (this.done && !this.dirty() ? 'Saved' : ''); }
}
