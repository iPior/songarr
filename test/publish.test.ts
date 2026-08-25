import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';
import { promisify } from 'node:util';

import { probeAudio, FfprobeError } from '../src/spike/ffprobe.ts';
import { publishToReady, PublishError, PROCESSING_DIR, verifySource } from '../src/spike/publish.ts';

const execFileAsync = promisify(execFile);

interface Workspace {
  downloadRoot: string;
  readyRoot: string;
}

async function workspace(): Promise<Workspace> {
  const base = await mkdtemp(path.join(tmpdir(), 'songarr-publish-'));
  const downloadRoot = path.join(base, 'downloads');
  const readyRoot = path.join(base, 'ready');
  await mkdir(downloadRoot);
  await mkdir(readyRoot);
  return { downloadRoot, readyRoot };
}

/** Generate a real, decodable audio file so the ffprobe assertions mean something. */
async function generateAudio(target: string, seconds = 1): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    target,
  ]);
}

describe('verifySource', () => {
  test('accepts a real file beneath the download root', async () => {
    const { downloadRoot } = await workspace();
    const relative = path.join('Album', 'track.flac');
    await generateAudio(path.join(downloadRoot, relative));

    const source = await verifySource(downloadRoot, relative, { recheckDelayMs: 1 });
    assert.ok(source.size > 0);
    assert.ok(source.absolutePath.endsWith(path.join('Album', 'track.flac')));
  });

  test('refuses a path that escapes the download root', async () => {
    const { downloadRoot } = await workspace();
    await assert.rejects(
      () => verifySource(downloadRoot, '../../etc/passwd', { recheckDelayMs: 1 }),
      (error: PublishError) => error.code === 'SOURCE_PATH_UNSAFE',
    );
  });

  test('refuses a symlink pointing outside the download root', async () => {
    const { downloadRoot, readyRoot } = await workspace();
    const outside = path.join(readyRoot, 'elsewhere.flac');
    await generateAudio(outside);
    await symlink(outside, path.join(downloadRoot, 'link.flac'));

    await assert.rejects(
      () => verifySource(downloadRoot, 'link.flac', { recheckDelayMs: 1 }),
      (error: PublishError) => error.code === 'SOURCE_PATH_UNSAFE',
    );
  });

  test('reports a missing source with path-mapping guidance', async () => {
    const { downloadRoot } = await workspace();
    await assert.rejects(
      () => verifySource(downloadRoot, 'nope.flac', { recheckDelayMs: 1 }),
      (error: PublishError) => error.code === 'SOURCE_MISSING' && /same download path/.test(error.message),
    );
  });

  test('rejects a directory and a zero-byte file', async () => {
    const { downloadRoot } = await workspace();
    await mkdir(path.join(downloadRoot, 'adir'));
    await writeFile(path.join(downloadRoot, 'empty.flac'), '');

    await assert.rejects(
      () => verifySource(downloadRoot, 'adir', { recheckDelayMs: 1 }),
      (error: PublishError) => error.code === 'SOURCE_NOT_A_FILE',
    );
    await assert.rejects(
      () => verifySource(downloadRoot, 'empty.flac', { recheckDelayMs: 1 }),
      (error: PublishError) => error.code === 'SOURCE_EMPTY',
    );
  });

  test('detects a file that is still being written', async () => {
    const { downloadRoot } = await workspace();
    const target = path.join(downloadRoot, 'growing.flac');
    await writeFile(target, 'a'.repeat(1000));

    // Grow the file inside the recheck window.
    const grow = setTimeout(() => void writeFile(target, 'a'.repeat(5000)), 10);
    await assert.rejects(
      () => verifySource(downloadRoot, 'growing.flac', { recheckDelayMs: 60 }),
      (error: PublishError) => error.code === 'SOURCE_UNSTABLE',
    );
    clearTimeout(grow);
  });
});

describe('probeAudio', () => {
  test('accepts a real audio file and reports its stream', async () => {
    const { downloadRoot } = await workspace();
    const target = path.join(downloadRoot, 'tone.flac');
    await generateAudio(target);

    const probe = await probeAudio(target);
    assert.equal(probe.codec, 'flac');
    assert.ok((probe.durationSec ?? 0) > 0.5);
    assert.ok((probe.channels ?? 0) >= 1);
  });

  test('rejects a text file wearing an .mp3 extension', async () => {
    const { downloadRoot } = await workspace();
    const target = path.join(downloadRoot, 'fake.mp3');
    await writeFile(target, 'this is definitely not audio\n'.repeat(100));

    await assert.rejects(
      () => probeAudio(target),
      (error: FfprobeError) => error.code === 'FFPROBE_REJECTED' || error.code === 'NO_AUDIO_STREAM',
    );
  });

  test('rejects a text file wearing a .flac extension, which ffprobe calls "raw FLAC"', async () => {
    const { downloadRoot } = await workspace();
    const target = path.join(downloadRoot, 'fake.flac');
    await writeFile(target, 'not audio at all\n'.repeat(200));

    // ffprobe reports an audio stream here purely from the extension (probe_score 1,
    // sample_rate 0, channels 0), so "has an audio stream" alone is not enough.
    await assert.rejects(
      () => probeAudio(target),
      (error: FfprobeError) => error.code === 'NO_AUDIO_STREAM',
    );
  });

  test('reports a missing ffprobe binary distinctly', async () => {
    const { downloadRoot } = await workspace();
    const target = path.join(downloadRoot, 'tone.flac');
    await generateAudio(target);

    await assert.rejects(
      () => probeAudio(target, '/nonexistent/ffprobe'),
      (error: FfprobeError) => error.code === 'FFPROBE_NOT_FOUND',
    );
  });
});

describe('publishToReady', () => {
  const nameParts = {
    artist: 'Daft Punk',
    title: 'Around the World',
    version: null,
    extension: '.flac',
  };

  test('copies through .processing and lands at the final path', async () => {
    const { downloadRoot, readyRoot } = await workspace();
    const sourcePath = path.join(downloadRoot, 'track.flac');
    await generateAudio(sourcePath);

    const result = await publishToReady({ readyRoot, sourcePath, nameParts, requestId: 'req-1' });

    assert.equal(
      result.readyPath,
      path.join(readyRoot, 'Daft Punk', 'Daft Punk - Around the World.flac'),
    );
    assert.equal(result.relativePath, path.join('Daft Punk', 'Daft Punk - Around the World.flac'));

    // The copy is byte-identical.
    assert.deepEqual(await readFile(result.readyPath), await readFile(sourcePath));
    assert.equal(result.size, (await stat(sourcePath)).size);
  });

  test('leaves nothing behind in .processing', async () => {
    const { downloadRoot, readyRoot } = await workspace();
    const sourcePath = path.join(downloadRoot, 'track.flac');
    await generateAudio(sourcePath);

    await publishToReady({ readyRoot, sourcePath, nameParts, requestId: 'req-2' });
    assert.deepEqual(await readdir(path.join(readyRoot, PROCESSING_DIR)), []);
  });

  test('never modifies or removes the qBittorrent source, so seeding survives', async () => {
    const { downloadRoot, readyRoot } = await workspace();
    const sourcePath = path.join(downloadRoot, 'track.flac');
    await generateAudio(sourcePath);
    const before = await stat(sourcePath);

    await publishToReady({ readyRoot, sourcePath, nameParts, requestId: 'req-3' });

    const after = await stat(sourcePath);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
  });

  test('refuses to overwrite an existing ready file', async () => {
    const { downloadRoot, readyRoot } = await workspace();
    const sourcePath = path.join(downloadRoot, 'track.flac');
    await generateAudio(sourcePath);

    await publishToReady({ readyRoot, sourcePath, nameParts, requestId: 'req-4' });

    await assert.rejects(
      () => publishToReady({ readyRoot, sourcePath, nameParts, requestId: 'req-4' }),
      (error: PublishError) => error.code === 'DESTINATION_EXISTS',
    );
  });

  test('leaves the existing file untouched when it refuses', async () => {
    const { downloadRoot, readyRoot } = await workspace();
    const sourcePath = path.join(downloadRoot, 'track.flac');
    await generateAudio(sourcePath);

    const destination = path.join(readyRoot, 'Daft Punk', 'Daft Punk - Around the World.flac');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, 'PRE-EXISTING');

    await assert.rejects(() =>
      publishToReady({ readyRoot, sourcePath, nameParts, requestId: 'req-5' }),
    );

    assert.equal(await readFile(destination, 'utf8'), 'PRE-EXISTING');
    // And no scratch file was orphaned.
    assert.deepEqual(await readdir(path.join(readyRoot, PROCESSING_DIR)).catch(() => []), []);
  });

  test('sanitizes a hostile artist and title into the ready root', async () => {
    const { downloadRoot, readyRoot } = await workspace();
    const sourcePath = path.join(downloadRoot, 'track.mp3');
    await generateAudio(sourcePath);

    const result = await publishToReady({
      readyRoot,
      sourcePath,
      requestId: 'req-6',
      nameParts: { artist: '../../etc', title: 'passwd', version: null, extension: '.mp3' },
    });

    assert.ok(result.readyPath.startsWith(readyRoot + path.sep));
    assert.ok(!result.readyPath.includes('..'));
    assert.equal(result.relativePath, path.join('etc', 'etc - passwd.mp3'));
  });

  test('includes the version in the output name when one was requested', async () => {
    const { downloadRoot, readyRoot } = await workspace();
    const sourcePath = path.join(downloadRoot, 'track.flac');
    await generateAudio(sourcePath);

    const result = await publishToReady({
      readyRoot,
      sourcePath,
      requestId: 'req-7',
      nameParts: { ...nameParts, version: 'Radio Edit' },
    });

    assert.ok(result.readyPath.endsWith('Daft Punk - Around the World (Radio Edit).flac'));
  });
});
