/** Refresh the target's own offline OSS document after installing new runtime/CI assets. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { git } from './git-state.mjs';
import { redactCredentials } from '../tools/cnb-api.mjs';

export const INVENTORY_DOCUMENT = 'docs/OPEN_SOURCE_COMPONENTS.md';
const execute = promisify(execFile);

export async function verifyInventoryCheckout(root) {
  // An incomplete sparse view would silently drop product manifests from the document.
  const tracked = await git(['ls-files', '-v', '-z'], { cwd: root, raw: true });
  if (tracked.split('\0').some(entry => entry.startsWith('S '))) throw new Error('Target OSS generation requires a complete tracked checkout');
}

export async function refreshTargetInventory(root) {
  const source = await readFile(join(root, 'scripts/oss-inventory.mjs'), 'utf8');
  if (!source.includes('OSS_REPO_ROOT') || !source.includes('generateDocument')) throw new Error('Target OSS generator needs an explicit compatible installation adapter');
  await verifyInventoryCheckout(root);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'delivery-inventory-')));
  try {
    const generator = join(directory, 'inventory.mjs');
    await writeFile(generator, source);
    // ESM resolves the parser beside this copied module. The target's manifest
    // and generator stay intact; the locked delivery parser provides full YAML.
    const require = createRequire(new URL('./runtime/package.json', import.meta.url));
    await mkdir(join(directory, 'node_modules'));
    await symlink(dirname(require.resolve('yaml/package.json')), join(directory, 'node_modules/yaml'), 'dir');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|NODE_OPTIONS|NODE_PATH/i.test(key)));
    env.OSS_REPO_ROOT = root;
    for (const flag of ['--write', '--check']) {
      try { await execute(process.execPath, [generator, flag], { cwd: root, env, timeout: 120000, maxBuffer: 1024 * 1024 }); }
      catch (error) { throw new Error('Target OSS generation failed: ' + redactCredentials(error.stderr ?? error.message)); }
    }
    const content = await readFile(join(root, INVENTORY_DOCUMENT), 'utf8');
    if (!content.trim()) throw new Error('Target OSS generation returned an empty document');
    return content;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
