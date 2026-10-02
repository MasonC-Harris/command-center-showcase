import { useEffect, useMemo, useState } from 'react'
import type {
  FinanceItem,
  FinanceItemInput,
  FinanceKind,
  FinanceScanStatus,
  FinanceStatus
} from '@shared/types'
import { Icon } from '../components/Icon'
import { useDataChanged } from '../hooks'
import { shortDate } from '../format'

const KIND_LABEL: Record<FinanceKind, string> = {
  bill: 'Bill',
  subscription: 'Subscription',
  receipt: 'Receipt',
  income: 'Income'
}

const DAY = 86_400_000

function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`
  }
}

/** Sums per currency; mixed currencies are never added together. */
function totalLabel(items: FinanceItem[]): string {
  const sums = new Map<string, number>()
  for (const i of items) sums.set(i.currency, (sums.get(i.currency) ?? 0) + i.amountCents)
  if (sums.size === 0) return money(0, 'USD')
  return [...sums].map(([cur, cents]) => money(cents, cur)).join(' + ')
}

const errorText = (err: unknown): string =>
  err instanceof Error
    ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    : String(err)

/** Bills, subscriptions and spending, from scanned mail and manual entries. */
export function Finance({ onOpenEmail }: { onOpenEmail: (id: string) => void }): React.JSX.Element {
  const [items, setItems] = useState<FinanceItem[] | null>(null)
  const [scan, setScan] = useState<FinanceScanStatus | null>(null)
  const [nowAt, setNowAt] = useState(() => new Date())
  const [editing, setEditing] = useState<string | 'new' | null>(null)

  const load = (): void => {
    void window.api.listFinanceItems().then((list) => {
      setItems(list)
      setNowAt(new Date())
    })
    void window.api.getFinanceScanStatus().then(setScan)
  }
  useEffect(load, [])
  useDataChanged(load)

  const startScan = (): void => {
    setScan((s) => (s ? { ...s, running: true, done: 0, total: 0, error: null } : s))
    void window.api.scanFinanceMail().then(setScan)
  }

  const markPaid = (i: FinanceItem): void =>
    void window.api.saveFinanceItem(i.id, { ...i, status: 'paid' })

  const now = nowAt
  const view = useMemo(() => {
    const all = (items ?? []).filter((i) => i.status !== 'ignored')
    const horizon = now.getTime() + 30 * DAY
    const bills = all
      .filter((i) => i.kind === 'bill' && i.status === 'open')
      .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'))
      .filter((i) => !i.due || new Date(i.due).getTime() <= horizon)
    // One row per merchant: the most recent open subscription charge.
    const subs = new Map<string, FinanceItem>()
    for (const i of all) {
      if (i.kind !== 'subscription' || i.status !== 'open') continue
      const key = i.merchant.toLowerCase()
      const prev = subs.get(key)
      if (!prev || i.occurredAt > prev.occurredAt) subs.set(key, i)
    }
    const subList = [...subs.values()].sort((a, b) =>
      (a.due ?? '9999').localeCompare(b.due ?? '9999')
    )
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    const spend = all.filter(
      (i) => i.kind === 'receipt' && new Date(i.occurredAt).getTime() >= monthStart
    )
    return { bills, subList, spend, recent: all.slice(0, 12) }
  }, [items, now])

  return (
    <div className="page">
      <div className="finance-bar">
        <div className="muted finance-note">
          <Icon name="wallet" size={12} /> Private by design: items live in this device&apos;s
          database. Scanning sends only sender, subject, date and a short preview of recent
          bill-like mail to Groq, never the full message, and only when you press Scan.
        </div>
        <button className="btn" onClick={() => setEditing('new')}>
          <Icon name="plus" size={12} /> Add
        </button>
        <button className="btn primary" disabled={scan?.running} onClick={startScan}>
          <Icon name="refresh" size={12} /> {scan?.running ? 'Scanning…' : 'Scan mail'}
        </button>
      </div>

      {scan && !scan.hasKey && (
        <div className="muted finance-status">
          Scanning needs a Groq API key. Add one in Settings → Assistant. You can still add items by
          hand.
        </div>
      )}
      {scan?.running && (
        <div className="muted finance-status mono">
          Checked {scan.done} of {scan.total} · {scan.found} found
        </div>
      )}
      {scan && !scan.running && scan.hasKey && scan.total > 0 && (
        <div className="muted finance-status mono">
          Last scan: {scan.total} emails checked, {scan.found} added
          {scan.error ? ` · ${scan.error}` : ''}
        </div>
      )}
      {scan && !scan.running && scan.hasKey && scan.total === 0 && scan.error && (
        <div className="warning finance-status">{scan.error}</div>
      )}

      {editing === 'new' && <ItemEditor item={null} onDone={() => setEditing(null)} />}

      <div className="bento">
        <section className="tile">
          <header className="tile-header">
            Upcoming bills <span className="count mono">{view.bills.length}</span>
            <span className="hint mono">{totalLabel(view.bills)}</span>
          </header>
          <ul className="tile-list">
            {items && view.bills.length === 0 && (
              <li className="empty">No open bills in the next 30 days.</li>
            )}
            {view.bills.map((i) =>
              editing === i.id ? (
                <ItemEditor key={i.id} item={i} onDone={() => setEditing(null)} />
              ) : (
                <ItemRow
                  key={i.id}
                  item={i}
                  now={now}
                  onEdit={() => setEditing(i.id)}
                  onOpenEmail={onOpenEmail}
                  onPaid={() => markPaid(i)}
                />
              )
            )}
          </ul>
        </section>

        <section className="tile">
          <header className="tile-header">
            Subscriptions <span className="count mono">{view.subList.length}</span>
            <span className="hint mono">{totalLabel(view.subList)} / mo</span>
          </header>
          <ul className="tile-list">
            {items && view.subList.length === 0 && (
              <li className="empty">No subscriptions yet. Scan your mail or add one.</li>
            )}
            {view.subList.map((i) =>
              editing === i.id ? (
                <ItemEditor key={i.id} item={i} onDone={() => setEditing(null)} />
              ) : (
                <ItemRow
                  key={i.id}
                  item={i}
                  now={now}
                  renews
                  onEdit={() => setEditing(i.id)}
                  onOpenEmail={onOpenEmail}
                />
              )
            )}
          </ul>
        </section>

        <section className="tile">
          <header className="tile-header">
            Spending this month <span className="hint mono">{totalLabel(view.spend)}</span>
          </header>
          <SpendBars items={view.spend} loaded={items !== null} />
        </section>

        <section className="tile span-3">
          <header className="tile-header">Recent</header>
          <ul className="tile-list">
            {items && view.recent.length === 0 && (
              <li className="empty">Nothing here yet. Press Scan mail or add an item.</li>
            )}
            {view.recent.map((i) =>
              editing === i.id ? (
                <ItemEditor key={i.id} item={i} onDone={() => setEditing(null)} />
              ) : (
                <ItemRow
                  key={i.id}
                  item={i}
                  now={now}
                  showKind
                  onEdit={() => setEditing(i.id)}
                  onOpenEmail={onOpenEmail}
                />
              )
            )}
          </ul>
        </section>
      </div>
    </div>
  )
}

function ItemRow({
  item: i,
  now,
  renews,
  showKind,
  onEdit,
  onOpenEmail,
  onPaid
}: {
  item: FinanceItem
  now: Date
  renews?: boolean
  showKind?: boolean
  onEdit: () => void
  onOpenEmail: (id: string) => void
  onPaid?: () => void
}): React.JSX.Element {
  // Overdue is the only thing that earns the accent colour here.
  const overdue =
    i.kind === 'bill' && i.status === 'open' && i.due !== null && new Date(i.due) < now
  const days = i.due ? Math.round((new Date(i.due).getTime() - now.getTime()) / DAY) : null
  return (
    <li className="row">
      <div
        className="row-main"
        role="button"
        tabIndex={0}
        onClick={onEdit}
        onKeyDown={(e) => e.key === 'Enter' && onEdit()}
      >
        <div className="row-top">
          <span className="row-title">{i.merchant}</span>
          <span className={`mono ${i.kind === 'income' ? '' : 'row-meta'}`}>
            {i.kind === 'income' ? '+' : ''}
            {money(i.amountCents, i.currency)}
          </span>
        </div>
        <div className="row-sub mono finance-meta">
          {showKind && <span>{KIND_LABEL[i.kind]}</span>}
          {i.due && (
            <span className={overdue ? 'overdue' : ''}>
              {overdue ? 'Overdue · ' : renews ? 'Renews ' : 'Due '}
              {shortDate(i.due)}
              {!overdue && days !== null && days >= 0 && days < 8 ? ` · ${days}d` : ''}
            </span>
          )}
          {!i.due && <span>{shortDate(i.occurredAt)}</span>}
          {showKind && i.status !== 'open' && <span>{i.status}</span>}
        </div>
      </div>
      {onPaid && (
        <button className="btn ghost" onClick={onPaid}>
          Paid
        </button>
      )}
      {i.sourceEmailId && (
        <button
          className="link row-meta"
          onClick={() => onOpenEmail(i.sourceEmailId!)}
          title="Open the source email"
        >
          Email
        </button>
      )}
    </li>
  )
}

/** Plain CSS bars: top merchants this month, in the currency with the most spending. */
function SpendBars({
  items,
  loaded
}: {
  items: FinanceItem[]
  loaded: boolean
}): React.JSX.Element {
  const byCurrency = new Map<string, number>()
  for (const i of items)
    byCurrency.set(i.currency, (byCurrency.get(i.currency) ?? 0) + i.amountCents)
  const currency = [...byCurrency].sort((a, b) => b[1] - a[1])[0]?.[0]
  const byMerchant = new Map<string, number>()
  for (const i of items) {
    if (i.currency === currency)
      byMerchant.set(i.merchant, (byMerchant.get(i.merchant) ?? 0) + i.amountCents)
  }
  const top = [...byMerchant].sort((a, b) => b[1] - a[1]).slice(0, 6)
  if (top.length === 0) {
    return <div className="empty">{loaded ? 'No receipts this month.' : ''}</div>
  }
  const max = top[0][1]
  return (
    <div className="tile-body finance-bars">
      {top.map(([merchant, cents]) => (
        <div key={merchant} className="finance-bar-row">
          <span className="finance-bar-label">{merchant}</span>
          <span className="finance-bar-track">
            <span
              className="finance-bar-fill"
              style={{ width: `${Math.max(3, (cents / max) * 100)}%` }}
            />
          </span>
          <span className="mono finance-bar-value">{money(cents, currency)}</span>
        </div>
      ))}
    </div>
  )
}

const toDateInput = (iso: string | null): string => {
  if (!iso) return ''
  const d = new Date(iso)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const fromDateInput = (v: string): string | null =>
  v ? new Date(`${v}T12:00:00`).toISOString() : null

function ItemEditor({
  item,
  onDone
}: {
  item: FinanceItem | null
  onDone: () => void
}): React.JSX.Element {
  const [kind, setKind] = useState<FinanceKind>(item?.kind ?? 'bill')
  const [merchant, setMerchant] = useState(item?.merchant ?? '')
  const [amount, setAmount] = useState(item ? (item.amountCents / 100).toFixed(2) : '')
  const [currency, setCurrency] = useState(item?.currency ?? 'USD')
  const [due, setDue] = useState(toDateInput(item?.due ?? null))
  const [date, setDate] = useState(toDateInput(item?.occurredAt ?? new Date().toISOString()))
  const [status, setStatus] = useState<FinanceStatus>(item?.status ?? 'open')
  const [notes, setNotes] = useState(item?.notes ?? '')
  const [error, setError] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    const value = Number(amount.replace(',', '.'))
    if (!Number.isFinite(value) || value < 0) {
      setError('Enter a valid amount.')
      return
    }
    const input: FinanceItemInput = {
      kind,
      merchant,
      amountCents: Math.round(value * 100),
      currency,
      due: fromDateInput(due),
      occurredAt: fromDateInput(date) ?? new Date().toISOString(),
      status,
      notes: notes.trim() ? notes : null
    }
    try {
      await window.api.saveFinanceItem(item?.id ?? null, input)
      onDone()
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <li className="task-editor finance-editor">
      <div className="actions-row">
        <label className="field">
          Kind
          <select
            className="text-input"
            value={kind}
            onChange={(e) => setKind(e.target.value as FinanceKind)}
          >
            {Object.entries(KIND_LABEL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <input
          className="text-input"
          autoFocus
          placeholder="Merchant"
          value={merchant}
          onChange={(e) => setMerchant(e.target.value)}
        />
        <input
          className="text-input finance-amount mono"
          inputMode="decimal"
          placeholder="Amount"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <input
          className="text-input finance-currency mono"
          maxLength={3}
          value={currency}
          onChange={(e) => setCurrency(e.target.value.toUpperCase())}
          aria-label="Currency"
        />
      </div>
      <div className="actions-row">
        <label className="field">
          {kind === 'subscription' ? 'Renews' : 'Due'}
          <input
            className="text-input date-input"
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        </label>
        <label className="field">
          Date
          <input
            className="text-input date-input"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label className="field">
          Status
          <select
            className="text-input"
            value={status}
            onChange={(e) => setStatus(e.target.value as FinanceStatus)}
          >
            <option value="open">Open</option>
            <option value="paid">Paid</option>
            <option value="ignored">Ignored</option>
          </select>
        </label>
      </div>
      <textarea
        className="draft-editor task-notes-input"
        placeholder="Notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <div className="actions-row">
        <button className="btn primary" onClick={() => void save()}>
          Save
        </button>
        <button className="btn ghost" onClick={onDone}>
          Cancel
        </button>
        {item && (
          <button
            className="btn ghost danger"
            onClick={() => void window.api.deleteFinanceItem(item.id).then(onDone)}
          >
            Delete
          </button>
        )}
        {error && <span className="warning">{error}</span>}
      </div>
    </li>
  )
}
