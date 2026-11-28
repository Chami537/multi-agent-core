# Docker Validation Report (Phase 1 D2b)

- **Date**: 2026-11-28
- **Baseline**: `main` (`1936924`) + Phase 1 D2b conformance & fault-injection suites
- **Dockerfile**: `Dockerfile` (unmodified; `FROM node:24.21.0-bookworm`)

## Build Result

- **Status**: `ok`
- **Image**: `multi-agent-core:d2b-test`
- **Image Size**: `1.74GB`
- **Build Elapsed**: `36.55s` (`docker build -t multi-agent-core:d2b-test .`)
- **Note**: On WSL2 hosts where `~/.docker/config.json` configures `credsStore: desktop.exe` without the Windows helper in `$PATH`, `docker build` failed at metadata fetch (`exec: "docker-credential-desktop.exe": executable file not found in $PATH`). Building with an isolated empty `DOCKER_CONFIG` temporary directory resolved the host credential-helper lookup without modifying `Dockerfile`.

## Container Test Execution

- **Command**: `docker run --rm multi-agent-core:d2b-test` (`npm test` -> `npm run build && vitest run`)
- **Status**: `ok`
- **Total Elapsed**: `59.32s` (Vitest duration `56.28s`)
- **Result**: `18` test files passed, `255/255` tests passed (231 baseline + 20 runner conformance + 4 SQLite/NDJSON `SIGKILL` fault injection).
