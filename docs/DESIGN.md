# Command Center: Project Plan

A personal, local-first desktop app that pulls email, calendar and coursework into one minimal "Today" screen, classifies mail automatically, and lets me search and act on everything from a command palette. Built for one user (me).

## 1. Goals

- One screen that answers "what needs my attention right now?"
- Unified inbox across Outlook and multiple Gmail accounts.
- Calendar that syncs with my iPhone.
- Every email auto-classified for priority and category (Jev), with LLM help only where text generation is needed.
- Keyboard-first (Ctrl+K), fast, and feels personal.
- My data stays on my machine except for the API calls required to classify and draft.

Non-goals: multi-user support, a mobile app, public release, Google/Microsoft app-store verification.

## 2. Decisions already made

| Topic | Decision |
|---|---|
| Platform | Desktop app on Windows 11 |
| Stack | Electron + React + TypeScript + Vite (electron-vite), SQLite for storage via Electron's built-in `node:sqlite` (no native module to rebuild) |
| Email | Gmail API (multiple accounts) and Microsoft Graph (Outlook) |
| School | Canvas LMS, read-only, through a user access token the student makes in Canvas. No developer key to beg an admin for, and no OAuth client. See section 11. |
| Calendar | Outlook (personal) is the hub and main account. Gmail calendars are subscribed into Outlook.com by iCal link; the iPhone adds the Outlook and Google accounts directly. |
| Classification | Hosted TypeSafe Jev (`jev-latest`, $0.042/Mtok input) chosen 2026-10-01; local OpenJev remains a possible later swap behind the same interface. No rules-based fallback. See section 5. |
| GPU budget | Local classifier model must use at most 7 GB VRAM (RTX 5070 has 12 GB; leave headroom for everything else) |
| Model lifecycle | Load the classifier once at app startup and keep it resident; never reload per email. See section 5. |
| Generation | The user picks the provider: Claude, ChatGPT, Gemini, Groq, or OpenRouter as a gateway to all of them, each connected with its own API key and model. Groq was the only option at first (chosen 2026-10-01 for cost and speed); the picker replaced that. See section 13. |
| Look | Dark, minimal, bento grid, hairline borders, one accent color |
| Accent color | Muted indigo by default. Six palettes plus a custom base-and-accent, chosen in Settings. See section 14. |
| Users | Just me |

## 3. Architecture

```
Gmail (x N) / Outlook / Google Calendar
            |  OAuth (loopback) + push/delta sync
            v
     Sync layer (main process)  --->  SQLite (local)
            |                              |
            v                              v
  Classifier (Jev)  ------------->  Today view / triage / search
            |
            v
  Claude (summaries, drafts) only for flagged mail
```

- **Main process (Node):** OAuth flows, sync workers, SQLite, secrets, scheduled jobs.
- **Renderer (React):** UI only. Talks to main through a typed IPC bridge (preload).
- **Adapter interface per source:** `connect()`, `sync()`, `search()`, `actions`. Adding a source never touches core code.
- **Classifier interface:** `classify(email) -> {priority, category, needsReply, confidence}`. Jev is one implementation; a local fallback can be swapped in.
- **Secrets:** refresh tokens and API keys encrypted with Electron `safeStorage` (Windows DPAPI) in the app data folder, never in the DB or in git. (Chosen over the deprecated `keytar`.)

## 4. Data model (SQLite)

- `accounts` (id, provider, address, status, last_sync)
- `emails` (id, account_id, thread_id, from, subject, snippet, received_at, labels, is_read, body_ref)
- `classifications` (email_id, priority, category, needs_reply, confidence, model, created_at, user_override)
- `events` (id, calendar_id, title, start, end, attendees, location, link)
- `tasks` (id, title, due, source_email_id, status)
- `assignments` (id, account_id, course_name, course_code, title, kind, due, points_possible, url, submitted, graded, missing, done_at, synced_at) for Canvas work
- `settings` (key, value), `modes` (name, layout_json)
- `audit_log` (ts, actor, action, target), recording everything the app or AI did

## 5. Jev classification design

### Backends (swappable behind one interface)

1. **Local OpenJev (default).** Private, free, no email content leaves the machine for classification.
2. **Hosted TypeSafe Jev (optional).** OpenJev exposes the same wire API (`/v1/systemone`), so switching should be mostly a base-URL change.

There is no rules-based fallback. If the local model isn't running, classification is paused and emails stay marked "unclassified" until it is available.

### Model constraints

- **Max VRAM: 7 GB** for the model plus its context. Prefer quantized (Q4/Q8 GGUF) builds.
- **Speed matters more than size.** Candidates, smallest first (verify each before committing; these come from community write-ups, not tested by me):
  - **jevos** (MIT, ~1B, GGUF q4_k_m, ~619 MB). Reported ~54 to 220 ms on a laptop CPU through llama.cpp, so it would be near-instant on the RTX 5070. Caveat: reported to answer yes/no (probability) questions only, so "choice" categories would need to be asked as several yes/no questions.
  - **MiniCPM5 2B** (~1.6 GB), the default model in one OpenJev build.
  - **APUS-OpenJev 4B GGUF** (Q4/Q8, roughly 3 to 5 GB). Runs on Windows through llama.cpp, Ollama, or LM Studio. Best accuracy that still fits the 7 GB budget.
  - Avoid: the 26B DiffusionGemma build (too large) and 9B models at high precision (too close to the VRAM limit).
- A 4B model is reported at about 90% accuracy versus about 66% for 0.6B on one project's test, so very small models cost accuracy. Plan: benchmark jevos (1B) against the 4B on ~200 of my own labeled emails and choose the smallest model that is accurate enough.
- Windows support is not guaranteed by every repo (several document Linux/macOS only). Prefer the llama.cpp/GGUF route, which runs natively on Windows; fall back to WSL only if needed.

### Lifecycle (runs once, doesn't hog VRAM)

- The model server starts **once at app startup** as a child process of the main process and stays resident while the app runs. It is not respawned per email, and it is stopped when the app quits.
- Emails are classified in **batches** (a queue drained in one pass, for example on startup catch-up and after each sync) so the GPU is busy briefly and then idle.
- Hard cap on VRAM: set the context length small (emails are truncated to ~500 characters), GPU layers explicit, and a single model instance only.
- Settings toggle to disable local classification entirely, plus a "classification paused" indicator in the UI.
- Optional: if the app has been idle for a long time (for example 30 minutes), unload the model and lazily reload on next activity. Off by default.

### What gets classified

Per incoming email, send only sender, subject, and the first ~500 characters of the body.

- **Priority (choice):** urgent / needs reply / FYI / newsletter / junk
- **Category (choice):** bills, work, school, personal, shopping, security alert, other
- **Needs response (probability):** yes/no
- **Importance (score):** 1 to 10

Handling:
- High confidence: auto-file. Low confidence: goes to a "review" pile.
- My corrections are stored as `user_override`. They are used as examples to evaluate (and possibly fine-tune or few-shot) the model, and an override always wins over the model's answer for that email.
- Before relying on it, verify: accuracy on a sample of my own mail, and the license and Windows support of the chosen local build. If I ever enable hosted Jev, also check TypeSafe's pricing, free tier, and data-retention policy, and use their official endpoint (`api.typesafe.ai`), not third-party mirror sites.

## 6. Features by phase

**Phase 0: Foundation** (done 2026-10-01, in `app/`)
- Electron + React + TS app, dark theme tokens, app shell, typed IPC, SQLite.
- Today view with placeholder data in the bento layout.

**Phase 1: Read-only Google** (done 2026-10-01: OAuth loopback + PKCE, Gmail delta sync via history ids, primary calendar sync, Inbox search with FTS5, Calendar agenda, Accounts settings)
- Google OAuth (testing mode, my own account), Gmail and Calendar sync.
- Today view shows real next events and recent mail. Search across mail.

**Phase 2: Command palette and more accounts** (palette done 2026-10-01: Ctrl+K commands, live mail and event search. Installer + Start menu/desktop shortcuts + open at login also done.)
- Ctrl+K: search, jump, quick actions.
- Add more Gmail accounts, then Outlook via Microsoft Graph (check whether it's a personal or work/school account, since work accounts may need admin consent).

**Phase 3: Classification**
- Benchmark candidate local models (jevos 1B vs a 4B GGUF) on ~200 of my own labeled emails; pick the smallest that is accurate enough and stays under 7 GB VRAM.
- Run the model once at startup as a managed child process; batch-classify through a queue.
- Priority badges, triage queue, review pile, corrections.
- Hosted Jev as an optional second backend.

**Phase 4: Assistant**
- Claude summaries and draft replies (approve before send), meeting prep briefs, task extraction from emails.

**Phase 5: Personalization**
- Modes (Work, Focus, Weekend) with saved layouts, drag-and-drop tiles, accent and background settings, morning brief and end-of-day review, learned sender importance.

**Phase 6: Extras (as wanted)**
- GitHub PRs/issues, weather and commute, RSS, finance snapshot (read-only), Spotify, system tray and notifications.
- School: Canvas assignments due today/this week/this month, and a brief that can be written as concrete steps and asked follow-up questions (sections 11 and 12).
- A choice of AI provider (Claude, ChatGPT, Gemini, Groq) and a choice of theme (sections 13 and 14).

## 7. Design direction (dark, minimal)

- Layered near-black surfaces (background, card, hover), 1px hairline borders, no heavy shadows or gradients.
- 6 to 10px card radius; bento grid with key info top left.
- One accent color, used only for urgency and Jev priority signals.
- Type: Inter or Geist for UI, a mono font for numbers and timestamps.
- Motion: fast and subtle (150 to 200 ms), a morphing active-tab indicator, no heavy animation.
- Keyboard-first; every action reachable from the palette.
- References: Raycast, Superhuman, Linear; Dribbble shots by Kulak ("Personal Dashboard"), Won J. You ("Bento"), and Md Adham Hossain Efti ("Command OS").

## 8. Today view layout (v1)

```
+--------------------------+----------------+
| Greeting + date          | Next up        |
| Daily brief [Summary|Steps]  (next 3 events)|
| Ask a follow-up...       |                |
+------------+-------------+----------------+
| Priority   | Needs reply | Tasks / due    |
| inbox      | (Jev)       |                |
+------------+-------------+----------------+
| Assignments      [Today | Week | Month]   |
+--------------------------+----------------+
| Schedule (day timeline)  | Quick stats    |
+--------------------------+----------------+
```

## 9. Security and privacy

- Minimal OAuth scopes (read-only first; add send/modify only when drafting ships).
- AI never sends email on its own. It drafts, and I approve.
- Audit log of every AI action.
- Only truncated email content goes to Jev. Send whole bodies to Claude only for emails I've flagged.
- Tokens stored in the OS credential store; `.env` and credentials are gitignored.

## 10. Status

Mail and calendar sync, Jev classification, tasks and reminders, the assistant, rebindable
shortcuts, the Finance view, Canvas assignments, the two brief styles, the AI provider picker and
the themes are built. See the README for setup.

## 11. School: Canvas assignments

### Getting in

Canvas's OAuth needs a developer key issued by the school's Canvas admin, which a student can't get
for a personal app. Canvas also lets any user mint a **user access token** (Account → Settings → New
Access Token), which is all a read-only client needs. So Canvas is connected the way iCloud Mail is:
paste the school's Canvas address and a token once, verified against `/api/v1/users/self` before it
is stored, then encrypted with DPAPI like every other secret. The account id carries the host
(`canvas:school.instructure.com`), so there is no second place to keep the base URL, and one Canvas
account per host.

The token is only ever sent to that host: the address is parsed down to a bare host, forced to
https, and pagination only follows a `rel="next"` link that stays on the same origin.

### What is fetched

- **Primary: `/api/v1/planner/items`** over a window of 21 days back to 45 days ahead. The planner is
  Canvas's own "what's coming up" list, and it already carries the submission state (handed in,
  graded, missing) that decides how a row is drawn. Assignments, quizzes, graded discussions, graded
  pages, peer reviews and the student's own to-do notes are kept; announcements and calendar events
  are not work to hand in and are left out.
- **Fallback: `/api/v1/courses/:id/assignments`** per active course, for instances that don't serve
  the planner. A rejected *token* (401) is reported instead of being worked around, so the user is
  told to reconnect rather than seeing a silently empty tile.
- `/api/v1/courses` labels each row with its course name and code. It is best-effort: labels are
  cosmetic, so a Canvas that won't list courses still syncs through the planner.

Each sync upserts the window and then deletes rows inside it that this run didn't see, so work
deleted or rescheduled in Canvas disappears here too. Items older than the window age out.

### Timeframes

The tile answers "what is due" for a rolling **today / 7 days / 30 days**, chosen on the tile and
stored in `settings`, so it survives a restart and is also what the assistant means by "due soon".
Rolling windows beat calendar weeks here: on a Sunday evening "this week" would be empty, which is
the opposite of useful. Work due earlier today stays in the list all day; anything older that is
still not handed in moves to an "Past due" group that shows whatever the timeframe is.

Ticking an item off is local (`done_at`) and survives later syncs. Command Center never writes to
Canvas: submitting work in the real tool is deliberate, and a desktop app guessing at it would be
worse than useless.

## 12. Brief styles and follow-ups

The Today brief has two styles, chosen on the tile:

- **Summary** (default) is the sentence assembled in `queries.ts` from counts already in hand. It
  costs nothing, needs no API key, and is always right.
- **Steps** asks Groq to turn the same day snapshot into at most five concrete actions, most
  pressing first, each with a short reason. It is written once and cached in `settings` for the day
  (and at most a few hours, after which the day has moved on), so opening Today again doesn't spend
  tokens; "Refresh" rewrites it on demand. Without a Groq key the tile says so and falls back to the
  summary rather than going blank.

Under the brief is a one-line bar for follow-ups ("what should I do first?", "is anything due before
my 3:30?"). It streams through the same transport as the chat panel, tagged by request id, and
always includes the day snapshot, since that is what the user is looking at. It can create a task or
an event like the panel can, with the same undo card.

The snapshot itself lives in one place (`assistant/daySnapshot.ts`) and is shared by the chat panel
and the brief, so there is a single answer to "what does the assistant know about my day". It is
labelled untrusted data in both prompts: subjects, sender names and assignment titles are written by
other people, and the assistant only acts when the user asks.


## 13. Choosing the AI provider

### Why keys and not sign-in

The obvious ask is "sign in with my Claude / ChatGPT / Gemini account". That does not exist for this
kind of app. Consumer subscriptions (Claude Pro, ChatGPT Plus, Gemini Advanced) cover the chat
products, not programmatic use, and none of the three publishes an OAuth flow a third-party desktop
app can use to call the models. So every provider is connected the way the rest of the app connects
things it cannot OAuth into (TypeSafe, iCloud, Canvas): **Connect opens the provider's own sign-in
and API-keys page in the browser**, the user makes a key there and pastes it back. The key is
checked against the provider before it is stored, then encrypted with DPAPI. The Settings tile and
the README both say plainly that a subscription does not cover this, because the opposite
assumption would turn into a surprise bill later.

### One active provider, five connected

Keys are per provider and independent; `assistant_provider` in `settings` names the one in use.
Everything AI — Summarize, Draft reply, Make task, the Today brief and its follow-ups, and the
Finance scan — goes through that one choice, so there is never a question of which service saw
what. Switching is one click and takes effect on the next call. The first provider connected
becomes the active one, so a fresh install works after a single paste.

### Models come from the provider, not from this file

Hard-coding model names rots: models ship and retire faster than a personal app gets updated, and a
key may not have access to all of them anyway. So connecting a provider also asks it which models
the key can see (`GET /models`, which doubles as the key check), stores that list, and picks a
default by a per-provider preference order. The picker offers exactly what the key can reach, and
"Refresh models" re-asks. Models that can't hold a conversation (embeddings, speech, moderation)
are filtered out. A Groq key saved before the picker existed has no stored list, so each provider
also carries a fallback model to keep working until the list is refreshed.

### Two transports, five providers

Groq, OpenAI, Google and OpenRouter all serve the OpenAI chat-completions shape — Gemini through
its OpenAI-compatible endpoint — so one transport covers four, with the per-provider differences
(output-length field name, extra fields and headers, whether `temperature` is accepted) kept in
the provider spec. Anthropic's Messages API is different enough to have its own: the system prompt is a
top-level field, tool results come back as blocks inside a user turn, and the streaming events are
named differently. Both transports expose the same two calls, `completeJson` and `streamChat`, so
no caller branches on provider.

Three details that are easy to get wrong, handled in the Anthropic transport:

- **Current Claude models think before answering, and that thinking shares `max_tokens`.** The
  budget is widened accordingly, instead of a reply truncated mid-sentence. Effort is kept low for
  the extraction calls and medium for chat: these are short practical tasks, not research.
- **They reject `temperature`.** The spec leaves it unset for Anthropic and sets it for Groq.
- **An assistant turn has to be echoed back exactly**, thinking blocks and signatures included, or
  the next request in a tool loop is rejected. The stream keeps the raw blocks and the history
  carries them on a `raw` field that the other transport drops.

JSON schemas are normalized once for everyone: `type: ['string', 'null']` becomes an `anyOf`, which
all four accept.

### OpenRouter

OpenRouter is a gateway: one key reaches models from every lab, billed as credits on their account.
It needed no new machinery — it speaks the OpenAI shape, so it is one more entry in the provider
table, which is the point of having the table. Three things it did shake out:

- **Model ids carry the vendor** (`anthropic/claude-opus-4.1`), and the list it serves runs to
  hundreds. The stored list is now sorted by the provider's preference order *before* it is capped,
  so a gateway keeps the models worth offering instead of whatever the API happened to return
  first. The preference order puts the strong general models at the top of the picker.
- **Rates differ per model**, so OpenRouter's calls are counted and not priced, like OpenAI's and
  Gemini's. Its activity page shows exact spend and remaining credit, and the tile says so.
- **Attribution header.** Providers can want headers the others don't, so the spec grew an
  `extraHeaders` field; OpenRouter gets `X-Title: Command Center` so the app is identifiable in
  their dashboard.

### Cost

Finance's API-usage tile gained the three new providers. Anthropic's published per-million-token
rates are in the table; for OpenAI and Gemini the app has no rate it can state with confidence, so
those calls are **counted but not priced** — the tile shows the call and token counts, a dash
instead of a figure, and a line pointing at the provider's own billing page. A wrong number would
be worse than no number.

### What is not covered

None of this has been exercised against the live APIs — no keys to test with. The request shapes,
streaming parsers, tool-call round trip and error paths are covered by a test harness that stands
in for each API, but the first real call to each provider is still the first real call.

## 14. Themes

Six palettes — dark (the original), light, midnight blue, deep forest, light forest, ember — plus
"custom", which takes one of the two bases and an accent colour of the user's choosing.

- The palettes live in `styles/tokens.css` as `[data-theme='…']` blocks, one set of tokens each.
  Nothing in the UI names a colour, so adding a palette is a block of tokens and nothing else. The
  selectors are plain attribute selectors rather than `:root[…]`, which lets each card in the
  picker render a live swatch of itself instead of repeating the colours in JavaScript.
- A custom theme wears its base palette and overrides only the accent, through inline custom
  properties that beat the stylesheet. The hex is validated in the renderer and again in the main
  process, so nothing unchecked reaches a CSS property.
- The choice is stored in `settings` like everything else, and mirrored into `localStorage` so it
  can be applied synchronously before React mounts. The window itself is painted in the theme's
  background colour from the main process, so a light theme never flashes near-black on launch.
- The accent stays reserved for urgency and priority signals: unread bars, overdue dates, missing
  assignments, account errors. Email bodies keep their own white page, because that is what they
  were written for.

## 15. Shipping it

`npm run dev` is the development loop; it is not how the app is meant to be used day to day. The
electron-builder config produces two Windows artifacts from `npm run build:win`:

- **A one-click installer** (NSIS, `oneClick: true`, `perMachine: false`). Per-user, so no admin
  prompt; it creates a desktop shortcut and a Start menu entry and launches the app when it
  finishes. With "Open at login" in Settings → App, the app then starts with Windows and sits in
  the tray.
- **A portable exe.** One file, no install, no shortcuts — copy it onto a stick and double-click.

Both carry the Electron fuses the config already set: the binary can't be run as plain Node, can't
be opened with a Node debugger, ignores `NODE_OPTIONS`, and only loads its own integrity-checked
`app.asar`.

Neither is code-signed, so Windows SmartScreen warns on first run. Signing needs a certificate this
project doesn't have, and self-signing wouldn't help — SmartScreen cares about reputation, not
whether a signature exists. The README says plainly what the warning is and how to get past it,
which is better than a user meeting it unprepared.
