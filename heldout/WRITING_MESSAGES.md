# Writing a blind set of chat messages

You are writing test messages for a team chat in which an assistant may offer, under a
message, to **book a meeting** or to **add a task**. You have not seen how the assistant
works and must not look: write from this page only, the way real people on this team
would write.

## The team

| id    | Name          | Lives in      | Time zone          |
|-------|---------------|---------------|--------------------|
| lena  | Lena Hoffmann | Berlin        | Europe/Berlin      |
| arif  | Arif Rahman   | Kuala Lumpur  | Asia/Kuala_Lumpur  |
| maya  | Maya Okafor   | New York      | America/New_York   |
| jonas | Jonas Weber   | Berlin        | Europe/Berlin      |

Conversations (the `channel` field):

- `launch`: all four people, about a product launch on Friday.
- `design`: lena and maya.
- `arif-lena`: a direct conversation between arif and lena.

People write in **English or German** (Lena and Jonas sometimes in German), casually, with
typos now and then, the way people chat at work.

## When the assistant should offer something

**A meeting** (`"kind": "meeting"`): the writer proposes or asks to meet, call, sync or talk
at some point in the future, e.g. "can we hop on a call Thursday after 3?", "lass uns morgen
früh kurz telefonieren". Times are in the writer's own time zone.

**A task** (`"kind": "task"`): the writer asks a specific person to do something
("@arif can you send the contract by Friday?"), or commits to doing something themselves
("I'll update the budget sheet today"). In a direct conversation the other person is the
one asked, even without an @mention. In a group without an @mention, a request to "someone"
or "you" is **not** a task (it is unclear who is asked).

**Nothing** (`"kind": "none"`): everything else. In particular:
- talk about meetings in the past ("the call yesterday went well"),
- cancelling or moving meetings ("let's cancel Friday's sync"),
- questions about a meeting that already exists ("when is the standup?", "wo ist der Link?"),
- greetings, thanks, opinions, status updates, jokes,
- vague wishes with no request ("we should talk more sometime" is a judgment call: decide and be consistent).

## What to write

Write **60 messages** to `heldout/messages-1/messages.json`:

- roughly 25 meetings, 15 tasks and 20 nothing;
- about a third in German;
- vary how dates and times are written: weekdays, "tomorrow", "next week", "end of the week",
  dates like "12.11." or "Nov 12", times like "3pm", "15:00", "15 Uhr", "after 2", "before
  noon", "in the morning", "nachmittags", durations like "30 min" or "an hour";
- include some that are hard: a past meeting mentioned next to a new request, a German
  "Guten Morgen" (a greeting, not "tomorrow"), a question about an existing meeting, a request
  in a group with no @mention.

The **current time** for every message is Wednesday 4 November 2026, 10:00 in Berlin
(`2026-11-04T09:00:00Z`).

For each message give what you, as a person, expect the assistant to offer. Only fill the
fields you are sure of; leave the others out.

```json
{
  "now": "2026-11-04T09:00:00Z",
  "messages": [
    {
      "id": "m01",
      "channel": "design",
      "author": "lena",
      "text": "Can we do a quick call tomorrow after 3pm?",
      "expect": { "kind": "meeting", "day": "2026-11-05", "after": "15:00", "durationMin": 15 }
    },
    {
      "id": "m02",
      "channel": "launch",
      "author": "maya",
      "text": "@arif can you send the venue contract by Friday?",
      "expect": { "kind": "task", "assignee": "arif", "due": "2026-11-06" }
    },
    { "id": "m03", "channel": "launch", "author": "jonas", "text": "Great work everyone!", "expect": { "kind": "none" } }
  ]
}
```

Fields in `expect`:
- `kind`: `meeting`, `task` or `none` (required).
- `day`: for a meeting, the first day it could happen, as a date in the writer's time zone.
- `after`: for a meeting, the earliest local start time the writer named ("after 3pm" →
  `15:00`; "at 10" → `10:00`; "in the morning" → leave out).
- `durationMin`: only if the writer said how long.
- `assignee`: for a task, the person id who should do it.
- `due`: for a task, the due date if one was named.

Do not reuse the examples above. Write the file and nothing else.
