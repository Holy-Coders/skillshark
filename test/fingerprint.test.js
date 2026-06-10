import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treeFingerprint, sha256hex, fp8, formatFp8 } from '../src/fingerprint.js';

// §8 case 1 — computed once against this fixture, hard-coded forever. If this
// test ever fails, the fingerprint algorithm changed and every #fp= link in
// the wild silently broke.
test('§8.1 fingerprint regression: fixture tree hashes to the hard-coded value', () => {
  const files = [
    { path: 'SKILL.md', sha256: sha256hex('alpha') },
    { path: 'scripts/jump.sh', sha256: sha256hex('beta') },
  ];
  const fp = treeFingerprint(files);
  assert.equal(fp, 'cce69faeaf7821a22705a56abd014bbef872b25db9bc0251c156d2b9b26a18f8');
  assert.equal(fp8(fp), 'cce69fae');
  assert.equal(formatFp8(fp), 'cce6-9fae');
});

test('§8.1 fingerprint is order-independent: shuffled input, same fp', () => {
  const files = [
    { path: 'b.md', sha256: sha256hex('1') },
    { path: 'a.md', sha256: sha256hex('2') },
    { path: 'z/deep/c.md', sha256: sha256hex('3') },
    { path: 'README.md', sha256: sha256hex('4') },
  ];
  const fp = treeFingerprint(files);
  for (let i = 0; i < 5; i++) {
    const shuffled = [...files].sort(() => Math.random() - 0.5);
    assert.equal(treeFingerprint(shuffled), fp);
  }
});

test('§8.1 fingerprint changes when any path or content hash changes', () => {
  const base = [{ path: 'SKILL.md', sha256: sha256hex('alpha') }];
  const fp = treeFingerprint(base);
  assert.notEqual(treeFingerprint([{ path: 'SKILL2.md', sha256: sha256hex('alpha') }]), fp);
  assert.notEqual(treeFingerprint([{ path: 'SKILL.md', sha256: sha256hex('alphb') }]), fp);
});
