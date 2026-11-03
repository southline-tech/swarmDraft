# Editor bot templates

Files in `docs/bot-templates/` are ready-made briefs for Grok Bot editor roles in swarmDraft. Each file is the system prompt body for one bot: what the role covers, how to work through the app MCP server, and how to pair once.

Full connection scripts, tool names, and manuscript rules live in [bot-setup-prompt.md](../bot-setup-prompt.md). Server-side workflow guidance is tracked in [#233](https://github.com/southline-tech/swarmDraft/issues/233).

## Templates

| Role                   | File                                           | Use when                                                  |
| ---------------------- | ---------------------------------------------- | --------------------------------------------------------- |
| Line editor            | [line.md](./line.md)                           | Sentence-level clarity, grammar, rhythm, word choice      |
| Continuity editor      | [continuity.md](./continuity.md)               | Timeline, facts, names, geography, series consistency     |
| Developmental editor   | [developmental.md](./developmental.md)         | Structure, pacing, arcs, scene purpose, big-picture notes |
| Dialogue editor        | [dialogue.md](./dialogue.md)                   | Voice, subtext, tags, readability of spoken lines         |
| Drafter                | [drafter.md](./drafter.md)                     | New scenes and passages the author asked to draft         |
| Lead / PM orchestrator | [lead-orchestrator.md](./lead-orchestrator.md) | Priorities, scope, which editor to use, batching work     |

## Create a public Grok Bot template

1. Open Grok Bot settings and choose **Create bot** (or duplicate an existing editor bot).
2. Set a clear **name** and **description** that match the role (for example “swarmDraft — Line editor”).
3. Copy the entire contents of the matching file in this folder into the bot **instructions** field.
4. Set visibility to **Public** if the author should share the template link with others; otherwise keep it private on their account.
5. Save. The author opens the bot, completes pairing once (see each template’s **Pairing** section and [bot-setup-prompt.md](../bot-setup-prompt.md)), then assigns work in plain language (“line-edit chapter 3”).

To run several editors at once, create one bot per role and give each its own pairing folder and key on the author’s PC (see **Pairing** in each template).

## Pairing note ([#195](https://github.com/southline-tech/swarmDraft/issues/195))

These templates use today’s flow: `request_pairing`, the author clicks **Allow** in swarmDraft, then the bot stores the key locally and never prints it. When keyless relay ([#195](https://github.com/southline-tech/swarmDraft/issues/195)) ships, the **Pairing** steps here will shorten; the **Role** and **Workflow** sections stay the same.
