import type { Category, Priority } from '@shared/types'

export const CATEGORY_LABEL: Record<Category, string> = {
  bills: 'Bills',
  work: 'Work',
  school: 'School',
  personal: 'Personal',
  shopping: 'Shopping',
  security: 'Security',
  other: 'Other'
}

/** Below this priority confidence an email is shown as needing review rather than filed. */
export const REVIEW_THRESHOLD = 0.5

export function priorityLabel(priority: Priority, confidence: number | null): string {
  return confidence !== null && confidence < REVIEW_THRESHOLD
    ? `${PRIORITY_LABEL[priority]}?`
    : PRIORITY_LABEL[priority]
}

export const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: 'Urgent',
  needs_reply: 'Needs reply',
  fyi: 'FYI',
  newsletter: 'Newsletter',
  junk: 'Junk'
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function dayDiff(iso: string, now = new Date()): number {
  return Math.round((startOfDay(new Date(iso)) - startOfDay(now)) / 86_400_000)
}

export function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function ago(iso: string, now = new Date()): string {
  const minutes = Math.round((now.getTime() - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  if (dayDiff(iso, now) === 0) return `${Math.round(minutes / 60)}h`
  if (dayDiff(iso, now) === -1) return 'Yesterday'
  return shortDate(iso)
}

export function dayLabel(iso: string, now = new Date()): string {
  const diff = dayDiff(iso, now)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  return new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

export function due(iso: string, now = new Date()): string {
  const diff = dayDiff(iso, now)
  if (diff === 0) return `Today ${time(iso)}`
  if (diff === 1) return 'Tomorrow'
  if (diff > 1 && diff < 7) return new Date(iso).toLocaleDateString([], { weekday: 'short' })
  return shortDate(iso)
}

export function greeting(now = new Date()): string {
  const h = now.getHours()
  if (h < 5) return 'Good night'
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

export function longDate(now = new Date()): string {
  return now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
}
