# Changelog

## Unreleased

### Added

- Room activity now combines human discussion with published Work Updates.
- Task ChangeSet linking and owner-reviewed code-task merge flow.
- Participant room index persistence and online-member selectors.
- Public repository metadata and release hygiene checks for documentation and local configuration.

### Changed

- README now documents requirements, installation, host/participant flow, connection modes, privacy boundaries and current limitations.
- Internal design records, generated Graphify output and machine-local E2E settings are no longer tracked.
- The collaboration room surface is ordered as Activity, Tasks, Changes, Review.
- Collab UI copy is localized in Simplified Chinese and English.

### Fixed

- ChangeSets can be generated from materialized rooms without a Git directory.
- Task claim and unclaim mutations are idempotent.
- Room workspace baselines preserve line endings.
