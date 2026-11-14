import { div, image } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { exec, settings, window, notify } from 'herdr';
import { ToolbarButton } from './button.js';
import { glyph } from './icon.js';

export class ImageViewer {
  constructor(cx) {
    this.handle = cx.focus_handle();
    this.viewport = { width: 0, height: 0 };
    this.reset();
  }

  reset() { this.scale = null; this.offset = { x: 0, y: 0 }; this.drag = null; }
  get fitScale() { return this.natural ? Math.min(1, Math.max(1, this.viewport.width - 32) / this.natural.width,
    Math.max(1, this.viewport.height - 32) / this.natural.height) : 1; }
  get zoom() { return this.scale ?? this.fitScale; }
  get canPan() { return this.natural && (this.natural.width * this.zoom > this.viewport.width
    || this.natural.height * this.zoom > this.viewport.height); }

  clamp() {
    if (!this.natural) return;
    for (const [axis, size] of [['x', 'width'], ['y', 'height']]) {
      const limit = Math.max(0, (this.natural[size] * this.zoom - this.viewport[size]) / 2 + 16);
      this.offset[axis] = Math.max(-limit, Math.min(limit, this.offset[axis]));
    }
  }

  setZoom(value, cx, anchor = { x: this.viewport.width / 2, y: this.viewport.height / 2 }) {
    if (!this.natural) return;
    const previous = this.zoom, next = Math.max(Math.min(0.05, this.fitScale), Math.min(32, value));
    for (const [axis, size] of [['x', 'width'], ['y', 'height']]) {
      const distance = anchor[axis] - this.viewport[size] / 2;
      this.offset[axis] = distance - (distance - this.offset[axis]) * next / previous;
    }
    this.scale = next; this.clamp(); cx.notify();
  }

  fit(cx) { this.reset(); cx.notify(); }
  actual(cx) { this.offset = { x: 0, y: 0 }; this.setZoom(1, cx); }

  // shortcut: Herdr exposes no pinch callback; add native pinch zoom when its mod API supports it.
  scroll(event, cx) {
    if (!this.natural || event.touch_phase === 'cancelled') return;
    const { x, y } = event.delta, unit = Number(settings().zoom) || 1;
    if (!x && !y) return;
    cx.stop_propagation();
    if (event.delta_lines || event.modifiers?.platform || event.modifiers?.control) {
      const local = event.local_position;
      this.setZoom(this.zoom * Math.exp(Math.max(-1, Math.min(1, y * 0.002))), cx,
        local ? { x: local.x / unit, y: local.y / unit } : undefined);
    } else {
      this.offset.x += x / unit; this.offset.y += y / unit;
      this.clamp(); cx.notify();
    }
  }

  key(event, cx) {
    const key = event.key;
    if (key === '+' || key === '=' || key === 'add') this.setZoom(this.zoom * 1.25, cx);
    else if (key === '-' || key === 'subtract') this.setZoom(this.zoom / 1.25, cx);
    else if (key === '0') this.fit(cx);
    else if (key === '1') this.actual(cx);
    else if (['left', 'right', 'up', 'down'].includes(key)) {
      this.offset[key === 'left' || key === 'right' ? 'x' : 'y'] += key === 'left' || key === 'up' ? 40 : -40;
      this.clamp(); cx.notify();
    } else return;
    cx.stop_propagation();
  }

  async open(file) {
    try {
      const platform = window()?.platform;
      const result = await exec(platform === 'macos' ? '/usr/bin/open' : platform === 'windows' ? 'explorer.exe' : 'xdg-open', [file]);
      if (result.code && !(platform === 'windows' && result.code === 1)) throw new Error(result.stderr || 'Could not open this image.');
    } catch (error) { notify({ title: 'Could not open image', body: error.message, level: 'error' }); }
  }

  render(id, target, t) {
    if (this.path !== target.path) { this.path = target.path; this.natural = null; this.reset(); }
    const zoom = this.zoom, ready = Boolean(this.natural);
    const button = (name, label, action, selected = false) => ToolbarButton(`${id}-${name}`, t, { icon: true, selected, disabled: !ready })
      .tooltip(label).accessibility_label(label).on_click((_event, cx) => { this.handle.focus(); action(cx); }).child(glyph(name, 16));
    const unit = () => Number(settings().zoom) || 1;
    const viewport = div().id(`${id}-viewport`).relative().flex_1().min_w(0).min_h(0).overflow_hidden().bg(t.background)
      .on_size_change((size, cx) => {
        if (size.width === this.viewport.width && size.height === this.viewport.height) return;
        this.viewport = size; this.clamp(); cx.notify();
      });
    // Keep the input surface above the image, covering both the picture and its surrounding margins.
    const controls = div().id(`${id}-controls`).absolute().inset_0()
      .accessibility_label(`${target.file || 'Image'}: scroll to pan, Command or Control + scroll to zoom, double-click for actual size`)
      .track_focus(this.handle).on_key_down((event, cx) => this.key(event, cx))
      .when(Boolean(this.canPan), el => this.drag ? el.cursor_grabbing() : el.cursor_grab())
      .on_scroll_wheel((event, cx) => this.scroll(event, cx))
      .on_mouse_down('left', (event, cx) => {
        cx.stop_propagation(); this.handle.focus();
        if (event.click_count >= 2) { this.scale === null ? this.actual(cx) : this.fit(cx); return; }
        if (this.canPan) { this.drag = { position: event.position, offset: { ...this.offset } }; cx.notify(); }
      })
      .on_mouse_move((event, cx) => {
        if (!this.drag) return;
        this.offset = { x: this.drag.offset.x + (event.position.x - this.drag.position.x) / unit(),
          y: this.drag.offset.y + (event.position.y - this.drag.position.y) / unit() };
        this.clamp(); cx.notify();
      })
      .on_mouse_up('left', (_event, cx) => { if (this.drag) { this.drag = null; cx.notify(); } })
      .on_hover((inside, cx) => { if (!inside && this.drag) { this.drag = null; cx.notify(); } });
    if (!ready) {
      // Let the native decoder measure the original image; no format-specific parser or OS tool is needed.
      viewport.child(div().absolute().left(0).top(0).flex().items_start()
        .child(div().id(`${id}-natural-${target.path}`).flex_none().on_size_change((size, cx) => {
          if (this.path !== target.path || this.natural || size.width <= 0 || size.height <= 0) return;
          this.natural = size; cx.notify();
        }).child(image(target.path).flex_none())));
    } else {
      const width = this.natural.width * zoom, height = this.natural.height * zoom;
      viewport.child(div().absolute().left((this.viewport.width - width) / 2 + this.offset.x)
        .top((this.viewport.height - height) / 2 + this.offset.y).w(width).h(height)
        .accessibility_label(target.file || 'Image').child(image(target.path).w(width).h(height)));
    }
    return v_flex().size_full().min_w(0).min_h(0)
      .child(h_flex().h(32).flex_none().px(4).gap(4).items_center().bg(t.chrome).border_b(1).border_color(t.border)
        .child(button('minus', 'Zoom out (−)', cx => this.setZoom(this.zoom / 1.25, cx)))
        .child(div().w(52).text_center().text_size(12).text_color(t.muted).child(ready ? `${Math.round(zoom * 100)}%` : '—'))
        .child(button('plus', 'Zoom in (+)', cx => this.setZoom(this.zoom * 1.25, cx)))
        .child(button('maximize', 'Fit image (0)', cx => this.fit(cx), this.scale === null))
        .child(button('minimize', 'Actual size (1)', cx => this.actual(cx), this.scale === 1))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted)
          .tooltip('Two-finger scroll: pan · Command/Control + scroll: zoom · Double-click: fit / actual size')
          .child(ready ? `${Math.round(this.natural.width)} × ${Math.round(this.natural.height)}` : 'Loading image…'))
        .child(div().min_w(0).truncate().text_size(11).text_color(t.muted)
          .child(window()?.platform === 'macos' ? 'Cmd + scroll to zoom' : 'Ctrl + scroll to zoom'))
        .child(ToolbarButton(`${id}-open`, t, { icon: true }).tooltip('Open in image viewer').accessibility_label('Open in image viewer')
          .on_click((_event, cx) => { cx.stop_propagation(); cx.spawn(() => this.open(target.file)); }).child(glyph('external-link', 16))))
      .child(viewport.child(controls));
  }
}
