#!/usr/bin/env bash
# ==============================================================================
#  lib/verify.sh — cómo se decide si una feature "está hecha"
# ------------------------------------------------------------------------------
#  Sin verificación automática esto no es un harness, es un generador de texto
#  optimista. La precedencia del comando es:
#
#    1. $TEST_COMMAND del entorno / harness.conf   (manda siempre)
#    2. campo `test:` del bloque de la feature      (por feature)
#    3. .harness/test_cmd, que ESCRIBE EL AGENTE    (la fuente de verdad)
#    4. autodetección según el tipo de proyecto     (último recurso)
#
#  El (3) existe por un choque real: el agente armó el proyecto con `unittest`
#  y lo documentó, pero la autodetección vio un tests/ + pyproject.toml y
#  dedujo `pytest`, que no estaba instalado. El harness marcaba todo en rojo
#  por un comando que nadie había elegido. Quien arma el andamiaje sabe cómo
#  se corren sus tests; el harness no tiene por qué adivinarlo.
# ==============================================================================

TEST_CMD_FILE="${TEST_CMD_FILE:-.harness/test_cmd}"

# Lo que el agente declaró en el andamiaje.
declared_test_command() {
    [ -s "$TEST_CMD_FILE" ] || return 1
    # Primera línea no vacía ni comentada.
    awk 'NF && $0 !~ /^[[:space:]]*#/ { sub(/^[[:space:]]+/, ""); sub(/[[:space:]]+$/, ""); print; exit }' \
        "$TEST_CMD_FILE"
}

detect_test_command() {
    # Un venv del proyecto gana siempre: si el agente creó .venv e instaló ahí,
    # el python3 del sistema no tiene nada de eso.
    local v
    for v in .venv venv env; do
        if [ -x "$v/bin/pytest" ];  then printf '%s/bin/pytest -q' "$v"; return 0; fi
        if [ -x "$v/bin/python" ] && [ -d tests ]; then
            printf '%s/bin/python -m pytest -q' "$v"; return 0
        fi
    done

    if [ -f package.json ] && grep -qE '"test"[[:space:]]*:' package.json 2>/dev/null; then
        ensure_node_in_path || true
        if   [ -f pnpm-lock.yaml ]; then printf 'pnpm test'
        elif [ -f yarn.lock ];      then printf 'yarn test'
        elif [ -f bun.lockb ];      then printf 'bun test'
        else                             printf 'npm test --silent'; fi
        return 0
    fi
    [ -f uv.lock ]     && { printf 'uv run pytest -q';     return 0; }
    [ -f poetry.lock ] && { printf 'poetry run pytest -q'; return 0; }
    if [ -f pyproject.toml ] || [ -f pytest.ini ] || [ -f setup.cfg ] || [ -d tests ]; then
        have pytest && { printf 'pytest -q'; return 0; }
        # `python3 -m pytest` sólo si pytest está REALMENTE importable; si no,
        # devolvemos un comando que falla siempre y culpa al código ajeno.
        if have python3 && python3 -c 'import pytest' >/dev/null 2>&1; then
            printf 'python3 -m pytest -q'; return 0
        fi
        [ -d tests ] && have python3 && { printf 'python3 -m unittest discover -s tests'; return 0; }
    fi
    [ -f go.mod ]     && { printf 'go test ./...';  return 0; }
    [ -f Cargo.toml ] && { printf 'cargo test';     return 0; }
    [ -f pom.xml ]    && { printf 'mvn -q -B test'; return 0; }
    { [ -f build.gradle ] || [ -f build.gradle.kts ]; } && { printf './gradlew test'; return 0; }
    [ -f mix.exs ]       && { printf 'mix test';      return 0; }
    [ -f composer.json ] && { printf 'composer test'; return 0; }
    if [ -f Makefile ] || [ -f makefile ]; then
        grep -qE '^test:' Makefile makefile 2>/dev/null && { printf 'make test'; return 0; }
    fi
    return 1
}

# Comando de verificación efectivo para la feature N.
resolve_test_command() {
    local idx="$1" cmd
    if [ -n "${TEST_COMMAND:-}" ]; then printf '%s' "$TEST_COMMAND"; return 0; fi
    if [ -n "$idx" ]; then
        cmd=$(spec_field_of "$idx" test)
        if [ -n "$cmd" ]; then printf '%s' "$cmd"; return 0; fi
    fi
    cmd=$(declared_test_command) && [ -n "$cmd" ] && { printf '%s' "$cmd"; return 0; }
    detect_test_command || return 1
}

# --- Ejecución ----------------------------------------------------------------
VERIFY_OUTPUT=""        # archivo con la salida de la última verificación
VERIFY_CODE=0

# run_verification <cmd> <timeout_secs> <outfile>
#   0   = verde
#   124 = se colgó
#   127 = el comando no existe  -> problema de ENTORNO, no de código
run_verification() {
    local cmd="$1" secs="$2" out="$3"
    VERIFY_OUTPUT="$out"
    : > "$out"
    # `bash -lc` para que el login shell traiga nvm/pyenv/asdf al PATH.
    run_supervised "$secs" "$out" -- bash -lc "$cmd"
    VERIFY_CODE=$?
    return "$VERIFY_CODE"
}

# Recorta la salida de los tests para devolvérsela al modelo. Mandar 3000
# líneas de stacktrace a un modelo local es la forma más rápida de reventar
# su ventana de contexto y que pierda el enunciado original.
verification_excerpt() {
    local out="${1:-$VERIFY_OUTPUT}" max="${2:-${TEST_EXCERPT_LINES:-60}}"
    [ -s "$out" ] || return 1
    local total
    total=$(wc -l < "$out" | tr -d ' ')
    if [ "$total" -le "$max" ]; then
        cat "$out"
    else
        # La cola suele tener el resumen ("3 failed, 10 passed") y el primer
        # error suele estar arriba: nos llevamos las dos puntas.
        head -n "$((max / 3))" "$out"
        printf '\n... [%s líneas omitidas] ...\n\n' "$((total - max))"
        tail -n "$((max - max / 3))" "$out"
    fi
}
