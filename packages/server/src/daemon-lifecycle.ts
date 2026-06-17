/**
 * Global singleton daemon discovery, startup, and management.
 *
 * The daemon is a GLOBAL process (one per user), storing its runtime files in
 * ~/.tot/ (or $XDG_STATE_HOME/tot/ if set). Per-project data (sessions) still
 * lives in {projectDir}/.tot/sessions/.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fork } from 'node:child_process';
import { createConnection } from 'node:net';
import { HTTP_PORT_DEFAULT, DAEMON_STARTUP_TIMEOUT_MS, DAEMON_POLL_INTERVAL_MS, TCP_PROBE_TIMEOUT_MS } from './defaults.js';

export interface DaemonInfo {
  pid: number;
  ipcPort: number;
  httpPort: number;
}

/**
 * Returns the tot state root directory.
 * Precedence: $TOT_DATA_DIR (explicit override) > $XDG_STATE_HOME/tot > ~/.tot.
 */
export function getTotDir(): string {
  const override = process.env['TOT_DATA_DIR'];
  if (override) return override;
  const xdg = process.env['XDG_STATE_HOME'];
  if (xdg) return join(xdg, 'tot');
  return join(homedir(), '.tot');
}

export function discoverDaemon(totDir: string): DaemonInfo | null {
  const portFile = join(totDir, 'daemon.port');
  const pidFile = join(totDir, 'daemon.pid');

  if (!existsSync(portFile) || !existsSync(pidFile)) return null;

  try {
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    const ipcPort = parseInt(readFileSync(portFile, 'utf-8').trim(), 10);
    const httpPort = existsSync(join(totDir, 'daemon.http'))
      ? parseInt(readFileSync(join(totDir, 'daemon.http'), 'utf-8').trim(), 10)
      : HTTP_PORT_DEFAULT;

    // Check if process is alive
    try {
      process.kill(pid, 0);
    } catch {
      // Process is dead — stale files
      cleanup(totDir);
      return null;
    }

    return { pid, ipcPort, httpPort };
  } catch {
    return null;
  }
}

export async function startDaemon(totDir: string): Promise<DaemonInfo> {
  mkdirSync(totDir, { recursive: true });

  // Acquire exclusive lock to prevent dual-daemon race.
  // If the lock file exists from a crashed process, check staleness and clean up.
  const lockFile = join(totDir, 'daemon.lock');
  let lockFd: number;
  try {
    lockFd = openSync(lockFile, 'wx'); // O_CREAT | O_EXCL — fails if file exists
  } catch {
    // Lock file exists — check if it's stale (holder crashed)
    try {
      const lockContent = readFileSync(lockFile, 'utf-8').trim();
      const lockPid = parseInt(lockContent, 10);
      if (!Number.isNaN(lockPid)) {
        try {
          process.kill(lockPid, 0); // Check if process alive
          // Process alive — another process is legitimately starting the daemon
          return pollForDaemon(totDir);
        } catch {
          // Process dead — stale lock, remove it and retry
          try { unlinkSync(lockFile); } catch {}
          try {
            lockFd = openSync(lockFile, 'wx');
          } catch {
            return pollForDaemon(totDir);
          }
        }
      } else {
        // Lock file has invalid content — remove and retry
        try { unlinkSync(lockFile); } catch {}
        return pollForDaemon(totDir);
      }
    } catch {
      // Can't read lock file — just poll
      return pollForDaemon(totDir);
    }
  }

  try {
    // Write our PID to the lock file so staleness can be detected
    writeFileSync(lockFile, String(process.pid));

    const daemonScript = join(import.meta.dirname, 'daemon.js');
    const logPath = join(totDir, 'daemon.log');
    const logFd = openSync(logPath, 'a');
    const child = fork(daemonScript, [], {
      detached: true,
      stdio: ['ignore', logFd, logFd, 'ipc'],
      env: { ...process.env, TOT_GLOBAL_DIR: totDir },
    });
    child.unref();
    child.disconnect();
    closeSync(logFd);

    // Hold the lock until the child has booted and written daemon.port. The
    // fork+startup window takes tens of ms; releasing the lock the instant
    // fork() returns would let a second concurrent shim pass the lock check
    // and fork a duplicate daemon before this one is listening.
    return await pollForDaemon(totDir);
  } finally {
    closeSync(lockFd);
    try { unlinkSync(lockFile); } catch {}
  }
}

async function pollForDaemon(totDir: string): Promise<DaemonInfo> {
  const portFile = join(totDir, 'daemon.port');
  const deadline = Date.now() + DAEMON_STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(DAEMON_POLL_INTERVAL_MS);
    if (existsSync(portFile)) {
      const info = discoverDaemon(totDir);
      if (info) {
        const reachable = await tcpProbe(info.ipcPort, TCP_PROBE_TIMEOUT_MS);
        if (reachable) return info;
      }
    }
  }

  throw new Error(`Daemon failed to start within ${DAEMON_STARTUP_TIMEOUT_MS / 1000} seconds`);
}

export function stopDaemon(totDir: string): boolean {
  const info = discoverDaemon(totDir);
  if (!info) return false;

  try {
    process.kill(info.pid, 'SIGTERM');
    return true;
  } catch {
    cleanup(totDir);
    return false;
  }
}

export function writeDaemonFiles(totDir: string, info: DaemonInfo): void {
  mkdirSync(totDir, { recursive: true });
  atomicWrite(join(totDir, 'daemon.pid'), String(info.pid));
  atomicWrite(join(totDir, 'daemon.port'), String(info.ipcPort));
  atomicWrite(join(totDir, 'daemon.http'), String(info.httpPort));
}

export function cleanup(totDir: string): void {
  const files = ['daemon.pid', 'daemon.port', 'daemon.http'];
  for (const file of files) {
    try {
      unlinkSync(join(totDir, file));
    } catch {
      // Ignore
    }
  }
}

function atomicWrite(filePath: string, content: string): void {
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, content, 'utf-8');
  try {
    // Rename is atomic on the same filesystem
    renameSync(tmpPath, filePath);
  } catch {
    // Fallback: direct write
    writeFileSync(filePath, content, 'utf-8');
    try { unlinkSync(tmpPath); } catch {}
  }
}

export function tcpProbe(port: number, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeout);

    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });

    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
