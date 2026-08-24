# Songarr MVP Product Requirements Document

**Version:** 0.1  
**Status:** Ready for implementation planning  
**Date:** August 24, 2026  
**Product owner:** Piotr Szaran  
**Working name:** Songarr

## 1. Executive summary

Songarr is a self-hosted, track-first music acquisition manager designed to run alongside Prowlarr and qBittorrent in an existing Docker media stack. It fills a gap left by Lidarr: requesting and acquiring an individual song without treating the artist or complete album as the managed unit.

The MVP will let an authenticated user enter an artist and track, search Prowlarr, manually select a torrent, inspect the files inside it, confirm the intended audio file, download only that file through qBittorrent, validate the completed audio, and copy it into a clean server-side `ready` folder.

Songarr ends at the `ready` folder. Playback, Navidrome integration, Rekordbox integration, SMB configuration, desktop synchronization, and moving files onto another computer are separate concerns and are not part of this MVP.

The application should feel like another member of the Arr stack. It will use an Arr-inspired information architecture, compact tables, dark sidebar, settings pages, activity queue, history, health checks, built-in Forms authentication, API-key authentication, and a self-contained SQLite database. The interface must be implemented from scratch rather than copying GPL-licensed source code or branded assets from Sonarr, Radarr, Lidarr, or Prowlarr.

## 2. Problem statement

Lidarr is primarily organized around artists, releases, and complete albums. The product owner often wants one specific track for a DJ or local music library. Manually searching an indexer, adding a torrent to qBittorrent, waiting for metadata, disabling unwanted files, monitoring completion, finding the result, validating it, and moving it into an organized folder is repetitive and error-prone.

Songarr should make that workflow consistent while retaining manual confirmation at the two ambiguous points:

1. Which torrent release should be used?
2. Which file inside that torrent is the requested song?

The MVP is successful if it reliably automates everything after those confirmations without disrupting downloads owned by other applications.

## 3. Product principles

1. **Track-first:** A request represents one desired song or version of a song.
2. **Human-confirmed:** The MVP recommends but does not autonomously choose torrents or files.
3. **Self-contained:** One application container and one persistent `/config` volume; no external database or identity provider.
4. **Arr-familiar:** The application should behave and look familiar to users of Sonarr, Radarr, Lidarr, and Prowlarr.
5. **Safe ownership:** Songarr must only modify qBittorrent items that it created and can positively identify.
6. **Restart-safe:** Requests and downloads must survive application restarts.
7. **Clear handoff:** A file appearing in `ready` is Songarr's guarantee that processing is complete.
8. **MVP discipline:** Do not implement library monitoring, playlist synchronization, automatic acquisition, or playback.

## 4. Goals

### 4.1 MVP goals

- Provide a first-run setup flow and built-in administrator login.
- Accept a request containing artist, title, optional version, optional album, and preferred quality.
- Detect obvious duplicate active or completed requests.
- Search Prowlarr and display useful release information.
- Let the user choose a torrent result.
- Add the selected torrent to qBittorrent in a non-downloading state.
- Wait for torrent metadata and display its files.
- Recommend the most likely audio file and require user confirmation.
- Set unwanted torrent files to do-not-download and download the selected file.
- Persist and display request/download state.
- Recover monitoring after a Songarr restart.
- Validate a completed audio file.
- Copy the file safely into a consistently named `ready` path.
- Provide Activity, History, Settings, System Status, and Logs views.
- Provide API-key authentication for future external integrations.
- Ship as a Docker image with an example Docker Compose deployment.

### 4.2 Success criteria

The proof of concept succeeds when the complete workflow works reliably for at least 10 varied requests, including:

- MP3 and FLAC files.
- A single-track torrent.
- An album torrent where only one track is selected.
- A torrent requiring metadata retrieval before file selection.
- A title containing punctuation or filesystem-unsafe characters.
- An application restart during an active download.
- A duplicate request.
- A deliberately failed or stalled torrent followed by manual retry.

## 5. Non-goals

The following are explicitly excluded from the MVP:

- Playback or audio preview.
- Navidrome integration.
- SMB, SFTP, Syncthing, or desktop-client configuration.
- Copying files to another computer.
- Spotify, Apple Music, YouTube Music, or playlist integrations.
- Artist, album, or discography monitoring.
- RSS monitoring and automatic grabs.
- Fully automatic torrent selection.
- Fully automatic file selection.
- Searching multiple releases automatically after failure.
- Audio fingerprinting.
- Complete MusicBrainz or Discogs metadata enrichment.
- Automated retagging of all metadata fields.
- Transcoding or format conversion.
- Quality upgrades or replacement of existing tracks.
- Multi-user accounts, roles, request quotas, or public registration.
- Notifications.
- Usenet download clients.
- Download clients other than qBittorrent.
- Indexer managers other than Prowlarr.
- Multiple root folders or remote path mappings.
- Full library scanning, renaming, or management.
- Mobile applications.
- Plugin architecture.
- Exact feature or API parity with any Arr application.

## 6. Target user and environment

### 6.1 User

The MVP targets one administrator operating Songarr on a private home network or over an existing trusted remote network such as Tailscale. It is not intended to be exposed directly to the public internet.

### 6.2 Existing services

Songarr assumes the following already exist:

- Prowlarr with working indexers.
- qBittorrent configured to route downloads through the user's VPN arrangement.
- Docker and Docker Compose.
- Host directories for Songarr configuration, downloads, and prepared files.

Songarr is responsible for connecting to these services. It is not responsible for installing, configuring, or validating the legality of external content sources.

## 7. Proposed technical shape

The implementation agent may adjust libraries when justified, but should preserve the deployment shape and behaviour described here.

### 7.1 Recommended stack

- **Language:** TypeScript.
- **Runtime:** Node.js 22 or newer LTS.
- **Frontend:** React with Vite.
- **Backend:** Fastify or another small TypeScript HTTP framework.
- **Database:** SQLite with migrations; Drizzle ORM is preferred.
- **Background processing:** In-process persisted job reconciler; do not add Redis or a separate queue service.
- **Audio validation:** `ffprobe` available inside the application image.
- **Packaging:** Multi-stage Docker build producing one application image.
- **Process model:** One application process serves the SPA, API, and background reconciliation loop.

### 7.2 Persistent paths

```text
/config/
├── songarr.db
├── logs/
└── backups/

/downloads/
├── incomplete/
└── complete/

/ready/
├── .processing/
└── Artist/
    └── Artist - Track Title (Version).flac
```

The exact qBittorrent folder nesting may differ in the deployed environment. Songarr must allow the download and ready roots to be configured.

### 7.3 Example container volumes

```yaml
volumes:
  - ./songarr/config:/config
  - ./jellyfin/data/downloads/songarr:/downloads
  - ./songarr/ready:/ready
```

The deployment documentation must explain that Songarr and qBittorrent need a consistent view of the completed download path and compatible filesystem permissions.

## 8. Information architecture and visual direction

Songarr should resemble the established Arr applications without copying their source code, logo, or branded assets.

### 8.1 Primary navigation

```text
Songarr
├── Songs
├── Activity
│   ├── Queue
│   └── History
├── Settings
│   ├── Indexers
│   ├── Download Client
│   ├── Quality
│   ├── Media Management
│   └── General
└── System
    ├── Status
    ├── Logs
    └── Backups
```

### 8.2 Visual requirements

- Desktop-first responsive React interface.
- Dark blue or charcoal sidebar.
- Compact Arr-style tables, buttons, badges, modals, tabs, and progress bars.
- Familiar green success, amber warning, red error, and blue active states.
- Font Awesome or another permissively licensed icon set.
- Songarr-specific logo using a music-note or waveform motif.
- Dark theme only is acceptable for the MVP.
- Clear empty, loading, connection-error, and no-results states.

### 8.3 Songs page

The Songs page is the default page and request catalogue. It must include an `Add New` action and a table containing:

- Artist.
- Title.
- Version, when present.
- Preferred quality.
- Current status.
- Date added.
- Row action or link to request details.

### 8.4 Request details

The request-details view should show:

- Requested metadata.
- Current state and state explanation.
- Selected release.
- Selected torrent file.
- Download progress when applicable.
- Ready file path when completed.
- Chronological event history.
- Contextual actions such as search, retry, choose another result, cancel, or open ready-folder details.

## 9. Core user flows

### 9.1 First-run setup

On first launch, when no administrator exists, Songarr must present a setup wizard:

1. Create administrator username and password.
2. Enter Prowlarr URL and API key.
3. Test the Prowlarr connection.
4. Enter qBittorrent URL, username, and password.
5. Test the qBittorrent connection.
6. Configure download and ready folders.
7. Validate that required paths exist and are writable.
8. Choose the default quality preference.
9. Complete setup and redirect to login or establish the initial session.

Once setup completes, setup routes must no longer be usable without administrator authentication.

### 9.2 Request a song

The user selects `Add New` and enters:

- Artist: required.
- Title: required.
- Version: optional free text, for example `Extended Mix` or `Radio Edit`.
- Album: optional.
- Preferred quality: required, defaulted from settings.

Songarr normalizes the artist, title, and version for duplicate comparison while preserving the user's original values for display and output naming.

If a likely duplicate exists, Songarr displays it and requires the user to explicitly continue before creating another request.

### 9.3 Search and select a release

Songarr queries Prowlarr using combinations of the request fields. The exact query strategy may be refined during implementation, but must begin with a straightforward artist-and-title query.

Results must display, when available:

- Release title.
- Indexer.
- Age.
- Size.
- Seeders and leechers.
- Protocol.
- Download type or URL availability.
- Basic quality hints inferred from the release title, such as FLAC or MP3 320.

The user manually selects a result. Songarr stores the selected result before submitting it to qBittorrent.

### 9.4 Inspect torrent contents

Songarr adds the torrent to qBittorrent in a stopped or paused state using:

- Category `songarr`.
- A unique Songarr request tag such as `songarr-request-<uuid>`.
- The configured Songarr download path.

The unique tag is the primary correlation mechanism when the qBittorrent add operation does not directly return a torrent hash. Songarr polls only long enough to resolve the newly added torrent, stores the resulting hash, and thereafter uses the hash as its qBittorrent identifier.

Songarr waits for torrent metadata. If metadata is unavailable after a configurable timeout, the request transitions to `Failed` with a retry action.

When files are available, Songarr:

1. Lists all torrent files.
2. Identifies supported audio files.
3. Scores likely matches using normalized artist, title, version, filename, extension, and path.
4. Highlights one proposed match when confidence is reasonable.
5. Requires the user to confirm or manually choose a file.

Supported MVP audio extensions:

- `.flac`
- `.mp3`
- `.m4a`
- `.aac`
- `.alac`, if encountered as a standalone extension
- `.wav`

Non-audio files may be displayed but must not be selectable as the requested track.

### 9.5 Download selected file

After confirmation, Songarr sets every unwanted torrent file to do-not-download and enables the selected audio file. Small supporting files such as artwork are not required for the MVP and should remain disabled by default.

Songarr starts the torrent and records:

- Torrent hash.
- Selected file index.
- Selected relative file path.
- Expected download path.
- Progress.
- qBittorrent state.
- Last successful synchronization time.

Songarr must tolerate extra bytes being downloaded because torrent pieces can overlap file boundaries.

### 9.6 Process completed file

Songarr processes a track only after qBittorrent indicates that the selected file is complete.

Processing steps:

1. Resolve the selected file to an allowed path beneath the configured download root.
2. Confirm the file exists and is a regular file.
3. Confirm the file size is non-zero and stable across a short recheck.
4. Run `ffprobe` and confirm a readable audio stream exists.
5. Read basic embedded metadata when practical, but do not require metadata enrichment.
6. Build a safe output filename from the requested artist, title, version, and original extension.
7. Copy to `/ready/.processing/<request-id>.<extension>`.
8. Flush and close the completed copy.
9. Atomically rename it into its final path beneath `/ready/<Artist>/`.
10. Record final size, format, and path.
11. Transition the request to `Ready`.

The MVP preserves the source audio stream and existing embedded tags. It must not transcode. Complete retagging is deferred.

If the destination already exists, Songarr must not silently overwrite it. It should mark the request `Needs Review` or require an explicit overwrite/copy-with-suffix decision.

### 9.7 Seeding and source retention

The qBittorrent-owned payload and Songarr-ready copy are separate:

- qBittorrent owns the file under the download root.
- Songarr owns the copy under the ready root.

Songarr must not move the qBittorrent payload. qBittorrent may continue seeding after the ready copy is created. For the MVP, torrent seeding limits and cleanup may remain qBittorrent configuration responsibilities. Songarr must never delete a ready file when qBittorrent later stops or removes its torrent.

### 9.8 Cancel and retry

The user can cancel an active request. Cancellation must:

- Require confirmation once a torrent has been added.
- Operate only on a torrent that has both Songarr category ownership and the request-specific tag/hash correlation.
- Stop Songarr processing.
- Optionally remove the Songarr-owned torrent and partial data when the user explicitly chooses that option.
- Preserve request history as `Cancelled`.

Retry should return the user to the most appropriate prior stage. The MVP does not automatically try another search result.

## 10. Functional requirements

Priority definitions:

- **P0:** Required for the proof of concept.
- **P1:** Required before calling the MVP complete.
- **P2:** Useful follow-up that must not block the MVP.

### 10.1 Authentication and setup

| ID | Priority | Requirement |
|---|---|---|
| AUTH-01 | P0 | First launch requires creation of one administrator account. |
| AUTH-02 | P0 | Passwords are hashed with Argon2id or an equivalently modern password-hashing function. |
| AUTH-03 | P0 | Browser authentication uses server-side sessions and secure HTTP-only cookies. |
| AUTH-04 | P0 | All application pages and non-setup API endpoints require authentication after setup. |
| AUTH-05 | P1 | The administrator can change username and password. |
| AUTH-06 | P1 | Songarr can generate and regenerate an API key for future clients. |
| AUTH-07 | P1 | API clients can authenticate using `X-Api-Key`. |
| AUTH-08 | P1 | Login attempts are rate limited. |

### 10.2 Requests and duplicate checks

| ID | Priority | Requirement |
|---|---|---|
| REQ-01 | P0 | A user can create a request with artist, title, optional version, optional album, and quality preference. |
| REQ-02 | P0 | Requests receive a stable UUID. |
| REQ-03 | P0 | Songarr stores both display values and normalized comparison values. |
| REQ-04 | P0 | Songarr warns about matching active or ready requests. |
| REQ-05 | P1 | A user can intentionally override a duplicate warning. |
| REQ-06 | P1 | A user can cancel or retry an eligible request. |

### 10.3 Search and selection

| ID | Priority | Requirement |
|---|---|---|
| SRCH-01 | P0 | Songarr searches the configured Prowlarr instance. |
| SRCH-02 | P0 | Search results show release name, indexer, size, age, seeders, and inferred format when available. |
| SRCH-03 | P0 | The user manually selects a release. |
| SRCH-04 | P1 | Results can be sorted by seeders, size, age, or inferred quality. |
| SRCH-05 | P1 | The search can be manually rerun with an edited query. |

### 10.4 qBittorrent integration

| ID | Priority | Requirement |
|---|---|---|
| QBT-01 | P0 | Songarr authenticates with one configured qBittorrent instance. |
| QBT-02 | P0 | Added torrents use category `songarr` and a unique request tag. |
| QBT-03 | P0 | Songarr resolves and stores the torrent hash after adding a release. |
| QBT-04 | P0 | Torrents remain stopped/paused while metadata and file selection are pending. |
| QBT-05 | P0 | Songarr can list torrent files and set per-file priorities. |
| QBT-06 | P0 | Songarr downloads the confirmed audio file and disables unwanted files. |
| QBT-07 | P0 | Songarr displays progress and qBittorrent state. |
| QBT-08 | P0 | Songarr never changes a torrent it cannot positively identify as its own. |
| QBT-09 | P1 | Songarr detects when an owned torrent was manually removed or changed. |

### 10.5 Import and ready-folder processing

| ID | Priority | Requirement |
|---|---|---|
| IMP-01 | P0 | Songarr validates that the selected file contains an audio stream. |
| IMP-02 | P0 | Songarr prevents path traversal and output outside configured roots. |
| IMP-03 | P0 | Songarr copies through a hidden processing path before an atomic final rename. |
| IMP-04 | P0 | Songarr uses a filesystem-safe, deterministic output name. |
| IMP-05 | P0 | Songarr preserves the source file and does not break qBittorrent seeding. |
| IMP-06 | P0 | Songarr never silently overwrites an existing ready file. |
| IMP-07 | P1 | Songarr records output path, format, size, and completion date. |
| IMP-08 | P1 | Songarr reports insufficient disk space or permission failures clearly. |

### 10.6 Activity, history, and system

| ID | Priority | Requirement |
|---|---|---|
| SYS-01 | P0 | Activity shows all nonterminal requests and their progress. |
| SYS-02 | P0 | History shows request state changes and errors. |
| SYS-03 | P0 | System Status reports Prowlarr, qBittorrent, database, path writability, and free disk space. |
| SYS-04 | P1 | Logs can be viewed and filtered in the UI. |
| SYS-05 | P1 | Sensitive values are redacted from logs and UI responses. |
| SYS-06 | P1 | The database can be backed up from the UI or a documented command. |

## 11. State model

Use explicit persisted states. Suggested values:

```text
requested
searching
awaiting_release_selection
adding_torrent
awaiting_torrent_metadata
awaiting_file_selection
downloading
processing
ready
needs_review
failed
cancelled
```

Allowed primary transitions:

```text
requested -> searching
searching -> awaiting_release_selection
awaiting_release_selection -> adding_torrent
adding_torrent -> awaiting_torrent_metadata
awaiting_torrent_metadata -> awaiting_file_selection
awaiting_file_selection -> downloading
downloading -> processing
processing -> ready
any active state -> failed
any active state -> cancelled
failed -> searching | awaiting_release_selection | awaiting_file_selection
needs_review -> processing | cancelled
```

Every state change must be written transactionally with a history event. Background processing should be idempotent: running the same reconciliation step twice must not create a second torrent or second ready copy.

## 12. Minimal data model

Exact column names may vary, but the model must preserve the following concepts.

### 12.1 `users`

- `id`
- `username`
- `password_hash`
- `created_at`
- `updated_at`

Only one user is supported in the MVP.

### 12.2 `sessions`

- `id`
- `user_id`
- `token_hash`
- `expires_at`
- `created_at`
- `last_seen_at`

### 12.3 `requests`

- `id` UUID
- Display artist, title, version, and album
- Normalized artist, title, and version
- Preferred quality
- Current state
- Failure code and human-readable failure message
- Duplicate override flag
- Final ready path
- Final format and size
- Created, updated, and completed timestamps

### 12.4 `search_results`

- `id`
- `request_id`
- Prowlarr/indexer result identifier when available
- Release title
- Indexer name
- Download URL or reference stored server-side
- Size, age, seeders, and leechers
- Inferred format
- Selected flag
- Raw response subset needed for debugging, excluding secrets
- Created timestamp

### 12.5 `downloads`

- `id`
- `request_id`
- qBittorrent hash
- Request-specific qBittorrent tag
- qBittorrent category
- Selected file index and relative path
- qBittorrent state
- Progress
- Download path
- Last synchronized timestamp
- Created and completed timestamps

### 12.6 `events`

- `id`
- `request_id`
- Event type
- From state
- To state
- Human-readable message
- Sanitized detail JSON
- Created timestamp

### 12.7 `settings`

- Prowlarr base URL and API key
- qBittorrent base URL, username, and password
- Download root
- Ready root
- Default quality preference
- Torrent metadata timeout
- Application URL base, if supported
- Log level
- API key hash

Secrets must never be returned to the browser after saving. The `/config` directory and database should use restrictive filesystem permissions. At-rest secret encryption is desirable later but not required for this private-network MVP.

## 13. API surface

The React UI should consume the same versioned JSON API that a future client could use. Endpoint naming may be refined, but the MVP should expose equivalent capabilities.

### 13.1 Authentication

```http
POST /api/v1/auth/setup
POST /api/v1/auth/login
POST /api/v1/auth/logout
GET  /api/v1/auth/me
POST /api/v1/auth/api-key/regenerate
```

### 13.2 Requests

```http
GET  /api/v1/requests
POST /api/v1/requests
GET  /api/v1/requests/{id}
POST /api/v1/requests/{id}/search
POST /api/v1/requests/{id}/select-release
GET  /api/v1/requests/{id}/torrent-files
POST /api/v1/requests/{id}/select-file
POST /api/v1/requests/{id}/retry
POST /api/v1/requests/{id}/cancel
GET  /api/v1/requests/{id}/events
```

### 13.3 System and settings

```http
GET  /api/v1/health
GET  /api/v1/system/status
GET  /api/v1/system/logs
POST /api/v1/system/backup
GET  /api/v1/settings
PUT  /api/v1/settings/prowlarr
POST /api/v1/settings/prowlarr/test
PUT  /api/v1/settings/qbittorrent
POST /api/v1/settings/qbittorrent/test
PUT  /api/v1/settings/media-management
PUT  /api/v1/settings/general
```

API responses must use consistent error objects and HTTP status codes. Long-running actions should update persisted request state rather than keep an HTTP request open until completion.

## 14. Quality preferences and matching

### 14.1 MVP quality options

1. **FLAC preferred:** Rank releases containing clear FLAC/lossless hints above MP3; do not automatically reject alternatives.
2. **MP3 320 preferred:** Rank clear MP3 320 releases above others; do not automatically reject FLAC.
3. **Any supported audio:** Do not prioritize a specific supported format.

These are ranking hints, not automatic grab profiles. The user remains responsible for selecting the release and file.

### 14.2 File-match recommendation

The MVP matcher should be deterministic and explainable. It may award or subtract points for:

- Exact normalized title in filename.
- Artist present in filename or parent folder.
- Requested version present in filename.
- Conflicting version terms such as `live`, `remix`, `instrumental`, or `radio edit`.
- Preferred extension.
- Track-number prefixes.
- Unsupported extension.

Display the proposed match and a simple confidence label such as High, Medium, or Low. Do not hide other selectable audio files.

## 15. Reliability and reconciliation

A small background loop should periodically reconcile nonterminal requests with qBittorrent. It must:

- Resume monitoring after process restart.
- Resolve a newly added torrent using its unique request tag.
- Update progress and qBittorrent state.
- Detect metadata availability.
- Detect selected-file completion.
- Start processing at most once.
- Detect missing torrents.
- Record integration failures without losing the request.

Use database transactions and request-level locking or compare-and-set state transitions to prevent concurrent processing of the same request. A separate distributed queue is not justified for the MVP.

## 16. Failure handling

At minimum, Songarr must produce actionable errors for:

- Prowlarr unavailable or unauthorized.
- qBittorrent unavailable or unauthorized.
- Prowlarr returns no results.
- Selected release cannot be submitted.
- Torrent cannot be correlated after submission.
- Torrent metadata timeout.
- Torrent has no supported audio files.
- Selected file disappears or is manually deselected.
- Torrent is manually removed.
- Download stalls or errors.
- Completed path cannot be resolved safely.
- Source file is missing.
- `ffprobe` rejects the file or finds no audio stream.
- Download or ready directory is not writable.
- Insufficient disk space.
- Destination file already exists.
- Application restart during processing.

Each error must include a stable internal code, a user-readable message, and a recommended next action. Stack traces belong in sanitized server logs, not user-facing API responses.

## 17. Security requirements

- Designed for private-network deployment; documentation must warn against direct unauthenticated internet exposure.
- Forms authentication is required after setup.
- Passwords use Argon2id or equivalent hashing.
- Session cookies use `HttpOnly` and `SameSite=Lax` or stricter; `Secure` is enabled when HTTPS is used.
- State-changing cookie-authenticated requests require CSRF protection.
- Login and setup endpoints are rate limited.
- API keys are high-entropy, shown only when generated, and stored as hashes where practical.
- Prowlarr and qBittorrent credentials remain server-side.
- Logs redact passwords, API keys, cookies, magnet URLs, and authenticated download URLs.
- Filesystem paths received from qBittorrent are treated as untrusted input.
- All resolved source and destination paths must remain beneath configured roots.
- Songarr cannot delete or modify torrents without positive category, tag, and stored-hash ownership checks.
- Container should run as a non-root user with configurable UID/GID when practical.

## 18. Non-functional requirements

### 18.1 Performance

- Normal authenticated page/API responses should complete within 500 ms on the target home server, excluding external service calls.
- Search and connection tests may take longer but must show loading state and enforce timeouts.
- The background reconciler should not poll qBittorrent more aggressively than necessary; a 5–10 second interval is adequate for active downloads.

### 18.2 Compatibility

- Target the currently deployed qBittorrent Web API and current Prowlarr API rather than building a broad compatibility matrix.
- Support modern Chromium, Firefox, and Safari browsers.
- Support Linux amd64 Docker deployment first.

### 18.3 Observability

- Structured application logs with timestamp, level, component, request ID, and sanitized message.
- Configurable log level.
- Health endpoint suitable for a Docker health check.
- Status page for dependency connectivity and storage health.

### 18.4 Maintainability

- Clear adapters for Prowlarr and qBittorrent integrations.
- Database migrations committed with the application.
- Unit tests for normalization, matching, naming, safe paths, and state transitions.
- Integration tests using mocked Prowlarr/qBittorrent HTTP services.
- Avoid premature abstraction for additional download clients or indexer managers.

## 19. Deployment requirements

The repository should include:

- Production `Dockerfile`.
- Example `docker-compose.yml`.
- `.env.example` containing only non-secret placeholders.
- Persistent `/config`, `/downloads`, and `/ready` volume documentation.
- Configurable port, defaulting to a documented unused value.
- Configurable UID/GID or a clearly documented container user strategy.
- Docker health check.
- Upgrade instructions that preserve `/config` and the SQLite database.
- Backup and restore instructions.
- Connection examples for Prowlarr and qBittorrent when services share a Docker network or when qBittorrent is reachable through a Gluetun container.

Songarr must not alter the user's existing media-stack Compose files automatically.

## 20. Testing and acceptance criteria

### 20.1 Authentication

- On an empty `/config` volume, the setup wizard is shown.
- After setup, unauthenticated users are redirected to login.
- Valid credentials create a session; invalid credentials do not.
- The administrator can log out and change the password.
- A generated API key authenticates API requests and can be revoked by regeneration.

### 20.2 Search and selection

- A request can be created with only artist, title, and a default quality preference.
- Likely duplicates cause a warning rather than a silent duplicate.
- Prowlarr results appear with the required available fields.
- Selecting a result creates exactly one qBittorrent torrent tagged for that request.
- Repeating a timed-out API action does not create another torrent for the same request.

### 20.3 Torrent inspection

- The torrent remains stopped/paused until a file is confirmed.
- Songarr displays supported audio files after metadata arrives.
- A likely filename match is highlighted.
- The user can select a different audio file.
- Unwanted files receive do-not-download priority before the torrent starts.

### 20.4 Download and restart recovery

- Activity displays selected-file progress.
- Restarting Songarr during download does not create a duplicate request or torrent.
- After restart, Songarr resumes tracking the same torrent hash.
- Removing the torrent manually produces a clear failed state.

### 20.5 Processing and output

- Songarr waits until the selected file is complete.
- Invalid or non-audio content is not copied to the final ready path.
- Valid audio is first copied into `.processing` and then atomically renamed.
- The final filename is safe and deterministic.
- Existing files are never silently overwritten.
- The qBittorrent source remains present for seeding.
- A Ready request records its final server path, format, size, and completion time.

### 20.6 Isolation

- Songarr does not list, pause, reprioritize, remove, or process torrents owned by Sonarr, Radarr, Lidarr, or manual qBittorrent activity except where qBittorrent's global status is read for health information.

## 21. Implementation phases

### Phase 1: Application shell

- Repository and TypeScript workspace.
- SQLite migrations.
- First-run setup and Forms authentication.
- Arr-inspired layout and navigation.
- Settings persistence.
- System health checks.

### Phase 2: Request and search

- Request CRUD and duplicate warnings.
- Prowlarr adapter and connection test.
- Search-results table.
- Manual release selection.

### Phase 3: Torrent inspection

- qBittorrent adapter and connection test.
- Safe torrent submission with category and unique tag.
- Hash correlation and metadata polling.
- File listing, match recommendation, and user confirmation.

### Phase 4: Download and processing

- File-priority control.
- Progress reconciliation and restart recovery.
- Completion detection.
- `ffprobe` validation.
- Safe copy and atomic ready-folder publication.

### Phase 5: MVP hardening

- Retry and cancel flows.
- History and logs UI.
- Database backup.
- Security review.
- Docker packaging and documentation.
- Unit and integration test coverage for critical paths.

## 22. Future possibilities

These ideas should be documented but not implemented during the MVP:

- Automatic high-confidence release and file selection.
- Metadata lookup and robust tag writing.
- Album artwork handling.
- MusicBrainz and Discogs integrations.
- Audio fingerprinting.
- Spotify playlist comparison.
- Rekordbox library/export integration.
- A desktop sync client that lists ready tracks via the Songarr API.
- SMB or Syncthing-based ready-folder distribution.
- Notifications.
- Multiple users and request permissions.
- Additional download clients.
- Automatic fallback to another release.
- Ready-file archive/export state.

## 23. Implementation-agent instructions

The implementation agent should:

1. Treat this document as the source of truth for MVP scope.
2. Inspect the repository and any local agent instructions before choosing exact libraries or editing files.
3. Produce a short technical plan mapped to the implementation phases before coding.
4. Confirm the deployed Prowlarr and qBittorrent API behaviour against their current official API documentation.
5. Prefer the simplest architecture that satisfies restart safety and idempotency.
6. Build integration adapters behind small interfaces, but do not generalize for unsupported services.
7. Implement Arr-inspired visuals from scratch; do not copy GPL source code, logos, or proprietary assets.
8. Include safe defaults and an example Docker Compose deployment without modifying the existing media stack automatically.
9. Add automated tests for critical normalization, state, ownership, and path-safety behaviour.
10. Stop and surface a decision rather than expanding into a non-goal.

## 24. Definition of done

Songarr MVP is done when:

- It can be installed as a self-contained Docker application.
- A user can complete first-run setup and authenticate.
- Prowlarr and qBittorrent connections can be configured and tested.
- A user can request a song, choose a search result, and confirm one audio file.
- Songarr downloads only the selected content to the extent qBittorrent piece boundaries allow.
- Songarr survives restarts without duplicating work.
- A valid, safely named copy appears atomically in the configured ready folder.
- Existing ready files and unrelated torrents are protected.
- Failures are visible and manually recoverable.
- The critical acceptance scenarios pass.
- No excluded playback, playlist, Rekordbox, external sync, or full-library functionality has been added.

