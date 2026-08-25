/**
 * Deterministic, explainable file matching (PRD 14.2).
 *
 * The MVP never picks a file on its own - this only produces a ranked, annotated
 * recommendation for a human to confirm. Every score carries the reasons that produced it
 * so the UI (and a test) can show exactly why a file was proposed.
 */

import path from 'node:path';

/** Audio extensions the MVP supports (PRD 9.4). */
export const SUPPORTED_AUDIO_EXTENSIONS = ['.flac', '.mp3', '.m4a', '.aac', '.alac', '.wav'] as const;

export type SupportedAudioExtension = (typeof SUPPORTED_AUDIO_EXTENSIONS)[number];

/**
 * Version words that indicate a *different* recording. If the user did not ask for one of
 * these and the filename advertises it, the file is very likely the wrong take.
 */
const VERSION_TERMS = [
  'live', 'remix', 'instrumental', 'radio edit', 'extended mix', 'extended', 'acoustic',
  'karaoke', 'demo', 'edit', 'dub', 'club mix', 'vip mix', 'bootleg', 'mashup', 'rework',
  'reprise', 'a cappella', 'acapella', 'intro', 'interlude', 'skit',
];

export interface TrackRequest {
  artist: string;
  title: string;
  version?: string | null;
  /** Preferred container, e.g. `.flac`. Only a ranking hint. */
  preferredExtension?: string | null;
}

export interface TorrentFileLike {
  /** qBittorrent file index (or array position on pre-2.8.2 WebAPI). */
  index: number;
  /** Path relative to the torrent root, as reported by qBittorrent. Untrusted. */
  name: string;
  size: number;
}

export type Confidence = 'High' | 'Medium' | 'Low';

export interface ScoredFile<T extends TorrentFileLike = TorrentFileLike> {
  file: T;
  /** Ordering score: identity evidence plus the format-preference hint. */
  score: number;
  /**
   * Identity evidence only, with the format hint excluded. Confidence answers "is this the
   * requested recording", which must not change just because the container differs.
   */
  identityScore: number;
  reasons: string[];
  confidence: Confidence;
  isSupportedAudio: boolean;
}

/**
 * Fold a display string down to a comparable form: lowercase, no diacritics, no punctuation.
 * Used for both duplicate comparison and filename matching, so it must be stable.
 */
export function normalize(raw: string): string {
  return (raw ?? '')
    .normalize('NFKD')
    // Strip the combining marks NFKD leaves behind, so "Beyoncé" folds to "beyonce".
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[_\-.]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The lowercase extension of a torrent-relative path, including the leading dot. */
export function fileExtension(name: string): string {
  return path.posix.extname(name.replace(/\\/g, '/')).toLowerCase();
}

export function isSupportedAudio(name: string): boolean {
  return (SUPPORTED_AUDIO_EXTENSIONS as readonly string[]).includes(fileExtension(name));
}

/** Filename without directories or extension, normalized. */
function normalizedStem(name: string): string {
  const posix = name.replace(/\\/g, '/');
  const base = path.posix.basename(posix);
  return normalize(base.slice(0, base.length - path.posix.extname(base).length));
}

/** Every parent directory of a torrent-relative path, normalized. */
function normalizedParents(name: string): string {
  const posix = name.replace(/\\/g, '/');
  return normalize(path.posix.dirname(posix));
}

/**
 * Strip a leading track number so "07 - Around The World" still matches "around the world"
 * at the start of the stem. Handles "07", "07 -", "07.", "1-07" and "a1" (vinyl) prefixes.
 */
export function stripTrackNumber(normalizedName: string): string {
  return normalizedName.replace(/^(?:[a-d]?\d{1,3}(?:\s+\d{1,3})?)\s+/, '').trim();
}

/** Version terms present in a normalized string, matched on word boundaries. */
function versionTermsIn(normalized: string): string[] {
  const padded = ` ${normalized} `;
  return VERSION_TERMS.filter((term) => padded.includes(` ${term} `));
}

/**
 * Score one torrent file against the request. Positive points for evidence that this is the
 * requested recording, negative for evidence that it is a different one.
 */
export function scoreAudioFile<T extends TorrentFileLike>(file: T, request: TrackRequest): ScoredFile<T> {
  const reasons: string[] = [];
  let score = 0;

  const extension = fileExtension(file.name);
  const supported = isSupportedAudio(file.name);

  if (!supported) {
    return {
      file,
      score: -1000,
      identityScore: -1000,
      reasons: [`Unsupported extension "${extension || 'none'}"`],
      confidence: 'Low',
      isSupportedAudio: false,
    };
  }

  const stem = normalizedStem(file.name);
  const stemNoTrack = stripTrackNumber(stem);
  const parents = normalizedParents(file.name);
  const haystack = `${parents} ${stem}`.trim();

  const title = normalize(request.title);
  const artist = normalize(request.artist);
  const version = request.version ? normalize(request.version) : '';

  // Title is the strongest signal available.
  if (title) {
    if (stemNoTrack === title || stem === title) {
      score += 60;
      reasons.push('Filename is exactly the requested title');
    } else if (` ${stem} `.includes(` ${title} `)) {
      score += 45;
      reasons.push('Filename contains the requested title');
    } else if (stem.includes(title)) {
      score += 30;
      reasons.push('Filename contains the requested title as a substring');
    } else {
      score -= 25;
      reasons.push('Filename does not contain the requested title');
    }
  }

  if (artist) {
    if (` ${stem} `.includes(` ${artist} `)) {
      score += 20;
      reasons.push('Artist appears in the filename');
    } else if (` ${parents} `.includes(` ${artist} `)) {
      score += 12;
      reasons.push('Artist appears in a parent folder');
    }
  }

  // Version handling: reward the requested one, punish a competing one.
  const requestedTerms = version ? versionTermsIn(version) : [];
  const fileTerms = versionTermsIn(haystack);

  if (version) {
    if (` ${haystack} `.includes(` ${version} `)) {
      score += 30;
      reasons.push(`Requested version "${request.version}" appears in the path`);
    } else {
      score -= 15;
      reasons.push(`Requested version "${request.version}" is absent`);
    }
  }

  const conflicting = fileTerms.filter((term) => !requestedTerms.includes(term) && !version.includes(term));
  if (conflicting.length > 0) {
    score -= 20 * conflicting.length;
    reasons.push(`Conflicting version term(s): ${conflicting.join(', ')}`);
  }

  // A cover-art-sized "audio" file is almost certainly not a track.
  if (file.size > 0 && file.size < 256 * 1024) {
    score -= 15;
    reasons.push('File is unusually small for an audio track');
  }

  // Everything above is identity evidence. The format hint below only affects ordering.
  const identityScore = score;

  const preferred = request.preferredExtension ? request.preferredExtension.toLowerCase() : '';
  if (preferred && extension === preferred) {
    score += 15;
    reasons.push(`Preferred format ${extension}`);
  } else if (preferred) {
    reasons.push(`Format ${extension} (preferred ${preferred})`);
  }

  return {
    file,
    score,
    identityScore,
    reasons,
    confidence: confidenceFor(identityScore),
    isSupportedAudio: true,
  };
}

/**
 * Thresholds calibrated so that title-plus-artist evidence with no conflicting version term
 * reads as High (45 + 20), and title evidence alone reads as Medium.
 */
export function confidenceFor(identityScore: number): Confidence {
  if (identityScore >= 60) return 'High';
  if (identityScore >= 30) return 'Medium';
  return 'Low';
}

/**
 * Score every file and return them best-first. Unsupported files are kept (the UI shows them
 * but must not let them be selected - PRD 9.4) and always sort last.
 */
export function rankFiles<T extends TorrentFileLike>(files: readonly T[], request: TrackRequest): ScoredFile<T>[] {
  return files
    .map((file) => scoreAudioFile(file, request))
    .sort((a, b) => b.score - a.score || a.file.name.localeCompare(b.file.name));
}

/** The single file to highlight, or null when the torrent holds no supported audio. */
export function recommendFile<T extends TorrentFileLike>(files: readonly T[], request: TrackRequest): ScoredFile<T> | null {
  return rankFiles(files, request).find((scored) => scored.isSupportedAudio) ?? null;
}
