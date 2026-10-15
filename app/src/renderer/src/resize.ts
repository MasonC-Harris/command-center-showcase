// Drag-to-resize for the panels the user can size themselves (the brief's thread and focus window,
// the chat panel). Sizes are a per-machine convenience, so they live in localStorage.

export function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

/** Pass null to forget the size and go back to the default. */
export function writeStored(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Remembering the size is a convenience only.
  }
}

export const clamp = (n: number, min: number, max: number): number =>
  Math.min(Math.max(n, min), Math.max(min, max))

/**
 * Follows the pointer from a handle's pointerdown until it is released, reporting how far it has
 * moved. Text selection and the cursor are held for the whole drag, even off the handle.
 */
export function dragFrom(
  e: React.PointerEvent,
  onMove: (dx: number, dy: number) => void,
  onEnd?: () => void
): void {
  if (e.button !== 0) return
  e.preventDefault()
  const x0 = e.clientX
  const y0 = e.clientY
  const cursor = getComputedStyle(e.currentTarget).cursor
  const move = (ev: PointerEvent): void => onMove(ev.clientX - x0, ev.clientY - y0)
  const up = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    document.body.classList.remove('resizing')
    document.body.style.removeProperty('cursor')
    onEnd?.()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  document.body.classList.add('resizing')
  document.body.style.cursor = cursor
}
