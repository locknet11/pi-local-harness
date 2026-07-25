// Build step for `prepare`.
//
// `npm install -g git+https://…` prepares the clone by re-running `npm install`
// inside it, but that inner install inherits npm_config_global=true and ends up
// placing no dependencies at all — so devDependencies (and therefore tsc) are
// missing by the time `prepare` runs. Fetch a compiler ourselves in that case.
//
// tsc is resolved as a module rather than through node_modules/.bin, which is
// not populated when npm installs with --ignore-scripts.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));

function findTsc() {
  try {
    return require.resolve('typescript/lib/tsc.js');
  } catch {
    return null;
  }
}

function run(command, args) {
  // npm_config_* leaks into child installs: global/prefix send the install
  // somewhere else, dry_run (from `npm pack --dry-run`) makes it a no-op.
  const env = { ...process.env };
  for (const key of ['npm_config_global', 'npm_config_prefix', 'npm_config_location', 'npm_config_dry_run']) {
    delete env[key];
  }

  const res = spawnSync(command, args, { cwd: root, stdio: 'inherit', env, shell: process.platform === 'win32' });
  if (res.error) {
    console.error(`prepare: failed to run ${command}: ${res.error.message}`);
    return 1;
  }
  return res.status ?? 1;
}

let tsc = findTsc();

if (!tsc) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const spec = `typescript@${pkg.devDependencies.typescript}`;
  console.log(`prepare: no local typescript, installing ${spec}`);
  // --ignore-scripts keeps this install from re-entering prepare.
  const code = run('npm', [
    'install',
    '--no-save',
    '--no-audit',
    '--no-fund',
    '--no-dry-run',
    '--ignore-scripts',
    spec,
  ]);
  if (code !== 0) process.exit(code);

  tsc = findTsc();
  if (!tsc) {
    console.error('prepare: typescript still not resolvable after install');
    process.exit(1);
  }
}

process.exit(run(process.execPath, [tsc, '-p', 'tsconfig.json']));
