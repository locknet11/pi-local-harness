#!/usr/bin/env bash
# ==============================================================================
#  lib/runner.sh — invocación de pi y lectura del stream de eventos JSON
# ------------------------------------------------------------------------------
#  pi corre en `-p --mode json`, que escupe un evento JSON por línea. De ahí
#  sacamos señales mucho más útiles que el exit code pelado:
#
#    · ¿el modelo llamó a alguna herramienta de escritura? (si no, no hizo NADA)
#    · ¿alguna tool devolvió error?
#    · tokens gastados, para detectar que el contexto se está desbordando
#
#  Un modelo local chico muchas veces "responde" describiendo el código en vez
#  de escribirlo. El exit code en ese caso es 0. Por eso miramos las tools.
# ==============================================================================

PI_LAST_JSONL=""        # ruta al JSONL de la última corrida
PI_LAST_WRITES=0        # cuántas tool calls de escritura hubo
PI_LAST_TOOL_ERRORS=0
PI_LAST_TOKENS=0

# Herramientas de pi que efectivamente modifican el repo.
PI_WRITE_TOOLS_RE='^(edit|write|multi_edit|apply_patch|create_file|str_replace)$'

# --- Construcción de la línea de comandos -------------------------------------
# El array se arma a mano y NUNCA pasando por un archivo intermedio: el prompt
# es multilínea, y leerlo de vuelta línea por línea lo partiría en decenas de
# argumentos sueltos. Bash 3.2 no tiene `arr+=(x)`, de ahí el índice explícito.
_pa() { PI_ARGV[${#PI_ARGV[@]}]="$1"; }

# `--no-context-files` NO se usa: queremos que pi descubra AGENTS.md solo.
# Adjuntarlo a mano además de eso duplicaría contexto, que es justo el recurso
# escaso con modelos locales.
pi_build_argv() {
    PI_ARGV=()
    _pa -p; _pa --mode; _pa json; _pa --approve
    [ -n "${PI_PROVIDER:-}" ] && { _pa --provider; _pa "$PI_PROVIDER"; }
    [ -n "${PI_MODEL:-}" ]    && { _pa --model;    _pa "$PI_MODEL"; }
    [ -n "${PI_THINKING:-}" ] && { _pa --thinking; _pa "$PI_THINKING"; }
    return 0
}

# pi_run <tag> <timeout_secs> <prompt_text> [archivo_a_adjuntar...]
#
#   Sesión nueva por invocación a propósito: cada feature arranca con el
#   contexto limpio. Arrastrar la sesión entre features llena la ventana con
#   basura vieja y el modelo local empieza a truncar justo lo que importa.
pi_run() {
    local tag="$1"; shift
    local secs="$1"; shift
    local prompt="$1"; shift

    local jsonl rc f
    jsonl="$HARNESS_TMP/pi.${tag}.jsonl"
    : > "$jsonl"
    PI_LAST_JSONL="$jsonl"

    pi_build_argv
    if [ "${PI_SAVE_SESSIONS:-0}" -eq 1 ]; then
        _pa --name; _pa "harness-$tag"
    else
        _pa --no-session
    fi
    for f in "$@"; do
        [ -f "$f" ] && _pa "@$f"
    done
    _pa "$prompt"          # el prompt va entero, como un único argumento

    log_dim "pi ${PI_PROVIDER:-<default>}/${PI_MODEL:-<default>} · timeout $(human_secs "$secs")"
    run_supervised "$secs" "$jsonl" -- "$PI_BIN" "${PI_ARGV[@]}"
    rc=$?

    pi_analyze "$jsonl"
    return "$rc"
}

# --- Lectura del stream -------------------------------------------------------
pi_analyze() {
    local jsonl="$1"
    PI_LAST_WRITES=0
    PI_LAST_TOOL_ERRORS=0
    PI_LAST_TOKENS=0
    [ -s "$jsonl" ] || return 0

    # Ojo: `grep -c` sin matches imprime "0" Y sale con 1. Un `|| printf 0`
    # detrás termina concatenando y devolviendo "00", que después revienta las
    # comparaciones numéricas. Por eso todo cuenta con `wc -l`.
    if have jq; then
        PI_LAST_WRITES=$(jq -r 'select(.type == "tool_execution_end")
            | select(.isError != true) | .toolName' "$jsonl" 2>/dev/null \
            | grep -E "$PI_WRITE_TOOLS_RE" | wc -l | tr -d ' ')
        PI_LAST_TOOL_ERRORS=$(jq -r 'select(.type == "tool_execution_end" and .isError == true)
            | .toolName' "$jsonl" 2>/dev/null | wc -l | tr -d ' ')
        PI_LAST_TOKENS=$(jq -r 'select(.type == "turn_end")
            | .message.usage.totalTokens // empty' "$jsonl" 2>/dev/null | sort -n | tail -1)
    else
        PI_LAST_WRITES=$(grep -o '"toolName":"[a-z_]*"' "$jsonl" 2>/dev/null \
            | sed 's/.*:"//; s/"//' | grep -E "$PI_WRITE_TOOLS_RE" | wc -l | tr -d ' ')
        PI_LAST_TOOL_ERRORS=$(grep -o '"isError":true' "$jsonl" 2>/dev/null | wc -l | tr -d ' ')
        PI_LAST_TOKENS=$(grep -o '"totalTokens":[0-9]*' "$jsonl" 2>/dev/null \
            | sed 's/.*://' | sort -n | tail -1)
    fi

    [ -n "$PI_LAST_WRITES" ]      || PI_LAST_WRITES=0
    [ -n "$PI_LAST_TOOL_ERRORS" ] || PI_LAST_TOOL_ERRORS=0
    [ -n "$PI_LAST_TOKENS" ]      || PI_LAST_TOKENS=0
    return 0
}

# Último texto del asistente (para diagnóstico y para leer respuestas de la
# fase de entrevista).
pi_last_text() {
    local jsonl="${1:-$PI_LAST_JSONL}"
    [ -s "$jsonl" ] || return 1
    if have jq; then
        jq -r 'select(.type == "agent_end")
               | .messages[-1].content[]?
               | select(.type == "text") | .text' "$jsonl" 2>/dev/null | tail -n 200
    else
        grep '"type":"agent_end"' "$jsonl" | tail -1 \
            | sed 's/.*"type":"text","text":"//; s/"}.*//' \
            | sed 's/\\n/\
/g; s/\\"/"/g'
    fi
}

# Mensajes de error del proveedor. Con Ollama los más comunes son:
#   · context length exceeded  -> num_ctx chico (ver ollama_tune_context)
#   · model not found          -> falta `ollama pull`
#   · connection refused       -> el server se murió
pi_error_hint() {
    local jsonl="${1:-$PI_LAST_JSONL}"
    [ -s "$jsonl" ] || return 1
    grep -io 'context length[^"]*\|context window[^"]*\|model .\{0,40\}not found\|connection refused\|ECONNREFUSED\|502 Bad Gateway\|rate limit[^"]*' \
        "$jsonl" 2>/dev/null | sort -u | head -3
}

pi_log_run_summary() {
    local rc="$1"
    log_dim "tools: ${PI_LAST_WRITES} escrituras, ${PI_LAST_TOOL_ERRORS} errores · ~${PI_LAST_TOKENS} tokens · exit ${rc}"
    local hint
    hint=$(pi_error_hint)
    if [ -n "$hint" ]; then
        printf '%s\n' "$hint" | while IFS= read -r h; do
            [ -n "$h" ] && log_warn "proveedor: $h"
        done
    fi
    return 0
}

# ¿La corrida sirvió de algo? Un exit 0 sin una sola escritura significa que el
# modelo charló en vez de trabajar: para el harness eso es un fracaso.
pi_did_work() {
    [ "$PI_LAST_WRITES" -gt 0 ]
}
