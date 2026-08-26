/**
 * Filesystem-safety helpers.
 *
 * Two separate concerns live here, and both are security-relevant (PRD 17):
 *
 *  1. Turning user-supplied request metadata into a filesystem-safe output name.
 *  2. Proving that a path derived from untrusted input (notably anything qBittorrent
 *     reports back to us) really does live beneath a configured root.
 */

import { realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * Characters that are illegal or hostile in a path segment on Linux, macOS or Windows:
 * C0 controls and DEL, the path separators, and the Windows-reserved punctuation.
 */
const ILLEGAL_CHARS = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;

/** Windows device names. Illegal there even with an extension, harmless to avoid on Linux. */
const RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

/** ext4 and most other filesystems cap a single name at 255 bytes, not characters. */
const MAX_SEGMENT_BYTES = 255;

export class UnsafePathError extends Error {
  readonly code = 'UNSAFE_PATH';
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

/** Truncate to at most `maxBytes` of UTF-8 without splitting a multi-byte character. */
function truncateBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let out = '';
  let used = 0;
  // Iterating the string yields whole code points, so surrogate pairs stay intact.
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8');
    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }
  return out;
}

/**
 * Make one path segment safe. Never returns an empty string, a traversal token,
 * or anything a filesystem will reject.
 */
export function sanitizeSegment(raw: string, fallback = 'unknown'): string {
  let value = (raw ?? '').normalize('NFC');

  value = value.replace(ILLEGAL_CHARS, ' ');
  // Drop dot-only tokens outright. Replacing separators turns "../../etc" into ".. .. etc",
  // and a leftover ".." carries no information while still reading as a traversal token.
  value = value
    .split(/\s+/)
    .filter((token) => token.length > 0 && !/^\.+$/.test(token))
    .join(' ');
  // Leading dots hide files; trailing dots and spaces are silently dropped by Windows.
  value = value
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim();

  if (RESERVED_NAMES.has(value.toLowerCase())) value = `_${value}`;

  value = truncateBytes(value, MAX_SEGMENT_BYTES)
    .replace(/[. ]+$/, '')
    .trim();

  return value.length > 0 ? value : fallback;
}

/** Normalize a file extension to a safe, lowercase, dot-prefixed form. */
export function sanitizeExtension(raw: string, fallback = '.bin'): string {
  const value = (raw ?? '').trim().toLowerCase().replace(/^\.+/, '');
  if (!/^[a-z0-9]{1,10}$/.test(value)) return fallback;
  return `.${value}`;
}

export interface ReadyNameParts {
  artist: string;
  title: string;
  version?: string | null;
  extension: string;
}

/** `Artist - Title (Version).flac` - the PRD 7.2 output shape. */
export function buildReadyFilename(parts: ReadyNameParts): string {
  const artist = sanitizeSegment(parts.artist, 'Unknown Artist');
  const title = sanitizeSegment(parts.title, 'Unknown Title');
  const version = parts.version ? sanitizeSegment(parts.version, '') : '';
  const extension = sanitizeExtension(parts.extension);

  const stem = version ? `${artist} - ${title} (${version})` : `${artist} - ${title}`;
  // Re-cap after joining: two 255-byte halves would make a 500-byte name.
  const capped = truncateBytes(stem, MAX_SEGMENT_BYTES - Buffer.byteLength(extension, 'utf8'))
    .replace(/[. ]+$/, '')
    .trim();

  return `${capped || 'Unknown'}${extension}`;
}

/** `<Artist>/<Artist> - <Title> (<Version>).<ext>`, relative to the ready root. */
export function buildReadyRelPath(parts: ReadyNameParts): string {
  return path.join(sanitizeSegment(parts.artist, 'Unknown Artist'), buildReadyFilename(parts));
}

/**
 * Resolve `candidate` (absolute, or relative to `root`) and prove it stays beneath `root`.
 *
 * This is a lexical check on already-resolved paths. It defeats `..`, absolute escapes and
 * the `/data` vs `/data-other` prefix trap, but it cannot see through symlinks - use
 * `resolveWithinRootReal` when the path is expected to exist on disk.
 */
export function resolveWithinRoot(root: string, candidate: string): string {
  if (!path.isAbsolute(root)) {
    throw new UnsafePathError(`Root must be an absolute path, received "${root}"`);
  }

  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);

  if (resolved === resolvedRoot) {
    throw new UnsafePathError(`Path "${candidate}" resolves to the root itself, not a file within it`);
  }
  // The path.sep suffix is what stops "/data-other" from passing a "/data" check.
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (!resolved.startsWith(prefix)) {
    throw new UnsafePathError(`Path "${candidate}" resolves outside of root "${resolvedRoot}"`);
  }

  return resolved;
}

/**
 * As `resolveWithinRoot`, but also resolves symlinks so a link pointing out of the root is
 * caught. The root must exist; the candidate need not (its nearest existing ancestor is
 * resolved instead, then the remaining suffix re-appended).
 */
export async function resolveWithinRootReal(root: string, candidate: string): Promise<string> {
  const lexical = resolveWithinRoot(root, candidate);
  const realRoot = await realpath(path.resolve(root));

  let probe = lexical;
  let realProbe: string | null = null;
  for (;;) {
    try {
      realProbe = await realpath(probe);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }

  if (realProbe === null) {
    throw new UnsafePathError(`Unable to resolve any existing ancestor of "${lexical}"`);
  }

  const suffix = path.relative(probe, lexical);
  const realCandidate = suffix ? path.join(realProbe, suffix) : realProbe;

  return resolveWithinRoot(realRoot, realCandidate);
}
