# pi-local-llm-harness

Un harness alrededor de [pi](https://pi.dev) para que un **LLM local** (Ollama:
Qwen3-Coder, Gemma, gpt-oss, lo que tengas) construya un proyecto mediano
**desde cero**: te entrevista, arma el backlog, levanta el andamiaje y después
implementa feature por feature verificando con tests reales.

Nace de un orquestador para aider que corría el loop de features bien, pero no
lograba arrancar de un directorio vacío. El problema no era el loop: era que
nadie definía **qué** construir ni dejaba el terreno listo para verificar nada.

## Por qué tres fases y no un loop

```
init ──▶ entrevista ──▶ AGENTS.md + PROJECT_SPEC.md ──▶ andamiaje verde
                              (validado)                  (tests pasan)
                                                              │
run  ─────────────────────────────────────────────────────────┘
      por cada feature: pi implementa ──▶ tests ──▶ commit
                             ▲              │
                             └── reintento ─┘ (con la salida real del error)
                                            └── falla N veces ──▶ rollback
```

Cada fase termina en algo **comprobable**, no en una promesa del modelo:

| Fase | Termina cuando | Si no |
|---|---|---|
| `init` | el spec parsea y tiene features bien formadas | se le devuelven los errores exactos al modelo y reintenta |
| `scaffold` | el comando de tests corre y pasa en verde | reintenta con la salida del fallo |
| `run` | cada feature pasa sus tests | reintento; tras N, `FAILED` + rollback |

Sin la fase de andamiaje, la primera feature no tiene contra qué verificarse y
todo el loop se vuelve decorativo: el modelo dice "listo" y nadie lo contradice.

## Instalación

```bash
npm i -g @earendil-works/pi-coding-agent    # pi
brew install ollama jq                      # jq es opcional pero recomendado
ollama serve &
ollama pull qwen3-coder:30b

git clone <este-repo> ~/pi-local-llm-harness
chmod +x ~/pi-local-llm-harness/pi-harness.sh
```

Registrá el modelo en pi y revisá el entorno:

```bash
cd ~/mi-proyecto-nuevo
~/pi-local-llm-harness/pi-harness.sh setup-model qwen3-coder:30b
~/pi-local-llm-harness/pi-harness.sh doctor
```

`setup-model` hace un **merge no destructivo** en `~/.pi/agent/models.json`
(deja backup con fecha) y le agrega el `compat` que Ollama necesita —ver abajo—.

## Uso

```bash
pi-harness.sh init      # te entrevista y deja el proyecto listo para arrancar
pi-harness.sh run       # implementa el backlog entero
pi-harness.sh build     # las dos de una

pi-harness.sh run -b            # en background
pi-harness.sh follow            # ver el log en vivo
pi-harness.sh stop              # frenar
pi-harness.sh spec              # estado del backlog
pi-harness.sh reset FAILED      # devolver las fallidas a PENDING
pi-harness.sh run --once        # una sola feature (para tantear el modelo)
pi-harness.sh run --feature F003
```

Sin ganas de contestar la entrevista:

```bash
pi-harness.sh init --idea "Un CLI en Go que sincroniza carpetas por SSH" -y
pi-harness.sh init --brief mi_brief.md -y
```

## Los dos problemas que te van a morder con Ollama

### 1. `num_ctx` — el que arruina todo en silencio

Ollama sirve los modelos con **4096 tokens** por defecto. El `contextWindow` de
`models.json` sólo le dice a pi qué asumir; **no cambia lo que Ollama hace**.
Resultado: Ollama trunca el prompt por abajo, el agente "olvida" las
instrucciones a mitad de camino y escribe cualquier cosa. No hay error, no hay
warning: sólo un modelo que parece más tonto de lo que es.

No es teoría. Medido en una Fedora con Ollama 0.32.1:

```
$ ollama ps
NAME                ID              SIZE      PROCESSOR    CONTEXT
qwen2.5-coder:7b    dae161e27b0e    4.6 GB    100% GPU     4096      ← el default
```

4096 tokens no alcanzan ni para el system prompt de pi (~10-13k). El agente
arranca ya truncado.

`doctor` te lo detecta leyendo el `num_ctx` del Modelfile —ojo, `/api/show` lo
devuelve adentro del string `parameters`, no como campo JSON—. Se arregla así:

```bash
pi-harness.sh tune-ctx qwen2.5-coder:7b 32768   # crea un modelo derivado
OLLAMA_CONTEXT_LENGTH=32768 ollama serve        # o al arrancar el SERVIDOR
```

Verificalo siempre con `ollama ps`: la columna CONTEXT es la verdad.

```
qwen2.5-coder-pi32768    5.5 GB    100% GPU    32768   ← después de tune-ctx
```

### Elegir modelo según la VRAM

Tienen que entrar **dos** cosas: los pesos y el KV cache del contexto. Para una
placa de 8 GB (probado en una RTX 2070 Super):

| | |
|---|---|
| qwen2.5-coder:7b, pesos Q4_K_M | ~4.7 GB |
| KV cache a 32k con `OLLAMA_KV_CACHE_TYPE=q8_0` | ~0.9 GB |
| **total** | **~5.5 GB de 8 GB** |

A 64k sigue entrando (~6.5 GB). `OLLAMA_KV_CACHE_TYPE=q8_0` en el systemd de
ollama casi halva el KV cache y es la forma más barata de comprar contexto.

**El tamaño del modelo importa más que su contexto.** Probado en la 2070 Super,
mismo proyecto (librería de estadística, 3 features), mismo prompt:

| Modelo | VRAM | ctx | Resultado |
|---|---|---|---|
| `gemma4:e2b` | 2.1 GB | 131k | docs OK, **andamiaje falló** 3/3: `pyproject.toml` inválido; escribió un `__init__.py` cuyo contenido era el literal `__init__.py` |
| `qwen2.5-coder:7b` | 4.6 GB | 4096→32k | **no ejecuta tools**: devuelve el JSON del tool call como texto. Inservible para un agente |
| `qwen3.5:latest` | 6.2 GB | 32k | ejecuta tools, pero se colgó >10 min razonando en el primer prompt |
| `gemma4:e4b` | 3.3 GB | 32k | **el mejor de los cuatro**: proyecto entero, 2/3 features implementadas y testeadas de verdad |

Ninguno es cómodo. En 8 GB entran modelos de 7-9B, y esos son irregulares en
uso sostenido de herramientas: `gemma4:e4b` necesitó que se le insistiera para
no quedarse describiendo en vez de escribir. Sirven para proyectos chicos, con
features **finas** (una función por feature) y `MAX_RETRIES` alto.

Si podés, más VRAM es lo que más mueve la aguja: los modelos que hacen agentic
coding con soltura son de 14B-30B y piden 12-24 GB.

### 2. `compat` — el rol `developer` y `reasoning_effort`

pi manda el system prompt con el rol `developer` y a veces `reasoning_effort`.
Muchos servidores OpenAI-compatibles (Ollama, vLLM, SGLang) no los entienden y
devuelven 400. `setup-model` ya escribe el `compat` que lo desactiva; si armás
el `models.json` a mano, no te lo saltees.

## Cómo se lo hace rendir a un modelo chico

El contexto es el recurso escaso. Todo esto está para no desperdiciarlo:

- **Una sesión nueva por feature.** Arrastrar la sesión llena la ventana de
  basura vieja y el modelo termina truncando justo lo que importa.
- **AGENTS.md no se adjunta:** pi ya lo descubre solo. Mandarlo a mano duplica.
- **Al modelo se le da una feature, no el backlog entero.**
- **Los errores se recortan** (`TEST_EXCERPT_LINES`): se manda la cabeza y la
  cola de la salida, que es donde están el primer error y el resumen.
- **Rollback al fallar.** Un intento fallido deja imports rotos y archivos a
  medio escribir. Si eso queda, la feature siguiente arranca sobre escombros y
  arrastra el fracaso. Con rollback, cada feature parte de verde.

### Los tres fracasos silenciosos de un modelo local

Los tres dan **exit code 0**. Sin chequearlos, el harness reporta features
"completadas" que no existen. Cada uno se detecta distinto:

**1. Describe en vez de escribir.** En vez de usar las tools, contesta en prosa
el código que habría que escribir. Se detecta contando las llamadas a tools de
escritura en el stream JSON de pi: cero escrituras = intento fallido. En el
reintento se le dice explícitamente que no modificó nada — repetirle el mismo
prompt da el mismo resultado. Medido: gemma4:e4b falló dos features seguidas
así y las completó apenas se le avisó.

**2. Emite el tool call como texto.** El modelo contesta

```json
{"name": "write", "arguments": {"path": "hola.txt", "content": "HOLA"}}
```

como texto plano. pi nunca ve una tool call y no pasa nada. Declarar `tools` en
las capabilities de Ollama **no alcanza**: eso viene de la plantilla, no del
modelo. `qwen2.5-coder:7b` declara `tools` y hace exactamente esto.

```bash
pi-harness.sh doctor --probe    # lo prueba de verdad, cuesta una inferencia
```

**3. Escribe código sin tests.** El más traicionero: toca el código pero ningún
test. La suite sigue verde —porque los tests que hay son de features
anteriores— y la feature se marca COMPLETED. Caso real medido: dos features
dadas por hechas sobre un `return 0.0  # Dummy return` duplicado dos veces, con
la suite en verde.

Una suite que pasa sólo prueba que no rompiste lo viejo. Por eso el harness
exige que cada feature toque algún archivo de tests
(`REQUIRE_TEST_CHANGES=1`, por defecto).

## Estados de una feature

`PENDING → IN_PROGRESS → COMPLETED` en el camino feliz. Además:

- **UNVERIFIED** — se aceptó sin poder correr tests. Miralas a mano.
- **FAILED** — agotó los reintentos. `reset FAILED` las vuelve a poner en cola.
- **BLOCKED** — para marcar a mano lo que no va a salir.

Si el harness se muere a la mitad, las `IN_PROGRESS` vuelven a `PENDING` solas
en el próximo arranque.

## Cuando algo se rompe

```bash
pi-harness.sh doctor          # primera parada, siempre
KEEP_TMP=1 pi-harness.sh run --once   # deja los JSONL crudos en .harness/tmp
```

| Síntoma | Causa casi segura |
|---|---|
| features `FAILED` en cadena desde la primera | `num_ctx` chico (ver arriba) |
| `no tocó ningún archivo` repetido | modelo demasiado chico, o `num_ctx` |
| todo `UNVERIFIED` | no hay comando de tests; mirá `.harness/test_cmd` |
| freno por "no existe en el PATH" | el venv/toolchain no está en el PATH del harness |
| pi sale con código 1 al toque | provider mal registrado: `setup-model` |

El **freno global** (`MAX_CONSECUTIVE_FAILURES`) existe para eso: si tres
features seguidas fallan, algo está roto de raíz y seguir sólo quema GPU toda
la noche.

## Configuración

`cp harness.conf.example harness.conf` en la raíz del proyecto. Todo se puede
pisar por entorno:

```bash
MAX_RETRIES=8 FEATURE_TIMEOUT=45m pi-harness.sh run
```

## Tests del harness

```bash
./test/harness_test.sh      # 61 pruebas, sin red ni GPU ni tokens
```

Corren el orquestador entero contra un `pi` falso: transiciones de estado,
reintentos, rollback, watchdog de timeout, locking, dependencias entre
features. Es lo que se rompe en silencio si lo probás sólo contra un modelo.

## Notas de portabilidad

macOS trae **bash 3.2** y no trae `timeout`, `flock` ni `setsid`. Todo está
escrito para bash 3.2 y esos tres se reemplazan a mano:

| Falta | Reemplazo |
|---|---|
| `timeout(1)` | watchdog propio; el `wait` deja que los traps corran, así el Ctrl+C corta de verdad |
| `flock(1)` | lock con `mkdir` atómico, que además detecta locks huérfanos |
| `setsid(1)` | `set -m`: cada job queda como líder de su process group, así `kill -TERM -PID` se lleva también a los nietos que lanza pi |

Funciona igual en Linux.

## Limitaciones conocidas

- **El modelo puede contradecir su propio AGENTS.md.** En una prueba declaró la
  estructura en `csv2json/` y después escribió todo en `src/`. Los tests pasan
  igual, pero la doc queda mintiendo. Revisá AGENTS.md antes de un `run` largo.
- **Un backlog malo no lo salva ningún loop.** Si las features salen enormes o
  mal ordenadas, editá `PROJECT_SPEC.md` a mano antes de `run`. Es texto plano
  justamente para eso.
- **`UNVERIFIED` no es `COMPLETED`.** Sin tests, nadie garantiza nada.
