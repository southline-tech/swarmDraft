/** The backend's code when another backup, restore or copy holds the shared lock (#86, #100). */
export const BUSY_CODE = 'busy';

/** Plain notice for {@link BUSY_CODE}; shared by Backup, Restore and Save a copy. */
export const BUSY_NOTICE =
  'A backup, restore, or copy is already running. Wait for it to finish, then try again.';
