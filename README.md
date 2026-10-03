# Command Center

A local-first desktop app that puts mail, calendar, tasks and money-from-email in one dark, keyboard-first screen. Built with Electron, React, TypeScript and SQLite. Everything is stored on your machine; the only network calls are to your mail providers and the AI APIs you configure.

![Today view](docs/screenshots/1-today.png)

## What it does

- **Unified inbox** across Outlook (Microsoft Graph), any number of Gmail accounts (Gmail API) and iCloud Mail (IMAP, read-only with an app-specific password). Mail can be hidden locally, one at a time or all at once, without touching the provider.
- **Today screen** that answers "what needs my attention right now": daily brief, priority mail, threads waiting on a reply, next events, tasks, and a schedule strip.
- **Auto-classification** of new mail by priority, category and "needs reply", using a hosted classifier behind a swappable interface. Low-confidence mail goes to a Review tab and your corrections are stored.
- **Assistant** (Groq) to summarize an email, draft a reply, or turn it into a task, only when you press the button. Drafts are never sent from the app, and every AI action is logged.
- **Calendar** with month and week views, per-account colours, and de-duplication of events that arrive from several sources.
- **Tasks and reminders**, plus a **Finance** view: bills, subscriptions and receipts pulled out of mail (the scan must quote evidence that money actually moved, so offers and gift-card promos are rejected), one-click adding from bill-like emails, hand-entered account balances, and **API usage** tracking with spend and remaining credit for the AI services.
- **Command palette** (`Ctrl+K`) to search mail and events and run any action. All shortcuts are rebindable.
- Tray icon, daily database backups, and read-only mail access by default.

| Inbox | Calendar |
|---|---|
| ![Inbox](docs/screenshots/2-inbox.png) | ![Calendar](docs/screenshots/3-calendar.png) |
| **Tasks** | **Command palette** |
| ![Tasks](docs/screenshots/4-tasks.png) | ![Palette](docs/screenshots/0-palette.png) |

## Security

- Renderer runs sandboxed with context isolation; only a typed API is exposed, and every IPC call is checked to come from the app's own page.
- The window can't navigate away from the app; links open in the default browser. Email bodies render in a script-less sandboxed iframe with remote images off by default.
- Electron fuses disable RunAsNode, Node inspector flags and `NODE_OPTIONS`, and enforce asar integrity.
- Email text given to the assistant is treated as untrusted; it only creates tasks or events when the user asks.

## Architecture

```
Gmail (xN) / Outlook / iCloud (IMAP) / calendars
        |  OAuth (loopback) + delta sync
        v
 Sync layer (Electron main)  --->  SQLite (node:sqlite, local)
        |                               |
        v                               v
 Classifier (swappable)  ------>  Today / Inbox / search
        |
        v
 Assistant (on demand, per email)
```

- **Main process:** OAuth flows, sync workers, SQLite, secrets, scheduled jobs.
- **Renderer:** React UI only, talking to main through a typed IPC bridge.
- **Adapters per provider** (connect, sync, search), so adding a source doesn't touch core code.
- **Secrets** are encrypted with Windows DPAPI and never stored in the database or in git.

More detail and the reasoning behind each choice is in [docs/DESIGN.md](docs/DESIGN.md).

## Running it

Requires Node 22+ and Windows (secret storage uses DPAPI). The app starts with seeded demo data, which is what the screenshots show.

```bash
cd app
npm install
npm run dev
```

To connect real accounts you need your own OAuth clients, because this project is not verified by Google or Microsoft:

- **Google:** create a Desktop OAuth client with the Gmail and Calendar APIs enabled and save it as `client_secret_google.json` in the project root (it is gitignored).
- **Microsoft:** register an Azure app for Microsoft Graph and set `MS_CLIENT_ID` to its client ID.
- **Classifier and assistant:** paste a TypeSafe key and a Groq key in Settings.

Set `CC_USER_DATA` to use a separate data folder, for example when trying the demo without touching real data.

## Status

A personal project I built for myself, in under 24 hours. Not packaged for general release.

## License

MIT. See [LICENSE](LICENSE).
