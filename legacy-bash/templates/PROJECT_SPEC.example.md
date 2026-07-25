# Backlog del proyecto
#
# Formato que espera el harness. Normalmente lo genera `pi-harness.sh init`,
# pero podés escribirlo a mano: es sólo texto.
#
# Reglas que valida el parser (`./pi-harness.sh spec` te las chequea):
#   · cada bloque arranca con "## feature: <nombre>"
#   · id único, correlativo
#   · status en: PENDING | IN_PROGRESS | COMPLETED | UNVERIFIED | FAILED | BLOCKED
#   · acceptance con al menos un ítem
#
# Los campos van SIN indentar. El harness sólo reescribe la línea `status:`.

## feature: Parsear el archivo de configuración
id: F001
status: PENDING
depends: none
acceptance:
  - load_config() lee un TOML y devuelve un dict
  - una clave faltante levanta ConfigError con el nombre de la clave
  - un archivo inexistente levanta ConfigError, no FileNotFoundError
notes: |
  Va en src/config.py. Usar tomllib (stdlib desde 3.11).
  ConfigError se define en src/errors.py.

## feature: Cliente HTTP con reintentos
id: F002
status: PENDING
depends: F001
# Una feature puede pisar el comando de verificación global:
test: .venv/bin/pytest -q tests/test_client.py
acceptance:
  - get() reintenta 3 veces ante 5xx, con backoff exponencial
  - un 4xx no se reintenta: levanta ClientError al toque
  - el timeout sale de la config, no está hardcodeado
notes: |
  src/client.py. Sin dependencias nuevas: urllib de la stdlib.
  Los tests mockean el transporte, no pegan a la red.

## feature: Comando `sync` de la CLI
id: F003
status: PENDING
depends: F001, F002
acceptance:
  - `app sync` sale con código 0 cuando todo anda
  - `app sync --dry-run` no escribe nada en disco
  - sin config, sale con código 2 y un mensaje claro por stderr
notes: |
  src/cli.py con argparse. La lógica va en src/sync.py para poder testearla
  sin pasar por la CLI.
