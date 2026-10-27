<script setup lang="ts">
/**
 * Rename-migration notices (#71). Two live regions stay mounted for the life of the app so screen
 * readers announce notices that arrive later: info notices go in a polite role=status region,
 * warn notices (something the writer must act on, e.g. close the other app) in role=alert.
 * Only the inner content is conditional. Copy comes from the backend, written for writers.
 */
import { computed } from 'vue';
import type { MigrationNotice } from '../backend';
import { PRODUCT_NAME } from '../lib/brand';

const props = defineProps<{ notices: MigrationNotice[] }>();
const emit = defineEmits<{ dismiss: [ids: string[]] }>();

const info = computed(() => props.notices.filter((n) => n.kind !== 'warn'));
const warn = computed(() => props.notices.filter((n) => n.kind === 'warn'));
</script>

<template>
  <div class="migration-regions" data-test="migration-notice-region">
    <div role="alert" data-test="migration-notice-warn-region">
      <section
        v-if="warn.length"
        class="migration-notice migration-notice--warn"
        data-test="migration-notice"
        data-kind="warn"
      >
        <svg class="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path
            d="M8 1.75 15 14H1L8 1.75Z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linejoin="round"
          />
          <path
            d="M8 6v3.5M8 11.5v.5"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
        <div class="body">
          <p v-for="n in warn" :key="n.id" class="text" :data-id="n.id">{{ n.text }}</p>
        </div>
        <button
          type="button"
          class="action"
          data-test="migration-notice-dismiss"
          :aria-label="`Dismiss ${PRODUCT_NAME} update warning${warn.length > 1 ? 's' : ''}`"
          @click="
            emit(
              'dismiss',
              warn.map((n) => n.id),
            )
          "
        >
          Dismiss
        </button>
      </section>
    </div>
    <div role="status" data-test="migration-notice-info-region">
      <section
        v-if="info.length"
        class="migration-notice migration-notice--info"
        data-test="migration-notice"
        data-kind="info"
      >
        <svg class="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.5" />
          <path
            d="M8 7v4.5M8 4.5v.5"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
        <div class="body">
          <p v-for="n in info" :key="n.id" class="text" :data-id="n.id">{{ n.text }}</p>
        </div>
        <button
          type="button"
          class="action"
          data-test="migration-notice-dismiss"
          :aria-label="`Dismiss ${PRODUCT_NAME} update notice${info.length > 1 ? 's' : ''}`"
          @click="
            emit(
              'dismiss',
              info.map((n) => n.id),
            )
          "
        >
          Dismiss
        </button>
      </section>
    </div>
  </div>
</template>

<style scoped>
.migration-notice {
  display: flex;
  align-items: flex-start;
  gap: var(--ct-space-3);
  margin: var(--ct-space-2) var(--ct-space-4);
  padding: var(--ct-space-3) var(--ct-space-4);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-md);
  background: var(--ct-surface-raised);
  color: var(--ct-text);
}
.migration-notice--warn {
  border-color: var(--ct-warning);
  background: var(--ct-warning-bg);
}
.migration-notice--info {
  border-color: var(--ct-accent);
}
.icon {
  flex: none;
  margin-top: 2px;
}
.migration-notice--warn .icon {
  color: var(--ct-warning);
}
.migration-notice--info .icon {
  color: var(--ct-accent);
}
.body {
  flex: 1;
  min-width: 0;
}
.text {
  margin: 0;
}
.text + .text {
  margin-top: var(--ct-space-1);
}
.action {
  flex: none;
  padding: var(--ct-space-1) var(--ct-space-3);
  border: 1px solid var(--ct-border-strong);
  border-radius: var(--ct-radius-sm);
  background: var(--ct-surface);
  color: var(--ct-text);
  font: inherit;
  cursor: pointer;
}
.action:focus-visible {
  outline: none;
  box-shadow: var(--ct-focus-ring);
}
</style>
