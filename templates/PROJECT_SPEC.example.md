# Project backlog
#
# The format the harness expects. Normally `pi-harness init` generates this,
# but it is plain text so you can write or edit it by hand.
#
# Rules the parser enforces (`pi-harness spec` checks them for you):
#   - each block starts with "## feature: <name>"
#   - unique, sequential id
#   - status is one of PENDING | IN_PROGRESS | COMPLETED | UNVERIFIED | FAILED | BLOCKED
#   - acceptance has at least one item
#   - depends only references features defined EARLIER in the file
#
# Fields are unindented. The harness only ever rewrites the `status:` line.

## feature: Parse the configuration file
id: F001
status: PENDING
depends: none
acceptance:
  - load_config() reads a TOML file and returns a dict
  - a missing key raises ConfigError naming the key
  - a missing file raises ConfigError, not FileNotFoundError
notes: |
  Goes in src/config.py using tomllib (stdlib since 3.11).
  ConfigError is defined in src/errors.py.

## feature: HTTP client with retries
id: F002
status: PENDING
depends: F001
# A feature may override the global verification command:
test: .venv/bin/pytest -q tests/test_client.py
acceptance:
  - get() retries 3 times on 5xx with exponential backoff
  - a 4xx is not retried and raises ClientError immediately
  - the timeout comes from config, it is not hardcoded
notes: |
  src/client.py. No new dependencies: use urllib from the stdlib.
  Tests mock the transport; they must not hit the network.

## feature: The `sync` CLI command
id: F003
status: PENDING
depends: F001, F002
acceptance:
  - `app sync` exits 0 on success
  - `app sync --dry-run` writes nothing to disk
  - with no config it exits 2 with a clear message on stderr
notes: |
  src/cli.py with argparse. Keep the logic in src/sync.py so it can be tested
  without going through the CLI.
