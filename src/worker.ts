// Pod worker: owns the board. For each queued task it starts an agent (up to `maxParallel` of
// Pod's own running at once): in a fresh worktree for a Git project, or in the existing workspace
// of a folder project or a bot. It adopts agents started in Orca directly, follows every agent's
// status through agent.status.changed, and answers the panel. Tasks live in orca.storage so they
// survive worker and Orca restarts.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import type { PodState, SubAgent, Target, Task, TaskState } from './protocol'
import { LANGS, translator } from './messages'

type Wake = { at: number; kind: 'loop' | 'cron'; label: string }

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
/** How often the cards' tab titles are read again from Orca. */
const TITLES_EVERY_MS = 15_000
/** How often Orca's automations are read for their next runs. */
const AUTOMATIONS_EVERY_MS = 60_000
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
  path?: string
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

/* ---------- Claude sub-agents ----------
 * Claude Code keeps each session's transcript under ~/.claude/projects/<cwd>/<conversation id>.jsonl
 * (<cwd> with every non-alphanumeric character turned into '-'), and each sub-agent it starts
 * (Task / Agent tool) under <conversation id>/subagents/agent-<id>.jsonl, with a .meta.json beside
 * it: { description, agentType, finished, ... }. Orca's API has no view of them; the files do. */

/** A sub-agent whose transcript has not moved for this long is not running, whatever its meta says. */
const SUBAGENT_FRESH_MS = 10 * 60_000

export function claudeProjectDir(cwd: string, base = join(homedir(), '.claude', 'projects')): string {
  return join(base, cwd.replace(/[^a-zA-Z0-9]/g, '-'))
}

/** The sub-agents recorded in one session folder, newest first. */
export async function readSubagents(sessionDir: string, now = Date.now()): Promise<SubAgent[]> {
  const dir = join(sessionDir, 'subagents')
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const out: SubAgent[] = []
  for (const n of names) {
    if (!n.endsWith('.meta.json')) continue
    const id = n.slice(0, -'.meta.json'.length)
    try {
      const meta = JSON.parse(await readFile(join(dir, n), 'utf8')) as { description?: string; agentType?: string; finished?: boolean }
      let at = 0
      try {
        at = (await stat(join(dir, id + '.jsonl'))).mtimeMs
      } catch {
        at = (await stat(join(dir, n))).mtimeMs
      }
      out.push({
        id,
        description: String(meta.description || meta.agentType || id),
        type: String(meta.agentType || ''),
        // Claude writes `finished: true` only at the end; while it works the field is absent.
        running: meta.finished !== true && now - at < SUBAGENT_FRESH_MS,
        at,
      })
    } catch {
      // a meta being written right now: next scan reads it
    }
  }
  return out.sort((a, b) => b.at - a.at)
}

/** A session's folder: exact when the Claude conversation id is known (terminal agents report it),
 *  else, for a chat, the most recently written session of its workspace. */
export async function sessionDirFor(projectDir: string, conversationId: string | null | undefined, allowLatest: boolean): Promise<string | null> {
  if (conversationId) {
    // the transcript file always exists; the folder only once a sub-agent or tool result was saved
    for (const p of [join(projectDir, conversationId + '.jsonl'), join(projectDir, conversationId)]) {
      try {
        await stat(p)
        return join(projectDir, conversationId)
      } catch {
        // not there: try the next form, then fall through (a chat's Orca session id)
      }
    }
  }
  if (!allowLatest) return null
  let names: string[]
  try {
    names = await readdir(projectDir)
  } catch {
    return null
  }
  let best: string | null = null
  let bestAt = 0
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue
    try {
      const s = await stat(join(projectDir, n))
      if (s.mtimeMs > bestAt) {
        bestAt = s.mtimeMs
        best = n.slice(0, -'.jsonl'.length)
      }
    } catch {
      // gone meanwhile
    }
  }
  return best ? join(projectDir, best) : null
}

/** What a Claude session is doing, read from the tail of its transcript: the last thing it was
 *  asked (a bot's mail gives its Subject) and its latest action (the last tool it called, or that
 *  it is writing). `act` is a kind plus a detail; the worker words it in the chosen language. */
export type Activity = { prompt?: string; act?: { kind: string; detail: string }; at: number }

const TAIL_BYTES = 512 * 1024
const DEEP_TAIL_BYTES = 4 * 1024 * 1024
const base = (p: unknown) => String(p ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''
const oneLine = (s: unknown, n = 90) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/** When a limit message's reset time ("7pm", "3:30pm (Europe/Rome)", "19:00") next comes, in local
 *  time, or undefined when it is not a plain time of day (a date, nothing). */
export function parseReset(text: string, now = Date.now()): number | undefined {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text)
  if (!m) return undefined
  let h = Number(m[1])
  const min = Number(m[2] ?? 0)
  const ap = m[3]?.toLowerCase()
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  if (h > 23 || min > 59 || (!ap && !m[2])) return undefined
  const d = new Date(now)
  d.setHours(h, min, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/* ---------- schedules: Claude loops and cron jobs ---------- */

/** The next time (ms) at or after `from` that a 5-field cron expression fires (minute hour
 *  day-of-month month day-of-week; `*`, numbers, `a-b`, lists and `/n` steps), in local time, or
 *  null when it does not fire within a year. */
export function nextCron(expr: string, from: number): number | null {
  const f = expr.trim().split(/\s+/)
  if (f.length !== 5) return null
  const field = (s: string, min: number, max: number): Set<number> | null => {
    const out = new Set<number>()
    for (const part of s.split(',')) {
      const [range, stepS] = part.split('/')
      const step = stepS ? Number(stepS) : 1
      if (!Number.isFinite(step) || step < 1) return null
      let a = min
      let b = max
      if (range !== '*') {
        const [x, y] = range.split('-').map(Number)
        if (!Number.isFinite(x)) return null
        a = x
        b = y === undefined || Number.isNaN(y) ? (stepS ? max : x) : y
      }
      for (let v = a; v <= b; v += step) out.add(v === 7 && max === 6 ? 0 : v)
    }
    return out
  }
  const [mi, ho, dom, mo, dow] = [field(f[0], 0, 59), field(f[1], 0, 23), field(f[2], 1, 31), field(f[3], 1, 12), field(f[4], 0, 6)]
  if (!mi || !ho || !dom || !mo || !dow) return null
  const domAny = f[2] === '*'
  const dowAny = f[4] === '*'
  const d = new Date(from)
  d.setSeconds(0, 0)
  if (d.getTime() < from) d.setMinutes(d.getMinutes() + 1)
  const end = from + 366 * 86_400_000
  while (d.getTime() <= end) {
    if (!mo.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1)
      d.setHours(0, 0, 0, 0)
      continue
    }
    // cron: when both day fields are restricted, either one matching is enough
    const dayOk = domAny && dowAny ? true : domAny ? dow.has(d.getDay()) : dowAny ? dom.has(d.getDate()) : dom.has(d.getDate()) || dow.has(d.getDay())
    if (!dayOk) {
      d.setDate(d.getDate() + 1)
      d.setHours(0, 0, 0, 0)
      continue
    }
    if (!ho.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!mi.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0)
      continue
    }
    return d.getTime()
  }
  return null
}

const shifted = (t: number | null, by: number) => (t === null ? null : t + by)

/** The next self-scheduled wake-up of a Claude session, from its transcript lines: a dynamic loop
 *  (ScheduleWakeup: its time plus delaySeconds, `stop` ends it) or a cron job (CronCreate, until
 *  CronDelete or, for a one-shot, until it fired). Earliest upcoming, or null. */
export function nextWake(lines: string[], now = Date.now()): Wake | null {
  let loop: Wake | null = null
  const jobs = new Map<string, { cron: string; recurring: boolean; next: number | null; offset: number }>()
  // CronCreate's result only has a human-readable schedule ("Every 30 minutes"); the cron
  // expression is in the tool call, so remember it by tool_use id until the result shows up.
  const crons = new Map<string, string>()
  for (const raw of lines) {
    if (!raw.includes('ScheduleWakeup') && !raw.includes('Cron') && !raw.includes('nextFireAt')) continue
    let o: { timestamp?: string; message?: { content?: unknown }; toolUseResult?: { id?: string; humanSchedule?: string; recurring?: boolean; nextFireAt?: number } }
    try {
      o = JSON.parse(raw)
    } catch {
      continue
    }
    const ts = o.timestamp ? Date.parse(o.timestamp) : now
    const r = o.toolUseResult
    const content = o.message?.content
    if (r && r.id && r.humanSchedule) {
      const res = Array.isArray(content) ? (content as { type?: string; tool_use_id?: string }[]).find((c) => c.type === 'tool_result') : undefined
      const cron = (res?.tool_use_id && crons.get(res.tool_use_id)) || r.humanSchedule
      // Claude shifts a job's fire time off the cron slot (`*/30` fires at :13:20 and :43:20, not at
      // :00 and :30). The first fire it reports tells us that shift; later fires keep it.
      const slot = r.recurring && r.nextFireAt ? nextCron(cron, ts) : null
      const shift = slot !== null && r.nextFireAt ? Math.round(r.nextFireAt) - slot : 0
      jobs.set(r.id, { cron, recurring: !!r.recurring, next: r.nextFireAt ?? null, offset: shift > 0 && shift < 3_600_000 ? shift : 0 })
    }
    if (!Array.isArray(content)) continue
    for (const c of content as { type?: string; id?: string; name?: string; input?: Record<string, unknown> }[]) {
      if (c.type !== 'tool_use') continue
      if (c.name === 'CronCreate' && c.id && typeof c.input?.cron === 'string') crons.set(c.id, c.input.cron)
      else if (c.name === 'ScheduleWakeup') {
        const stop = c.input?.stop === true
        const delay = Number(c.input?.delaySeconds)
        loop = stop || !Number.isFinite(delay) ? null : { at: ts + delay * 1000, kind: 'loop', label: String(c.input?.reason ?? '').slice(0, 120) }
      } else if (c.name === 'CronDelete' && c.input?.id) jobs.delete(String(c.input.id))
    }
  }
  let best: Wake | null = loop && loop.at > now - 60_000 ? loop : null
  for (const j of jobs.values()) {
    let at = j.next
    if (j.recurring || at === null || at < now - 60_000) at = j.recurring ? shifted(nextCron(j.cron, now - j.offset), j.offset) : at !== null && at >= now - 60_000 ? at : null
    if (at !== null && (!best || at < best.at)) best = { at, kind: 'cron', label: j.cron }
  }
  return best
}

/** True when the session's last turn is over: its `turn_duration` marker comes after the last
 *  user or assistant message. Orca can keep reporting such a session as working. */
export function turnEnded(lines: string[]): boolean {
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i]
    const isTurn = raw.includes('"turn_duration"')
    if (!isTurn && !raw.includes('"type":"user"') && !raw.includes('"type":"assistant"')) continue
    try {
      const o = JSON.parse(raw) as { type?: string; subtype?: string; isSidechain?: boolean }
      if (o.isSidechain) continue
      if (o.type === 'system' && o.subtype === 'turn_duration') return true
      if (o.type === 'user' || o.type === 'assistant') return false
    } catch {
      continue
    }
  }
  return false
}

/** The transcript's last lines (up to `bytes`), for schedule scanning. */
export async function tailLines(file: string, bytes = 4 * 1024 * 1024): Promise<string[]> {
  let fh
  try {
    fh = await open(file, 'r')
  } catch {
    return []
  }
  try {
    const { size } = await fh.stat()
    const len = Math.min(size, bytes)
    const buf = new Uint8Array(len)
    await fh.read(buf, 0, len, size - len)
    const lines = new TextDecoder().decode(buf).split('\n')
    if (size > len) lines.shift()
    return lines
  } finally {
    await fh.close()
  }
}

/** A tab title worth showing, or undefined: drops the spinner glyphs Claude puts in front, and
 *  generic names (the agent's, the workspace's, a shell or executable path). */
export function tabTitle(raw: string | null | undefined, generic: (string | null | undefined)[] = []): string | undefined {
  const t = String(raw ?? '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (t.length < 3) return undefined
  const low = t.toLowerCase()
  if (['claude code', 'claude', 'codex', 'terminal', 'shell'].includes(low)) return undefined
  if (generic.some((g) => g && low === String(g).trim().toLowerCase())) return undefined
  if (/[\\/]|\.exe\b|^(cmd|pwsh|powershell|bash|zsh|sh|node)(\s|$)/i.test(t)) return undefined
  return t
}

/** The kind and detail of one tool call, in plain words. */
export function describeTool(name: string, input: Record<string, unknown>): { kind: string; detail: string } {
  const n = name.toLowerCase()
  if (n === 'edit' || n === 'multiedit' || n === 'notebookedit') return { kind: 'edit', detail: base(input.file_path ?? input.notebook_path) }
  if (n === 'write') return { kind: 'write', detail: base(input.file_path) }
  if (n === 'read') return { kind: 'read', detail: base(input.file_path) }
  if (n === 'bash' || n === 'powershell' || n === 'shell') return input.description ? { kind: 'plain', detail: oneLine(input.description) } : { kind: 'run', detail: oneLine(input.command, 60) }
  if (n === 'grep' || n === 'glob' || n === 'search') return { kind: 'search', detail: oneLine(input.pattern ?? input.query, 50) }
  if (n === 'agent' || n === 'task') return { kind: 'agent', detail: oneLine(input.description ?? input.subagent_type) }
  if (n === 'webfetch' || n === 'websearch') return { kind: 'web', detail: oneLine(input.url ?? input.query, 60) }
  if (n === 'todowrite') return { kind: 'plan', detail: '' }
  if (n.startsWith('mcp__')) return { kind: 'tool', detail: n.split('__').pop() ?? n }
  return { kind: 'tool', detail: name }
}

/** User turns that are not requests: permission denials, interruptions, the preamble Orca gives
 *  its workers, Claude's resume notes. */
export const NOT_A_REQUEST = /^(Denied:|\[Request interrupted|\[Orca:|You are working inside Orca|Caveat:|This session is being continued|Continue where you left off)/i

/** The text a user turn carries, or null for tool results and harness notes. */
function promptText(content: unknown): string | null {
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    const parts = content.filter((c: { type?: string }) => c && c.type === 'text').map((c: { text?: string }) => c.text ?? '')
    if (!parts.length) return null
    text = parts.join('\n')
  } else return null
  text = text.trim()
  if (!text || text.startsWith('<')) return null
  if (NOT_A_REQUEST.test(text)) return null
  // mail between agents: "──── From: … ──── Subject: <subject>\n<body>". A subject that says
  // nothing (agents mail "Denied: Bash" too) gives way to the body's first line.
  const subj = /Subject:\s*([^\n]+)\n?([\s\S]*)/.exec(text)
  if (/^─+\s*From:/.test(text) && subj) {
    const subject = subj[1].trim()
    const body = subj[2].trim().split('\n').find((l) => l.trim()) ?? ''
    if ((NOT_A_REQUEST.test(subject) || subject.length < 12) && body) return oneLine(body, 120)
    return oneLine(subject, 120)
  }
  return oneLine(text, 120)
}

export async function readActivity(transcript: string, tailBytes = TAIL_BYTES): Promise<Activity | null> {
  let fh
  try {
    fh = await open(transcript, 'r')
  } catch {
    return null
  }
  try {
    const { size, mtimeMs } = await fh.stat()
    const len = Math.min(size, tailBytes)
    const buf = new Uint8Array(len)
    await fh.read(buf, 0, len, size - len)
    const lines = new TextDecoder().decode(buf).split('\n')
    if (size > len) lines.shift() // cut mid-line
    const out: Activity = { at: mtimeMs }
    for (let i = lines.length - 1; i >= 0 && (!out.prompt || !out.act); i--) {
      const l = lines[i].trim()
      if (!l) continue
      let o: { type?: string; isMeta?: boolean; isSidechain?: boolean; message?: { role?: string; content?: unknown } }
      try {
        o = JSON.parse(l)
      } catch {
        continue
      }
      if (o.isSidechain) continue
      if (!out.act && o.type === 'assistant' && Array.isArray(o.message?.content)) {
        const items = o.message.content as { type?: string; name?: string; input?: Record<string, unknown>; text?: string }[]
        const last = items[items.length - 1]
        if (last?.type === 'tool_use' && last.name) out.act = describeTool(last.name, last.input ?? {})
        else if (last?.type === 'text' && last.text?.trim()) out.act = { kind: 'reply', detail: '' }
        else if (last?.type === 'thinking') out.act = { kind: 'think', detail: '' }
      }
      if (!out.prompt && o.type === 'user' && !o.isMeta) {
        const p = promptText(o.message?.content)
        if (p) out.prompt = p
      }
    }
    return out
  } finally {
    await fh.close()
  }
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
    for (const t of tasks) {
      if (!t.source) t.source = 'pod'
      // requests saved before the filter existed
      if (t.prompt && NOT_A_REQUEST.test(t.prompt)) t.prompt = undefined
    }
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
    const hiddenLanes = ['claude', 'codex'].filter((a) => s['show' + a.charAt(0).toUpperCase() + a.slice(1) + 'Lane'] === false)
    return { maxParallel, doneVisible, defaultAgent, showOrcaAgents, language, hiddenLanes }
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

  /** The agent CLIs installed on this machine (`orca agent installed`), or null when unknown. */
  let installedAt = 0
  let installed: Set<string> | null = null
  async function installedAgents(): Promise<Set<string> | null> {
    if (Date.now() - installedAt < 60_000) return installed
    installedAt = Date.now()
    const r = (await runOrca(['agent', 'installed']).catch(() => null)) as { agents?: { id?: string }[] } | null
    installed = Array.isArray(r?.agents) && r.agents.length ? new Set(r.agents.map((a) => String(a.id))) : null
    return installed
  }

  async function snapshot(): Promise<PodState> {
    const [s, ts, last, inst] = await Promise.all([settings(), targets(), orca.storage.get(LAST_TARGET), installedAgents()])
    return {
      tasks: plain(),
      targets: ts,
      defaultAgent: s.defaultAgent,
      defaultTargetId: typeof last === 'string' && ts.some((t) => t.id === last) ? last : (ts[0]?.id ?? null),
      maxParallel: s.maxParallel,
      language: s.language,
      hiddenLanes: [...new Set([...s.hiddenLanes, ...(inst ? ['claude', 'codex'].filter((a) => !inst.has(a)) : [])])],
      agents: inst ? ['claude', 'codex'].filter((a) => inst.has(a)) : null,
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
    // an automation's card stays off until it is turned off and on again (its id is the key)
    const k = t.wakeKind === 'automation' ? t.id : taskKey(t)
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
  type SessionInfo = { text: string; at: number; state: AgentState | null; title: string }
  let sessions = new Map<string, SessionInfo>()
  let repliesAt = 0
  async function sessionInfo(force = false): Promise<Map<string, SessionInfo>> {
    if (!force && Date.now() - repliesAt < REPLIES_EVERY_MS) return sessions
    repliesAt = Date.now()
    const r = (await runOrca(['agent', 'list']).catch(() => null)) as { agents?: { orcaSessionId: string; state?: AgentState; title?: string | null; lastAssistantMessage?: string | null; updatedAt?: number }[] } | null
    if (r?.agents) {
      sessions = new Map(
        r.agents.map((a) => [a.orcaSessionId, { text: String(a.lastAssistantMessage ?? '').replace(/\s+/g, ' ').trim(), at: a.updatedAt ?? 0, state: a.state ?? null, title: String(a.title ?? '') }])
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

  const deepRead = new Map<string, number>()

  /** A Claude session's next self-scheduled wake-up (loop or cron job), from its transcript. */
  async function scheduleFor(t: Task): Promise<Wake | null> {
    const path = t.workspaceId ? (await workspaces()).get(t.workspaceId)?.path : undefined
    if (!path) return null
    const dir = await sessionDirFor(claudeProjectDir(path), t.sessionId, !t.terminalId)
    if (!dir) return null
    return nextWake(await tailLines(dir + '.jsonl'))
  }

  /** Nothing was written to the transcript for `ms`. */
  async function quietFor(file: string, ms: number): Promise<boolean> {
    try {
      return Date.now() - (await stat(file)).mtimeMs >= ms
    } catch {
      return false
    }
  }

  /** The transcript has been quiet for a while and its last turn is over. */
  async function asleep(file: string): Promise<boolean> {
    return (await quietFor(file, 20_000)) && turnEnded(await tailLines(file, 256 * 1024))
  }

  /** The agent stopped on its usage limit: back to Queued until the limit resets. */
  function parkOnLimit(t: Task, lim: string): boolean {
    const fresh = t.limit === undefined || t.state !== 'queued'
    t.limit = lim
    t.awaitPickup = false
    t.activity = undefined
    t.wakeAt = parseReset(lim)
    t.wakeKind = 'limit'
    t.wakeLabel = lim
    t.question = lim ? tr('limit.q', { reset: lim }) : tr('limit.qNoReset')
    t.last = t.question
    if (!fresh) return false
    move(t, 'queued', tr('note.limit'))
    void orca.host.call('notifications.show', { title: 'Pod: ' + t.title, body: t.question }).catch(() => undefined)
    return true
  }

  /** Orca automations on the board: each enabled one waits in Queued for its next run. */
  let automationsAt = 0
  async function syncAutomations(): Promise<boolean> {
    if (Date.now() - automationsAt < AUTOMATIONS_EVERY_MS) return false
    automationsAt = Date.now()
    if (!(await settings()).showOrcaAgents) return false
    let list: { id: string; name: string; agent: string; prompt: string; projectId: string | null; workspaceId: string | null; schedule: string | null; enabled: boolean; nextRunAt: number | null }[]
    try {
      list = (await orca.host.call('automation.list')).automations
    } catch (e) {
      orca.log('automation.list failed: ' + errMessage(e))
      return false
    }
    const ws = await workspaces()
    const projects = new Map(((await orca.host.call('project.list').catch(() => null))?.projects ?? []).map((p) => [p.id, p]))
    let changed = false
    const live = new Set<string>()
    for (const a of list) {
      const id = 'auto:' + a.id
      if (!a.enabled || !a.nextRunAt || dismissed[id]) continue
      live.add(id)
      const w = a.workspaceId ? ws.get(a.workspaceId) : undefined
      const p = a.projectId ? projects.get(a.projectId) : undefined
      const place: Task['place'] = w ? (isBotWorkspace(w) ? 'bot' : w.kind === 'worktree' ? 'git' : 'folder') : p?.kind === 'git' ? 'git' : 'folder'
      const fields = {
        title: a.name,
        prompt: oneLine(a.prompt, 120),
        agent: (a.agent || 'claude').toLowerCase(),
        projectName: w?.project || w?.name || p?.name || a.name,
        place,
        wakeAt: a.nextRunAt,
        wakeKind: 'automation' as const,
        wakeLabel: a.schedule ?? '',
      }
      const t = tasks.find((x) => x.id === id)
      if (!t) {
        const now = Date.now()
        tasks.push({ id, source: 'orca', projectId: a.projectId ?? '', hostId: null, workspaceId: a.workspaceId ?? undefined, state: 'queued', since: now, createdAt: now, timeline: [{ s: 'queued', at: now, note: tr('note.automation') }], ...fields })
        changed = true
      } else if (JSON.stringify(fields) !== JSON.stringify({ title: t.title, prompt: t.prompt, agent: t.agent, projectName: t.projectName, place: t.place, wakeAt: t.wakeAt, wakeKind: t.wakeKind, wakeLabel: t.wakeLabel })) {
        Object.assign(t, fields)
        changed = true
      }
    }
    const before = tasks.length
    tasks = tasks.filter((t) => !t.id.startsWith('auto:') || live.has(t.id))
    return changed || tasks.length !== before
  }

  /** Keeps each card's tab title in step with Orca: a terminal's title (which Claude sets to a
   *  summary of the session), or a chat's. Generic ones ("Claude Code", a shell) are ignored. */
  let titlesAt = 0
  async function refreshTitles(): Promise<boolean> {
    if (Date.now() - titlesAt < TITLES_EVERY_MS) return false
    titlesAt = Date.now()
    let changed = false
    const byWorkspace = new Map<string, Map<string, string>>()
    const sess = await sessionInfo()
    for (const t of tasks) {
      let title: string | undefined
      if (t.terminalId && t.workspaceId) {
        if (!byWorkspace.has(t.workspaceId)) {
          const r = await orca.host.call('terminal.list', { workspaceId: t.workspaceId }).catch(() => null)
          byWorkspace.set(t.workspaceId, new Map((r?.terminals ?? []).map((x) => [x.id, x.title ?? ''])))
        }
        title = byWorkspace.get(t.workspaceId)?.get(t.terminalId)
      } else if (t.sessionId) {
        title = sess.get(orcaKey(t) ?? '')?.title
      }
      const clean = tabTitle(title, [agentLabel(t.agent), t.projectName, t.bot, t.byBot])
      if (clean && clean !== t.tabTitle) {
        t.tabTitle = clean
        changed = true
      }
    }
    return changed
  }

  /** An action from the transcript, worded in the selected language. */
  function wordActivity(a: { kind: string; detail: string }): string {
    if (a.kind === 'plain') return a.detail
    const key = ('act.' + a.kind) as Parameters<typeof tr>[0]
    try {
      return tr(key, { d: a.detail })
    } catch {
      return a.detail
    }
  }

  /** Refreshes the Claude sub-agents of running and waiting tasks. Keeps those of the current run
   *  (started since the task last went running), at most 12. */
  async function scanSubagents(): Promise<boolean> {
    const ws = await workspaces()
    let changed = false
    for (const t of tasks) {
      const active = t.state === 'running' || t.state === 'waiting' || (t.state === 'queued' && (!!t.wakeAt || t.limit !== undefined) && t.wakeKind !== 'automation')
      // a done card is read once, only to learn what it was asked (for a generic title)
      const once = t.state === 'done' && !t.prompt && !deepRead.has(t.id)
      if ((!active && !once) || t.agent !== 'claude') continue
      const path = t.workspaceId ? ws.get(t.workspaceId)?.path : undefined
      if (!path) continue
      const dir = await sessionDirFor(claudeProjectDir(path), t.sessionId, !t.terminalId)
      if (!dir) continue
      if (once) {
        deepRead.set(t.id, Date.now())
        const a = await readActivity(dir + '.jsonl', DEEP_TAIL_BYTES)
        if (a?.prompt) {
          t.prompt = a.prompt
          changed = true
        }
        continue
      }
      const runStart = [...t.timeline].reverse().find((e) => e.s === 'running')?.at ?? t.createdAt
      const subs = (await readSubagents(dir)).filter((s) => s.running || s.at >= runStart - 1000).slice(0, 12)
      const prev = JSON.stringify(t.subagents ?? [])
      const next = JSON.stringify(subs)
      if (prev !== next) {
        t.subagents = subs.length ? subs : undefined
        changed = true
      }
      // Sub-agents still running in the background: the session is busy even if its own turn ended.
      const busy = subs.some((x) => x.running)
      if (t.state === 'queued') {
        // It works again: sub-agents running, or (after a usage limit) writes to its transcript
        const resumed = t.limit !== undefined && !(await quietFor(dir + '.jsonl', Date.now() - t.since - 30_000))
        if (busy || resumed) {
          t.wakeAt = t.wakeKind = t.wakeLabel = t.limit = undefined
          move(t, 'running')
          changed = true
        }
        continue
      }
      // Stopped by the usage limit while Orca still says working (a scheduled run that failed):
      // the terminal says so.
      if (!busy && t.state === 'running' && !t.awaitPickup && t.terminalId && (await quietFor(dir + '.jsonl', 60_000))) {
        const lim = detectLimit((await readTail(t, 40)).slice(-8).join('\n'))
        if (lim !== null) {
          changed = parkOnLimit(t, lim) || changed
          continue
        }
      }
      // Orca still says working, but the turn is over and a wake-up is scheduled: it is sleeping.
      if (!busy && t.state === 'running' && !t.awaitPickup && (await asleep(dir + '.jsonl'))) {
        const w = await scheduleFor(t)
        if (w) {
          t.wakeAt = w.at
          t.wakeKind = w.kind
          t.wakeLabel = w.label
          t.activity = undefined
          move(t, 'queued', tr(w.kind === 'loop' ? 'note.loop' : 'note.cron'))
          changed = true
          continue
        }
      }
      // What it is doing now, and what it was asked last
      let act = await readActivity(dir + '.jsonl')
      // Long tool output can push the last request out of the tail: look further back, at most
      // once a minute per task.
      if (act && !act.prompt && Date.now() - (deepRead.get(t.id) ?? 0) > 60_000) {
        deepRead.set(t.id, Date.now())
        const deep = await readActivity(dir + '.jsonl', DEEP_TAIL_BYTES)
        if (deep?.prompt) act = { ...act, prompt: deep.prompt }
      }
      if (act) {
        const doing = act.act ? wordActivity(act.act) : undefined
        if (doing !== t.activity) {
          t.activity = doing
          changed = true
        }
        if (act.prompt && act.prompt !== t.prompt) {
          t.prompt = act.prompt
          changed = true
        }
      }
    }
    return changed
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
    const r = orcaKey(t) ? (await lastReplies()).get(orcaKey(t) as string) : undefined
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
    const reply = orcaKey(t) ? (await lastReplies(force)).get(orcaKey(t) as string) : undefined
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
    // only Pod's own tasks waiting for a slot; scheduled ones start by themselves
    const queue = tasks.filter((t) => t.state === 'queued' && t.source === 'pod' && !t.wakeAt && t.limit === undefined).sort((a, b) => a.createdAt - b.createdAt)
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
      t.orcaSessionId = home
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

  /** findTask, then by Orca's id when the report carries a chat's Claude conversation id: a bot
   *  task Pod mailed knows its chat only by Orca's id. Learns the conversation id on the way. */
  async function findTaskAsync(p: { terminalId?: string | null; sessionId?: string | null; workspaceListId?: string; workspaceId?: string | null }): Promise<Task | undefined> {
    const t = findTask(p)
    if (t || !p.sessionId) return t
    const oid = await orcaIdFor(p.sessionId)
    if (!oid) return undefined
    const hit = tasks.find((x) => x.orcaSessionId === oid || x.sessionId === oid)
    if (hit) {
      hit.orcaSessionId = oid
      hit.sessionId = p.sessionId
    }
    return hit
  }

  /** True when a workspace belongs to a Pod task still launching (its id is not known yet). */
  function isPodLaunch(w: WorkspaceRow): boolean {
    return tasks.some((t) => t.source === 'pod' && !t.workspaceId && t.branch && (w.name === t.branch || w.branch === t.branch))
  }

  /** Orca's session id for a session id the plugin API reported. The plugin API gives a chat's
   *  Claude conversation id; Orca names the session differently, and answers the mapping when
   *  asked about the conversation id ("… Address it as orca_session_id:<id>"). Cached. */
  const orcaIds = new Map<string, string>()
  async function orcaIdFor(sid: string | null | undefined): Promise<string | undefined> {
    if (!sid) return undefined
    if (orcaIds.has(sid)) return orcaIds.get(sid)
    if ((await sessionInfo()).has(sid)) {
      orcaIds.set(sid, sid)
      return sid
    }
    let oid: string | undefined
    try {
      // bare id: Orca answers a conversation id with `agent_provider_id` naming its own id
      const r = (await runOrca(['agent', 'show', sid])) as { orcaSessionId?: string }
      oid = r?.orcaSessionId
    } catch (e) {
      oid = /orca_session_id:([0-9a-f-]{36})/i.exec(errMessage(e))?.[1]
    }
    if (oid) orcaIds.set(sid, oid)
    return oid
  }
  /** The id `orca agent list` knows a task's session by. */
  const orcaKey = (t: Task) => t.orcaSessionId ?? t.sessionId ?? undefined

  /** A bot's own workspace: a folder that belongs to no project. */
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
    if (!a.sessionId) return false
    // the plugin API gives a chat's Claude conversation id; bot chats are listed by Orca's id
    return ids.has(a.sessionId) || ids.has((await orcaIdFor(a.sessionId)) ?? '')
  }

  /** Puts an agent started in Orca on the board. Returns the new task, if any. */
  async function adopt(w: WorkspaceRow, a: AgentRow, fromEvent: boolean): Promise<Task | null> {
    const k = agentKey(a)
    if (!k || (await findTaskAsync(a)) || isPodLaunch(w)) return null
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
      orcaSessionId: await orcaIdFor(a.sessionId),
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
      if (w && isBotWorkspace(w) && (await isRealAgent(w, { sessionId: t.orcaSessionId ?? t.sessionId })) === false) {
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
    // Orca may keep reporting `working` for a session whose turn already ended (it sleeps until a
    // loop or cron job fires). A state older than the move to Queued is that stale report.
    if (col === 'running' && t.state === 'queued' && (t.wakeAt || t.limit !== undefined) && at && at <= t.since) {
      // while it sleeps, keep the shown time in line with the transcript
      const w = t.agent === 'claude' && (t.wakeKind === 'loop' || t.wakeKind === 'cron') ? await scheduleFor(t) : null
      if (!w || (w.at === t.wakeAt && w.kind === t.wakeKind)) return false
      t.wakeAt = w.at
      t.wakeKind = w.kind
      t.wakeLabel = w.label
      return true
    }
    // Still idle before its scheduled wake-up: nothing to re-read yet.
    if (col === 'done' && t.state === 'queued' && t.wakeAt && Date.now() < t.wakeAt + 60_000) return false
    // An agent stopped by its usage limit is not done: it waits for the limit to reset (or for
    // you). Checked before the pickup guard, since a limit can stop an agent right at launch.
    if (col === 'running') {
      if (t.limit !== undefined) t.limit = undefined
    } else {
      const lim = await limitHit(t)
      if (lim !== null) {
        return parkOnLimit(t, lim)
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
        const r = orcaKey(t) ? (await lastReplies(true)).get(orcaKey(t) as string) : undefined
        return !!r && r.at >= (t.sentAt ?? 0)
      }
      if (col === 'running') t.awaitPickup = false
      else if (col === 'done' && fresh && !(await answered())) return false
      else t.awaitPickup = false
    }
    // A session that stops with a wake-up scheduled (a loop, a cron job) is not done: it goes back
    // to Queued until then. Waking up clears it.
    if (col === 'running' && t.wakeAt) {
      t.wakeAt = t.wakeKind = t.wakeLabel = undefined
    } else if (col === 'done' && t.agent === 'claude') {
      const w = await scheduleFor(t)
      if (w) {
        const moved = t.state !== 'queued' || t.wakeAt !== w.at
        t.wakeAt = w.at
        t.wakeKind = w.kind
        t.wakeLabel = w.label
        if (t.state !== 'queued') move(t, 'queued', tr(w.kind === 'loop' ? 'note.loop' : 'note.cron'))
        return moved
      }
      if (t.wakeAt) t.wakeAt = t.wakeKind = t.wakeLabel = undefined
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
      const t = await findTaskAsync(p)
      if (t) {
        const tt = tabTitle(p.title, [agentLabel(t.agent), t.projectName, t.bot, t.byBot])
        const retitled = !!tt && tt !== t.tabTitle
        if (retitled) t.tabTitle = tt
        if ((await applyAgentState(t, p.state, p, p.mainAgent?.stateStartedAt ?? p.receivedAt)) || retitled) {
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
      if (!t.workspaceId || t.error || (t.state === 'queued' && !t.wakeAt && t.limit === undefined) || t.wakeKind === 'automation') continue
      if (t.state === 'done' && t.last) continue
      const agents = await agentsIn(t.workspaceId)
      if (agents) {
        let a = agents.find((x) => (t.terminalId && x.terminalId === t.terminalId) || (t.sessionId && x.sessionId === t.sessionId))
        if (!a && t.source === 'pod' && !t.launchIn && !t.terminalId) a = agents[0]
        // The plugin API does not always tie a bot's chat to its session id: fall back to the
        // state `orca agent list` reports for that session.
        const s = !a && orcaKey(t) ? (await sessionInfo()).get(orcaKey(t) as string) : undefined
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
      if (await scanSubagents()) changed = true
      if (await refreshTitles()) changed = true
      if (await syncAutomations()) changed = true
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

  orca.panels.handle('pod.setLanguage', (input) =>
    serial(async () => {
      const lang = (LANGS as string[]).includes(input.language) ? input.language : 'en'
      await orca.settings.set('language', lang)
      tr = translator(lang)
      await updateStatusBar()
      return snapshot()
    })
  )

  // A new language rebuilds the strings; raising the limit from Settings starts queued tasks.
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
