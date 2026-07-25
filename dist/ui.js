/**
 * Terminal output: colors, log levels, and file logging.
 *
 * Everything the harness prints also lands in the log file, because a run is
 * usually long and unattended and the log is the only record of what the model
 * actually did.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
const useColor = process.stdout.isTTY === true &&
    !process.env["NO_COLOR"] &&
    process.env["TERM"] !== "dumb";
const wrap = (code) => (s) => useColor ? `[${code}m${s}[0m` : s;
export const color = {
    dim: wrap("2"),
    red: wrap("31"),
    green: wrap("32"),
    yellow: wrap("33"),
    blue: wrap("34"),
    cyan: wrap("36"),
    bold: wrap("1"),
};
let logFile = null;
let mirrorToStdout = true;
export function configureLogging(opts) {
    if (opts.file !== undefined) {
        logFile = opts.file;
        try {
            mkdirSync(dirname(logFile), { recursive: true });
        }
        catch {
            /* the log is a convenience; never fail the run over it */
        }
    }
    if (opts.mirror !== undefined)
        mirrorToStdout = opts.mirror;
}
function stamp() {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function emit(line, plain) {
    if (mirrorToStdout)
        process.stdout.write(line + "\n");
    if (logFile) {
        try {
            appendFileSync(logFile, `${stamp()} ${plain}\n`);
        }
        catch {
            /* disk full / permissions: keep going */
        }
    }
}
const strip = (s) => s.replace(/\[[0-9;]*m/g, "");
export const log = {
    plain(msg) {
        emit(msg, strip(msg));
    },
    info(msg) {
        emit(`${stamp()} ${color.blue("·")} ${msg}`, `· ${strip(msg)}`);
    },
    ok(msg) {
        emit(`${stamp()} ${color.green("✔")} ${msg}`, `✔ ${strip(msg)}`);
    },
    warn(msg) {
        emit(`${stamp()} ${color.yellow("!")} ${msg}`, `! ${strip(msg)}`);
    },
    error(msg) {
        emit(`${stamp()} ${color.red("✖")} ${msg}`, `✖ ${strip(msg)}`);
    },
    step(msg) {
        emit(`${stamp()} ${color.cyan("▸")} ${color.cyan(msg)}`, `▸ ${strip(msg)}`);
    },
    detail(msg) {
        emit(`${stamp()}   ${color.dim(msg)}`, `  ${strip(msg)}`);
    },
    /** Indented excerpt of command output, trimmed to the last `maxLines`. */
    excerpt(text, maxLines = 20) {
        const lines = text.split("\n").filter((l) => l.trim() !== "");
        for (const l of lines.slice(-maxLines)) {
            emit(`    ${color.dim("| " + l)}`, `    | ${strip(l)}`);
        }
    },
    blank() {
        emit("", "");
    },
};
export function formatDuration(seconds) {
    if (seconds >= 3600) {
        return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
    }
    if (seconds >= 60) {
        return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
    }
    return `${seconds}s`;
}
/** "25m" / "90s" / "2h" / "1500" -> seconds */
export function parseDuration(value) {
    if (typeof value === "number")
        return Math.max(0, Math.floor(value));
    const m = /^(\d+)\s*([smh]?)$/i.exec(value.trim());
    if (!m)
        return 0;
    const n = Number(m[1]);
    switch ((m[2] ?? "").toLowerCase()) {
        case "h":
            return n * 3600;
        case "m":
            return n * 60;
        default:
            return n;
    }
}
//# sourceMappingURL=ui.js.map