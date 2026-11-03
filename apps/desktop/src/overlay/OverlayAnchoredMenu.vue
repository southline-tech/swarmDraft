<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, shallowRef, watch } from 'vue';
import { anchorMenuPosition, type AnchorPlacement } from './anchor-position';
import { APP_OVERLAY_LAYER, ensureOverlayLayer } from './layer';

const props = withDefaults(
  defineProps<{
    open: boolean;
    trigger: HTMLElement | null;
    placement?: AnchorPlacement;
  }>(),
  { placement: 'bottom-start' },
);

const menuRef = shallowRef<HTMLElement | null>(null);
const pos = shallowRef({ top: '0px', left: '0px' });

function reposition() {
  if (!props.open || !props.trigger || !menuRef.value) return;
  const t = props.trigger.getBoundingClientRect();
  const m = menuRef.value.getBoundingClientRect();
  const { top, left } = anchorMenuPosition(t, m, props.placement);
  pos.value = { top: `${top}px`, left: `${left}px` };
}

let listening = false;
function startListen() {
  if (listening) return;
  listening = true;
  window.addEventListener('resize', reposition, { passive: true });
  window.addEventListener('scroll', reposition, true);
}
function stopListen() {
  if (!listening) return;
  listening = false;
  window.removeEventListener('resize', reposition);
  window.removeEventListener('scroll', reposition, true);
}

watch(
  () => props.open,
  async (on) => {
    if (on) {
      ensureOverlayLayer();
      await nextTick();
      await nextTick();
      reposition();
      startListen();
    } else stopListen();
  },
);

onBeforeUnmount(() => stopListen());

defineExpose({ menuEl: menuRef });
</script>

<template>
  <Teleport :to="APP_OVERLAY_LAYER" :disabled="!open">
    <div
      v-show="open"
      ref="menuRef"
      class="overlay-anchored-menu"
      :style="{ top: pos.top, left: pos.left }"
    >
      <slot />
    </div>
  </Teleport>
</template>

<style scoped>
.overlay-anchored-menu {
  position: fixed;
  z-index: var(--ct-z-dropdown);
  min-width: 0;
}
</style>
