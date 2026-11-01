<script setup lang="ts">
/**
 * Toolbar Agents window (#245 / #244): draft access per bot; pairing keys stay in Settings.
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import {
  agentsApi,
  type Agent,
  type AgentDraftAccess,
  type AgentDraftAccessMode,
  type StoredManuscriptRow,
} from '../backend';
import { errorLine } from '../errors/map-error';
import { trapTab } from '../settings/focus-trap';

const props = defineProps<{
  batchBanner?: boolean;
  initialSelectedAgentIds?: string[];
  agents: Agent[];
  manuscripts: StoredManuscriptRow[];
  currentManuscriptId: string | null;
  /** Active draft title for ba2 batch banner (#245). */
  currentDraftTitle?: string;
}>();

const currentDraftLabel = computed(() => props.currentDraftTitle?.trim() || 'Untitled draft');

const newlyPairedCount = computed(() => props.initialSelectedAgentIds?.length ?? 0);

const batchBannerText = computed(
  () =>
    `${newlyPairedCount.value} bots paired · each starts with access to ${currentDraftLabel.value} only. Adjust below or use bulk actions.`,
);

const emit = defineEmits<{
  close: [];
  'open-settings': [];
  'dismiss-batch': [];
}>();

const root = ref<HTMLElement | null>(null);
const accessByAgent = ref<Map<string, AgentDraftAccess>>(new Map());
const selected = ref<Set<string>>(new Set());
const busy = ref(false);
const loadError = ref('');

const activeAgents = computed(() => props.agents.filter((a) => !a.revokedAt));

const selectedIds = computed(() => [...selected.value]);

const canBulk = computed(() => selected.value.size > 0 && !busy.value);

async function reloadAccess() {
  loadError.value = '';
  try {
    const rows = await agentsApi.draftAccessList();
    accessByAgent.value = new Map(rows.map((r) => [r.agentId, r]));
  } catch (e) {
    console.error('Load agent draft access failed', e);
    loadError.value = 'Could not load draft access. Try again.';
  }
}

function accessFor(agentId: string): AgentDraftAccess {
  return (
    accessByAgent.value.get(agentId) ?? {
      agentId,
      mode: 'selected',
      manuscriptIds: [],
    }
  );
}

function isGranted(agentId: string, manuscriptId: string): boolean {
  const a = accessFor(agentId);
  if (a.mode === 'all') return true;
  return a.manuscriptIds.includes(manuscriptId);
}

function toggleSelected(agentId: string) {
  const next = new Set(selected.value);
  if (next.has(agentId)) next.delete(agentId);
  else next.add(agentId);
  selected.value = next;
}

async function setMode(agentId: string, mode: AgentDraftAccessMode) {
  if (busy.value) return;
  busy.value = true;
  try {
    await agentsApi.setDraftAccessMode(agentId, mode);
    await reloadAccess();
  } catch (e) {
    console.error('Set draft access mode failed', e);
    loadError.value = errorLine(e, 'save');
  } finally {
    busy.value = false;
  }
}

async function toggleDraft(agentId: string, manuscriptId: string, on: boolean) {
  if (busy.value) return;
  busy.value = true;
  try {
    if (on) await agentsApi.grantDraft(agentId, manuscriptId);
    else await agentsApi.revokeDraft(agentId, manuscriptId);
    await reloadAccess();
  } catch (e) {
    console.error('Toggle draft access failed', e);
    loadError.value = errorLine(e, 'save');
  } finally {
    busy.value = false;
  }
}

async function bulkGrantCurrent() {
  const mid = props.currentManuscriptId;
  if (!mid || !canBulk.value) return;
  busy.value = true;
  try {
    await agentsApi.bulkGrantCurrentDraft(selectedIds.value, mid);
    await reloadAccess();
    emit('dismiss-batch');
  } catch (e) {
    console.error('Bulk grant current draft failed', e);
    loadError.value = errorLine(e, 'save');
  } finally {
    busy.value = false;
  }
}

async function bulkGrantAll() {
  if (!canBulk.value) return;
  busy.value = true;
  try {
    await agentsApi.bulkGrantAllDrafts(selectedIds.value);
    await reloadAccess();
    emit('dismiss-batch');
  } catch (e) {
    console.error('Bulk grant all drafts failed', e);
    loadError.value = errorLine(e, 'save');
  } finally {
    busy.value = false;
  }
}

async function bulkRevokeAll() {
  if (!canBulk.value) return;
  busy.value = true;
  try {
    await agentsApi.bulkRevokeAllDrafts(selectedIds.value);
    await reloadAccess();
  } catch (e) {
    console.error('Bulk revoke all drafts failed', e);
    loadError.value = errorLine(e, 'save');
  } finally {
    busy.value = false;
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close');
  else if (root.value) trapTab(e, root.value);
}

watch(
  () => props.initialSelectedAgentIds,
  (ids) => {
    if (ids?.length) selected.value = new Set(ids);
  },
  { immediate: true },
);

onMounted(async () => {
  await reloadAccess();
  await nextTick();
  root.value?.querySelector<HTMLElement>('[data-test="agents-close"]')?.focus();
});
</script>

<template>
  <div class="aw-scrim" data-test="agents-scrim" @click.self="emit('close')">
    <div
      ref="root"
      class="aw"
      role="dialog"
      aria-modal="true"
      aria-labelledby="aw-title"
      data-test="agents-window"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <header class="aw__head">
        <h2 id="aw-title" class="aw__title">Agents</h2>
        <button
          type="button"
          class="aw__close"
          data-test="agents-close"
          aria-label="Close"
          @click="emit('close')"
        >
          ×
        </button>
      </header>
      <p v-if="batchBanner" class="aw__banner" role="status" data-test="agents-batch-banner">
        {{ batchBannerText }}
      </p>
      <div
        v-if="canBulk"
        class="aw__bulk"
        role="toolbar"
        aria-label="Bulk draft access actions"
        data-test="agents-bulk-bar"
      >
        <span class="aw__bulk-label">{{ selected.size }} selected</span>
        <button
          type="button"
          class="aw__bulk-btn"
          data-test="bulk-grant-current"
          :disabled="!currentManuscriptId || busy"
          @click="bulkGrantCurrent"
        >
          Grant current draft
        </button>
        <button
          type="button"
          class="aw__bulk-btn"
          data-test="bulk-grant-all"
          :disabled="busy"
          @click="bulkGrantAll"
        >
          Grant all drafts
        </button>
        <button
          type="button"
          class="aw__bulk-btn aw__bulk-btn--danger"
          data-test="bulk-revoke-all"
          :disabled="busy"
          @click="bulkRevokeAll"
        >
          Revoke all drafts
        </button>
      </div>
      <div class="aw__body" data-test="agents-list">
        <p v-if="loadError" class="aw__error" role="alert">{{ loadError }}</p>
        <p v-else-if="!activeAgents.length" class="aw__muted">No active agents yet.</p>
        <ul v-else class="aw__agents">
          <li
            v-for="agent in activeAgents"
            :key="agent.id"
            class="aw__agent"
            data-test="agent-row"
            :data-agent="agent.name"
          >
            <label class="aw__select">
              <input
                type="checkbox"
                data-test="agent-select"
                :checked="selected.has(agent.id)"
                @change="toggleSelected(agent.id)"
              />
              <span class="aw__swatch" aria-hidden="true" :style="{ background: agent.color }" />
              <bdi dir="auto" class="aw__name">{{ agent.name }}</bdi>
            </label>
            <fieldset
              class="aw__mode"
              role="radiogroup"
              data-test="access-mode"
              :aria-label="`Draft access for ${agent.name}`"
            >
              <legend class="visually-hidden">Draft access for {{ agent.name }}</legend>
              <label class="aw__radio">
                <input
                  type="radio"
                  data-test="mode-selected"
                  :name="`mode-${agent.id}`"
                  value="selected"
                  :checked="accessFor(agent.id).mode === 'selected'"
                  @change="setMode(agent.id, 'selected')"
                />
                Selected drafts
              </label>
              <label class="aw__radio">
                <input
                  type="radio"
                  data-test="mode-all"
                  :name="`mode-${agent.id}`"
                  value="all"
                  :checked="accessFor(agent.id).mode === 'all'"
                  @change="setMode(agent.id, 'all')"
                />
                All drafts (incl. future)
              </label>
            </fieldset>
            <ul
              v-if="accessFor(agent.id).mode === 'selected'"
              class="aw__drafts"
              data-test="access-checklist"
            >
              <li v-for="m in manuscripts" :key="m.id">
                <label class="aw__draft">
                  <input
                    type="checkbox"
                    :checked="isGranted(agent.id, m.id)"
                    :disabled="busy"
                    @change="
                      toggleDraft(agent.id, m.id, ($event.target as HTMLInputElement).checked)
                    "
                  />
                  {{ m.title.trim() || 'Untitled draft' }}
                </label>
              </li>
            </ul>
          </li>
        </ul>
      </div>
      <footer class="aw__foot">
        <button
          type="button"
          class="aw__link"
          data-test="agents-settings-link"
          @click="emit('open-settings')"
        >
          Open Settings…
        </button>
        <button type="button" class="aw__done" data-test="agents-done" @click="emit('close')">
          Done
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.aw-scrim {
  position: fixed;
  inset: 0;
  z-index: 6;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--ct-space-4);
  background: var(--ct-scrim);
}
.aw {
  display: flex;
  flex-direction: column;
  width: min(36rem, 100%);
  max-height: min(32rem, 100%);
  border-radius: var(--ct-radius-lg);
  border: 1px solid var(--ct-border);
  background: var(--ct-surface);
  color: var(--ct-text);
  font-family: var(--ct-font-ui);
  box-shadow: var(--ct-elevation-3);
}
.aw:focus {
  outline: none;
}
.aw__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ct-space-3);
  padding: var(--ct-space-4);
  border-bottom: 1px solid var(--ct-border);
}
.aw__title {
  margin: 0;
  font-size: var(--ct-text-lg);
  font-weight: var(--ct-weight-semibold);
}
.aw__close {
  min-width: var(--ct-space-8);
  min-height: var(--ct-space-8);
  border: 0;
  border-radius: var(--ct-radius-sm);
  background: transparent;
  color: var(--ct-text-muted);
  font-size: var(--ct-text-xl);
  cursor: pointer;
}
.aw__close:focus-visible {
  outline: 2px solid var(--ct-focus-ring-color);
  outline-offset: 2px;
}
.aw__banner {
  margin: 0;
  padding: var(--ct-space-3) var(--ct-space-4);
  background: var(--ct-success-bg);
  color: var(--ct-text);
  font-size: var(--ct-text-sm);
}
.aw__bulk {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ct-space-2);
  padding: var(--ct-space-3) var(--ct-space-4);
  border-bottom: 1px solid var(--ct-border);
  background: var(--ct-bg);
}
.aw__bulk-label {
  font-size: var(--ct-text-sm);
  font-weight: var(--ct-weight-semibold);
  margin-right: var(--ct-space-2);
}
.aw__bulk-btn {
  min-height: var(--ct-space-8);
  padding: 0 var(--ct-space-3);
  border: 1px solid var(--ct-border-strong);
  border-radius: var(--ct-radius-sm);
  background: var(--ct-surface);
  color: var(--ct-text);
  font-size: var(--ct-text-sm);
  cursor: pointer;
}
.aw__bulk-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.aw__bulk-btn--danger {
  border-color: var(--ct-danger);
  color: var(--ct-danger);
}
.aw__body {
  flex: 1;
  overflow: auto;
  padding: var(--ct-space-4);
}
.aw__muted {
  margin: 0;
  color: var(--ct-text-muted);
  font-size: var(--ct-text-sm);
  line-height: var(--ct-leading-body);
}
.aw__error {
  margin: 0;
  color: var(--ct-danger);
  font-size: var(--ct-text-sm);
}
.aw__agents {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-4);
}
.aw__agent {
  padding: var(--ct-space-3);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-md);
}
.aw__select {
  display: flex;
  align-items: center;
  gap: var(--ct-space-2);
  font-weight: var(--ct-weight-semibold);
  cursor: pointer;
}
.aw__swatch {
  width: var(--ct-space-4);
  height: var(--ct-space-4);
  border-radius: var(--ct-radius-full);
  border: 1px solid var(--ct-border-strong);
}
.aw__mode {
  margin: var(--ct-space-3) 0 0;
  padding: 0;
  border: 0;
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-2);
}
.aw__radio {
  display: flex;
  align-items: center;
  gap: var(--ct-space-2);
  font-size: var(--ct-text-sm);
  cursor: pointer;
}
.aw__drafts {
  margin: var(--ct-space-3) 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-1);
}
.aw__draft {
  display: flex;
  align-items: center;
  gap: var(--ct-space-2);
  font-size: var(--ct-text-sm);
  cursor: pointer;
}
.aw__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--ct-space-3);
  padding: var(--ct-space-3) var(--ct-space-4);
  border-top: 1px solid var(--ct-border);
}
.aw__link {
  border: 0;
  background: none;
  color: var(--ct-accent);
  font-size: var(--ct-text-sm);
  cursor: pointer;
  text-decoration: underline;
}
.aw__done {
  min-height: var(--ct-space-8);
  padding: 0 var(--ct-space-4);
  border: 0;
  border-radius: var(--ct-radius-sm);
  background: var(--ct-accent);
  color: var(--ct-paper);
  font-weight: var(--ct-weight-semibold);
  cursor: pointer;
}
.aw__done:focus-visible {
  outline: 2px solid var(--ct-focus-ring-color);
  outline-offset: 2px;
}
</style>
