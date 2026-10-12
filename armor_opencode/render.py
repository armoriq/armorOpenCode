import json
from typing import Optional


def render_json(report: dict) -> str:
    return json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2) + "\n"


def _number(value: Optional[int]) -> str:
    return "unknown" if value is None else format(value, ",")


def _table(headers, rows) -> str:
    values = [["".join(character if ord(character) >= 32 and ord(character) != 127 else " " for character in str(value)) for value in row] for row in [headers] + list(rows)]
    widths = [max(len(row[index]) for row in values) for index in range(len(headers))]
    return "\n".join("  ".join(value.ljust(widths[index]) for index, value in enumerate(row)) for row in values)


def render_table(report: dict) -> str:
    overview = report["overview"]
    budget = overview["budget"]
    lines = ["ArmorIQ / OpenCode telemetry", "",
             "Sessions " + _number(overview["sessions"]) + "  Models " + str(len(report["models"])) + "  Steps " + _number(overview["steps"]),
             "Tokens " + _number(overview["tokens"]) + "  Tool calls " + _number(overview["toolCalls"]),
             "Components  " + "  ".join(key + "=" + _number(value) for key, value in overview["breakdown"].items()),
             "Total budget  actual=" + _number(budget["actual"]) + " limit=" + _number(budget["limit"]) + " remaining=" + _number(budget["remaining"]) + " status=" + budget["status"],
             "Inherited history  messages=" + str(overview["inheritedMessages"]) + " tools=" + str(overview["inheritedToolCalls"]) + " tokens=" + _number(overview["inheritedTokens"]), "", "Models",
             _table(["Provider/model", "Family", "Tokens", "Tools", "Errors"],
                    [(row["id"], row["family"], _number(row["tokens"]), row["toolCalls"], row["toolOutcomes"]["error"]) for row in report["models"]]),
             "", "Sessions",
             _table(["Session ID", "Tokens", "Tools", "Target", "Remaining", "Budget"],
                    [(row["id"], _number(row["tokens"]), row["toolCalls"], _number(row["budget"]["limit"]), _number(row["budget"]["remaining"]), row["budget"]["status"]) for row in report["sessions"]]),
             "", "Daily usage (" + report["metadata"]["timezone"] + ")",
             _table(["Date", "Tokens", "Tools"], [(row["date"], _number(row["tokens"]), row["toolCalls"]) for row in report["days"]]),
             "", "Tools",
             _table(["Tool", "Calls", "Completed", "Error", "Running", "Pending", "Unknown"],
                    [(row["name"], row["calls"], *[row["outcomes"][key] for key in ("completed", "error", "running", "pending", "unknown")]) for row in report["tools"]]),
             "", report["metadata"]["notice"]]
    if overview["missingUsageSteps"]:
        lines.append("Incomplete usage  " + str(overview["missingUsageSteps"]) + " steps; known tokens=" + _number(overview["knownTokens"]))
    if report["diagnostics"]:
        from collections import Counter
        lines.append("Diagnostics  " + "  ".join(key + "=" + str(value) for key, value in sorted(Counter(item["code"] for item in report["diagnostics"]).items())))
    return "\n".join(lines) + "\n"


def render_trace(report: dict, session_id: str) -> str:
    trace = next((row for row in report["traces"] if row["sessionID"] == session_id), None)
    if trace is None:
        return "No retained telemetry matches this session and filter.\n"
    lines = ["Session " + session_id, "", "Usage steps",
             _table(["Step ID", "Model", "Tokens", "Basis", "Inherited"],
                    [(row["id"], row["model"], _number(row["tokens"]), row["basis"], row["inherited"]) for row in trace["steps"]]),
             "", "Tool calls",
             _table(["Tool", "Outcome", "Duration ms", "Model", "Inherited"],
                    [(row["name"], row["status"], _number(row["durationMs"]), row["model"], row["inherited"]) for row in trace["tools"]]),
             "", "Per-tool token attribution is unavailable. Trace contains metadata only."]
    return "\n".join(lines) + "\n"
