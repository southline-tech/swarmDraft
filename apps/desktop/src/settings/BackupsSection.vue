<script setup lang="ts">
/**
 * Settings → Backups (#99). Layout only: the backup and restore logic stays in App.vue (it has
 * to flush and close the open session), so this component just shows state and emits clicks.
 */
import { nextTick, ref, watch } from 'vue';
import { trapTab } from './focus-trap';

const props = defineProps<{
  status: string;
  confirming: boolean;
  tokensNotice: number | null;
}>();
const restorePath = defineModel<string>('restorePath', { required: true });
const emit = defineEmits<{
  backup: [];
  pick: [];
  ask: [];
  confirm: [];
  cancel: [];
  dismiss: [];
}>();

const dialog = ref<HTMLElement | null>(null);
const cancelButton = ref<HTMLButtonElement | null>(null);
let opener: HTMLElement | null = null;

watch(
  () => props.confirming,
  async (open) => {
    if (open) {
      const active = document.activeElement;
      opener = active instanceof HTMLElement ? active : null;
      await nextTick();
      // Start on Cancel: the safe choice in a destructive confirm.
      cancelButton.value?.focus();
    } else if (opener?.isConnected) {
      await nextTick();
      opener.focus();
      opener = null;
    }
  },
);

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    emit('cancel');
  } else if (dialog.value) trapTab(e, dialog.value);
}
</script>

<template>
  <div data-test="backup">
    <div role="status" data-test="tokens-revoked-live">
      <div
        v-if="tokensNotice !== null"
        class="st-ban st-ban--s st-ban--top"
        data-test="tokens-revoked-notice"
      >
        <div class="st-ban__text">
          <b>Restore finished.</b> For safety, restoring turned off all {{ tokensNotice }} agent
          key(s). Your agents are kept; create new keys in Settings &gt; Agents to reconnect them.
        </div>
        <button
          type="button"
          class="st-btn st-btn--s"
          data-test="tokens-notice-dismiss"
          @click="emit('dismiss')"
        >
          Dismiss
        </button>
      </div>
    </div>
    <h1 class="st-h1">Backups</h1>
    <p class="st-muted st-sub">
      A backup is one file holding all your books, comments, suggestions, settings and attached
      files.
    </p>
    <section class="st-card" aria-labelledby="bk-make">
      <h2 id="bk-make" class="st-h2">Make a backup</h2>
      <p class="st-muted st-desc">Saves a .zip file you can keep somewhere safe.</p>
      <button
        type="button"
        class="st-btn st-btn--primary"
        data-test="backup-button"
        @click="emit('backup')"
      >
        Download backup
      </button>
    </section>
    <section class="st-card" aria-labelledby="bk-restore">
      <h2 id="bk-restore" class="st-h2">Restore from a backup</h2>
      <p class="st-muted st-desc">
        Replaces everything in swarmDraft with what's in the backup. You'll be asked to confirm
        first.
      </p>
      <button type="button" class="st-btn" data-test="restore-pick" @click="emit('pick')">
        Restore from backup…
      </button>
      <details class="bk__fallback" data-test="restore-fallback">
        <summary>Enter a path instead</summary>
        <div class="bk__pathrow">
          <input
            v-model="restorePath"
            class="st-inp st-mono"
            aria-label="Path to backup .zip"
            data-test="restore-path"
            placeholder="Path to backup .zip"
          />
          <button type="button" class="st-btn" data-test="restore-button" @click="emit('ask')">
            Restore…
          </button>
        </div>
      </details>
    </section>
    <p role="status" class="st-status" data-test="backup-status">{{ status }}</p>
    <div v-if="confirming" class="bk__scrim">
      <div
        ref="dialog"
        class="bk__dlg"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="bk-confirm-title"
        aria-describedby="bk-confirm-body"
        data-test="restore-confirm"
        @keydown="onKeydown"
      >
        <div class="bk__ic" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="24" height="24">
            <path d="M12 3 2 21h20z" />
            <path d="M12 10v5M12 18h.01" />
          </svg>
        </div>
        <h2 id="bk-confirm-title" class="bk__title">Replace everything with this backup?</h2>
        <p class="st-mono bk__target" data-test="restore-target">{{ restorePath }}</p>
        <p id="bk-confirm-body">
          Restoring replaces all manuscripts, comments, suggestions, settings and attached files
          with the contents of this backup, and turns off all agent keys. Your current state is
          saved first as a pre-restore snapshot in the backups folder.
        </p>
        <div class="bk__actions">
          <button
            ref="cancelButton"
            type="button"
            class="st-btn"
            data-test="restore-confirm-no"
            @click="emit('cancel')"
          >
            Cancel
          </button>
          <button
            type="button"
            class="st-btn st-btn--danger"
            data-test="restore-confirm-yes"
            @click="emit('confirm')"
          >
            Replace everything and restore
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bk__fallback {
  margin-top: var(--ct-space-4);
}
.bk__fallback summary {
  min-height: var(--ct-space-10);
  display: flex;
  align-items: center;
  gap: var(--ct-space-2);
  width: fit-content;
  font-size: var(--ct-text-sm);
  font-weight: var(--ct-weight-semibold);
  cursor: pointer;
  list-style: none;
}
.bk__fallback summary::-webkit-details-marker {
  display: none;
}
.bk__fallback summary::before {
  content: '▸';
}
.bk__fallback[open] summary::before {
  content: '▾';
}
.bk__fallback summary:focus-visible {
  box-shadow: var(--ct-focus-ring);
  outline: 0;
  border-radius: var(--ct-radius-md);
}
.bk__pathrow {
  display: flex;
  gap: var(--ct-space-3);
  margin-top: var(--ct-space-2);
}
.bk__scrim {
  position: fixed;
  inset: 0;
  z-index: 10;
  display: grid;
  place-items: center;
  padding: var(--ct-space-6);
  background: color-mix(in srgb, var(--ct-text) 40%, transparent);
}
.bk__dlg {
  width: min(640px, 100%);
  padding: var(--ct-space-8);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-lg);
  background: var(--ct-surface-raised);
  box-shadow: var(--ct-elevation-2);
  line-height: 1.5;
}
.bk__ic {
  display: grid;
  place-items: center;
  width: var(--ct-space-12);
  height: var(--ct-space-12);
  margin-bottom: var(--ct-space-4);
  border-radius: var(--ct-radius-full);
  background: var(--ct-danger-bg);
  color: var(--ct-danger);
}
.bk__ic svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.bk__title {
  margin: 0;
  font-family: var(--ct-font-manuscript);
  font-size: var(--ct-text-xl);
  font-weight: var(--ct-weight-semibold);
}
.bk__target {
  margin: var(--ct-space-2) 0 var(--ct-space-3);
  padding: var(--ct-space-2) var(--ct-space-3);
  border-radius: var(--ct-radius-md);
  background: var(--ct-bg);
  overflow-wrap: anywhere;
}
.bk__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ct-space-3);
  margin-top: var(--ct-space-6);
}
</style>
