/**
 * Ready-folder publication (PRD 9.6, IMP-02..IMP-06).
 *
 * The invariants this file exists to hold:
 *
 *  - The source is only ever *read*. qBittorrent keeps owning it and keeps seeding (9.7).
 *  - Both source and destination are proven to live beneath their configured roots.
 *  - A partially written file never appears at the final path: copy into `.processing`,
 *    fsync, close, then rename. Rename within one filesystem is atomic.
 *  - An existing destination is never silently overwritten.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { buildReadyRelPath, resolveWithinRoot, resolveWithinRootReal, type ReadyNameParts } from './paths.ts';
import type { Logger } from './log.ts';

/** Subdirectory of the ready root that in-flight copies live in (PRD 7.2). */
export const PROCESSING_DIR = '.processing';

export class PublishError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PublishError';
    this.code = code;
  }
}

export interface SourceCheck {
  absolutePath: string;
  size: number;
}

/**
 * Resolve a qBittorrent-reported relative path against the download root and confirm the
 * file is a real, non-empty, size-stable regular file.
 *
 * Size stability matters because qBittorrent reports a file complete a moment before the
 * last write lands on disk.
 */
export async function verifySource(
  downloadRoot: string,
  relativePath: string,
  options: { recheckDelayMs?: number; logger?: Logger } = {},
): Promise<SourceCheck> {
  let absolutePath: string;
  try {
    // qBittorrent's path is untrusted input (PRD 17).
    absolutePath = await resolveWithinRootReal(downloadRoot, relativePath);
  } catch (error) {
    throw new PublishError(
      'SOURCE_PATH_UNSAFE',
      `The completed file path could not be resolved safely beneath "${downloadRoot}": ${(error as Error).message}`,
    );
  }

  let info;
  try {
    info = await stat(absolutePath);
  } catch {
    throw new PublishError(
      'SOURCE_MISSING',
      `The completed file was not found at "${absolutePath}". Songarr and qBittorrent must ` +
        'see the same download path - check that SONGARR_DOWNLOAD_ROOT matches the save path ' +
        'inside the qBittorrent container.',
    );
  }

  if (!info.isFile()) {
    throw new PublishError('SOURCE_NOT_A_FILE', `"${absolutePath}" is not a regular file`);
  }
  if (info.size === 0) {
    throw new PublishError('SOURCE_EMPTY', `"${absolutePath}" is zero bytes`);
  }

  const recheckDelayMs = options.recheckDelayMs ?? 1_000;
  await delay(recheckDelayMs);
  const recheck = await stat(absolutePath);
  if (recheck.size !== info.size) {
    throw new PublishError(
      'SOURCE_UNSTABLE',
      `"${absolutePath}" is still being written (${info.size} -> ${recheck.size} bytes)`,
    );
  }

  options.logger?.debug('source verified', { path: absolutePath, size: recheck.size });
  return { absolutePath, size: recheck.size };
}

export interface PublishResult {
  readyPath: string;
  relativePath: string;
  size: number;
}

export interface PublishOptions {
  readyRoot: string;
  sourcePath: string;
  /** Used to build the final name; the extension comes from the source file. */
  nameParts: ReadyNameParts;
  /** Names the temporary file in `.processing`, so a retry reuses the same scratch path. */
  requestId: string;
  logger?: Logger;
}

/**
 * Copy a validated source file into the ready root under a safe, deterministic name.
 * Refuses rather than overwriting an existing destination.
 */
export async function publishToReady(options: PublishOptions): Promise<PublishResult> {
  const { readyRoot, sourcePath, nameParts, requestId, logger } = options;

  const relativePath = buildReadyRelPath(nameParts);
  const destination = resolveWithinRoot(readyRoot, relativePath);
  const processingDir = resolveWithinRoot(readyRoot, PROCESSING_DIR);
  const extension = path.extname(destination);
  const scratchPath = resolveWithinRoot(readyRoot, path.join(PROCESSING_DIR, `${requestId}${extension}`));

  // Check before copying so an obvious clash fails fast, and again just before the rename.
  await assertDestinationFree(destination);

  await mkdir(processingDir, { recursive: true });
  await mkdir(path.dirname(destination), { recursive: true });

  logger?.info('copying into the processing directory', { destination: relativePath });

  try {
    await copyAndFlush(sourcePath, scratchPath);
  } catch (error) {
    await unlink(scratchPath).catch(() => {});
    throw mapCopyError(error, scratchPath);
  }

  const copied = await stat(scratchPath);
  const source = await stat(sourcePath);
  if (copied.size !== source.size) {
    await unlink(scratchPath).catch(() => {});
    throw new PublishError(
      'COPY_SIZE_MISMATCH',
      `The copy is ${copied.size} bytes but the source is ${source.size} bytes`,
    );
  }

  // Re-check immediately before the rename to narrow the race to almost nothing.
  try {
    await assertDestinationFree(destination);
  } catch (error) {
    await unlink(scratchPath).catch(() => {});
    throw error;
  }

  await rename(scratchPath, destination);
  logger?.info('published to the ready folder', { path: destination, size: copied.size });

  return { readyPath: destination, relativePath, size: copied.size };
}

async function assertDestinationFree(destination: string): Promise<void> {
  try {
    await stat(destination);
  } catch {
    return; // Does not exist, which is what we want.
  }
  throw new PublishError(
    'DESTINATION_EXISTS',
    `"${destination}" already exists. Songarr will not overwrite a ready file - resolve this manually.`,
  );
}

/** Stream the copy, then fsync so the rename cannot expose a partially flushed file. */
async function copyAndFlush(sourcePath: string, destinationPath: string): Promise<void> {
  const handle = await open(destinationPath, 'w');
  try {
    await pipeline(createReadStream(sourcePath), createWriteStream('', { fd: handle.fd, autoClose: false }));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function mapCopyError(error: unknown, destination: string): PublishError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOSPC') {
    return new PublishError('NO_DISK_SPACE', `Ran out of disk space while writing "${destination}"`);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new PublishError('READY_NOT_WRITABLE', `Permission denied while writing "${destination}"`);
  }
  return new PublishError('COPY_FAILED', `Copy failed: ${(error as Error).message}`);
}
