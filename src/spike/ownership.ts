/**
 * Torrent ownership guard (PRD 3.5, 17, 20.6).
 *
 * qBittorrent is shared with Sonarr, Radarr, Lidarr and the user's own manual downloads.
 * Songarr must never pause, reprioritise, start or remove a torrent it did not create. Every
 * mutating call in `qbittorrent.ts` routes through `assertOwned` first, so there is exactly
 * one place where that rule can be got wrong.
 */

export interface OwnershipClaim {
  /** The category Songarr adds its torrents under, e.g. `songarr`. */
  category: string;
  /** The per-request tag, e.g. `songarr-request-<uuid>`. */
  tag: string;
  /** The resolved infohash. Absent only in the window between adding and correlating. */
  hash?: string | null;
}

export interface OwnableTorrent {
  hash: string;
  category?: string | null;
  /** qBittorrent returns tags as a comma-separated string. */
  tags?: string | null;
  name?: string | null;
}

export class OwnershipError extends Error {
  readonly code = 'TORRENT_NOT_OWNED';
  constructor(message: string) {
    super(message);
    this.name = 'OwnershipError';
  }
}

/** Split qBittorrent's comma-separated tag string into trimmed, non-empty tags. */
export function parseTags(tags: string | null | undefined): string[] {
  return (tags ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/** Case-insensitive infohash comparison; qBittorrent has returned both cases over the years. */
function sameHash(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * True only when the torrent carries our category, our request tag, and (once known) our hash.
 * All three must match - any one alone can collide with another application's torrent.
 */
export function isOwned(torrent: OwnableTorrent, claim: OwnershipClaim): boolean {
  if ((torrent.category ?? '') !== claim.category) return false;
  if (!parseTags(torrent.tags).includes(claim.tag)) return false;
  if (claim.hash && !sameHash(torrent.hash, claim.hash)) return false;
  return true;
}

/** `isOwned`, but throws with a message naming the failed check. */
export function assertOwned(torrent: OwnableTorrent, claim: OwnershipClaim): OwnableTorrent {
  if ((torrent.category ?? '') !== claim.category) {
    throw new OwnershipError(
      `Refusing to touch torrent ${torrent.hash}: category "${torrent.category ?? ''}" is not "${claim.category}"`,
    );
  }
  if (!parseTags(torrent.tags).includes(claim.tag)) {
    throw new OwnershipError(
      `Refusing to touch torrent ${torrent.hash}: it does not carry the request tag "${claim.tag}"`,
    );
  }
  if (claim.hash && !sameHash(torrent.hash, claim.hash)) {
    throw new OwnershipError(
      `Refusing to touch torrent ${torrent.hash}: expected hash ${claim.hash}`,
    );
  }
  return torrent;
}

/**
 * Pick our torrent out of a qBittorrent listing. Returns null when it is not there yet
 * (still being added) and throws when the tag somehow matched more than one torrent, which
 * would mean the tag is not unique and nothing downstream can be trusted.
 */
export function selectOwned(torrents: readonly OwnableTorrent[], claim: OwnershipClaim): OwnableTorrent | null {
  const owned = torrents.filter((torrent) => isOwned(torrent, claim));
  if (owned.length > 1) {
    throw new OwnershipError(
      `Request tag "${claim.tag}" matched ${owned.length} torrents; it must identify exactly one`,
    );
  }
  return owned[0] ?? null;
}
