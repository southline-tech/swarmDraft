<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import ShellIcon from './ShellIcon.vue';

withDefaults(
  defineProps<{
    icon: 'alert' | 'lock' | 'disk' | 'save';
    tone: 'danger' | 'warning';
    title: string;
    text: string;
    action: string;
    variant?: 'card' | 'banner';
    role?: 'alert' | undefined;
    actionDataTest?: string;
    actionDisabled?: boolean;
    actionAriaBusy?: boolean;
    dismissible?: boolean;
  }>(),
  {
    variant: 'card',
    role: undefined,
    actionDataTest: undefined,
    actionDisabled: false,
    actionAriaBusy: false,
    dismissible: false,
  },
);
const emit = defineEmits<{ action: []; dismiss: [] }>();
const root = ref<HTMLElement | null>(null);
onMounted(async () => {
  await nextTick();
  root.value?.focus();
});
</script>

<template>
  <section
    ref="root"
    class="ec"
    :class="[`ec--${tone}`, variant === 'banner' ? 'ec--banner' : '']"
    :role="role ?? (variant === 'banner' ? 'alert' : undefined)"
    tabindex="-1"
    :data-test="variant === 'banner' ? 'save-failure-banner' : 'error-card'"
    @keydown.esc.prevent="dismissible && emit('dismiss')"
  >
    <span class="ec__icon"><ShellIcon :name="icon" /></span>
    <div class="ec__body">
      <h3 class="ec__title">{{ title }}</h3>
      <p class="ec__text">{{ text }}</p>
    </div>
    <div class="ec__actions">
      <button type="button" class="sh-btn sh-btn--primary" @click="emit('action')">
        {{ action }}
      </button>
      <button
        v-if="dismissible"
        type="button"
        class="sh-btn sh-btn--secondary ec__dismiss"
        aria-label="Dismiss"
        data-test="error-card-dismiss"
        @click="emit('dismiss')"
      >
        ×
      </button>
    </div>
  </section>
</template>

<style scoped>
.ec {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--ct-space-3);
  padding: var(--ct-space-5);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-lg);
  background: var(--ct-surface-raised);
  box-shadow: var(--ct-elevation-1);
  color: var(--ct-text);
}
.ec:focus-visible {
  outline: 2px solid var(--ct-focus-ring-color);
  outline-offset: 2px;
}
.ec__icon {
  display: grid;
  place-items: center;
  width: var(--ct-space-8);
  height: var(--ct-space-8);
  border-radius: var(--ct-radius-md);
}
.ec--danger .ec__icon {
  background: var(--ct-danger-bg);
  color: var(--ct-danger);
}
.ec--danger {
  border-left: 3px solid var(--ct-danger);
  background: var(--ct-danger-bg);
}
.ec--warning .ec__icon {
  background: var(--ct-warning-bg);
  color: var(--ct-warning);
}
.ec__title {
  margin: 0 0 var(--ct-space-1);
  font-size: var(--ct-text-md);
  font-weight: var(--ct-weight-semibold);
}
.ec__text {
  margin: 0;
  color: var(--ct-text-muted);
  font-size: var(--ct-text-sm);
}
.ec__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ct-space-2);
  width: 100%;
}
.ec__dismiss {
  min-width: var(--ct-space-8);
}
.ec--banner {
  flex-direction: row;
  align-items: center;
  border-color: var(--ct-danger);
  background: var(--ct-danger-bg);
  box-shadow: none;
}
.ec--banner .ec__body {
  flex: 1;
}
.ec--banner .ec__actions {
  width: auto;
}
</style>
