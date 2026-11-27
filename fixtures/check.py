#!/usr/bin/env python3
"""Validate fixtures offline; --sources also compares local, read-only provenance."""

import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SECRET_KEYS = {
    "apikey", "authorization", "proxyauthorization", "cookie", "cookies",
    "setcookie", "accesstoken", "refreshtoken", "idtoken", "token",
    "password", "passwd", "clientsecret", "secret", "credentials", "headers",
    "authtoken", "bearertoken", "sessiontoken",
}
PROMPT_KEYS = {"prompt", "systemprompt", "task", "userprompt", "instructions"}
CONTENT_KEYS = {
    "input", "output", "result", "text", "content", "command", "commandline",
    "description", "title", "titlesummary", "summary", "reasoning", "arguments",
}
IDENTIFIERS = {
    "type", "id", "sessionId", "turnId", "stepId", "toolCallId", "authFailureId",
    "backend", "runner", "provider", "kind", "role", "status", "stopReason",
    "reason", "toolKind", "model", "modelIdentity", "tool", "tools", "name",
    "completionReason", "workflow",
}
SAFE_ERRORS = {
    "API Error: 502 status code (no body). This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway (127.0.0.1:<gateway-port>).",
    "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 6:18 PM. [usageLimitExceeded]",
    "FAILED_PRECONDITION (code 400): User location is not supported for the API use.",
    "authentication failed or timed out",
    "Antigravity authentication failed — run `agy` in a terminal and sign in with your Google account.",
    "the session closed after inactivity before the task declared completion — continue to resume it",
}
SAFE_LIFECYCLE = {
    "goal achieved — session closed", "run finished", "run cancelled",
    "session closed after 15m of inactivity",
    "run closed after inactivity — nobody replied; Continue to resume it",
    "The agent is not signed in or its login expired — sign in again (Settings → Agents → Accounts, or the agent's own login command in a terminal), then Continue this task",
}
LIFECYCLE_PATTERNS = [
    r'run (?:started|resumed) — workflow "quick-task" \(runner: (?:claude|codex|antigravity)\)',
    r'temporary provider failure — retrying automatically at [A-Za-z0-9 ,:/+()]+',
    r'retrying after a temporary provider failure \([12]/2\)',
    r'usage limit reached — resuming automatically at [A-Za-z0-9 ,:/+()]+',
    r'usage limit reset — resuming automatically \(1/12\)',
]
RUN_FIELDS = (
    "id", "title", "titleSummary", "workflow", "task", "systemPrompt", "runner",
    "model", "modelIdentity", "status", "completionReason", "createdAt",
    "startedAt", "finishedAt", "tokensUsed", "inputTokens", "outputTokens",
    "costUsd", "liveUsage", "lastSeq",
)
STEP_FIELDS = (
    "id", "status", "iterations", "tokensUsed", "inputTokens", "outputTokens",
    "costUsd", "usageInvocationsStarted", "usageInvocationsObserved",
    "usageTurnsStarted", "usageTurnsRecorded", "usageInvocationEpoch",
    "startedAt", "finishedAt", "sessionId", "backend", "modelIdentity", "error",
)
SECRET_PATTERN = re.compile(
    r"\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|"
    r"AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|"
    r"Bearer\s+[A-Za-z0-9._~+/-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)"
)


def normalized(key):
    return re.sub(r"[^a-z0-9]", "", key.lower())


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical_digest(value):
    return digest(json.dumps(value, ensure_ascii=False, sort_keys=True).encode())


def sanitize(value, path=(), event_type=None, content=False):
    """Default-deny free text, retaining JSON shape and numeric measurements."""
    if isinstance(value, dict):
        event_type = event_type or value.get("type")
        return {
            key: sanitize(child, path + (key,), event_type,
                            content or normalized(key) in CONTENT_KEYS
                            or normalized(key) in PROMPT_KEYS)
            for key, child in value.items() if normalized(key) not in SECRET_KEYS
        }
    if isinstance(value, list):
        return [sanitize(child, path, event_type, content) for child in value]
    if not isinstance(value, str):
        return value
    key = path[-1] if path else ""
    if any(normalized(part) in PROMPT_KEYS for part in path):
        return "[REDACTED:PROMPT]"
    if content:
        return "[REDACTED:TEXT]"
    # Only reviewed control errors retain their text; tool errors are masked.
    control_error = (
        path == ("message",) and event_type in {"error", "session.error", "session.ended"}
    ) or path in {("error",), ("steps", "error")}
    if control_error and value in SAFE_ERRORS:
        return value
    if event_type == "lifecycle" and path == ("message",):
        if (value in SAFE_LIFECYCLE
                or any(re.fullmatch(pattern, value) for pattern in LIFECYCLE_PATTERNS)
                or any(value == 'run failed — step "task" failed: ' + err for err in SAFE_ERRORS)):
            return value
    if key in IDENTIFIERS and re.fullmatch(r"[A-Za-z0-9_./:@-]{0,160}", value):
        return value
    if key in {"ts", "at", "createdAt", "startedAt", "finishedAt"} and re.fullmatch(
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value):
        return value
    if path == ("cwd",) and re.fullmatch(r"/home/rinat/[A-Za-z0-9_./-]+", value):
        return value
    return "[REDACTED:TEXT]"


def project_run(run):
    result = {key: run[key] for key in RUN_FIELDS if key in run}
    result["steps"] = [
        {key: step[key] for key in STEP_FIELDS if key in step}
        for step in run.get("steps", [])
    ]
    return sanitize(result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", action="store_true")
    args = parser.parse_args()
    manifest = json.loads((ROOT / "manifest.json").read_text())
    totals = Counter()
    expected = set()
    for sample in manifest["samples"]:
        stream = ROOT / sample["stream"]
        record = ROOT / sample["run_record"]
        expected.update((stream, record))
        data = stream.read_bytes()
        rows = [json.loads(line) for line in data.decode().splitlines()]
        run = json.loads(record.read_text())
        assert digest(data) == sample["fixture_sha256"], stream
        assert len(rows) == len(sample["source_lines"]), stream
        assert [row["seq"] for row in rows] == sample["seqs"], stream
        assert all(a["seq"] < b["seq"] for a, b in zip(rows, rows[1:])), stream
        assert run["id"] == sample["run_id"] and run["runner"] == sample["runner"], record
        assert canonical_digest(run) == sample["run_projection_sha256"], record
        totals[sample["runner"]] += len(rows)
        # Validate default-deny redaction even without the local source records.
        assert sanitize(rows) == rows, stream
        assert project_run(run) == run, record
        for path in (stream, record):
            assert not SECRET_PATTERN.search(path.read_text()), path
        assert rows[0]["seq"] == sample["first_source_seq"], stream
        assert rows[-1]["seq"] == sample["last_source_seq"], stream
        if args.sources:
            source = Path(sample["source_stream"])
            original = source.read_bytes()
            assert digest(original) == sample["source_sha256"], source
            raw_rows = [json.loads(line) for line in original.decode().splitlines()]
            assert len(raw_rows) == sample["source_line_count"], source
            selected = [sanitize(raw_rows[n - 1]) for n in sample["source_lines"]]
            assert rows == selected, stream
            source_runs = json.loads(Path(sample["source_runs"]).read_text())
            raw_run = next(r for r in source_runs if r["id"] == sample["run_id"])
            assert canonical_digest(raw_run) == sample["source_run_sha256"], record
            assert run == project_run(raw_run), record
    assert set(totals) == {"claude", "codex", "antigravity"}
    assert all(0 < count <= 200 for count in totals.values()), totals
    assert set((ROOT / "runners").glob("*/*")) == expected
    for path in ROOT.rglob("*"):
        if path.is_file():
            assert not SECRET_PATTERN.search(path.read_text()), path
    print(f"PASS: {len(manifest['samples'])} runs; event lines {dict(totals)}; "
          "JSON, hashes, ordering, redaction and file inventory valid"
          + ("; local sources unchanged and extraction matches" if args.sources else ""))


if __name__ == "__main__":
    main()
