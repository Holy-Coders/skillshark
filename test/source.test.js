import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSource, formatSource } from '../src/source.js';
import { CliError } from '../src/errors.js';

const ID = '8a1bc94ef23d4b6a9c01e57f8d2a4b3c';

test('§8.11 source parsing: gist URLs with and without user and #fp', () => {
  assert.deepEqual(parseSource(`https://gist.github.com/${ID}`), { kind: 'gist', id: ID, fp: null });
  assert.deepEqual(parseSource(`https://gist.github.com/someuser/${ID}`), { kind: 'gist', id: ID, fp: null });
  assert.deepEqual(parseSource(`https://gist.github.com/${ID}#fp=3f9a7c21`), { kind: 'gist', id: ID, fp: '3f9a7c21' });
  assert.deepEqual(parseSource(`https://gist.github.com/some-user/${ID}/#fp=deadbeef`), { kind: 'gist', id: ID, fp: 'deadbeef' });
});

test('§8.11 source parsing: bare hex ids (20–32 chars)', () => {
  assert.deepEqual(parseSource(ID), { kind: 'gist', id: ID, fp: null });
  const short = 'abcdef0123456789abcd';
  assert.deepEqual(parseSource(short), { kind: 'gist', id: short, fp: null });
});

test('§8.11 source parsing: gh: forms, deep paths, and last-@ ref splitting', () => {
  assert.deepEqual(parseSource('gh:acme/skills'), { kind: 'repo', owner: 'acme', repo: 'skills', path: null, ref: null });
  assert.deepEqual(parseSource('gh:acme/skills@main'), { kind: 'repo', owner: 'acme', repo: 'skills', path: null, ref: 'main' });
  assert.deepEqual(parseSource('gh:acme/skills/deep/path'), { kind: 'repo', owner: 'acme', repo: 'skills', path: 'deep/path', ref: null });
  assert.deepEqual(
    parseSource('gh:acme/skills/deep/path@v1.2'),
    { kind: 'repo', owner: 'acme', repo: 'skills', path: 'deep/path', ref: 'v1.2' },
  );
  // ref containing "/" (branch name) — the LAST @ splits, path keeps its slashes
  assert.deepEqual(
    parseSource('gh:acme/skills/deep/path@feat/x'),
    { kind: 'repo', owner: 'acme', repo: 'skills', path: 'deep/path', ref: 'feat/x' },
  );
  // a path segment containing "@" must not eat the real ref (last-@ rule)
  assert.deepEqual(
    parseSource('gh:acme/skills/v@2/file.md@main'),
    { kind: 'repo', owner: 'acme', repo: 'skills', path: 'v@2/file.md', ref: 'main' },
  );
  const sha = '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d';
  assert.deepEqual(
    parseSource(`gh:octocat/Hello-World@${sha}`),
    { kind: 'repo', owner: 'octocat', repo: 'Hello-World', path: null, ref: sha },
  );
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
  ];
  for (const s of bad) {
    assert.throws(
      () => parseSource(s),
      (e) => e instanceof CliError && e.exitCode === 2 && /gh:owner\/repo/.test(e.message),
      `should reject: ${JSON.stringify(s)}`,
    );
  }
});

test('formatSource round-trips for install records', () => {
  assert.equal(formatSource(parseSource(`https://gist.github.com/${ID}#fp=12345678`)), `gist:${ID}`);
  assert.equal(formatSource(parseSource('gh:a/b/c/d@e')), 'gh:a/b/c/d@e');
});
