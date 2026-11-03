<script setup lang="ts">
/**
 * Shared markup for toolbar items that may render inline or in the ⋯ menu (issue 268).
 */
import type { Align } from './toolbar';
import { SHORTCUTS, SUPPORTED_ALIGN } from './toolbar';
import type { ToolbarCommand } from './toolbar';
import type { ToolbarOverflowItemId } from './toolbar-overflow';

const props = defineProps<{
  surface: 'inline' | 'overflow-icons' | 'overflow-text' | 'measure';
  show: (id: ToolbarOverflowItemId) => boolean;
  btn: string;
  ro: Record<string, string>;
  editable: boolean;
  readOnlyText: string;
  state: {
    underline: boolean;
    align: Align;
    smallcaps: boolean;
    strike: boolean;
  };
  navigatorOpen: boolean;
  navigatorControls: string;
  commentEnabled: boolean;
  findEnabled: boolean;
  textActions: {
    id: ToolbarOverflowItemId;
    cmd: ToolbarCommand;
    label: string;
    active?: 'smallcaps' | 'strike';
  }[];
  aligns: { id: Align; label: string; path: string }[];
  ftip: (label: string, key?: string) => string;
  soon: (label: string, key?: string) => string;
  soonAttrs: Record<string, string>;
}>();

const emit = defineEmits<{
  'toggle-navigator': [];
  comment: [];
  find: [];
  run: [cmd: ToolbarCommand];
  pick: [cmd: ToolbarCommand];
}>();

const visible = (id: ToolbarOverflowItemId) => props.surface === 'measure' || props.show(id);

const textBtn =
  'inline-flex h-7.5 max-w-40 shrink-0 cursor-pointer items-center rounded-sm border-0 bg-transparent px-2 font-ui text-[13px] text-text hover:bg-selected hover:text-accent aria-disabled:cursor-default aria-disabled:opacity-40';
const menuTextBtn =
  'flex h-7.5 w-full cursor-pointer items-center rounded-sm border-0 bg-transparent px-2.5 text-left font-ui text-[13px] text-text hover:bg-selected hover:text-accent focus:bg-selected aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-text';
</script>

<template>
  <template v-if="surface !== 'overflow-text'">
    <button
      v-if="visible('navigator')"
      type="button"
      data-test="tb-navigator"
      :class="btn"
      aria-label="Chapters"
      title="Chapters"
      :aria-pressed="navigatorOpen"
      :aria-expanded="navigatorOpen"
      :aria-controls="navigatorControls"
      :data-tb-measure="surface === 'measure' ? 'navigator' : undefined"
      @click="emit('toggle-navigator')"
    >
      <svg class="tb-i" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
        <path d="M6 3v10" />
      </svg>
    </button>
    <button
      v-if="visible('underline')"
      type="button"
      data-test="tb-underline"
      :class="[btn, 'underline']"
      :aria-pressed="state.underline"
      aria-label="Underline"
      :aria-keyshortcuts="editable ? 'Control+U' : undefined"
      :title="ftip('Underline', SHORTCUTS.underline)"
      :data-tb-measure="surface === 'measure' ? 'underline' : undefined"
      v-bind="ro"
      @click="emit('run', 'underline')"
    >
      U
    </button>
    <template v-if="visible('aligns')">
      <span
        v-if="surface === 'measure'"
        data-tb-measure="aligns"
        class="inline-flex items-center gap-0.5"
      >
        <button
          v-for="a in aligns"
          :key="a.id"
          type="button"
          :class="btn"
          tabindex="-1"
          aria-hidden="true"
        >
          <svg class="tb-i" viewBox="0 0 16 16"><path :d="a.path" /></svg>
        </button>
      </span>
      <button
        v-for="a in aligns"
        v-else
        :key="a.id"
        type="button"
        :data-test="`tb-align-${a.id}`"
        :class="btn"
        :aria-pressed="state.align === a.id"
        :aria-label="a.label"
        :title="SUPPORTED_ALIGN.includes(a.id) ? ftip(a.label) : soon(a.label)"
        v-bind="SUPPORTED_ALIGN.includes(a.id) ? ro : soonAttrs"
        @click="SUPPORTED_ALIGN.includes(a.id) && emit('run', `align:${a.id}`)"
      >
        <svg class="tb-i" viewBox="0 0 16 16" aria-hidden="true"><path :d="a.path" /></svg>
      </button>
    </template>
    <button
      v-if="visible('comment')"
      type="button"
      data-test="tb-comment"
      :class="btn"
      aria-label="Add comment"
      :title="commentEnabled ? 'Add comment' : soon('Add comment')"
      :aria-disabled="commentEnabled ? undefined : 'true'"
      :aria-description="commentEnabled ? undefined : soonAttrs['aria-description']"
      :data-tb-measure="surface === 'measure' ? 'comment' : undefined"
      @click="commentEnabled && emit('comment')"
    >
      <svg class="tb-i" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H7l-3 2.5V11h0A1 1 0 0 1 3 10z"
        />
      </svg>
    </button>
    <button
      v-if="visible('find')"
      type="button"
      data-test="tb-find"
      :class="[btn, 'px-2.5']"
      aria-label="Find"
      :title="findEnabled ? 'Find' : soon('Find')"
      :aria-disabled="findEnabled ? undefined : 'true'"
      :aria-description="findEnabled ? undefined : soonAttrs['aria-description']"
      :data-tb-measure="surface === 'measure' ? 'find' : undefined"
      @click="findEnabled && emit('find')"
    >
      <svg class="tb-i" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="7" cy="7" r="3.8" />
        <path d="m10 10 3 3" />
      </svg>
      Find
    </button>
    <template v-if="surface === 'inline' || surface === 'measure'">
      <template v-for="o in textActions" :key="o.cmd">
        <button
          v-if="visible(o.id)"
          type="button"
          :data-test="`tb-menu-${o.cmd.replace(':', '-')}`"
          :class="textBtn"
          :aria-label="o.label"
          v-bind="ro"
          :title="editable ? o.label : readOnlyText"
          :data-tb-measure="surface === 'measure' ? o.id : undefined"
          @click="emit('run', o.cmd)"
        >
          {{ o.label }}
        </button>
      </template>
    </template>
  </template>
  <template v-else>
    <button
      v-for="o in textActions"
      :key="o.cmd"
      type="button"
      :role="o.active ? 'menuitemcheckbox' : 'menuitem'"
      tabindex="-1"
      :aria-label="o.label"
      v-bind="ro"
      :title="editable ? o.label : readOnlyText"
      :data-test="`tb-menu-${o.cmd.replace(':', '-')}`"
      :aria-checked="o.active ? state[o.active] : undefined"
      :class="[menuTextBtn, o.active && state[o.active] ? 'bg-selected text-accent' : '']"
      @click="emit('pick', o.cmd)"
    >
      {{ o.label }}
    </button>
  </template>
</template>
