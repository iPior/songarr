# Where things stand

Last updated: 2026-08-25

The acquisition-pipeline spike is written and green (164 tests), but it has **never run against
real hardware**. Everything below is the plan for that first live run.

## Pick up here

### 1. Find qBittorrent's Web UI port

The one blocker. Prowlarr is confirmed reachable at `192.168.2.103:9696` (returns 401, so it is
up and waiting for a key). qBittorrent was not found on 8080, 8090, 9091, 8081, 8112, 8000,
8082, 8083, 9000, 9080, 3000, 5080, 8200 or 10095. Port 3000 is open but is some other JSON
app, not qBittorrent.

If qBittorrent sits behind Gluetun, its Web UI is usually published on the *Gluetun* container,
not on qBittorrent's own. Check the port mapping there.

### 2. Fill in `.env`

```bash
cp .env.example .env
```

```
PROWLARR_URL=http://192.168.2.103:9696
PROWLARR_API_KEY=          # Prowlarr -> Settings -> General -> Security -> API Key
QBITTORRENT_URL=http://192.168.2.103:<the port from step 1>
QBITTORRENT_USERNAME=admin
QBITTORRENT_PASSWORD=
SONGARR_DOWNLOAD_ROOT=/downloads    # the path qBittorrent uses ON THE SERVER, e.g. /downloads
# SONGARR_READY_ROOT deliberately left unset - not needed with --skip-publish
```

`.env` is gitignored. Nothing secret goes in the repo.

### 3. Run it

```bash
npm install                                    # if node_modules is gone
npm run spike -- --check --skip-publish        # connections only, changes nothing
npm run spike -- --artist "..." --title "..." --skip-publish
```

Pick something well seeded and unambiguous for the first attempt - a single-track torrent, not
a 30-track discography. The first run should test the plumbing, not the matcher.

## Why `--skip-publish`

The stack is on 192.168.2.103 and the code is here, so the finished file lands somewhere this
machine cannot see. Steps 1-8 (search, select, add stopped, correlate, metadata, file select,
set priorities, download) all work over HTTP. Steps 9-10 (ffprobe validation, copy into
`ready`) open the file on disk and cannot. `--skip-publish` stops cleanly after the download
rather than failing at validation, and relaxes the local check on `SONGARR_DOWNLOAD_ROOT`.

That is where the risk is anyway: steps 1-8 are the assumptions about Prowlarr and qBittorrent
that no fake can settle. Steps 9-10 are local filesystem work, already covered by tests against
real generated audio.

`SONGARR_DOWNLOAD_ROOT` is still **sent to qBittorrent as its save path**, so it must be a path
valid on the server even though it is not checked here.

## What is still unproven

- Anything against a real Prowlarr or real qBittorrent. All 164 tests use fakes.
- The CSRF fix (sending `Origin` and `Referer` on every request) is defensive, written from how
  qBittorrent's protection is documented to behave. **If `--check` passes but the add step
  fails with a 401, look here first.**
- ffprobe against a real indexer FLAC, and the ready-folder copy. Both are covered locally
  using generated audio, which is not quite the same thing. This gap closes when the code runs
  on the server.

## Housekeeping

- No cleanup exists yet. Each run leaves a torrent in qBittorrent under category `songarr` with
  tag `songarr-request-<uuid>`. **Delete them by hand between attempts.**
- Ctrl-C after the torrent is added prints the category, tag and hash so nothing is orphaned
  silently.
- Make sure `SONGARR_CATEGORY` is not a category another Arr app already uses. It is half the
  ownership check.

## After the live run succeeds

Move the spike to the server (Node 20.6+ and ffprobe needed there), drop `--skip-publish`, set
`SONGARR_READY_ROOT`, and prove steps 9-10 end to end. Then PRD Phase 1 - the application shell
- can start.

Detail on all of this, plus what the spike established about both APIs, is in
[docs/spike.md](docs/spike.md).
