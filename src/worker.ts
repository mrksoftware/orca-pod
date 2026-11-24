// Pod worker: owns the board. For each queued task it starts an agent (up to `maxParallel` of
// Pod's own running at once): in a fresh worktree for a Git project, or in the existing workspace
// of a folder project or a bot. It adopts agents started in Orca directly, follows every agent's
// status through agent.status.changed, and answers the panel. Tasks live in orca.storage so they
// survive worker and Orca restarts.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import type { PodState, Target, Task, TaskState } from './protocol'
import { LANGS, translator } from './messages'

/** The Orca CLI. The plugin host API has no way to write into a chat, so messages for bots go
 *  through `orca orchestration send --to bot:<name>`, the documented way to reach a bot. On
 *  Windows it must be orca.exe: orca.cmd refuses `orchestration send`. */
function orcaCli(): string {
  const candidates = [
    process.env.ORCA_CLI_COMMAND,
    join(dirname(process.execPath), 'resources', 'bin', process.platform === 'win32' ? 'orca.exe' : 'orca'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'orca', 'resources', 'bin', 'orca.exe'),
    join(homedir(), 'AppData', 'Local', 'Programs', 'orca', 'resources', 'bin', 'orca.exe'),
  ]
  for (const c of candidates) if (c && existsSync(c)) return c
  return 'orca'
}

/** Orca runs plugin workers with a trimmed environment; the CLI needs the user's profile folders
 *  (APPDATA on Windows) to find the running Orca. */
function cliEnv(): Record<string, string | undefined> {
  const home = homedir()
  const env: Record<string, string | undefined> = { ...process.env }
  env.HOME ??= home
  if (process.platform === 'win32') {
    env.USERPROFILE ??= home
    env.APPDATA ??= join(home, 'AppData', 'Roaming')
    env.LOCALAPPDATA ??= join(home, 'AppData', 'Local')
  }
  return env
}

let runner: (args: string[]) => Promise<unknown> = (args) => execOrca(args)
/** Runs the Orca CLI; tests swap it with `setOrcaRunner`. */
const runOrca = (args: string[]) => runner(args)
export function setOrcaRunner(fn: ((args: string[]) => Promise<unknown>) | null): void {
  runner = fn ?? ((args) => execOrca(args))
}

/** Runs the Orca CLI with arguments (no shell) and returns its JSON `result`. */
function execOrca(args: string[], cli = orcaCli()): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const p = spawn(cli, [...args, '--json'], { windowsHide: true, env: cliEnv() })
    let out = ''
    let err = ''
    // A CLI call that hangs must not leave a card in "Sending…" forever.
    const timer = setTimeout(() => {
      p.kill()
      reject(new Error('timeout: orca ' + args.slice(0, 2).join(' ') + ' did not answer in ' + CLI_TIMEOUT_MS / 1000 + 's'))
    }, CLI_TIMEOUT_MS)
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    p.on('close', () => {
      clearTimeout(timer)
      try {
        const j = JSON.parse(out) as { ok: boolean; result?: unknown; error?: { code?: string; message?: string } }
        if (j.ok) resolve(j.result)
        else {
          const what = [j.error?.code, j.error?.message].filter(Boolean).join(': ')
          reject(new Error(what || out.trim().slice(0, 300) || err.trim().slice(0, 300) || 'orca ' + args.slice(0, 2).join(' ') + ' failed'))
        }
      } catch {
        reject(new Error((err || out || 'orca ' + args.slice(0, 2).join(' ') + ' failed').trim().slice(0, 300)))
      }
    })
  })
}

const TASKS = 'tasks'
const DISMISSED = 'dismissed'
const LAST_TARGET = 'lastTargetId'
const CLI_TIMEOUT_MS = 60_000
/** How long after a launch or a message an "idle" report is taken as "not started yet". */
const PICKUP_GRACE_MS = 10 * 60_000
/** How often `orca agent list` is read for the agents' last replies. */
const REPLIES_EVERY_MS = 8_000
/** Bot workspace id -> the "Pod" terminal that sends its mail. */
const MAILBOXES = 'mailboxes'
const AGENT_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex' }
const STOP = new Set(['di', 'a', 'al', 'alla', 'allo', 'su', 'sul', 'sulla', 'in', 'il', 'lo', 'la', 'le', 'i', 'gli', 'del', 'della', 'dei', 'delle', 'per', 'e', 'con', 'da', 'un', 'una', 'nel', 'nella', 'ai', 'agli', 'the', 'to', 'of', 'and'])
/** An agent found already idle is adopted only if it finished this recently. */
const RECENT_DONE_MS = 2 * 60 * 60 * 1000
const DISCOVER_EVERY_MS = 20_000
const WORKSPACES_TTL_MS = 15_000

type AgentState = 'working' | 'blocked' | 'waiting' | 'done'
type AgentRow = {
  terminalId: string | null
  title: string | null
  agent: string | null
  state: AgentState
  stateStartedAt: number
  sessionId?: string | null
  task?: { title: string } | null
}
type WorkspaceRow = {
  id: string
  kind?: 'worktree' | 'folder'
  name: string
  project?: string | null
  projectId?: string | null
  branch: string | null
  hostId: string | null
  status?: { state: string; lastActivityAt: number | null }
}

/** Orca's agent state -> Pod's board column. An agent idle after its turn reports `done`. */
export function columnFor(state: AgentState): TaskState {
  if (state === 'working') return 'running'
  if (state === 'done') return 'done'
  return 'waiting'
}

export function slug(title: string): string {
  const s = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w && !STOP.has(w))
    .slice(0, 4)
    .join('-')
  return s || 'task'
}

/** Strips TUI chrome (box drawing, prompts, hints) from terminal lines and keeps the text. */
export function cleanLines(lines: string[]): string[] {
  const out: string[] = []
  for (const raw of lines) {
    const l = raw
      .replace(/[─-▟⠀-⣿⎿⏵⏺✻✢✳✶✽·]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (l.length < 3 || !/[a-z0-9]/i.test(l)) continue
    if (/^(>|›|\$\s*$|Tip:)/.test(l)) continue
    if (/(\? for shortcuts|esc to interrupt|bypass permissions|accept edits|auto-accept|ctrl\+[a-z] to|shift\+tab)/i.test(l)) continue
    // agent status lines: "repo | model effort (alt+p) | ctx:33%"
    if (/\bctx:\s*\d+%|\(alt\+[a-z]|\btokens?\b.*\|/i.test(l) || (l.match(/ \| /g) ?? []).length >= 2) continue
    out.push(l.length > 240 ? l.slice(0, 239) + '…' : l)
  }
  return out
}

/** Usage-limit messages of Claude Code and Codex, e.g. "Claude usage limit reached. Your limit will
 *  reset at 3pm", "5-hour limit reached ∙ resets 3pm", "You've hit your limit · resets 7pm".
 *  Answers the reset time ('' when none is given), or null when the text is no limit message. */
export function detectLimit(text: string): string | null {
  const s = text.replace(/\s+/g, ' ')
  if (!/(usage limit (reached|hit)|you'?ve hit your (usage )?limit|(\d+-hour|weekly|opus|session|daily) limit reached|limit will reset|out of (extra )?usage)/i.test(s)) return null
  const m = /reset(?:s)?(?: at)?\s+([0-9][^·∙|.\n]{0,40}|[a-z]{3,9} [0-9][^·∙|.\n]{0,30})/i.exec(s)
  return m ? m[1].trim() : ''
}

/** Stable key of an agent: its terminal, or for a chat its session. */
export function agentKey(a: { terminalId?: string | null; sessionId?: string | null }): string | null {
  if (a.terminalId) return 'term:' + a.terminalId
  if (a.sessionId) return 'session:' + a.sessionId
  return null
}

function taskKey(t: Task): string | null {
  return agentKey(t)
}

function newId(): string {
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function errMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  return String(e)
}

export default function activate(orca: OrcaWorkerApi): void {
  let tasks: Task[] = []
  /** Agent key -> when it was taken off the board; it comes back only with newer activity. */
  let dismissed: Record<string, number> = {}
  let wsCache = new Map<string, WorkspaceRow>()
  let wsAt = 0
  let lastDiscover = 0
  let chain: Promise<unknown> = Promise.resolve()
  /** Strings in the selected language (setting `language`, English by default). */
  let tr = translator('en')
  const agentLabel = (a: string) => AGENT_NAMES[a] ?? a
  const ready = (async () => {
    tr = translator(String((await orca.settings.get('language')) ?? 'en'))
    const [v, d] = await Promise.all([orca.storage.get(TASKS), orca.storage.get(DISMISSED)])
    tasks = Array.isArray(v) ? (v as unknown as Task[]) : []
    for (const t of tasks) if (!t.source) t.source = 'pod'
    // A launch or send cut off by a worker restart never finished: show it as failed so it can be
    // retried by hand. It is not resent on its own, so a bot never gets the same message twice.
    for (const t of tasks) {
      if (t.source !== 'pod' || t.state !== 'running' || t.error) continue
      const started = t.bot ? !!t.sentAt : t.launchIn ? !!t.terminalId : !!t.workspaceId
      if (started) continue
      t.error = tr('err.interrupted')
      t.state = 'waiting'
      t.since = Date.now()
      t.timeline.push({ s: 'waiting', at: t.since, note: tr('note.failed') })
      t.question = tr('q.failed', { e: t.error })
    }
    dismissed = d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, number>) : {}
  })()

  /** Runs mutations one at a time so events and requests never interleave half-way. */
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(async () => {
      await ready
      return fn()
    })
    chain = next.catch(() => undefined)
    return next
  }

  async function settings() {
    const s = await orca.settings.get()
    // 0 (the default) means no limit.
    const maxParallel = typeof s.maxParallel === 'number' && s.maxParallel > 0 ? s.maxParallel : 0
    const doneVisible = typeof s.doneVisible === 'number' ? s.doneVisible : 6
    const defaultAgent = typeof s.defaultAgent === 'string' ? s.defaultAgent : 'claude'
    const showOrcaAgents = s.showOrcaAgents !== false
    const language = typeof s.language === 'string' && (LANGS as string[]).includes(s.language) ? s.language : 'en'
    return { maxParallel, doneVisible, defaultAgent, showOrcaAgents, language }
  }

  /** Every place a task can run: Git projects (new worktree), folder projects and bots (their
   *  existing workspace). Bots are folder workspaces that belong to no project. */
  async function targets(): Promise<Target[]> {
    const out: Target[] = []
    let projects: { id: string; name: string; kind: 'git' | 'folder'; hostId: string | null }[] = []
    try {
      projects = (await orca.host.call('project.list')).projects
    } catch (e) {
      orca.log('project.list failed: ' + errMessage(e))
    }
    const ws = [...(await workspaces()).values()]
    for (const p of projects) {
      if (p.kind === 'git') {
        out.push({ id: 'p:' + p.id, name: p.name, kind: 'git', projectId: p.id, hostId: p.hostId })
        continue
      }
      const w = ws.find((x) => x.projectId === p.id && x.kind === 'folder') ?? ws.find((x) => x.projectId === p.id)
      if (w) out.push({ id: 'w:' + w.id, name: p.name, kind: 'folder', projectId: p.id, workspaceId: w.id, hostId: p.hostId })
    }
    for (const w of ws) {
      if (w.kind === 'folder' && !w.projectId) out.push({ id: 'w:' + w.id, name: w.name, kind: 'bot', workspaceId: w.id, bot: w.name, hostId: w.hostId })
    }
    const order = { git: 0, folder: 1, bot: 2 }
    return out.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name))
  }

  async function workspaces(force = false): Promise<Map<string, WorkspaceRow>> {
    if (!force && Date.now() - wsAt < WORKSPACES_TTL_MS) return wsCache
    try {
      const r = await orca.host.call('workspace.list', { includeStatus: true })
      wsCache = new Map(r.workspaces.map((w) => [w.id, w as WorkspaceRow]))
      wsAt = Date.now()
    } catch (e) {
      orca.log('workspace.list failed: ' + errMessage(e))
    }
    return wsCache
  }

  const plain = () => JSON.parse(JSON.stringify(tasks)) as Task[]

  async function snapshot(): Promise<PodState> {
    const [s, ts, last] = await Promise.all([settings(), targets(), orca.storage.get(LAST_TARGET)])
    return {
      tasks: plain(),
      targets: ts,
      defaultAgent: s.defaultAgent,
      defaultTargetId: typeof last === 'string' && ts.some((t) => t.id === last) ? last : (ts[0]?.id ?? null),
      maxParallel: s.maxParallel,
      language: s.language,
    }
  }

  function move(t: Task, state: TaskState, note?: string, at = Date.now()): void {
    if (t.state === state) return
    t.state = state
    t.since = at
    t.timeline.push(note ? { s: state, at, note } : { s: state, at })
    if (state !== 'waiting') t.question = undefined
  }

  function dismiss(t: Task): void {
    const k = taskKey(t)
    if (t.source === 'orca' && k) dismissed[k] = Date.now()
  }

  async function save(): Promise<void> {
    const { doneVisible } = await settings()
    const done = tasks.filter((t) => t.state === 'done').sort((a, b) => b.since - a.since)
    if (done.length > doneVisible) {
      const drop = new Set(done.slice(doneVisible).map((t) => t.id))
      for (const t of tasks) if (drop.has(t.id)) dismiss(t)
      tasks = tasks.filter((t) => !drop.has(t.id))
    }
    // A JSON copy drops `undefined` fields, which storage and posts refuse. The live objects stay:
    // launch() holds references to them.
    const copy = plain()
    await orca.storage.set(TASKS, copy as unknown as never)
    await orca.storage.set(DISMISSED, dismissed)
    orca.panels.post('pod.changed', { tasks: copy })
    void updateStatusBar()
  }

  async function updateStatusBar(): Promise<void> {
    const running = tasks.filter((t) => t.state === 'running').length
    const waiting = tasks.filter((t) => t.state === 'waiting').length
    const queued = tasks.filter((t) => t.state === 'queued').length
    const parts = ['pod']
    if (running) parts.push(tr('status.running', { n: running }))
    if (waiting) parts.push(tr('status.waiting', { n: waiting }))
    if (queued) parts.push(tr('status.queued', { n: queued }))
    try {
      await orca.host.call('statusBar.update', {
        id: 'pod-status',
        text: parts.join(' · '),
        tone: waiting ? 'warning' : running ? 'accent' : 'neutral',
        tooltip: waiting ? tr('status.tipWaiting') : tr('status.tip'),
      })
    } catch {
      // Status bar only exists in the desktop app.
    }
  }

  async function readTail(t: Task, maxLines = 60): Promise<string[]> {
    if (!t.terminalId) return []
    try {
      const r = await orca.host.call('terminal.read', { terminalId: t.terminalId, maxLines })
      return cleanLines(r.lines)
    } catch {
      return []
    }
  }

  /** Every agent's last reply, by Orca session id, from `orca agent list` (one CLI call for all
   *  agents, chats and terminals alike), cached for REPLIES_EVERY_MS. */
  type SessionInfo = { text: string; at: number; state: AgentState | null }
  let sessions = new Map<string, SessionInfo>()
  let repliesAt = 0
  async function sessionInfo(force = false): Promise<Map<string, SessionInfo>> {
    if (!force && Date.now() - repliesAt < REPLIES_EVERY_MS) return sessions
    repliesAt = Date.now()
    const r = (await runOrca(['agent', 'list']).catch(() => null)) as { agents?: { orcaSessionId: string; state?: AgentState; lastAssistantMessage?: string | null; updatedAt?: number }[] } | null
    if (r?.agents) {
      sessions = new Map(
        r.agents.map((a) => [a.orcaSessionId, { text: String(a.lastAssistantMessage ?? '').replace(/\s+/g, ' ').trim(), at: a.updatedAt ?? 0, state: a.state ?? null }])
      )
    }
    return sessions
  }
  /** Every agent's last reply, by Orca session id (only sessions that have one). */
  async function lastReplies(force = false): Promise<Map<string, { text: string; at: number }>> {
    const all = await sessionInfo(force)
    return new Map([...all].filter(([, v]) => v.text))
  }

  /** Workspace id -> the bot that started it (its orchestration worker), from `orca worktree ps`,
   *  which names the owning bot on each row. Keyed by both id forms Orca uses. */
  let owners = new Map<string, string>()
  let ownersAt = 0
  async function ownerBots(): Promise<Map<string, string>> {
    if (Date.now() - ownersAt < DISCOVER_EVERY_MS) return owners
    ownersAt = Date.now()
    const r = (await runOrca(['worktree', 'ps', '--limit', '10000']).catch(() => null)) as {
      worktrees?: { worktreeId: string; workspaceKind?: string; bot?: string | null; identity?: { key?: string } }[]
    } | null
    if (r?.worktrees) {
      const m = new Map<string, string>()
      for (const w of r.worktrees) {
        // a bot's own folder carries its name too: that is the bot itself, not a worker
        if (!w.bot || w.workspaceKind === 'folder-workspace') continue
        m.set(w.worktreeId, w.bot)
        if (w.identity?.key) m.set('identity:' + w.identity.key, w.bot)
      }
      owners = m
    }
    return owners
  }

  /** Tags each task with the bot that started its workspace. */
  async function tagOwners(): Promise<boolean> {
    const m = await ownerBots()
    let changed = false
    for (const t of tasks) {
      const by = t.workspaceId ? m.get(t.workspaceId) : undefined
      if (by && by !== t.bot && by !== t.byBot) {
        t.byBot = by
        changed = true
      }
    }
    return changed
  }

  /** If the agent stopped on its usage limit, the reset time it gave ('' when none); else null.
   *  Reads the agent's last reply and, for a terminal agent, its last lines. */
  async function limitHit(t: Task): Promise<string | null> {
    const texts: string[] = []
    const r = t.sessionId ? (await lastReplies()).get(t.sessionId) : undefined
    if (r && r.at >= (t.sentAt ?? 0)) texts.push(r.text)
    if (t.terminalId) texts.push((await readTail(t, 40)).slice(-8).join('\n'))
    for (const s of texts) {
      const hit = detectLimit(s)
      if (hit !== null) return hit
    }
    return null
  }

  /** Updates the card's last line. Done or waiting: the agent's last reply (Orca's own record).
   *  Running: that reply only if it came after the task was sent, else "working…". Agents Orca has
   *  no reply for yet fall back to the terminal's newest text. */
  async function captureLast(t: Task, force = false): Promise<void> {
    const reply = t.sessionId ? (await lastReplies(force)).get(t.sessionId) : undefined
    const fresh = reply && reply.at >= (t.sentAt ?? 0)
    if (reply && (t.state !== 'running' || fresh)) {
      t.last = reply.text.length > 240 ? reply.text.slice(0, 239) + '…' : reply.text
      if (t.state === 'waiting') t.question = t.last
      return
    }
    if (t.state === 'running' && (t.bot || t.sessionId)) {
      t.last = t.bot ? tr('last.botWorking', { bot: t.bot }) : tr('last.working', { agent: agentLabel(t.agent) })
      return
    }
    if (t.bot) return
    const lines = await readTail(t)
    if (!lines.length) return
    t.last = lines[lines.length - 1]
    if (t.state === 'waiting') t.question = lines.slice(-3).join(' · ')
  }

  /** Starts queued tasks while there is room. Agents opened in Orca directly do not take a slot. */
  async function dispatch(): Promise<void> {
    const { maxParallel } = await settings()
    // Tasks being launched are already 'running', so they count here.
    const running = tasks.filter((t) => t.state === 'running' && t.source !== 'orca').length
    let room = maxParallel > 0 ? maxParallel - running : Infinity
    const queue = tasks.filter((t) => t.state === 'queued').sort((a, b) => a.createdAt - b.createdAt)
    for (const t of queue) {
      if (room <= 0) break
      room -= 1
      void launch(t)
    }
  }

  async function launch(t: Task): Promise<void> {
    if (t.bot) return sendToBot(t, t.title, true)
    if (t.launchIn) return launchExisting(t, t.launchIn)
    move(t, 'running', tr('note.start', { agent: agentLabel(t.agent) }))
    t.sentAt = Date.now()
    t.awaitPickup = true
    t.branch = 'pod-' + slug(t.title) + '-' + t.id.slice(-4)
    t.last = tr('last.creatingWt', { branch: t.branch })
    await save()
    try {
      const r = await orca.host.call('workspace.create', {
        projectId: t.projectId,
        ...(t.hostId ? { hostId: t.hostId } : {}),
        name: t.branch,
        agent: t.agent,
        prompt: t.title,
      })
      await serial(async () => {
        t.workspaceId = r.workspaceId
        t.terminalId = r.terminalId ?? null
        t.last = tr('last.startedWt', { agent: agentLabel(t.agent) })
        // The agent may have reported before this answer and been adopted as an Orca agent.
        tasks = tasks.filter((x) => !(x.source === 'orca' && x.workspaceId === r.workspaceId))
        await save()
      })
    } catch (e) {
      await serial(async () => {
        t.error = errMessage(e)
        move(t, 'waiting', tr('note.failed'))
        t.question = tr('q.failed', { e: t.error })
        await save()
      })
    }
  }

  /** Mails a message to a bot's Home Chat, as `orca orchestration send --to bot:<name>` does, and
   *  follows that chat by its session id. A bot is never launched: it already has its chat. */
  async function sendToBot(t: Task, text: string, first: boolean): Promise<void> {
    const bot = t.bot as string
    if (first) {
      move(t, 'running', tr('note.sentBot', { bot }))
      t.workspaceId = t.launchIn
      t.last = tr('last.sendingBot', { bot })
      await save()
    }
    try {
      const sentAt = Date.now()
      const home = await mailBot(bot, t.launchIn as string, text)
      await serial(async () => {
        markSent(t, home, sentAt)
        await save()
      })
    } catch (e) {
      await serial(async () => {
        t.error = errMessage(e)
        move(t, 'waiting', tr('note.failed'))
        t.question = tr('q.failed', { e: t.error })
        await save()
      })
    }
  }

  /** `orchestration send` must come from a live Orca terminal (`--from`), and a plugin worker is
   *  none. Pod keeps one quiet shell terminal, titled "Pod", in each bot's workspace and sends from
   *  it; it is created once and reused while it lives. */
  async function mailbox(workspaceId: string): Promise<string> {
    const boxes = ((await orca.storage.get(MAILBOXES)) ?? {}) as Record<string, string>
    const known = boxes[workspaceId]
    if (known) {
      const live = await orca.host.call('terminal.list', { workspaceId }).catch(() => null)
      if (live?.terminals.some((x) => x.id === known)) return known
    }
    const { terminalId } = await orca.host.call('terminal.create', { workspaceId, title: 'Pod' })
    boxes[workspaceId] = terminalId
    await orca.storage.set(MAILBOXES, boxes)
    return terminalId
  }

  /** Delivers `text` to the bot's Home Chat and answers that chat's id (its Orca session id). */
  async function mailBot(bot: string, workspaceId: string, text: string): Promise<string | null> {
    const from = await mailbox(workspaceId)
    const dir = await mkdtemp(join(tmpdir(), 'pod-'))
    try {
      const file = join(dir, 'body.txt')
      await writeFile(file, text, 'utf8')
      const subject = text.replace(/\s+/g, ' ').trim().slice(0, 80)
      await runOrca(['orchestration', 'send', '--to', 'bot:' + bot, '--from', from, '--type', 'handoff', '--subject', subject, '--body-file', file])
    } finally {
      void rm(dir, { recursive: true, force: true })
    }
    const chats = (await runOrca(['bot', 'chats', '--bot', bot]).catch(() => null)) as { chats?: { id: string; home?: boolean; closed?: boolean }[] } | null
    return chats?.chats?.find((c) => c.home && !c.closed)?.id ?? null
  }

  /** `sentAt` is taken before the send: a quick bot can answer before the send call returns. */
  function markSent(t: Task, home: string | null, sentAt: number): void {
    if (home) {
      t.sessionId = home
      // The Home Chat may already be on the board as an adopted Orca agent.
      tasks = tasks.filter((x) => !(x.source === 'orca' && x.sessionId === home))
    }
    t.terminalId = null
    t.sentAt = sentAt
    t.awaitPickup = true
    t.last = tr('last.sentBot', { bot: t.bot as string })
  }

  /** Starts the agent in an existing workspace: a folder project. */
  async function launchExisting(t: Task, workspaceId: string): Promise<void> {
    move(t, 'running', tr('note.startIn', { agent: agentLabel(t.agent), place: t.projectName }))
    t.sentAt = Date.now()
    t.awaitPickup = true
    t.workspaceId = workspaceId
    t.last = tr('last.starting', { agent: agentLabel(t.agent), place: t.projectName })
    await save()
    try {
      const r = await orca.host.call('agent.launch', { workspaceId, agent: t.agent, prompt: t.title })
      await serial(async () => {
        t.terminalId = r.terminalId
        t.last = tr('last.startedIn', { agent: agentLabel(t.agent), place: t.projectName })
        // The agent may have reported before this answer and been adopted as an Orca agent.
        tasks = tasks.filter((x) => !(x.source === 'orca' && x.terminalId === r.terminalId))
        await save()
      })
    } catch (e) {
      await serial(async () => {
        t.error = errMessage(e)
        move(t, 'waiting', tr('note.failed'))
        t.question = tr('q.failed', { e: t.error })
        await save()
      })
    }
  }

  function findTask(p: { terminalId?: string | null; sessionId?: string | null; workspaceListId?: string; workspaceId?: string | null }): Task | undefined {
    if (p.terminalId) {
      const t = tasks.find((x) => x.terminalId === p.terminalId)
      if (t) return t
    }
    if (p.sessionId) {
      const t = tasks.find((x) => x.sessionId === p.sessionId)
      if (t) return t
    }
    // A Pod worktree task whose launch has not answered yet is known only by its workspace. A task
    // started in a shared workspace (folder, bot) is not: other agents run there too.
    const ws = p.workspaceListId ?? p.workspaceId
    if (!ws) return undefined
    return tasks.find((t) => t.source === 'pod' && !t.launchIn && t.workspaceId === ws && !t.terminalId && t.state !== 'queued')
  }

  /** True when a workspace belongs to a Pod task still launching (its id is not known yet). */
  function isPodLaunch(w: WorkspaceRow): boolean {
    return tasks.some((t) => t.source === 'pod' && !t.workspaceId && t.branch && (w.name === t.branch || w.branch === t.branch))
  }

  /** Puts an agent started in Orca on the board. Returns the new task, if any. */
  const isBotWorkspace = (w: WorkspaceRow) => w.kind === 'folder' && !w.projectId

  /** A bot's real chats, by session id (from `orca bot chats`), cached briefly. Orca can report
   *  stray "working" sessions in a bot's folder that are none of its chats; those are ignored. */
  const botChatCache = new Map<string, { ids: Set<string>; at: number }>()
  async function botChats(bot: string): Promise<Set<string> | null> {
    const hit = botChatCache.get(bot)
    if (hit && Date.now() - hit.at < DISCOVER_EVERY_MS) return hit.ids
    const r = (await runOrca(['bot', 'chats', '--bot', bot]).catch(() => null)) as { chats?: { id: string; closed?: boolean }[] } | null
    if (!r?.chats) return hit?.ids ?? null
    const ids = new Set(r.chats.filter((c) => !c.closed).map((c) => c.id))
    botChatCache.set(bot, { ids, at: Date.now() })
    return ids
  }

  /** In a bot's workspace only its own chats count as agents. `null` when the bot's chats cannot
   *  be read (CLI unavailable): then nothing is adopted and nothing is removed. */
  async function isRealAgent(w: WorkspaceRow, a: { sessionId?: string | null }): Promise<boolean | null> {
    if (!isBotWorkspace(w)) return true
    const ids = await botChats(w.name)
    if (!ids) return null
    return !!a.sessionId && ids.has(a.sessionId)
  }

  async function adopt(w: WorkspaceRow, a: AgentRow, fromEvent: boolean): Promise<Task | null> {
    const k = agentKey(a)
    if (!k || findTask(a) || isPodLaunch(w)) return null
    if ((await isRealAgent(w, a)) !== true) return null
    // A worktree Pod created belongs to its task; a shared folder or bot workspace does not.
    if (tasks.some((t) => t.source === 'pod' && !t.launchIn && t.workspaceId === w.id)) return null
    const at = a.stateStartedAt || Date.now()
    if (dismissed[k] && dismissed[k] >= at) return null
    if (a.state === 'done' && !fromEvent && Date.now() - at > RECENT_DONE_MS) return null
    const state = columnFor(a.state)
    const agent = (a.agent || 'agent').toLowerCase()
    const t: Task = {
      id: 'o' + newId().slice(1),
      source: 'orca',
      place: isBotWorkspace(w) ? 'bot' : w.kind === 'worktree' ? 'git' : 'folder',
      ...(isBotWorkspace(w) ? { bot: w.name } : {}),
      title: (a.task?.title || a.title || w.name || 'Agent').trim(),
      agent,
      projectId: w.projectId || '',
      hostId: w.hostId,
      projectName: w.project || w.name,
      state,
      since: at,
      createdAt: at,
      workspaceId: w.id,
      terminalId: a.terminalId,
      sessionId: a.sessionId ?? null,
      branch: w.branch || undefined,
      timeline: [{ s: state, at, note: tr('note.openedOrca') }],
    }
    tasks.push(t)
    await captureLast(t)
    return t
  }

  async function agentsIn(workspaceId: string): Promise<AgentRow[] | null> {
    try {
      return (await orca.host.call('agents.list', { workspaceId })).agents as AgentRow[]
    } catch {
      return null
    }
  }

  /** Finds agents started in Orca directly and adopts them. */
  async function discover(): Promise<boolean> {
    lastDiscover = Date.now()
    if (!(await settings()).showOrcaAgents) return false
    const ws = await workspaces(true)
    let changed = false
    // Drop Orca cards that are not a real chat of their bot (adopted before this check existed).
    for (const t of [...tasks]) {
      const w = t.source === 'orca' && t.workspaceId ? ws.get(t.workspaceId) : undefined
      if (w && isBotWorkspace(w) && (await isRealAgent(w, t)) === false) {
        tasks = tasks.filter((x) => x.id !== t.id)
        changed = true
      }
    }
    for (const w of ws.values()) {
      const st = w.status?.state
      if (!st || st === 'inactive') continue
      if (st === 'done' && (!w.status?.lastActivityAt || Date.now() - w.status.lastActivityAt > RECENT_DONE_MS)) continue
      const agents = await agentsIn(w.id)
      if (!agents) continue
      for (const a of agents) if (await adopt(w, a, false)) changed = true
    }
    return changed
  }

  async function applyAgentState(t: Task, state: AgentState, ids?: { terminalId?: string | null; sessionId?: string | null }, at?: number): Promise<boolean> {
    if (ids?.terminalId && !t.terminalId && !t.bot) t.terminalId = ids.terminalId
    if (ids?.sessionId && !t.sessionId) t.sessionId = ids.sessionId
    let col = columnFor(state)
    if (t.error) return false
    // An agent stopped by its usage limit is not done: it waits for the limit to reset (or for
    // you). Checked before the pickup guard, since a limit can stop an agent right at launch.
    if (col === 'running') {
      if (t.limit !== undefined) t.limit = undefined
    } else {
      const lim = await limitHit(t)
      if (lim !== null) {
        const fresh = t.limit === undefined || t.state !== 'waiting'
        t.limit = lim
        t.awaitPickup = false
        t.question = lim ? tr('limit.q', { reset: lim }) : tr('limit.qNoReset')
        t.last = t.question
        if (!fresh) return false
        move(t, 'waiting', tr('note.limit'))
        void orca.host.call('notifications.show', { title: 'Pod: ' + t.title, body: t.question }).catch(() => undefined)
        return true
      }
      if (t.limit !== undefined) t.limit = undefined
    }
    if (t.awaitPickup) {
      // Until the agent is seen working on the task, "idle" means it has not started yet: Claude
      // Code reports done for a moment after launch, before its prompt arrives, and a bot's chat
      // stays idle until it reads the mail. A question or permission prompt still counts.
      const fresh = Date.now() - (t.sentAt ?? 0) < PICKUP_GRACE_MS
      // A reply that came after the task was sent proves the work happened, even when it was so
      // quick that no "working" report was seen.
      const answered = async () => {
        const r = t.sessionId ? (await lastReplies(true)).get(t.sessionId) : undefined
        return !!r && r.at >= (t.sentAt ?? 0)
      }
      if (col === 'running') t.awaitPickup = false
      else if (col === 'done' && fresh && !(await answered())) return false
      else t.awaitPickup = false
    }
    if (col === t.state) return false
    const prev = t.state
    move(t, col, prev === 'waiting' && col === 'running' ? tr('note.resumed') : undefined)
    await captureLast(t, true)
    if (col === 'waiting') {
      void orca.host
        .call('notifications.show', { title: 'Pod: ' + t.title, body: t.question || tr('notif.waiting') })
        .catch(() => undefined)
    }
    return true
  }

  orca.events.on('agent.status.changed', (p) =>
    serial(async () => {
      const t = findTask(p)
      if (t) {
        if (await applyAgentState(t, p.state, p, p.mainAgent?.stateStartedAt ?? p.receivedAt)) {
          await save()
          await dispatch()
        }
        return
      }
      // An agent Pod does not know yet: an agent started in Orca directly.
      if (!(await settings()).showOrcaAgents) return
      const wsId = p.workspaceListId ?? p.workspaceId
      if (!wsId) return
      let w = (await workspaces()).get(wsId)
      if (!w) w = (await workspaces(true)).get(wsId)
      if (!w) return
      const agents = (await agentsIn(w.id)) ?? []
      const row =
        agents.find((a) => (p.terminalId && a.terminalId === p.terminalId) || (p.sessionId && a.sessionId === p.sessionId)) ??
        ({ terminalId: p.terminalId ?? null, sessionId: p.sessionId ?? null, title: p.title ?? null, agent: null, state: p.state, stateStartedAt: p.mainAgent?.stateStartedAt ?? p.receivedAt } as AgentRow)
      if (await adopt(w, { ...row, state: p.state }, true)) await save()
    })
  )

  orca.events.on('workspace.removed', (p) =>
    serial(async () => {
      const ids = new Set([p.workspaceId, p.workspaceListId].filter(Boolean))
      const before = tasks.length
      tasks = tasks.filter((t) => !(t.workspaceId && ids.has(t.workspaceId)))
      if (tasks.length !== before) {
        await save()
        await dispatch()
      }
    })
  )

  /** Re-reads every live task from Orca: catches events missed while the worker was stopped. */
  async function reconcile(): Promise<boolean> {
    let changed = false
    for (const t of [...tasks]) {
      if (!t.workspaceId || t.error || t.state === 'queued') continue
      if (t.state === 'done' && t.last) continue
      const agents = await agentsIn(t.workspaceId)
      if (agents) {
        let a = agents.find((x) => (t.terminalId && x.terminalId === t.terminalId) || (t.sessionId && x.sessionId === t.sessionId))
        if (!a && t.source === 'pod' && !t.launchIn && !t.terminalId) a = agents[0]
        // The plugin API does not always tie a bot's chat to its session id: fall back to the
        // state `orca agent list` reports for that session.
        const s = !a && t.sessionId ? (await sessionInfo()).get(t.sessionId) : undefined
        if (a) {
          if (await applyAgentState(t, a.state, a, a.stateStartedAt)) changed = true
        } else if (s?.state) {
          if (await applyAgentState(t, s.state, t, s.at)) changed = true
        } else if (t.source === 'orca' && t.state !== 'done') {
          // The agent's pane was closed in Orca.
          move(t, 'done', tr('note.closedOrca'))
          changed = true
        }
      }
      if (t.state === 'running' || t.state === 'waiting') {
        const before = t.last
        await captureLast(t)
        if (t.last !== before) changed = true
      }
    }
    return changed
  }

  orca.panels.handle('pod.state', () => serial(snapshot))

  orca.panels.handle('pod.refresh', () =>
    serial(async () => {
      let changed = await reconcile()
      if (Date.now() - lastDiscover > DISCOVER_EVERY_MS && (await discover())) changed = true
      if (await tagOwners()) changed = true
      if (changed) await save()
      await dispatch()
      return snapshot()
    })
  )

  orca.panels.handle('pod.add', (input) =>
    serial(async () => {
      const title = input.title.trim()
      if (!title) throw Object.assign(new Error(tr('err.empty')), { code: 'invalid_params' })
      const target = (await targets()).find((x) => x.id === input.targetId)
      if (!target) throw Object.assign(new Error(tr('err.target')), { code: 'invalid_params' })
      const { defaultAgent } = await settings()
      const now = Date.now()
      tasks.push({
        id: newId(),
        source: 'pod',
        title: title.charAt(0).toUpperCase() + title.slice(1),
        agent: input.agent || defaultAgent,
        projectId: target.projectId ?? '',
        hostId: target.hostId,
        projectName: target.name,
        ...(target.workspaceId ? { launchIn: target.workspaceId } : {}),
        ...(target.bot ? { bot: target.bot } : {}),
        place: target.kind,
        state: 'queued',
        since: now,
        createdAt: now,
        timeline: [{ s: 'queued', at: now }],
        last: tr('last.waitingAgent'),
      })
      await orca.storage.set(LAST_TARGET, target.id)
      await save()
      await dispatch()
      return snapshot()
    })
  )

  orca.panels.handle('pod.reply', (input) =>
    serial(async () => {
      const t = tasks.find((x) => x.id === input.id)
      if (!t) throw Object.assign(new Error(tr('err.notFound')), { code: 'invalid_params' })
      if (t.bot) {
        // A bot answers by its chat: the reply is mail to the same Home Chat.
        const sentAt = Date.now()
        const home = await mailBot(t.bot, t.launchIn as string, input.text)
        move(t, 'running', tr('note.afterReply'))
        markSent(t, home, sentAt)
        await save()
        return snapshot()
      }
      if (!t.terminalId) throw Object.assign(new Error(tr('err.chat')), { code: 'not_permitted' })
      await orca.host.call('terminal.sendText', { terminalId: t.terminalId, text: input.text, enter: true })
      move(t, 'running', tr('note.afterReply'))
      t.last = '› ' + input.text
      await save()
      return snapshot()
    })
  )

  orca.panels.handle('pod.retry', (input) =>
    serial(async () => {
      const t = tasks.find((x) => x.id === input.id)
      if (!t) throw Object.assign(new Error(tr('err.notFound')), { code: 'invalid_params' })
      t.error = undefined
      t.workspaceId = undefined
      t.terminalId = undefined
      t.branch = undefined
      t.awaitPickup = undefined
      move(t, 'queued', tr('note.retry'))
      t.last = tr('last.waitingAgent')
      await save()
      await dispatch()
      return snapshot()
    })
  )

  orca.panels.handle('pod.remove', (input) =>
    serial(async () => {
      const t = tasks.find((x) => x.id === input.id)
      if (t) dismiss(t)
      tasks = tasks.filter((x) => x.id !== input.id)
      await save()
      return snapshot()
    })
  )

  orca.panels.handle('pod.setMaxParallel', (input) =>
    serial(async () => {
      const v = Math.max(0, Math.min(50, Math.round(input.value)))
      await orca.settings.set('maxParallel', v)
      await dispatch()
      return snapshot()
    })
  )

  // Raising the limit from Settings starts queued tasks right away.
  orca.panels.handle('pod.setLanguage', (input) =>
    serial(async () => {
      const lang = (LANGS as string[]).includes(input.language) ? input.language : 'en'
      await orca.settings.set('language', lang)
      tr = translator(lang)
      await updateStatusBar()
      return snapshot()
    })
  )

  orca.settings.onDidChange(({ key }) => {
    if (key === 'language') {
      void serial(async () => {
        tr = translator((await settings()).language)
        await updateStatusBar()
      })
    }
    if (key === 'maxParallel') void serial(dispatch)
  })

  orca.panels.handle('pod.clearDone', (input) =>
    serial(async () => {
      const only = input.ids ? new Set(input.ids) : null
      const drop = tasks.filter((t) => t.state === 'done' && (!only || only.has(t.id)))
      for (const t of drop) dismiss(t)
      const ids = new Set(drop.map((t) => t.id))
      tasks = tasks.filter((t) => !ids.has(t.id))
      await save()
      return snapshot()
    })
  )

  orca.panels.handle('pod.log', async (input) => {
    await ready
    const t = tasks.find((x) => x.id === input.id)
    if (!t || !t.terminalId) return { lines: [] }
    try {
      const r = await orca.host.call('terminal.read', { terminalId: t.terminalId, maxLines: input.lines ?? 300 })
      return { lines: r.lines }
    } catch {
      return { lines: [] }
    }
  })

  async function focusTask(t: Task): Promise<boolean> {
    if (t.terminalId) {
      try {
        const r = await orca.host.call('terminal.focus', { terminalId: t.terminalId })
        if (r.focused) return true
      } catch {
        // fall back to the workspace
      }
    }
    if (t.workspaceId) {
      await orca.host.call('workspace.open', { workspaceId: t.workspaceId })
      return true
    }
    return false
  }

  orca.panels.handle('pod.open', async (input) => {
    await ready
    const t = tasks.find((x) => x.id === input.id)
    return { focused: t ? await focusTask(t) : false }
  })

  orca.commands.register('pod.focusWaiting', async () => {
    await ready
    const t = tasks.filter((x) => x.state === 'waiting').sort((a, b) => a.since - b.since)[0]
    if (!t) return tr('cmd.none')
    await focusTask(t)
    return tr('cmd.opened', { title: t.title })
  })

  void ready.then(() =>
    serial(async () => {
      const reconciled = await reconcile()
      const found = await discover()
      if (reconciled || found) await save()
      await updateStatusBar()
      await dispatch()
    })
  )
}
