import argparse
import json
import os
import sys
from datetime import date
from pathlib import Path
from typing import List, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from . import __version__
from .catalog import load_catalog, refresh_catalog
from .model import BudgetPolicy, Filters
from .render import render_json, render_table, render_trace
from .report import build_report
from .source import default_sources, protect_output, read_snapshot


def local_timezone() -> str:
    candidate = os.environ.get("TZ")
    if not candidate:
        try:
            resolved = str(Path("/etc/localtime").resolve())
            candidate = resolved.split("zoneinfo/", 1)[1] if "zoneinfo/" in resolved else "UTC"
        except OSError:
            candidate = "UTC"
    try:
        return ZoneInfo(candidate).key
    except (ZoneInfoNotFoundError, ValueError):
        return "UTC"


def _tokens(value: str) -> int:
    try:
        number = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("Token targets must be nonnegative integers.")
    if number < 0:
        raise argparse.ArgumentTypeError("Token targets must be nonnegative integers.")
    return number


def _date(value: str) -> str:
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        raise argparse.ArgumentTypeError("Dates must use YYYY-MM-DD.")


def _timezone(value: str) -> str:
    try:
        return ZoneInfo(value).key
    except (ZoneInfoNotFoundError, ValueError):
        raise argparse.ArgumentTypeError("Timezone must be a supported IANA zone, for example Asia/Kolkata or UTC.")


def _budgets(path: Optional[Path], session: Optional[int], total: Optional[int]) -> BudgetPolicy:
    data = {}
    if path is not None:
        with path.open(encoding="utf-8") as stream:
            data = json.load(stream)
        if not isinstance(data, dict) or set(data) - {"sessionBudget", "totalBudget", "sessions"}:
            raise ValueError("Budget config accepts sessionBudget, totalBudget, and sessions only.")
    overrides = data.get("sessions", {})
    if not isinstance(overrides, dict) or any(not isinstance(key, str) or not key for key in overrides):
        raise ValueError("Budget session overrides must map session IDs to nonnegative integers.")
    values = [data.get("sessionBudget"), data.get("totalBudget"), *overrides.values()]
    if any(value is not None and (not isinstance(value, int) or isinstance(value, bool) or value < 0) for value in values):
        raise ValueError("Budget config targets must be nonnegative integers.")
    if any(value is None for value in overrides.values()):
        raise ValueError("Budget session overrides must be nonnegative integers.")
    return BudgetPolicy(session if session is not None else data.get("sessionBudget"),
                        total if total is not None else data.get("totalBudget"), overrides)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only, metadata-only OpenCode usage and tool telemetry.")
    parser.add_argument("--version", action="version", version=__version__)
    commands = parser.add_subparsers(dest="command")
    catalog_command = commands.add_parser("catalog", help="Explicitly refresh optional current model metadata.")
    catalog_commands = catalog_command.add_subparsers(dest="catalog_action", required=True)
    refresh = catalog_commands.add_parser("refresh", help="Fetch models.dev metadata and atomically replace a local snapshot.")
    refresh.add_argument("--output", type=Path, required=True)
    refresh.add_argument("--source", action="append", type=Path, help="Protect additional OpenCode source paths from output collisions.")
    for command in ("report", "trace"):
        child = commands.add_parser(command, help="Summarize retained usage." if command == "report" else "Inspect session step and tool metadata.")
        if command == "trace":
            child.add_argument("session_id", nargs="?", help="Exact session ID, alternatively use --session.")
        child.add_argument("--source", action="append", type=Path, help="OpenCode data directory or SQLite path. Repeat for multiple roots.")
        child.add_argument("--format", choices=("table", "json"), default="table")
        child.add_argument("--output", type=Path)
        child.add_argument("--session", help="Exact session ID.")
        child.add_argument("--model", help="Exact provider/model ID.")
        child.add_argument("--since", type=_date, help="Inclusive local date.")
        child.add_argument("--until", type=_date, help="Inclusive local date.")
        child.add_argument("--timezone", type=_timezone, default=local_timezone())
        child.add_argument("--session-budget", type=_tokens, help="Token target for each selected session.")
        child.add_argument("--total-budget", type=_tokens, help="Token target for the entire selected scope.")
        child.add_argument("--budget-config", type=Path, help="JSON target configuration and session overrides.")
        child.add_argument("--model-catalog", type=Path, help="Optional local current-metadata catalog. Never reprices historical costs.")
    arguments = list(sys.argv[1:] if argv is None else argv)
    if not arguments or arguments[0] not in ("report", "trace", "catalog", "-h", "--help", "--version"):
        arguments.insert(0, "report")
    args = parser.parse_args(arguments)
    if args.command is None:
        parser.print_help()
        return 0
    if args.command == "catalog":
        try:
            protect_output(args.output, [*default_sources(), *(args.source or [])])
            catalog = refresh_catalog(args.output)
            sys.stdout.write(json.dumps(catalog.provenance(), allow_nan=False, indent=2) + "\n")
            return 0
        except (OSError, ValueError) as error:
            parser.exit(2, "armor-opencode: " + (str(error) if isinstance(error, ValueError) else "Unable to write model catalog snapshot.") + "\n")
    if args.since and args.until and args.since > args.until:
        parser.error("--since must not follow --until.")
    if args.model and ("/" not in args.model or any(not value for value in args.model.split("/", 1))):
        parser.error("--model must be an exact provider/model ID.")
    if args.command == "trace" and args.session and args.session_id and args.session != args.session_id:
        parser.error("Trace session ID and --session must agree.")
    if args.command == "trace" and not (args.session_id or args.session):
        parser.error("trace requires a session ID or --session.")
    try:
        sources = args.source or default_sources()
        protect_output(args.output, sources, args.budget_config, args.model_catalog)
        budgets = _budgets(args.budget_config, args.session_budget, args.total_budget)
        catalog = load_catalog(args.model_catalog) if args.model_catalog else None
        session = (args.session_id or args.session) if args.command == "trace" else args.session
        report = build_report(read_snapshot(sources), Filters(session, args.model, args.since, args.until, args.timezone), budgets, catalog)
        if args.format == "json":
            rendered = render_json(report)
        elif args.command == "trace":
            rendered = render_trace(report, session)
        else:
            rendered = render_table(report)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(rendered, encoding="utf-8")
        else:
            sys.stdout.write(rendered)
        fatal = {"source_missing", "source_unreadable", "unsupported_schema"}
        return 1 if any(diagnostic["code"] in fatal for diagnostic in report["diagnostics"]) else 0
    except (OSError, ValueError, UnicodeError) as error:
        parser.exit(2, "armor-opencode: " + (str(error) if isinstance(error, ValueError) else "Unable to read configuration or write output.") + "\n")


if __name__ == "__main__":
    raise SystemExit(main())
