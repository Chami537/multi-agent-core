# multi-agent-core

**multi-agent-core** is a supervisor core for orchestrating CLI coding agents such as
Codex and Claude Code. It replaces ad-hoc natural-language coordination with
structured, protocol-based task submission, run lifecycle management, capability
discovery, events, usage accounting, and conformance-checked runner integration.

## Status

- **Phase 1 was conditionally accepted on 2026-11-28** after 279 tests passed.
- The **Claude adapter (D2c)** is still pending; the Claude adapter must be
  delivered before Phase 2 begins or with the first Phase 2 batch.
- The Phase 2 entry criteria record **five conformance items** that came from
  the D2b suite delta review. Every real runner, including Claude, Codex, and
  Antigravity, must close these items before it can receive conformance
  admission:

  1. Verify forced termination and process-group cleanup for an original child
     process that ignores cancellation, with complete event assertions after
     stdout and process close.
  2. Reject contradictory capability combinations and connect RC-07/RC-08
     startup-count checks to the normal start path.
  3. Bind RC-39 session accounting, baseline subtraction, reset, and session
     changes to session semantics, and verify streaming usage frequency.
  4. Keep the public suite out of control sessions for `run.start`, and select
     mandatory profiles according to declared usage capabilities.
  5. Verify takeover recovery with side-effect counts instead of primary-key
     constraints, proving exactly-once consumption of global and activity
     side effects.

  The detailed criteria are recorded in
  [`docs/phase2-entry-criteria.md`](docs/phase2-entry-criteria.md).

## Architecture overview

multi-agent-core is a modular, single-machine TypeScript runtime for supervising
the work of separate CLI agent processes.

- **Core runtime**: owns the run state machine and pure scheduling decisions,
  launches and recovers runs, and records usage and lifecycle outcomes.
- **SQLite and NDJSON store**: uses SQLite for state and structured records,
  NDJSON for raw and normalized event data, and persisted byte offsets for
  recoverable, no-repeat consumption.
- **Per-run shim hosting**: starts each runner in an isolated shim process, keeps
  the shim and daemon responsibilities separate, and supports daemon-restart
  takeover and process-group cleanup.
- **HTTP API**: exposes the supervisor protocol over `/v0` REST endpoints with
  authentication, capability discovery, run controls, results, and event access.
- **Fake runner**: provides a local JSON-RPC/NDJSON reference endpoint and
  scriptable scenarios for lifecycle, cancellation, usage, fault, and
  conformance testing.
- **Conformance suite**: tests the public Supervisor and Runner protocols,
  including protocol coverage, capabilities, recovery, cancellation, usage,
  and runner-admission conditions.

The repository is currently at `0.1.0`.

## Quick start

### Prerequisites

- Node.js **24.21.x**; the repository pins `24.21.0` in `.node-version` and
  declares `24.21.x` in `package.json`.
- npm
- Linux or WSL2
- `/proc`, `/usr/bin/flock`, and `/usr/bin/git`

Tests use local temporary directories and do not require runner accounts,
credentials, or network services.

### Install and test

Dependencies are locked by `package-lock.json`:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run typecheck
```

`npm test` first performs a strict TypeScript build, then runs Vitest.
Integration tests start the built shim and fake runner as real child processes,
not mock subprocesses.

An optional container entry point is available:

```sh
docker build -t multi-agent-core-d1 .
docker run --rm --init multi-agent-core-d1
```

The container configuration is provided for validation; the Docker image build
and execution entry point should be run in the appropriate Linux environment.

## Repository layout

```text
src/
  core/       State types, validation, scheduling decisions, runtime, and usage
  store/      SQLite transactions, migrations, event ingestion, and NDJSON offsets
  host/       Run shim, process lifecycle, recovery, workspaces, and host logging
  runners/    Fake runner JSON-RPC endpoint and scenario definitions
  api/        HTTP API, authentication, protocol schemas, and run operations
  index.ts    Public core exports

tests/
  api/         API and protocol behavior
  conformance/ Supervisor and runner conformance checks
  faults/      Crash, recovery, and signal fault tests
  helpers/     Runtime, daemon, and endpoint test helpers
  fixtures/    Recorded runner fixture entry point

fixtures/
  runners/     Sanitized runner output fixtures
  manifest.json Fixture collection metadata

docs/
  phase0-design-plan.md         Approved architecture and phase plan
  supervisor-protocol.md        Upstream supervisor HTTP/SSE protocol
  runner-protocol.md            Downstream runner JSON-RPC/NDJSON protocol
  phase2-entry-criteria.md      Phase 2 conformance entry conditions
```

## Design documents

- [Phase 0 design plan](docs/phase0-design-plan.md)
- [Supervisor Protocol v0.2](docs/supervisor-protocol.md) — the upstream
  HTTP/JSON and SSE contract for supervisor clients
- [Runner Protocol v0.2](docs/runner-protocol.md) — the downstream JSON-RPC,
  NDJSON, capability, lifecycle, and conformance contract
- [Phase 2 entry criteria](docs/phase2-entry-criteria.md)

The protocols define version negotiation, capability admission, event recovery,
idempotency, run lifecycle, usage, security, and staged conformance requirements.
The implementation's conformance evidence is reported separately from the
protocol specifications.

## License

This project is licensed under the **MIT License**. See
[`LICENSE`](LICENSE).
