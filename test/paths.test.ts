import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';

import {
  buildReadyFilename,
  buildReadyRelPath,
  resolveWithinRoot,
  resolveWithinRootReal,
  sanitizeExtension,
  sanitizeSegment,
  UnsafePathError,
} from '../src/spike/paths.ts';

describe('sanitizeSegment', () => {
  test('strips path separators so a segment can never become two', () => {
    assert.equal(sanitizeSegment('AC/DC'), 'AC DC');
    assert.equal(sanitizeSegment('back\\slash'), 'back slash');
    assert.ok(!sanitizeSegment('a/b/c').includes(path.sep));
  });

  test('neutralises traversal tokens', () => {
    assert.equal(sanitizeSegment('..'), 'unknown');
    assert.equal(sanitizeSegment('.'), 'unknown');
    assert.equal(sanitizeSegment('../../etc/passwd'), 'etc passwd');
  });

  test('strips control characters and NUL', () => {
    assert.equal(sanitizeSegment('Track\u0000Name'), 'Track Name');
    assert.equal(sanitizeSegment('Bell\u0007Tune'), 'Bell Tune');
    assert.equal(sanitizeSegment('Line\nBreak'), 'Line Break');
  });

  test('removes Windows-illegal punctuation', () => {
    assert.equal(sanitizeSegment('Who? What: Where*'), 'Who What Where');
    assert.equal(sanitizeSegment('a<b>c|d"e'), 'a b c d e');
  });

  test('drops leading dots and trailing dots or spaces', () => {
    assert.equal(sanitizeSegment('.hidden'), 'hidden');
    assert.equal(sanitizeSegment('trailing.'), 'trailing');
    assert.equal(sanitizeSegment('  padded  '), 'padded');
  });

  test('escapes Windows reserved device names', () => {
    assert.equal(sanitizeSegment('CON'), '_CON');
    assert.equal(sanitizeSegment('nul'), '_nul');
    assert.equal(sanitizeSegment('COM1'), '_COM1');
    // Not reserved once it is part of a longer name.
    assert.equal(sanitizeSegment('Contour'), 'Contour');
  });

  test('never returns an empty segment', () => {
    assert.equal(sanitizeSegment(''), 'unknown');
    assert.equal(sanitizeSegment('///'), 'unknown');
    assert.equal(sanitizeSegment('***', 'Unknown Artist'), 'Unknown Artist');
  });

  test('caps a segment at 255 bytes without splitting a character', () => {
    const result = sanitizeSegment('é'.repeat(300));
    assert.ok(Buffer.byteLength(result, 'utf8') <= 255);
    // A split surrogate/continuation byte would show up as a replacement character.
    assert.ok(!result.includes('�'));
  });

  test('preserves legitimate punctuation and non-ASCII text', () => {
    assert.equal(sanitizeSegment("Don't Stop Me Now"), "Don't Stop Me Now");
    assert.equal(sanitizeSegment('Beyoncé'), 'Beyoncé');
    assert.equal(sanitizeSegment('Sigur Rós - Hoppípolla'), 'Sigur Rós - Hoppípolla');
  });
});

describe('sanitizeExtension', () => {
  test('normalises to a lowercase dotted extension', () => {
    assert.equal(sanitizeExtension('FLAC'), '.flac');
    assert.equal(sanitizeExtension('.Mp3'), '.mp3');
  });

  test('rejects anything that is not a plain alphanumeric extension', () => {
    assert.equal(sanitizeExtension('../sh'), '.bin');
    assert.equal(sanitizeExtension('tar.gz'), '.bin');
    assert.equal(sanitizeExtension(''), '.bin');
    assert.equal(sanitizeExtension('waytoolongextension'), '.bin');
  });
});

describe('buildReadyFilename', () => {
  test('produces the PRD output shape', () => {
    assert.equal(
      buildReadyFilename({ artist: 'Daft Punk', title: 'Around the World', extension: '.flac' }),
      'Daft Punk - Around the World.flac',
    );
    assert.equal(
      buildReadyFilename({
        artist: 'Daft Punk',
        title: 'Around the World',
        version: 'Radio Edit',
        extension: 'flac',
      }),
      'Daft Punk - Around the World (Radio Edit).flac',
    );
  });

  test('is deterministic for the same input', () => {
    const parts = { artist: 'AC/DC', title: 'T.N.T.', version: null, extension: '.mp3' };
    assert.equal(buildReadyFilename(parts), buildReadyFilename(parts));
  });

  test('keeps filesystem-unsafe titles safe', () => {
    const name = buildReadyFilename({
      artist: '../../etc',
      title: 'passwd\u0000',
      extension: '.mp3',
    });
    assert.equal(name, 'etc - passwd.mp3');
    assert.ok(!name.includes('/'));
    assert.ok(!name.includes('\u0000'));
  });

  test('caps the whole name, extension included, at 255 bytes', () => {
    const name = buildReadyFilename({
      artist: 'a'.repeat(300),
      title: 'b'.repeat(300),
      extension: '.flac',
    });
    assert.ok(Buffer.byteLength(name, 'utf8') <= 255);
    assert.ok(name.endsWith('.flac'));
  });
});

describe('buildReadyRelPath', () => {
  test('nests the file under a sanitized artist directory', () => {
    assert.equal(
      buildReadyRelPath({ artist: 'Daft Punk', title: 'Da Funk', extension: '.flac' }),
      path.join('Daft Punk', 'Daft Punk - Da Funk.flac'),
    );
  });

  test('a hostile artist cannot introduce extra directory levels', () => {
    const rel = buildReadyRelPath({ artist: '../../etc', title: 'x', extension: '.mp3' });
    assert.equal(rel.split(path.sep).length, 2);
    assert.ok(!rel.includes('..'));
  });
});

describe('resolveWithinRoot', () => {
  const root = '/data/ready';

  test('resolves a relative path beneath the root', () => {
    assert.equal(resolveWithinRoot(root, 'Artist/Track.flac'), '/data/ready/Artist/Track.flac');
  });

  test('rejects traversal out of the root', () => {
    assert.throws(() => resolveWithinRoot(root, '../secrets.txt'), UnsafePathError);
    assert.throws(() => resolveWithinRoot(root, 'Artist/../../secrets.txt'), UnsafePathError);
    assert.throws(() => resolveWithinRoot(root, 'a/b/c/../../../../etc/passwd'), UnsafePathError);
  });

  test('rejects an absolute path outside the root', () => {
    assert.throws(() => resolveWithinRoot(root, '/etc/passwd'), UnsafePathError);
  });

  test('accepts an absolute path that is genuinely inside the root', () => {
    assert.equal(resolveWithinRoot(root, '/data/ready/Artist/Track.flac'), '/data/ready/Artist/Track.flac');
  });

  test('rejects a sibling directory sharing the root prefix', () => {
    // The classic bug: "/data/ready-backup".startsWith("/data/ready") is true.
    assert.throws(() => resolveWithinRoot(root, '/data/ready-backup/x.flac'), UnsafePathError);
    assert.throws(() => resolveWithinRoot(root, '../readyother/x.flac'), UnsafePathError);
  });

  test('rejects the root itself', () => {
    assert.throws(() => resolveWithinRoot(root, '.'), UnsafePathError);
    assert.throws(() => resolveWithinRoot(root, '/data/ready'), UnsafePathError);
  });

  test('tolerates a trailing separator on the root', () => {
    assert.equal(resolveWithinRoot('/data/ready/', 'x.flac'), '/data/ready/x.flac');
    assert.throws(() => resolveWithinRoot('/data/ready/', '../x.flac'), UnsafePathError);
  });

  test('requires an absolute root', () => {
    assert.throws(() => resolveWithinRoot('relative/root', 'x.flac'), UnsafePathError);
  });
});

describe('resolveWithinRootReal', () => {
  test('rejects a symlink that points outside the root', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'songarr-paths-'));
    const root = path.join(base, 'downloads');
    const outside = path.join(base, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.flac'), 'nope');
    await symlink(outside, path.join(root, 'escape'));

    // Lexically this looks fine - only realpath exposes the escape.
    assert.equal(resolveWithinRoot(root, 'escape/secret.flac'), path.join(root, 'escape/secret.flac'));
    await assert.rejects(() => resolveWithinRootReal(root, 'escape/secret.flac'), UnsafePathError);
  });

  test('accepts a real file inside the root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'songarr-paths-'));
    await mkdir(path.join(root, 'Album'));
    const file = path.join(root, 'Album', 'track.flac');
    await writeFile(file, 'x');

    assert.equal(await resolveWithinRootReal(root, 'Album/track.flac'), await realish(file));
  });

  test('accepts a path that does not exist yet, inside the root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'songarr-paths-'));
    const resolved = await resolveWithinRootReal(root, 'Not/Created/Yet.flac');
    assert.ok(resolved.endsWith(path.join('Not', 'Created', 'Yet.flac')));
  });
});

/** macOS puts temp dirs behind a /private symlink, so compare against the resolved form. */
async function realish(target: string): Promise<string> {
  const { realpath } = await import('node:fs/promises');
  return realpath(target);
}
