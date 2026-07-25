#!/usr/bin/env bash
# ==============================================================================
#  lib/ollama.sh — detección de Ollama, registro del provider en pi, y VRAM
# ------------------------------------------------------------------------------
#  pi lee los providers custom de ~/.pi/agent/models.json (global, no hay
#  versión por proyecto). Este módulo hace un MERGE no destructivo ahí: nunca
#  pisa otros providers, y siempre deja un backup antes de escribir.
# ==============================================================================

PI_MODELS_JSON="${PI_MODELS_JSON:-$HOME/.pi/agent/models.json}"

# --- Disponibilidad -----------------------------------------------------------
ollama_api_up() {
    have curl || return 0          # sin curl no podemos chequear: asumimos que sí
    curl -fsS --max-time 3 "$OLLAMA_URL/api/tags" >/dev/null 2>&1
}

ollama_wait_up() {
    local deadline=$((SECONDS + ${1:-60}))
    while [ "$SECONDS" -lt "$deadline" ]; do
        [ "$STOP_REQUESTED" -eq 0 ] || return 1
        ollama_api_up && return 0
        nap 2
    done
    return 1
}

# Modelos que Ollama tiene descargados, uno por línea.
ollama_local_models() {
    if have curl; then
        curl -fsS --max-time 5 "$OLLAMA_URL/api/tags" 2>/dev/null \
            | tr ',' '\n' | sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
    elif have ollama; then
        ollama list 2>/dev/null | awk 'NR>1 {print $1}'
    fi
}

# Ollama normaliza los tags: un modelo creado como "foo" se lista como
# "foo:latest". Comparar literal daba falsos negativos justo con los modelos
# derivados que crea `tune-ctx`.
ollama_has_model() {
    local want="$1"
    case "$want" in *:*) ;; *) want="$want:latest" ;; esac
    ollama_local_models | sed 's/^\([^:]*\)$/\1:latest/' | grep -qx -- "$want"
}

# --- Arranque del servidor ----------------------------------------------------
# En macOS no hay systemd. Ollama corre como app, como `brew services`, o suelto.
ollama_start() {
    ollama_api_up && return 0
    if [ -n "${OLLAMA_START_CMD:-}" ]; then
        log_info "Arrancando Ollama: $OLLAMA_START_CMD"
        bash -c "$OLLAMA_START_CMD" >> "$LOG_FILE" 2>&1 || true
    elif have brew && brew services list 2>/dev/null | grep -q '^ollama'; then
        log_info "brew services start ollama"
        brew services start ollama >> "$LOG_FILE" 2>&1 || true
    elif have ollama; then
        log_info "Levantando 'ollama serve' en background"
        # OLLAMA_CONTEXT_LENGTH sólo tiene efecto si lo ve el SERVIDOR al arrancar.
        set -m
        OLLAMA_CONTEXT_LENGTH="${OLLAMA_CONTEXT_LENGTH:-32768}" \
            nohup ollama serve >> "$LOG_FILE" 2>&1 &
        set +m
    else
        return 1
    fi
    ollama_wait_up 60
}

# --- VRAM ---------------------------------------------------------------------
# Lo que realmente querés entre features es DESCARGAR el modelo de VRAM, no
# reiniciar el daemon. keep_alive:0 hace exactamente eso, sin sudo y sin cortar
# el servicio.
ollama_unload() {
    local m="${1:-$OLLAMA_MODEL}"
    [ -n "$m" ] || return 1
    if have curl && curl -fsS --max-time 15 "$OLLAMA_URL/api/generate" \
            -d "{\"model\":\"$m\",\"keep_alive\":0}" >/dev/null 2>&1; then
        return 0
    fi
    if have ollama && ollama stop "$m" >/dev/null 2>&1; then
        return 0
    fi
    return 1
}

ollama_restart() {
    if [ -n "${OLLAMA_RESTART_CMD:-}" ]; then
        log_info "Reiniciando Ollama: $OLLAMA_RESTART_CMD"
        bash -c "$OLLAMA_RESTART_CMD" >> "$LOG_FILE" 2>&1 || return 1
    elif have brew && brew services list 2>/dev/null | grep -q '^ollama'; then
        log_info "brew services restart ollama"
        brew services restart ollama >> "$LOG_FILE" 2>&1 || return 1
    elif have systemctl && systemctl cat -- ollama >/dev/null 2>&1; then
        log_info "systemctl restart ollama"
        { systemctl --user restart ollama || sudo -n systemctl restart ollama; } \
            >> "$LOG_FILE" 2>&1 || return 1
    else
        return 1
    fi
    ollama_wait_up 90
}

free_vram() {
    case "${VRAM_STRATEGY:-auto}" in
        none)    return 0 ;;
        unload)  ollama_unload || log_warn "No pude descargar el modelo de VRAM." ;;
        restart) ollama_restart || log_warn "No pude reiniciar Ollama." ;;
        auto|*)
            if ollama_unload; then
                log_dim "VRAM liberada (keep_alive=0)"
            else
                log_dim "No pude descargar el modelo; intento reiniciar el servicio…"
                ollama_restart || log_warn "Tampoco pude reiniciar Ollama. Sigo igual."
            fi
            ;;
    esac
    return 0
}

# --- Registro del provider en pi ----------------------------------------------
# Escribe/actualiza SOLO el bloque providers.<name> de models.json.
# Merge con jq; si no hay jq, con python3; si no hay ninguno, error claro.
#
# `compat` es obligatorio para Ollama: muchos modelos locales no entienden el
# rol `developer` ni `reasoning_effort`, y pi los manda por defecto en modelos
# con reasoning. Sin esto vas a comer 400s del server.
register_ollama_provider() {
    local provider="$1" base_url="$2" model_id="$3" ctx="$4" maxout="$5" reasoning="$6"
    local dir tmp backup

    dir=$(dirname "$PI_MODELS_JSON")
    mkdir -p "$dir" 2>/dev/null || true
    [ -f "$PI_MODELS_JSON" ] || printf '{"providers":{}}\n' > "$PI_MODELS_JSON"

    # Un models.json corrupto rompe TODOS los providers de pi, no sólo el nuestro.
    if have jq && ! jq -e . "$PI_MODELS_JSON" >/dev/null 2>&1; then
        log_err "$PI_MODELS_JSON no es JSON válido. No lo toco."
        return 1
    fi

    backup="${PI_MODELS_JSON}.bak.$(date +%Y%m%d%H%M%S)"
    cp "$PI_MODELS_JSON" "$backup" 2>/dev/null || true
    tmp="${PI_MODELS_JSON}.tmp.$$"

    if have jq; then
        jq --arg p "$provider" --arg url "$base_url" --arg id "$model_id" \
           --argjson ctx "$ctx" --argjson mx "$maxout" --argjson rz "$reasoning" '
            .providers //= {}
            | .providers[$p] //= {}
            | .providers[$p].baseUrl = $url
            | .providers[$p].api     = "openai-completions"
            | .providers[$p].apiKey  = "ollama"
            | .providers[$p].compat  = {
                  "supportsDeveloperRole": false,
                  "supportsReasoningEffort": false
              }
            | .providers[$p].models //= []
            | .providers[$p].models =
                ( [ .providers[$p].models[] | select(.id != $id) ]
                  + [ { "id": $id, "input": ["text"], "reasoning": $rz,
                        "contextWindow": $ctx, "maxTokens": $mx,
                        "cost": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0} } ] )
           ' "$PI_MODELS_JSON" > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
    elif have python3; then
        PROV="$provider" URL="$base_url" MID="$model_id" CTX="$ctx" MX="$maxout" RZ="$reasoning" \
        python3 - "$PI_MODELS_JSON" "$tmp" <<'PY' || { rm -f "$tmp"; return 1; }
import json, os, sys
src, dst = sys.argv[1], sys.argv[2]
with open(src) as f:
    data = json.load(f)
p = os.environ["PROV"]
prov = data.setdefault("providers", {}).setdefault(p, {})
prov["baseUrl"] = os.environ["URL"]
prov["api"] = "openai-completions"
prov["apiKey"] = "ollama"
prov["compat"] = {"supportsDeveloperRole": False, "supportsReasoningEffort": False}
mid = os.environ["MID"]
models = [m for m in prov.get("models", []) if m.get("id") != mid]
models.append({
    "id": mid, "input": ["text"],
    "reasoning": os.environ["RZ"] == "true",
    "contextWindow": int(os.environ["CTX"]), "maxTokens": int(os.environ["MX"]),
    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
})
prov["models"] = models
with open(dst, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
    else
        log_err "Necesito jq o python3 para editar $PI_MODELS_JSON sin romperlo."
        return 1
    fi

    [ -s "$tmp" ] || { rm -f "$tmp"; return 1; }
    mv "$tmp" "$PI_MODELS_JSON" || return 1
    log_dim "backup: $backup"
    return 0
}

# ¿pi ve realmente el modelo? Es la única verificación que vale.
pi_sees_model() {
    local provider="$1" model_id="$2"
    "$PI_BIN" --list-models 2>/dev/null \
        | sed 's/\x1b\[[0-9;]*[A-Za-z]//g' \
        | awk -v p="$provider" -v m="$model_id" '$1 == p && $2 == m {found=1} END{exit !found}'
}

# --- num_ctx: el gotcha #1 de Ollama ------------------------------------------
# `contextWindow` en models.json sólo le dice a pi qué asumir. NO cambia el
# num_ctx real de Ollama, que por defecto es chico (2k-4k según versión). Un
# agente de coding con 4k de contexto trunca el prompt y alucina.
#
# Se arregla de dos formas:
#   a) OLLAMA_CONTEXT_LENGTH=32768 en el entorno del SERVIDOR (no del cliente)
#   b) un modelo derivado con `PARAMETER num_ctx` fijo  <- esto hace la función
ollama_tune_context() {
    local base="$1" ctx="${2:-32768}" derived tmpfile
    have ollama || { log_err "Necesito la CLI de ollama para esto."; return 1; }
    derived="${base%%:*}-pi${ctx}"
    tmpfile="$HARNESS_TMP/Modelfile.$$"
    {
        printf 'FROM %s\n' "$base"
        printf 'PARAMETER num_ctx %s\n' "$ctx"
    } > "$tmpfile"
    log_step "Creando modelo derivado '$derived' (num_ctx=$ctx) desde '$base'…"
    if ollama create "$derived" -f "$tmpfile" >> "$LOG_FILE" 2>&1; then
        log_ok "Listo: $derived"
        printf '%s\n' "$derived"
        return 0
    fi
    log_err "Falló 'ollama create'. Mirá $LOG_FILE"
    return 1
}

# --- Lectura del contexto real ------------------------------------------------
# /api/show NO devuelve el num_ctx como campo JSON: lo mete adentro de
# "parameters", que es UN STRING con el volcado del Modelfile:
#
#   "parameters": "top_k    64\ntop_p    0.95\nnum_ctx    131072\n..."
#
# O sea que buscar la clave "num_ctx": <n> en el JSON no matchea nunca, y un
# modelo bien configurado se reporta como si no lo estuviera. Hay que parsear
# el string.
ollama_show() {
    have curl || return 1
    curl -fsS --max-time 8 "$OLLAMA_URL/api/show" -d "{\"model\":\"$1\"}" 2>/dev/null
}

# num_ctx declarado explícitamente en el Modelfile. Es el que manda al servir.
ollama_effective_ctx() {
    local m="$1" params v
    if have jq; then
        params=$(ollama_show "$m" | jq -r '.parameters // ""' 2>/dev/null)
    else
        params=$(ollama_show "$m" | sed -n 's/.*"parameters"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
    fi
    [ -n "$params" ] || return 1
    # Sirve tanto para el string con \n literales como ya expandido.
    v=$(printf '%s' "$params" | sed 's/\\n/\n/g' \
        | awk '$1 == "num_ctx" { print $2; exit }')
    [ -n "$v" ] && { printf '%s' "$v"; return 0; }
    return 1
}

# Techo arquitectónico del modelo (model_info.<arch>.context_length). NO es lo
# que se sirve: es lo máximo que el modelo soporta.
ollama_arch_ctx() {
    local m="$1" v
    if have jq; then
        v=$(ollama_show "$m" | jq -r '.model_info // {} | to_entries
            | map(select(.key | endswith("context_length"))) | .[0].value // empty' 2>/dev/null)
    else
        v=$(ollama_show "$m" | tr ',' '\n' \
            | sed -n 's/.*context_length"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' | head -1)
    fi
    [ -n "$v" ] && { printf '%s' "$v"; return 0; }
    return 1
}

# ¿El servidor tiene un default global? Sólo lo ve el proceso de ollama, así
# que esto es lo mejor que podemos hacer sin leer /proc del daemon.
ollama_server_ctx_default() {
    [ -n "${OLLAMA_CONTEXT_LENGTH:-}" ] && { printf '%s' "$OLLAMA_CONTEXT_LENGTH"; return 0; }
    return 1
}

# Capacidades declaradas por el modelo ("tools", "thinking", "vision"…).
ollama_capabilities() {
    if have jq; then
        ollama_show "$1" | jq -r '.capabilities // [] | join(",")' 2>/dev/null
    else
        ollama_show "$1" | tr ',' '\n' | sed -n 's/.*"\(tools\|thinking\|vision\)".*/\1/p' | tr '\n' ','
    fi
}

ollama_declares_tools() {
    case ",$(ollama_capabilities "$1")," in *,tools,*) return 0 ;; *) return 1 ;; esac
}

# La prueba que de verdad importa: ¿el modelo emite un TOOL CALL estructurado,
# o escupe el JSON de la llamada como texto y se queda tan pancho?
#
# Declarar "tools" en las capabilities no alcanza: viene de la plantilla, no del
# modelo. qwen2.5-coder:7b declara tools y sin embargo contesta
#   {"name": "write", "arguments": {...}}
# como texto plano. pi nunca ve una tool call, no se escribe nada, y el exit
# code es 0. Sin esta prueba te enterás recién después de una corrida entera.
pi_probe_tool_calling() {
    local provider="$1" model="$2" dir out calls
    dir=$(mktemp -d "${TMPDIR:-/tmp}/pi-probe.XXXXXX") || return 2
    out="$dir/probe.json"
    ( cd "$dir" && "$PI_BIN" -p --mode json --approve \
        --provider "$provider" --model "$model" --thinking off --no-session \
        "Escribi un archivo hola.txt con el texto HOLA usando la herramienta de escritura." \
        > "$out" 2>&1 )
    if have jq; then
        calls=$(jq -r 'select(.type=="tool_execution_end")|.toolName' "$out" 2>/dev/null | wc -l | tr -d ' ')
    else
        calls=$(grep -o '"tool_execution_end"' "$out" 2>/dev/null | wc -l | tr -d ' ')
    fi
    local wrote=1; [ -f "$dir/hola.txt" ] || wrote=0
    rm -rf "$dir"
    [ "${calls:-0}" -gt 0 ] && [ "$wrote" -eq 1 ] && return 0
    return 1
}
