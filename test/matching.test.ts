import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  fileExtension,
  isSupportedAudio,
  normalize,
  rankFiles,
  recommendFile,
  scoreAudioFile,
  stripTrackNumber,
  type TorrentFileLike,
  type TrackRequest,
} from '../src/spike/matching.ts';

const MB = 1024 * 1024;

/** Terse helper: files are identified by index in the assertions below. */
function file(index: number, name: string, size = 30 * MB): TorrentFileLike {
  return { index, name, size };
}

describe('normalize', () => {
  test('folds case, diacritics and punctuation to a comparable form', () => {
    assert.equal(normalize('Beyoncé'), 'beyonce');
    assert.equal(normalize('Sigur Rós'), 'sigur ros');
    assert.equal(normalize("Don't Stop Me Now!"), 'don t stop me now');
    assert.equal(normalize('T.N.T.'), 't n t');
  });

  test('expands ampersands so "Simon & Garfunkel" matches "Simon and Garfunkel"', () => {
    assert.equal(normalize('Simon & Garfunkel'), normalize('Simon and Garfunkel'));
  });

  test('treats underscores, dots and dashes as separators', () => {
    assert.equal(normalize('Around_The-World.Radio'), 'around the world radio');
  });

  test('is idempotent', () => {
    const once = normalize('Björk – Jóga (Live!)');
    assert.equal(normalize(once), once);
  });

  test('tolerates empty input', () => {
    assert.equal(normalize(''), '');
  });
});

describe('extension handling', () => {
  test('reads the extension case-insensitively from a nested path', () => {
    assert.equal(fileExtension('Album/01 Track.FLAC'), '.flac');
    assert.equal(fileExtension('no-extension'), '');
  });

  test('recognises every supported audio extension and nothing else', () => {
    for (const ext of ['.flac', '.mp3', '.m4a', '.aac', '.alac', '.wav']) {
      assert.ok(isSupportedAudio(`track${ext}`), ext);
    }
    for (const ext of ['.cue', '.log', '.jpg', '.nfo', '.txt', '.m3u', '.ogg']) {
      assert.ok(!isSupportedAudio(`file${ext}`), ext);
    }
  });
});

describe('stripTrackNumber', () => {
  test('removes common track-number prefixes', () => {
    assert.equal(stripTrackNumber('07 around the world'), 'around the world');
    assert.equal(stripTrackNumber('1 07 around the world'), 'around the world');
    assert.equal(stripTrackNumber('a1 around the world'), 'around the world');
  });

  test('leaves a title that legitimately starts with a number alone', () => {
    // "99 Problems" is only four characters of digits away from a track number, so this
    // documents the trade-off rather than claiming perfection.
    assert.equal(stripTrackNumber('1979'), '1979');
  });
});

describe('scoreAudioFile', () => {
  const request: TrackRequest = {
    artist: 'Daft Punk',
    title: 'Around the World',
    preferredExtension: '.flac',
  };

  test('scores an exact single-track filename as High confidence', () => {
    const scored = scoreAudioFile(file(0, 'Daft Punk - Around the World.flac'), request);
    assert.equal(scored.confidence, 'High');
    assert.ok(scored.isSupportedAudio);
    assert.ok(scored.reasons.some((reason) => reason.includes('title')));
  });

  test('scores a track-numbered album filename well', () => {
    const scored = scoreAudioFile(file(3, 'Homework/07 - Around the World.flac'), request);
    assert.ok(scored.score > 0);
    assert.ok(scored.isSupportedAudio);
  });

  test('rejects an unsupported extension outright', () => {
    const scored = scoreAudioFile(file(1, 'Homework/cover.jpg'), request);
    assert.equal(scored.isSupportedAudio, false);
    assert.ok(scored.score < -100);
    assert.match(scored.reasons[0]!, /Unsupported extension/);
  });

  test('penalises a conflicting version term', () => {
    const plain = scoreAudioFile(file(0, 'Around the World.flac'), request);
    const remix = scoreAudioFile(file(1, 'Around the World (Remix).flac'), request);
    assert.ok(remix.score < plain.score, `${remix.score} should be below ${plain.score}`);
    assert.ok(remix.reasons.some((reason) => reason.includes('Conflicting')));
  });

  test('rewards the requested version and does not penalise it as a conflict', () => {
    const versioned: TrackRequest = { ...request, version: 'Radio Edit' };
    const match = scoreAudioFile(file(0, 'Around the World (Radio Edit).flac'), versioned);
    const plain = scoreAudioFile(file(1, 'Around the World.flac'), versioned);

    assert.ok(match.score > plain.score);
    assert.ok(match.reasons.some((reason) => reason.includes('Radio Edit')));
    assert.ok(!match.reasons.some((reason) => reason.includes('Conflicting')));
  });

  test('rewards the preferred extension', () => {
    const flac = scoreAudioFile(file(0, 'Around the World.flac'), request);
    const mp3 = scoreAudioFile(file(1, 'Around the World.mp3'), request);
    assert.ok(flac.score > mp3.score);
  });

  test('credits an artist found only in a parent folder', () => {
    const scored = scoreAudioFile(file(0, 'Daft Punk - Homework/07 Around the World.flac'), request);
    assert.ok(scored.reasons.some((reason) => reason.includes('parent folder')));
  });

  test('penalises a file too small to be a track', () => {
    const tiny = scoreAudioFile({ index: 0, name: 'Around the World.flac', size: 40 * 1024 }, request);
    const normal = scoreAudioFile(file(1, 'Around the World.flac'), request);
    assert.ok(tiny.score < normal.score);
  });

  test('penalises a filename that does not contain the title at all', () => {
    const scored = scoreAudioFile(file(0, 'Homework/01 - Daftendirekt.flac'), request);
    assert.ok(scored.score < 0);
    assert.equal(scored.confidence, 'Low');
  });

  test('matches through punctuation differences in the title', () => {
    const punctuated: TrackRequest = { artist: 'Panic! at the Disco', title: 'I Write Sins Not Tragedies' };
    const scored = scoreAudioFile(file(0, 'Panic At The Disco - I Write Sins, Not Tragedies.mp3'), punctuated);
    assert.ok(scored.score > 40);
  });

  test('is deterministic', () => {
    const target = file(0, 'Daft Punk - Around the World.flac');
    assert.deepEqual(scoreAudioFile(target, request), scoreAudioFile(target, request));
  });
});

describe('rankFiles and recommendFile', () => {
  const request: TrackRequest = {
    artist: 'Daft Punk',
    title: 'Around the World',
    preferredExtension: '.flac',
  };

  const album: TorrentFileLike[] = [
    file(0, 'Daft Punk - Homework/01 - Daftendirekt.flac'),
    file(1, 'Daft Punk - Homework/07 - Around the World.flac'),
    file(2, 'Daft Punk - Homework/08 - Around the World (Live).flac'),
    file(3, 'Daft Punk - Homework/folder.jpg', 200 * 1024),
    file(4, 'Daft Punk - Homework/Homework.cue', 2 * 1024),
  ];

  test('recommends the plain album track over the live take', () => {
    const best = recommendFile(album, request);
    assert.equal(best?.file.index, 1);
  });

  test('keeps non-audio files in the ranking but never recommends them', () => {
    const ranked = rankFiles(album, request);
    assert.equal(ranked.length, album.length);

    const nonAudio = ranked.filter((scored) => !scored.isSupportedAudio);
    assert.equal(nonAudio.length, 2);
    // Unsupported files must sort last so the UI can show them without offering them.
    assert.deepEqual(
      ranked.slice(-2).map((scored) => scored.isSupportedAudio),
      [false, false],
    );
  });

  test('returns null when the torrent holds no supported audio', () => {
    const nothing = [file(0, 'readme.nfo'), file(1, 'cover.jpg')];
    assert.equal(recommendFile(nothing, request), null);
  });

  test('picks the single track in a single-track torrent', () => {
    const single = [file(0, 'Daft Punk - Around the World.mp3')];
    const best = recommendFile(single, request);
    assert.equal(best?.file.index, 0);
    assert.equal(best?.confidence, 'High');
  });

  test('ranking is a total order - equal scores break ties by name', () => {
    const ambiguous = [file(1, 'b.flac'), file(0, 'a.flac')];
    const ranked = rankFiles(ambiguous, request);
    assert.deepEqual(
      ranked.map((scored) => scored.file.name),
      ['a.flac', 'b.flac'],
    );
  });

  test('preserves the caller file type through the generic', () => {
    const withPriority = [{ index: 0, name: 'Around the World.flac', size: 30 * MB, priority: 1 }];
    const ranked = rankFiles(withPriority, request);
    assert.equal(ranked[0]!.file.priority, 1);
  });
});
