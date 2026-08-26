# Songarr acquisition-pipeline spike

A command-line proof of concept for the riskiest part of the [Songarr MVP](PRD.md): the chain
from a Prowlarr search to a validated audio file in the `ready` folder, driving a **shared**
qBittorrent instance without disturbing anything Sonarr, Radarr, Lidarr or the user own.

It exists to answer questions that cannot be answered on paper, before Phase 1 of the PRD
builds an application shell around them. It is not the MVP and is not meant to become the
product as-is - see [What this is not](#what-this-is-not).

## What it does

One run walks the ten steps of PRD sections 9.3 - 9.6, pausing twice for the two decisions the
MVP deliberately leaves to a human:

1. Search Prowlarr for `artist title [version]`, audio categories only.
2. **Ask the user to select a release** (ranked by quality preference, nothing filtered out).
3. Add the torrent to qBittorrent **stopped**, under category `songarr` and a unique
   `songarr-request-<uuid>` tag.
4. Correlate the newly added torrent by that tag and record its infohash.
5. Wait for the torrent's file list.
6. **Ask the user to confirm the audio file**, with a scored recommendation and its reasons.
7. Set every other file to do-not-download, enable the chosen one, and verify the readback.
8. Start the torrent and monitor the _selected file's_ progress.
9. Resolve the completed file safely, confirm it is stable, and validate it with `ffprobe`.
10. Copy it to `<ready>/.processing/`, then atomically rename into
    `<ready>/<Artist>/<Artist> - <Title> (<Version>).<ext>`.

The qBittorrent payload is never moved or deleted, so seeding continues.

## Requirements

- Node.js 20.6 or newer (the PRD targets 22 LTS; the spike is compatible with both).
- `ffprobe` on `PATH` (`ffmpeg` package on most distributions), or its location set with
  `FFPROBE_PATH`.
- A reachable Prowlarr with at least one music-capable indexer.
- A reachable qBittorrent Web UI.

## Setup

```bash
pnpm install
cp .env.example .env
# edit .env - see the comments in that file
```

`.env` is gitignored and no credential is ever written to the repository. Prowlarr's API key
travels in an `X-Api-Key` header rather than a query string, and the logger redacts registered
secrets, magnet links, authenticated download URLs and session cookies at every log level.

### The one path rule

Remote path mapping is a PRD non-goal, so `SONGARR_DOWNLOAD_ROOT` is used **both** as the save
path handed to qBittorrent and as the directory the spike reads the finished file from. The
two services must see that directory at the same path. If they do not, the run fails at step 9
with `SOURCE_MISSING` and a message saying exactly that.

## Running it

Check connectivity, credentials and path permissions without touching anything:

```bash
pnpm spike --check
```

```
Prowlarr    ok  http://localhost:9696 (Prowlarr 1.30.2.4939)
qBittorrent ok  http://localhost:8080 (v5.0.4, WebAPI 2.11.2, lifecycle: start/stop)
Paths       ok  downloads=/data/downloads ready=/data/ready
```

Then run the pipeline:

```bash
pnpm spike --artist "Daft Punk" --title "Around the World"
pnpm spike --artist "Daft Punk" --title "Around the World" --version "Radio Edit" --quality flac
```

Selection prompts are on stdout and logs on stderr, so `2>/dev/null` gives a clean interactive
session and `1>/dev/null` gives a clean log. Enter accepts the recommended entry (marked `*`),
and `q` aborts.

### Testing against a remote stack

If qBittorrent runs on another machine, steps 1-8 work over the network but steps 9 and 10
cannot: they open the finished file, which only exists where qBittorrent wrote it. `--skip-publish`
stops after the download instead of failing at validation:

```bash
pnpm spike --check --skip-publish
pnpm spike --artist "Daft Punk" --title "Around the World" --skip-publish
```

In this mode `SONGARR_DOWNLOAD_ROOT` is still sent to qBittorrent as its save path, so it must
be a path valid on **that** host - but it is no longer checked locally, and
`SONGARR_READY_ROOT` may be left unset. The run reports where the download host placed the
file so it can be verified by hand.

This is the right way to exercise the risky half of the pipeline before deploying anything.
Everything a fake cannot settle - CSRF headers, stopped-add behaviour, tag correlation, magnet
metadata, `filePrio` semantics, the WebAPI version in play - happens in steps 1-8. Steps 9 and
10 are local filesystem work already covered by tests against real generated audio.

If you interrupt a run after the torrent has been added, the spike prints the category, tag and
hash so you can find or remove it in qBittorrent yourself. It does not clean up after itself -
that is cancel-flow work for the MVP.

## Tests

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The unit tests cover the logic the MVP must not get wrong: path sanitising and root
containment, file-match scoring, release format inference, the ownership guard, the
qBittorrent version matrix, config validation, and log redaction.

`test/pipeline.e2e.test.ts` runs the real `runPipeline` over real HTTP against scriptable fake
Prowlarr and qBittorrent servers (`test/fakes/`), with the prompts answered by a script. It
asserts the ordering guarantees that matter: the torrent is added stopped, every `filePrio`
call precedes the first `start`, a pre-existing Sonarr torrent is never touched, nothing is
written outside the ready root, and `.processing` is left empty. `ffprobe` validation is tested
against genuinely generated audio, not fixtures.

## What the spike established

**A stopped torrent does not fetch magnet metadata.** The PRD's "add paused, then inspect the
files" only works directly when the release provides a real `.torrent` file. So Songarr
downloads the `.torrent` bytes from the indexer itself and uploads them to qBittorrent, which
makes the file list available immediately while the torrent is still stopped. This is the
primary path and it is clean.

For a magnet-only release there is no such option: the torrent must run to obtain metadata. The
spike starts it, polls for the file list, stops it again, applies priorities and only then
starts it for real - logging a warning that a small amount of unwanted data may be downloaded
in that window. **The MVP should surface this to the user rather than hiding it**, because with
files still at default priority the torrent may fetch anything during the metadata window.

**An indexer may answer a `.torrent` request with an HTML error page.** A bencoded torrent
always starts with `d`; anything else is rejected and the flow falls back to adding by URL,
rather than uploading a rate-limit page to qBittorrent as though it were a torrent.

**`ffprobe` reporting an audio stream is not sufficient validation.** A text file named
`fake.flac` probes as "raw FLAC" - one audio stream, codec `flac` - purely on the strength of
its extension, with `probe_score: 1`, `sample_rate: 0` and `channels: 0`. `IMP-01` as written
in the PRD would pass it. The spike additionally requires `probe_score >= 25` and a non-zero
sample rate and channel count. **The MVP must keep this check.**

**Torrent-level progress is the wrong completion signal.** With unwanted files disabled, a
torrent may never report 100%, while piece overlap means bytes beyond the selected file are
downloaded anyway. Completion is `files[i].progress >= 1` for the selected index only.

**qBittorrent 5.0 renamed the lifecycle endpoints.** `pause`/`resume` became `stop`/`start`,
and the `paused` add parameter became `stopped`, at WebAPI 2.11. `files[].index` only exists
from 2.8.2. The adapter detects the version once and adapts; both paths are tested.

**qBittorrent's CSRF protection rejects requests carrying neither `Origin` nor `Referer`.**
It is enabled by default, and a request with both headers absent is treated as cross-site.
Sending them only on login is not enough - every subsequent POST (`add`, `filePrio`, `start`,
`stop`) needs them too, or the run dies at the add step. The fake qBittorrent enforces the same
rule so this cannot regress unnoticed; with the headers removed, all 17 end-to-end tests fail.

**Three-way ownership is worth the strictness.** Category alone collides with Songarr's own
other requests; the tag alone would be enough but cannot be verified before the hash resolves.
Requiring category _and_ tag _and_ (once known) hash costs nothing and makes "never touch
someone else's torrent" a single enforceable choke point.

## What this is not

Deliberately absent, all Phase 1/4/5 work in the PRD:

- No SQLite, no persistence. State lives in memory for one run.
- No HTTP API, no React UI, no authentication, no sessions.
- No duplicate detection, no persisted state machine, no history.
- **No restart recovery.** Interrupt a run and the torrent is left in qBittorrent for you to
  deal with. Reconciliation (PRD 15) is exactly what this spike does not attempt.
- No cancel or retry flows, no Docker image, no health checks.
- No transcoding, no retagging, no metadata enrichment - all PRD non-goals.

## Modules worth carrying into the MVP

These are written to be lifted more or less directly into Phase 3/4:

| Module                     | Why                                                                       |
| -------------------------- | ------------------------------------------------------------------------- |
| `src/spike/paths.ts`       | Filename sanitising and root containment. Security-relevant, well tested. |
| `src/spike/ownership.ts`   | The three-way ownership guard; the single place the isolation rule lives. |
| `src/spike/matching.ts`    | Deterministic, explainable file scoring with confidence labels.           |
| `src/spike/quality.ts`     | Format inference and preference ranking.                                  |
| `src/spike/ffprobe.ts`     | Audio validation, including the probe-score check above.                  |
| `src/spike/publish.ts`     | Copy-then-atomic-rename with overwrite refusal.                           |
| `src/spike/qbittorrent.ts` | The version compatibility layer, minus the polling.                       |
| `test/fakes/`              | Reusable fake services for the MVP's integration tests.                   |

`src/spike/pipeline.ts` is the one module that should **not** carry over unchanged: its
sequential polling loop becomes the persisted reconciler described in PRD section 15, driven by
database state rather than by an `await` chain.
