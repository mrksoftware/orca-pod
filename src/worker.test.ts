// Runs src/worker.ts's activate(orca) over a mock Orca host.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'
import { claudeProjectDir, cleanLines, columnFor, describeTool, detectLimit, nextCron, nextWake, turnEnded, readActivity, readSubagents, sessionDirFor, setOrcaRunner, slug, tabTitle } from './worker'

// launches run in the background (void launch): give them time to finish, also on a busy machine
const settle = () => new Promise((r) => setTimeout(r, 150))

function host(extra: Record<string, unknown> = {}, maxParallel = 1) {
  let n = 0
  return mockHost({
    settings: { defaultAgent: 'claude', maxParallel, doneVisible: 6 },
    results: {
      'project.list': { projects: [{ id: 'p1', name: 'api', kind: 'git', hostId: 'local', path: 'D:/api' }], truncated: false },
      'workspace.create': () => { n += 1; return { workspaceId: 'ws' + n, terminalId: 'term' + n } },
      'terminal.read': { lines: ['╭────╮', '│ > │', 'Leggo src/orders.ts', '? for shortcuts'], truncated: false },
      'statusBar.update': { ok: true },
      'notifications.show': { delivered: true },
      'terminal.sendText': { accepted: true },
      'workspace.list': { workspaces: [], truncated: false },
      'agents.list': { agents: [] },
      ...extra,
    },
  })
}

test('maps Orca agent states to board columns', () => {
  assert.equal(columnFor('working'), 'running')
  assert.equal(columnFor('blocked'), 'waiting')
  assert.equal(columnFor('waiting'), 'waiting')
  assert.equal(columnFor('done'), 'done')
})

test('slugs titles for worktree names', () => {
  assert.equal(slug('Fix bug paginazione su lista ordini'), 'fix-bug-paginazione-lista')
  assert.equal(slug('!!!'), 'task')
})

test('recognises usage-limit messages and their reset time', () => {
  assert.equal(detectLimit('Claude usage limit reached. Your limit will reset at 3pm (Europe/Rome).'), '3pm (Europe/Rome)')
  assert.equal(detectLimit('5-hour limit reached ∙ resets 7pm'), '7pm')
  assert.equal(detectLimit("You've hit your limit · resets Nov 25 at 9am"), 'Nov 25 at 9am')
  assert.equal(detectLimit("You've hit your usage limit"), '')
  assert.equal(detectLimit('I added rate limiting to the API and the tests pass'), null)
  assert.equal(detectLimit('The lime line resets only when the goal changes'), null)
})

test('an agent stopped by the usage limit waits for you instead of looking done', async () => {
  const h = host({ 'terminal.read': { lines: ['Working on it', "You've hit your limit · resets 7pm"], truncated: false } }, 0)
  const w = await mountWorker(main, { host: h })
  await w.request('pod.add', { title: 'fai una cosa', targetId: 'p:p1' })
  await settle()
  // even right after launch, when an idle report is otherwise ignored
  await w.emit('agent.status.changed', { workspaceId: 'ws1', paneKey: 'a:b', terminalId: 'term1', state: 'done', receivedAt: Date.now() })
  let s = await w.request('pod.state')
  assert.equal(s.tasks[0].state, 'waiting')
  assert.equal(s.tasks[0].limit, '7pm')
  // working again clears it
  await w.emit('agent.status.changed', { workspaceId: 'ws1', paneKey: 'a:b', terminalId: 'term1', state: 'working', receivedAt: Date.now() })
  s = await w.request('pod.state')
  assert.equal(s.tasks[0].state, 'running')
  assert.equal(s.tasks[0].limit, undefined)
  await w.deactivate()
})

test("reads Claude sub-agents from a session's folder", async () => {
  const { mkdtemp, mkdir, writeFile, utimes } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  assert.equal(claudeProjectDir('C:\\Users\\me\\.orca\\bots\\pm', 'B'), join('B', 'C--Users-me--orca-bots-pm'))

  const proj = await mkdtemp(join(tmpdir(), 'pod-claude-'))
  const conv = 'conv-1'
  const subs = join(proj, conv, 'subagents')
  await mkdir(subs, { recursive: true })
  await writeFile(join(proj, conv + '.jsonl'), '{}')
  // while a sub-agent works its meta has no `finished` at all
  await writeFile(join(subs, 'agent-a.meta.json'), JSON.stringify({ description: 'Read the guide', agentType: 'web-fetch' }))
  await writeFile(join(subs, 'agent-a.jsonl'), '{}')
  await writeFile(join(subs, 'agent-b.meta.json'), JSON.stringify({ description: 'Explore repo', agentType: 'Explore', finished: true }))
  await writeFile(join(subs, 'agent-b.jsonl'), '{}')
  // unfinished but silent for an hour: crashed, not running
  await writeFile(join(subs, 'agent-c.meta.json'), JSON.stringify({ description: 'Stale', finished: false }))
  await writeFile(join(subs, 'agent-c.jsonl'), '{}')
  const old = new Date(Date.now() - 3600_000)
  await utimes(join(subs, 'agent-c.jsonl'), old, old)

  const list = await readSubagents(join(proj, conv))
  const byId = Object.fromEntries(list.map((s) => [s.id, s]))
  assert.equal(byId['agent-a'].running, true)
  assert.equal(byId['agent-a'].description, 'Read the guide')
  assert.equal(byId['agent-b'].running, false)
  assert.equal(byId['agent-c'].running, false)

  // exact by conversation id; a chat (unknown id) takes the latest session only when allowed
  assert.equal(await sessionDirFor(proj, conv, false), join(proj, conv))
  assert.equal(await sessionDirFor(proj, 'orca-chat-id', false), null)
  assert.equal(await sessionDirFor(proj, 'orca-chat-id', true), join(proj, conv))
})

test("reads what a Claude session is doing from its transcript's tail", async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'pod-act-'))
  const file = join(dir, 'conv.jsonl')
  const lines = [
    { type: 'user', message: { role: 'user', content: 'Fix the date picker on the settings page' } },
    // not requests: a permission denial and Orca's worker preamble
    { type: 'user', message: { role: 'user', content: 'Denied: Bash' } },
    { type: 'user', message: { role: 'user', content: 'You are working inside Orca, a multi-agent IDE.' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'Read', input: { file_path: 'C:/app/src/settings.tsx' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: '...' }] } },
    { type: 'user', isMeta: true, message: { role: 'user', content: '<system-reminder>ignored</system-reminder>' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Run the unit tests' } }] } },
  ]
  await writeFile(join(dir, 'conv.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const a = await readActivity(file)
  assert.equal(a?.prompt, 'Fix the date picker on the settings page')
  assert.deepEqual(a?.act, { kind: 'plain', detail: 'Run the unit tests' })

  // a bot's mail is titled by its Subject
  const mail = join(dir, 'bot.jsonl')
  await writeFile(mail, JSON.stringify({ type: 'user', message: { role: 'user', content: '──── From: term_1 (handoff) ──── Subject: Triage the new issues\nbody' } }) + '\n')
  assert.equal((await readActivity(mail))?.prompt, 'Triage the new issues')
  // a subject that says nothing gives way to the body
  const mail2 = join(dir, 'bot2.jsonl')
  await writeFile(mail2, JSON.stringify({ type: 'user', message: { role: 'user', content: '──── From: term_1 (status) ──── Subject: Denied: Bash\nStop the timezone probe: this is the third attempt.' } }) + '\n')
  assert.equal((await readActivity(mail2))?.prompt, 'Stop the timezone probe: this is the third attempt.')

  assert.deepEqual(describeTool('Edit', { file_path: 'D:\\x\\panel.js' }), { kind: 'edit', detail: 'panel.js' })
  assert.deepEqual(describeTool('Agent', { description: 'Explore repo' }), { kind: 'agent', detail: 'Explore repo' })
  assert.equal(await readActivity(join(dir, 'missing.jsonl')), null)
})

test('computes the next run of cron expressions', () => {
  const from = new Date(2026, 10, 25, 10, 7, 30).getTime() // Wed 25 Nov 2026 10:07:30
  const at = (m: number | null) => (m === null ? null : new Date(m))
  assert.equal(at(nextCron('*/15 * * * *', from))?.getMinutes(), 15)
  const daily = at(nextCron('30 9 * * *', from))!
  assert.deepEqual([daily.getDate(), daily.getHours(), daily.getMinutes()], [26, 9, 30])
  const oneShot = at(nextCron('15 14 25 11 *', from))!
  assert.deepEqual([oneShot.getDate(), oneShot.getHours(), oneShot.getMinutes()], [25, 14, 15])
  const monday = at(nextCron('0 8 * * 1', from))!
  assert.deepEqual([monday.getDay(), monday.getDate(), monday.getHours()], [1, 30, 8])
  assert.equal(nextCron('not a cron', from), null)
})

test('finds the next wake-up of a looping or scheduled session', () => {
  const now = Date.parse('2026-11-25T10:00:00Z')
  const L = (o: unknown) => JSON.stringify(o)
  const tool = (ts: string, name: string, input: unknown) => L({ timestamp: ts, message: { content: [{ type: 'tool_use', name, input }] } })
  // a dynamic loop: 20 minutes after its last ScheduleWakeup
  let w = nextWake([tool('2026-11-25T09:55:00Z', 'ScheduleWakeup', { delaySeconds: 1200, reason: 'watch CI' })], now)
  assert.equal(w?.kind, 'loop')
  assert.equal(w?.at, Date.parse('2026-11-25T10:15:00Z'))
  // stopped loop: nothing
  w = nextWake([tool('2026-11-25T09:55:00Z', 'ScheduleWakeup', { delaySeconds: 1200 }), tool('2026-11-25T09:58:00Z', 'ScheduleWakeup', { stop: true })], now)
  assert.equal(w, null)
  // a one-shot cron job, from CronCreate's result; deleted later: nothing
  const created = L({ timestamp: '2026-11-25T09:00:00Z', toolUseResult: { id: 'job1', humanSchedule: '15 14 25 11 *', recurring: false, nextFireAt: Date.parse('2026-11-25T13:15:00Z') } })
  w = nextWake([created], now)
  assert.equal(w?.kind, 'cron')
  assert.equal(w?.at, Date.parse('2026-11-25T13:15:00Z'))
  assert.equal(nextWake([created, tool('2026-11-25T09:30:00Z', 'CronDelete', { id: 'job1' })], now), null)
  // a recurring job: the result only says "Every 30 minutes", the cron is in the CronCreate call
  const rec = [
    L({ timestamp: '2026-11-25T09:00:00Z', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'CronCreate', input: { cron: '*/30 * * * *', recurring: true } }] } }),
    L({ timestamp: '2026-11-25T09:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] }, toolUseResult: { id: 'job2', humanSchedule: 'Every 30 minutes', recurring: true, nextFireAt: Date.parse('2026-11-25T09:30:00Z') } }),
  ]
  w = nextWake(rec, now)
  assert.equal(w?.kind, 'cron')
  assert.ok(w && w.at >= now && w.at <= now + 30 * 60_000)
  // Claude shifts a recurring job off its cron slot: fires at :13:20 and :43:20, not :00 and :30
  const shiftedJob = [
    L({ timestamp: '2026-11-25T09:35:08Z', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'CronCreate', input: { cron: '*/30 * * * *', recurring: true } }] } }),
    L({ timestamp: '2026-11-25T09:35:12Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'ok' }] }, toolUseResult: { id: 'job3', humanSchedule: 'Every 30 minutes', recurring: true, nextFireAt: Date.parse('2026-11-25T10:13:20Z') } }),
  ]
  assert.equal(nextWake(shiftedJob, Date.parse('2026-11-25T10:50:00Z'))?.at, Date.parse('2026-11-25T11:13:20Z'))
  assert.equal(nextWake(shiftedJob, Date.parse('2026-11-25T10:13:10Z'))?.at, Date.parse('2026-11-25T10:13:20Z'))
  assert.equal(nextWake(shiftedJob, Date.parse('2026-11-25T10:13:30Z'))?.at, Date.parse('2026-11-25T10:43:20Z'))
  // a one-shot whose time has passed has fired
  assert.equal(nextWake([created], Date.parse('2026-11-25T14:00:00Z')), null)
})

test('turnEnded: the last turn is over once turn_duration follows the last message', () => {
  const j = (o: unknown) => JSON.stringify(o)
  const msg = j({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } })
  const end = j({ type: 'system', subtype: 'turn_duration' })
  const noise = j({ type: 'attachment' })
  assert.equal(turnEnded([msg, end, noise]), true)
  assert.equal(turnEnded([end, msg, noise]), false)
  assert.equal(turnEnded([]), false)
})

test("Orca automations wait in Queued for their next run; they are never launched by Pod", async () => {
  const next = Date.now() + 3600_000
  const h = host({
    'workspace.list': { workspaces: [], truncated: false },
    'automation.list': {
      automations: [
        { id: 'a1', name: 'Nightly dependency check', agent: 'claude', prompt: 'Check outdated packages', promptTruncated: false, projectId: 'p1', hostId: 'local', workspaceId: null, workspaceMode: 'new-per-run', schedule: '0 2 * * *', timezone: 'Europe/Rome', enabled: true, nextRunAt: next, lastRunAt: null, createdByThisPlugin: false },
        { id: 'a2', name: 'Off', agent: 'claude', prompt: 'x', promptTruncated: false, projectId: 'p1', hostId: 'local', workspaceId: null, workspaceMode: 'new-per-run', schedule: '0 3 * * *', timezone: 'Europe/Rome', enabled: false, nextRunAt: next, lastRunAt: null, createdByThisPlugin: false },
      ],
      truncated: false,
    },
  }, 0)
  const w = await mountWorker(main, { host: h })
  const s = await w.request('pod.refresh')
  assert.equal(s.tasks.length, 1)
  assert.equal(s.tasks[0].state, 'queued')
  assert.equal(s.tasks[0].wakeKind, 'automation')
  assert.equal(s.tasks[0].wakeAt, next)
  assert.equal(s.tasks[0].projectName, 'api')
  await settle()
  assert.equal(h.callsOf('workspace.create').length + h.callsOf('agent.launch').length, 0)
  await w.deactivate()
})

test('keeps tab titles worth showing', () => {
  assert.equal(tabTitle('✳ Licenze per il bus di integrazione'), 'Licenze per il bus di integrazione')
  assert.equal(tabTitle('⠂ Fix the flaky checkout test'), 'Fix the flaky checkout test')
  assert.equal(tabTitle('Claude Code'), undefined)
  assert.equal(tabTitle('C:\\WINDOWS\\system32\\cmd.exe'), undefined)
  assert.equal(tabTitle('pwsh'), undefined)
  assert.equal(tabTitle('PM', ['PM']), undefined)
  assert.equal(tabTitle(null), undefined)
})

test('cleans TUI chrome from terminal lines', () => {
  assert.deepEqual(cleanLines(['╭──╮', '│ > │', 'Leggo src/a.ts', '? for shortcuts', '  ']), ['Leggo src/a.ts'])
  assert.deepEqual(cleanLines(['Fatto, test verdi', 'Notes | Opus 5.5 medium (alt+p, ←/→ effort) | ctx:33%']), ['Fatto, test verdi'])
})

test('queues past maxParallel and launches in a fresh worktree', async () => {
  const h = host()
  const w = await mountWorker(main, { host: h })
  await w.request('pod.add', { title: 'primo task', targetId: 'p:p1' })
  await w.request('pod.add', { title: 'secondo task', agent: 'codex', targetId: 'p:p1' })
  await settle()
  const s = await w.request('pod.state')
  assert.deepEqual(s.tasks.map((t) => t.state), ['running', 'queued'])
  assert.equal(s.tasks[0].terminalId, 'term1')
  assert.equal(s.tasks[0].title, 'Primo task')
  const create = h.callsOf('workspace.create')[0] as { projectId: string; agent: string; prompt: string; name: string }
  assert.equal(create.projectId, 'p1')
  assert.equal(create.agent, 'claude')
  assert.equal(create.prompt, 'Primo task')
  assert.ok(create.name.startsWith('pod-primo-task-'))
  assert.deepEqual(w.refusals, [])
  await w.deactivate()
})

test('follows agent status: waiting, reply, done frees a slot', async () => {
  const h = host()
  const w = await mountWorker(main, { host: h })
  await w.request('pod.add', { title: 'primo', targetId: 'p:p1' })
  await w.request('pod.add', { title: 'secondo', targetId: 'p:p1' })
  await settle()

  await w.emit('agent.status.changed', { workspaceId: 'ws1', paneKey: 'a:b', terminalId: 'term1', state: 'blocked', receivedAt: Date.now() })
  let s = await w.request('pod.state')
  assert.equal(s.tasks[0].state, 'waiting')
  assert.equal(s.tasks[0].question, 'Leggo src/orders.ts')
  assert.equal(h.callsOf('notifications.show').length, 1)

  s = await w.request('pod.reply', { id: s.tasks[0].id, text: 'procedi' })
  assert.equal(s.tasks[0].state, 'running')
  assert.deepEqual(h.callsOf('terminal.sendText')[0], { terminalId: 'term1', text: 'procedi', enter: true })

  await w.emit('agent.status.changed', { workspaceId: 'ws1', paneKey: 'a:b', terminalId: 'term1', state: 'done', receivedAt: Date.now() })
  await settle()
  s = await w.request('pod.state')
  assert.deepEqual(s.tasks.map((t) => t.state), ['done', 'running'])
  assert.equal(s.tasks[1].terminalId, 'term2')
  await w.deactivate()
})

const ORCA_WS = {
  workspaces: [
    { id: 'wsO', kind: 'worktree', name: 'feature-x', project: 'api', projectId: 'p1', path: 'D:/api-x', branch: 'feature-x', hostId: 'local', status: { state: 'working', unread: false, terminalCount: 1, lastActivityAt: Date.now() } },
    { id: 'wsOld', kind: 'worktree', name: 'old', project: 'api', projectId: 'p1', path: 'D:/api-old', branch: 'old', hostId: 'local', status: { state: 'done', unread: false, terminalCount: 1, lastActivityAt: Date.now() - 86_400_000 } },
  ],
  truncated: false,
}
const ORCA_AGENTS = (p: { workspaceId?: string }) => ({
  agents: p.workspaceId === 'wsO' ? [{ terminalId: 'termO', title: 'Sistema il login', agent: 'gemini', state: 'working', stateStartedAt: Date.now() - 5000, sessionId: 'sO' }] : [],
})

test('adopts agents started in Orca, without taking a Pod slot', async () => {
  const h = host({ 'workspace.list': ORCA_WS, 'agents.list': ORCA_AGENTS })
  const w = await mountWorker(main, { host: h })
  await settle()
  let s = await w.request('pod.state')
  assert.equal(s.tasks.length, 1)
  assert.equal(s.tasks[0].source, 'orca')
  assert.equal(s.tasks[0].title, 'Sistema il login')
  assert.equal(s.tasks[0].agent, 'gemini')
  assert.equal(s.tasks[0].state, 'running')
  assert.equal(s.tasks[0].branch, 'feature-x')
  // the old, idle workspace was not even asked for its agents
  assert.ok(!h.callsOf('agents.list').some((c) => (c as { workspaceId: string }).workspaceId === 'wsOld'))

  // maxParallel is 1, but the Orca agent does not count: Pod still launches its own task
  await w.request('pod.add', { title: 'mio task', targetId: 'p:p1' })
  await settle()
  s = await w.request('pod.state')
  assert.deepEqual(s.tasks.map((t) => [t.source, t.state]), [['orca', 'running'], ['pod', 'running']])

  // status events move the adopted card like any other
  await w.emit('agent.status.changed', { workspaceId: 'wsO', paneKey: 'x:y', terminalId: 'termO', state: 'waiting', receivedAt: Date.now() })
  s = await w.request('pod.state')
  assert.equal(s.tasks[0].state, 'waiting')
  await w.deactivate()
})

test('adopts an unknown agent on its first status event; a removed one stays off', async () => {
  let agentState = 'working'
  const h = host({
    'workspace.list': ORCA_WS,
    'agents.list': (p: { workspaceId?: string }) => (p.workspaceId === 'wsO' ? { agents: [{ terminalId: 'termO', title: 'Sistema il login', agent: 'claude', state: agentState, stateStartedAt: Date.now(), sessionId: 'sO' }] } : { agents: [] }),
  })
  const w = await mountWorker(main, { host: h, events: ['agent.status.changed', 'workspace.removed'] })
  await settle()
  let s = await w.request('pod.state')
  const id = s.tasks[0].id
  s = await w.request('pod.remove', { id })
  assert.equal(s.tasks.length, 0)

  // same activity: not re-adopted by discovery
  await w.request('pod.refresh')
  // new activity later: comes back
  await settle()
  agentState = 'blocked'
  await w.emit('agent.status.changed', { workspaceId: 'wsO', paneKey: 'x:y', terminalId: 'termO', state: 'blocked', receivedAt: Date.now() + 1000 })
  s = await w.request('pod.state')
  assert.equal(s.tasks.length, 1)
  assert.equal(s.tasks[0].state, 'waiting')
  await w.deactivate()
})

test('clears one or all completed tasks, and cleared Orca agents stay off', async () => {
  const h = host({ 'workspace.list': ORCA_WS, 'agents.list': ORCA_AGENTS }, 3)
  const w = await mountWorker(main, { host: h })
  await w.request('pod.add', { title: 'uno', targetId: 'p:p1' })
  await w.request('pod.add', { title: 'due', targetId: 'p:p1' })
  await settle()
  for (const term of ['term1', 'term2', 'termO']) {
    await w.emit('agent.status.changed', { workspaceId: null, paneKey: 'a:b', terminalId: term, state: 'working', receivedAt: Date.now() })
    await w.emit('agent.status.changed', { workspaceId: null, paneKey: 'a:b', terminalId: term, state: 'done', receivedAt: Date.now() })
  }
  let s = await w.request('pod.state')
  assert.equal(s.tasks.filter((t) => t.state === 'done').length, 3)

  s = await w.request('pod.clearDone', { ids: [s.tasks.find((t) => t.title === 'Uno')!.id] })
  assert.deepEqual(s.tasks.map((t) => t.title).sort(), ['Due', 'Sistema il login'])

  s = await w.request('pod.clearDone', {})
  assert.equal(s.tasks.length, 0)
  // the Orca agent is still listed by Orca, but discovery does not bring it back
  s = await w.request('pod.refresh')
  assert.equal(s.tasks.length, 0)
  await w.deactivate()
})

test('lists Git projects, folder projects and bots; starts a bot task in its own workspace', async () => {
  const h = host({
    'project.list': {
      projects: [
        { id: 'p1', name: 'api', kind: 'git', hostId: 'local', path: 'D:/api' },
        { id: 'p2', name: 'Notebook', kind: 'folder', hostId: 'local', path: 'D:/notebook' },
      ],
      truncated: false,
    },
    'workspace.list': {
      workspaces: [
        { id: 'p2::D:/notebook', kind: 'folder', name: 'notebook', project: 'Notebook', projectId: 'p2', path: 'D:/notebook', branch: null, hostId: 'local' },
        { id: 'folder:bot1', kind: 'folder', name: 'Junior Dev', path: 'C:/bots/junior', branch: null, hostId: null },
      ],
      truncated: false,
    },
    'agent.launch': { terminalId: 'termBot' },
  })
  const w = await mountWorker(main, { host: h })
  let s = await w.request('pod.state')
  assert.deepEqual(s.targets.map((t) => [t.kind, t.name, t.id]), [
    ['git', 'api', 'p:p1'],
    ['folder', 'Notebook', 'w:p2::D:/notebook'],
    ['bot', 'Junior Dev', 'w:folder:bot1'],
  ])

  // a folder project still starts an agent in its workspace
  await w.request('pod.add', { title: 'riordina le note', targetId: 'w:p2::D:/notebook' })
  await settle()
  assert.deepEqual(h.callsOf('agent.launch')[0], { workspaceId: 'p2::D:/notebook', agent: 'claude', prompt: 'Riordina le note' })
  assert.equal(h.callsOf('workspace.create').length, 0)
  await w.deactivate()
})

test('a bot gets the task as mail in its Home Chat, and stays running until it answers', async () => {
  const cli: string[][] = []
  let reply: { text: string; at: number } | null = null
  setOrcaRunner(async (args) => {
    cli.push(args)
    if (args[0] === 'bot' && args[1] === 'chats') return { chats: [{ id: 'homeJ', home: true, closed: false }] }
    if (args[0] === 'agent' && args[1] === 'list') return { agents: reply ? [{ orcaSessionId: 'homeJ', lastAssistantMessage: reply.text, updatedAt: reply.at }] : [] }
    return { messageId: 'm1' }
  })
  try {
    const old = Date.now() - 60_000
    const h = host({
      'workspace.list': { workspaces: [{ id: 'folder:bot1', kind: 'folder', name: 'Junior Dev', path: 'C:/bots/junior', branch: null, hostId: null }], truncated: false },
      // the Home Chat is idle since before the message
      'agents.list': { agents: [{ terminalId: null, title: 'Junior Dev', agent: 'claude', state: 'done', stateStartedAt: old, sessionId: 'homeJ' }] },
      'terminal.create': { terminalId: 'termMailbox' },
      'terminal.list': { terminals: [{ id: 'termMailbox', title: 'Pod' }], truncated: false },
    })
    const w = await mountWorker(main, { host: h })
    await w.request('pod.add', { title: 'apri la issue del grafico', targetId: 'w:folder:bot1' })
    await settle()
    let s = await w.request('pod.state')
    const t = s.tasks.find((x) => x.source === 'pod')!
    assert.equal(t.state, 'running')
    assert.equal(t.bot, 'Junior Dev')
    assert.equal(t.sessionId, 'homeJ')
    assert.equal(h.callsOf('agent.launch').length, 0, 'a bot is not launched again')
    const send = cli.find((a) => a[0] === 'orchestration')!
    // sent from Pod's own terminal in the bot's workspace: orchestration mail needs a live sender
    assert.deepEqual(send.slice(0, 10), ['orchestration', 'send', '--to', 'bot:Junior Dev', '--from', 'termMailbox', '--type', 'handoff', '--subject', 'Apri la issue del grafico'])
    assert.deepEqual(h.callsOf('terminal.create'), [{ workspaceId: 'folder:bot1', title: 'Pod' }])
    // the adopted Home Chat card was merged into the task, not shown twice
    assert.equal(s.tasks.filter((x) => x.sessionId === 'homeJ').length, 1)

    // the old idle state does not close it
    s = await w.request('pod.refresh')
    assert.equal(s.tasks.find((x) => x.id === t.id)!.state, 'running')

    // the bot picks it up, then finishes
    await w.emit('agent.status.changed', { workspaceId: 'folder:bot1', paneKey: 'p', sessionId: 'homeJ', state: 'working', receivedAt: Date.now() })
    reply = { text: 'Fatto: issue #70 aperta', at: Date.now() + 1 }
    await w.emit('agent.status.changed', { workspaceId: 'folder:bot1', paneKey: 'p', sessionId: 'homeJ', state: 'done', receivedAt: Date.now() + 1 })
    s = await w.request('pod.state')
    const done = s.tasks.find((x) => x.id === t.id)!
    assert.equal(done.state, 'done')
    assert.equal(done.last, 'Fatto: issue #70 aperta')

    // a bot so quick that no "working" was ever seen: its fresh reply is enough to close the card
    await w.request('pod.reply', { id: t.id, text: 'rispondi solo pong' })
    reply = { text: 'pong', at: Date.now() + 5 }
    await w.emit('agent.status.changed', { workspaceId: 'folder:bot1', paneKey: 'p', sessionId: 'homeJ', state: 'done', receivedAt: Date.now() + 6 })
    s = await w.request('pod.state')
    assert.equal(s.tasks.find((x) => x.id === t.id)!.state, 'done')
    assert.equal(s.tasks.find((x) => x.id === t.id)!.last, 'pong')

    // a follow-up is mail to the same chat
    await w.request('pod.reply', { id: t.id, text: 'aggiungi anche lo screenshot' })
    assert.equal(cli.filter((a) => a[0] === 'orchestration').length, 3)
    assert.equal(h.callsOf('terminal.create').length, 1, 'the mailbox terminal is reused')
    s = await w.request('pod.state')
    assert.equal(s.tasks.find((x) => x.id === t.id)!.state, 'running')
    await w.deactivate()
  } finally {
    setOrcaRunner(null)
  }
})

test('0 means no limit; the panel can change the limit and queued tasks start', async () => {
  const h = host({}, 0)
  const w = await mountWorker(main, { host: h })
  for (const title of ['a', 'b', 'c', 'd', 'e']) await w.request('pod.add', { title, targetId: 'p:p1' })
  await settle()
  let s = await w.request('pod.state')
  assert.equal(s.maxParallel, 0)
  assert.equal(s.tasks.filter((t) => t.state === 'running').length, 5)

  s = await w.request('pod.setMaxParallel', { value: 1 })
  assert.equal(s.maxParallel, 1)
  assert.equal(h.data().settings.maxParallel, 1)
  await w.deactivate()
})

test('English by default; Italian and Spanish selectable', async () => {
  const h = host()
  const w = await mountWorker(main, { host: h })
  let s = await w.request('pod.state')
  assert.equal(s.language, 'en')
  await w.request('pod.add', { title: 'one', targetId: 'p:p1' })
  await settle()
  s = await w.request('pod.state')
  assert.equal(s.tasks[0].timeline[1].note, 'starting Claude')

  s = await w.request('pod.setLanguage', { language: 'es' })
  assert.equal(s.language, 'es')
  assert.equal(h.data().settings.language, 'es')
  await w.emit('agent.status.changed', { workspaceId: 'ws1', paneKey: 'a:b', terminalId: 'term1', state: 'blocked', receivedAt: Date.now() })
  await w.request('pod.retry', { id: s.tasks[0].id }).catch(() => undefined)
  s = await w.request('pod.state')
  assert.ok(s.tasks[0].timeline.some((e) => e.note === 'reintento'))

  s = await w.request('pod.setLanguage', { language: 'xx' })
  assert.equal(s.language, 'en')
  await w.deactivate()
})

test("in a bot's workspace only its real chats are shown; stray sessions are dropped", async () => {
  setOrcaRunner(async (args) => (args[0] === 'bot' && args[1] === 'chats' ? { chats: [{ id: 'homePM', home: true, closed: false }] } : {}))
  try {
    const now = Date.now()
    const h = host({
      'workspace.list': { workspaces: [{ id: 'folder:pm', kind: 'folder', name: 'PM', path: 'C:/bots/pm', branch: null, hostId: null, status: { state: 'working', unread: false, terminalCount: 2, lastActivityAt: now } }], truncated: false },
      'agents.list': {
        agents: [
          { terminalId: null, title: 'PM', agent: 'claude', state: 'working', stateStartedAt: now, sessionId: 'homePM' },
          { terminalId: null, title: 'PM', agent: 'claude', state: 'working', stateStartedAt: now, sessionId: 'stray' },
        ],
      },
    })
    const w = await mountWorker(main, { host: h })
    await settle()
    const s = await w.request('pod.state')
    assert.deepEqual(s.tasks.map((t) => t.sessionId), ['homePM'])
    // an event from the stray session does not bring it in either
    await w.emit('agent.status.changed', { workspaceId: 'folder:pm', paneKey: 'x', sessionId: 'stray', state: 'working', receivedAt: now + 1 })
    assert.equal((await w.request('pod.state')).tasks.length, 1)
    await w.deactivate()
  } finally {
    setOrcaRunner(null)
  }
})

test("a bot's worker is tagged with the bot that started it", async () => {
  setOrcaRunner(async (args) =>
    args[0] === 'worktree' && args[1] === 'ps'
      ? {
          worktrees: [
            { worktreeId: 'repo::C:/w/pearleye', workspaceKind: 'git', bot: 'Junior Dev', identity: { key: 'wt2:local:pe' } },
            { worktreeId: 'folder:jd', workspaceKind: 'folder-workspace', bot: 'Junior Dev' },
          ],
        }
      : {}
  )
  try {
    const now = Date.now()
    const h = host({
      'workspace.list': { workspaces: [{ id: 'identity:wt2:local:pe', kind: 'worktree', name: 'pearleye', project: 'acme-web', projectId: 'p1', path: 'C:/w/pearleye', branch: 'fix', hostId: 'local', status: { state: 'working', unread: false, terminalCount: 1, lastActivityAt: now } }], truncated: false },
      'agents.list': { agents: [{ terminalId: null, title: 'IMPLEMENT issue #67', agent: 'claude', state: 'working', stateStartedAt: now, sessionId: 'w67' }] },
    })
    const w = await mountWorker(main, { host: h })
    await settle()
    const s = await w.request('pod.refresh')
    assert.equal(s.tasks.length, 1)
    assert.equal(s.tasks[0].byBot, 'Junior Dev')
    assert.equal(s.tasks[0].place, 'git')
    await w.deactivate()
  } finally {
    setOrcaRunner(null)
  }
})

test('the idle blip right after a launch does not mark the task done', async () => {
  const h = host({}, 0)
  const w = await mountWorker(main, { host: h })
  await w.request('pod.add', { title: 'fai una cosa', targetId: 'p:p1' })
  await settle()
  // Claude Code reports done for a moment after it starts, before the prompt arrives
  await w.emit('agent.status.changed', { workspaceId: 'ws1', paneKey: 'a:b', terminalId: 'term1', state: 'done', receivedAt: Date.now() })
  let s = await w.request('pod.state')
  assert.equal(s.tasks[0].state, 'running')
  await w.emit('agent.status.changed', { workspaceId: 'ws1', paneKey: 'a:b', terminalId: 'term1', state: 'working', receivedAt: Date.now() })
  await w.emit('agent.status.changed', { workspaceId: 'ws1', paneKey: 'a:b', terminalId: 'term1', state: 'done', receivedAt: Date.now() })
  s = await w.request('pod.state')
  assert.equal(s.tasks[0].state, 'done')
  await w.deactivate()
})

test('a send cut off by a restart becomes a failure to retry, never a silent resend', async () => {
  const cli: string[][] = []
  setOrcaRunner(async (args) => (cli.push(args), {}))
  try {
    const now = Date.now()
    const stuck = { id: 'tS', source: 'pod', title: 'Ciao PM', agent: 'claude', projectId: '', projectName: 'PM', launchIn: 'folder:pm', bot: 'PM', workspaceId: 'folder:pm', state: 'running', since: now, createdAt: now, timeline: [{ s: 'queued', at: now }, { s: 'running', at: now }] }
    const h = mockHost({ settings: { maxParallel: 0 }, storage: { tasks: [stuck] }, results: { 'statusBar.update': { ok: true }, 'workspace.list': { workspaces: [], truncated: false }, 'project.list': { projects: [], truncated: false }, 'agents.list': { agents: [] } } })
    const w = await mountWorker(main, { host: h })
    await settle()
    const t = (await w.request('pod.state')).tasks[0]
    assert.equal(t.state, 'waiting')
    assert.ok(t.error)
    assert.equal(cli.filter((a) => a[0] === 'orchestration').length, 0)
    await w.deactivate()
  } finally {
    setOrcaRunner(null)
  }
})

test('a failed launch waits for you and can be retried', async () => {
  let fail = true
  const h = host({
    'workspace.create': () => {
      if (fail) throw Object.assign(new Error('branch exists'), { code: 'action_failed' })
      return { workspaceId: 'ws9', terminalId: 'term9' }
    },
  })
  const w = await mountWorker(main, { host: h })
  await w.request('pod.add', { title: 'rotto', targetId: 'p:p1' })
  await settle()
  let s = await w.request('pod.state')
  assert.equal(s.tasks[0].state, 'waiting')
  assert.ok(s.tasks[0].error)
  fail = false
  await w.request('pod.retry', { id: s.tasks[0].id })
  await settle()
  s = await w.request('pod.state')
  assert.equal(s.tasks[0].state, 'running')
  assert.equal(s.tasks[0].error, undefined)
  await w.deactivate()
})
