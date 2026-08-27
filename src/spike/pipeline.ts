/**
 * The Songarr acquisition pipeline, end to end (PRD 9.3 - 9.6).
 *
 * This is the spike's whole point: proving the chain works against a real Prowlarr and a
 * real, shared qBittorrent before any database, HTTP API or UI exists. State lives in memory
 * for the duration of one run - persistence and restart recovery are MVP Phase 4 work.
 *
 * Every stage announces itself with the PRD 11 state name so the vocabulary carries over.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { probeAudio, type AudioProbe } from './ffprobe.ts';
import { fileExtension, rankFiles, type ScoredFile, type TrackRequest } from './matching.ts';
import { preferredExtensionFor, rankReleases, type QualityPreference } from './quality.ts';
import { publishToReady, verifySource, type PublishResult } from './publish.ts';
import { buildSearchQuery, ProwlarrError, type ProwlarrClient, type ProwlarrRelease } from './prowlarr.ts';
import {
  FilePriority,
  isErrorState,
  isFileComplete,
  type QbittorrentClient,
  type TorrentFile,
  type TorrentInfo,
} from './qbittorrent.ts';
import type { OwnershipClaim } from './ownership.ts';
import type { Choice, Prompter } from './prompt.ts';
import type { Logger } from './log.ts';

export type PipelineState =
  | 'searching'
  | 'awaiting_release_selection'
  | 'adding_torrent'
  | 'awaiting_torrent_metadata'
  | 'awaiting_file_selection'
  | 'downloading'
  | 'processing'
  | 'ready';

export class PipelineError extends Error {
  readonly code: string;
  readonly nextAction: string;
  constructor(code: string, message: string, nextAction: string) {
    super(message);
    this.name = 'PipelineError';
    this.code = code;
    this.nextAction = nextAction;
  }
}

export interface PipelineDeps {
  prowlarr: ProwlarrClient;
  qbittorrent: QbittorrentClient;
  prompter: Prompter;
  logger: Logger;
}

export interface PipelineInput {
  request: TrackRequest & { artist: string; title: string };
  preferredQuality: QualityPreference;
  category: string;
  downloadRoot: string;
  /** Unused when `skipPublish` is set. */
  readyRoot: string | null;
  metadataTimeoutSec: number;
  pollIntervalSec: number;
  stallTimeoutSec: number;
  /** Executable name or absolute path used to validate the completed audio. */
  ffprobePath: string;
  /**
   * Stop once the selected file has finished downloading, skipping validation and the ready
   * copy. Used when Songarr runs somewhere that cannot see qBittorrent's download directory
   * (see docs/spike.md, "Testing against a remote stack"). `readyRoot` is unused in this mode.
   */
  skipPublish?: boolean;
  /** Shorter recheck window in tests; production waits a second for the write to settle. */
  sourceRecheckDelayMs?: number;
}

export interface PipelineResult {
  requestId: string;
  tag: string;
  hash: string;
  release: ProwlarrRelease;
  selectedFile: TorrentFile;
  /** Where qBittorrent reports it placed the file, as that host sees the path. */
  downloadedPath: string;
  /** null when `skipPublish` stopped the run after the download. */
  probe: AudioProbe | null;
  /** null when `skipPublish` stopped the run after the download. */
  published: PublishResult | null;
}

/** Torrent hash and tag, exposed so an interrupted run can be cleaned up by hand. */
export interface PipelineHandle {
  requestId: string;
  tag: string;
  hash: string | null;
}

export async function runPipeline(
  input: PipelineInput,
  deps: PipelineDeps,
  onHandle?: (handle: PipelineHandle) => void,
): Promise<PipelineResult> {
  const { prowlarr, qbittorrent, prompter, logger } = deps;

  const requestId = randomUUID();
  const tag = `songarr-request-${requestId}`;
  const claim: OwnershipClaim = { category: input.category, tag, hash: null };
  const handle: PipelineHandle = { requestId, tag, hash: null };
  onHandle?.(handle);

  const announce = (state: PipelineState, message: string): void => {
    logger.info(`[${state}] ${message}`);
  };

  const preferredExtension = preferredExtensionFor(input.preferredQuality);
  const request: TrackRequest = { ...input.request, preferredExtension };

  // ---- 1. Search -----------------------------------------------------------------------
  const query = buildSearchQuery(input.request);
  announce('searching', `Searching Prowlarr for "${query}"`);

  const releases = await prowlarr.search(query);
  if (releases.length === 0) {
    throw new PipelineError(
      'NO_SEARCH_RESULTS',
      `Prowlarr returned no results for "${query}"`,
      'Try a different artist/title spelling, or check that your indexers cover music.',
    );
  }
  logger.info(`Prowlarr returned ${releases.length} result(s)`);

  // ---- 2. Select a release -------------------------------------------------------------
  announce('awaiting_release_selection', 'Waiting for the user to choose a release');
  const release = await selectRelease(releases, input.preferredQuality, prompter);
  logger.info('release selected', { title: release.title, indexer: release.indexer });

  // ---- 3. Add the torrent, stopped -----------------------------------------------------
  announce('adding_torrent', `Adding to qBittorrent under category "${input.category}", tag ${tag}`);

  await qbittorrent.ensureCategory(input.category, input.downloadRoot);

  // Idempotency guard (PRD 20.2): if a previous attempt already added this tag, adopt it.
  const preexisting = await qbittorrent.findOwnedTorrent(claim);
  if (preexisting) {
    logger.warn('a torrent already carries this request tag; adopting it instead of adding again');
  } else {
    const source = await resolveTorrentSource(release, prowlarr, logger);
    await qbittorrent.addTorrent({
      category: input.category,
      tag,
      savePath: input.downloadRoot,
      torrentFile: source.kind === 'file' ? source.bytes : null,
      url: source.kind === 'url' ? source.url : null,
    });
    logger.info(`torrent submitted from ${source.kind === 'file' ? 'a .torrent file' : 'a URL'}`);
  }

  // ---- 4. Correlate the torrent by tag -------------------------------------------------
  const torrent = await resolveTorrent(qbittorrent, claim, input, logger);
  claim.hash = torrent.hash;
  handle.hash = torrent.hash;
  logger.info('torrent correlated', { hash: torrent.hash, name: torrent.name });

  const ownedClaim = { ...claim, hash: torrent.hash };

  // ---- 5. Wait for metadata ------------------------------------------------------------
  announce('awaiting_torrent_metadata', 'Waiting for the torrent file list');
  const files = await waitForMetadata(qbittorrent, ownedClaim, input, logger);
  logger.info(`torrent contains ${files.length} file(s)`);

  // ---- 6. Select the audio file --------------------------------------------------------
  announce('awaiting_file_selection', 'Waiting for the user to confirm the audio file');
  const selected = await selectFile(files, request, prompter);
  logger.info('file selected', { index: selected.index, name: selected.name });

  // ---- 7. Disable everything else, then verify the readback ----------------------------
  const unwanted = files.filter((file) => file.index !== selected.index).map((file) => file.index);
  await qbittorrent.setFilePriority(ownedClaim, unwanted, FilePriority.DoNotDownload);
  await qbittorrent.setFilePriority(ownedClaim, [selected.index], FilePriority.Normal);

  const readback = await qbittorrent.listFiles(ownedClaim);
  assertPrioritiesApplied(readback, selected.index);
  logger.info(`priorities applied: 1 file enabled, ${unwanted.length} set to do-not-download`);

  // ---- 8. Start and monitor the selected file ------------------------------------------
  announce('downloading', 'Starting the torrent');
  await qbittorrent.start(ownedClaim);
  const completed = await monitorSelectedFile(qbittorrent, ownedClaim, selected.index, input, logger);

  // qBittorrent's file names are relative to the torrent root, which sits under save_path.
  const current = await qbittorrent.getOwnedTorrent(ownedClaim);
  const savePath = current?.save_path ?? input.downloadRoot;
  const relativeToRoot = path.join(path.relative(input.downloadRoot, savePath) || '.', completed.name);
  const downloadedPath = path.join(savePath, completed.name);

  // Steps 9 and 10 need to open the file, which is only possible where qBittorrent wrote it.
  if (input.skipPublish) {
    logger.warn(
      'skipping validation and the ready copy (--skip-publish): the download host owns this ' +
        'file, so ffprobe and the atomic copy cannot run from here',
    );
    return {
      requestId,
      tag,
      hash: torrent.hash,
      release,
      selectedFile: completed,
      downloadedPath,
      probe: null,
      published: null,
    };
  }

  if (!input.readyRoot) {
    throw new PipelineError(
      'READY_ROOT_REQUIRED',
      'A ready root is required to publish the finished file',
      'Set SONGARR_READY_ROOT, or pass --skip-publish to stop after the download.',
    );
  }

  // ---- 9. Validate -------------------------------------------------------------------
  announce('processing', 'Validating the completed file');

  const source = await verifySource(input.downloadRoot, relativeToRoot, {
    recheckDelayMs: input.sourceRecheckDelayMs,
    logger,
  });

  const probe = await probeAudio(source.absolutePath, input.ffprobePath);
  logger.info('audio validated', {
    codec: probe.codec,
    format: probe.formatName,
    durationSec: probe.durationSec,
  });

  // ---- 10. Publish ---------------------------------------------------------------------
  const published = await publishToReady({
    readyRoot: input.readyRoot,
    sourcePath: source.absolutePath,
    requestId,
    nameParts: {
      artist: input.request.artist,
      title: input.request.title,
      version: input.request.version ?? null,
      extension: fileExtension(completed.name),
    },
    logger,
  });

  announce('ready', `Ready at ${published.readyPath}`);

  return {
    requestId,
    tag,
    hash: torrent.hash,
    release,
    selectedFile: completed,
    downloadedPath,
    probe,
    published,
  };
}

// ---------------------------------------------------------------------------------------
// Stage helpers
// ---------------------------------------------------------------------------------------

function formatSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return '?';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatAge(publishDate: string | null): string {
  if (!publishDate) return '?';
  const published = Date.parse(publishDate);
  if (!Number.isFinite(published)) return '?';
  const days = Math.floor((Date.now() - published) / 86_400_000);
  return days <= 0 ? 'today' : `${days}d`;
}

async function selectRelease(
  releases: readonly ProwlarrRelease[],
  preference: QualityPreference,
  prompter: Prompter,
): Promise<ProwlarrRelease> {
  const ranked = rankReleases(releases, preference);

  const choices: Choice<ProwlarrRelease>[] = ranked.map(({ release, format }, position) => {
    // Usenet results are listed for transparency but the spike only drives qBittorrent.
    const usable = release.protocol === 'torrent' && Boolean(release.downloadUrl || isMagnetUrl(release.magnetUrl));
    return {
      value: release,
      label: [
        release.title.slice(0, 80).padEnd(80),
        format.padEnd(10),
        formatSize(release.size).padStart(9),
        `S:${release.seeders ?? '?'}`.padStart(7),
        `L:${release.leechers ?? '?'}`.padStart(7),
        formatAge(release.publishDate).padStart(6),
        release.indexer,
      ].join('  '),
      detail: usable ? undefined : `not usable: protocol=${release.protocol}, no torrent/magnet URL`,
      disabled: !usable,
      recommended: position === 0 && usable,
    };
  });

  return prompter.select('Select a release:', choices);
}

type TorrentSource = { kind: 'file'; bytes: Uint8Array } | { kind: 'url'; url: string; isMagnet: boolean };

function isMagnetUrl(value: string | null): value is string {
  return value !== null && value.trim().toLowerCase().startsWith('magnet:');
}

/**
 * Prefer the raw `.torrent` bytes. A torrent added from a file already carries its file
 * list, which is what lets it stay stopped through file selection. A magnet cannot: a
 * stopped magnet fetches no metadata, so that path needs the brief-start fallback in
 * `waitForMetadata`. See docs/spike.md.
 */
async function resolveTorrentSource(
  release: ProwlarrRelease,
  prowlarr: ProwlarrClient,
  logger: Logger,
): Promise<TorrentSource> {
  let fetchError: ProwlarrError | null = null;

  if (release.downloadUrl) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const fetched = await prowlarr.fetchTorrentFile(release);
        if (fetched.kind === 'magnet') {
          logger.info('Prowlarr download endpoint redirected to a magnet link');
          return { kind: 'url', url: fetched.url, isMagnet: true };
        }
        return fetched;
      } catch (error) {
        if (!(error instanceof ProwlarrError)) throw error;
        fetchError = error;

        const retryable = error.code === 'TORRENT_FETCH_FAILED';
        if (retryable && attempt < 3) {
          logger.warn(`Prowlarr torrent fetch failed; retrying (${attempt}/3)`, { code: error.code });
          await delay(attempt * 500);
          continue;
        }
        break;
      }
    }
  }

  const url = release.magnetUrl?.trim() ?? null;
  if (!isMagnetUrl(url)) {
    throw new PipelineError(
      'TORRENT_SOURCE_UNAVAILABLE',
      `Songarr could not retrieve torrent bytes or a magnet for "${release.title}"` +
        (fetchError ? ` (${fetchError.code})` : ''),
      'Retry once in case the indexer was temporarily unavailable, or choose a different release.',
    );
  }

  logger.warn(
    'this release is magnet-only: qBittorrent cannot fetch metadata while stopped, so the ' +
      'torrent will be started briefly to retrieve the file list, then stopped again. ' +
      'A small amount of unwanted data may be downloaded during that window.',
  );
  return { kind: 'url', url, isMagnet: true };
}

/** Poll `/torrents/info?tag=` until the newly added torrent appears (PRD 9.4). */
async function resolveTorrent(
  qbittorrent: QbittorrentClient,
  claim: OwnershipClaim,
  input: PipelineInput,
  logger: Logger,
): Promise<TorrentInfo> {
  const deadline = Date.now() + 60_000;

  for (;;) {
    const torrent = await qbittorrent.findOwnedTorrent(claim);
    if (torrent) return torrent;

    if (Date.now() > deadline) {
      throw new PipelineError(
        'TORRENT_NOT_CORRELATED',
        `No torrent carrying tag "${claim.tag}" appeared in qBittorrent within 60s`,
        'Check qBittorrent for a torrent that failed to add, then retry the request.',
      );
    }
    logger.debug('waiting for the torrent to appear');
    await delay(Math.min(input.pollIntervalSec * 1000, 2000));
  }
}

/**
 * Wait for the torrent's file list. For a magnet the torrent must be running to fetch
 * metadata, so this starts it, waits, and stops it again the moment files appear.
 */
async function waitForMetadata(
  qbittorrent: QbittorrentClient,
  claim: OwnershipClaim & { hash: string },
  input: PipelineInput,
  logger: Logger,
): Promise<TorrentFile[]> {
  const deadline = Date.now() + input.metadataTimeoutSec * 1000;
  let startedForMetadata = false;

  for (;;) {
    const files = await qbittorrent.listFiles(claim);
    if (files.length > 0) {
      if (startedForMetadata) {
        logger.info('metadata received, stopping the torrent again before file selection');
        await qbittorrent.stop(claim);
      }
      return files;
    }

    const torrent = await qbittorrent.getOwnedTorrent(claim);
    if (!torrent) {
      throw new PipelineError(
        'TORRENT_MISSING',
        `Torrent ${claim.hash} disappeared from qBittorrent while waiting for metadata`,
        'It was probably removed manually. Retry the request.',
      );
    }
    if (isErrorState(torrent.state)) {
      throw new PipelineError(
        'TORRENT_ERROR',
        `qBittorrent reports state "${torrent.state}" for this torrent`,
        'Inspect the torrent in qBittorrent, then retry.',
      );
    }

    // Only a running torrent fetches magnet metadata.
    if (!startedForMetadata && isStopped(torrent.state)) {
      logger.warn('no file list while stopped (magnet-only release); starting briefly to fetch metadata');
      await qbittorrent.start(claim);
      startedForMetadata = true;
    }

    if (Date.now() > deadline) {
      if (startedForMetadata) await qbittorrent.stop(claim).catch(() => {});
      throw new PipelineError(
        'METADATA_TIMEOUT',
        `No torrent metadata after ${input.metadataTimeoutSec}s`,
        'The swarm may have no peers. Choose a different release and retry.',
      );
    }

    await delay(input.pollIntervalSec * 1000);
  }
}

/** qBittorrent 4.x says "paused*", 5.x says "stopped*". */
function isStopped(state: string): boolean {
  return state.startsWith('paused') || state.startsWith('stopped');
}

async function selectFile(
  files: readonly TorrentFile[],
  request: TrackRequest,
  prompter: Prompter,
): Promise<TorrentFile> {
  const ranked = rankFiles(files, request);
  if (!ranked.some((scored) => scored.isSupportedAudio)) {
    throw new PipelineError(
      'NO_SUPPORTED_AUDIO',
      'The torrent contains no files with a supported audio extension',
      'Choose a different release.',
    );
  }

  const best: ScoredFile | undefined = ranked.find((scored) => scored.isSupportedAudio);

  const choices: Choice<TorrentFile>[] = ranked.map((scored) => ({
    value: scored.file,
    label: [
      scored.file.name.slice(0, 90).padEnd(90),
      formatSize(scored.file.size).padStart(9),
      scored.isSupportedAudio ? `${scored.confidence} (${scored.score})`.padStart(13) : '  not audio  ',
    ].join('  '),
    detail: scored.reasons.join('; '),
    // PRD 9.4: non-audio files are shown but must not be selectable.
    disabled: !scored.isSupportedAudio,
    recommended: scored === best,
  }));

  return prompter.select('Select the audio file to download:', choices);
}

/** Fail loudly if qBittorrent did not actually apply the priorities we asked for. */
function assertPrioritiesApplied(files: readonly TorrentFile[], selectedIndex: number): void {
  const selected = files.find((file) => file.index === selectedIndex);
  if (!selected) {
    throw new PipelineError(
      'SELECTED_FILE_MISSING',
      `File index ${selectedIndex} is no longer present in the torrent`,
      'Retry file selection.',
    );
  }
  if (selected.priority === FilePriority.DoNotDownload) {
    throw new PipelineError(
      'PRIORITY_NOT_APPLIED',
      'qBittorrent still reports the selected file as do-not-download',
      'Check the torrent in qBittorrent and retry.',
    );
  }

  const stillEnabled = files.filter(
    (file) => file.index !== selectedIndex && file.priority !== FilePriority.DoNotDownload,
  );
  if (stillEnabled.length > 0) {
    throw new PipelineError(
      'PRIORITY_NOT_APPLIED',
      `${stillEnabled.length} unwanted file(s) are still enabled; refusing to start the torrent`,
      'Check the torrent in qBittorrent and retry.',
    );
  }
}

/**
 * Poll until the *selected file* reports full progress. Torrent-level progress is not used:
 * with files disabled it may never reach 100%, and piece overlap means extra bytes are
 * downloaded regardless (PRD 9.5).
 */
async function monitorSelectedFile(
  qbittorrent: QbittorrentClient,
  claim: OwnershipClaim & { hash: string },
  selectedIndex: number,
  input: PipelineInput,
  logger: Logger,
): Promise<TorrentFile> {
  let lastProgress = -1;
  let lastProgressAt = Date.now();

  for (;;) {
    const torrent = await qbittorrent.getOwnedTorrent(claim);
    if (!torrent) {
      throw new PipelineError(
        'TORRENT_MISSING',
        `Torrent ${claim.hash} was removed from qBittorrent during the download`,
        'Retry the request to add it again.',
      );
    }
    if (isErrorState(torrent.state)) {
      throw new PipelineError(
        'TORRENT_ERROR',
        `qBittorrent reports state "${torrent.state}"`,
        'Inspect the torrent in qBittorrent, then retry.',
      );
    }

    const files = await qbittorrent.listFiles(claim);
    const file = files.find((candidate) => candidate.index === selectedIndex);
    if (!file) {
      throw new PipelineError(
        'SELECTED_FILE_MISSING',
        `File index ${selectedIndex} vanished from the torrent`,
        'Retry file selection.',
      );
    }
    if (file.priority === FilePriority.DoNotDownload) {
      throw new PipelineError(
        'SELECTED_FILE_DESELECTED',
        'The selected file was set to do-not-download outside Songarr',
        'Re-enable it in qBittorrent, or retry the request.',
      );
    }

    if (isFileComplete(file)) {
      logger.info('selected file is complete', { name: file.name, size: file.size });
      return file;
    }

    if (file.progress > lastProgress) {
      lastProgress = file.progress;
      lastProgressAt = Date.now();
      logger.info(
        `downloading ${(file.progress * 100).toFixed(1)}% of ${formatSize(file.size)} ` +
          `(torrent state: ${torrent.state})`,
      );
    } else if (Date.now() - lastProgressAt > input.stallTimeoutSec * 1000) {
      throw new PipelineError(
        'DOWNLOAD_STALLED',
        `No progress on the selected file for ${input.stallTimeoutSec}s (state: ${torrent.state})`,
        'The swarm may have no seeders. Cancel and choose a different release.',
      );
    }

    await delay(input.pollIntervalSec * 1000);
  }
}
