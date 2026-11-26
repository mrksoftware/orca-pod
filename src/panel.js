// Pod panel. The worker owns the tasks; this frame renders them as the animated board from the
// Claude Design prototype (FLIP moves between columns, pipe tokens, counters) and sends actions
// back with orca.plugin.request. Cards are keyed by task id and updated in place, so running
// shimmer and waiting glow animations do not restart on every refresh.

import { LANGS, SPEECH_LANG, translator } from './i18n.js'

/** Current language and its translator; set from the worker's state (setting `language`). */
let LANG = 'en'
let T = translator(LANG)
const stateLabel = (s) => T('state.' + s)
const AGENTS = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', opencode: 'OpenCode', opencode2: 'OpenCode', copilot: 'Copilot', cursor: 'Cursor', grok: 'Grok', pi: 'Pi', kiro: 'Kiro', devin: 'Devin', droid: 'Droid' }
const LANES = ['claude', 'codex']
const REFRESH_MS = 4000
const LOG_MS = 2500

const $ = (s, el = document) => el.querySelector(s)
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s))
const root = $('#root')
const reduced = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false } })()

const S = {
  tasks: [],
  targets: [],
  maxParallel: 0,
  hiddenLanes: [],
  tabs: [],
  active: null,
  panelOpen: false,
  panelW: 440,
  replies: {},
  logs: {},
  listening: false,
  prevState: {},
  prevCounts: null,
}

/* ---------- helpers ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const pad = (n) => String(n).padStart(2, '0')
function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return s + 's'
  if (s < 3600) return Math.floor(s / 60) + 'm ' + pad(s % 60) + 's'
  if (s < 86400) return Math.floor(s / 3600) + 'h ' + pad(Math.floor((s % 3600) / 60)) + 'm'
  return Math.floor(s / 86400) + T('unit.day')
}
const fmtClock = (t) => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) }

/** The card's timer. Queued and running tick. Done and waiting are frozen at how long the agent
 *  worked before it stopped; an agent adopted when already stopped shows the time it stopped. */
/** A scheduled run's time: HH:MM today, else day/month HH:MM. */
function fmtWake(at) {
  const d = new Date(at)
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes())
  return d.toDateString() === new Date().toDateString() ? hm : pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' ' + hm
}
const untilText = (at) => (at - Date.now() > 30_000 ? T('wake.in', { t: fmtElapsed(at - Date.now()) }) : T('wake.due'))
/** A card that finished a moment ago keeps a soft glow, so you notice what just completed. */
const FRESH_MS = 5 * 60_000
const isFresh = (t) => t.state === 'done' && Date.now() - t.since < FRESH_MS
const isLimited = (t) => t.limit !== undefined && (t.state === 'queued' || t.state === 'waiting')
const isScheduled = (t) => t.state === 'queued' && !!t.wakeAt

function timer(t) {
  // scheduled: a countdown to the next run
  if (isScheduled(t)) return { kind: 'live', text: untilText(t.wakeAt) }
  if (t.state === 'running' || t.state === 'queued') return { kind: 'live', text: fmtElapsed(Date.now() - t.since) }
  const tl = t.timeline || []
  for (let i = tl.length - 1; i >= 0; i--) {
    if (tl[i].s === 'running' && tl[i].at <= t.since) return { kind: 'ran', text: fmtElapsed(t.since - tl[i].at) }
  }
  return { kind: 'at', text: fmtClock(t.since).slice(0, 5) }
}
const detailTimer = (t) => {
  const x = timer(t)
  return T(x.kind === 'live' ? 'detail.inState' : x.kind === 'ran' ? 'detail.ranFor' : 'detail.stoppedAt', { t: x.text })
}
const agentName = (a) => AGENTS[a] || (a ? a.charAt(0).toUpperCase() + a.slice(1) : 'Agent')
const laneOf = (a) => (LANES.includes(a) ? a : 'other')
const byId = (id) => S.tasks.find((t) => t.id === id)
const isError = (t) => !!t.error

async function call(name, input) {
  try {
    return await orca.plugin.request(name, input)
  } catch (e) {
    showBanner((e && e.message) || String(e))
    throw e
  }
}
let bannerT
function showBanner(msg) {
  const b = $('#banner')
  b.textContent = msg
  b.hidden = false
  clearTimeout(bannerT)
  bannerT = setTimeout(() => { b.hidden = true; measureHeader() }, 6000)
  measureHeader()
}

/* ---------- icons ---------- */
// Real agent logos (simple-icons 13.21.0, CC0): Claude's spark and OpenAI's knot for Codex.
const LOGO_PATH = {
  claude: 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z',
  codex: 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z',
}
const logo = (agent, cls = '') => '<svg class="logo logo--' + agent + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true"><path d="' + LOGO_PATH[agent] + '"></path></svg>'

const IC = {
  claude: logo('claude'),
  codex: logo('codex'),
  branch: '<svg class="ic ic--s" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v12"></path><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg>',
  bot: '<svg class="ic ic--s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8V4H8"></path><rect x="4" y="8" width="16" height="12" rx="2"></rect><path d="M9 13v2M15 13v2"></path></svg>',
  repo: '<svg class="ic ic--s" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"></path></svg>',
  subs: '<svg class="ic ic--s" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="5" r="2.5"></circle><circle cx="6" cy="19" r="2.5"></circle><circle cx="18" cy="12" r="2.5"></circle><path d="M6 7.5v9M6 12h9.5"></path></svg>',
  alarm: '<svg class="ic ic--s" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="8"></circle><path d="M12 9v4l2 2M5 3 2 6M22 6l-3-3"></path></svg>',
  hourglass: '<svg class="ic ic--s" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h12M6 22h12M7 2v4a5 5 0 0 0 10 0V2M7 22v-4a5 5 0 0 1 10 0v4"></path></svg>',
  chat: '<svg class="ic ic--s" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>',
  term: '<svg class="ic ic--s" viewBox="0 0 24 24" aria-hidden="true"><path d="m4 17 6-6-6-6"></path><path d="M12 19h8"></path></svg>',
  folder: '<svg class="ic ic--s" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"></path></svg>',
  clock: '<svg class="ic ic--s" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>',
  check: '<span class="ck" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg></span>',
  x: '<svg class="ic ic--s" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>',
}

/* ---------- board ---------- */
const cards = new Map()

function listKey(t) {
  if (t.state === 'running') return 'running:' + laneOf(t.agent)
  return t.state
}

function cardSig(t) {
  return [LANG, t.state, t.title, t.agent, t.branch || '', t.projectName, t.source, placeOf(t), modeOf(t), t.byBot || '', t.limit ?? '-', t.wakeAt || 0, t.wakeKind || '', runningSubs(t).map((s) => s.id + s.description).join(','), isError(t) ? 'e' : ''].join('|')
}

/** Where a task runs: a worktree of a Git project, a folder project's workspace, or a bot. */
const placeOf = (t) => t.place || (t.bot ? 'bot' : t.branch ? 'git' : 'folder')
/** How the agent runs: a bot's chat, a chat session, or a CLI in a terminal (unknown while queued). */
const modeOf = (t) => (t.bot ? 'bot' : t.terminalId ? 'cli' : t.sessionId ? 'chat' : null)
/** One colour per project, folder or bot, stable by name. Hues skip lime, amber and red, which
 *  mean running, waiting and error. */
const PLACE_HUES = [190, 215, 250, 275, 300, 325, 170, 30]
function placeHue(name) {
  let h = 0
  for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0
  return PLACE_HUES[h % PLACE_HUES.length]
}
function placeChip(t) {
  const kind = placeOf(t)
  const icon = kind === 'bot' ? IC.bot : kind === 'git' ? IC.repo : IC.folder
  const tag = kind === 'bot' ? '<b>BOT</b>' : ''
  return '<span class="place place--' + kind + '" title="' + esc(T('place.' + kind) + ': ' + t.projectName) + '">' + icon + tag + '<span>' + esc(t.projectName) + '</span></span>'
}
/** Orca's own title is often generic ("Claude Code", the bot's or workspace's name): then the card
 *  is titled by the last thing the agent was asked. */
function isGenericTitle(t) {
  const s = (t.title || '').trim().toLowerCase()
  if (!s) return true
  return [agentName(t.agent), 'claude code', 'claude', 'codex', t.projectName, t.bot, t.byBot].some((g) => g && s === String(g).trim().toLowerCase())
}
/** The card's title: the agent's tab title in Orca (Claude names its session), else Orca's own
 *  title, else, when that is generic, the last thing the agent was asked. */
const displayTitle = (t) => t.tabTitle || (t.prompt && isGenericTitle(t) ? t.prompt : t.title)
/** Under the title, what you asked: the latest request (or, for a Pod task, the message you wrote),
 *  when it differs from the title. */
function askText(t) {
  if (t.state === 'queued') return ''
  const title = displayTitle(t)
  const ask = t.prompt || (t.source === 'pod' ? t.title : '')
  if (!ask) return ''
  const same = (a, b) => a === b || b.startsWith(a.replace(/…$/, '')) || a.startsWith(b.replace(/…$/, ''))
  return same(ask, title) ? '' : ask
}

/** Claude sub-agents working for this task right now: count, then what each one does. */
const runningSubs = (t) => (t.subagents || []).filter((s) => s.running)
function subsLine(t) {
  const subs = runningSubs(t)
  if (!subs.length || (t.state !== 'running' && t.state !== 'waiting')) return ''
  const what = subs.map((s) => esc(s.description)).join(' · ')
  return '<span class="c-subs" title="' + what + '">' + IC.subs + '<b>' + esc(T(subs.length === 1 ? 'sub.one' : 'sub.many', { n: subs.length })) + '</b><span class="c-subs-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="c-subs-what">' + what + '</span></span>'
}

/** For a bot's worker: which bot started it, in that bot's colour. */
function ownerChip(t) {
  if (!t.byBot) return ''
  return '<span class="place place--owner" style="--pc: hsl(' + placeHue(t.byBot) + ' var(--pc-s) var(--pc-l))" title="' + esc(T('owner.title', { bot: t.byBot })) + '">' + IC.bot + '<b>BOT</b><span>' + esc(t.byBot) + '</span></span>'
}
function modeIcon(t) {
  const m = modeOf(t)
  if (!m || m === 'bot') return ''
  return '<span class="mode" title="' + esc(T('mode.' + m)) + '">' + (m === 'chat' ? IC.chat : IC.term) + '</span>'
}

const srcChip = (t) => (t.source === 'orca' ? '<span class="src" title="' + esc(T('src.orcaTitle')) + '">Orca</span>' : '<span class="src src--pod" title="' + esc(T('src.podTitle')) + '">Pod</span>')

function cardInner(t) {
  const err = isError(t)
  // Running: the agent's logo inside a spinning ring (Claude's spark also turns, like Claude Code's spinner).
  const orbAgent = LOGO_PATH[t.agent] ? t.agent : null
  const lead = t.state === 'running'
    ? '<span class="c-orb' + (orbAgent ? ' c-orb--' + orbAgent : '') + '" aria-hidden="true">' + (orbAgent ? logo(orbAgent) : IC.bot) + '</span>'
    : t.state === 'done' ? IC.check : ''
  const badge = isLimited(t) && !err
    ? '<span class="badge badge--limit" title="' + esc(t.limit ? T('limit.resets', { t: t.limit }) : T('badge.limit')) + '">' + IC.hourglass + (t.limit ? esc(t.limit) : T('badge.limit')) + '</span>'
    : isScheduled(t)
    ? '<span class="badge badge--wake" title="' + esc(T('wake.' + (t.wakeKind || 'cron')) + (t.wakeLabel ? ': ' + t.wakeLabel : '')) + '">' + IC.alarm + esc(fmtWake(t.wakeAt)) + '</span>'
    : t.state === 'waiting'
    ? t.limit !== undefined && !err
      ? '<span class="badge badge--limit" title="' + esc(t.limit ? T('limit.resets', { t: t.limit }) : T('badge.limit')) + '">' + IC.hourglass + (t.limit ? esc(t.limit) : T('badge.limit')) + '</span>'
      : '<span class="badge"><span class="badge-dot"></span>' + (err ? T('badge.error') : T('badge.input')) + '</span>'
    : t.state === 'done'
      ? '<button class="c-clear" data-clear title="' + esc(T('card.clear')) + '" aria-label="' + esc(T('card.clearAria', { title: t.title })) + '">' + IC.x + '</button>'
      : ''
  const branch = t.branch ? '<span class="c-branch">' + IC.branch + '<b>' + esc(t.branch) + '</b></span>' : ''
  return (
    '<span class="c-top">' + lead + '<span class="c-title" data-el="title"></span>' + badge + '</span>' +
    '<span class="c-ask" data-el="ask"></span>' +
    '<span class="c-place">' + ownerChip(t) + placeChip(t) + srcChip(t) + '</span>' +
    '<span class="c-meta"><span class="c-agent">' + (IC[t.agent] || IC.bot) + esc(agentName(t.agent)) + modeIcon(t) + '</span>' + branch +
    '<span class="c-time">' + IC.clock + '<span data-el="time"></span></span></span>' +
    subsLine(t) +
    '<span class="c-last" data-el="last"></span>' +
    (t.state === 'running' ? '<span class="ibar" aria-hidden="true"></span>' : '')
  )
}

function lastText(t) {
  if (isLimited(t)) return t.question || t.last || ''
  if (isScheduled(t)) return T('wake.next', { kind: T('wake.' + (t.wakeKind || 'cron')), at: fmtWake(t.wakeAt), in: untilText(t.wakeAt) })
  if (t.state === 'waiting') return t.question || t.last || ''
  // running: what it is doing right now, when its transcript says
  if (t.state === 'running' && t.activity) return t.activity
  return t.last || ''
}

function updateCard(el, t) {
  const sig = cardSig(t)
  if (el._sig !== sig) {
    el._sig = sig
    el.className = 'card card--' + t.state + (isError(t) ? ' card--error' : isLimited(t) ? ' card--limit' : isScheduled(t) ? ' card--scheduled' : '')
    el.style.setProperty('--ph', String(placeHue(t.projectName)))
    el.innerHTML = cardInner(t)
    el.setAttribute('aria-label', t.title + ', ' + stateLabel(t.state) + ', ' + agentName(t.agent) + '. ' + T('card.hint'))
  }
  el.classList.toggle('is-open', S.panelOpen && S.active === t.id)
  el.classList.toggle('card--fresh', isFresh(t))
  const last = lastText(t)
  const lastEl = el.querySelector('[data-el="last"]')
  if (lastEl && lastEl.textContent !== last) lastEl.textContent = last
  lastEl?.classList.toggle('c-last--now', t.state === 'running' && !!t.activity)
  // title and latest request change while the agent works: updated in place, no rebuild
  const titleEl = el.querySelector('[data-el="title"]')
  const title = displayTitle(t)
  if (titleEl && titleEl.textContent !== title) { titleEl.textContent = title; titleEl.title = t.title }
  const askEl = el.querySelector('[data-el="ask"]')
  const ask = askText(t)
  if (askEl && askEl.textContent !== ask) askEl.textContent = ask
  const time = el.querySelector('[data-el="time"]')
  if (time) time.textContent = timer(t).text
}

// A card is a div with role=button so a done card can hold its own clear button.
function makeCard(t) {
  const el = document.createElement('div')
  el.dataset.fid = t.id
  el.setAttribute('role', 'button')
  el.tabIndex = 0
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-clear]')) { e.stopPropagation(); clearDone([t.id]); return }
    openCard(t.id, e)
  })
  el.addEventListener('keydown', (e) => {
    if (e.target !== el || (e.key !== 'Enter' && e.key !== ' ')) return
    e.preventDefault()
    openCard(t.id, e)
  })
  el.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); openCard(t.id, { ctrlKey: true }) } })
  return el
}

/** Animates completed cards out (staggered), then asks the worker to drop them. */
async function clearDone(ids) {
  const els = (ids ?? [...cards.keys()].filter((id) => byId(id)?.state === 'done')).map((id) => cards.get(id)).filter(Boolean)
  if (!els.length) return
  if (!reduced) {
    await Promise.all(els.map((el, i) => el.animate(
      [{ transform: 'none', opacity: 1 }, { transform: 'translateX(14px) scale(.96)', opacity: 0.6, offset: 0.4 }, { transform: 'translateX(60px) scale(.85)', opacity: 0 }],
      { duration: 360, delay: i * 60, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' }
    ).finished.catch(() => {})))
  }
  for (const el of els) el.style.visibility = 'hidden'
  for (const el of els) if (S.tabs.includes(el.dataset.fid)) S.tabs = S.tabs.filter((x) => x !== el.dataset.fid)
  try { apply(await call('pod.clearDone', ids ? { ids } : {})) } catch { for (const el of els) { el.style.visibility = ''; el.getAnimations().forEach((a) => a.cancel()) } }
}

function sorted() {
  return S.tasks.slice().sort((a, b) => (a.state === 'done' ? b.since - a.since : a.since - b.since))
}

function render(opts = {}) {
  const anim = !reduced && opts.animate !== false
  const before = {}
  if (anim) for (const [id, el] of cards) before[id] = el.getBoundingClientRect()
  let src = null
  if (anim && opts.flyId) src = $('#aq-input').getBoundingClientRect()

  // place cards
  const lists = {}
  for (const el of $$('[data-list]')) lists[el.dataset.list] = { el, ids: [] }
  for (const t of sorted()) lists[listKey(t)]?.ids.push(t.id)
  const live = new Set(S.tasks.map((t) => t.id))
  for (const [id, el] of cards) if (!live.has(id)) { el.remove(); cards.delete(id) }
  for (const key in lists) {
    const { el: listEl, ids } = lists[key]
    ids.forEach((id, i) => {
      const t = byId(id)
      let el = cards.get(id)
      if (!el) { el = makeCard(t); cards.set(id, el) }
      updateCard(el, t)
      if (listEl.children[i] !== el) listEl.insertBefore(el, listEl.children[i] || null)
    })
    const empty = $('[data-empty="' + key + '"]')
    if (empty) empty.hidden = ids.length > 0
  }

  // lanes, counts, header
  const c = { queued: 0, running: 0, waiting: 0, done: 0 }
  for (const t of S.tasks) c[t.state] += 1
  for (const a of [...LANES, 'other']) {
    const n = S.tasks.filter((t) => t.state === 'running' && listKey(t) === 'running:' + a).length
    const lane = $('[data-lane="' + a + '"]')
    lane.classList.toggle('is-busy', n > 0)
    lane.hidden = a === 'other' ? n === 0 : n === 0 && S.hiddenLanes.includes(a)
    const subs = S.tasks.filter((t) => t.state === 'running' && listKey(t) === 'running:' + a).reduce((k, t) => k + runningSubs(t).length, 0)
    $('[data-lane-status="' + a + '"]').textContent = n ? T('lane.busy', { n }) + (subs ? ' · ' + T('sub.short', { n: subs }) : '') : T('lane.idle')
  }
  for (const k in c) {
    const el = $('[data-count="' + k + '"]')
    if (el.textContent !== String(c[k])) {
      const up = S.prevCounts && c[k] > S.prevCounts[k]
      el.textContent = String(c[k])
      if (anim && S.prevCounts && el.animate) el.animate([{ transform: 'translateY(' + (up ? '80%' : '-80%') + ') scale(.6)', opacity: 0 }, { transform: 'translateY(0) scale(1.25)', opacity: 1, offset: 0.6 }, { transform: 'none', opacity: 1 }], { duration: 480, easing: 'cubic-bezier(.34,1.56,.64,1)' })
    }
    el.setAttribute('aria-label', T('count.aria', { n: c[k] }))
    $('[data-col="' + k + '"]').classList.toggle('has-items', c[k] > 0)
  }
  S.prevCounts = c
  $('#clear-all').hidden = c.done === 0
  $('#sub-running').textContent = S.maxParallel > 0 ? T('par.max', { n: S.maxParallel }) : T('par.none')
  $('#par-dec').disabled = S.maxParallel === 0
  const live$ = $('.live')
  live$.classList.toggle('is-idle', c.running === 0)
  $('#live-text').textContent = T(c.running === 1 ? 'live.one' : 'live.many', { n: c.running }) + (c.waiting ? ' · ' + T('live.waiting', { n: c.waiting }) : '')

  // transitions -> pipe tokens
  const edges = []
  for (const t of S.tasks) {
    const p = S.prevState[t.id]
    if (p && p !== t.state) {
      if (p === 'queued' && t.state === 'running') edges.push('assign')
      else if (p === 'running' && t.state === 'waiting') edges.push('ask')
      else if ((p === 'waiting' || p === 'done') && t.state === 'running') edges.push('reply')
      else if (t.state === 'done') edges.push('complete')
    }
  }
  S.prevState = Object.fromEntries(S.tasks.map((t) => [t.id, t.state]))

  if (anim) flip(before, src, opts.flyId)
  if (anim && !opts.first) fire([...new Set(edges)])
  renderPanel()
}

function flip(before, src, flyId) {
  for (const [id, el] of cards) {
    const b = el.getBoundingClientRect()
    const a = before[id]
    if (!a) {
      if (src && id === flyId) {
        const dx = src.left + 12 - b.left, dy = src.top - b.top
        el.animate([
          { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(.5)', opacity: 0, zIndex: 50 },
          { transform: 'translate(' + dx * 0.4 + 'px,' + dy * 0.4 + 'px) scale(.9)', opacity: 1, zIndex: 50, offset: 0.45 },
          { transform: 'translate(0,0) scale(1.05)', opacity: 1, zIndex: 50, offset: 0.78 },
          { transform: 'translate(0,0) scale(1)', opacity: 1, zIndex: 50 },
        ], { duration: 820, easing: 'cubic-bezier(.3,.7,.3,1)' })
      } else {
        el.animate([{ transform: 'scale(.9)', opacity: 0 }, { transform: 'scale(1.03)', opacity: 1, offset: 0.7 }, { transform: 'none', opacity: 1 }], { duration: 420, easing: 'ease-out' })
      }
      continue
    }
    const dx = a.left - b.left, dy = a.top - b.top
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
    if (Math.abs(dx) > 40 || Math.abs(dy) > 120) {
      el.animate([
        { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(1)', zIndex: 50, boxShadow: '0 0 0 rgba(0,0,0,0)' },
        { transform: 'translate(' + dx * 0.5 + 'px,' + (dy * 0.5 - 18) + 'px) scale(1.05) rotate(-1.2deg)', zIndex: 50, boxShadow: '0 28px 48px -18px rgba(0,0,0,.55)', offset: 0.5 },
        { transform: 'translate(0,0) scale(1)', zIndex: 50, boxShadow: '0 0 0 rgba(0,0,0,0)' },
      ], { duration: 680, easing: 'cubic-bezier(.65,0,.35,1)' })
    } else {
      el.animate([{ transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { transform: 'translate(0,0)' }], { duration: 440, easing: 'cubic-bezier(.2,.8,.2,1)' })
    }
  }
}

function fire(edges) {
  edges.forEach((edge, i) => {
    const p = $('[data-edge="' + edge + '"]')
    if (!p) return
    const tok = p.querySelector('.tok')
    const r = p.getBoundingClientRect()
    const vertical = r.height > r.width
    const up = p.classList.contains('pipe--up')
    const L = (vertical ? r.height : r.width) - 10
    const from = up ? L : 0, to = up ? 0 : L
    const prop = vertical ? 'top' : 'left'
    const k = (pos, o, s, off) => Object.assign({ [prop]: pos + 'px', opacity: o, transform: 'scale(' + s + ')' }, off == null ? {} : { offset: off })
    if (tok) tok.animate([k(from, 0, 0.4), k(from + (to - from) * 0.15, 1, 1.3, 0.15), k(to, 1, 1, 0.85), k(to, 0, 2.2)], { duration: 700, delay: i * 120, easing: 'cubic-bezier(.45,0,.55,1)' })
    const line = p.querySelector('.pipe-line')
    if (line) line.animate([{ opacity: 0.85, filter: 'brightness(1)' }, { opacity: 1, filter: 'brightness(2)' }, { opacity: 0.85, filter: 'brightness(1)' }], { duration: 800, delay: i * 120 })
  })
}

/* ---------- side panel ---------- */
/** Click opens the agent itself in Orca; Ctrl/Cmd+Click (or middle click) opens Pod's detail panel.
 *  A task with no agent yet (queued) always opens the detail. */
function openCard(id, e) {
  const t = byId(id)
  if (!t) return
  const inPanel = !!(e && (e.ctrlKey || e.metaKey))
  if (!inPanel && (t.terminalId || t.workspaceId)) {
    if (e && e.preventDefault) e.preventDefault()
    call('pod.open', { id }).catch(() => {})
    return
  }
  if (!S.tabs.includes(id)) S.tabs.push(id)
  S.active = id
  S.panelOpen = true
  render({ animate: false })
  pollLog()
}

function closeTab(id) {
  const i = S.tabs.indexOf(id)
  S.tabs = S.tabs.filter((x) => x !== id)
  if (S.active === id) S.active = S.tabs[Math.min(i, S.tabs.length - 1)] || null
  if (!S.tabs.length) S.panelOpen = false
  render({ animate: false })
}

function renderPanel() {
  S.tabs = S.tabs.filter((id) => byId(id))
  if (!byId(S.active)) S.active = S.tabs[S.tabs.length - 1] || null
  const show = S.panelOpen && !!S.active
  const panel = $('#panel')
  panel.hidden = !show
  for (const el of cards.values()) el.classList.toggle('is-open', show && el.dataset.fid === S.active)
  if (!show) return
  panel.style.width = S.panelW + 'px'

  $('#tabs').innerHTML = S.tabs.map((id) => {
    const t = byId(id)
    const full = displayTitle(t)
    const title = full.length > 26 ? full.slice(0, 25) + '…' : full
    return '<div class="tab' + (id === S.active ? ' is-active' : '') + '">' +
      '<button class="tab-btn" role="tab" aria-selected="' + (id === S.active) + '" title="' + esc(t.title) + '" data-tab="' + id + '"><span class="tdot tdot--' + t.state + '"></span><span>' + esc(title) + '</span></button>' +
      '<button class="tab-x" aria-label="' + esc(T('detail.closeTab', { title: t.title })) + '" data-close="' + id + '">' + IC.x + '</button></div>'
  }).join('')

  const t = byId(S.active)
  const err = isError(t)
  const pill = $('#d-pill')
  pill.className = 'pill pill--' + t.state
  pill.textContent = err ? T('badge.error') : isLimited(t) ? T('badge.limit') : stateLabel(t.state)
  $('#d-title').textContent = displayTitle(t)
  const lastAsk = askText(t)
  $('#d-ask-now').hidden = !lastAsk && !(t.state === 'running' && t.activity)
  $('#d-ask-now-q').textContent = lastAsk
  $('#d-ask-now-a').textContent = t.state === 'running' && t.activity ? t.activity : ''
  $('#d-agent').textContent = agentName(t.agent)
  $('.detail').style.setProperty('--ph', String(placeHue(t.projectName)))
  $('#d-place').innerHTML = ownerChip(t) + placeChip(t) + modeIcon(t)
  const src = $('#d-source')
  src.className = 'src' + (t.source === 'orca' ? '' : ' src--pod')
  src.textContent = t.source === 'orca' ? T('src.openedOrca') : T('src.launchedPod')
  $('#d-branch').textContent = t.branch || T('detail.noWorktree')
  $('#d-elapsed').textContent = detailTimer(t)

  const ask = $('#d-ask')
  // A bot is answered through its Home Chat (mail), a terminal agent by typing into it.
  const canReply = !err && (t.state === 'waiting' || t.state === 'done') && (!!t.terminalId || !!t.bot)
  ask.hidden = !canReply
  ask.classList.toggle('is-waiting', t.state === 'waiting')
  ask.classList.toggle('is-followup', t.state === 'done')
  $('#d-ask-label').textContent = t.state === 'waiting' ? T('detail.asks') : T('detail.followup')
  $('#d-question').textContent = t.state === 'waiting' ? (t.question || t.last || '') : ''
  const ta = $('#d-reply')
  ta.placeholder = t.state === 'waiting' ? T('detail.replyPh') : T('detail.followupPh')
  if (ta._for !== t.id) { ta._for = t.id; ta.value = S.replies[t.id] || '' }
  $('#d-send').disabled = !ta.value.trim()

  $('#d-err').hidden = !err
  $('#d-err-text').textContent = t.error || ''

  const last = t.timeline.length - 1
  $('#d-timeline').innerHTML = t.timeline.map((ev, i) =>
    '<div class="tl-i tl--' + ev.s + (i === last ? ' is-cur' : '') + '"><span class="tl-dot" aria-hidden="true"></span><span>' + esc(stateLabel(ev.s)) +
    (ev.note ? ' <span class="tl-note">· ' + esc(ev.note) + '</span>' : '') + '</span><span class="tl-t">' + fmtClock(ev.at) + '</span></div>'
  ).join('')

  // Claude sub-agents of the current run: working ones spin, finished ones are checked.
  const subs = t.subagents || []
  $('#d-subs-sec').hidden = !subs.length
  $('#d-subs').innerHTML = subs.map((s) =>
    '<div class="sa' + (s.running ? ' sa--run' : '') + '">' + (s.running ? '<span class="sa-spin" aria-hidden="true"></span>' : IC.check) +
    '<span class="sa-d">' + esc(s.description) + (s.type ? ' <span class="sa-t">' + esc(s.type) + '</span>' : '') + '</span>' +
    '<span class="tl-t">' + (s.running ? T('sub.working') : fmtClock(s.at).slice(0, 5)) + '</span></div>'
  ).join('')

  $('#d-term-title').textContent = agentName(t.agent).toLowerCase() + ' · ' + (t.branch || t.projectName)
  $('#d-cursor').hidden = t.state !== 'running'
  renderLog(t)
  $('#d-focus').disabled = !(t.terminalId || t.workspaceId)
}

function lineClass(l) {
  if (/^\s*[$>❯]/.test(l)) return 'ln ln--cmd'
  if (/(✓|✔|passed|success|ok\b|0 errori|0 errors)/i.test(l)) return 'ln ln--ok'
  return 'ln'
}

function renderLog(t) {
  const box = $('#d-term-lines')
  const lines = S.logs[t.id]
  if (!lines) {
    if (box._for !== t.id) { box._for = t.id; box._n = 0; box._placeholder = true; box.innerHTML = '<div class="ln ln--sys">' + esc(t.terminalId ? T('log.reading') : t.state === 'queued' ? T('log.queued') : t.bot ? T('log.bot', { bot: t.bot }) : T('log.chat')) + '</div>' }
    return
  }
  const term = $('#d-term')
  const atBottom = term.scrollHeight - term.scrollTop - term.clientHeight < 40
  if (box._for !== t.id || box._placeholder) { box._for = t.id; box._n = 0; box._placeholder = false; box.innerHTML = '' }
  if (lines.length < box._n) { box._n = 0; box.innerHTML = '' }
  const frag = document.createDocumentFragment()
  for (let i = box._n; i < lines.length; i++) {
    const d = document.createElement('div')
    d.className = lineClass(lines[i]) + (box._n ? ' ln--new' : '')
    d.textContent = lines[i]
    frag.appendChild(d)
  }
  box._n = lines.length
  box.appendChild(frag)
  if (atBottom || frag.childNodes.length === lines.length) term.scrollTop = term.scrollHeight
}

let logBusy = false
async function pollLog() {
  if (logBusy || !S.panelOpen || !S.active) return
  const t = byId(S.active)
  if (!t || !t.terminalId) return
  logBusy = true
  try {
    const r = await orca.plugin.request('pod.log', { id: t.id, lines: 400 })
    const lines = r.lines.map((l) => l.replace(/\s+$/, '')).filter((l, i, a) => l || (a[i - 1] && a[i - 1] !== ''))
    const prev = S.logs[t.id]
    // terminal.read returns the newest window; if it scrolled, redraw instead of appending
    if (prev && (lines.length < prev.length || prev[0] !== lines[0])) { const box = $('#d-term-lines'); box._n = 0; box.innerHTML = '' }
    S.logs[t.id] = lines
    if (S.active === t.id) renderLog(t)
  } catch {
    // worker busy or terminal gone; next poll retries
  } finally {
    logBusy = false
  }
}

async function sendReply() {
  const id = S.active
  const text = (S.replies[id] || '').trim()
  if (!id || !text) return
  S.replies[id] = ''
  $('#d-reply').value = ''
  $('#d-send').disabled = true
  try { apply(await call('pod.reply', { id, text })) } catch { S.replies[id] = text }
}

/* ---------- composer ---------- */
const GROUPS = ['git', 'folder', 'bot']
function renderTargets(state) {
  const sel = $('#aq-project')
  const cur = sel.value || state.defaultTargetId
  const sig = LANG + state.targets.map((t) => t.id + t.name).join('|')
  if (sel._sig !== sig) {
    sel._sig = sig
    sel.innerHTML = state.targets.length
      ? GROUPS.map((kind) => {
          const label = T('group.' + kind)
          const items = state.targets.filter((t) => t.kind === kind)
          return items.length ? '<optgroup label="' + esc(label) + '">' + items.map((t) => '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>').join('') + '</optgroup>' : ''
        }).join('')
      : '<option value="">' + esc(T('target.none')) + '</option>'
  }
  if (state.targets.some((t) => t.id === cur)) sel.value = cur
  const t = state.targets.find((x) => x.id === sel.value)
  sel.title = t ? T(t.kind === 'git' ? 'target.gitTitle' : 'target.wsTitle', { name: t.name }) : ''
  if (!S.agentTouched) $('#aq-agent').value = state.defaultAgent in AGENTS ? state.defaultAgent : 'claude'
}

async function addTask() {
  const input = $('#aq-input')
  const title = input.value.trim()
  if (!title) { input.focus(); shake(); return }
  const targetId = $('#aq-project').value
  if (!targetId) { showBanner(T('target.pick')); return }
  stopMic()
  const btn = $('#add')
  btn.disabled = true
  try {
    const before = new Set(S.tasks.map((t) => t.id))
    const state = await call('pod.add', { title, agent: $('#aq-agent').value, targetId })
    input.value = ''
    autosize()
    const fresh = state.tasks.find((t) => !before.has(t.id))
    apply(state, { flyId: fresh && fresh.id })
  } catch {
    shake()
  } finally {
    btn.disabled = false
  }
}

function shake() {
  const f = $('#field')
  f.classList.remove('is-shake')
  void f.offsetWidth
  f.classList.add('is-shake')
}

/* ---------- microphone (Web Speech API, in the selected language) ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null
let rec = null
let msgT
function micTip(msg) {
  const tip = $('#mic-tip')
  const lang = SPEECH_LANG[LANG]
  tip.textContent = msg || (!SR ? T('mic.unavailable') : S.listening ? T('mic.listening', { lang }) : T('mic.idle', { lang }))
  tip.classList.toggle('is-on', !!msg)
  if (msg) { clearTimeout(msgT); msgT = setTimeout(() => micTip(''), 3500) }
}
function setListening(on) {
  S.listening = on
  $('#mic').classList.toggle('is-rec', on)
  $('#mic').setAttribute('aria-pressed', String(on))
  $('#mic').setAttribute('aria-label', on ? T('mic.stop') : T('mic.start'))
  $('#field').classList.toggle('is-rec', on)
  $('#rec').hidden = !on
  micTip('')
}
function stopMic() { if (rec) { try { rec.stop() } catch {} } }
function toggleMic() {
  if (!SR) return
  if (S.listening) { stopMic(); return }
  let r
  try { r = new SR() } catch { $('#mic').disabled = true; micTip(''); return }
  r.lang = SPEECH_LANG[LANG]; r.interimResults = true; r.continuous = true
  const input = $('#aq-input')
  const base = input.value.trim() ? input.value.trim() + ' ' : ''
  r.onresult = (ev) => {
    let txt = ''
    for (let i = 0; i < ev.results.length; i++) txt += ev.results[i][0].transcript
    input.value = base + txt.trim()
    autosize()
  }
  r.onerror = (ev) => {
    const msg = ev.error === 'not-allowed' || ev.error === 'service-not-allowed' ? T('mic.denied') : ev.error === 'no-speech' ? T('mic.noSpeech') : ev.error === 'network' ? T('mic.network') : T('mic.error', { e: ev.error })
    setListening(false)
    micTip(msg)
  }
  r.onend = () => { rec = null; setListening(false) }
  try { r.start(); rec = r; setListening(true) } catch { micTip(T('mic.cantStart')) }
}

/* ---------- state ---------- */
function apply(state, opts = {}) {
  if (state.language && state.language !== LANG) setLang(state.language)
  S.tasks = state.tasks
  S.hiddenLanes = state.hiddenLanes || []
  if (state.agents) for (const o of $('#aq-agent').options) o.hidden = o.disabled = !state.agents.includes(o.value)
  if (state.targets) { S.targets = state.targets; S.maxParallel = state.maxParallel; renderTargets(state) }
  render(opts)
}

/** Fits the composer to its text (CSS caps it with max-height, then it scrolls). */
function autosize() {
  const el = $('#aq-input')
  el.style.height = 'auto'
  el.style.height = el.scrollHeight + 2 + 'px'
  measureHeader()
}

function measureHeader() {
  root.style.setProperty('--hh', $('#top').offsetHeight + 'px')
}

/* ---------- language ---------- */
function applyStatic() {
  document.documentElement.lang = LANG
  for (const el of $$('[data-i18n]')) el.textContent = T(el.dataset.i18n)
  for (const el of $$('[data-i18n-ph]')) el.placeholder = T(el.dataset.i18nPh)
  for (const el of $$('[data-i18n-aria]')) el.setAttribute('aria-label', T(el.dataset.i18nAria))
  for (const el of $$('[data-i18n-title]')) el.title = T(el.dataset.i18nTitle)
  for (const b of $$('[data-lang]')) b.setAttribute('aria-checked', String(b.dataset.lang === LANG))
}

function setLang(lang) {
  LANG = LANGS.includes(lang) ? lang : 'en'
  T = translator(LANG)
  applyStatic()
  micTip('')
  $('#mic').setAttribute('aria-label', S.listening ? T('mic.stop') : T('mic.start'))
  const box = $('#d-term-lines')
  if (box._placeholder) box._for = null
  if (S.targets.length) renderTargets({ targets: S.targets, defaultTargetId: null, defaultAgent: $('#aq-agent').value })
  measureHeader()
}

$('#lang').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-lang]')
  if (!b || b.dataset.lang === LANG) return
  setLang(b.dataset.lang)
  render({ animate: false })
  try { apply(await call('pod.setLanguage', { language: LANG })) } catch {}
})

/* ---------- wiring ---------- */
$('#add').addEventListener('click', addTask)
$('#clear-all').addEventListener('click', () => clearDone(null))
// − from 1 goes to "no limit"; + from "no limit" starts at 1.
async function setParallel(v) {
  S.maxParallel = v
  render({ animate: false })
  try { apply(await call('pod.setMaxParallel', { value: v })) } catch {}
}
$('#par-dec').addEventListener('click', () => setParallel(S.maxParallel <= 1 ? 0 : S.maxParallel - 1))
$('#par-inc').addEventListener('click', () => setParallel(Math.min(50, S.maxParallel + 1)))
// Enter adds the task, Shift+Enter starts a new line; the box grows with the text.
$('#aq-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); addTask() } })
$('#aq-input').addEventListener('input', autosize)
addEventListener('resize', autosize)
$('#aq-agent').addEventListener('change', () => { S.agentTouched = true })
$('#aq-project').addEventListener('change', () => renderTargets({ targets: S.targets, defaultTargetId: null, defaultAgent: $('#aq-agent').value }))
$('#mic').addEventListener('click', toggleMic)
if (!SR) $('#mic').disabled = true
for (const el of $$('[data-logo]')) el.innerHTML = logo(el.dataset.logo)
applyStatic()
micTip('')

$('#tabs').addEventListener('click', (e) => {
  const sel = e.target.closest('[data-tab]')
  const close = e.target.closest('[data-close]')
  if (close) closeTab(close.dataset.close)
  else if (sel) { S.active = sel.dataset.tab; render({ animate: false }); pollLog() }
})
$('#close-panel').addEventListener('click', () => { S.panelOpen = false; render({ animate: false }) })
const openActive = () => { if (S.active) call('pod.open', { id: S.active }).catch(() => {}) }
$('#open-orca').addEventListener('click', openActive)
$('#d-focus').addEventListener('click', openActive)
$('#d-remove').addEventListener('click', async () => {
  const id = S.active
  if (!id) return
  closeTab(id)
  try { apply(await call('pod.remove', { id })) } catch {}
})
$('#d-retry').addEventListener('click', async () => { if (S.active) try { apply(await call('pod.retry', { id: S.active })) } catch {} })
$('#d-reply').addEventListener('input', (e) => { S.replies[S.active] = e.target.value; $('#d-send').disabled = !e.target.value.trim() })
$('#d-reply').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendReply() } })
$('#d-send').addEventListener('click', sendReply)

$('#resizer').addEventListener('pointerdown', (e) => {
  e.preventDefault()
  const x0 = e.clientX, w0 = S.panelW
  $('#panel').classList.add('is-resizing')
  const move = (ev) => { S.panelW = Math.round(Math.max(340, Math.min(innerWidth * 0.72, w0 + (x0 - ev.clientX)))); $('#panel').style.width = S.panelW + 'px' }
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); $('#panel').classList.remove('is-resizing') }
  addEventListener('pointermove', move)
  addEventListener('pointerup', up)
})
$('#resizer').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') { e.preventDefault(); S.panelW = Math.min(innerWidth * 0.72, S.panelW + 32) }
  if (e.key === 'ArrowRight') { e.preventDefault(); S.panelW = Math.max(340, S.panelW - 32) }
  $('#panel').style.width = S.panelW + 'px'
})
addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.panelOpen) { S.panelOpen = false; render({ animate: false }) } })

new ResizeObserver(measureHeader).observe($('#top'))
measureHeader()

orca.plugin.on('pod.changed', ({ tasks }) => { S.tasks = tasks; render() })

// elapsed timers tick locally; the worker is asked only every REFRESH_MS
setInterval(() => {
  // only live timers move; frozen ones (done, waiting) are left as they are
  for (const [id, el] of cards) {
    const t = byId(id)
    if (t && t.state === 'done') { el.classList.toggle('card--fresh', isFresh(t)); continue }
    if (!t || (t.state !== 'running' && t.state !== 'queued')) continue
    const time = el.querySelector('[data-el="time"]')
    if (time) time.textContent = timer(t).text
  }
  const t = S.panelOpen && byId(S.active)
  if (t) $('#d-elapsed').textContent = detailTimer(t)
}, 1000)

let refreshing = false
async function refresh() {
  if (refreshing || document.hidden) return
  refreshing = true
  try { apply(await orca.plugin.request('pod.refresh')) } catch {} finally { refreshing = false }
}
setInterval(refresh, REFRESH_MS)
setInterval(pollLog, LOG_MS)
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh() })

orca.plugin.request('pod.state')
  .then((state) => { apply(state, { first: true, animate: false }); refresh() })
  .catch((e) => showBanner(T('workerDown', { e: (e && e.message) || e })))
