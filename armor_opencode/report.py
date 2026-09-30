from collections import Counter
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional
from zoneinfo import ZoneInfo

from .model import BudgetPolicy, Filters, ModelKey, Snapshot, ToolCall, UsageStep


def classify_model(key: ModelKey) -> dict:
    name = key.model.lower()
    entries = (("big-pickle", "Big Pickle", "Big Pickle"), ("muse", "Muse", "Muse"),
               ("union-alpha", "Union Alpha", "Union Alpha"), ("gemma", "Gemma", "Gemma"),
               ("claude", "Claude", "Claude"), ("gpt", "GPT", "GPT"), ("gemini", "Gemini", "Gemini"))
    display, family = key.model, "Unclassified"
    for prefix, friendly, group in entries:
        if prefix in name:
            display, family = friendly, group
            break
    if key.model == "unknown":
        display, family = "Unknown model", "Unknown"
    return {"id": key.label, "providerID": key.provider, "modelID": key.model, "displayName": display, "family": family}


def _day(milliseconds: Optional[int], zone: ZoneInfo) -> str:
    if milliseconds is None:
        return "unknown"
    try:
        return datetime.fromtimestamp(milliseconds / 1000, zone).date().isoformat()
    except (ValueError, OverflowError, OSError):
        return "unknown"


def _matches(session: str, model: ModelKey, milliseconds: Optional[int], filters: Filters, zone: ZoneInfo) -> bool:
    if filters.session is not None and session != filters.session:
        return False
    if filters.model is not None and model.label != filters.model:
        return False
    day = _day(milliseconds, zone)
    if filters.since is not None and (day == "unknown" or day < filters.since):
        return False
    if filters.until is not None and (day == "unknown" or day > filters.until):
        return False
    return True


def _budget(actual: Optional[int], limit: Optional[int]) -> dict:
    status = "unconfigured" if limit is None else "incomplete" if actual is None else "exceeded" if actual > limit else "within"
    return {"actual": actual, "limit": limit, "remaining": None if actual is None or limit is None else limit - actual, "status": status}


def _summary(steps: Iterable[UsageStep], tools: Iterable[ToolCall], inherited_messages: int = 0) -> dict:
    all_steps, all_tools = list(steps), list(tools)
    steps = [step for step in all_steps if not step.inherited]
    tools = [tool for tool in all_tools if not tool.inherited]
    missing = sum(step.tokens is None or step.tokens.total is None for step in steps)
    known_tokens = sum(step.tokens.total for step in steps if step.tokens is not None and step.tokens.total is not None)
    breakdown = {"input": 0, "output": 0, "reasoning": 0, "cacheRead": 0, "cacheWrite": 0}
    attrs = {"input": "input", "output": "output", "reasoning": "reasoning", "cacheRead": "cache_read", "cacheWrite": "cache_write"}
    missing_components = dict.fromkeys(attrs, 0)
    for step in steps:
        for label, attr in attrs.items():
            value = getattr(step.tokens, attr) if step.tokens is not None else None
            if value is None:
                missing_components[label] += 1
            else:
                breakdown[label] += value
    outcomes = dict.fromkeys(("pending", "running", "completed", "error", "unknown"), 0)
    outcomes.update(Counter(tool.status for tool in tools))
    costs = [step.cost for step in steps if step.cost is not None]
    reported = [step.tokens.reported_total for step in steps if step.tokens is not None and step.tokens.reported_total is not None]
    inherited_steps = [step for step in all_steps if step.inherited]
    inherited_missing = sum(step.tokens is None or step.tokens.total is None for step in inherited_steps)
    inherited_known = sum(step.tokens.total for step in inherited_steps if step.tokens is not None and step.tokens.total is not None)
    return {
        "tokens": None if missing else known_tokens, "knownTokens": known_tokens,
        "missingUsageSteps": missing, "breakdown": breakdown, "missingComponents": missing_components,
        "reportedTokens": sum(reported) if len(reported) == len(steps) else None,
        "steps": len(steps), "messages": len({step.message_id for step in steps}),
        "toolCalls": len(tools), "toolOutcomes": outcomes,
        "reportedCost": sum(costs) if len(costs) == len(steps) else None,
        "knownReportedCost": sum(costs), "inheritedSteps": len(all_steps) - len(steps),
        "inheritedToolCalls": len(all_tools) - len(tools), "inheritedMessages": inherited_messages,
        "inheritedTokens": None if inherited_missing else inherited_known,
        "inheritedKnownTokens": inherited_known, "inheritedMissingUsageSteps": inherited_missing,
    }


def _step_json(step: UsageStep) -> dict:
    usage = step.tokens
    return {"id": step.id, "messageID": step.message_id, "model": step.model.label, "createdMs": step.created_ms,
            "inherited": step.inherited, "basis": step.basis, "tokens": None if usage is None else usage.total,
            "breakdown": None if usage is None else {"input": usage.input, "output": usage.output, "reasoning": usage.reasoning,
                                                      "cacheRead": usage.cache_read, "cacheWrite": usage.cache_write},
            "reportedTokens": None if usage is None else usage.reported_total, "reportedCost": step.cost}


def _tool_json(tool: ToolCall) -> dict:
    return {"id": tool.id, "messageID": tool.message_id, "callID": tool.call_id, "model": tool.model.label,
            "name": tool.name, "status": tool.status, "createdMs": tool.created_ms, "startedMs": tool.started_ms,
            "completedMs": tool.completed_ms, "durationMs": tool.duration_ms, "inherited": tool.inherited,
            "tokens": None, "tokenAttribution": "unavailable"}


def build_report(snapshot: Snapshot, filters: Filters = Filters(), budgets: BudgetPolicy = BudgetPolicy()) -> dict:
    zone = ZoneInfo(filters.timezone)
    steps = [step for step in snapshot.steps if _matches(step.session_id, step.model, step.created_ms, filters, zone)]
    tools = [tool for tool in snapshot.tools if _matches(tool.session_id, tool.model, tool.started_ms if tool.started_ms is not None else tool.created_ms, filters, zone)]
    session_ids = {step.session_id for step in steps} | {tool.session_id for tool in tools}
    if filters.model is None and filters.since is None and filters.until is None:
        session_ids.update(identity for identity in snapshot.sessions if filters.session is None or identity == filters.session)
    selected_messages = {step.message_id for step in steps} | {tool.message_id for tool in tools}
    inherited_by_session = Counter()
    for message in snapshot.messages:
        if message.id not in selected_messages:
            continue
        session = snapshot.sessions[message.session_id]
        if message.created_ms is not None and session.created_ms is not None and message.created_ms < session.created_ms:
            inherited_by_session[session.id] += 1
    overview = _summary(steps, tools, sum(inherited_by_session.values()))
    if not snapshot.complete:
        overview["tokens"] = None
    overview["sessions"] = len(session_ids)
    overview["budget"] = _budget(overview["tokens"], budgets.total)
    sessions = []
    traces = []
    for session_id in sorted(session_ids):
        session = snapshot.sessions[session_id]
        session_steps = [step for step in steps if step.session_id == session_id]
        session_tools = [tool for tool in tools if tool.session_id == session_id]
        summary = _summary(session_steps, session_tools, inherited_by_session[session_id])
        if not snapshot.complete:
            summary["tokens"] = None
        summary.update(id=session_id, parentID=session.parent_id, createdMs=session.created_ms, updatedMs=session.updated_ms,
                       models=sorted({step.model.label for step in session_steps} | {tool.model.label for tool in session_tools}))
        summary["budget"] = _budget(summary["tokens"], budgets.sessions.get(session_id, budgets.session))
        sessions.append(summary)
        traces.append({"sessionID": session_id,
                       "steps": [_step_json(step) for step in sorted(session_steps, key=lambda step: (step.created_ms or 0, step.id))],
                       "tools": [_tool_json(tool) for tool in sorted(session_tools, key=lambda tool: (tool.started_ms or tool.created_ms or 0, tool.id))]})
    models = []
    keys = {step.model for step in steps} | {tool.model for tool in tools}
    for key in sorted(keys, key=lambda key: key.label):
        summary = _summary([step for step in steps if step.model == key], [tool for tool in tools if tool.model == key])
        if not snapshot.complete:
            summary["tokens"] = None
        summary.update(classify_model(key))
        models.append(summary)
    days = []
    dates = {_day(step.created_ms, zone) for step in steps} | {_day(tool.started_ms if tool.started_ms is not None else tool.created_ms, zone) for tool in tools}
    for day in sorted(dates):
        summary = _summary([step for step in steps if _day(step.created_ms, zone) == day],
                           [tool for tool in tools if _day(tool.started_ms if tool.started_ms is not None else tool.created_ms, zone) == day])
        if not snapshot.complete:
            summary["tokens"] = None
        summary["date"] = day
        days.append(summary)
    tool_summaries = []
    for name in sorted({tool.name for tool in tools}):
        named = [tool for tool in tools if tool.name == name and not tool.inherited]
        outcomes = dict.fromkeys(("pending", "running", "completed", "error", "unknown"), 0)
        outcomes.update(Counter(tool.status for tool in named))
        durations = [tool.duration_ms for tool in named if tool.duration_ms is not None]
        tool_summaries.append({"name": name, "calls": len(named), "outcomes": outcomes,
                               "inheritedCalls": sum(tool.name == name and tool.inherited for tool in tools),
                               "timedCalls": len(durations), "durationMs": sum(durations) if durations else None,
                               "tokens": None, "tokenAttribution": "unavailable"})
    diagnostics = list(snapshot.diagnostics)
    if filters.since is not None or filters.until is not None:
        excluded_steps = sum(_day(step.created_ms, zone) == "unknown" for step in snapshot.steps if (filters.session is None or step.session_id == filters.session) and (filters.model is None or step.model.label == filters.model))
        excluded_tools = sum(_day(tool.started_ms if tool.started_ms is not None else tool.created_ms, zone) == "unknown" for tool in snapshot.tools if (filters.session is None or tool.session_id == filters.session) and (filters.model is None or tool.model.label == filters.model))
        if excluded_steps or excluded_tools:
            diagnostics.append({"code": "unknown_date_excluded", "message": "Date filtering excluded telemetry with no usable timestamp.", "steps": excluded_steps, "tools": excluded_tools})
    return {
        "schemaVersion": 1,
        "metadata": {"generatedAt": datetime.now(timezone.utc).isoformat(), "timezone": filters.timezone,
                     "sourceCount": snapshot.source_count, "sourceKinds": list(snapshot.source_kinds),
                     "scanComplete": snapshot.complete,
                     "accountingBasis": "normalized-disjoint-components", "usagePriority": "step-finish-then-assistant-fallback",
                     "scope": {"session": filters.session, "model": filters.model, "since": filters.since, "until": filters.until},
                     "privacy": "metadata-only", "costBasis": "recorded-cost-no-price-estimation",
                     "notice": "Retained recorded usage, not an invoice total. Fork-inherited history is excluded from new execution totals. Budgets are configured targets, not optimal-token estimates."},
        "overview": overview, "models": models, "sessions": sessions, "days": days,
        "tools": tool_summaries, "traces": traces, "diagnostics": diagnostics,
    }
