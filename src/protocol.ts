// Panel <-> worker contract. The worker imports these types; the HTML panel (plain JS) calls the
// same request names through orca.plugin.request.
export {}

export type TaskState = 'queued' | 'running' | 'waiting' | 'done'

export type TimelineEvent = { s: TaskState; at: number; note?: string }

/** A Claude sub-agent (Task/Agent tool) of a session; `at` is when its transcript last changed. */
export type SubAgent = { id: string; description: string; type: string; running: boolean; at: number }

export type Task = {
  id: string
  /** `pod`: queued and launched by Pod. `orca`: an agent started in Orca directly, adopted by Pod. */
  source: 'pod' | 'orca'
  title: string
  agent: string
  projectId: string
  hostId?: string | null
  projectName: string
  state: TaskState
  /** When the task entered its current state. */
  since: number
  createdAt: number
  workspaceId?: string
  terminalId?: string | null
  /** Set when the agent starts in this existing workspace (a folder project or a bot) instead of
   *  a new worktree. */
  launchIn?: string
  /** The bot whose orchestration started this agent's workspace (a bot's worker), if any. */
  byBot?: string
  /** Where it runs: a worktree of a Git project, a folder project's workspace, or a bot. */
  place?: 'git' | 'folder' | 'bot'
  /** Set for a task sent to an Orca bot: delivered to the bot's Home Chat by mail, not launched. */
  bot?: string
  /** When the last message went to the bot; idle states older than this are ignored. */
  sentAt?: number
  /** True until the bot's chat is seen working after `sentAt`. */
  awaitPickup?: boolean
  /** Orca's own session id (what `orca agent list` and `orca bot chats` use). `sessionId` may
   *  instead hold the Claude conversation id, which is what plugin events and agents.list report. */
  orcaSessionId?: string
  /** Orca session id: the only handle a chat agent has. */
  sessionId?: string | null
  branch?: string
  timeline: TimelineEvent[]
  /** Last meaningful line of the agent's terminal. */
  last?: string
  /** What the agent is waiting for (waiting state). */
  question?: string
  /** Set while the task waits for a scheduled run: back in Queued until then. `loop` and `cron`
   *  are a Claude session's own wake-ups, `automation` an Orca automation's next run. */
  wakeAt?: number
  wakeKind?: 'loop' | 'cron' | 'automation'
  /** The cron expression, the automation's schedule, or the loop's reason. */
  wakeLabel?: string
  /** The title of the agent's tab in Orca (Claude names its session), kept up to date. */
  tabTitle?: string
  /** What the agent is doing right now (its latest action), from Claude's transcript. */
  activity?: string
  /** The last thing the agent was asked, from Claude's transcript. */
  prompt?: string
  /** Claude sub-agents of this session's current work (read from Claude's transcripts on disk). */
  subagents?: SubAgent[]
  /** Set while the agent is stopped by its usage limit: the reset time it gave, or ''. */
  limit?: string
  /** Why the launch failed. */
  error?: string
}

/** Where a new task can run. `git`: a new worktree of the project. `folder` and `bot`: the
 *  existing workspace `workspaceId`. `id` is `p:<projectId>` or `w:<workspaceId>`. */
export type Target = {
  id: string
  name: string
  kind: 'git' | 'folder' | 'bot'
  projectId?: string
  workspaceId?: string
  /** Bots only: the bot's name, its `orca orchestration send --to bot:<name>` address. */
  bot?: string
  hostId: string | null
}

export type PodState = {
  tasks: Task[]
  targets: Target[]
  defaultAgent: string
  defaultTargetId: string | null
  /** 0 = no limit. */
  maxParallel: number
  /** UI language: en (default), it, es. */
  language: string
  /** Agent lanes of the Running column turned off in Settings or not installed here (shown anyway while busy). */
  hiddenLanes: string[]
  /** Agents installed on this machine that the composer offers, or null when Orca did not say. */
  agents: string[] | null
}

declare module 'orca' {
  interface PluginRequests {
    'pod.state': { output: PodState }
    'pod.refresh': { output: PodState }
    'pod.add': { input: { title: string; agent?: string; targetId: string }; output: PodState }
    'pod.reply': { input: { id: string; text: string }; output: PodState }
    'pod.retry': { input: { id: string }; output: PodState }
    'pod.open': { input: { id: string }; output: { focused: boolean } }
    'pod.log': { input: { id: string; lines?: number }; output: { lines: string[] } }
    'pod.remove': { input: { id: string }; output: PodState }
    'pod.setLanguage': { input: { language: string }; output: PodState }
    /** Sets how many Pod tasks run at once; 0 = no limit. */
    'pod.setMaxParallel': { input: { value: number }; output: PodState }
    /** Takes completed tasks off the board: the given ones, or all of them. */
    'pod.clearDone': { input: { ids?: string[] }; output: PodState }
  }
  interface PluginPanelEvents {
    'pod.changed': { tasks: Task[] }
  }
}
