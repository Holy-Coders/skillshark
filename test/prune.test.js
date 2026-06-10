import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPrune } from '../src/share.js';
import { CliError } from '../src/errors.js';
import { addShareRecord, loadConfig } from '../src/config.js';
import { silentUi, throwingPrompts, tmpdir } from './helpers.js';

const PAST = new Date(Date.now() - 10 * 86400000).toISOString();
const FUTURE = new Date(Date.now() + 5 * 86400000).toISOString();

async function deps({ gists = [], gistFetch = {}, isTTY = false } = {}) {
  const calls = [];
  return {
    cwd: await tmpdir(),
    home: await tmpdir(),
    env: {},
    isTTY,
    configDir: await tmpdir(),
    ui: silentUi(),
    prompts: throwingPrompts(),
    clipboard: async () => false,
    _calls: calls,
    ghApi: async (args) => {
      calls.push(args);
      const last = args.at(-1);
      if (args.includes('gists') && args.includes('--paginate')) return JSON.stringify(gists);
      if (last.startsWith('gists/') && args.includes('--method')) return ''; // delete
      if (last.startsWith('gists/')) {
        const id = last.slice('gists/'.length);
        return JSON.stringify(gistFetch[id] ?? { files: {} });
      }
      throw new Error('unexpected gh call: ' + JSON.stringify(args));
    },
  };
}

function gist(id, description) {
  return { id, description, files: { 'SKILLSHARK.json': { filename: 'SKILLSHARK.json', size: 100 } } };
}

test('prune deletes only shares past advisory expiry (cache-sourced)', async () => {
  const d = await deps({
    gists: [gist('aaa', 'skillshark: old (claude-code skill) · fp 1111'), gist('bbb', 'skillshark: fresh · fp 2222'), gist('ccc', 'not ours')],
  });
  await addShareRecord(d.configDir, { id: 'aaa', name: 'old', url: 'u', expiresAt: PAST });
  await addShareRecord(d.configDir, { id: 'bbb', name: 'fresh', url: 'u', expiresAt: FUTURE });

  const res = await runPrune({ yes: true }, d);
  assert.equal(res.deleted, 1);
  assert.equal(res.scanned, 2, 'non-skillshark gists are ignored');
  const deletes = d._calls.filter((a) => a.includes('--method') && a.includes('DELETE'));
  assert.deepEqual(deletes, [['--method', 'DELETE', 'gists/aaa']]);
  // pruned id removed from cache; the fresh one stays
  const cfg = await loadConfig(d.configDir);
  assert.deepEqual(cfg.shares.map((s) => s.id), ['bbb']);
});

test('prune reads expiry from the gist stub when not in the local cache', async () => {
  const d = await deps({
    gists: [gist('zzz', 'skillshark: encrypted (fp 9999)')],
    gistFetch: { zzz: { files: { 'SKILLSHARK.json': { content: JSON.stringify({ encrypted: true, expiresAt: PAST }) } } } },
  });
  const res = await runPrune({ yes: true }, d);
  assert.equal(res.deleted, 1);
  assert.ok(d._calls.some((a) => a.at(-1) === 'gists/zzz' && !a.includes('--method')), 'fetched the stub');
});

test('prune leaves everything alone when nothing is expired (exit 0, no deletes)', async () => {
  const d = await deps({ gists: [gist('aaa', 'skillshark: fresh · fp 1')] });
  await addShareRecord(d.configDir, { id: 'aaa', name: 'fresh', url: 'u', expiresAt: FUTURE });
  const res = await runPrune({ yes: true }, d);
  assert.equal(res.deleted, 0);
  assert.ok(!d._calls.some((a) => a.includes('DELETE')));
  assert.match(d.ui.text(), /Nothing to prune/);
});

test('prune respects the TTY confirmation (declined → nothing deleted)', async () => {
  const d = await deps({ gists: [gist('aaa', 'skillshark: old · fp 1')], isTTY: true });
  await addShareRecord(d.configDir, { id: 'aaa', name: 'old', url: 'u', expiresAt: PAST });
  d.prompts = { confirm: async () => false, select: async () => null, text: async () => null };
  const res = await runPrune({}, d);
  assert.equal(res.status, 'cancelled');
  assert.ok(!d._calls.some((a) => a.includes('DELETE')), 'declined prune deletes nothing');
});

test('prune --json reports scanned + expired, then the delete count', async () => {
  const d = await deps({ gists: [gist('aaa', 'skillshark: old · fp 1')] });
  await addShareRecord(d.configDir, { id: 'aaa', name: 'old', url: 'u', expiresAt: PAST });
  await runPrune({ yes: true, json: true }, d);
  const lines = d.ui.lines.filter(Boolean);
  const summary = JSON.parse(lines[0]);
  assert.equal(summary.scanned, 1);
  assert.equal(summary.expired[0].id, 'aaa');
  assert.deepEqual(JSON.parse(lines.at(-1)), { deleted: 1 });
});
