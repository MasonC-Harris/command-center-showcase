import { useEffect, useMemo, useState } from 'react'
import type {
  AccountBalance,
  ApiUsageSummary,
  FinanceEmail,
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
          bill-like mail to the AI provider, never the full message, and only when you press Scan.
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
          Scanning needs an AI provider. Connect one in Settings → Assistant. You can still add
          items by hand.
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
        <BalancesTile />

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

        <FinanceEmailsTile onOpenEmail={onOpenEmail} />

        <ApiUsageTile />

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

/** Small API bills need more than two decimals to show anything. */
function usd(amount: number): string {
  const abs = Math.abs(amount)
  const digits = abs === 0 || abs >= 1 ? 2 : abs >= 0.01 ? 3 : 5
  return `${amount < 0 ? '-' : ''}$${abs.toFixed(digits)}`
}

const compact = (n: number): string =>
  new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n)

/** Spend and remaining credit for the paid APIs (Jev and the AI providers). */
function ApiUsageTile(): React.JSX.Element {
  const [usage, setUsage] = useState<ApiUsageSummary[] | null>(null)
  const [editing, setEditing] = useState<string | null>(null)

  const load = (): void => void window.api.getApiUsage().then(setUsage)
  useEffect(() => {
    load()
    // Rate limits change with every call; keep the numbers fresh while the page is open.
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [])
  useDataChanged(load)

  return (
    <section className="tile span-3">
      <header className="tile-header">
        API usage <span className="count mono">{usage?.length ?? 0}</span>
        <span className="hint">Counted by this app at published rates</span>
      </header>
      <ul className="tile-list">
        {usage && usage.length === 0 && (
          <li className="empty">No paid APIs connected. Add a key in Settings.</li>
        )}
        {usage?.map((p) => (
          <li key={p.id} className="api-usage">
            <div className="api-usage-head">
              <span className="row-title">{p.name}</span>
              {p.balance ? (
                <span
                  className={`mono api-balance ${p.balance.remaining < p.balance.amount * 0.1 ? 'overdue' : ''}`}
                >
                  {usd(p.balance.remaining)} left
                </span>
              ) : (
                <span className="muted">Balance unknown: set it to track what&apos;s left</span>
              )}
              <button className="btn ghost header-action" onClick={() => setEditing(p.id)}>
                {p.balance ? 'Update balance' : 'Set balance'}
              </button>
              <a className="link row-meta" href={p.billingUrl} target="_blank" rel="noreferrer">
                Billing
              </a>
            </div>
            {editing === p.id && (
              <BalanceEditor
                current={p.balance?.remaining ?? null}
                onSave={async (amount) => {
                  await window.api.setApiBalance(p.id, amount)
                  setEditing(null)
                  load()
                }}
                onCancel={() => setEditing(null)}
              />
            )}
            <div className="api-usage-grid mono">
              {(
                [
                  ['Today', p.today],
                  ['This month', p.month],
                  ['All time', p.total]
                ] as const
              ).map(([label, t]) => (
                <div key={label}>
                  <div className="muted">{label}</div>
                  {/* Every call is counted; only models with a published rate reach the figure. */}
                  <div className="api-cost">
                    {t.unpricedRequests === t.requests && t.requests > 0 ? '—' : usd(t.cost)}
                  </div>
                  <div className="muted">
                    {t.requests} calls · {compact(t.inputTokens + t.outputTokens)} tokens
                  </div>
                </div>
              ))}
            </div>
            {p.limits && (
              <div className="muted mono api-usage-sub">
                Rate limit ({p.limits.model}): {p.limits.requestsRemaining ?? '?'}/
                {p.limits.requestsLimit ?? '?'} requests today
                {p.limits.tokensLimit !== null &&
                  ` · ${compact(p.limits.tokensRemaining ?? 0)}/${compact(p.limits.tokensLimit)} tokens per minute`}
              </div>
            )}
            {p.balance && (
              <div className="muted api-usage-sub">
                Balance of {usd(p.balance.amount)} entered {shortDate(p.balance.setAt)}; spend since
                then is subtracted.
              </div>
            )}
            {p.estimatedRequests > 0 && (
              <div className="muted api-usage-sub">
                Includes {p.estimatedRequests} earlier calls made before tracking started, with
                estimated token counts.
              </div>
            )}
            {p.total.unpricedRequests > 0 && (
              <div className="muted api-usage-sub">
                {p.total.unpricedRequests} of {p.total.requests} calls used a model this app has no
                published rate for, so their tokens are counted but not costed. The provider&apos;s
                own billing page has the real figure.
              </div>
            )}
            {p.note && <div className="muted api-usage-sub">{p.note}</div>}
          </li>
        ))}
      </ul>
    </section>
  )
}

function BalanceEditor({
  current,
  onSave,
  onCancel
}: {
  current: number | null
  onSave: (amount: number | null) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(current === null ? '' : current.toFixed(2))
  const [error, setError] = useState<string | null>(null)
  const save = (): void => {
    const amount = value.trim() === '' ? null : Number(value.replace(/[$,\s]/g, ''))
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
      setError('Enter a dollar amount, e.g. 4.85')
      return
    }
    onSave(amount).catch((err) => setError(errorText(err)))
  }
  return (
    <div className="actions-row api-balance-editor">
      <input
        className="text-input"
        autoFocus
        inputMode="decimal"
        placeholder="Credit left on the account, e.g. 4.85"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save()
          if (e.key === 'Escape') onCancel()
        }}
      />
      <button className="btn primary" onClick={save}>
        Save
      </button>
      <button className="btn ghost" onClick={onCancel}>
        Cancel
      </button>
      {error && <span className="warning">{error}</span>}
      <span className="muted hint-right">
        Copy it from the provider&apos;s billing page. Empty clears it.
      </span>
    </div>
  )
}

/** Bank and card balances, typed in by hand now and then. */
function BalancesTile(): React.JSX.Element {
  const [balances, setBalances] = useState<AccountBalance[] | null>(null)
  const [editing, setEditing] = useState<string | 'new' | null>(null)

  const load = (): void => void window.api.listBalances().then(setBalances)
  useEffect(load, [])
  useDataChanged(load)

  const list = balances ?? []
  const oldest = list.reduce<string | null>(
    (min, b) => (min === null || b.updatedAt < min ? b.updatedAt : min),
    null
  )

  return (
    <section className="tile span-3">
      <header className="tile-header">
        Balances <span className="count mono">{list.length}</span>
        <button className="btn ghost header-action" onClick={() => setEditing('new')}>
          <Icon name="plus" size={10} /> Add account
        </button>
        <span className="hint mono">{oldest ? `oldest update ${shortDate(oldest)}` : ''}</span>
      </header>
      <div className="balance-total">
        <span className="muted">Total</span>
        <span className="mono balance-total-amount">{totalBalance(list)}</span>
      </div>
      <ul className="tile-list">
        {balances && list.length === 0 && editing !== 'new' && (
          <li className="empty">
            Add your bank and card accounts with their current balance. Update them whenever you
            check.
          </li>
        )}
        {list.map((b) =>
          editing === b.id ? (
            <BalanceRowEditor key={b.id} balance={b} onDone={() => setEditing(null)} />
          ) : (
            <li
              key={b.id}
              className="row balance-row"
              role="button"
              tabIndex={0}
              title="Click to update"
              onClick={() => setEditing(b.id)}
              onKeyDown={(e) => e.key === 'Enter' && setEditing(b.id)}
            >
              <div className="row-main">
                <span className="row-title">{b.name}</span>
                <div className="row-sub mono">updated {shortDate(b.updatedAt)}</div>
              </div>
              <span className={`mono balance-amount ${b.amountCents < 0 ? 'overdue' : ''}`}>
                {money(b.amountCents, b.currency)}
              </span>
            </li>
          )
        )}
        {editing === 'new' && <BalanceRowEditor balance={null} onDone={() => setEditing(null)} />}
      </ul>
    </section>
  )
}

/** Sums per currency, like totalLabel for items. */
function totalBalance(list: AccountBalance[]): string {
  const sums = new Map<string, number>()
  for (const b of list) sums.set(b.currency, (sums.get(b.currency) ?? 0) + b.amountCents)
  if (sums.size === 0) return money(0, 'USD')
  return [...sums].map(([cur, cents]) => money(cents, cur)).join(' + ')
}

function BalanceRowEditor({
  balance,
  onDone
}: {
  balance: AccountBalance | null
  onDone: () => void
}): React.JSX.Element {
  const [name, setName] = useState(balance?.name ?? '')
  const [amount, setAmount] = useState(balance ? (balance.amountCents / 100).toFixed(2) : '')
  const [error, setError] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    const value = Number(amount.replace(/[$,\s]/g, ''))
    if (!Number.isFinite(value)) {
      setError('Enter an amount, e.g. 899.84')
      return
    }
    try {
      await window.api.saveBalance(balance?.id ?? null, {
        name,
        amountCents: Math.round(value * 100),
        currency: balance?.currency ?? 'USD'
      })
      onDone()
    } catch (err) {
      setError(errorText(err))
    }
  }
  const remove = async (): Promise<void> => {
    if (!balance || !window.confirm(`Remove ${balance.name}?`)) return
    await window.api.deleteBalance(balance.id)
    onDone()
  }
  const keys = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') void save()
    if (e.key === 'Escape') onDone()
  }

  return (
    <li className="task-editor">
      <div className="actions-row">
        <input
          className="text-input"
          autoFocus={!balance}
          placeholder="Account, e.g. BofA checking"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={keys}
        />
        <input
          className="text-input balance-input mono"
          autoFocus={!!balance}
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onKeyDown={keys}
        />
        <button className="btn primary" onClick={() => void save()}>
          Save
        </button>
        <button className="btn ghost" onClick={onDone}>
          Cancel
        </button>
        {balance && (
          <button className="btn ghost danger" onClick={() => void remove()}>
            Remove
          </button>
        )}
        {error && <span className="warning">{error}</span>}
      </div>
    </li>
  )
}

const ADD_AS: { kind: FinanceKind; label: string }[] = [
  { kind: 'receipt', label: 'Spending' },
  { kind: 'subscription', label: 'Subscription' },
  { kind: 'bill', label: 'Bill' }
]

/** Bill-like mail that isn't in Finance yet, with one-click adding. */
function FinanceEmailsTile({
  onOpenEmail
}: {
  onOpenEmail: (id: string) => void
}): React.JSX.Element {
  const [emails, setEmails] = useState<FinanceEmail[] | null>(null)
  const [hiddenCount, setHiddenCount] = useState(0)
  const [adding, setAdding] = useState<{ id: string; kind: FinanceKind } | null>(null)
  const [showAll, setShowAll] = useState(false)

  const load = (): void =>
    void window.api.listFinanceEmails().then((r) => {
      setEmails(r.emails)
      setHiddenCount(r.hidden)
    })

  const hide = (ids: string[]): void => {
    setEmails((list) => list?.filter((e) => !ids.includes(e.id)) ?? null)
    void window.api.hideFinanceEmails(ids)
  }
  const hideAll = (): void => {
    if (!emails?.length) return
    if (
      !window.confirm(`Hide all ${emails.length} emails from this list? Your Inbox is not changed.`)
    )
      return
    hide(emails.map((e) => e.id))
  }
  useEffect(load, [])
  useDataChanged(load)

  const shown = showAll ? (emails ?? []) : (emails ?? []).slice(0, 6)

  return (
    <section className="tile span-3">
      <header className="tile-header">
        From your mail <span className="count mono">{emails?.length ?? 0}</span>
        <span className="hint">Bill-like emails not in Finance yet</span>
        {emails && emails.length > 0 && (
          <button className="btn ghost header-action" onClick={hideAll}>
            Hide all
          </button>
        )}
        {hiddenCount > 0 && (
          <button
            className="btn ghost header-action"
            onClick={() => void window.api.restoreFinanceEmails()}
          >
            Restore {hiddenCount} hidden
          </button>
        )}
      </header>
      <ul className="tile-list">
        {emails && emails.length === 0 && (
          <li className="empty">Nothing waiting. Bills and receipts you add show up above.</li>
        )}
        {shown.map((e) =>
          adding?.id === e.id ? (
            <ItemEditor
              key={e.id}
              item={null}
              draft={{
                kind: adding.kind,
                merchant: e.fromName || e.fromAddr,
                amountCents: e.amountCents ?? 0,
                currency: 'USD',
                due: null,
                occurredAt: e.receivedAt,
                // Spending is money already spent; bills and subscriptions start open.
                status: adding.kind === 'receipt' ? 'paid' : 'open',
                notes: e.subject,
                sourceEmailId: e.id
              }}
              onDone={() => setAdding(null)}
            />
          ) : (
            <li key={e.id} className="row finance-email">
              <div className="row-main">
                <div className="row-top">
                  <span className="row-title">{e.fromName || e.fromAddr}</span>
                  <span className="row-meta mono">{shortDate(e.receivedAt)}</span>
                  {e.amountCents !== null && (
                    <span className="row-meta mono">{money(e.amountCents, 'USD')}</span>
                  )}
                </div>
                <div className="row-sub">{e.subject}</div>
              </div>
              <div className="finance-add">
                {ADD_AS.map((a) => (
                  <button
                    key={a.kind}
                    className="label-chip"
                    title={`Add as ${a.label.toLowerCase()}`}
                    onClick={() => setAdding({ id: e.id, kind: a.kind })}
                  >
                    <Icon name="plus" size={10} /> {a.label}
                  </button>
                ))}
                <button className="link row-meta" onClick={() => onOpenEmail(e.id)}>
                  Email
                </button>
                <button
                  className="row-action"
                  title="Hide from this list"
                  aria-label={`Hide "${e.subject}" from this list`}
                  onClick={() => hide([e.id])}
                >
                  <Icon name="hide" size={12} />
                </button>
              </div>
            </li>
          )
        )}
        {emails && emails.length > 6 && (
          <li className="empty">
            <button className="link" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Show fewer' : `Show all ${emails.length}`}
            </button>
          </li>
        )}
      </ul>
    </section>
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
  draft,
  onDone
}: {
  item: FinanceItem | null
  /** Starting values for a new item, e.g. one made from an email. */
  draft?: Omit<FinanceItem, 'id'>
  onDone: () => void
}): React.JSX.Element {
  const start = item ?? draft
  const [kind, setKind] = useState<FinanceKind>(start?.kind ?? 'bill')
  const [merchant, setMerchant] = useState(start?.merchant ?? '')
  const [amount, setAmount] = useState(
    start && start.amountCents > 0 ? (start.amountCents / 100).toFixed(2) : ''
  )
  const [currency, setCurrency] = useState(start?.currency ?? 'USD')
  const [due, setDue] = useState(toDateInput(start?.due ?? null))
  const [date, setDate] = useState(toDateInput(start?.occurredAt ?? new Date().toISOString()))
  const [status, setStatus] = useState<FinanceStatus>(start?.status ?? 'open')
  const [notes, setNotes] = useState(start?.notes ?? '')
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
      notes: notes.trim() ? notes : null,
      sourceEmailId: item ? undefined : (draft?.sourceEmailId ?? null)
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
