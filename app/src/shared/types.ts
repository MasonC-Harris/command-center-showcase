// Types shared by the main process, preload bridge, and renderer.

/**
 * "google" covers both Gmail and Google Calendar for one Google account. "canvas" is a school
 * account (assignments only, no mail or calendar), so it is left out of the mail views.
 */
export type Provider = 'google' | 'outlook' | 'icloud' | 'canvas' | 'demo'

/** Providers that bring mail in, and so take part in the Inbox, scope switcher and backfill. */
export const MAIL_PROVIDERS = ['google', 'outlook', 'icloud', 'demo'] as const

export function isMailProvider(provider: Provider): boolean {
  return (MAIL_PROVIDERS as readonly string[]).includes(provider)
}

export type Priority = 'urgent' | 'needs_reply' | 'fyi' | 'newsletter' | 'junk'

export type Category = 'bills' | 'work' | 'school' | 'personal' | 'shopping' | 'security' | 'other'

export type TaskStatus = 'open' | 'done'

/** Position in a newest-first email list: the last email already shown. */
export interface EmailCursor {
  receivedAt: string
  id: string
}

/** Which account a view shows: one account id, or null for all accounts combined. */
export type AccountScope = string | null

export interface Account {
  id: string
  provider: Provider
  address: string
  status: 'connected' | 'disconnected' | 'error'
  lastSync: string | null
  /** Human-readable reason for the last failed sync, if any. */
  lastError: string | null
  /** Unread mail in this account's inbox. */
  unread: number
  /** The user's main account: listed first and used as the default. */
  isPrimary: boolean
  /** Outlook only: the account allowed the assistant to add calendar events. */
  canWriteCalendar: boolean
}

export interface EmailSummary {
  id: string
  accountAddress: string
  fromName: string | null
  fromAddr: string
  subject: string
  snippet: string
  receivedAt: string
  isRead: boolean
  /** Opens the message in the provider's web client. Null for demo mail. */
  webUrl: string | null
  /** Null until the classifier has run on this email. */
  priority: Priority | null
  category: Category | null
  needsReply: number | null
  importance: number | null
  confidence: number | null
  /** The user corrected this email's labels; their correction wins over Jev. */
  overridden: boolean
  /** Jev's own answer, kept so the UI can show what was corrected. */
  modelPriority: Priority | null
}

/** A message body, fetched on demand when an email is opened. Never stored. */
export interface EmailBody {
  html: string | null
  text: string | null
  to: string[]
  cc: string[]
}

/** The AI services the assistant can run on. One is active at a time. */
export type AssistantProvider = 'anthropic' | 'openai' | 'gemini' | 'groq' | 'openrouter'

export interface AssistantProviderInfo {
  id: AssistantProvider
  name: string
  /** Maker of the service, shown under the name. */
  maker: string
  /** True once an API key for it is stored on this PC. */
  connected: boolean
  /** The model this provider runs, once chosen. */
  model: string | null
  /** Models the key can actually see, newest-looking first. Empty until it is connected. */
  models: string[]
  /** Opened in the browser by Connect: sign in there, create a key, paste it back. */
  consoleUrl: string
  /** Shape of the key, e.g. "sk-ant-…". */
  keyHint: string
  /** One line under the key box: what the service charges for and what it won't do. */
  note: string
  /** Set when the last call to this provider failed, so Settings can explain it. */
  lastError: string | null
}

export interface AssistantSettings {
  /** The provider every assistant feature uses right now. */
  active: AssistantProvider
  /** True when the active provider has a key; nothing AI works without one. */
  hasKey: boolean
  /** Active provider and model, for headers and labels, e.g. "Claude · claude-opus-5". */
  label: string
  providers: AssistantProviderInfo[]
}

/** Groq's summary of one email. */
export interface EmailSummaryAI {
  summary: string
  keyPoints: string[]
  actionsForMe: string[]
  model: string
}

export interface EmailDraft {
  body: string
  model: string
}

/** A task the assistant created during a chat reply; the renderer shows it with an Undo button. */
export interface ChatTaskAction {
  /** What the assistant created; missing means a task (older replies). */
  kind?: 'task' | 'event'
  taskId: string
  title: string
  due: string | null
  remindAt: string | null
  /** For events: the Outlook account and event id (used by Undo) and a readable schedule. */
  eventAccountId?: string
  eventId?: string
  detail?: string
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
  /** Tasks created while producing this reply. Display only; never sent to the model. */
  actions?: ChatTaskAction[]
}

export interface TaskSuggestion {
  title: string
  due: string | null
}

/** A correction to Jev's labels. Omitted fields keep their current value. */
export interface EmailOverride {
  priority?: Priority
  category?: Category
  needsReply?: boolean
}

/** Which list to page through: the Inbox, low-confidence mail waiting for review, or hidden mail. */
export type MailView = 'inbox' | 'review' | 'hidden'

export interface CalendarEvent {
  id: string
  title: string
  start: string
  end: string
  allDay: boolean
  /** Account the event was synced from, and the calendar it lives on in that account. */
  accountAddress: string | null
  calendarName: string | null
  location: string | null
  /** Video-call link, if the event has one. */
  link: string | null
  attendees: string[]
}

export interface Task {
  id: string
  title: string
  due: string | null
  status: TaskStatus
  sourceEmailId: string | null
  /** Free-form notes, so a task can double as a personal note. */
  notes: string | null
  /** When to show a desktop reminder (while Command Center is running). */
  remindAt: string | null
}

/** Fields that can be edited on a task; omitted fields stay as they are. */
export interface TaskUpdate {
  title?: string
  notes?: string | null
  due?: string | null
  remindAt?: string | null
}

/** What Canvas calls the work: an assignment, a quiz, a graded discussion, a to-do note, ... */
export type AssignmentKind =
  'assignment' | 'quiz' | 'discussion' | 'page' | 'note' | 'peer_review' | 'other'

/** How far ahead the assignments tile looks: the rest of today, 7 days, or 30 days. */
export type AssignmentRange = 'day' | 'week' | 'month'

export interface Assignment {
  id: string
  /** The Canvas account the item came from. */
  accountId: string
  courseName: string | null
  /** Short course code, e.g. "CS-162". */
  courseCode: string | null
  title: string
  kind: AssignmentKind
  /** When it is due. Null for Canvas items with no date. */
  due: string | null
  pointsPossible: number | null
  /** Opens the item in Canvas in the browser. */
  url: string | null
  submitted: boolean
  graded: boolean
  /** Canvas marked it missing: past due with nothing handed in. */
  missing: boolean
  /** Ticked off in Command Center. Canvas is never changed. */
  done: boolean
}

export interface AssignmentsData {
  range: AssignmentRange
  /** Due inside the range, soonest first. */
  items: Assignment[]
  /** Past due, still not handed in or ticked off. Shown whatever the range is. */
  overdue: Assignment[]
  /** False while no Canvas account is connected, so the UI can offer to connect one. */
  connected: boolean
}

export interface CanvasSettings {
  connected: boolean
  /** Canvas host, e.g. "school.instructure.com". */
  host: string | null
  /** Name or login Canvas reports for the token's owner. */
  user: string | null
  /** The timeframe the Today tile opens on. */
  range: AssignmentRange
  lastSync: string | null
  lastError: string | null
  /** Items stored locally for this account. */
  stored: number
}

/** "summary" is the built-in one-liner; "steps" is a short plan written by Groq. */
export type BriefStyle = 'summary' | 'steps'

export interface BriefStep {
  text: string
  /** Why it is next, e.g. "due 5pm, nothing handed in". */
  detail: string | null
}

/** Today's concrete-steps brief. Written once per day and cached until refreshed. */
export interface BriefPlan {
  headline: string
  steps: BriefStep[]
  model: string
  generatedAt: string
}

export type FinanceKind = 'bill' | 'subscription' | 'receipt' | 'income'
export type FinanceStatus = 'open' | 'paid' | 'ignored'

export interface FinanceItem {
  id: string
  kind: FinanceKind
  merchant: string
  amountCents: number
  currency: string
  /** Bill due date or subscription renewal date. */
  due: string | null
  occurredAt: string
  status: FinanceStatus
  sourceEmailId: string | null
  notes: string | null
}

export interface FinanceItemInput {
  kind: FinanceKind
  merchant: string
  amountCents: number
  currency: string
  due: string | null
  occurredAt: string
  status: FinanceStatus
  notes: string | null
  /** New items only: the email the item came from. */
  sourceEmailId?: string | null
}

/** A bank or card balance the user enters by hand. */
export interface AccountBalance {
  id: string
  name: string
  amountCents: number
  currency: string
  updatedAt: string
}

export interface AccountBalanceInput {
  name: string
  amountCents: number
  currency: string
}

/** A recent bill-like email that isn't in Finance yet. */
export interface FinanceEmail {
  id: string
  fromName: string | null
  fromAddr: string
  subject: string
  snippet: string
  receivedAt: string
  /** First dollar amount in the subject or preview, if any. */
  amountCents: number | null
}

export interface ApiUsageTotals {
  requests: number
  inputTokens: number
  outputTokens: number
  /** USD at the provider's published rates, for the models the app has rates for. */
  cost: number
  /** Requests on models with no published rate: counted here, left out of `cost`. */
  unpricedRequests: number
}

/** Usage and spend for one connected API (TypeSafe, Groq, ...). */
export interface ApiUsageSummary {
  id: string
  name: string
  connected: boolean
  billingUrl: string
  note: string | null
  /** Calls made before usage tracking began, counted from past results with estimated tokens. */
  estimatedRequests: number
  today: ApiUsageTotals
  month: ApiUsageTotals
  total: ApiUsageTotals
  /** The balance the user entered, minus spend since then. */
  balance: { amount: number; setAt: string; remaining: number } | null
  /** Latest rate limits reported by the provider, if it sends them. */
  limits: {
    model: string
    requestsLimit: number | null
    requestsRemaining: number | null
    tokensLimit: number | null
    tokensRemaining: number | null
    at: string
  } | null
}

export interface FinanceScanStatus {
  running: boolean
  done: number
  total: number
  /** Items added by the last (or current) scan. */
  found: number
  error: string | null
  hasKey: boolean
}

export interface ClassifierStatus {
  /** running: key set and enabled; paused: no key or the last call failed; disabled: turned off. */
  state: 'running' | 'paused' | 'disabled'
  model: string | null
  /** Recent Inbox mail still waiting to be classified. */
  unclassified: number
  /** A classification batch is in progress. */
  working: boolean
}

export interface ClassifierSettings {
  hasKey: boolean
  enabled: boolean
  lastError: string | null
  model: string | null
}

export interface TodayStats {
  unread: number
  needsReply: number
  meetingsToday: number
  tasksDue: number
  /** Canvas items due inside the chosen timeframe, plus anything overdue. */
  assignmentsDue: number
}

export interface TodayData {
  generatedAt: string
  /** True while the app is showing seeded placeholder data instead of real accounts. */
  isDemo: boolean
  /** The built-in one-line summary. The steps brief is fetched separately, only when asked for. */
  brief: string
  assignments: AssignmentsData
  accounts: Account[]
  priorityInbox: EmailSummary[]
  needsReply: EmailSummary[]
  upcoming: CalendarEvent[]
  schedule: CalendarEvent[]
  allDay: CalendarEvent[]
  tasks: Task[]
  stats: TodayStats
  classifier: ClassifierStatus
}

export interface SyncStatus {
  syncing: boolean
  /** False until client_secret_google.json is found. */
  googleClientConfigured: boolean
}

/** A key combo. `key` is KeyboardEvent.key lowercased, e.g. 'k', '1', 'escape'. */
export interface Keybinding {
  key: string
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
}

/** Only actions the user rebound; everything else uses the default in the renderer's registry. */
export type KeybindingOverrides = Record<string, Keybinding>

/**
 * Built-in palettes, plus "custom" for one of the two bases with a colour of the user's choosing.
 * The values live in renderer/src/styles/tokens.css; these ids select them.
 */
export type ThemeId = 'dark' | 'light' | 'midnight' | 'forest' | 'grove' | 'ember' | 'custom'

/** Which base palette a custom theme builds on. */
export type ThemeBase = 'dark' | 'light'

export interface ThemeSettings {
  id: ThemeId
  /** Custom only: the palette the surfaces come from. Kept for every theme so the editor opens on it. */
  base: ThemeBase
  /** Custom only: the one accent colour, as #rrggbb. */
  accent: string
}

export interface LaunchAtLogin {
  /** False in development builds; only the installed app can register itself. */
  supported: boolean
  enabled: boolean
}

export interface CommandCenterApi {
  getToday(scope: AccountScope): Promise<TodayData>
  setTaskStatus(id: string, status: TaskStatus): Promise<void>
  /** One page (default 50) of mail, newest first; pass `before` to continue after a page. */
  searchEmails(
    query: string,
    scope: AccountScope,
    before?: EmailCursor | null,
    limit?: number,
    view?: MailView
  ): Promise<EmailSummary[]>
  getEmail(emailId: string): Promise<EmailSummary | null>
  /** Hides an email in Command Center only; Gmail and Outlook are not changed. */
  hideEmail(emailId: string): Promise<void>
  unhideEmail(emailId: string): Promise<void>
  /** Hides everything in the Inbox for the scope; resolves with the hidden ids (for undo). */
  hideAllInbox(scope: AccountScope): Promise<string[]>
  /** Restores the given hidden emails, or all hidden mail in scope when ids is null. */
  unhideMany(ids: string[] | null, scope: AccountScope): Promise<number>
  /** Fetches the full message from Gmail or Outlook. */
  getEmailBody(emailId: string): Promise<EmailBody>
  /** Low-confidence mail not yet reviewed. */
  countReview(scope: AccountScope): Promise<number>
  /**
   * Corrects an email's labels; null clears the correction and goes back to Jev's answer.
   * "Confirming" Jev's answer is a correction with the same priority.
   */
  setEmailOverride(emailId: string, override: EmailOverride | null): Promise<void>
  /**
   * Fetches the next batch of older Inbox mail from the providers. `done` is true once there is
   * nothing older anywhere in scope.
   */
  loadOlderMail(scope: AccountScope): Promise<{ fetched: number; done: boolean }>
  getAgenda(days: number, scope: AccountScope): Promise<CalendarEvent[]>
  /** Events overlapping [start, end) for any range; months outside the sync window load live. */
  getEventsRange(start: string, end: string, scope: AccountScope): Promise<CalendarEvent[]>
  listAccounts(): Promise<Account[]>
  getSyncStatus(): Promise<SyncStatus>
  /** Opens the Google sign-in page in the default browser and resolves once the account is connected. */
  connectGoogle(): Promise<Account>
  connectOutlook(): Promise<Account>
  /** iCloud Mail over IMAP with an app-specific password (mail only, read-only). */
  connectIcloud(address: string, appPassword: string): Promise<Account>
  /**
   * Canvas with a user access token from Canvas → Account → Settings. `baseUrl` is the school's
   * Canvas address, e.g. https://school.instructure.com. Read-only; assignments only.
   */
  connectCanvas(baseUrl: string, token: string): Promise<Account>
  getCanvasSettings(): Promise<CanvasSettings>
  setPrimaryAccount(id: string): Promise<void>
  /** Abandons a sign-in that is waiting on the browser. */
  cancelConnect(): Promise<void>
  disconnectAccount(id: string): Promise<void>
  syncNow(): Promise<void>
  getClassifierSettings(): Promise<ClassifierSettings>
  /** Verifies and stores the TypeSafe API key; null removes it. */
  setTypeSafeKey(apiKey: string | null): Promise<ClassifierSettings>
  setClassifierEnabled(enabled: boolean): Promise<ClassifierSettings>
  getAssistantSettings(): Promise<AssistantSettings>
  /**
   * Verifies and stores one provider's API key, then lists the models that key can see; null
   * removes the key. Connecting a provider does not switch to it.
   */
  setProviderKey(provider: AssistantProvider, apiKey: string | null): Promise<AssistantSettings>
  /** Switches every assistant feature to this provider. It has to be connected first. */
  setAssistantProvider(provider: AssistantProvider): Promise<AssistantSettings>
  /** Picks which of the provider's models to use. */
  setProviderModel(provider: AssistantProvider, model: string): Promise<AssistantSettings>
  /** Opens the provider's sign-in and API-keys page in the default browser. */
  openProviderConsole(provider: AssistantProvider): Promise<void>
  /** Re-reads the models the stored key can see (they change as providers ship new ones). */
  refreshProviderModels(provider: AssistantProvider): Promise<AssistantSettings>
  summarizeEmail(emailId: string): Promise<EmailSummaryAI>
  /** Drafts a reply; `instructions` steers it ("shorter", "decline politely"). Never sends. */
  draftReply(emailId: string, instructions: string): Promise<EmailDraft>
  suggestTask(emailId: string): Promise<TaskSuggestion>
  /**
   * Streams a chat reply from Groq. `onDelta` receives text as it arrives; resolves when done.
   * With `includeDay`, a snapshot of today's events, priority mail and tasks is shared.
   */
  chat(
    requestId: string,
    turns: ChatTurn[],
    includeDay: boolean,
    onDelta: (text: string) => void,
    onAction?: (action: ChatTaskAction) => void
  ): Promise<void>
  /**
   * Streams an answer to a follow-up question about today's brief. Same transport as `chat`, with
   * a prompt that keeps the assistant on today's mail, calendar, tasks and assignments.
   */
  askBrief(
    requestId: string,
    turns: ChatTurn[],
    onDelta: (text: string) => void,
    onAction?: (action: ChatTaskAction) => void
  ): Promise<void>
  cancelChat(requestId: string): Promise<void>
  getBriefStyle(): Promise<BriefStyle>
  setBriefStyle(style: BriefStyle): Promise<BriefStyle>
  /**
   * Today's concrete-steps brief. Returns the one already written unless `force`, so opening
   * Today doesn't spend tokens again.
   */
  generateBriefPlan(force: boolean): Promise<BriefPlan>
  /** Canvas items due in the timeframe, plus anything overdue. */
  listAssignments(range: AssignmentRange): Promise<AssignmentsData>
  /** Stores the timeframe the assignments tile opens on. */
  setAssignmentRange(range: AssignmentRange): Promise<AssignmentRange>
  /** Ticks an assignment off in Command Center only; Canvas is not changed. */
  setAssignmentDone(id: string, done: boolean): Promise<void>
  /** Removes an event the assistant added (a repeating event's whole series). */
  deleteCalendarEvent(accountId: string, eventId: string): Promise<void>
  listTasks(): Promise<Task[]>
  createTask(title: string, due: string | null, sourceEmailId: string | null): Promise<Task>
  deleteTask(id: string): Promise<void>
  updateTask(id: string, update: TaskUpdate): Promise<Task>
  listFinanceItems(): Promise<FinanceItem[]>
  saveFinanceItem(id: string | null, input: FinanceItemInput): Promise<FinanceItem>
  deleteFinanceItem(id: string): Promise<void>
  getFinanceScanStatus(): Promise<FinanceScanStatus>
  /** Sends sender, subject, date and snippet (never the body) of recent finance-looking mail to Groq. */
  scanFinanceMail(): Promise<FinanceScanStatus>
  getApiUsage(): Promise<ApiUsageSummary[]>
  /** Bill-like mail not in Finance yet, and how many were hidden from that list. */
  listFinanceEmails(): Promise<{ emails: FinanceEmail[]; hidden: number }>
  /** Hides emails from Finance's "From your mail" list (the Inbox is not affected). */
  hideFinanceEmails(ids: string[]): Promise<void>
  restoreFinanceEmails(): Promise<number>
  listBalances(): Promise<AccountBalance[]>
  saveBalance(id: string | null, input: AccountBalanceInput): Promise<AccountBalance>
  deleteBalance(id: string): Promise<void>
  /** Sets the credit currently on the account (null clears it); later spend comes off it. */
  setApiBalance(provider: string, amount: number | null): Promise<void>
  /** Fires when the app asks a window to show a view, e.g. after clicking a reminder. */
  onNavigate(callback: (view: string) => void): () => void
  getLaunchAtLogin(): Promise<LaunchAtLogin>
  setLaunchAtLogin(enabled: boolean): Promise<LaunchAtLogin>
  /** Whether closing the window hides it to the tray instead of quitting. Default on. */
  getKeepInTray(): Promise<boolean>
  setKeepInTray(enabled: boolean): Promise<boolean>
  getTheme(): Promise<ThemeSettings>
  /** Stores the theme; returns what was kept after validation. */
  setTheme(theme: ThemeSettings): Promise<ThemeSettings>
  getKeybindings(): Promise<KeybindingOverrides>
  /** Replaces all overrides; returns what was stored after validation. */
  setKeybindings(overrides: KeybindingOverrides): Promise<KeybindingOverrides>
  /** Fires whenever synced data or sync status changes. Returns an unsubscribe function. */
  onDataChanged(callback: () => void): () => void
}

export const IPC = {
  getToday: 'today:get',
  setTaskStatus: 'tasks:set-status',
  searchEmails: 'emails:search',
  loadOlderMail: 'emails:load-older',
  countReview: 'emails:count-review',
  getEmail: 'emails:get',
  hideEmail: 'emails:hide',
  unhideEmail: 'emails:unhide',
  hideAllInbox: 'emails:hide-all',
  unhideMany: 'emails:unhide-many',
  getEmailBody: 'emails:body',
  setEmailOverride: 'emails:set-override',
  getAgenda: 'events:agenda',
  getEventsRange: 'events:range',
  listAccounts: 'accounts:list',
  getSyncStatus: 'sync:status',
  connectGoogle: 'accounts:connect-google',
  connectOutlook: 'accounts:connect-outlook',
  connectIcloud: 'accounts:connect-icloud',
  connectCanvas: 'accounts:connect-canvas',
  getCanvasSettings: 'canvas:settings',
  listAssignments: 'assignments:list',
  setAssignmentRange: 'assignments:set-range',
  setAssignmentDone: 'assignments:set-done',
  setPrimaryAccount: 'accounts:set-primary',
  cancelConnect: 'accounts:cancel-connect',
  disconnectAccount: 'accounts:disconnect',
  syncNow: 'sync:now',
  getClassifierSettings: 'classifier:settings',
  setTypeSafeKey: 'classifier:set-key',
  setClassifierEnabled: 'classifier:set-enabled',
  getAssistantSettings: 'assistant:settings',
  setProviderKey: 'assistant:set-key',
  setAssistantProvider: 'assistant:set-provider',
  setProviderModel: 'assistant:set-model',
  openProviderConsole: 'assistant:open-console',
  refreshProviderModels: 'assistant:refresh-models',
  getTheme: 'theme:get',
  setTheme: 'theme:set',
  summarizeEmail: 'assistant:summarize',
  draftReply: 'assistant:draft-reply',
  suggestTask: 'assistant:suggest-task',
  chat: 'assistant:chat',
  chatDelta: 'assistant:chat-delta',
  chatAction: 'assistant:chat-action',
  cancelChat: 'assistant:chat-cancel',
  askBrief: 'brief:ask',
  getBriefStyle: 'brief:get-style',
  setBriefStyle: 'brief:set-style',
  generateBriefPlan: 'brief:generate',
  deleteCalendarEvent: 'events:delete',
  listTasks: 'tasks:list',
  createTask: 'tasks:create',
  deleteTask: 'tasks:delete',
  updateTask: 'tasks:update',
  listFinanceItems: 'finance:list',
  saveFinanceItem: 'finance:save',
  deleteFinanceItem: 'finance:delete',
  getFinanceScanStatus: 'finance:scan-status',
  scanFinanceMail: 'finance:scan',
  getApiUsage: 'api-usage:get',
  listFinanceEmails: 'finance:emails',
  hideFinanceEmails: 'finance:emails-hide',
  restoreFinanceEmails: 'finance:emails-restore',
  listBalances: 'balances:list',
  saveBalance: 'balances:save',
  deleteBalance: 'balances:delete',
  setApiBalance: 'api-usage:set-balance',
  navigate: 'app:navigate',
  getLaunchAtLogin: 'system:get-launch-at-login',
  setLaunchAtLogin: 'system:set-launch-at-login',
  getKeepInTray: 'system:get-keep-in-tray',
  setKeepInTray: 'system:set-keep-in-tray',
  getKeybindings: 'settings:get-keybindings',
  setKeybindings: 'settings:set-keybindings',
  dataChanged: 'data:changed'
} as const
