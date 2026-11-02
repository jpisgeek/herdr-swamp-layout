// Swamp tabs: the tab strip over the swamp layout's "swamp-tools" stack.
// Each tab shows one child of the stack (layout.select). Props:
//   stack: the stack id; tabs: [{ id, label }] (the stack's children).

import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { layout, props, run, theme } from "herdr";

const DEFAULT_TABS = [
  { id: "swamp-runs", label: "Runs" },
  { id: "swamp-quickrun", label: "Quick run" },
];

function findNode(n, id) {
  if (!n || typeof n !== "object") return null;
  if (n.id === id) return n;
  for (const c of n.children ?? []) {
    const r = findNode(c, id);
    if (r) return r;
  }
  return null;
}

export default class SwampTabs extends View {
  render() {
    const t = theme();
    const p = props() ?? {};
    const stack = p.stack ?? "swamp-tools";
    const tabs = p.tabs ?? DEFAULT_TABS;
    const active = findNode(layout(), stack)?.active ?? tabs[0].id;
    return h_flex().id("root").size_full().px(8).gap(4).items_center().bg(t.chrome).border_b_1().border_color(t.border)
      .children(tabs.map((tab) => {
        const on = tab.id === active;
        return div().id(`tab-${tab.id}`).h(24).px(10).flex().items_center().rounded(6).text_size(12).cursor_pointer()
          .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
          .when(on, (el) => el.font_semibold())
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("layout.select", { stack, child: tab.id }))
          .child(tab.label);
      }));
  }
}
