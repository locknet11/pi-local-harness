#!/usr/bin/env bash
# ==============================================================================
#  test/harness_test.sh — pruebas de la mecánica del harness
# ------------------------------------------------------------------------------
#  Corre el orquestador entero contra un `pi` FALSO y un proyecto de juguete.
#  Nada de red, nada de GPU, nada de tokens: se prueba la lógica (parseo del
#  spec, transiciones de estado, reintentos, rollback, timeouts, locking), que
#  es justo lo que se rompe en silencio cuando lo probás sólo contra un modelo.
#
#  Uso:  ./test/harness_test.sh
# ==============================================================================

set -uo pipefail

HARNESS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0

RED=$'\033[31m'; GRN=$'\033[32m'; DIM=$'\033[2m'; RST=$'\033[0m'

ok()   { printf '  %s✔%s %s\n' "$GRN" "$RST" "$1"; PASS=$((PASS+1)); }
bad()  { printf '  %s✖%s %s\n'   "$RED" "$RST" "$1"; printf '      %s%s%s\n' "$DIM" "${2:-}" "$RST"; FAIL=$((FAIL+1)); }
head_() { printf '\n%s── %s%s\n' "$DIM" "$1" "$RST"; }

assert_eq() {
    [ "$2" = "$3" ] && ok "$1" || bad "$1" "esperaba '$3', obtuve '$2'"
}
assert_contains() {
    case "$2" in *"$3"*) ok "$1" ;; *) bad "$1" "no encontré '$3' en la salida" ;; esac
}

SANDBOX=$(mktemp -d "${TMPDIR:-/tmp}/pi-harness-test.XXXXXX")
trap 'rm -rf "$SANDBOX"' EXIT

# ------------------------------------------------------------------------------
#  Fixture: un spec válido de 3 features
# ------------------------------------------------------------------------------
make_spec() {
    cat > "$1" <<'EOF'
# Backlog

## feature: Sumar dos numeros
id: F001
status: PENDING
depends: none
acceptance:
  - suma(2,3) devuelve 5

## feature: Restar dos numeros
id: F002
status: PENDING
depends: F001
acceptance:
  - resta(5,3) devuelve 2

## feature: Multiplicar
id: F003
status: PENDING
depends: F002
acceptance:
  - mult(2,3) devuelve 6
EOF
}

# ------------------------------------------------------------------------------
#  `pi` falso. Se comporta según FAKE_PI_MODE:
#     good      escribe el archivo pedido y emite eventos de escritura
#     noop      responde texto pero NO toca ningún archivo (el caso clásico
#               del modelo chico que describe en vez de programar)
#     broken    escribe código que rompe los tests
#     hang      se cuelga (para probar el watchdog de timeout)
# ------------------------------------------------------------------------------
make_fake_pi() {
    cat > "$SANDBOX/bin/pi" <<'FAKE'
#!/usr/bin/env bash
mode="${FAKE_PI_MODE:-good}"
emit() { printf '%s\n' "$1"; }
emit '{"type":"session","version":3,"id":"test","cwd":"'"$PWD"'"}'
emit '{"type":"agent_start"}'

case "$mode" in
  hang)  sleep 300 ;;
  noop)
    emit '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"Para implementarlo habria que crear un archivo."}],"usage":{"totalTokens":900}},"toolResults":[]}'
    ;;
  broken)
    printf 'def suma(a, b):\n    return a - b\n' > impl.py
    emit '{"type":"tool_execution_end","toolCallId":"1","toolName":"write","result":"ok","isError":false}'
    emit '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"listo"}],"usage":{"totalTokens":1200}},"toolResults":[]}'
    ;;
  notests)
    # Toca el código pero NINGÚN test: la suite vieja sigue pasando y la
    # feature se daría por hecha sin haberse probado nada.
    printf 'def stdev(d):\n    return 0.0  # Dummy\n' >> impl.py
    printf 'PASS\n' > .fake_tests_pass
    emit '{"type":"tool_execution_end","toolCallId":"1","toolName":"write","result":"ok","isError":false}'
    emit '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"listo"}],"usage":{"totalTokens":1500}},"toolResults":[]}'
    ;;
  good)
    printf 'def suma(a, b):\n    return a + b\n' > impl.py
    mkdir -p tests && printf 'def test_suma():\n    assert True\n' > "tests/test_f$RANDOM.py"
    printf 'PASS\n' > .fake_tests_pass
    emit '{"type":"tool_execution_end","toolCallId":"1","toolName":"write","result":"ok","isError":false}'
    emit '{"type":"tool_execution_end","toolCallId":"2","toolName":"edit","result":"ok","isError":false}'
    emit '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"hecho"}],"usage":{"totalTokens":2400}},"toolResults":[]}'
    ;;
esac
emit '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"fin"}]}],"willRetry":false}'
emit '{"type":"agent_settled"}'
exit 0
FAKE
    chmod +x "$SANDBOX/bin/pi"
}

mkdir -p "$SANDBOX/bin"
make_fake_pi

# El comando de verificación mira un archivo bandera que deja el pi falso.
FAKE_TEST_CMD='test -f .fake_tests_pass'

new_project() {
    local d="$SANDBOX/$1"
    rm -rf "$d"; mkdir -p "$d"; cd "$d" || exit 1
    git init -q .
    git config user.email t@t.local; git config user.name test
    make_spec PROJECT_SPEC.md
    printf '# Reglas\nProyecto de prueba.\n' > AGENTS.md
    git add -A >/dev/null 2>&1; git commit -qm init >/dev/null 2>&1
}

run_harness() {
    PATH="$SANDBOX/bin:$PATH" \
    PI_BIN="$SANDBOX/bin/pi" \
    TEST_COMMAND="${TEST_COMMAND:-$FAKE_TEST_CMD}" \
    VRAM_STRATEGY=none \
    REQUIRE_TEST_CHANGES="${REQUIRE_TEST_CHANGES:-1}" \
    COOLDOWN=0 \
    NO_COLOR=1 \
    "$HARNESS_ROOT/pi-harness.sh" "$@" 2>&1
}

# ==============================================================================
head_ "Módulos: parseo del spec"
# ==============================================================================
cd "$SANDBOX" || exit 1
SPEC_FILE="$SANDBOX/spec_fixture.md"; make_spec "$SPEC_FILE"
# Ojo con el orden: common.sh reinicia estas variables al cargarse.
. "$HARNESS_ROOT/lib/common.sh"; . "$HARNESS_ROOT/lib/spec.sh"
LOG_FILE="$SANDBOX/lib.log"; HARNESS_TMP="$SANDBOX"; DUP_LOG=0; STOP_REQUESTED=0

assert_eq "cuenta 3 features"          "$(spec_count)" "3"
assert_eq "próxima pendiente es la #1" "$(spec_next_pending | cut -f1)" "1"
assert_eq "lee el nombre"              "$(spec_name_of 2)" "Restar dos numeros"
assert_eq "lee un campo"               "$(spec_field_of 2 id)" "F002"
assert_eq "spec válido"                "$(spec_validate)" ""

spec_set_status 1 COMPLETED
assert_eq "escribe el status"          "$(spec_status_of 1)" "COMPLETED"
assert_eq "no toca a los vecinos"      "$(spec_status_of 2)" "PENDING"
assert_eq "sigue por la #2"            "$(spec_next_pending | cut -f1)" "2"

# Dependencias: si F002 no está lista, F003 no puede entrar.
spec_set_status 2 FAILED
assert_eq "respeta depends"            "$(spec_next_pending)" ""
spec_has_blocked_pending && ok "detecta pendientes bloqueadas" || bad "detecta pendientes bloqueadas" "no las vio"

assert_eq "reset devuelve a PENDING"   "$(spec_reset_from FAILED)" "1"

# Un spec roto tiene que dar errores legibles (es lo que se le devuelve al modelo).
cat > "$SANDBOX/bad_spec.md" <<'EOF'
## feature: Sin status
id: F001
acceptance:
  - algo

## feature: Id repetido
id: F001
status: RARO
EOF
BAD=$(spec_validate "$SANDBOX/bad_spec.md")
assert_contains "detecta status faltante" "$BAD" 'falta "status:"'
assert_contains "detecta status inválido" "$BAD" 'status "RARO" inválido'
assert_contains "detecta id duplicado"    "$BAD" 'duplicado'
assert_contains "detecta acceptance faltante" "$BAD" 'falta la lista "acceptance:"'

# ==============================================================================
head_ "Módulos: timeout y duraciones (sin timeout(1))"
# ==============================================================================
cmd_available "ls -la"                  && ok "cmd_available: comando simple"       || bad "cmd_available simple" ""
cmd_available "FOO=1 BAR=2 ls"          && ok "cmd_available: saltea VAR=valor"     || bad "cmd_available env-prefix" ""
cmd_available "env FOO=1 ls"            && ok "cmd_available: saltea 'env'"         || bad "cmd_available env" ""
cmd_available "no_existe_xyz_123"       && bad "cmd_available: inexistente" "lo dio por bueno" || ok "cmd_available: rechaza inexistente"
cmd_available "PYTHONPATH=. ./nope/pytest" && bad "cmd_available: ruta inexistente" "" || ok "cmd_available: rechaza ruta inexistente"
printf '#!/bin/sh\ntrue\n' > "$SANDBOX/fakebin"; chmod +x "$SANDBOX/fakebin"
cmd_available "PYTHONPATH=. $SANDBOX/fakebin -q" && ok "cmd_available: ruta relativa con env" || bad "cmd_available ruta+env" ""

assert_eq "parse 25m" "$(parse_duration 25m)" "1500"
assert_eq "parse 90s" "$(parse_duration 90s)" "90"
assert_eq "parse 2h"  "$(parse_duration 2h)"  "7200"
assert_eq "parse 45"  "$(parse_duration 45)"  "45"

run_supervised 2 "$SANDBOX/to.log" -- sleep 30
assert_eq "el watchdog corta y devuelve 124" "$?" "124"
assert_eq "marca RUN_TIMED_OUT"              "$RUN_TIMED_OUT" "1"

start=$SECONDS
run_supervised 10 "$SANDBOX/to2.log" -- true
rc=$?
assert_eq "no interfiere con lo que termina rápido" "$rc" "0"
[ $((SECONDS - start)) -lt 3 ] && ok "vuelve al toque (no espera el timeout)" \
    || bad "vuelve al toque" "tardó $((SECONDS - start))s"

# El watchdog tiene que llevarse el ÁRBOL, no sólo al hijo directo.
run_supervised 2 "$SANDBOX/tree.log" -- bash -c 'sleep 300 & sleep 300'
sleep 1
if pgrep -f "sleep 300" >/dev/null 2>&1; then
    bad "mata el árbol de procesos" "quedaron nietos vivos"
    pkill -f "sleep 300" 2>/dev/null
else
    ok "mata el árbol de procesos (set -m + kill de process group)"
fi

# ==============================================================================
head_ "Módulos: lock sin flock"
# ==============================================================================
acquire_lock "$SANDBOX/l.d" && ok "toma el lock" || bad "toma el lock" ""
( acquire_lock "$SANDBOX/l.d" ) && bad "rechaza al segundo" "lo dejó pasar" || ok "rechaza al segundo"
release_lock
acquire_lock "$SANDBOX/l.d" && ok "se puede retomar tras liberar" || bad "retoma" ""
release_lock
# Lock huérfano: PID muerto -> se lo puede robar.
mkdir -p "$SANDBOX/stale.d"; printf '999999\n' > "$SANDBOX/stale.d/pid"
acquire_lock "$SANDBOX/stale.d" && ok "roba un lock huérfano" || bad "roba un lock huérfano" ""
release_lock

# ==============================================================================
head_ "Loop: camino feliz"
# ==============================================================================
new_project happy
OUT=$(FAKE_PI_MODE=good run_harness run)
assert_contains "termina el backlog"  "$OUT" "Backlog terminado"
assert_eq "F001 completada" "$(grep -A2 'id: F001' PROJECT_SPEC.md | grep status | sed 's/status: //')" "COMPLETED"
assert_eq "F003 completada" "$(grep -A2 'id: F003' PROJECT_SPEC.md | grep status | sed 's/status: //')" "COMPLETED"
assert_eq "commiteó una vez por feature" "$(git log --oneline | grep -c '^[a-f0-9]* feat')" "3"

# ==============================================================================
head_ "Loop: el modelo habla pero no escribe"
# ==============================================================================
new_project noop
OUT=$(FAKE_PI_MODE=noop MAX_RETRIES=2 MAX_CONSECUTIVE_FAILURES=1 run_harness run)
assert_contains "detecta que no tocó archivos" "$OUT" "no tocó ningún archivo"
assert_eq "la marca FAILED" "$(grep -A2 'id: F001' PROJECT_SPEC.md | grep status | sed 's/status: //')" "FAILED"
assert_contains "corta con el freno global" "$OUT" "Freno global"

# ==============================================================================
head_ "Loop: tests en rojo -> reintento -> rollback"
# ==============================================================================
new_project broken
BEFORE=$(git rev-parse HEAD)
OUT=$(FAKE_PI_MODE=broken MAX_RETRIES=2 MAX_CONSECUTIVE_FAILURES=1 run_harness run)
assert_contains "reintenta"                "$OUT" "intento 2/2"
assert_contains "avisa el circuit breaker" "$OUT" "circuit breaker"
assert_eq "queda FAILED" "$(grep -A2 'id: F001' PROJECT_SPEC.md | grep status | sed 's/status: //')" "FAILED"
[ ! -f impl.py ] && ok "el rollback borró el código roto" || bad "rollback" "impl.py sobrevivió"

# Sin rollback, el destrozo tiene que quedar (contraprueba de que la opción sirve).
new_project norollback
OUT=$(FAKE_PI_MODE=broken MAX_RETRIES=1 MAX_CONSECUTIVE_FAILURES=1 GIT_ROLLBACK_ON_FAIL=0 run_harness run)
[ -f impl.py ] && ok "GIT_ROLLBACK_ON_FAIL=0 conserva el árbol" || bad "sin rollback" "igual borró"

# ==============================================================================
head_ "Loop: código sin tests (suite verde que no prueba nada)"
# ==============================================================================
new_project notests
OUT=$(FAKE_PI_MODE=notests MAX_RETRIES=2 MAX_CONSECUTIVE_FAILURES=1 run_harness run)
assert_contains "detecta que no escribió tests" "$OUT" "no tocó ningún archivo de tests"
assert_eq "no la da por COMPLETED" "$(grep -A2 'id: F001' PROJECT_SPEC.md | grep status | sed 's/status: //')" "FAILED"

# Con la comprobación apagada, pasa igual (contraprueba).
new_project notests2
OUT=$(FAKE_PI_MODE=notests MAX_RETRIES=1 REQUIRE_TEST_CHANGES=0 run_harness run --once)
assert_eq "REQUIRE_TEST_CHANGES=0 la acepta" "$(grep -A2 'id: F001' PROJECT_SPEC.md | grep status | sed 's/status: //')" "COMPLETED"

# ==============================================================================
head_ "Loop: entorno roto (comando de test inexistente)"
# ==============================================================================
new_project envbroken
OUT=$(FAKE_PI_MODE=good TEST_COMMAND="comando_que_no_existe_xyz" run_harness run)
assert_contains "frena por entorno, no marca FAILED" "$OUT" "no existe en el PATH"
assert_eq "deja la feature en PENDING" "$(grep -A2 'id: F001' PROJECT_SPEC.md | grep status | sed 's/status: //')" "PENDING"

# ==============================================================================
head_ "Loop: --once y --feature"
# ==============================================================================
new_project once
OUT=$(FAKE_PI_MODE=good run_harness run --once)
assert_eq "--once hace sólo una" "$(grep -c 'status: COMPLETED' PROJECT_SPEC.md)" "1"

new_project onlyfeat
OUT=$(FAKE_PI_MODE=good run_harness run --feature F002)
assert_eq "--feature va derecho a esa" "$(grep -A2 'id: F002' PROJECT_SPEC.md | grep status | sed 's/status: //')" "COMPLETED"
assert_eq "y no toca las otras"        "$(grep -A2 'id: F001' PROJECT_SPEC.md | grep status | sed 's/status: //')" "PENDING"

# ==============================================================================
head_ "Loop: timeout del agente"
# ==============================================================================
new_project slow
OUT=$(FAKE_PI_MODE=hang FEATURE_TIMEOUT=3s MAX_RETRIES=1 MAX_CONSECUTIVE_FAILURES=1 run_harness run)
assert_contains "corta a un pi colgado" "$OUT" "timeout"
assert_eq "y la marca FAILED" "$(grep -A2 'id: F001' PROJECT_SPEC.md | grep status | sed 's/status: //')" "FAILED"

# ==============================================================================
head_ "Reanudar: features a medias"
# ==============================================================================
new_project resume
# Simulamos una corrida que se murió con una feature en IN_PROGRESS.
# (awk y no `sed 0,/re/`: esa forma de direccionar es de GNU, la BSD de macOS la rechaza)
awk '!done && /^status: PENDING$/ { print "status: IN_PROGRESS"; done=1; next } {print}' \
    PROJECT_SPEC.md > .spec.tmp && mv .spec.tmp PROJECT_SPEC.md
OUT=$(FAKE_PI_MODE=good run_harness run)
assert_contains "destraba las IN_PROGRESS viejas" "$OUT" "quedó IN_PROGRESS"
assert_eq "y las termina" "$(grep -c 'status: COMPLETED' PROJECT_SPEC.md)" "3"

# ==============================================================================
head_ "Subcomandos"
# ==============================================================================
new_project subcmds
OUT=$(run_harness spec)
assert_contains "spec muestra el backlog" "$OUT" "total=3"
OUT=$(run_harness status)
assert_contains "status sin corrida viva" "$OUT" "no hay nada corriendo"
OUT=$(run_harness reset FAILED)
assert_contains "reset informa"           "$OUT" "devueltas a PENDING"

# ==============================================================================
printf '\n%s─────────────────────────────%s\n' "$DIM" "$RST"
if [ "$FAIL" -eq 0 ]; then
    printf '%s%d pruebas OK%s\n\n' "$GRN" "$PASS" "$RST"; exit 0
else
    printf '%s%d fallaron%s, %d OK\n\n' "$RED" "$FAIL" "$RST" "$PASS"; exit 1
fi
