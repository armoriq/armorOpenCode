import json
from pathlib import Path
import sqlite3
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]


def run_report(source, *arguments):
    process = subprocess.run(
        [sys.executable, "-m", "armor_opencode", "report", "--source", str(source),
         "--format", "json", *arguments],
        cwd=ROOT, capture_output=True, text=True, check=True,
    )
    return json.loads(process.stdout)


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python3 scripts/verify_local.py /path/to/opencode.db")
    source = Path(sys.argv[1]).expanduser().resolve()
    connection = sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)
    connection.execute("PRAGMA query_only=ON")
    connection.execute("BEGIN")
    rows = connection.execute("""
        SELECT m.id, m.session_id, json_extract(m.data, '$.providerID'),
               json_extract(m.data, '$.modelID'),
               COALESCE(json_extract(m.data, '$.time.created'), m.time_created),
               s.time_created,
               json_extract(m.data, '$.tokens')
        FROM message m JOIN session s ON s.id = m.session_id
        WHERE json_extract(m.data, '$.role') = 'assistant'
    """).fetchall()
    expected = {}
    inherited = set()
    for message_id, session_id, provider, model, created, session_created, fallback in rows:
        if created < session_created:
            inherited.add(message_id)
            continue
        key = (provider or "unknown") + "/" + (model or "unknown")
        group = expected.setdefault(key, {"tokens": 0, "messages": 0, "toolCalls": 0})
        group["messages"] += 1
        finishes = connection.execute("""
            SELECT json_extract(data, '$.tokens') FROM part
            WHERE message_id = ? AND json_extract(data, '$.type') = 'step-finish'
        """, (message_id,)).fetchall()
        for raw in [row[0] for row in finishes] if finishes else [fallback]:
            if raw is None:
                raise AssertionError("Local usage has an unmeasured step; inspect its diagnostic.")
            tokens = json.loads(raw)
            group["tokens"] += sum(tokens[field] for field in ("input", "output", "reasoning"))
            group["tokens"] += tokens["cache"]["read"] + tokens["cache"]["write"]
        group["toolCalls"] += connection.execute("""
            SELECT COUNT(DISTINCT COALESCE(json_extract(data, '$.callID'), id))
            FROM part WHERE message_id = ? AND json_extract(data, '$.type') = 'tool'
        """, (message_id,)).fetchone()[0]
    session_count = connection.execute("SELECT COUNT(*) FROM session").fetchone()[0]
    connection.close()

    report = run_report(source)
    assert report["overview"]["sessions"] == session_count
    assert report["overview"]["tokens"] == sum(group["tokens"] for group in expected.values())
    assert report["overview"]["toolCalls"] == sum(group["toolCalls"] for group in expected.values())
    actual = {model["id"]: {key: model[key] for key in ("tokens", "messages", "toolCalls")}
              for model in report["models"] if model["messages"]}
    assert actual == expected, (actual, expected)

    repeated = run_report(source)
    for field in ("overview", "models", "sessions", "days", "tools", "traces", "diagnostics"):
        assert report[field] == repeated[field], field
    limited = run_report(source, "--total-budget", "0", "--session-budget", "0")
    assert limited["overview"]["budget"]["actual"] == report["overview"]["tokens"]
    assert limited["overview"]["budget"]["status"] == "exceeded"
    for session in limited["sessions"]:
        assert session["budget"]["actual"] == session["tokens"]
        assert session["budget"]["status"] == ("exceeded" if session["tokens"] else "within")
    for key, group in expected.items():
        selected = run_report(source, "--model", key)
        assert selected["overview"]["tokens"] == group["tokens"], key
        assert selected["overview"]["toolCalls"] == group["toolCalls"], key
    print(json.dumps({"verified": True, "sessions": session_count, "models": len(expected),
                      "tokens": report["overview"]["tokens"],
                      "toolCalls": report["overview"]["toolCalls"],
                      "checks": ["independent SQL reconciliation", "repeat scans", "both budget scopes", "every model filter"]}, indent=2))


if __name__ == "__main__":
    main()
