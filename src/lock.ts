/**
 * Single-instance lock, plus the PID file that `status`/`stop` use.
 *
 * `mkdir` is atomic on every POSIX filesystem: either you created it or it
 * already existed. A lock whose owner is dead is stale and gets reclaimed,
 * which is what happens after a crash or a hard kill.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export class Lock {
  private held = false;
  constructor(private readonly dir: string) {}

  private get pidFile(): string {
    return join(this.dir, "pid");
  }

  acquire(): boolean {
    try {
      mkdirSync(dirname(this.dir), { recursive: true });
      mkdirSync(this.dir);
      writeFileSync(this.pidFile, String(process.pid));
      this.held = true;
      return true;
    } catch {
      const owner = this.ownerPid();
      if (owner !== null && isAlive(owner)) return false;
      // Stale lock: the owner is gone, so take it over.
      try {
        rmSync(this.dir, { recursive: true, force: true });
        mkdirSync(this.dir);
        writeFileSync(this.pidFile, String(process.pid));
        this.held = true;
        return true;
      } catch {
        return false;
      }
    }
  }

  ownerPid(): number | null {
    try {
      const pid = Number(readFileSync(this.pidFile, "utf8").trim());
      return Number.isFinite(pid) ? pid : null;
    } catch {
      return null;
    }
  }

  release(): void {
    if (!this.held) return;
    if (this.ownerPid() === process.pid) {
      try {
        rmSync(this.dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    this.held = false;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readPidFile(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function writePidFile(path: string, pid: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(pid));
}
