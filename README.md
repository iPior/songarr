# Songarr

Songarr is a planned self-hosted, track-first request manager for individual music downloads. It is intended to run alongside the Arr stack and automate the gap between requesting one song and receiving a validated, consistently named file in a server-side ready folder.

> [!IMPORTANT]
> Songarr is currently in the planning and proof-of-concept stage. There is no usable release yet.

## Why Songarr?

Lidarr is built primarily around artists and complete albums. Songarr is being designed for the smaller workflow of requesting one specific track without turning the entire artist or album into the managed unit.

The planned MVP will:

1. Accept an artist, track title, optional version, and preferred format.
2. Search configured indexers through Prowlarr.
3. Let the user manually select a torrent release.
4. Inspect the files inside the torrent and suggest the likely track.
5. Let the user confirm the exact file to download.
6. Use qBittorrent to download the selected file while leaving unrelated torrent contents disabled.
7. Validate the completed audio and copy it into a clean `ready` folder.

```text
Song request
    -> Prowlarr search
    -> release selection
    -> qBittorrent inspection
    -> file selection
    -> download
    -> validation
    -> ready folder
```

## Planned application shape

Songarr is intended to feel like another Arr application:

- Self-hosted with Docker
- Arr-inspired interface
- Built-in Forms login
- SQLite database
- Activity queue and history
- Prowlarr integration
- qBittorrent integration
- Persistent, restart-safe request state
- API-key authentication for future integrations

The first version will intentionally keep release and file selection manual. Music releases can contain remixes, radio edits, live recordings, remasters, and other ambiguous variants, so reliable user confirmation is more important than premature automation.

## Out of scope for the MVP

Songarr is not intended to provide:

- Music playback
- Full artist or album management
- Spotify or playlist synchronization
- Automatic release selection
- Audio transcoding
- Multi-user request management

The MVP ends when a validated copy of the requested track appears in the configured server-side `ready` folder. Rekordbox, desktop synchronization, SMB, and other downstream workflows can be developed independently.

## Documentation

The complete MVP requirements, architecture, workflows, state model, API outline, and acceptance criteria are documented in the [Product Requirements Document](docs/PRD.md).

## Project status

The current focus is validating the product design and implementing the smallest reliable proof of concept. The PRD is the source of truth for MVP scope.

## Responsible use

Songarr is intended for material that the user is authorized to access and download. Users are responsible for complying with applicable laws and the terms of the services and sources they configure.

