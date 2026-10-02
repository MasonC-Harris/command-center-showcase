import { useEffect, useMemo, useState } from 'react'
import type { EmailBody, EmailSummary } from '@shared/types'
import { useDataChanged } from '../hooks'
import { CATEGORY_LABEL } from '../format'
import { AssistantPanel } from './AssistantPanel'
import { EmailLabels } from './EmailLabels'
import { Icon } from './Icon'

const REMOTE_IMAGE = /<img\b[^>]*\bsrc\s*=\s*["']?\s*https?:/i

/**
 * Shows one email. The body renders in a sandboxed iframe with scripts disabled; links open in
 * the default browser; remote images (often trackers) stay blocked until the user loads them.
 * Mount with key={emailId} so switching emails starts from a clean state.
 */
export function ReadingPane({
  emailId,
  onClose,
  onHide
}: {
  emailId: string
  onClose: () => void
  /** Hides the email in Command Center only; the parent updates the list and offers undo. */
  onHide?: (emailId: string) => void
}): React.JSX.Element {
  const [email, setEmail] = useState<EmailSummary | null>(null)
  const [body, setBody] = useState<EmailBody | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showImages, setShowImages] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.api.getEmail(emailId).then((e) => !cancelled && setEmail(e))
    window.api
      .getEmailBody(emailId)
      .then((b) => !cancelled && setBody(b))
      .catch((err) => !cancelled && setError(errorText(err)))
    return () => {
      cancelled = true
    }
  }, [emailId])

  // Keep labels current after a correction.
  useDataChanged(() => void window.api.getEmail(emailId).then(setEmail))

  const hasRemoteImages = !!body?.html && REMOTE_IMAGE.test(body.html)
  const srcDoc = useMemo(() => (body ? buildDocument(body, showImages) : ''), [body, showImages])

  return (
    <article className="reading-pane" aria-label="Email">
      <header className="pane-header">
        <div className="pane-actions">
          {onHide && email && (
            <>
              <button
                className="btn ghost"
                title="Hide from Command Center. Nothing changes in your mailbox."
                onClick={() => onHide(email.id)}
              >
                <Icon name="hide" size={13} />
                Hide
              </button>
              <span className="pane-divider" />
            </>
          )}
          {email?.webUrl && (
            <a className="btn ghost" href={email.webUrl} target="_blank" rel="noreferrer" title="o">
              <Icon name="external" size={12} />
              Open in {email.webUrl.includes('google.com') ? 'Gmail' : 'Outlook'}
            </a>
          )}
          <button className="btn ghost icon-only" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>
        <h2 className="pane-subject">{email?.subject ?? ' '}</h2>
        {email && (
          <div className="pane-meta">
            <div className="pane-from">
              <span className="pane-name">{email.fromName ?? email.fromAddr}</span>
              {email.fromName && <span className="muted">&lt;{email.fromAddr}&gt;</span>}
            </div>
            <div className="pane-sub">
              {body?.to.length ? <span>To {body.to.join(', ')}</span> : null}
              {body?.cc.length ? <span>Cc {body.cc.join(', ')}</span> : null}
            </div>
            <div className="pane-sub">
              <span className="mono">{new Date(email.receivedAt).toLocaleString()}</span>
              <span>· {email.accountAddress}</span>
              {email.category && <span>· {CATEGORY_LABEL[email.category]}</span>}
              <EmailLabels email={email} />
            </div>
          </div>
        )}
      </header>

      {email && <AssistantPanel email={email} />}

      {hasRemoteImages && !showImages && (
        <div className="pane-notice">
          Remote images are blocked to keep senders from tracking when you open this.
          <button className="btn" onClick={() => setShowImages(true)}>
            Load images
          </button>
        </div>
      )}

      <div className="pane-body">
        {error && <div className="placeholder">Couldn&apos;t load this email: {error}</div>}
        {!error && !body && <div className="placeholder">Loading…</div>}
        {body && (
          <iframe
            title="Email body"
            // No allow-scripts and no allow-same-origin: the email can't run code or reach the app.
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            srcDoc={srcDoc}
          />
        )}
      </div>
    </article>
  )
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!
  )
}

function buildDocument(body: EmailBody, showImages: boolean): string {
  const content = body.html ?? `<pre>${escapeHtml(body.text ?? '')}</pre>`
  const images = showImages ? 'data: cid: https: http:' : 'data: cid:'
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${images}; font-src data:">
<base target="_blank">
<style>
  html { color-scheme: light; }
  body { margin: 0; padding: 20px 24px; background: #fff; color: #1d1d1f;
         font: 14px/1.55 'Segoe UI', system-ui, sans-serif; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  pre { margin: 0; white-space: pre-wrap; font: inherit; }
  a { color: #3b49c9; }
  table { max-width: 100%; }
</style></head><body>${content}</body></html>`
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
