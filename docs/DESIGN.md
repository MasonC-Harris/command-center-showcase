# Command Center: Project Plan

A personal, local-first desktop app that pulls email and calendar into one dark, minimal "Today" screen, classifies mail automatically, and lets me search and act on everything from a command palette. Built for one user (me).

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
| Calendar | Outlook (personal) is the hub and main account. Gmail calendars are subscribed into Outlook.com by iCal link; the iPhone adds the Outlook and Google accounts directly. |
| Classification | Hosted TypeSafe Jev (`jev-latest`, $0.042/Mtok input) chosen 2026-10-01; local OpenJev remains a possible later swap behind the same interface. No rules-based fallback. See section 5. |
| GPU budget | Local classifier model must use at most 7 GB VRAM (RTX 5070 has 12 GB; leave headroom for everything else) |
| Model lifecycle | Load the classifier once at app startup and keep it resident; never reload per email. See section 5. |
| Generation | Groq (`openai/gpt-oss-120b`) for summaries, draft replies, and task extraction, run only when the user presses a button on an email. Chosen 2026-10-01 over Claude for cost and speed. |
| Look | Dark, minimal, bento grid, hairline borders, one accent color |
| Accent color | No preference yet. Default proposal: a muted indigo, configurable in settings |
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
| Daily brief              | (next 3 events)|
+------------+-------------+----------------+
| Priority   | Needs reply | Tasks / due    |
| inbox      | (Jev)       |                |
+------------+-------------+----------------+
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

Mail and calendar sync, Jev classification, tasks and reminders, the assistant, rebindable shortcuts and the Finance view are built. See the README for setup.
