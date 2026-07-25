#!/usr/bin/env bash
# ==============================================================================
#  lib/bootstrap.sh — la fase que le faltaba al orquestador de aider
# ------------------------------------------------------------------------------
#  "Codear desde cero" no falla por el loop de features: falla porque nadie
#  define QUÉ construir ni deja el terreno preparado. Un modelo local al que le
#  tirás "hacé una app de notas" y un repo vacío improvisa una estructura
#  distinta en cada intento y nunca converge.
#
#  Acá se arregla en tres pasos separados, cada uno verificable:
#
#    1. interview  — le sacamos al humano lo que sólo el humano sabe
#    2. docs       — pi convierte eso en AGENTS.md + PROJECT_SPEC.md, y el
#                    harness VALIDA el spec y le devuelve los errores hasta que
#                    salga parseable (los modelos chicos se comen campos)
#    3. scaffold   — pi crea el esqueleto + el runner de tests + un test que
#                    pasa. Sin esto, la primera feature no tiene contra qué
#                    verificarse y todo el loop se vuelve decorativo.
# ==============================================================================

BRIEF_FILE="${BRIEF_FILE:-.harness/brief.md}"

# --- 1. Entrevista ------------------------------------------------------------
_ask() {
    local prompt="$1" default="$2" ans
    if [ -n "$default" ]; then
        printf '%s%s%s [%s]: ' "$C_CYN" "$prompt" "$C_RESET" "$default" > /dev/tty
    else
        printf '%s%s%s: ' "$C_CYN" "$prompt" "$C_RESET" > /dev/tty
    fi
    IFS= read -r ans < /dev/tty || ans=""
    [ -n "$ans" ] || ans="$default"
    printf '%s' "$ans"
}

# Multilínea: se corta con una línea vacía.
_ask_multi() {
    local prompt="$1" line out=""
    printf '%s%s%s %s(una por línea, ENTER vacío para terminar)%s\n' \
        "$C_CYN" "$prompt" "$C_RESET" "$C_DIM" "$C_RESET" > /dev/tty
    while IFS= read -r line < /dev/tty; do
        [ -n "$line" ] || break
        out="${out}- ${line}
"
    done
    printf '%s' "$out"
}

bootstrap_interview() {
    [ -e /dev/tty ] || { log_err "No hay TTY. Usá --brief <archivo> o --idea \"...\"."; return 1; }

    printf '\n%s┌─ Definamos el proyecto ────────────────────────────────%s\n' "$C_CYN" "$C_RESET" > /dev/tty
    printf '%s│ Lo que pongas acá es lo único que el modelo no puede%s\n' "$C_DIM" "$C_RESET" > /dev/tty
    printf '%s│ inventar. Sé concreto; después no se cambia solo.%s\n' "$C_DIM" "$C_RESET" > /dev/tty
    printf '%s└────────────────────────────────────────────────────────%s\n\n' "$C_CYN" "$C_RESET" > /dev/tty

    local name desc stack testfw features constraints nonfeatures target
    name=$(_ask "Nombre del proyecto" "$(basename "$PWD")")
    desc=$(_ask "¿Qué hace? (una o dos frases)" "")
    while [ -z "$desc" ]; do
        printf '%s  Sin esto no hay proyecto. Escribí algo.%s\n' "$C_YLW" "$C_RESET" > /dev/tty
        desc=$(_ask "¿Qué hace?" "")
    done
    stack=$(_ask "Stack / lenguaje (ej: python+fastapi, typescript+node, go)" "python")
    testfw=$(_ask "Framework de tests" "$(_default_testfw "$stack")")
    target=$(_ask "¿Cuántas features querés en el backlog?" "${FEATURE_TARGET:-10}")

    printf '\n' > /dev/tty
    features=$(_ask_multi "Funcionalidades que SÍ o SÍ tienen que estar")
    printf '\n' > /dev/tty
    nonfeatures=$(_ask_multi "Cosas que explícitamente NO querés (fuera de alcance)")
    printf '\n' > /dev/tty
    constraints=$(_ask "Restricciones técnicas (deps prohibidas, versiones, etc.)" "ninguna")

    mkdir -p "$(dirname "$BRIEF_FILE")"
    cat > "$BRIEF_FILE" <<EOF
# Brief: $name

## Qué es
$desc

## Stack
- Lenguaje/framework: $stack
- Tests: $testfw
- Restricciones: $constraints

## Debe tener
${features:-- (no se especificaron; inferir del propósito)}

## Fuera de alcance
${nonfeatures:-- (nada declarado)}

## Tamaño del backlog
Apuntar a ~$target features.
EOF

    FEATURE_TARGET="$target"
    log_ok "Brief guardado en $BRIEF_FILE"
    return 0
}

_default_testfw() {
    case "$1" in
        *python*|*fastapi*|*django*|*flask*) printf 'pytest' ;;
        *typescript*|*node*|*js*|*react*)    printf 'vitest' ;;
        *go*)                                printf 'go test' ;;
        *rust*)                              printf 'cargo test' ;;
        *)                                   printf 'el idiomático del stack' ;;
    esac
}

# Brief no interactivo, a partir de una frase suelta.
bootstrap_brief_from_idea() {
    local idea="$1"
    mkdir -p "$(dirname "$BRIEF_FILE")"
    cat > "$BRIEF_FILE" <<EOF
# Brief

## Qué es
$idea

## Stack
- Lenguaje/framework: elegir el más idiomático para lo pedido
- Tests: el framework estándar de ese stack
- Restricciones: preferir librerías estándar; pocas dependencias

## Debe tener
- (inferir del propósito)

## Fuera de alcance
- (nada declarado)

## Tamaño del backlog
Apuntar a ~${FEATURE_TARGET:-10} features.
EOF
    log_ok "Brief generado en $BRIEF_FILE"
}

# --- 2. AGENTS.md + PROJECT_SPEC.md ------------------------------------------
#  Van en DOS llamadas separadas, una por archivo.
#
#  En un solo turno ("escribí estos dos archivos") los modelos locales chicos
#  se quedan a mitad de camino: escriben AGENTS.md, explican en prosa lo que
#  iría en PROJECT_SPEC.md, y terminan el turno. Cero errores, cero archivos.
#  Un archivo por llamada le baja la complejidad a cada turno y le da al
#  harness un entregable único y verificable por vez.

_prompt_agents() {
    cat <<EOF
Sos el arquitecto de un proyecto nuevo. El repositorio está VACÍO.

Leé el brief adjunto y escribí UN SOLO archivo con la herramienta de escritura:
AGENTS.md. Nada más. No escribas código, no hagas preguntas, no expliques.

AGENTS.md son las reglas permanentes para quien programe este repo. Corto y
accionable, 60 líneas como máximo. Incluí:
- Qué es el proyecto, en dos frases.
- Stack elegido y versiones.
- Estructura de directorios concreta (rutas reales).
- Convenciones: nombres, manejo de errores, estilo.
- Cómo se corren los tests (el comando exacto).
- Reglas duras: qué NO tocar, qué dependencias están prohibidas.

Terminá apenas hayas escrito AGENTS.md.
EOF
}

_prompt_spec() {
    cat <<EOF
El proyecto ya tiene su AGENTS.md (está cargado). Ahora escribí UN SOLO archivo
con la herramienta de escritura: $SPEC_FILE. Nada más.

Es el backlog. Apuntá a ~${FEATURE_TARGET:-10} features ordenadas por
dependencia: las primeras no pueden depender de las últimas. Cada feature tiene
que ser implementable en un solo paso y verificable con un test.

Usá EXACTAMENTE este formato. Los campos van sin indentación, uno por línea:

## feature: Nombre corto en imperativo
id: F001
status: PENDING
depends: none
acceptance:
  - criterio observable y verificable
  - otro criterio
notes: |
  Detalle técnico: qué archivos toca, qué firma tienen las funciones.

## feature: La siguiente
id: F002
status: PENDING
depends: F001
acceptance:
  - ...
notes: |
  ...

Reglas del formato, sin excepción:
- Toda feature arranca en status: PENDING.
- Los id son F001, F002, F003… correlativos y únicos.
- 'depends' es 'none' o una lista de ids ya definidos ARRIBA.
- 'acceptance' siempre existe y tiene al menos un ítem con guión.
- La primera feature NO es el scaffolding: el andamiaje ya va a existir.

Terminá apenas hayas escrito $SPEC_FILE.
EOF
}

_bootstrap_agents() {
    local attempt=0 rc prompt
    while [ "$attempt" -lt "${BOOTSTRAP_RETRIES:-3}" ]; do
        attempt=$((attempt + 1))
        [ "$STOP_REQUESTED" -eq 0 ] || return 1
        log_step "Escribiendo $AGENTS_FILE (intento $attempt/${BOOTSTRAP_RETRIES:-3})…"

        prompt=$(_prompt_agents)
        [ "$attempt" -gt 1 ] && prompt="$prompt

## Atención
En el intento anterior no escribiste el archivo. Usá la herramienta de
escritura para crear $AGENTS_FILE ahora mismo."

        free_vram
        pi_run "agents-$attempt" "$BOOTSTRAP_TIMEOUT" "$prompt" "$BRIEF_FILE"
        rc=$?
        pi_log_run_summary "$rc"
        [ "$STOP_REQUESTED" -eq 0 ] || return 1

        if [ -s "$AGENTS_FILE" ]; then
            log_ok "$AGENTS_FILE escrito ($(wc -l < "$AGENTS_FILE" | tr -d ' ') líneas)."
            return 0
        fi
        log_warn "No apareció $AGENTS_FILE."
    done
    log_err "No conseguí que el modelo escribiera $AGENTS_FILE."
    return 1
}

_bootstrap_spec() {
    local attempt=0 rc prompt errors=""
    while [ "$attempt" -lt "${BOOTSTRAP_RETRIES:-3}" ]; do
        attempt=$((attempt + 1))
        [ "$STOP_REQUESTED" -eq 0 ] || return 1
        log_step "Escribiendo $SPEC_FILE (intento $attempt/${BOOTSTRAP_RETRIES:-3})…"

        prompt=$(_prompt_spec)
        if [ -n "$errors" ]; then
            prompt="$prompt

## CORRECCIÓN OBLIGATORIA
El $SPEC_FILE que escribiste antes no parsea. Errores exactos:

$errors

Reescribilo completo y bien formado."
        fi

        free_vram
        pi_run "spec-$attempt" "$BOOTSTRAP_TIMEOUT" "$prompt" "$BRIEF_FILE" "$AGENTS_FILE"
        rc=$?
        pi_log_run_summary "$rc"
        [ "$STOP_REQUESTED" -eq 0 ] || return 1

        if [ ! -f "$SPEC_FILE" ]; then
            log_warn "No apareció $SPEC_FILE."
            errors="No creaste el archivo $SPEC_FILE. Creálo con la herramienta de escritura."
            continue
        fi

        errors=$(spec_validate "$SPEC_FILE")
        if [ -z "$errors" ]; then
            log_ok "$SPEC_FILE válido: $(spec_count) features."
            return 0
        fi
        log_warn "El spec no valida. Se lo devuelvo al modelo:"
        printf '%s\n' "$errors" | head -12 | while IFS= read -r e; do log_dim "$e"; done
    done
    log_err "No conseguí un $SPEC_FILE válido en ${BOOTSTRAP_RETRIES:-3} intentos."
    log_dim "Editalo a mano y volvé a correr, o probá con un modelo más grande."
    return 1
}

bootstrap_generate_docs() {
    _bootstrap_agents || return 1
    _bootstrap_spec   || return 1
    return 0
}

# --- 3. Andamiaje -------------------------------------------------------------
_prompt_scaffold() {
    cat <<EOF
Preparás el andamiaje del proyecto. Todavía NO implementás features.

Leé AGENTS.md (ya está en el repo) y hacé exactamente esto:

1. Creá la estructura de directorios que declara AGENTS.md.
2. Creá el archivo de manifiesto del stack (package.json, pyproject.toml,
   go.mod, Cargo.toml, el que corresponda) con el runner de tests configurado.
3. Creá UN test mínimo que pase, del estilo "el paquete importa". Nada de
   testear features que todavía no existen.
4. Creá los puntos de entrada vacíos pero válidos (que importen sin explotar).
5. Si el stack necesita instalar dependencias, instalalas con la herramienta
   bash ahora. Si usás un entorno virtual, dejalo en ./.venv del proyecto.
6. Corré la suite de tests con la herramienta bash y arreglá lo que falle,
   hasta que pase en verde.
7. IMPORTANTE: escribí en $TEST_CMD_FILE una sola línea con el comando EXACTO
   que acabás de correr para los tests, tal cual, sin adornos ni markdown.
   Ese archivo es el que va a usar el harness para verificar cada feature.
   Si usaste un venv, poné la ruta del intérprete del venv en el comando.
   Ejemplos válidos:
       python3 -m unittest discover -s tests
       .venv/bin/pytest -q
       npm test --silent

Criterio de terminado: el comando de tests corre, pasa, y quedó escrito en
$TEST_CMD_FILE. Sin eso, el resto del proyecto no se puede verificar.

No implementes ninguna feature del backlog. No escribas PROJECT_SPEC.md.
EOF
}

bootstrap_scaffold() {
    local attempt=0 cmd rc

    while [ "$attempt" -lt "${BOOTSTRAP_RETRIES:-3}" ]; do
        attempt=$((attempt + 1))
        [ "$STOP_REQUESTED" -eq 0 ] || return 1
        log_step "Armando el andamiaje (intento $attempt/${BOOTSTRAP_RETRIES:-3})…"

        local prompt
        prompt=$(_prompt_scaffold)
        if [ "$attempt" -gt 1 ]; then
            if [ -z "$(declared_test_command 2>/dev/null)" ]; then
                prompt="$prompt

## Falta lo más importante
No escribiste $TEST_CMD_FILE. Escribilo ahora: una línea, el comando de tests
y nada más."
            fi
            if [ -s "$VERIFY_OUTPUT" ]; then
                prompt="$prompt

## El intento anterior no dejó los tests en verde
Comando: $cmd

\`\`\`
$(verification_excerpt "$VERIFY_OUTPUT" 40)
\`\`\`

Arreglá eso puntualmente. Si el comando en sí estaba mal (por ejemplo apunta a
un pytest que no está instalado), corregí $TEST_CMD_FILE."
            fi
        fi

        free_vram
        pi_run "scaffold-$attempt" "$BOOTSTRAP_TIMEOUT" "$prompt" "$AGENTS_FILE"
        rc=$?
        pi_log_run_summary "$rc"

        [ "$STOP_REQUESTED" -eq 0 ] || return 1

        if ! pi_did_work; then
            log_warn "El modelo no escribió ningún archivo. Reintento."
            continue
        fi

        cmd=$(resolve_test_command "" || true)
        if [ -z "$cmd" ]; then
            log_warn "No hay comando de tests: ni declarado ni detectable."
            continue
        fi
        if [ -n "$(declared_test_command 2>/dev/null)" ]; then
            log_dim "comando declarado por el agente en $TEST_CMD_FILE"
        else
            log_warn "El agente no declaró el comando; uso el autodetectado."
        fi

        log_info "Verificando el andamiaje: $cmd"
        run_verification "$cmd" "$TEST_TIMEOUT_S" "$HARNESS_TMP/scaffold_test.log"
        rc=$?
        log_tail "$HARNESS_TMP/scaffold_test.log" 15

        if [ "$rc" -eq 0 ]; then
            log_ok "Andamiaje verde con: $cmd"
            TEST_COMMAND_RESOLVED="$cmd"
            git_commit_feature "F000" "andamiaje del proyecto" "COMPLETED"
            return 0
        fi
        log_warn "El andamiaje no pasa los tests (código $rc)."
    done

    log_err "No logré dejar el andamiaje en verde."
    return 1
}
