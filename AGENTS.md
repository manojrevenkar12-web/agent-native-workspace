# Working in this repository

## Fast feedback

| What                                   | Command                                                                 | Time    |
| -------------------------------------- | ----------------------------------------------------------------------- | ------- |
| Lint and format                        | `npx biome check .`                                                     | 1 s     |
| Types (TypeScript 7)                   | `npm run typecheck`                                                     | 3 s     |
| Unit, property and chaos tests         | `npx vitest run`                                                        | ~1 min  |
| One package                            | `npx vitest run --project sheets` (or `sync`, `agent`, `server`, `web`) | seconds |
| End to end, accessibility, performance | `npm -w @anw/web run build && npm run e2e`                              | ~2 min  |
| Run it                                 | `npm run dev` then open http://localhost:3417                           |         |

The end-to-end suite starts its own server on a fresh database; stop `npm run dev` first (both use ports
3417 and 4417).

## Layout

```
packages/sheets   formula parser, evaluator, incremental recalculation, Yjs binding (no React)
packages/sync     wire protocol (zod), the client connection, rooms, the chat channel, workspace config
packages/agent    suggestions in documents and sheets, intent reading, the scheduler, model adapters
apps/server       Node: HTTP (Hono) and one WebSocket per client; SQLite (node:sqlite) for everything durable
apps/web          Next.js 16 app, feature folders: features/{chat,docs,notes,calendar,sheets,shell}
config/           every setting: people and rooms, sync, agent, scheduling, performance budgets
heldout/          blind message sets for the assistant's intent reading
```

## Invariants (each has a test)

- **The server orders chat.** Only the server assigns `seq`; a send is keyed by (channel, author,
  clientMsgId), so a retried send returns the existing message. `apps/server/test/sync.test.ts` (chaos).
- **Write before broadcast.** A document update is in SQLite before any client sees it; a restart loses
  nothing anyone has seen. `restores documents after a restart`.
- **Viewers never write.** The server drops sync updates from viewers before applying them; the client
  does not send them. `syncs two editors, and a viewer sees edits but cannot make them`.
- **Access is decided before a room is loaded.** Unknown or forbidden rooms are denied without being
  created. `denies rooms a person has no access to`.
- **The assistant only suggests.** Text it writes carries the `suggestion` mark; blocks it creates carry
  the `suggestion` attribute; sheet cells it fills are pending. A person accepts or rejects. It fills
  only empty cells. `packages/agent/test/suggestions.test.ts`, `filling a sheet`.
- **People's text never carries the assistant's mark**, even typed or pasted inside the assistant's
  sentence, so rejecting can never delete a person's words. `apps/web/test/editor.test.ts`. The mark must
  not be declared overlapping (`excludes: ""`): the Yjs binding would store it under a hashed key and the
  server would stop recognising it.
- **Human edits win.** If a person deletes or accepts text the assistant is still writing, it yields.
- **Models write, code decides.** Who is asked, when a meeting can be, who may book it and what is
  written where are decided by code; the model only produces text.
- **Snapshots handed to React are never mutated** (the React Compiler compares by identity). Components
  that render mutable engine state (`Grid`, `Row`) opt out with `"use no memo"` and re-render on `rev`.
- **Settings live in `config/`**, not in code; performance budgets in `config/perf.json`.
- **No default secret.** The server refuses to start without `ANW_SECRET` unless `ANW_DEV=1`, which also
  enables `/auth/dev` for the demo people.

## The held-out rule

`heldout/<set>/messages.json` is written blind from `heldout/WRITING_MESSAGES.md` by someone who has not
seen the code. Run a set once with `npm run heldout -- <set>`; its first run in
`reports/heldout/<set>/first_run.json` is never rewritten (CI checks). Never change the intent reader to
pass a held-out set. If you study a set's failures, write `regression` to `heldout/<set>/STATUS` and have
someone who has not seen the code write a new set from the guide only.

## Lint exceptions

`biome.json` turns off two a11y rules for `features/sheets/Grid.tsx` only: a virtualised ARIA grid with
`aria-activedescendant` is the pattern the WAI-ARIA practices recommend, and a `<table>` cannot be
virtualised in both directions. Specificity ordering in CSS modules is intentional.
