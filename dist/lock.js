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
    dir;
    held = false;
    constructor(dir) {
        this.dir = dir;
    }
    get pidFile() {
        return join(this.dir, "pid");
    }
    acquire() {
        try {
            mkdirSync(dirname(this.dir), { recursive: true });
            mkdirSync(this.dir);
            writeFileSync(this.pidFile, String(process.pid));
            this.held = true;
            return true;
        }
        catch {
            const owner = this.ownerPid();
            if (owner !== null && isAlive(owner))
                return false;
            // Stale lock: the owner is gone, so take it over.
            try {
                rmSync(this.dir, { recursive: true, force: true });
                mkdirSync(this.dir);
                writeFileSync(this.pidFile, String(process.pid));
                this.held = true;
                return true;
            }
            catch {
                return false;
            }
        }
    }
    ownerPid() {
        try {
            const pid = Number(readFileSync(this.pidFile, "utf8").trim());
            return Number.isFinite(pid) ? pid : null;
        }
        catch {
            return null;
        }
    }
    release() {
        if (!this.held)
            return;
        if (this.ownerPid() === process.pid) {
            try {
                rmSync(this.dir, { recursive: true, force: true });
            }
            catch {
                /* best effort */
            }
        }
        this.held = false;
    }
}
export function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
export function readPidFile(path) {
    if (!existsSync(path))
        return null;
    try {
        const pid = Number(readFileSync(path, "utf8").trim());
        return Number.isFinite(pid) ? pid : null;
    }
    catch {
        return null;
    }
}
export function writePidFile(path, pid) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(pid));
}
//# sourceMappingURL=lock.js.map