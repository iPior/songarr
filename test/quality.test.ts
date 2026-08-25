import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  formatRank,
  inferFormat,
  isQualityPreference,
  preferredExtensionFor,
  rankReleases,
} from '../src/spike/quality.ts';

describe('inferFormat', () => {
  test('reads lossless hints out of a release title', () => {
    assert.equal(inferFormat('Daft Punk - Homework (1997) [FLAC]'), 'FLAC');
    assert.equal(inferFormat('Artist - Album [Lossless]'), 'FLAC');
    assert.equal(inferFormat('Artist - Album (2020) FLAC 24bit 96kHz'), 'FLAC 24bit');
    assert.equal(inferFormat('Artist - Album [Hi-Res FLAC]'), 'FLAC 24bit');
  });

  test('reads MP3 bitrate hints', () => {
    assert.equal(inferFormat('Artist - Track [MP3 320]'), 'MP3 320');
    assert.equal(inferFormat('Artist - Track (MP3-320kbps)'), 'MP3 320');
    assert.equal(inferFormat('Artist - Track [MP3 V0]'), 'MP3 V0');
    assert.equal(inferFormat('Artist - Track [MP3 CBR 192]'), 'MP3');
  });

  test('reads the remaining supported containers', () => {
    assert.equal(inferFormat('Artist - Album [ALAC]'), 'ALAC');
    assert.equal(inferFormat('Artist - Album [WAV]'), 'WAV');
    assert.equal(inferFormat('Artist - Album [AAC 256]'), 'AAC');
  });

  test('returns unknown rather than guessing', () => {
    assert.equal(inferFormat('Artist - Some Album (2021)'), 'unknown');
    assert.equal(inferFormat(''), 'unknown');
  });

  test('is case-insensitive and tolerates bracket styles', () => {
    assert.equal(inferFormat('artist_-_album_flac'), 'FLAC');
    assert.equal(inferFormat('Artist - Album (flac)'), 'FLAC');
  });
});

describe('formatRank', () => {
  test('flac preference ranks lossless first but never rejects MP3', () => {
    assert.ok(formatRank('FLAC', 'flac') > formatRank('MP3 320', 'flac'));
    assert.ok(formatRank('MP3 320', 'flac') > formatRank('unknown', 'flac'));
    // Ranking only - an MP3 still scores above nothing (PRD 14.1).
    assert.ok(formatRank('MP3', 'flac') > 0);
  });

  test('mp3_320 preference ranks MP3 320 first but keeps FLAC competitive', () => {
    assert.ok(formatRank('MP3 320', 'mp3_320') > formatRank('FLAC', 'mp3_320'));
    assert.ok(formatRank('FLAC', 'mp3_320') > formatRank('MP3', 'mp3_320'));
  });

  test('any preference does not prefer a specific format', () => {
    assert.equal(formatRank('FLAC', 'any'), formatRank('MP3', 'any'));
    assert.ok(formatRank('FLAC', 'any') > formatRank('unknown', 'any'));
  });
});

describe('preferredExtensionFor', () => {
  test('maps a preference to a container hint', () => {
    assert.equal(preferredExtensionFor('flac'), '.flac');
    assert.equal(preferredExtensionFor('mp3_320'), '.mp3');
    assert.equal(preferredExtensionFor('any'), null);
  });
});

describe('isQualityPreference', () => {
  test('accepts only the three MVP options', () => {
    assert.ok(isQualityPreference('flac'));
    assert.ok(isQualityPreference('mp3_320'));
    assert.ok(isQualityPreference('any'));
    assert.ok(!isQualityPreference('FLAC'));
    assert.ok(!isQualityPreference('lossless'));
  });
});

describe('rankReleases', () => {
  const releases = [
    { title: 'Daft Punk - Homework [MP3 320]', seeders: 50 },
    { title: 'Daft Punk - Homework [FLAC]', seeders: 10 },
    { title: 'Daft Punk - Homework', seeders: 100 },
  ];

  test('floats the preferred format to the top', () => {
    const ranked = rankReleases(releases, 'flac');
    assert.match(ranked[0]!.release.title, /FLAC/);
    assert.equal(ranked[0]!.format, 'FLAC');
  });

  test('never drops a release from the list', () => {
    assert.equal(rankReleases(releases, 'flac').length, releases.length);
    assert.equal(rankReleases(releases, 'mp3_320').length, releases.length);
    assert.equal(rankReleases([], 'any').length, 0);
  });

  test('breaks ties on seeders', () => {
    const ranked = rankReleases(
      [
        { title: 'A [FLAC]', seeders: 5 },
        { title: 'B [FLAC]', seeders: 500 },
      ],
      'flac',
    );
    assert.equal(ranked[0]!.release.title, 'B [FLAC]');
  });

  test('sorts unknown formats last without removing them', () => {
    const ranked = rankReleases(releases, 'flac');
    assert.equal(ranked.at(-1)!.format, 'unknown');
  });

  test('treats a missing seeder count as zero rather than throwing', () => {
    const ranked = rankReleases([{ title: 'A [FLAC]' }, { title: 'B [FLAC]', seeders: 1 }], 'flac');
    assert.equal(ranked[0]!.release.title, 'B [FLAC]');
  });
});
