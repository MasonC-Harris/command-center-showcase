import type { Account } from '@shared/types'

// Desaturated hues that sit quietly on the near-black UI. None is close to --accent (indigo),
// which is reserved for urgency.
const PALETTE = [
  '#7fa8b8', // steel
  '#c2a27c', // sand
  '#8fb08b', // sage
  '#b88fa8', // mauve
  '#b0ab7a', // olive
  '#7fb5a8', // teal
  '#bb8e8a' // clay
]

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/**
 * Colour per account id. Derived from the id, then nudged to the next free swatch on a clash so
 * two accounts never share a colour; ids are sorted first so the result doesn't depend on order.
 */
export function accountColors(accounts: Account[]): Map<string, string> {
  const colors = new Map<string, string>()
  const used = new Set<number>()
  for (const a of [...accounts].sort((x, y) => x.id.localeCompare(y.id))) {
    let i = hash(a.id) % PALETTE.length
    for (let tries = 0; used.has(i) && tries < PALETTE.length; tries++) i = (i + 1) % PALETTE.length
    used.add(i)
    colors.set(a.id, PALETTE[i])
  }
  return colors
}

/** Colour by account address, which is what events carry. */
export function colorsByAddress(accounts: Account[]): Map<string, string> {
  const byId = accountColors(accounts)
  return new Map(accounts.map((a) => [a.address, byId.get(a.id) as string]))
}
