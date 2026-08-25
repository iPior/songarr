/**
 * Release format inference and preference ranking (PRD 14.1).
 *
 * These are *hints only*. Nothing here filters a release out - the user still picks from the
 * full result list. Ranking exists so the likely-right release floats to the top of the table.
 */

export type QualityPreference = 'flac' | 'mp3_320' | 'any';

export const QUALITY_PREFERENCES: readonly QualityPreference[] = ['flac', 'mp3_320', 'any'];

export function isQualityPreference(value: string): value is QualityPreference {
  return (QUALITY_PREFERENCES as readonly string[]).includes(value);
}

/** The container/bitrate we could infer from a release title. `unknown` when nothing matched. */
export type InferredFormat =
  | 'FLAC 24bit'
  | 'FLAC'
  | 'MP3 320'
  | 'MP3 V0'
  | 'MP3'
  | 'AAC'
  | 'ALAC'
  | 'WAV'
  | 'unknown';

/** The container extension we would prefer for a given quality preference. */
export function preferredExtensionFor(preference: QualityPreference): string | null {
  switch (preference) {
    case 'flac':
      return '.flac';
    case 'mp3_320':
      return '.mp3';
    case 'any':
      return null;
  }
}

/**
 * Infer a format from a scene/indexer release title. Ordered most specific first, because
 * "FLAC 24bit 96kHz" also matches the plain FLAC pattern.
 */
export function inferFormat(releaseTitle: string): InferredFormat {
  const title = ` ${(releaseTitle ?? '').toLowerCase().replace(/[[\]()_,]/g, ' ').replace(/\s+/g, ' ')} `;

  const has = (pattern: RegExp): boolean => pattern.test(title);

  if (has(/\bflac\b/) && has(/\b24\s?bit\b|\b24b\b|\bhi-?res\b/)) return 'FLAC 24bit';
  if (has(/\bflac\b|\blossless\b/)) return 'FLAC';
  if (has(/\balac\b/)) return 'ALAC';
  if (has(/\bwav\b/)) return 'WAV';
  if (has(/\bmp3\b|\bcbr\b|\bvbr\b/) || has(/\b320\s?kbps\b|\b320k?\b/)) {
    if (has(/\b320\b|\b320k\b|\b320kbps\b/)) return 'MP3 320';
    if (has(/\bv0\b/)) return 'MP3 V0';
    return 'MP3';
  }
  if (has(/\baac\b|\bm4a\b/)) return 'AAC';
  return 'unknown';
}

/** Higher is better, for the given preference. Used only for sorting the results table. */
export function formatRank(format: InferredFormat, preference: QualityPreference): number {
  const lossless = format === 'FLAC' || format === 'FLAC 24bit' || format === 'ALAC' || format === 'WAV';

  switch (preference) {
    case 'flac':
      if (lossless) return 3;
      if (format === 'MP3 320' || format === 'MP3 V0') return 2;
      if (format === 'unknown') return 0;
      return 1;
    case 'mp3_320':
      if (format === 'MP3 320') return 3;
      if (lossless || format === 'MP3 V0') return 2;
      if (format === 'unknown') return 0;
      return 1;
    case 'any':
      return format === 'unknown' ? 0 : 1;
  }
}

export interface RankableRelease {
  title: string;
  seeders?: number | null;
  size?: number | null;
}

export interface RankedRelease<T extends RankableRelease> {
  release: T;
  format: InferredFormat;
  rank: number;
}

/**
 * Sort releases by format fit, then seeders. Never removes anything - the user chooses
 * from the complete list (PRD 9.3, 14.1).
 */
export function rankReleases<T extends RankableRelease>(
  releases: readonly T[],
  preference: QualityPreference,
): RankedRelease<T>[] {
  return releases
    .map((release) => {
      const format = inferFormat(release.title);
      return { release, format, rank: formatRank(format, preference) };
    })
    .sort((a, b) => b.rank - a.rank || (b.release.seeders ?? 0) - (a.release.seeders ?? 0));
}
