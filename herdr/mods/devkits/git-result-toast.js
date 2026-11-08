import { div, svg } from 'gpui-kit';
import { h_flex, Popup } from 'gpui-base';
import { shared, setShared, settings } from 'herdr';
import { Button } from './components/button.js';

const GIT_TOAST = 'devkits.git-result-toast';
export const gitToastProject = context => JSON.stringify([context?.machine || '', context?.folder || context?.id || '']);

export function clearGitToast(context) {
  if (!context || shared(GIT_TOAST)?.project === gitToastProject(context)) setShared(GIT_TOAST, null);
}

export function showGitToast(context, title, failed) {
  setShared(GIT_TOAST, { project: gitToastProject(context), title, failed });
}

// The status bar ends at the window's right edge. Anchor a window-wide,
// transparent row there so its card stays centered across every dock layout.
export function GitResultToast(t, project) {
  const result = shared(GIT_TOAST);
  if (!result || result.project !== gitToastProject(project)) return div();
  const width = globalThis.window.viewport_size().width / (Number(settings().zoom) || 1);
  const card = h_flex().id('git-result-toast').max_w(480).min_w(0)
    .px(12).py(8).gap(8).items_center().bg(t.chrome).border(1).border_color(t.border)
    .text_color(t.foreground).accessibility_label(result.title)
    .child(svg(`mods/devkits/assets/icons/${result.failed ? 'circle-alert' : 'circle-check'}.svg`).size(12).flex_none()
      .text_color(result.failed ? t.destructive || t.foreground : t.muted))
    .child(div().min_w(0).truncate().text_size(12).child(result.title))
    .when(result.failed, el => el.child(Button('git-view-log', t, { variant: 'secondary' }).h(26).px(8)
      .child('View Log').on_click(() => {
        setShared('devkits.git-output-request', result.project);
        setShared('devkits.right-panel', 'diff');
        clearGitToast();
      })))
    .child(Button('git-toast-close', t, { variant: 'ghost', size: 'icon-sm' })
      .accessibility_label('Dismiss Git notification').child(svg('mods/devkits/assets/icons/close.svg').size(12))
      .on_click(() => clearGitToast()));
  return Popup.new('git-result-toast-layer', div().size(0)).relative().absolute().right(0).top(0)
    .anchor('bottom_right')
    .content(h_flex().w(width).px(12).pb(12).justify_center().child(card));
}
