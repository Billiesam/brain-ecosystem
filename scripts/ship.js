#!/usr/bin/env node
/**
 * Ship script: publish all packages, update global installs, restart daemons.
 * Stops daemons BEFORE global install to avoid EPERM on locked .node files.
 */
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, opts = {}) {
  console.log(`\n  ▸ ${cmd}`);
  try {
    execSync(cmd, { cwd: root, stdio: 'inherit', ...opts });
    return true;
  } catch {
    return false;
  }
}

function runSilent(cmd) {
  try {
    execSync(cmd, { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// 1. Publish all workspaces
console.log('\n── 1. Publishing packages ──────────────────');
if (!run('npm publish --workspaces')) {
  console.error('\n  ✗ Publish failed — aborting.');
  process.exit(1);
}

// 2. Stop all daemons (so .node files are unlocked)
console.log('\n── 2. Stopping daemons ─────────────────────');
runSilent('brain stop');
runSilent(`node ${resolve(root, 'packages/trading-brain/dist/index.js')} stop`);
runSilent(`node ${resolve(root, 'packages/marketing-brain/dist/index.js')} stop`);
// Give OS time to release file handles
await new Promise(r => setTimeout(r, 2000));

// 3. Read exact versions from package.json (avoids npm cache serving stale @latest)
import { readFileSync } from 'node:fs';
const brainVer = JSON.parse(readFileSync(resolve(root, 'packages/brain/package.json'), 'utf8')).version;
const tradingVer = JSON.parse(readFileSync(resolve(root, 'packages/trading-brain/package.json'), 'utf8')).version;
const marketingVer = JSON.parse(readFileSync(resolve(root, 'packages/marketing-brain/package.json'), 'utf8')).version;

// 4. Install globally with exact versions
console.log('\n── 3. Installing globally ──────────────────');
run(`npm install -g @timmeck/brain@${brainVer} @timmeck/trading-brain@${tradingVer} @timmeck/marketing-brain@${marketingVer}`);

// 5. Restart daemons
console.log('\n── 4. Restarting daemons ────────────────────');
run('brain start');
run(`node "${resolve(root, 'packages/trading-brain/dist/index.js')}" start`);
run(`node "${resolve(root, 'packages/marketing-brain/dist/index.js')}" start`);

console.log('\n  ✓ Ship complete.\n');
