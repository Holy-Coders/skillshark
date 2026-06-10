import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSource, formatSource, resolveHost, DEFAULT_HOST } from '../src/source.js';
import { CliError } from '../src/errors.js';

const ID = '8a1bc94ef23d4b6a9c01e57f8d2a4b3c';
const GH = 'github.com';

test('§8.11 source parsing: gist URLs with and without user and #fp', () => {
  assert.deepEqual(parseSource(`https://gist.github.com/${ID}`), { kind: 'gist', id: ID, fp: null, key: null, host: GH });
  assert.deepEqual(parseSource(`https://gist.github.com/someuser/${ID}`), { kind: 'gist', id: ID, fp: null, key: null, host: GH });
  assert.deepEqual(parseSource(`https://gist.github.com/${ID}#fp=3f9a7c21`), { kind: 'gist', id: ID, fp: '3f9a7c21', key: null, host: GH });
  assert.deepEqual(parseSource(`https://gist.github.com/some-user/${ID}/#fp=deadbeef`), { kind: 'gist', id: ID, fp: 'deadbeef', key: null, host: GH });
});

test('§8.11 source parsing: bare hex ids (20–32 chars)', () => {
  assert.deepEqual(parseSource(ID), { kind: 'gist', id: ID, fp: null, key: null, host: GH });
  const short = 'abcdef0123456789abcd';
  assert.deepEqual(parseSource(short), { kind: 'gist', id: short, fp: null, key: null, host: GH });
  // --host applies to bare ids
  assert.deepEqual(parseSource(ID, { defaultHost: 'ghe.corp.com' }), { kind: 'gist', id: ID, fp: null, key: null, host: 'ghe.corp.com' });
});

test('§8.11 source parsing: gh: forms, deep paths, and last-@ ref splitting', () => {
  assert.deepEqual(parseSource('gh:acme/skills'), { kind: 'repo', owner: 'acme', repo: 'skills', path: null, ref: null, host: GH });
  assert.deepEqual(parseSource('gh:acme/skills@main'), { kind: 'repo', owner: 'acme', repo: 'skills', path: null, ref: 'main', host: GH });
  assert.deepEqual(parseSource('gh:acme/skills/deep/path'), { kind: 'repo', owner: 'acme', repo: 'skills', path: 'deep/path', ref: null, host: GH });
  assert.deepEqual(
    parseSource('gh:acme/skills/deep/path@v1.2'),
    { kind: 'repo', owner: 'acme', repo: 'skills', path: 'deep/path', ref: 'v1.2', host: GH },
  );
  // ref containing "/" (branch name) — the LAST @ splits, path keeps its slashes
  assert.deepEqual(
    parseSource('gh:acme/skills/deep/path@feat/x'),
    { kind: 'repo', owner: 'acme', repo: 'skills', path: 'deep/path', ref: 'feat/x', host: GH },
  );
  // a path segment containing "@" must not eat the real ref (last-@ rule)
  assert.deepEqual(
    parseSource('gh:acme/skills/v@2/file.md@main'),
    { kind: 'repo', owner: 'acme', repo: 'skills', path: 'v@2/file.md', ref: 'main', host: GH },
  );
  const sha = '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d';
  assert.deepEqual(
    parseSource(`gh:octocat/Hello-World@${sha}`),
    { kind: 'repo', owner: 'octocat', repo: 'Hello-World', path: null, ref: sha, host: GH },
  );
  // --host routes repo sources at an enterprise
  assert.equal(parseSource('gh:acme/skills', { defaultHost: 'ghe.corp.com' }).host, 'ghe.corp.com');
});

test('enterprise gist URLs: subdomain isolation and path forms carry their host', () => {
  assert.deepEqual(
    parseSource(`https://gist.ghe.corp.com/${ID}#fp=3f9a7c21`),
    { kind: 'gist', id: ID, fp: '3f9a7c21', key: null, host: 'ghe.corp.com' },
  );
  assert.deepEqual(
    parseSource(`https://ghe.corp.com/gist/${ID}#fp=3f9a7c21`),
    { kind: 'gist', id: ID, fp: '3f9a7c21', key: null, host: 'ghe.corp.com' },
  );
  assert.deepEqual(
    parseSource(`https://ghe.corp.com/gist/someuser/${ID}`),
    { kind: 'gist', id: ID, fp: null, key: null, host: 'ghe.corp.com' },
  );
  // tenant.ghe.com (GHE Cloud with data residency) parses the same way
  assert.equal(parseSource(`https://gist.tenant.ghe.com/${ID}`).host, 'tenant.ghe.com');
  // a URL's host always beats the default
  assert.equal(parseSource(`https://gist.ghe.corp.com/${ID}`, { defaultHost: GH }).host, 'ghe.corp.com');
});

test('resolveHost: flag > SKILLSHARK_HOST > GH_HOST > github.com; junk refused', () => {
  assert.equal(resolveHost({}, { env: {} }), DEFAULT_HOST);
  assert.equal(resolveHost({}, { env: { GH_HOST: 'ghe.corp.com' } }), 'ghe.corp.com');
  assert.equal(resolveHost({}, { env: { SKILLSHARK_HOST: 'a.example', GH_HOST: 'b.example' } }), 'a.example');
  assert.equal(resolveHost({ host: 'GHE.Corp.Com' }, { env: { GH_HOST: 'x' } }), 'ghe.corp.com');
  assert.throws(() => resolveHost({ host: 'not a host!' }, {}), (e) => e instanceof CliError && e.exitCode === 2);
});

test('§8.11 source parsing: everything else exits 2 with examples of accepted forms', () => {
  const bad = [
    '',
    'not-a-source',
    'https://example.com/x',
    'https://gist.github.com/nothex',
    'gh:onlyowner',
    'gh:owner/repo@',
    'ftp://gist.github.com/' + ID,
    'ABCDEF0123456789ABCD', // uppercase hex is not a gist id
    'https://github.com/gist/' + ID, // github.com has no /gist/ path form
  ];
  for (const s of bad) {
    assert.throws(
      () => parseSource(s),
      (e) => e instanceof CliError && e.exitCode === 2 && /gh:owner\/repo/.test(e.message),
      `should reject: ${JSON.stringify(s)}`,
    );
  }
});

test('formatSource round-trips for install records, tagging enterprise hosts', () => {
  assert.equal(formatSource(parseSource(`https://gist.github.com/${ID}#fp=12345678`)), `gist:${ID}`);
  assert.equal(formatSource(parseSource('gh:a/b/c/d@e')), 'gh:a/b/c/d@e');
  assert.equal(formatSource(parseSource(`https://ghe.corp.com/gist/${ID}`)), `gist:ghe.corp.com:${ID}`);
  assert.equal(formatSource(parseSource('gh:a/b@c', { defaultHost: 'ghe.corp.com' })), 'gh:ghe.corp.com:a/b@c');
});
