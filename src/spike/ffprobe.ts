/**
 * Audio validation via ffprobe (PRD 9.6.4, IMP-01).
 *
 * The only question asked here is "does this file actually contain a decodable audio
 * stream". No transcoding, no retagging, no metadata enrichment - all PRD non-goals.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class FfprobeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'FfprobeError';
    this.code = code;
  }
}

export interface AudioProbe {
  codec: string;
  /** Container format short name, e.g. `flac`, `mp3`. */
  formatName: string;
  durationSec: number | null;
  bitRate: number | null;
  sampleRate: number | null;
  channels: number | null;
  /** Whatever tags happened to be embedded. Read, never written (PRD 9.6.5). */
  tags: Record<string, string>;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  sample_rate?: string;
  channels?: number;
  bit_rate?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: {
    format_name?: string;
    duration?: string;
    bit_rate?: string;
    probe_score?: number;
    tags?: Record<string, string>;
  };
}

/**
 * ffprobe will happily declare a text file named `.flac` to be "raw FLAC" on the strength of
 * its extension alone, reporting probe_score 1 with sample_rate 0 and channels 0. So the
 * presence of an audio stream is NOT sufficient - the stream has to be substantive.
 *
 * 25 is ffmpeg's AVPROBE_SCORE_RETRY; anything genuinely demuxable scores far higher (a real
 * FLAC scores 100), while an extension-only guess scores 1.
 */
const MIN_PROBE_SCORE = 25;

/**
 * Probe a file and require at least one audio stream. Throws a coded FfprobeError on any
 * failure so the caller can map it to a user-facing message.
 */
export async function probeAudio(filePath: string, ffprobePath = 'ffprobe'): Promise<AudioProbe> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === 'ENOENT') {
      throw new FfprobeError(
        'FFPROBE_NOT_FOUND',
        `ffprobe was not found at "${ffprobePath}". Install ffmpeg or set FFPROBE_PATH.`,
      );
    }
    const detail = (err.stderr ?? err.message ?? '').trim().slice(0, 300);
    throw new FfprobeError('FFPROBE_REJECTED', `ffprobe could not read the file: ${detail}`);
  }

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    throw new FfprobeError('FFPROBE_BAD_OUTPUT', 'ffprobe returned output that could not be parsed');
  }

  const audio = (parsed.streams ?? []).find((stream) => stream.codec_type === 'audio');
  if (!audio) {
    throw new FfprobeError('NO_AUDIO_STREAM', 'The file contains no audio stream');
  }

  const probeScore = parsed.format?.probe_score ?? 0;
  if (probeScore < MIN_PROBE_SCORE) {
    throw new FfprobeError(
      'NO_AUDIO_STREAM',
      `ffprobe only guessed the format from the file extension (probe score ${probeScore}); ` +
        'the file does not contain a recognisable audio stream',
    );
  }

  const sampleRate = Number(audio.sample_rate ?? 0);
  const channels = audio.channels ?? 0;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || channels <= 0) {
    throw new FfprobeError(
      'NO_AUDIO_STREAM',
      `The audio stream is not decodable (sample rate ${sampleRate}, ${channels} channel(s))`,
    );
  }

  const numberOrNull = (value: string | undefined): number | null => {
    if (value === undefined) return null;
    const parsedValue = Number(value);
    return Number.isFinite(parsedValue) ? parsedValue : null;
  };

  return {
    codec: audio.codec_name ?? 'unknown',
    formatName: parsed.format?.format_name ?? 'unknown',
    durationSec: numberOrNull(parsed.format?.duration),
    bitRate: numberOrNull(parsed.format?.bit_rate ?? audio.bit_rate),
    sampleRate,
    channels,
    tags: parsed.format?.tags ?? {},
  };
}
