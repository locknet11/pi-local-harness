#!/usr/bin/env bash
# ==============================================================================
#  lib/common.sh — logging, portable timeouts, locking, signal handling
# ------------------------------------------------------------------------------
#  Escrito para bash 3.2 (el que trae macOS). Nada de arrays asociativos,
#  `mapfile`, `${x^^}` ni `&>>`.
#
#  Reemplaza tres binarios que en macOS NO existen:
#    timeout(1)  -> run_supervised()   (watchdog propio)
#    flock(1)    -> acquire_lock()     (mkdir atómico + PID staleness)
#    setsid(1)   -> `set -m`           (cada job en su propio process group)
# ==============================================================================

# --- Colores (sólo si stdout es un TTY) ---------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    C_RESET=$'\033[0m'; C_DIM=$'\033[2m';  C_RED=$'\033[31m'
    C_GRN=$'\033[32m';  C_YLW=$'\033[33m'; C_BLU=$'\033[34m'; C_CYN=$'\033[36m'
else
    C_RESET=""; C_DIM=""; C_RED=""; C_GRN=""; C_YLW=""; C_BLU=""; C_CYN=""
fi

# --- Estado global compartido -------------------------------------------------
CHILD_PID=""            # PID del hijo supervisado actual
WATCHDOG_PID=""         # PID del watchdog de timeout
STOP_REQUESTED=0        # 1 cuando llegó SIGINT/SIGTERM
SIGNAL_COUNT=0          # 2da señal = SIGKILL inmediato
RUN_TIMED_OUT=0         # lo setea run_supervised()
LOCK_DIR=""             # lock tomado por este proceso (para cleanup)
HARNESS_TMP=""          # tmpdir de la corrida
DUP_LOG=1               # 0 cuando stdout ya apunta al log (modo daemon)

# --- Logging ------------------------------------------------------------------
_log_raw() {
    local line="$1"
    printf '%s\n' "$line"
    if [ "$DUP_LOG" -eq 1 ] && [ -n "${LOG_FILE:-}" ]; then
        printf '%s\n' "$line" >> "$LOG_FILE" 2>/dev/null || true
    fi
}

log()      { _log_raw "$(date '+%Y-%m-%d %H:%M:%S') $*"; }
log_info() { log "${C_BLU}·${C_RESET} $*"; }
log_ok()   { log "${C_GRN}✔${C_RESET} $*"; }
log_warn() { log "${C_YLW}!${C_RESET} $*"; }
log_err()  { log "${C_RED}✖${C_RESET} $*"; }
log_step() { log "${C_CYN}▸${C_RESET} ${C_CYN}$*${C_RESET}"; }
log_dim()  { log "${C_DIM}  $*${C_RESET}"; }

die() { log_err "$*"; exit 1; }

# Vuelca un archivo al log, indentado y recortado.
log_tail() {
    local file="$1" n="${2:-40}"
    [ -s "$file" ] || return 0
    tail -n "$n" "$file" 2>/dev/null | while IFS= read -r l; do
        _log_raw "    ${C_DIM}| ${l}${C_RESET}"
    done
    return 0
}

# --- Duraciones: "25m" / "90s" / "2h" / "1500" --> segundos --------------------
parse_duration() {
    local v="$1" n u
    case "$v" in
        ''|*[!0-9smhSMH]*|'') ;;
    esac
    n=$(printf '%s' "$v" | sed 's/[^0-9]//g')
    u=$(printf '%s' "$v" | sed 's/[0-9]//g' | tr 'A-Z' 'a-z')
    [ -n "$n" ] || { printf '0'; return 1; }
    case "$u" in
        s|'') printf '%s' "$n" ;;
        m)    printf '%s' "$((n * 60))" ;;
        h)    printf '%s' "$((n * 3600))" ;;
        *)    printf '%s' "$n" ;;
    esac
}

human_secs() {
    local s="$1"
    if [ "$s" -ge 3600 ]; then printf '%dh%02dm' "$((s/3600))" "$(((s%3600)/60))"
    elif [ "$s" -ge 60 ]; then printf '%dm%02ds' "$((s/60))" "$((s%60))"
    else printf '%ds' "$s"; fi
}

# --- Señales ------------------------------------------------------------------
# Mata al hijo Y a su árbol. Gracias a `set -m` el hijo es líder de su propio
# process group, así que el `-PID` se lleva puesto también a los nietos
# (los bash que pi lanza desde su tool `bash`).
kill_tree() {
    local pid="$1" sig="${2:-TERM}"
    [ -n "$pid" ] || return 0
    kill -"$sig" -- -"$pid" 2>/dev/null || kill -"$sig" "$pid" 2>/dev/null || true
}

on_signal() {
    local sig="$1"
    SIGNAL_COUNT=$((SIGNAL_COUNT + 1))
    STOP_REQUESTED=1
    if [ "$SIGNAL_COUNT" -ge 2 ]; then
        log_err "Segunda señal ($sig): SIGKILL a todo y salgo."
        kill_tree "$CHILD_PID" KILL
        kill_tree "$WATCHDOG_PID" KILL
        exit 130
    fi
    log_warn "Señal $sig. Cortando la corrida actual… (otro Ctrl+C = SIGKILL)"
    kill_tree "$CHILD_PID" TERM
}

install_signal_traps() {
    trap 'on_signal INT'  INT
    trap 'on_signal TERM' TERM
    trap 'on_signal HUP'  HUP
}

# --- Locking (sin flock) ------------------------------------------------------
# mkdir es atómico en cualquier FS POSIX: o lo creás vos, o ya existía.
acquire_lock() {
    local dir="$1" owner
    if mkdir "$dir" 2>/dev/null; then
        printf '%s\n' "$$" > "$dir/pid"
        LOCK_DIR="$dir"
        return 0
    fi
    owner="$(cat "$dir/pid" 2>/dev/null)"
    if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
        return 1                       # lock vivo y legítimo
    fi
    # Lock huérfano (el dueño murió sin limpiar): lo robamos.
    rm -rf "$dir" 2>/dev/null || true
    if mkdir "$dir" 2>/dev/null; then
        printf '%s\n' "$$" > "$dir/pid"
        LOCK_DIR="$dir"
        return 0
    fi
    return 1
}

release_lock() {
    [ -n "$LOCK_DIR" ] && [ -d "$LOCK_DIR" ] || return 0
    if [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$$" ]; then
        rm -rf "$LOCK_DIR" 2>/dev/null || true
    fi
    LOCK_DIR=""
}

# --- Ejecución supervisada (sin timeout(1)) -----------------------------------
# run_supervised <segundos> <logfile> -- <cmd...>
#   segundos = 0  -> sin límite
#   Setea RUN_TIMED_OUT=1 si el watchdog tuvo que intervenir.
#
#   El `wait` es clave: bash SÓLO corre los traps cuando está bloqueado en
#   `wait`, no cuando está bloqueado en un comando en foreground. Ese era el
#   bug clásico del Ctrl+C que no cortaba nada.
run_supervised() {
    local secs="$1"; shift
    local out="$1"; shift
    [ "${1:-}" = "--" ] && shift
    local rc flag

    RUN_TIMED_OUT=0
    # Sin fallback, un HARNESS_TMP vacío manda el flag a "/timeout.flag.N": el
    # watchdog mata igual, pero el timeout se reporta como un exit code
    # cualquiera y el loop lo confunde con "los tests fallaron".
    flag="${HARNESS_TMP:-${TMPDIR:-/tmp}}/timeout.flag.$$"
    rm -f "$flag" 2>/dev/null || true

    # `set -m` (job control) hace que cada job en background arranque en su
    # propio process group. Es el sustituto de setsid, que en macOS no existe.
    set -m
    { "$@" >> "$out" 2>&1; } &
    CHILD_PID=$!
    set +m

    if [ "$secs" -gt 0 ]; then
        set -m
        (
            sleep "$secs"
            kill -0 "$CHILD_PID" 2>/dev/null || exit 0
            : > "$flag"
            kill -TERM -- -"$CHILD_PID" 2>/dev/null || kill -TERM "$CHILD_PID" 2>/dev/null
            sleep 15
            kill -0 "$CHILD_PID" 2>/dev/null || exit 0
            kill -KILL -- -"$CHILD_PID" 2>/dev/null || kill -KILL "$CHILD_PID" 2>/dev/null
        ) &
        WATCHDOG_PID=$!
        set +m
    fi

    wait "$CHILD_PID" 2>/dev/null; rc=$?
    # Si un trap nos interrumpió, `wait` volvió antes de tiempo: reapeamos.
    if [ "$rc" -gt 128 ] && kill -0 "$CHILD_PID" 2>/dev/null; then
        wait "$CHILD_PID" 2>/dev/null; rc=$?
    fi

    if [ -n "$WATCHDOG_PID" ]; then
        kill_tree "$WATCHDOG_PID" KILL
        wait "$WATCHDOG_PID" 2>/dev/null || true
        WATCHDOG_PID=""
    fi
    CHILD_PID=""

    if [ -f "$flag" ]; then
        RUN_TIMED_OUT=1
        rm -f "$flag" 2>/dev/null || true
        return 124
    fi
    return "$rc"
}

# sleep interrumpible (un `sleep` pelado se come el Ctrl+C)
nap() {
    local secs="$1"
    [ "$STOP_REQUESTED" -eq 0 ] || return 0
    [ "$secs" -gt 0 ] || return 0
    set -m
    sleep "$secs" &
    CHILD_PID=$!
    set +m
    wait "$CHILD_PID" 2>/dev/null || true
    CHILD_PID=""
    return 0
}

# --- Utilidades varias --------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

# El ejecutable de un comando, ¿existe? Evita quemar N reintentos contra un 127.
#
# Hay que saltear los prefijos `VAR=valor` y el `env`: un comando como
#   PYTHONPATH=. .venv/bin/pytest -q
# es perfectamente válido (de hecho lo genera el andamiaje solo), pero si se
# toma el primer token a lo bruto sale "PYTHONPATH=." y el harness se planta
# diciendo que el comando no existe.
cmd_available() {
    local tok rest="$1" found=""
    while [ -n "$rest" ]; do
        tok=$(printf '%s' "$rest" | awk '{print $1}')
        [ -n "$tok" ] || break
        case "$tok" in
            *=*)  ;;                       # asignación de entorno: seguir
            env)  ;;                       # `env FOO=bar cmd`: seguir
            *)    found="$tok"; break ;;
        esac
        rest=$(printf '%s' "$rest" | sed 's/^[[:space:]]*[^[:space:]]*[[:space:]]*//')
    done
    [ -n "$found" ] || return 1
    # Una ruta relativa/absoluta (./x, .venv/bin/pytest) no está en el PATH:
    # se chequea que exista y sea ejecutable.
    case "$found" in
        */*) [ -x "$found" ] && return 0 || return 1 ;;
        *)   command -v "$found" >/dev/null 2>&1 ;;
    esac
}

# nvm no deja node en el PATH de un shell no interactivo salvo que exista el
# alias `default`. pi se instala vía npm, así que sin esto el modo daemon
# arranca sin `pi`.
#
# Y hay un caso aparte: `npm config set prefix ~/.npm-global` (la forma de
# instalar global sin sudo). Ahí node está en /usr/bin pero pi NO, porque vive
# en el prefix del usuario, que sólo entra al PATH vía .bashrc — que un shell
# no interactivo no lee. Interactivo anda, en background no: hay que buscarlo.
ensure_node_in_path() {
    local best d prefix
    if ! have node; then
        if [ -d "${NVM_DIR:-$HOME/.nvm}/versions/node" ]; then
            best=$(ls -1 "${NVM_DIR:-$HOME/.nvm}/versions/node" 2>/dev/null | sort -V | tail -n 1)
            if [ -n "$best" ] && [ -x "${NVM_DIR:-$HOME/.nvm}/versions/node/$best/bin/node" ]; then
                PATH="${NVM_DIR:-$HOME/.nvm}/versions/node/$best/bin:$PATH"; export PATH
            fi
        fi
    fi
    if ! have node; then
        for d in "$HOME/.volta/bin" "$HOME/.asdf/shims" "$HOME/.bun/bin" \
                 /opt/homebrew/bin /usr/local/bin; do
            [ -x "$d/node" ] && { PATH="$d:$PATH"; export PATH; break; }
        done
    fi

    # El bin del prefix de npm, aunque node ya esté resuelto.
    for d in "$HOME/.npm-global/bin" "$HOME/.local/bin" "$HOME/node_modules/.bin"; do
        case ":$PATH:" in *":$d:"*) ;; *) [ -d "$d" ] && { PATH="$d:$PATH"; export PATH; } ;; esac
    done
    if ! have pi && have npm; then
        prefix=$(npm config get prefix 2>/dev/null)
        if [ -n "$prefix" ] && [ "$prefix" != "undefined" ] && [ -x "$prefix/bin/pi" ]; then
            PATH="$prefix/bin:$PATH"; export PATH
        fi
    fi
    have node
}

# Escapa un string para meterlo en JSON (sin depender de jq).
json_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
        -e 's/	/\\t/g' | awk 'BEGIN{ORS=""} {if (NR>1) print "\\n"; print}'
}

# Sin TTY (ssh no interactivo, cron, modo daemon) no hay a quién preguntarle:
# se responde que no en vez de reventar contra /dev/tty.
confirm() {
    local prompt="$1" ans
    [ "${ASSUME_YES:-0}" -eq 1 ] && return 0
    if [ ! -r /dev/tty ] || ! : > /dev/tty 2>/dev/null; then
        log_dim "(sin TTY: asumo que no a '$prompt')"
        return 1
    fi
    printf '%s [y/N] ' "$prompt" > /dev/tty
    read -r ans < /dev/tty || return 1
    case "$ans" in y|Y|yes|YES|s|S|si|SI) return 0 ;; *) return 1 ;; esac
}
