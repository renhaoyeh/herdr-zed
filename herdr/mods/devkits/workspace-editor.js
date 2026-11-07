import { div } from 'gpui-kit';
import { shared, setShared, theme } from 'herdr';
import FileViewer from './files.js';
import DiffViewer from './diff.js';
import { SidePanelLayout } from './components/side-panel.js';

// One editor owns both content views. Dock selection never changes the shown document.
export default class WorkspaceEditor {
  init(cx) {
    this.handle = cx.focus_handle();
    this.files = new FileViewer(); this.files.init(cx);
    this.diff = new DiffViewer(); this.diff.init(cx);
    this.files.onOpen = () => setShared('devkits.editor-kind', 'files');
    this.diff.onOpen = () => setShared('devkits.editor-kind', 'diff');
    cx.bind_keys([
      { keystroke: 'ctrl-tab', action: 'devkits-next-file', context: 'DevkitsFiles' },
      { keystroke: 'ctrl-shift-tab', action: 'devkits-prev-file', context: 'DevkitsFiles' },
    ]);
  }

  focus() {
    this.handle.focus();
  }

  close() { this.files.close(); this.diff.close(); }

  render(project, cx) {
    const dock = shared('devkits.right-panel');
    const kind = shared('devkits.editor-kind') || 'files';
    const files = this.files.render(project, cx, true);
    const diff = kind === 'diff' || dock === 'diff' ? this.diff.render(project, cx, true) : null;
    const content = div().size_full().min_w(0).min_h(0)
      .child(kind === 'diff' ? diff.content : files.content);
    const body = dock ? SidePanelLayout('workspace-editor-split', this.files.sidePanel, content,
      dock === 'diff' ? diff.panel : files.panel) : content;
    return div().id('workspace-editor').track_focus(this.handle).size_full().min_h(0).bg(theme().background)
      .when(kind === 'files', el => el.key_context('DevkitsFiles')
        .on_modifiers_changed((event) => { if (!event.modifiers.control) this.files.finishTabSwitch(); })
        .on_action('devkits-next-file', (_event, cx) => { cx.stop_propagation(); this.files.cycleTab(1, cx); })
        .on_action('devkits-prev-file', (_event, cx) => { cx.stop_propagation(); this.files.cycleTab(-1, cx); }))
      .child(body);
  }
}
