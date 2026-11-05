import { h_flex, v_flex } from 'gpui-base';

export function Sidebar(t) {
  return v_flex().id('devkits-sidebar').size_full().min_h(0).bg(t.chrome).text_color(t.foreground);
}

export function SidebarContent() {
  return v_flex().id('project-list').flex_1().min_h(0).overflow_y_scrollbar().gap(8).pt(4);
}

export function SidebarGroupLabel(id, active, t) {
  return h_flex().id(id).h(32).px(8).gap(4).items_center().text_size(12).font_medium().cursor_pointer()
    .text_color(active ? t.foreground : t.muted).hover(el => el.bg(t.hover));
}

export function SidebarMenuButton(id, active, t) {
  return h_flex().id(id).h(32).flex_none().mx(6).px(8).gap(8).items_center().rounded(4)
    .bg(active ? t.selected : t.chrome).hover(el => el.bg(t.hover)).cursor_pointer();
}

export function SidebarFooter(t) {
  return h_flex().id('sidebar-bottom-bar').h(32).flex_none().px(4).gap(4).border_t(1).border_color(t.border).items_center();
}
