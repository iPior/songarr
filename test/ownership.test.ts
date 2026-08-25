import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  assertOwned,
  isOwned,
  OwnershipError,
  parseTags,
  selectOwned,
  type OwnableTorrent,
  type OwnershipClaim,
} from '../src/spike/ownership.ts';

const TAG = 'songarr-request-11111111-2222-3333-4444-555555555555';

const claim: OwnershipClaim = { category: 'songarr', tag: TAG, hash: 'abc123' };

function torrent(overrides: Partial<OwnableTorrent> = {}): OwnableTorrent {
  return { hash: 'abc123', category: 'songarr', tags: TAG, name: 'Some Release', ...overrides };
}

describe('parseTags', () => {
  test('splits qBittorrent comma-separated tags', () => {
    assert.deepEqual(parseTags('a,b,c'), ['a', 'b', 'c']);
    assert.deepEqual(parseTags('a, b ,  c '), ['a', 'b', 'c']);
  });

  test('handles empty and missing tag strings', () => {
    assert.deepEqual(parseTags(''), []);
    assert.deepEqual(parseTags(null), []);
    assert.deepEqual(parseTags(undefined), []);
    assert.deepEqual(parseTags(',,'), []);
  });
});

describe('isOwned', () => {
  test('accepts a torrent matching category, tag and hash', () => {
    assert.ok(isOwned(torrent(), claim));
  });

  test('accepts our tag alongside other tags', () => {
    assert.ok(isOwned(torrent({ tags: `manual,${TAG},keep` }), claim));
  });

  test('compares the hash case-insensitively', () => {
    assert.ok(isOwned(torrent({ hash: 'ABC123' }), claim));
  });

  test('rejects a torrent belonging to another application', () => {
    assert.ok(!isOwned(torrent({ category: 'sonarr' }), claim));
    assert.ok(!isOwned(torrent({ category: '' }), claim));
    assert.ok(!isOwned(torrent({ category: null }), claim));
  });

  test('rejects our own category when the request tag is absent', () => {
    // Another Songarr request's torrent shares the category but not the tag.
    assert.ok(!isOwned(torrent({ tags: 'songarr-request-other' }), claim));
    assert.ok(!isOwned(torrent({ tags: '' }), claim));
    assert.ok(!isOwned(torrent({ tags: null }), claim));
  });

  test('rejects a tag that merely contains ours as a substring', () => {
    assert.ok(!isOwned(torrent({ tags: `${TAG}-extra` }), claim));
  });

  test('rejects a different hash even with the right category and tag', () => {
    assert.ok(!isOwned(torrent({ hash: 'deadbeef' }), claim));
  });

  test('skips the hash check while the hash is still unknown', () => {
    const unresolved: OwnershipClaim = { category: 'songarr', tag: TAG, hash: null };
    assert.ok(isOwned(torrent({ hash: 'anything' }), unresolved));
  });
});

describe('assertOwned', () => {
  test('returns the torrent when every check passes', () => {
    const subject = torrent();
    assert.equal(assertOwned(subject, claim), subject);
  });

  test('names the failing check in the error', () => {
    assert.throws(() => assertOwned(torrent({ category: 'radarr' }), claim), /category/);
    assert.throws(() => assertOwned(torrent({ tags: 'other' }), claim), /request tag/);
    assert.throws(() => assertOwned(torrent({ hash: 'ffff' }), claim), /expected hash/);
  });

  test('throws OwnershipError specifically', () => {
    assert.throws(() => assertOwned(torrent({ category: 'radarr' }), claim), OwnershipError);
  });
});

describe('selectOwned', () => {
  test('picks our torrent out of a mixed listing', () => {
    const listing = [
      torrent({ hash: 'sonarr1', category: 'tv-sonarr', tags: '' }),
      torrent({ hash: 'manual1', category: '', tags: '' }),
      torrent(),
    ];
    assert.equal(selectOwned(listing, claim)?.hash, 'abc123');
  });

  test('returns null when the torrent has not appeared yet', () => {
    assert.equal(selectOwned([], claim), null);
    assert.equal(selectOwned([torrent({ category: 'sonarr' })], claim), null);
  });

  test('throws when a request tag matched more than one torrent', () => {
    const duplicated = [torrent({ hash: 'aaa' }), torrent({ hash: 'bbb' })];
    const unresolved: OwnershipClaim = { category: 'songarr', tag: TAG, hash: null };
    assert.throws(() => selectOwned(duplicated, unresolved), /exactly one/);
  });

  test('never returns a torrent owned by another Arr application', () => {
    const foreign = [
      { hash: 'x', category: 'tv-sonarr', tags: 'sonarr' },
      { hash: 'y', category: 'radarr', tags: '' },
      { hash: 'z', category: 'music-lidarr', tags: 'lidarr' },
    ];
    assert.equal(selectOwned(foreign, claim), null);
  });
});
