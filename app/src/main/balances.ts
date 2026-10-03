import { randomUUID } from 'crypto'
import type { AccountBalance, AccountBalanceInput } from '../shared/types'
import { audit, getDb } from './db'
import { notifyChanged } from './events'

// Bank and card balances the user types in now and then. Nothing is fetched from a bank; the
// "updated" date shows how old each number is.

interface Row {
  id: string
  name: string
  amount_cents: number
  currency: string
  updated_at: string
}

const toBalance = (r: Row): AccountBalance => ({
  id: r.id,
  name: r.name,
  amountCents: r.amount_cents,
  currency: r.currency,
  updatedAt: r.updated_at
})

export function listBalances(): AccountBalance[] {
  return (
    getDb().prepare('SELECT * FROM balances ORDER BY sort, rowid').all() as unknown as Row[]
  ).map(toBalance)
}

export function saveBalance(id: string | null, input: AccountBalanceInput): AccountBalance {
  const name = String(input?.name ?? '')
    .trim()
    .slice(0, 80)
  if (!name) throw new Error('Give the account a name.')
  const cents = Math.round(Number(input.amountCents))
  if (!Number.isFinite(cents) || Math.abs(cents) > 100_000_000_000) {
    throw new Error('Enter a valid amount.')
  }
  const currency = /^[A-Za-z]{3}$/.test(input.currency ?? '') ? input.currency.toUpperCase() : 'USD'
  const now = new Date().toISOString()
  const db = getDb()
  let balanceId = id
  if (balanceId) {
    const res = db
      .prepare(
        'UPDATE balances SET name = ?, amount_cents = ?, currency = ?, updated_at = ? WHERE id = ?'
      )
      .run(name, cents, currency, now, balanceId)
    if (res.changes === 0) throw new Error('Account not found.')
    audit('user', 'balance.update', balanceId)
  } else {
    balanceId = randomUUID()
    const next = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM balances').get() as {
      n: number
    }
    db.prepare(
      'INSERT INTO balances (id, name, amount_cents, currency, updated_at, sort) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(balanceId, name, cents, currency, now, next.n)
    audit('user', 'balance.create', balanceId)
  }
  notifyChanged()
  return toBalance(
    db.prepare('SELECT * FROM balances WHERE id = ?').get(balanceId) as unknown as Row
  )
}

export function deleteBalance(id: string): void {
  getDb().prepare('DELETE FROM balances WHERE id = ?').run(id)
  audit('user', 'balance.delete', id)
  notifyChanged()
}
