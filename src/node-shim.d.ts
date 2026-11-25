// The few Node APIs the worker uses, typed here so `tsc` passes without node_modules (the plugin
// has no build step and ships no dependencies).
declare const process: { env: Record<string, string | undefined>; execPath: string; platform: string }

declare module 'node:child_process' {
  type Stream = { on(event: 'data', fn: (chunk: string) => void): void }
  export function spawn(
    cmd: string,
    args: string[],
    opts?: { windowsHide?: boolean; env?: Record<string, string | undefined> }
  ): { stdout: Stream; stderr: Stream; kill(): boolean; on(event: 'error', fn: (e: Error) => void): void; on(event: 'close', fn: (code: number | null) => void): void }
}
declare module 'node:fs' {
  export function existsSync(path: string): boolean
}
declare module 'node:fs/promises' {
  export function readdir(path: string): Promise<string[]>
  export function open(path: string, flags: 'r'): Promise<{
    stat(): Promise<{ size: number; mtimeMs: number }>
    read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
    close(): Promise<void>
  }>
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
  export function stat(path: string): Promise<{ mtimeMs: number; isDirectory(): boolean }>
  export function mkdtemp(prefix: string): Promise<string>
  export function writeFile(path: string, data: string, encoding?: 'utf8'): Promise<void>
  export function mkdir(path: string, opts?: { recursive?: boolean }): Promise<string | undefined>
  export function utimes(path: string, atime: Date, mtime: Date): Promise<void>
  export function rm(path: string, opts: { recursive?: boolean; force?: boolean }): Promise<void>
}
declare module 'node:os' {
  export function tmpdir(): string
  export function homedir(): string
}
declare module 'node:path' {
  export function join(...parts: string[]): string
  export function dirname(path: string): string
}
