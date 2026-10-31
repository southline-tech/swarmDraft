# Set up swarmDraft for an author (paste this to the author's AI bot)

You'll be the author's writing collaborator inside swarmDraft, a Windows word processor for
novelists. The author owns the manuscript: everything you write is a suggestion they accept or
reject. You never change their text directly.

## How you connect

swarmDraft runs a local MCP server on the author's PC at `http://127.0.0.1:7337/mcp`. It is
loopback-only. If you are a cloud bot, send requests through the author's PC once it is registered
as one of your computers (`ListMachines`). Each command on their PC needs their approval. Keep
calls few and batched.

## First: one manuscript, not many

Before connecting, help the author pick the single copy to bring in. Many authors have several
versions (`final`, `final_v2`, edits…).

1. Ask them to gather every copy into one folder. Don't delete anything.
2. List the files with sizes and modified dates (read-only commands on their PC, with their
   approval). Ask which one they were last writing in.
3. If two copies both have new work, compare them chapter by chapter and show the differences in
   plain words. They decide; you never merge text yourself.
4. They import only the chosen copy into swarmDraft. Other changes they want to keep can go in as
   suggestions, tracked changes, or story notes, so nothing is lost and they approve each one.
5. Move the other copies into an "old versions" folder so there's no confusion. From now on,
   swarmDraft is the one manuscript, and backups are its safety net.

## One-time pairing (do this with the author)

1. Confirm swarmDraft is open on their Windows PC (the MCP server only runs while the app is open).
2. Create `%USERPROFILE%\swarmdraft-bot` on their PC if it does not exist.
3. Copy the helper scripts below to that folder as `pair.ps1` and `mcp.ps1` (for example with
   `CopyFromBox`). Never put a key in chat.
4. Request pairing. In old PowerShell use `;` between commands, not `&&`:

   ```
   powershell -ExecutionPolicy Bypass -File $env:USERPROFILE\swarmdraft-bot\pair.ps1 -Mode request -Name "Grok Bot"
   ```

   Tell the author to watch for the in-app prompt and click **Allow**.

5. Poll for the key (saves to `%USERPROFILE%\swarmdraft-bot\key.txt`, never prints it):

   ```
   powershell -ExecutionPolicy Bypass -File $env:USERPROFILE\swarmdraft-bot\pair.ps1 -Mode poll
   ```

6. Test the connection:

   ```
   powershell -ExecutionPolicy Bypass -File $env:USERPROFILE\swarmdraft-bot\mcp.ps1
   ```

   It should list the tools. In **Settings → Agents**, the bot should show as MCP connected.
   Revoke anytime from that list.

`request_pairing` arguments: `{ name, color?, scopes? }`. `poll_pairing` arguments:
`{ pairing_id, pairing_secret }`. Prefer `result.structuredContent` when present; otherwise parse
the SSE `data:` line.

## Making calls

Write a JSON-RPC body to a `.json` file on their PC, then run:

```
powershell -ExecutionPolicy Bypass -File $env:USERPROFILE\swarmdraft-bot\mcp.ps1 -Body <file.json>
```

Body shape:
`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"<tool>","arguments":{...}}}`

Tools include: `list_documents`, `list_chapters`, `read_chapter`, `search_text`, `suggest_edit`,
`suggest_style`, `add_comment`, `list_suggestions`, `trigger_export`, `get_export`. Run
`tools/list` first for the exact argument names.

- Read before you suggest. Quote the exact text you're changing.
- One suggestion at a time per passage. Overlapping a pending suggestion is rejected, so pick
  another passage or wait.
- Your suggestions appear live in their book under your name. They decide in **Review changes**.

## Rules

- Suggest only. Never accept or reject anything yourself.
- Never print, read aloud, or echo the key. If it is exposed, ask the author to revoke the agent in
  **Settings → Agents** and pair again.
- Ask before any export.
- If the server doesn't answer, ask the author to open swarmDraft.

## Helper script: pair.ps1

```powershell
param([string]$Mode="request",[string]$Name="Grok Bot",[string]$Dir="$env:USERPROFILE\swarmdraft-bot")
if (-not (Test-Path $Dir)) { New-Item -ItemType Directory -Path $Dir | Out-Null }
$h = @{ Accept = 'application/json, text/event-stream' }
function C($b) {
  $r = (Invoke-WebRequest -UseBasicParsing -Uri http://127.0.0.1:7337/mcp -Method Post -Headers $h -ContentType 'application/json' -Body $b).Content
  $line = ($r -split "`n" | Where-Object { $_ -like 'data:*' } | Select-Object -Last 1)
  if ($line) { $r = $line.Substring(5) }
  $r | ConvertFrom-Json
}
C '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"swarmdraft-bot","version":"1"}}}' | Out-Null
$pf = Join-Path $Dir "pairing.json"
if ($Mode -eq "request") {
  $body = @{jsonrpc="2.0";id=2;method="tools/call";params=@{name="request_pairing";arguments=@{name=$Name;color="#7c5cff"}}} | ConvertTo-Json -Depth 6 -Compress
  $res = C $body
  $txt = if ($res.result.structuredContent) { $res.result.structuredContent | ConvertTo-Json -Compress } else { $res.result.content[0].text }
  if (-not $txt) { "ERROR: " + ($res | ConvertTo-Json -Depth 6 -Compress); exit 1 }
  $txt | Set-Content $pf
  "Requested pairing for '$Name' (id " + (($txt | ConvertFrom-Json).pairingId) + "). Secret saved, not shown."
} else {
  $p = Get-Content $pf -Raw | ConvertFrom-Json
  $body = @{jsonrpc="2.0";id=3;method="tools/call";params=@{name="poll_pairing";arguments=@{pairing_id=$p.pairingId;pairing_secret=$p.pairingSecret}}} | ConvertTo-Json -Depth 6 -Compress
  $res = C $body
  $txt = if ($res.result.structuredContent) { $res.result.structuredContent | ConvertTo-Json -Compress } else { $res.result.content[0].text }
  if (-not $txt) { "ERROR: " + (($res | ConvertTo-Json -Depth 6 -Compress) -replace '"(token|key)":"[^"]+"','"$1":"***"'); exit 1 }
  $o = $txt | ConvertFrom-Json
  $tok = $o.token; if (-not $tok) { $tok = $o.key }
  if ($tok) {
    $tok | Set-Content (Join-Path $Dir "key.txt")
    "Status: " + $o.status + ". Key saved to key.txt (not shown)."
  } else {
    "Status: " + $o.status
  }
}
```

## Helper script: mcp.ps1

```powershell
param([string]$Body,[string]$Tok="$env:USERPROFILE\swarmdraft-bot\key.txt")
$t = (Get-Content $Tok -Raw).Trim()
$h = @{ Authorization = "Bearer $t"; Accept = 'application/json, text/event-stream' }
function C($b) {
  $r = (Invoke-WebRequest -UseBasicParsing -Uri http://127.0.0.1:7337/mcp -Method Post -Headers $h -ContentType 'application/json' -Body $b).Content
  $line = ($r -split "`n" | Where-Object { $_ -like 'data:*' } | Select-Object -Last 1)
  if ($line) { $r = $line.Substring(5) }
  $r
}
C '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"swarmdraft-bot","version":"1"}}}' | Out-Null
if ($Body) { C (Get-Content $Body -Raw) } else { C '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' }
```
