/** Shared open/close behavior for toolbar dropdown menus (#245). */
import { nextTick, onBeforeUnmount, shallowRef, type Ref } from 'vue';

export function useToolbarMenu(
  menuEl: Ref<HTMLElement | null>,
  triggerEl: Ref<HTMLElement | null>,
) {
  const open = shallowRef(false);
  const wrapEl = shallowRef<HTMLElement | null>(null);

  const items = () => [
    ...(menuEl.value?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []),
  ];

  function focusItem(i: number) {
    const list = items();
    if (list.length) list[(i + list.length) % list.length]!.focus();
  }

  function onOutside(ev: PointerEvent) {
    if (!wrapEl.value?.contains(ev.target as Node)) close(false);
  }

  function show() {
    open.value = true;
    document.addEventListener('pointerdown', onOutside, true);
    void nextTick(() => focusItem(0));
  }

  function close(refocus = true) {
    if (!open.value) return;
    open.value = false;
    document.removeEventListener('pointerdown', onOutside, true);
    if (refocus) triggerEl.value?.focus();
  }

  function toggle() {
    if (open.value) close();
    else show();
  }

  function onMenuKey(ev: KeyboardEvent) {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    const to: Record<string, number> = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: -1 };
    if (ev.key in to) {
      ev.preventDefault();
      focusItem(to[ev.key]!);
    }
  }

  onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutside, true));

  return { open, wrapEl, show, close, toggle, onMenuKey };
}
