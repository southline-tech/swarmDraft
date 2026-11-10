# Git backbone

A `.draft` file is a zip of `manifest.json` plus a bare git repository. The open book also keeps a working git checkout under the app data directory. SQLite and Yjs are a cache of that git history. Git wins when a book is opened: the cache is rebuilt from the tree, and a tombstone removes the matching row. A git failure is logged and does not roll back text the writer has already typed.

The `.draft` format version is **2** (`manifest.json` `formatVersion`). A file with any other version fails to open with `unsupported format version`. There is no reader for older books.

## Worktree layout

| Path                        | Contents                                                             |
| --------------------------- | -------------------------------------------------------------------- |
| `book.json`                 | Title, numbering, outline, bot access                                |
| `chapters/<sectionId>.md`   | Chapter text for reading                                             |
| `yjs/<sectionId>.bin`       | Yjs state for that section                                           |
| `notes/<noteId>.md`         | Story notes                                                          |
| `comments/<threadId>.json`  | One comment thread, open or resolved. Rows are sorted by `createdAt` |
| `review/changes.json`       | Every tracked change, sorted by id                                   |
| `sessions/<sessionId>.json` | One human editing session                                            |

`review/changes.json` is a JSON array. Each object has `id`, `kind` (`suggestion_insert`, `suggestion_delete`, or `format_change`), `sectionId`, `authorKind`, `authorId`, `authorName`, `status` (`open`, `accepted`, or `rejected`), and `quote` (at most 200 characters). An accepted or rejected row also has `decidedBy` and `decidedAt`. The bytes stay the same when nothing in the book changed, so a second save does not add an empty commit.

A comment file has `threadId` and `rows`. Each row has `id`, `sectionId`, `blockId`, `quote`, `body`, `threadId`, `authorKind`, `authorId`, `authorName`, `createdAt`, and `resolvedAt`. A deleted row also has `deletedAt`. That row is a tombstone: the file stays in git, and opening the book removes the live cache row. A save writes `comments/.keep` so the directory stays in git when there are no threads.

Opening a book replaces the cache with git. Live rows on `main` are the comment list. A tombstone on `main` removes that id. A comment or a decision that exists only on a `bot/*` tip is still loaded, whether that branch is still open or already merged. A row that exists only in the local database, and not in git, is deleted. A bot comment or suggestion whose commit has not landed yet is kept, and that commit writes the saved row rather than the rebuilt cache. If a checkpoint or a decision runs before that commit, the bot branch is created and the suggestion is committed there first. A checkpoint on `main` does not write that comment, or that suggestion's row in `review/changes.json`, until the branch merges. A comment or a decision that is already on `main` stays there when a later commit on another open bot branch copies it, and a resolve of that comment stays on `main`. Pending suggestion marks are left out of the chapter on `main`. Accepted text is kept, without the mark. Rejected insert text stays off `main`.

`review/changes.json` records `decidedBy` and `decidedAt` when `status` is `accepted` or `rejected`. Opening the book writes those rows back into the decision log.

A session file has `id`, `authorName`, `startedAt`, `baseCommit`, and `endedAt` (`null` until the book is closed).

## Refs

| Ref                   | When it moves                                                                                                                                                                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main`                | Every human checkpoint, Save, human comment write, and Restore. HEAD stays here. A bot branch merges in once, after every suggestion on it is accepted or rejected. That merge keeps main's text and brings the decision history                                                                           |
| `session/<sessionId>` | Created at the current `main` tip when the book is opened. Each commit on `main` during that session moves it to the new tip. The ref is kept after the session ends                                                                                                                                       |
| `bot/<bot>/<session>` | The bot's suggestions, comments, and each accept or reject. The branch merges into `main` once every suggestion on it is decided. The git ref is kept. Rejecting one suggestion leaves the branch open and resolves the comment linked to it. A writer comment or suggestion does not keep the branch open |

Session ids are new each time a book is opened. Bot branch names are unchanged.

## Commit messages

The first line is the title History shows (`Edited …`, `Saved`, `Merged bot/…`, `Restored version from …`). Accept and reject titles live on the bot branch. Trailers sit after a blank line and are not part of that title.

Human commits include:

```
Session: <sessionId>
```

Accept and reject are commits on the bot branch. The git committer is the bot. History on `main` shows the later merge, `Merged bot/…`, not these titles. The bot commit adds:

```
Change-Id: <suggestionId>
Decision: accepted|rejected
Kind: <suggestion_insert|suggestion_delete|format_change>
Section: <sectionId>
Decided-By: <author id>
Session: <sessionId>
```

`Kind` is omitted when the decision has no change kind. `Decided-By` is omitted when the decider is empty. The same accept or reject is written into `review/changes.json` on the bot branch before the commit, so a rebuilt cache still knows which way it went. A reject also sets `resolvedAt` on the bot comment linked to that suggestion, in that same commit.

One accept or reject is one commit, including each id in an accept-all or reject-all batch. The deciding commit is the newest one whose `Change-Id` trailer matches. A commit that lists more than one `Change-Id` decides each of those ids.

## When Yjs is written into git

Live typing updates the Yjs document and SQLite on the existing save timer. It does not wait for git. Git is updated only at these points:

1. Idle checkpoint, about 5 seconds after a successful save (`draft_checkpoint`).
2. Save and Save As.
3. Each accept or reject, committed on the bot branch. `main` then checkpoints the live document.
4. Each comment create, reply, resolve, reopen, and delete, queued off the caller so the UI thread, the request thread, and a bot MCP call do not wait on git. A human comment commits on `main`. A bot comment commits on that bot's branch. A delete writes a tombstone row; it does not remove the comment file. A human comment's database write and its queue share the draft lock. Restore and open wait until a queued human comment commit has finished, and a reply saved while one of them already holds the lock is written after that rebuild, so a reply that is not in git yet is not dropped. A bot comment or suggestion does not take that lock, so the call can return while a draft operation holds it. Restore and open keep the saved comment and document update, and the bot commit writes those saved bytes. A checkpoint on `main` flushes a still-pending bot suggestion onto the bot branch first, then writes the live chapter without that comment, without that suggestion's row, and without pending suggestion marks.
5. Close, which finishes the editing session (`endedAt`) after the last flush. If that commit fails, the session stays active and the save failure is shown.
6. Restore, which adds a new commit on `main` and reloads the book from that tree. The new tree's manuscript text (`book.json`, `chapters/`, `yjs/`) is the restored version. Comments, notes, sessions, and `review/` stay as they are on the previous tip, so a comment made after the restored point is still there. A comment or an accept on a chapter the restored text does not contain stays in the cache, and the next commit writes it again. Restore never resets or rewinds a branch.

A bot branch merges into `main` once, only after every suggestion on it has been accepted or rejected. The merge uses the real merge-base. The tree starts as main's tree, so the writer's text stays, including a chapter they edited or deleted around a pending suggestion. It never brings rejected or deleted text back. The merge adds the bot branch's `review/changes.json` and bot comments that are not already on `main`. The git ref stays, and the in-memory session ends. Until that merge, checkpoints on `main` save the live document: accepted text included, pending marks excluded. The merge is bookkeeping. The packed file is written after it, so reopening does not offer to save a newer copy. A decision or a checkpoint that arrives before the bot commit creates the branch and commits the suggestion first. A reject resolves the comment linked to that suggestion in every order: before the bot commit, after a checkpoint, or after the suggestion is already on the branch. A writer comment that was copied onto the bot branch stays unresolved. The comment list on screen still reads from SQLite.

## Finding a change

`draft_resolve_change` walks history for one change id. The introducing commit is the earliest commit that adds the id, compared with its parent snapshot, searching `main`, then `bot/*`, then `session/*`. A later checkpoint that copies the same id does not replace that commit. The walk visits each commit once and stops when it reaches one already seen. On a cache miss that walk runs outside the draft operation lock, so Save does not wait on it. The deciding commit is the newest one with a matching `Change-Id` trailer. An unknown id is a not-found result. A `changes.json` that cannot be read is skipped. Lookups are cached until a `main`, `bot/*`, or `session/*` tip moves.
