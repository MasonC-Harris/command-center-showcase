import type { DatabaseSync } from 'node:sqlite'
import type { Category, Priority } from '../shared/types'
import { transaction } from './db'

// Placeholder data for Phase 0. Every demo row id starts with "demo-" and the rows are rebuilt on
// each launch so the dates stay relative to today. Removed once real accounts are connected.

const DEMO_PREFIX = 'demo-'

function at(dayOffset: number, hour: number, minute = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + dayOffset)
  d.setHours(hour, minute, 0, 0)
  return d.toISOString()
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

const accounts = [
  { id: 'demo-acct-personal', provider: 'demo', address: 'me@personal.example' },
  { id: 'demo-acct-school', provider: 'demo', address: 'me@school.example' },
  { id: 'demo-acct-outlook', provider: 'demo', address: 'me@outlook.example' }
]

interface DemoEmail {
  account: string
  fromName: string
  fromAddr: string
  subject: string
  snippet: string
  ago: number
  read?: boolean
  priority: Priority
  category: Category
  needsReply: number
  importance: number
  confidence: number
}

const emails: DemoEmail[] = [
  {
    account: 'demo-acct-personal',
    fromName: 'Chase Alerts',
    fromAddr: 'alerts@bank.example',
    subject: 'New sign-in from an unrecognized device',
    snippet:
      'We noticed a sign-in to your account from Chrome on Windows near Austin, TX. If this was you…',
    ago: 12,
    priority: 'urgent',
    category: 'security',
    needsReply: 0.1,
    importance: 9,
    confidence: 0.94
  },
  {
    account: 'demo-acct-school',
    fromName: 'Prof. Alvarez',
    fromAddr: 'alvarez@school.example',
    subject: 'Re: Extension on the systems project',
    snippet:
      'I can give you until Friday at 5pm. Can you confirm which parts are still outstanding?',
    ago: 48,
    priority: 'needs_reply',
    category: 'school',
    needsReply: 0.92,
    importance: 8,
    confidence: 0.88
  },
  {
    account: 'demo-acct-outlook',
    fromName: 'Jordan Lee',
    fromAddr: 'jordan@work.example',
    subject: 'Design review moved to 3:30',
    snippet:
      'Heads up, we pushed the review back 30 minutes. Could you send the latest mocks beforehand?',
    ago: 95,
    priority: 'needs_reply',
    category: 'work',
    needsReply: 0.81,
    importance: 7,
    confidence: 0.79
  },
  {
    account: 'demo-acct-personal',
    fromName: 'City Utilities',
    fromAddr: 'billing@utilities.example',
    subject: 'Your October statement is ready: $84.17 due Oct 15',
    snippet: 'Your statement for account ending 4421 is now available. Autopay is not enabled.',
    ago: 180,
    priority: 'urgent',
    category: 'bills',
    needsReply: 0.05,
    importance: 8,
    confidence: 0.91
  },
  {
    account: 'demo-acct-personal',
    fromName: 'Sam',
    fromAddr: 'sam@friends.example',
    subject: 'Lunch tomorrow?',
    snippet: 'Are we still on for tomorrow? I was thinking the ramen place on 6th around noon.',
    ago: 240,
    priority: 'needs_reply',
    category: 'personal',
    needsReply: 0.95,
    importance: 6,
    confidence: 0.9
  },
  {
    account: 'demo-acct-outlook',
    fromName: 'GitHub',
    fromAddr: 'noreply@github.example',
    subject: '[command-center] CI passed on main',
    snippet: 'All checks have passed for commit 3f9a2c1.',
    ago: 300,
    read: true,
    priority: 'fyi',
    category: 'work',
    needsReply: 0.02,
    importance: 3,
    confidence: 0.97
  },
  {
    account: 'demo-acct-personal',
    fromName: 'Parcel Tracker',
    fromAddr: 'updates@shipping.example',
    subject: 'Your package arrives today by 8pm',
    snippet: 'Order #88213 (USB-C dock) is out for delivery.',
    ago: 420,
    priority: 'fyi',
    category: 'shopping',
    needsReply: 0.01,
    importance: 4,
    confidence: 0.93
  },
  {
    account: 'demo-acct-school',
    fromName: 'Registrar',
    fromAddr: 'registrar@school.example',
    subject: 'Spring registration opens Monday',
    snippet:
      'Your registration window opens Monday at 8:00 AM. Review holds on your account before then.',
    ago: 600,
    priority: 'fyi',
    category: 'school',
    needsReply: 0.08,
    importance: 6,
    confidence: 0.62
  },
  {
    account: 'demo-acct-personal',
    fromName: 'The Weekly Byte',
    fromAddr: 'news@newsletter.example',
    subject: 'Issue #212: local models on consumer GPUs',
    snippet:
      'This week: quantization tradeoffs, the 7 GB club, and a look at llama.cpp on Windows.',
    ago: 900,
    read: true,
    priority: 'newsletter',
    category: 'other',
    needsReply: 0.0,
    importance: 2,
    confidence: 0.98
  }
]

const events = [
  {
    title: 'Standup',
    day: 0,
    sh: 9,
    sm: 30,
    eh: 9,
    em: 45,
    location: null,
    link: 'https://meet.example/standup',
    attendees: ['jordan@work.example', 'team@work.example']
  },
  {
    title: 'Systems lecture',
    day: 0,
    sh: 11,
    sm: 0,
    eh: 12,
    em: 15,
    location: 'Engineering 204',
    link: null,
    attendees: []
  },
  {
    title: 'Design review',
    day: 0,
    sh: 15,
    sm: 30,
    eh: 16,
    em: 30,
    location: null,
    link: 'https://meet.example/design',
    attendees: ['jordan@work.example', 'priya@work.example']
  },
  {
    title: 'Gym',
    day: 0,
    sh: 18,
    sm: 0,
    eh: 19,
    em: 0,
    location: 'Rec center',
    link: null,
    attendees: []
  },
  {
    title: 'Lunch with Sam',
    day: 1,
    sh: 12,
    sm: 0,
    eh: 13,
    em: 0,
    location: 'Ramen on 6th',
    link: null,
    attendees: ['sam@friends.example']
  },
  {
    title: 'Office hours',
    day: 1,
    sh: 14,
    sm: 0,
    eh: 15,
    em: 0,
    location: 'Engineering 310',
    link: null,
    attendees: []
  }
]

const tasks = [
  { title: 'Send outstanding parts list to Prof. Alvarez', day: 0, h: 17, source: 1 },
  { title: 'Export latest mocks for design review', day: 0, h: 15, source: 2 },
  { title: 'Pay utilities bill ($84.17)', day: 14, h: 12, source: 3 },
  { title: 'Clear registration holds', day: 4, h: 8, source: 7 }
]

function deleteDemoRows(db: DatabaseSync): void {
  // Children before parents so foreign keys are satisfied.
  db.prepare('DELETE FROM tasks WHERE id LIKE ?').run(`${DEMO_PREFIX}%`)
  db.prepare('DELETE FROM events WHERE id LIKE ?').run(`${DEMO_PREFIX}%`)
  db.prepare('DELETE FROM accounts WHERE id LIKE ?').run(`${DEMO_PREFIX}%`) // cascades to emails
}

export function clearDemoData(db: DatabaseSync): void {
  transaction(db, () => deleteDemoRows(db))
}

export function seedDemoData(db: DatabaseSync): void {
  transaction(db, () => {
    deleteDemoRows(db)

    const insertAccount = db.prepare(
      'INSERT INTO accounts (id, provider, address, status, last_sync) VALUES (?, ?, ?, ?, ?)'
    )
    for (const a of accounts)
      insertAccount.run(a.id, a.provider, a.address, 'connected', minutesAgo(3))

    const insertEmail = db.prepare(
      `INSERT INTO emails (id, account_id, thread_id, from_addr, from_name, subject, snippet, received_at, labels, is_read)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '["INBOX"]', ?)`
    )
    const insertClass = db.prepare(
      `INSERT INTO classifications (email_id, priority, category, needs_reply, importance, confidence, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'demo', ?)`
    )
    emails.forEach((e, i) => {
      const id = `${DEMO_PREFIX}email-${i}`
      const received = minutesAgo(e.ago)
      insertEmail.run(
        id,
        e.account,
        id,
        e.fromAddr,
        e.fromName,
        e.subject,
        e.snippet,
        received,
        e.read ? 1 : 0
      )
      insertClass.run(
        id,
        e.priority,
        e.category,
        e.needsReply,
        e.importance,
        e.confidence,
        received
      )
    })

    const insertEvent = db.prepare(
      `INSERT INTO events (id, calendar_id, title, start, end, attendees, location, link)
       VALUES (?, 'demo', ?, ?, ?, ?, ?, ?)`
    )
    events.forEach((ev, i) => {
      insertEvent.run(
        `${DEMO_PREFIX}event-${i}`,
        ev.title,
        at(ev.day, ev.sh, ev.sm),
        at(ev.day, ev.eh, ev.em),
        JSON.stringify(ev.attendees),
        ev.location,
        ev.link
      )
    })

    const insertTask = db.prepare(
      'INSERT INTO tasks (id, title, due, source_email_id, status) VALUES (?, ?, ?, ?, ?)'
    )
    tasks.forEach((t, i) => {
      insertTask.run(
        `${DEMO_PREFIX}task-${i}`,
        t.title,
        at(t.day, t.h),
        `${DEMO_PREFIX}email-${t.source}`,
        'open'
      )
    })
  })
}
