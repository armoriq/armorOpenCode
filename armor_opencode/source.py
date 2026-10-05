import json
import math
import os
import sqlite3
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .model import Message, ModelKey, Session, Snapshot, TokenUsage, ToolCall, UNKNOWN_MODEL, UsageStep


def default_sources() -> List[Path]:
    configured = os.environ.get("OPENCODE_DATA_DIR")
    if configured:
        return [Path(value.strip()).expanduser() for value in configured.split(",") if value.strip()]
    return [Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share"))) / "opencode"]


def _text(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value else None


def _integer(value: Any) -> Optional[int]:
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    return None


def _cost(value: Any) -> Optional[float]:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            if math.isfinite(value) and value >= 0:
                return float(value)
        except OverflowError:
            return None
    return None


def _object(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def _usage(value: Any) -> Optional[TokenUsage]:
    if not isinstance(value, dict):
        return None
    cache_value = value.get("cache", {})
    cache = _object(cache_value)
    return TokenUsage(
        _integer(value.get("input")), _integer(value.get("output")),
        _integer(value.get("reasoning", 0)), _integer(cache.get("read", 0)) if isinstance(cache_value, dict) else None,
        _integer(cache.get("write", 0)) if isinstance(cache_value, dict) else None, _integer(value.get("total")),
    )


def _model(row: dict) -> ModelKey:
    provider = _text(row.get("providerID"))
    model = _text(row.get("modelID"))
    return ModelKey(provider or "unknown", model or "unknown")


def _project(kind: str, data: dict) -> dict:
    timing = _object(data.get("time"))
    row = {
        "id": data.get("id"),
        "sessionID": data.get("sessionID"),
        "messageID": data.get("messageID"),
        "updated": timing.get("updated"),
        "created": timing.get("created"),
    }
    if kind == "session":
        row.update(parentID=data.get("parentID"))
    elif kind == "message":
        row.update(role=data.get("role"), providerID=data.get("providerID"), modelID=data.get("modelID"),
                   messageCreated=timing.get("created"), completed=timing.get("completed"),
                   tokens=data.get("tokens"), cost=data.get("cost"))
    else:
        state = _object(data.get("state"))
        state_time = _object(state.get("time"))
        row.update(type=data.get("type"), tool=data.get("tool"), callID=data.get("callID"),
                   status=state.get("status"), started=state_time.get("start"),
                   completed=state_time.get("end"), tokens=data.get("tokens"), cost=data.get("cost"))
    return row


def _sqlite_rows(path: Path, diagnostics: List[dict]) -> Dict[str, List[dict]]:
    result = {name: [] for name in ("session", "message", "part")}
    try:
        connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
        connection.row_factory = sqlite3.Row
        with connection:
            connection.execute("PRAGMA query_only=ON")
            connection.execute("BEGIN")
            schemas = {name: {row[1] for row in connection.execute('PRAGMA table_info("' + name + '")')}
                       for name in result}
            required = {"session": {"id", "time_created", "time_updated"},
                        "message": {"id", "session_id", "time_created", "data"},
                        "part": {"id", "message_id", "session_id", "time_created", "data"}}
            if any(not required[name].issubset(schemas[name]) for name in result):
                diagnostics.append({"code": "unsupported_schema", "message": "SQLite source lacks supported OpenCode tables or columns."})
                return result
            parent = "parent_id" if "parent_id" in schemas["session"] else "NULL"
            for row in connection.execute("SELECT id, " + parent + " AS parentID, time_created AS created, time_updated AS updated FROM session"):
                result["session"].append(dict(row))
            projections = {
                "message": {"role": "$.role", "providerID": "$.providerID", "modelID": "$.modelID",
                            "messageCreated": "$.time.created", "completed": "$.time.completed", "tokens": "$.tokens", "cost": "$.cost"},
                "part": {"type": "$.type", "tool": "$.tool", "callID": "$.callID", "status": "$.state.status",
                         "started": "$.state.time.start", "completed": "$.state.time.end", "tokens": "$.tokens", "cost": "$.cost"},
            }
            for name, fields in projections.items():
                valid = "CASE WHEN json_valid(data) THEN json_type(data) = 'object' ELSE 0 END"
                invalid = connection.execute("SELECT COUNT(*) FROM " + name + " WHERE NOT (" + valid + ")").fetchone()[0]
                if invalid:
                    diagnostics.append({"code": "malformed_json", "message": "Invalid JSON rows were skipped.", "kind": name, "count": invalid})
                columns = ["id", "session_id AS sessionID", "time_created AS created"]
                columns.append("time_updated AS updated" if "time_updated" in schemas[name] else "time_created AS updated")
                if name == "part":
                    columns.append("message_id AS messageID")
                for alias, location in fields.items():
                    expression = "json_extract(data, '" + location + "')"
                    if alias == "cost":
                        expression = "CASE WHEN json_type(data, '$.cost') IN ('integer', 'real') THEN " + expression + " ELSE NULL END"
                    elif alias in {"messageCreated", "completed", "started"}:
                        expression = "CASE WHEN json_type(data, '" + location + "') = 'integer' THEN " + expression + " ELSE NULL END"
                    columns.append(expression + " AS \"" + alias + "\"")
                for raw in connection.execute("SELECT " + ", ".join(columns) + " FROM " + name + " WHERE " + valid):
                    row = dict(raw)
                    if isinstance(row.get("tokens"), str):
                        try:
                            row["tokens"] = json.loads(row["tokens"])
                        except ValueError:
                            row["tokens"] = None
                    result[name].append(row)
    except (sqlite3.Error, OSError, ValueError):
        diagnostics.append({"code": "source_unreadable", "message": "Could not read SQLite telemetry source."})
    finally:
        if "connection" in locals():
            connection.close()
    return result


def _legacy_rows(root: Path, diagnostics: List[dict]) -> Dict[str, List[dict]]:
    result = {name: [] for name in ("session", "message", "part")}
    for kind in result:
        directory = root / kind
        if not directory.is_dir():
            continue
        for path in sorted(directory.rglob("*.json")):
            try:
                with path.open(encoding="utf-8") as stream:
                    data = json.load(stream)
                if not isinstance(data, dict):
                    raise ValueError("Not an object")
                result[kind].append(_project(kind, data))
            except (OSError, ValueError, UnicodeError):
                diagnostics.append({"code": "malformed_json", "message": "Legacy metadata file was unreadable or invalid.", "kind": kind})
    return result


def _source_locations(source: Path) -> Iterable[Tuple[str, Path]]:
    if source.is_file():
        yield "sqlite", source
        return
    if not source.is_dir():
        return
    database = source / "opencode.db"
    if database.is_file():
        yield "sqlite", database
    legacy = source / "storage" if (source / "storage").is_dir() else source
    if any((legacy / name).is_dir() for name in ("session", "message", "part")):
        yield "legacy", legacy


def protect_output(output: Optional[Path], sources: Iterable[Path], budget_config: Optional[Path] = None, model_catalog: Optional[Path] = None) -> None:
    if output is None:
        return
    resolved = output.expanduser().resolve()
    protected_files = []
    protected_directories = []
    if budget_config is not None:
        protected_files.append(budget_config.expanduser().resolve())
    if model_catalog is not None:
        protected_files.append(model_catalog.expanduser().resolve())
    for source in sources:
        source = Path(source).expanduser()
        if resolved == source.resolve():
            raise ValueError("Output must not replace an OpenCode source or its input configuration.")
        for kind, path in _source_locations(source):
            if kind == "legacy":
                protected_directories.append(path.resolve())
                protected_files.extend(path.rglob("*.json"))
            else:
                for database in (path, path.resolve()):
                    protected_files.extend((database, Path(str(database) + "-wal"), Path(str(database) + "-shm")))
    for directory in protected_directories:
        try:
            resolved.relative_to(directory)
        except ValueError:
            continue
        raise ValueError("Output must not be written inside OpenCode legacy storage.")
    for path in protected_files:
        if resolved == path.resolve():
            raise ValueError("Output must not replace OpenCode storage or its input configuration.")
        try:
            if output.exists() and path.exists() and output.samefile(path):
                raise ValueError("Output must not replace an alias of OpenCode storage or its input configuration.")
        except OSError:
            continue


def read_snapshot(sources: Iterable[Path]) -> Snapshot:
    snapshot = Snapshot()
    rows: Dict[str, Dict[str, Tuple[Tuple[int, int], dict]]] = {name: {} for name in ("session", "message", "part")}
    locations = []
    seen = set()
    for source in sources:
        found = list(_source_locations(Path(source).expanduser()))
        if not found:
            snapshot.diagnostics.append({"code": "source_missing", "message": "Source contains no supported OpenCode telemetry storage."})
        for kind, path in found:
            identity = (kind, str(path.resolve()))
            if identity not in seen:
                locations.append((kind, path))
                seen.add(identity)
    for kind, path in locations:
        imported = _sqlite_rows(path, snapshot.diagnostics) if kind == "sqlite" else _legacy_rows(path, snapshot.diagnostics)
        for table, records in imported.items():
            for row in records:
                identity = _text(row.get("id"))
                if identity is None:
                    snapshot.diagnostics.append({"code": "invalid_metadata", "message": "Telemetry row has no valid ID.", "kind": table})
                    continue
                rank = (1 if kind == "sqlite" else 0, _integer(row.get("updated")) or _integer(row.get("created")) or 0)
                prior = rows[table].get(identity)
                if prior is None or rank > prior[0]:
                    rows[table][identity] = (rank, row)
    snapshot.source_kinds = tuple(sorted({kind for kind, _ in locations}))
    snapshot.source_count = len(locations)
    for identity, (_, row) in rows["session"].items():
        snapshot.sessions[identity] = Session(identity, _text(row.get("parentID")), _integer(row.get("created")), _integer(row.get("updated")))
    messages = {}
    for identity, (_, row) in rows["message"].items():
        if row.get("role") != "assistant":
            continue
        session_id = _text(row.get("sessionID"))
        if session_id is None:
            snapshot.diagnostics.append({"code": "invalid_metadata", "message": "Assistant message has no session ID."})
            continue
        messages[identity] = Message(identity, session_id, _model(row), _integer(row.get("messageCreated")) if row.get("messageCreated") is not None else _integer(row.get("created")),
                                     _integer(row.get("completed")), _usage(row.get("tokens")), _cost(row.get("cost")))
    snapshot.messages = list(messages.values())
    for session_id in {message.session_id for message in messages.values()}:
        if session_id not in snapshot.sessions:
            snapshot.sessions[session_id] = Session(session_id, None, None, None)
            snapshot.diagnostics.append({"code": "missing_session", "message": "Assistant message refers to a missing session.", "sessionID": session_id})
    inheritance_unknown = set()

    def inherited(message: Message) -> bool:
        session = snapshot.sessions[message.session_id]
        if session.created_ms is None or message.created_ms is None:
            if session.id not in inheritance_unknown:
                inheritance_unknown.add(session.id)
                snapshot.diagnostics.append({"code": "inheritance_unknown", "message": "Missing creation time prevents reliable fork inheritance accounting.", "sessionID": session.id})
            return False
        return message.created_ms < session.created_ms

    finished = set()
    tools: Dict[Tuple[str, str, str], Tuple[int, ToolCall]] = {}
    for identity, (_, row) in rows["part"].items():
        message_id = _text(row.get("messageID"))
        message = messages.get(message_id)
        part_type = row.get("type")
        if part_type not in ("step-finish", "tool"):
            continue
        if message is None:
            session_id = _text(row.get("sessionID"))
            if message_id is None or session_id is None:
                snapshot.diagnostics.append({"code": "orphan_part", "message": "Telemetry part cannot be attributed because message or session ID is missing.", "partID": identity})
                continue
            snapshot.sessions.setdefault(session_id, Session(session_id, None, None, None))
            message = Message(message_id, session_id, UNKNOWN_MODEL, None, None, None, None)
            messages[message_id] = message
            snapshot.messages.append(message)
            snapshot.diagnostics.append({"code": "orphan_part", "message": "Telemetry part retained under unknown model because its assistant message is missing.", "partID": identity})
        if part_type == "step-finish":
            finished.add(message.id)
            step_time = _integer(row.get("created"))
            if step_time is None:
                step_time = message.completed_ms if message.completed_ms is not None else message.created_ms
            snapshot.steps.append(UsageStep(identity, message.id, message.session_id, message.model, step_time,
                                            _usage(row.get("tokens")), _cost(row.get("cost")), "step-finish", inherited(message)))
        else:
            status = row.get("status") if row.get("status") in ("pending", "running", "completed", "error") else "unknown"
            tool = ToolCall(identity, message.id, message.session_id, _text(row.get("callID")), message.model,
                            _text(row.get("tool")) or "unknown", status, _integer(row.get("created")) if row.get("created") is not None else _integer(row.get("started")),
                            _integer(row.get("started")), _integer(row.get("completed")), inherited(message))
            key = (message.session_id, message.id, tool.call_id or identity)
            update = _integer(row.get("updated")) or _integer(row.get("created")) or 0
            prior = tools.get(key)
            if prior is None or update > prior[0]:
                tools[key] = (update, tool)
    snapshot.tools = [tool for _, tool in tools.values()]
    for message in messages.values():
        if message.id not in finished:
            snapshot.steps.append(UsageStep("message:" + message.id, message.id, message.session_id, message.model,
                                            message.completed_ms or message.created_ms, message.tokens, message.cost,
                                            "assistant-fallback", inherited(message)))
    for step in snapshot.steps:
        if step.tokens is None or step.tokens.total is None:
            snapshot.diagnostics.append({"code": "missing_usage", "message": "Usage is missing or invalid; totals are incomplete.", "stepID": step.id})
        elif step.tokens.reported_total is not None and step.tokens.reported_total != step.tokens.total:
            snapshot.diagnostics.append({"code": "token_discrepancy", "message": "Recorded total differs from normalized component sum.", "stepID": step.id,
                                         "componentTotal": step.tokens.total, "reportedTotal": step.tokens.reported_total})
        if step.model.provider == "unknown" or step.model.model == "unknown":
            snapshot.diagnostics.append({"code": "unknown_model", "message": "Provider or model identity is missing.", "messageID": step.message_id})
    for tool in snapshot.tools:
        if tool.name == "unknown" or tool.status == "unknown":
            snapshot.diagnostics.append({"code": "unknown_tool", "message": "Tool name or outcome is missing or unsupported.", "partID": tool.id})
        if tool.started_ms is not None and tool.completed_ms is not None and tool.completed_ms < tool.started_ms:
            snapshot.diagnostics.append({"code": "invalid_duration", "message": "Tool end precedes start; duration is unavailable.", "partID": tool.id})
    snapshot.complete = not any(item["code"] in {"source_missing", "source_unreadable", "unsupported_schema", "malformed_json", "invalid_metadata"}
                                or item["code"] == "orphan_part" and "cannot be attributed" in item["message"]
                                for item in snapshot.diagnostics)
    return snapshot
