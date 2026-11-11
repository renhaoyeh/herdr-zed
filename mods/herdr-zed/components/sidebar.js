import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';

export function Sidebar(t) {
  return v_flex().id('herdr-zed-sidebar').size_full().min_h(0).bg(t.chrome).text_color(t.foreground);
}

export function SidebarContent() {
  return v_flex().id('project-list').flex_1().min_h(0).overflow_y_scrollbar();
}

export function SidebarGroup(separated, t) {
  return v_flex().when(separated, el => el.border_t(1).border_color(t.border));
}

export function SidebarGroupLabel(id, active, t) {
  return h_flex().id(id).h(32).px(12).gap(4).items_center().text_size(12).font_medium().cursor_pointer()
    .text_color(active ? t.foreground : t.muted).hover(el => el.bg(t.hover));
}

export function SidebarMenuButton(id, active, t) {
  return h_flex().id(id).h(32).flex_none().px(12).gap(8).items_center().rounded(0)
    .bg(active ? t.selected : t.chrome).hover(el => el.bg(t.hover)).cursor_pointer();
}

export function SidebarFooter(t) {
  return h_flex().id('sidebar-bottom-bar').h(32).flex_none().px(4).gap(4).border_t(1).border_color(t.border).items_center();
}

// Only related panes get a shared bracket. Independent threads remain ordinary rows.
export function SidebarTreeMenuButton(id, active, t, depth = 0, trunk = null) {
  const levels = depth + (trunk ? 1 : 0);
  return SidebarMenuButton(id, active, t).gap(0)
    .children(Array.from({ length: levels }, (_, index) => {
      const common = Boolean(trunk && index === 0), visible = !common || trunk.visible;
      return div().id(`${id}-guide-${index}`).relative().w(16).h_full().flex_none()
        .when(visible, el => el.child(div().absolute().left(8).top(common && trunk.first ? 16 : 0)
          .bottom(common && trunk.last ? 16 : 0).w(1).bg(t.border)))
        .when(index === levels - 1, el => el.child(div().absolute().left(8).top(16).w(8).h(1).bg(t.border)));
    }));
}
