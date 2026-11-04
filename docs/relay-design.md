# Relay design — cloud bots without hand-managed keys (#195)

**Status:** Deferred post-pilot (local key pairing stays supported)  
**Owner:** Brett Humphreys  
**Related:** [#195](https://github.com/southline-tech/swarmDraft/issues/195), local pairing (#188), loopback MCP (#187)

## 1. Problem

Today the in-app MCP server listens on `127.0.0.1` only. Cloud-hosted bots cannot reach it unless the author runs approved commands on their PC and saves a bearer token to disk ([#187](https://github.com/southline-tech/swarmDraft/issues/187) / [#188](https://github.com/southline-tech/swarmDraft/issues/188)). That works but violates the product goal: **pair like a normal MCP connector, store the key in the connector, never expose it to a person or chat.**

## 2. Goals and non-goals

**Goals**

- Author’s desktop app maintains an **outbound** connection to a relay; **nothing listens on the author’s LAN** for bots.
- Bot platform adds swarmDraft as an MCP connector at a stable HTTPS URL (`/mcp/<connector-id>`).
- Author approves new bots with the existing **PairingPrompt** Allow/Deny flow; issued tokens stay on the connector side.
- **Revoke** in Settings → Agents cuts the bot off promptly on the relay path.
- **Suggest-only** rules, attribution, and overlap behavior are unchanged from loopback MCP.
- When the app is closed, bots get an explicit **`swarmdraft_offline`** error (not a generic timeout).

**Non-goals (this design)**

- Multi-tenant SaaS billing or org admin (see `docs/mvp-spec.md`).
- Offline-first desktop or relaying while the app is quit.
- Replacing local loopback MCP for same-PC bots (loopback remains supported).

## 3. Architecture

```
┌─────────────────────┐         wss (outbound)          ┌──────────────────┐
│  swarmDraft (Tauri) │ ───────────────────────────────►│  Relay service   │
│  Rust MCP + relay   │◄───────────────────────────────│  (hosted)        │
│  client             │    multiplexed MCP frames       └────────┬─────────┘
└─────────────────────┘                                          │
       ▲                                                           │ https
       │ local Yjs / SQLite                                        ▼
       │                                                    ┌──────────────────┐
       │                                                    │  Bot host MCP    │
       │                                                    │  GET/POST        │
       │                                                    │  /mcp/{id}       │
       └──────── suggest marks, comments (unchanged)         └──────────────────┘
```

**Roles**

| Party             | Responsibility                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Desktop app**   | Opens authenticated WebSocket to relay; registers `manuscript_session_id` (or account stub pre-SaaS); forwards MCP JSON-RPC only after crypto session is ready; applies pairing decisions locally; pushes revoke events. |
| **Relay**         | Routes frames between one active app session and one or more bot connector sessions; enforces auth, rate limits, and revocation; **must not depend on reading manuscript text** once E2E is enabled (see §6).            |
| **Bot connector** | OAuth/OIDC client of the bot platform; holds swarmDraft bearer token after pairing; speaks Streamable HTTP MCP toward relay URL.                                                                                         |

**Connector id**

- Stable public id for the swarmDraft MCP offering (e.g. `swarmdraft` or environment-specific slug).
- Bot-facing MCP base: `https://<relay-host>/mcp/<connector-id>` (Streamable HTTP, same semantics as local `/mcp`).

**App WebSocket**

- Direction: **app → relay** (outbound dial from the author’s machine).
- Auth: short-lived **relay session JWT** obtained after desktop sign-in / device registration (exact issuer TBD when relay work resumes).
- Multiplexing: each MCP request/response is a **relay frame**: `{ v, kind, id, manuscriptId?, payload }` (shared protocol package planned in a later phase).
- Heartbeats and idle timeout detect offline app; relay responds to bots with `swarmdraft_offline`.

## 4. Pairing: OAuth 2.0 + PKCE + PairingPrompt

Cloud bots do **not** call loopback `request_pairing` directly. Instead:

1. **Discovery** — Connector metadata advertises authorization and token endpoints (or platform-internal equivalent) and the MCP URL above.
2. **Authorization (PKCE)** — Bot initiates OAuth with `code_challenge` (S256). Author is sent to a browser step on the bot platform or a swarmDraft-branded page that ultimately requires **the desktop app to be online**.
3. **Relay pairing ticket** — Relay creates a `pairing_id` + one-time secret and notifies the app over the open WebSocket (`pairing_requested` frame). UI shows the existing **PairingPrompt** (name, color, scopes) — same mental model as #188.
4. **Allow / Deny** — On Allow, the app mints the agent bearer token locally (same storage as today) and sends **`pairing_resolved`** to the relay with `status: approved` and a **hashed token reference** or encrypted token envelope for the connector (see §6). On Deny, the app sends **`pairing_resolved`** with `status: denied`. If the ticket expires before a decision, the relay emits **`pairing_resolved`** with `status: expired` (or the app acks expiry the same way). The relay completes OAuth with `access_denied` when pairing is denied or expired.
5. **Token delivery** — Connector receives OAuth tokens **plus** swarmDraft agent credential through the platform’s secure store — **never** in author chat, logs, or relay plaintext logs.

Loopback pairing (`request_pairing` / `poll_pairing`) remains for local scripts and migration; relay pairing is the path for hosted bots when this work resumes.

## 5. Revoke

- Author revokes in **Settings → Agents** (same as #188).
- App marks agent revoked in SQLite, invalidates token hash, and sends **`revoke_agent`** frame on the WebSocket with `agent_id`.
- Relay drops active bot sessions bound to that agent and rejects new MCP calls with `401` / MCP error body.
- Target: **≤ few seconds** cut-off under normal conditions; bots must not receive successful tool results after revoke ack from app.

## 6. Crypto handshake and threat model

### 6.1 Honest baseline: hosted MCP without E2E

If the bot host terminates TLS and forwards JSON-RPC to the relay in **plaintext inside the provider’s trust zone**, then:

- The **bot platform operator** can read manuscript content in tool arguments and results (`read_chapter`, `suggest_edit`, etc.).
- The **relay operator** can read the same unless frames are encrypted end-to-end.
- TLS protects against third parties on the wire, **not** against the host or relay.

This matches how most **hosted MCP connectors** work today: the platform speaks **plain Streamable HTTP** JSON-RPC on the connector side. **Issue #195 AC “relay can’t read manuscript content” requires E2E**, which in turn requires swarmDraft to **decrypt at a connector endpoint the relay never sees in plaintext** — not merely TLS to the router (see §6.2).

### 6.2 Target E2E session (authenticated handshake)

After WebSocket auth and when a bot session attaches:

1. **Bot connector** derives an ephemeral X25519 keypair **locally** in the connector Worker/process (keys never generated on the relay).
2. **App** generates its own ephemeral X25519 keypair and **signs the app ephemeral public key** with the author’s long-lived **Ed25519 device identity** (same trust root as local pairing).
3. **Pinning at Allow** — When the author taps Allow on PairingPrompt, the app records the connector’s long-lived or attested public key (or platform connector attestation) so later handshakes reject impersonation.
4. **Connector auth** — The connector presents the **pairing credential** (OAuth-delivered swarmDraft agent secret or envelope from step 4 in §4) when opening its session; the relay checks routing and revocation only, not manuscript access.
5. **Handshake frames** — App sends `handshake_init` (signed app ephemeral pubkey, `pairing_id`, binding). Connector responds with `handshake_finish` (bot ephemeral pubkey). Both run HKDF-SHA256 over the X25519 shared secret with `salt = pairing_id || manuscript_id`.
6. **Payloads** — MCP JSON-RPC in relay frames uses AEAD (e.g. ChaCha20-Poly1305) with monotonic nonces per direction.

**Relay visibility:** routing metadata, public keys, and **ciphertext only** — not agent bearer tokens, not JSON-RPC bodies.

**Deployment split for E2E:** A **router** Durable Object (or equivalent) multiplexes WebSocket sessions but must not hold connector pairing secrets. A separate **connector Worker** (distinct code, distinct `wrangler.toml` secrets) terminates bot Streamable HTTP, holds pairing credentials, and performs local ECDH. The relay/router never receives the agent bearer token in a form it can use for MCP calls.

**App visibility:** plaintext after decrypt — same as local MCP.

**Bot visibility:** plaintext in connector process — same trust as today’s “bot reads chapter” but **not** visible to relay staff or centralized payload logs.

### 6.3 Threat summary

| Threat                       | Mitigation                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------- |
| LAN exposure                 | Outbound-only app connection; no inbound port on author PC.                      |
| Stolen relay JWT             | Short TTL, rotate on reconnect, bind to device id.                               |
| Stolen agent bearer token    | Revoke; hash-at-rest unchanged.                                                  |
| Relay compromise without E2E | Full manuscript exposure in payloads — **unacceptable for GA** per #195.         |
| Relay compromise with E2E    | Metadata (timing, sizes, agent ids) still visible; content confidential.         |
| Malicious bot                | Scopes unchanged (`read` / `comment` / `suggest`); suggest-only enforced in app. |

Shared message shapes and version constants will live in a future **`@swarmdraft/relay` protocol package** (app, relay service, connector tests) — not in this doc-only phase.

## 7. Offline: `swarmdraft_offline`

When the app WebSocket is down or the author quit swarmDraft:

- Bot MCP calls fail fast with a structured error (JSON-RPC error or MCP tool error envelope):
  - **Code / name:** `swarmdraft_offline`
  - **Message:** Human-readable: swarmDraft is not running on the author’s machine; try again when the app is open.
- Relay must **not** queue manuscript-changing tool calls for later delivery (avoid stale suggestions).

## 8. Implementation phases

| Phase           | Deliverable                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------- |
| **A (this PR)** | This design doc only — relay implementation deferred post-pilot; local pairing unchanged.    |
| **B**           | `@swarmdraft/relay` protocol package + unit tests; frame and handshake types from §4–§7.     |
| **C**           | Rust relay client in Tauri; WebSocket + frame codec; PairingPrompt bridge for relay tickets. |
| **D**           | Hosted relay on Cloudflare Workers + Durable Objects (see §9); auth; routing; metrics.       |
| **E**           | Bot connector registration; OAuth + PKCE; E2E handshake; QA on Arm-A-Rillo (#195).           |
| **F**           | Settings → Agents UI for relay status (Designer pass on connected dot / copy).               |

## 9. Hosting and decisions when relay resumes

**Hosting (planned):** Cloudflare **Workers** for HTTP/MCP edge and a **Durable Object** per active author session for WebSocket multiplexing. **`wrangler.toml` must not commit secrets** — pairing and connector credentials only via CF secrets / environment at deploy time. When implementation resumes, follow the authenticated handshake in §6.2 and the connector/router split so the router DO never holds bot pairing material.

**E2E vs TLS-only:** **E2E is the GA target** per #195. **TLS-terminated relay with no payload logging** may be used **only for internal QA**, never as the author-facing build, unless decision (a) below explicitly accepts weaker AC.

**Future decisions (owner: Brett) when relay work resumes:**

1. **(a) First author build** — Ship TLS-terminated relay (relay could read content) vs hold until E2E meets #195 AC “relay can’t read manuscript content.”
2. **(b) Cloudflare spend** — Paid tier / Durable Object usage envelope and approval before production traffic.

Until those are decided, **no relay deploy** and **no `@swarmdraft/relay` package** in the pilot codebase.

## 10. Acceptance criteria mapping (#195)

| AC                                                | Design hook                                                     |
| ------------------------------------------------- | --------------------------------------------------------------- |
| Fresh hosted bot pairs with zero manual key steps | §4 OAuth + PKCE + PairingPrompt; token in connector store only. |
| Revoke cuts bot immediately                       | §5 `revoke_agent` frame + session drop.                         |
| Relay can’t read manuscript content               | §6.2 E2E + connector Worker split (decision 9a).                |
| QA on Arm-A-Rillo before user build               | Phase E; deferred with relay implementation.                    |

## 11. References

- Local MCP: `apps/desktop/src-tauri/src/mcp/`, `docs/bot-setup-prompt.md`
- Pairing UI: `apps/desktop/src/PairingPrompt.vue`
