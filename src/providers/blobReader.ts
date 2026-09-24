/**
 * File contents at a commit, through one long-lived `git cat-file --batch`.
 *
 * A collision scan reads the base copy of every file it looks at, and one `git show` per
 * file is a process spawn per file — tens of milliseconds each on Windows, paid in series.
 * `cat-file --batch` answers any number of `<rev>:<path>` requests over one pipe, so the
 * whole scan costs a single spawn.
 *
 * The process is started on first use and stopped after a short idle period, so a quiet
 * window holds no child process. While it is idle it is also unreferenced, so it can never
 * be the thing keeping a Node process alive.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Socket } from 'node:net';
import { gitEnv } from '../core/exec.js';

const IDLE_MS = 15_000;

interface Request {
  spec: string;
  resolve: (content: string | undefined) => void;
  reject: (error: Error) => void;
}

export class BlobReader {
  private child: ChildProcessWithoutNullStreams | undefined;
  /** Requests written to the pipe, oldest first; answers arrive in the same order. */
  private inFlight: Request[] = [];
  private buffer: Buffer = Buffer.alloc(0);
  private idleTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(private readonly cwd: string) {}

  /**
   * Content of `path` at `rev`, or undefined when it does not exist there or is not a file.
   *
   * Paths containing a newline cannot be expressed on the batch protocol; those return
   * `null` so the caller can fall back to a one-off `git show`.
   */
  read(rev: string, path: string): Promise<string | undefined> | null {
    if (path.includes('\n') || this.disposed) return null;

    return new Promise((resolve, reject) => {
      const child = this.ensureStarted();
      const request: Request = { spec: `${rev}:${path}`, resolve, reject };
      this.inFlight.push(request);
      this.hold();
      child.stdin.write(`${request.spec}\n`);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.stop(new Error('blob reader disposed'));
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;

    const child = spawn('git', ['cat-file', '--batch'], {
      cwd: this.cwd,
      env: gitEnv(),
      windowsHide: true,
      shell: false
    });
    this.child = child;
    this.buffer = Buffer.alloc(0);

    child.stdout.on('data', (chunk: Buffer) => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    // stderr is read only so a chatty git cannot fill the pipe and stall.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    const fail = (error: Error) => {
      if (this.child === child) this.stop(error);
    };
    child.on('error', fail);
    child.on('exit', (code) => fail(new Error(`git cat-file exited with code ${code}`)));

    return child;
  }

  /** Parse every complete answer in the buffer. */
  private drain(): void {
    this.parse();
    if (this.inFlight.length === 0) this.maybeIdle();
  }

  private parse(): void {
    for (;;) {
      const request = this.inFlight[0];
      if (!request) return;

      const newline = this.buffer.indexOf(0x0a);
      if (newline === -1) return;
      const header = this.buffer.subarray(0, newline).toString('utf8');

      // `<spec> missing`, `<spec> ambiguous`, and friends carry no body.
      const match = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(newline + 1);
        this.inFlight.shift();
        request.resolve(undefined);
        continue;
      }

      const size = Number(match[2]);
      // Header, body, and the newline that terminates every body.
      const end = newline + 1 + size + 1;
      if (this.buffer.length < end) return;

      const body = this.buffer.subarray(newline + 1, newline + 1 + size);
      this.buffer = this.buffer.subarray(end);
      this.inFlight.shift();
      request.resolve(match[1] === 'blob' ? body.toString('utf8') : undefined);
    }
  }

  /** Keep the process referenced while it owes answers; schedule shutdown once it does not. */
  private hold(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.setReferenced(true);
    queueMicrotask(() => this.maybeIdle());
  }

  private maybeIdle(): void {
    if (this.inFlight.length > 0 || !this.child || this.idleTimer) return;
    this.setReferenced(false);
    this.idleTimer = setTimeout(() => this.stop(), IDLE_MS);
    this.idleTimer.unref();
  }

  /** The child and its pipes each hold the event loop open, so all four are toggled. */
  private setReferenced(referenced: boolean): void {
    const child = this.child;
    if (!child) return;
    // Piped stdio streams are sockets, which is where ref/unref live.
    const pipes = [child.stdin, child.stdout, child.stderr] as unknown as Socket[];
    if (referenced) {
      child.ref();
      for (const pipe of pipes) pipe.ref?.();
    } else {
      child.unref();
      for (const pipe of pipes) pipe.unref?.();
    }
  }

  private stop(error?: Error): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    const child = this.child;
    this.child = undefined;
    this.buffer = Buffer.alloc(0);

    const pending = this.inFlight;
    this.inFlight = [];
    for (const request of pending) {
      request.reject(error ?? new Error('blob reader stopped'));
    }

    if (child) {
      child.stdin.end();
      child.kill();
    }
  }
}
