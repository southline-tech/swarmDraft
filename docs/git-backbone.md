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

Opening a book replaces the cache with git. Live rows on `main` are the comment list. A tombstone on `main` removes that id. A comment that is only on a `bot/*` tip is still loaded. Accept merges it. Rejecting the whole branch marks it resolved, including when a checkpoint already copied it onto `main`. A row that exists only in the local database, and not in git, is deleted. A bot comment or suggestion whose commit has not landed yet is kept, and that commit writes the saved row rather than the rebuilt cache. A checkpoint on `main` does not write that comment, or that suggestion's id in `review/changes.json`, while its `bot/*` commit is still pending. A keystroke saved on the suggestion is still written into the chapter. When that keystroke does not apply unless the suggestion is in the chapter, the chapter keeps the suggestion text as well, so the checkpoint does not drop the keystroke.

`review/changes.json` records `decidedBy` and `decidedAt` when `status` is `accepted` or `rejected`. Opening the book writes those rows back into the decision log.

A session file has `id`, `authorName`, `startedAt`, `baseCommit`, and `endedAt` (`null` until the book is closed).

## Refs

| Ref                   | When it moves                                                                                                                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `main`                | Every human checkpoint, Save, comment write, accept/reject, and Restore. HEAD stays here                                                                                                                                                                                                                                                   |
| `session/<sessionId>` | Created at the current `main` tip when the book is opened. Each commit on `main` during that session moves it to the new tip. The ref is kept after the session ends                                                                                                                                                                       |
| `bot/<bot>/<session>` | Bot suggestions and bot comments. Accept merges that branch into `main`. The branch is rejected only when every change that bot introduced is rejected; those comments then land on `main` with `resolvedAt` set. A writer comment or suggestion that was only in the cache is left alone. Rejecting one suggestion leaves the branch open |

Session ids are new each time a book is opened. Bot branch names are unchanged.

## Commit messages

The first line is the title History shows (`Edited …`, `Saved`, `Accepted <bot>'s change in <chapter>`, `Restored version from …`). Trailers sit after a blank line and are not part of that title.

Human commits include:

```
Session: <sessionId>
```

Accept and reject add:

```
Change-Id: <suggestionId>
Decision: accepted|rejected
Kind: <suggestion_insert|suggestion_delete|format_change>
Section: <sectionId>
Decided-By: <author id>
Session: <sessionId>
```

`Kind` is omitted when the decision has no change kind. `Decided-By` is omitted when the decider is empty. The same accept or reject is written into the decision log before the commit, so a rebuilt cache still knows which way it went.

One accept or reject is one commit, including each id in an accept-all or reject-all batch. The deciding commit is the newest one whose `Change-Id` trailer matches. A commit that lists more than one `Change-Id` decides each of those ids.

## When Yjs is written into git

Live typing updates the Yjs document and SQLite on the existing save timer. It does not wait for git. Git is updated only at these points:

1. Idle checkpoint, about 5 seconds after a successful save (`draft_checkpoint`).
2. Save and Save As.
3. Each accept or reject.
4. Each comment create, reply, resolve, reopen, and delete, queued off the caller so the UI thread, the request thread, and a bot MCP call do not wait on git. A human comment commits on `main`. A bot comment commits on that bot's branch. A delete writes a tombstone row; it does not remove the comment file. A human comment's database write and its queue share the draft lock. Restore and open wait until a queued human comment commit has finished, and a reply saved while one of them already holds the lock is written after that rebuild, so a reply that is not in git yet is not dropped. A bot comment or suggestion does not take that lock, so the call can return while a draft operation holds it. Restore and open keep the saved comment and document update, and the bot commit writes those saved bytes. A checkpoint on `main` skips those saved rows until that commit lands, so the branch is cut from a `main` that does not already contain them. A keystroke that does not apply without a still-pending suggestion is written into the chapter anyway, and the suggestion id stays out of `review/changes.json`.
5. Close, which finishes the editing session (`endedAt`) after the last flush. If that commit fails, the session stays active and the save failure is shown.
6. Restore, which adds a new commit on `main` and reloads the book from that tree. The new tree's manuscript text (`book.json`, `chapters/`, `yjs/`) is the restored version. Comments, notes, sessions, and `review/` stay as they are on the previous tip, so a comment made after the restored point is still there. A comment or an accept on a chapter the restored text does not contain stays in the cache, and the next commit writes it again. Restore never resets or rewinds a branch.

Accepting a bot change records that `bot/*` branch as a second parent of `main`. The merge tree is the accept commit, which already has the cache, comments included. A chapter or note the writer removed after the bot snapshot stays absent. Rejecting one suggestion does not end the branch, so another suggestion from that bot can still be accepted. The branch is rejected when every change that bot introduced has been rejected. A writer suggestion that was only in the cache does not keep the branch open. Rejecting the branch marks that bot's comments resolved on `main`, even if a checkpoint already copied them after the bot commit, and the bot session ends. A checkpoint that runs before the bot commit does not copy the comment or the suggestion id. A reject in that same window still writes the comment with `resolvedAt` set, and the decision, onto `main`. The later bot commit does not clear that resolution or put the suggestion text back. A keystroke saved on that suggestion is still in the chapter. It keeps the current comment text and does not bring back a comment the writer deleted. A writer comment that was copied onto the bot branch with the cache stays unresolved. It does not take the bot's text. The comment list on screen still reads from SQLite.

## Finding a change

`draft_resolve_change` walks history for one change id. The introducing commit is the earliest commit that adds the id, compared with its parent snapshot, searching `main`, then `bot/*`, then `session/*`. A later checkpoint that copies the same id does not replace that commit. The walk visits each commit once and stops when it reaches one already seen. On a cache miss that walk runs outside the draft operation lock, so Save does not wait on it. The deciding commit is the newest one with a matching `Change-Id` trailer. An unknown id is a not-found result. A `changes.json` that cannot be read is skipped. Lookups are cached until a `main`, `bot/*`, or `session/*` tip moves.
