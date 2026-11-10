import { onBeforeUnmount, shallowRef, type ShallowRef } from 'vue';
import { DEFAULT_PROFILE, type Profile } from './prefs';

/**
 * Writer name and color are one profile for the whole book. Every mounted
 * section reads this ref. The lead seeds it when track changes turns on and
 * reloads it when the name prompt closes, so a chapter already on screen
 * records that name and the writer color follows it. The ref is re-read from
 * storage only when no editor is mounted.
 */
const bookProfile = shallowRef<Profile>({ ...DEFAULT_PROFILE });
let holders = 0;

export function useBookProfile(stored: Profile): ShallowRef<Profile> {
  if (holders === 0) bookProfile.value = stored;
  holders += 1;
  onBeforeUnmount(() => {
    holders = Math.max(0, holders - 1);
  });
  return bookProfile;
}
