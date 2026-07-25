#!/usr/bin/env bash
# ==============================================================================
#  pi-harness — orquestador de proyectos completos con pi + LLMs locales
# ------------------------------------------------------------------------------
#  Uso:
#    ./pi-harness.sh init            entrevista, escribe los docs y el andamiaje
#    ./pi-harness.sh run             implementa el backlog feature por feature
#    ./pi-harness.sh build           init + run, de una
#    ./pi-harness.sh doctor          diagnostica entorno, Ollama, pi y tests
#    ./pi-harness.sh setup-model     registra el modelo de Ollama en pi
#    ./pi-harness.sh tune-ctx M [N]  crea un modelo derivado con num_ctx grande
#    ./pi-harness.sh spec            estado del backlog
#    ./pi-harness.sh reset [ESTADO]  devuelve features a PENDING (default FAILED)
#    ./pi-harness.sh status|stop|follow
#
#  Flags: -b/--background  -y/--yes  --idea "..."  --brief archivo
#         --model M  --provider P  --once  --feature ID
#         --probe   (con doctor) prueba de verdad si el modelo ejecuta tools
#
#  Todo lo configurable se puede pisar por entorno o por ./harness.conf:
#    OLLAMA_MODEL=qwen3-coder:30b MAX_RETRIES=5 ./pi-harness.sh build
# ==============================================================================

set -uo pipefail        # `set -e` NO: el loop maneja los errores a mano

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$HARNESS_DIR/$(basename "${BASH_SOURCE[0]}")"

export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$HOME/.local/bin"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
    # nvm.sh no es `set -u` safe: toca variables sin definir y mata el shell.
    set +u; . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; set -u
fi

for m in common ollama spec verify gitops runner bootstrap; do
    . "$HARNESS_DIR/lib/$m.sh" || { echo "No pude cargar lib/$m.sh" >&2; exit 1; }
done

# ==============================================================================
#  CONFIGURACIÓN
# ==============================================================================
PROJECT_DIR="${PROJECT_DIR:-$PWD}"
[ -f "$PROJECT_DIR/harness.conf" ] && . "$PROJECT_DIR/harness.conf"

# --- Modelo -------------------------------------------------------------------
OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3-coder:30b}"
PI_PROVIDER="${PI_PROVIDER:-ollama}"
PI_MODEL="${PI_MODEL:-$OLLAMA_MODEL}"
PI_THINKING="${PI_THINKING:-off}"
PI_BIN="${PI_BIN:-pi}"
MODEL_CONTEXT="${MODEL_CONTEXT:-32768}"
MODEL_MAXOUT="${MODEL_MAXOUT:-8192}"
MODEL_REASONING="${MODEL_REASONING:-false}"
PI_SAVE_SESSIONS="${PI_SAVE_SESSIONS:-0}"

# --- Archivos -----------------------------------------------------------------
SPEC_FILE="${SPEC_FILE:-PROJECT_SPEC.md}"
AGENTS_FILE="${AGENTS_FILE:-AGENTS.md}"
STATE_DIR="${STATE_DIR:-.harness}"
LOG_FILE="${LOG_FILE:-$STATE_DIR/harness.log}"
PID_FILE="${PID_FILE:-$STATE_DIR/run/harness.pid}"
LOCK_PATH="${LOCK_PATH:-$STATE_DIR/run/harness.lock.d}"

# --- Loop ---------------------------------------------------------------------
MAX_RETRIES="${MAX_RETRIES:-4}"
MAX_CONSECUTIVE_FAILURES="${MAX_CONSECUTIVE_FAILURES:-3}"
FEATURE_TIMEOUT="${FEATURE_TIMEOUT:-30m}"
TEST_TIMEOUT="${TEST_TIMEOUT:-10m}"
BOOTSTRAP_TIMEOUT_RAW="${BOOTSTRAP_TIMEOUT:-25m}"
COOLDOWN="${COOLDOWN:-10}"
VRAM_STRATEGY="${VRAM_STRATEGY:-auto}"
GIT_ROLLBACK_ON_FAIL="${GIT_ROLLBACK_ON_FAIL:-1}"
GIT_BRANCH="${GIT_BRANCH:-}"
TEST_COMMAND="${TEST_COMMAND:-}"
TEST_EXCERPT_LINES="${TEST_EXCERPT_LINES:-60}"
FEATURE_TARGET="${FEATURE_TARGET:-10}"
BOOTSTRAP_RETRIES="${BOOTSTRAP_RETRIES:-3}"

FEATURE_TIMEOUT_S=$(parse_duration "$FEATURE_TIMEOUT")
TEST_TIMEOUT_S=$(parse_duration "$TEST_TIMEOUT")
BOOTSTRAP_TIMEOUT=$(parse_duration "$BOOTSTRAP_TIMEOUT_RAW")

# --- Estado -------------------------------------------------------------------
ASSUME_YES=0
BACKGROUND=0
RUN_ONCE=0
ONLY_FEATURE=""
IDEA=""
BRIEF_IN=""
TEST_COMMAND_RESOLVED=""
CURRENT_IDX=""
CMD=""

# ==============================================================================
#  ARGUMENTOS
# ==============================================================================
usage() { sed -n '3,26p' "$SELF" | sed 's/^#\{1,2\} \{0,1\}//'; }

while [ $# -gt 0 ]; do
    case "$1" in
        init|run|build|scaffold|doctor|spec|status|stop|follow|reset|setup-model|tune-ctx)
            [ -z "$CMD" ] && CMD="$1" || ARGV_REST="${ARGV_REST:-} $1" ;;
        -b|--background) BACKGROUND=1 ;;
        -y|--yes)        ASSUME_YES=1 ;;
        --once)          RUN_ONCE=1 ;;
        --probe)         DOCTOR_PROBE=1 ;;
        --feature)       shift; ONLY_FEATURE="${1:-}" ;;
        --idea)          shift; IDEA="${1:-}" ;;
        --brief)         shift; BRIEF_IN="${1:-}" ;;
        --model)         shift; PI_MODEL="${1:-}"; OLLAMA_MODEL="$PI_MODEL" ;;
        --provider)      shift; PI_PROVIDER="${1:-}" ;;
        --spec)          shift; SPEC_FILE="${1:-}" ;;
        -h|--help)       usage; exit 0 ;;
        *)               ARGV_REST="${ARGV_REST:-} $1" ;;
    esac
    shift
done
CMD="${CMD:-run}"
set -- ${ARGV_REST:-}

cd "$PROJECT_DIR" || die "No pude entrar a $PROJECT_DIR"
mkdir -p "$STATE_DIR/run" "$STATE_DIR/tmp" 2>/dev/null || true

# ==============================================================================
#  SUBCOMANDOS LIVIANOS (no necesitan lock ni tmpdir)
# ==============================================================================
read_pid() { [ -f "$PID_FILE" ] && cat "$PID_FILE" 2>/dev/null; }

cmd_status() {
    local pid; pid=$(read_pid)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        printf '%s● corriendo%s (PID %s) · log: %s\n' "$C_GRN" "$C_RESET" "$pid" "$LOG_FILE"
        return 0
    fi
    printf '%s○ no hay nada corriendo%s\n' "$C_DIM" "$C_RESET"
    [ -n "$pid" ] && printf '  (PID file viejo con %s)\n' "$pid"
    return 1
}

cmd_stop() {
    local pid i; pid=$(read_pid)
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
        printf '○ no hay nada corriendo\n'; rm -f "$PID_FILE"; return 1
    fi
    printf 'Mandando SIGTERM a %s y su grupo…\n' "$pid"
    kill -TERM -- -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    i=0
    while [ "$i" -lt 30 ]; do
        kill -0 "$pid" 2>/dev/null || { printf '%s✔ frenado%s\n' "$C_GRN" "$C_RESET"; rm -f "$PID_FILE"; return 0; }
        sleep 1; i=$((i + 1))
    done
    printf 'No aflojó. SIGKILL.\n'
    kill -KILL -- -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
}

cmd_spec() {
    [ -f "$SPEC_FILE" ] || die "No existe $SPEC_FILE. Corré: $0 init"
    printf '\n%s%s%s\n\n' "$C_CYN" "$SPEC_FILE" "$C_RESET"
    spec_summary
    local errs; errs=$(spec_validate)
    if [ -n "$errs" ]; then
        printf '\n%sProblemas de formato:%s\n' "$C_YLW" "$C_RESET"
        printf '%s\n' "$errs" | sed 's/^/  /'
    fi
    printf '\n'
}

cmd_reset() {
    local from="${1:-FAILED}" n
    [ -f "$SPEC_FILE" ] || die "No existe $SPEC_FILE"
    if [ "$from" = "all" ]; then
        local t=0
        for s in FAILED UNVERIFIED IN_PROGRESS COMPLETED BLOCKED; do
            n=$(spec_reset_from "$s"); t=$((t + n))
        done
        printf '♻ %s feature(s) devueltas a PENDING.\n' "$t"
    else
        n=$(spec_reset_from "$from")
        printf '♻ %s feature(s) en %s devueltas a PENDING.\n' "$n" "$from"
    fi
}

cmd_setup_model() {
    local model="${1:-$OLLAMA_MODEL}"
    log_step "Registrando '$model' como $PI_PROVIDER/$model en pi"

    if ! ollama_api_up; then
        log_warn "Ollama no responde en $OLLAMA_URL. Intento levantarlo…"
        ollama_start || log_warn "No pude levantarlo. Sigo igual con el registro."
    fi
    if ollama_api_up && ! ollama_has_model "$model"; then
        log_warn "Ollama no tiene '$model' descargado."
        log_dim "Modelos disponibles:"
        ollama_local_models | sed 's/^/    /'
        if confirm "¿Hago 'ollama pull $model' ahora?"; then
            have ollama || die "No tengo la CLI de ollama."
            ollama pull "$model" || die "Falló el pull."
        fi
    fi

    register_ollama_provider "$PI_PROVIDER" "$OLLAMA_URL/v1" "$model" \
        "$MODEL_CONTEXT" "$MODEL_MAXOUT" "$MODEL_REASONING" \
        || die "No pude escribir $PI_MODELS_JSON"

    log_ok "Escrito en $PI_MODELS_JSON"
    if pi_sees_model "$PI_PROVIDER" "$model"; then
        log_ok "pi ve el modelo: $PI_PROVIDER/$model"
    else
        log_warn "pi todavía no lista el modelo. Revisá con: pi --list-models $model"
    fi
}

# ==============================================================================
#  DOCTOR
# ==============================================================================
cmd_doctor() {
    local ok=0 warn=0 bad=0
    _d_ok()   { printf '  %s✔%s %s\n' "$C_GRN" "$C_RESET" "$1"; ok=$((ok+1)); }
    _d_warn() { printf '  %s!%s %s\n' "$C_YLW" "$C_RESET" "$1"; warn=$((warn+1)); }
    _d_bad()  { printf '  %s✖%s %s\n' "$C_RED" "$C_RESET" "$1"; bad=$((bad+1)); }

    printf '\n%s── Entorno ─────────────────────────────────%s\n' "$C_CYN" "$C_RESET"
    ensure_node_in_path || true
    have "$PI_BIN" && _d_ok "pi $("$PI_BIN" --version 2>/dev/null | tr -d '\033' | sed 's/\[[0-9;]*[A-Za-z]//g' | tail -1)" \
                  || _d_bad "no encuentro 'pi' en el PATH (npm i -g @earendil-works/pi-coding-agent)"
    have git && _d_ok "git" || _d_bad "falta git"
    have jq  && _d_ok "jq (parseo exacto del stream JSON)" \
             || _d_warn "sin jq: uso un parser con grep, menos preciso"
    have curl && _d_ok "curl" || _d_warn "sin curl no puedo hablarle a la API de Ollama"
    local missing=""
    for b in timeout flock setsid; do have "$b" || missing="$missing $b"; done
    if [ -n "$missing" ]; then
        printf '  %s·%s bash %s · sin%s: los reemplaza el harness\n' \
            "$C_DIM" "$C_RESET" "${BASH_VERSION%%(*}" "$missing"
    else
        printf '  %s·%s bash %s · timeout/flock/setsid presentes (el harness usa los suyos igual)\n' \
            "$C_DIM" "$C_RESET" "${BASH_VERSION%%(*}"
    fi

    printf '\n%s── Ollama ──────────────────────────────────%s\n' "$C_CYN" "$C_RESET"
    if ollama_api_up; then
        _d_ok "API viva en $OLLAMA_URL"
        if ollama_has_model "$OLLAMA_MODEL"; then
            _d_ok "modelo descargado: $OLLAMA_MODEL"
        else
            _d_bad "falta el modelo '$OLLAMA_MODEL' (ollama pull $OLLAMA_MODEL)"
            ollama_local_models | head -8 | sed 's/^/      tenés: /'
        fi
        local eff arch srv; eff=$(ollama_effective_ctx "$OLLAMA_MODEL" 2>/dev/null)
        arch=$(ollama_arch_ctx "$OLLAMA_MODEL" 2>/dev/null)
        srv=$(ollama_server_ctx_default 2>/dev/null)
        if [ -n "$eff" ]; then
            # num_ctx fijado en el Modelfile: es el que se sirve, sin discusión.
            if [ "$eff" -ge 16384 ]; then
                _d_ok "num_ctx fijado en el Modelfile: $eff${arch:+ (techo del modelo: $arch)}"
            else
                _d_bad "num_ctx fijado en $eff — muy chico para codear.
      Arreglo: $0 tune-ctx $OLLAMA_MODEL 32768"
            fi
        elif [ -n "$srv" ]; then
            _d_ok "sin num_ctx propio, pero el server arranca con OLLAMA_CONTEXT_LENGTH=$srv"
        else
            # Éste es el caso que arruina corridas enteras sin dar un solo error.
            _d_warn "'$OLLAMA_MODEL' no fija num_ctx: se sirve con el default de Ollama
      (chico), sin importar que el modelo soporte ${arch:-mucho más}.
      El prompt se trunca en silencio y el agente 'olvida' las instrucciones.
      Arreglo: $0 tune-ctx $OLLAMA_MODEL 32768
      o poné OLLAMA_CONTEXT_LENGTH en el systemd de ollama y reiniciá."
        fi
    else
        _d_bad "Ollama no responde en $OLLAMA_URL"
    fi

    printf '\n%s── pi ↔ modelo ─────────────────────────────%s\n' "$C_CYN" "$C_RESET"
    if [ -f "$PI_MODELS_JSON" ]; then
        _d_ok "models.json: $PI_MODELS_JSON"
        if have jq && ! jq -e . "$PI_MODELS_JSON" >/dev/null 2>&1; then
            _d_bad "models.json NO es JSON válido: pi va a ignorar todos tus providers"
        fi
    else
        _d_warn "no existe $PI_MODELS_JSON (corré: $0 setup-model)"
    fi
    if pi_sees_model "$PI_PROVIDER" "$PI_MODEL"; then
        _d_ok "pi ve $PI_PROVIDER/$PI_MODEL"
    else
        _d_bad "pi NO ve $PI_PROVIDER/$PI_MODEL — corré: $0 setup-model"
    fi
    if ollama_api_up; then
        ollama_declares_tools "$OLLAMA_MODEL" \
            && _d_ok "capabilities: $(ollama_capabilities "$OLLAMA_MODEL")" \
            || _d_bad "el modelo NO declara 'tools': pi no puede hacer nada con él"
    fi
    # La prueba real cuesta una inferencia, así que va sólo con --probe.
    if [ "${DOCTOR_PROBE:-0}" -eq 1 ]; then
        printf '  %s·%s probando tool calling de verdad (tarda una inferencia)…\n' "$C_DIM" "$C_RESET"
        if pi_probe_tool_calling "$PI_PROVIDER" "$PI_MODEL"; then
            _d_ok "el modelo emite tool calls estructurados y escribió el archivo"
        else
            _d_bad "el modelo NO ejecuta tools: probablemente devuelve el JSON de la
      llamada como TEXTO. Declarar 'tools' no alcanza. Con este modelo el
      harness va a marcar todo como 'no tocó ningún archivo'. Cambialo."
        fi
    fi

    printf '\n%s── Proyecto ────────────────────────────────%s\n' "$C_CYN" "$C_RESET"
    git_available && _d_ok "repo git en $(git_head)" || _d_warn "no es un repo git (lo crea 'init')"
    [ -f "$AGENTS_FILE" ] && _d_ok "$AGENTS_FILE" || _d_warn "falta $AGENTS_FILE (lo crea 'init')"
    if [ -f "$SPEC_FILE" ]; then
        local errs; errs=$(spec_validate)
        if [ -z "$errs" ]; then _d_ok "$SPEC_FILE válido ($(spec_count) features)"
        else _d_bad "$SPEC_FILE tiene errores de formato:"; printf '%s\n' "$errs" | sed 's/^/      /'; fi
    else
        _d_warn "falta $SPEC_FILE (lo crea 'init')"
    fi

    local tc src; tc=$(resolve_test_command "" || true)
    if [ -n "$tc" ]; then
        if [ -n "${TEST_COMMAND:-}" ];                    then src="TEST_COMMAND"
        elif [ -n "$(declared_test_command 2>/dev/null)" ]; then src="$TEST_CMD_FILE"
        else                                                  src="autodetectado"; fi
        if cmd_available "$tc"; then _d_ok "verificación ($src): $tc"
        else _d_bad "verificación '$tc' no es ejecutable (daría 127): arreglá el PATH"; fi
    else
        _d_warn "sin comando de tests: las features van a quedar UNVERIFIED"
    fi

    printf '\n%s%d ok, %d avisos, %d problemas%s\n\n' "$C_DIM" "$ok" "$warn" "$bad" "$C_RESET"
    [ "$bad" -eq 0 ]
}

# ==============================================================================
#  PROMPT DE UNA FEATURE
# ==============================================================================
# Deliberadamente corto. pi ya carga AGENTS.md solo (auto-discovery), así que
# repetirlo acá sería quemar el doble de contexto — que con un modelo local es
# el recurso que primero se acaba.
build_feature_prompt() {
    local idx="$1" retry="$2" testcmd="$3"
    cat <<EOF
Implementá UNA sola feature del backlog. Está en el archivo adjunto.

Reglas:
1. Seguí AGENTS.md (arquitectura, convenciones, estructura). Ya está cargado.
2. Escribí el código Y sus tests. Cada criterio de 'acceptance' necesita un test.
3. Tiene que pasar: ${testcmd:-(sin comando de verificación)}
4. Corré ese comando con la herramienta bash antes de darte por terminado.
5. NO edites $SPEC_FILE. El estado lo maneja el harness.
6. No refactorices lo que ya funciona ni toques features ajenas.
EOF

    # El fracaso más común del modelo local: contesta el código en prosa y
    # termina el turno sin llamar a ninguna tool. Repetirle el mismo prompt da
    # el mismo resultado, así que en el reintento se le dice exactamente qué
    # hizo mal. Es la única corrección que sirve cuando no hay error que citar.
    if [ "${LAST_ATTEMPT_NO_WRITES:-0}" -eq 1 ]; then
        cat <<EOF

## ATENCIÓN: el intento anterior no modificó NADA
Escribiste una respuesta en texto sin usar las herramientas. Describir el
código no sirve: los archivos quedaron igual y la feature sigue sin hacerse.

Este turno, antes de cualquier explicación:
- usá la herramienta de escritura para crear o editar los archivos;
- después usá la herramienta bash para correr los tests.
No expliques lo que vas a hacer. Hacelo.
EOF
    fi

    if [ "${LAST_ATTEMPT_NO_TESTS:-0}" -eq 1 ]; then
        cat <<EOF

## ATENCIÓN: el intento anterior no escribió tests
Tocaste el código pero ningún archivo de tests. La suite pasa igual porque los
tests que ya existían son de OTRA feature: no prueban nada de ésta.

Este turno, escribí tests nuevos para cada criterio de 'acceptance' de esta
feature, en el archivo de tests que corresponda. Nada de stubs ni de
'return 0' de relleno: el test tiene que fallar si la implementación está mal.
EOF
    fi

    if [ "$retry" -gt 1 ] && [ -s "$VERIFY_OUTPUT" ]; then
        cat <<EOF

## El intento anterior falló
Salida real de \`$testcmd\`:

\`\`\`
$(verification_excerpt "$VERIFY_OUTPUT")
\`\`\`

Corregí exactamente eso. No reescribas de cero lo que ya andaba.
EOF
    fi
}

# ==============================================================================
#  UNA FEATURE, DE PUNTA A PUNTA
# ==============================================================================
# Devuelve: 0 ok · 1 falló · 2 entorno roto (cortar todo) · 3 interrumpido
process_feature() {
    local idx="$1" name="$2"
    local retry=0 rc checkpoint testcmd feature_file success=0 unverified=0
    LAST_ATTEMPT_NO_TESTS=0
    LAST_ATTEMPT_NO_WRITES=0

    feature_file="$HARNESS_TMP/current_feature.md"
    spec_extract_block "$idx" > "$feature_file"
    testcmd=$(resolve_test_command "$idx" || true)
    [ -n "$testcmd" ] || testcmd="$TEST_COMMAND_RESOLVED"

    checkpoint=$(git_checkpoint "$name")

    spec_set_status "$idx" "IN_PROGRESS" \
        || die "No pude escribir el status de la feature #$idx. Corto para no loopear infinito."

    while [ "$retry" -lt "$MAX_RETRIES" ] && [ "$STOP_REQUESTED" -eq 0 ]; do
        retry=$((retry + 1))
        log_info "intento $retry/$MAX_RETRIES"

        free_vram
        [ "$STOP_REQUESTED" -eq 0 ] || return 3

        local prompt; prompt=$(build_feature_prompt "$idx" "$retry" "$testcmd")
        pi_run "f${idx}-r${retry}" "$FEATURE_TIMEOUT_S" "$prompt" "$feature_file"
        rc=$?
        pi_log_run_summary "$rc"

        [ "$STOP_REQUESTED" -eq 0 ] || return 3

        if [ "$rc" -eq 124 ]; then
            log_warn "timeout: pi pasó de $(human_secs "$FEATURE_TIMEOUT_S")"
            continue
        fi
        if [ "$rc" -ne 0 ]; then
            log_warn "pi salió con código $rc"
            # Provider caído: reintentar es al pedo hasta que vuelva.
            if ! ollama_api_up; then
                log_err "Ollama dejó de responder."
                ollama_wait_up 60 || return 2
            fi
            continue
        fi
        if ! pi_did_work; then
            log_warn "el modelo no tocó ningún archivo (describió en vez de escribir)"
            LAST_ATTEMPT_NO_WRITES=1
            continue
        fi
        LAST_ATTEMPT_NO_WRITES=0

        local stat; stat=$(git_diffstat_since "$checkpoint")
        [ -n "$stat" ] && log_dim "diff: $stat"

        # Una suite verde que no creció no prueba nada de esta feature.
        if [ "${REQUIRE_TEST_CHANGES:-1}" -eq 1 ] && [ -n "$testcmd" ]; then
            local tf; tf=$(git_test_files_changed_since "$checkpoint")
            if [ "${tf:-0}" -eq 0 ]; then
                log_warn "no tocó ningún archivo de tests: la verificación no probaría nada nuevo"
                LAST_ATTEMPT_NO_TESTS=1
                continue
            fi
            LAST_ATTEMPT_NO_TESTS=0
        fi

        # --- Verificación ---
        if [ -z "$testcmd" ]; then
            log_warn "sin comando de verificación: acepto sin validar"
            success=1; unverified=1; break
        fi

        log_info "verificando: $testcmd"
        run_verification "$testcmd" "$TEST_TIMEOUT_S" "$HARNESS_TMP/test.f${idx}.log"
        rc=$?
        [ "$STOP_REQUESTED" -eq 0 ] || return 3

        case "$rc" in
            0)   log_ok "tests en verde"; success=1; break ;;
            124) log_warn "los tests se colgaron ($(human_secs "$TEST_TIMEOUT_S"))" ;;
            127) log_err "el comando de verificación no existe: '$testcmd'"
                 log_dim "Es el entorno, no el código. Freno acá."
                 return 2 ;;
            *)   log_warn "tests en rojo (código $rc)"
                 log_tail "$VERIFY_OUTPUT" 12 ;;
        esac
    done

    [ "$STOP_REQUESTED" -eq 0 ] || return 3

    if [ "$success" -eq 1 ]; then
        local final="COMPLETED"
        [ "$unverified" -eq 1 ] && final="UNVERIFIED"
        spec_set_status "$idx" "$final" || log_warn "No pude escribir $final en el spec."
        git_commit_feature "$(spec_field_of "$idx" id)" "$name" "$final"
        return 0
    fi

    log_err "circuit breaker: '$name' falló tras $MAX_RETRIES intentos"
    spec_set_status "$idx" "FAILED" || log_warn "No pude escribir FAILED en el spec."
    if [ "$GIT_ROLLBACK_ON_FAIL" -eq 1 ] && [ -n "$checkpoint" ]; then
        # Sin esto, la próxima feature arranca sobre código roto y arrastra el
        # fracaso hacia adelante.
        git_rollback_to "$checkpoint"
        spec_set_status "$idx" "FAILED" || true   # el reset --hard revirtió el spec
    else
        git_commit_feature "$(spec_field_of "$idx" id)" "$name" "FAILED"
    fi
    return 1
}

# ==============================================================================
#  LOOP PRINCIPAL
# ==============================================================================
cmd_run() {
    [ -f "$SPEC_FILE" ] || die "No existe $SPEC_FILE. Corré primero: $0 init"
    local errs; errs=$(spec_validate)
    [ -z "$errs" ] || { printf '%s\n' "$errs" | sed 's/^/  /'; die "$SPEC_FILE no parsea."; }

    git_ensure_branch "$GIT_BRANCH"
    spec_reset_stale

    TEST_COMMAND_RESOLVED=$(resolve_test_command "" || true)
    if [ -n "$TEST_COMMAND_RESOLVED" ] && ! cmd_available "$TEST_COMMAND_RESOLVED"; then
        die "El comando de verificación '$TEST_COMMAND_RESOLVED' no existe en el PATH.
    Es un problema de entorno: si arrancara igual, marcaría TODAS las features
    como FAILED sin razón. Arreglá el PATH o exportá TEST_COMMAND=...
    PATH: $PATH"
    fi

    log_step "Backlog: $(spec_count) features · modelo $PI_PROVIDER/$PI_MODEL"
    log_dim "verificación: ${TEST_COMMAND_RESOLVED:-(ninguna: todo quedará UNVERIFIED)}"

    local consecutive=0 done_count=0

    while [ "$STOP_REQUESTED" -eq 0 ]; do
        local line idx name
        if [ -n "$ONLY_FEATURE" ]; then
            idx=$(awk -v want="$ONLY_FEATURE" '
                /^#*[[:space:]]*feature:/ { i++ }
                /^[[:space:]]*id:/ {
                    v = $0; sub(/^[[:space:]]*id:[[:space:]]*/, "", v); sub(/[[:space:]]+$/, "", v)
                    if (v == want) { print i; exit }
                }' "$SPEC_FILE")
            [ -n "$idx" ] || die "No encuentro la feature con id '$ONLY_FEATURE'."
            name=$(spec_name_of "$idx")
            ONLY_FEATURE=""; RUN_ONCE=1
        else
            line=$(spec_next_pending)
            if [ -z "$line" ]; then
                if spec_has_blocked_pending; then
                    log_warn "Quedan features PENDING pero sus dependencias no están cumplidas."
                    log_dim "Mirá '$0 spec'. Arreglá los 'depends:' o reintentá las FAILED con '$0 reset'."
                else
                    log_ok "Backlog terminado."
                fi
                break
            fi
            idx=$(printf '%s' "$line" | cut -f1)
            name=$(printf '%s' "$line" | cut -f2-)
        fi

        CURRENT_IDX="$idx"
        printf '\n' >> "$LOG_FILE" 2>/dev/null || true
        log_step "#$idx $name"

        process_feature "$idx" "$name"
        local prc=$?
        CURRENT_IDX=""

        case "$prc" in
            0) consecutive=0; done_count=$((done_count + 1)) ;;
            1) consecutive=$((consecutive + 1)) ;;
            2) log_err "Entorno roto. Devuelvo '$name' a PENDING y corto."
               spec_set_status "$idx" "PENDING" || true
               break ;;
            3) log_warn "Interrumpido. Devuelvo '$name' a PENDING."
               spec_set_status "$idx" "PENDING" || true
               break ;;
        esac

        if [ "$consecutive" -ge "$MAX_CONSECUTIVE_FAILURES" ]; then
            log_err "$consecutive features seguidas fallaron. Freno global."
            log_dim "Algo está roto de raíz: modelo, contexto o tests. Mirá $LOG_FILE"
            break
        fi

        [ "$RUN_ONCE" -eq 1 ] && { log_info "--once: corté después de una feature."; break; }

        nap "$COOLDOWN"
    done

    printf '\n'
    spec_summary
    printf '\n'
    log_ok "$done_count feature(s) completadas en esta corrida."
}

# ==============================================================================
#  INIT
# ==============================================================================
cmd_init() {
    if [ -f "$SPEC_FILE" ] && ! confirm "Ya existe $SPEC_FILE. ¿Lo regenero (se pierde el progreso)?"; then
        log_info "Dejo el spec como está."
        return 0
    fi

    ensure_node_in_path || true
    have "$PI_BIN" || die "No encuentro 'pi' en el PATH."
    pi_sees_model "$PI_PROVIDER" "$PI_MODEL" \
        || log_warn "pi no lista $PI_PROVIDER/$PI_MODEL. Si falla, corré: $0 setup-model"

    git_init_repo
    git_ensure_branch "$GIT_BRANCH"

    if [ -n "$BRIEF_IN" ]; then
        [ -f "$BRIEF_IN" ] || die "No existe el brief $BRIEF_IN"
        mkdir -p "$(dirname "$BRIEF_FILE")"
        cp "$BRIEF_IN" "$BRIEF_FILE"
        log_ok "Brief tomado de $BRIEF_IN"
    elif [ -n "$IDEA" ]; then
        bootstrap_brief_from_idea "$IDEA"
    else
        bootstrap_interview || return 1
    fi

    bootstrap_generate_docs || return 1
    git_commit_feature "F000" "documentos del proyecto (AGENTS.md, PROJECT_SPEC.md)" "COMPLETED"

    bootstrap_scaffold || {
        log_warn "El andamiaje no quedó verde. Podés arreglarlo a mano y correr '$0 run'."
        return 1
    }

    printf '\n'
    spec_summary
    printf '\n'
    log_ok "Proyecto listo. Ahora: $0 run"
}

# ==============================================================================
#  ARRANQUE
# ==============================================================================
case "$CMD" in
    status) cmd_status; exit $? ;;
    stop)   cmd_stop;   exit $? ;;
    follow) exec tail -n 60 -f "$LOG_FILE" ;;
    spec)   cmd_spec;   exit 0 ;;
    reset)  cmd_reset "${1:-FAILED}"; exit $? ;;
esac

# --- Daemonize ----------------------------------------------------------------
if [ "$BACKGROUND" -eq 1 ] && [ "${HARNESS_DAEMONIZED:-0}" -ne 1 ]; then
    pid=$(read_pid)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        die "Ya hay una instancia corriendo (PID $pid). Usá '$0 stop'."
    fi
    case "$CMD" in
        init|build) die "'$CMD' necesita interacción. Corré '$0 run -b' después del init." ;;
    esac
    set -m
    HARNESS_DAEMONIZED=1 nohup "$SELF" "$CMD" >> "$LOG_FILE" 2>&1 < /dev/null &
    dpid=$!
    set +m
    sleep 1
    printf 'Lanzado en background (PID %s)\n  log:    %s follow\n  frenar: %s stop\n' \
        "$dpid" "$0" "$0"
    exit 0
fi
[ "${HARNESS_DAEMONIZED:-0}" -eq 1 ] && DUP_LOG=0

# --- Lock + traps + tmp -------------------------------------------------------
case "$CMD" in
    doctor|setup-model|tune-ctx) ;;
    *)
        acquire_lock "$LOCK_PATH" \
            || die "Otra instancia tiene el lock ($LOCK_PATH). Usá '$0 status'."
        printf '%s\n' "$$" > "$PID_FILE"
        ;;
esac

HARNESS_TMP=$(mktemp -d "$STATE_DIR/tmp/run.XXXXXX" 2>/dev/null) \
    || HARNESS_TMP=$(mktemp -d "${TMPDIR:-/tmp}/pi-harness.XXXXXX")

cleanup() {
    local rc=$?
    trap - EXIT INT TERM HUP
    kill_tree "$CHILD_PID" TERM
    kill_tree "$WATCHDOG_PID" KILL
    if [ -n "$CURRENT_IDX" ] && [ -f "$SPEC_FILE" ]; then
        [ "$(spec_status_of "$CURRENT_IDX")" = "IN_PROGRESS" ] \
            && spec_set_status "$CURRENT_IDX" "PENDING" 2>/dev/null
    fi
    [ "${KEEP_TMP:-0}" -eq 1 ] || { [ -n "$HARNESS_TMP" ] && rm -rf "$HARNESS_TMP"; }
    release_lock
    [ -f "$PID_FILE" ] && [ "$(cat "$PID_FILE" 2>/dev/null)" = "$$" ] && rm -f "$PID_FILE"
    exit "$rc"
}
trap cleanup EXIT
install_signal_traps

ensure_node_in_path || true
have "$PI_BIN" || die "No encuentro 'pi' en el PATH. Probá: npm i -g @earendil-works/pi-coding-agent"

case "$CMD" in
    doctor)      cmd_doctor; exit $? ;;
    setup-model) cmd_setup_model "${1:-}"; exit $? ;;
    tune-ctx)    [ -n "${1:-}" ] || die "Uso: $0 tune-ctx <modelo> [num_ctx]"
                 ollama_tune_context "$1" "${2:-32768}"; exit $? ;;
    scaffold)    bootstrap_scaffold; exit $? ;;
    init)        cmd_init; exit $? ;;
    run)         cmd_run; exit $? ;;
    build)       cmd_init && cmd_run; exit $? ;;
    *)           usage; exit 2 ;;
esac
