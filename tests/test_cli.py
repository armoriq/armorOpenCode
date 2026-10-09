import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
SECRET = "private-prompt-argument-result-reasoning-project-title-sentinel"


def usage(input=10, output=2, reasoning=3, read=4, write=5, total=None):
    result = {"input": input, "output": output, "reasoning": reasoning, "cache": {"read": read, "write": write}}
    if total is not None:
        result["total"] = total
    return result


class TelemetryCLI(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db = self.root / "opencode.db"
        connection = sqlite3.connect(self.db)
        connection.executescript("""
            CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);
            CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
            CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
        """)
        connection.close()

    def tearDown(self):
        self.temp.cleanup()

    def sql(self, statement, values=()):
        with sqlite3.connect(self.db) as connection:
            connection.execute(statement, values)

    def session(self, identity="s1", created=1000, parent=None):
        self.sql("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)", (identity, parent, SECRET, "/actual/project", created, created))

    def message(self, identity="m1", session="s1", created=2000, tokens=None, model="big-pickle", provider="opencode", **extra):
        data = {"id": identity, "sessionID": session, "role": "assistant", "providerID": provider,
                "modelID": model, "time": {"created": created, "completed": created + 100 if created is not None else None},
                "tokens": tokens if tokens is not None else usage(), "cost": 0,
                "content": SECRET, "reasoning": SECRET, "title": SECRET, **extra}
        self.sql("INSERT INTO message VALUES (?, ?, ?, ?, ?)", (identity, session, created, created, json.dumps(data)))

    def part(self, identity, kind="tool", message="m1", session="s1", created=2100, **extra):
        data = {"id": identity, "messageID": message, "sessionID": session, "type": kind,
                "tool": "bash", "callID": identity, "state": {"status": "completed", "time": {"start": created, "end": created + 50}, "input": SECRET, "output": SECRET},
                "text": SECRET, **extra}
        self.sql("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)", (identity, message, session, created, created, json.dumps(data)))

    def run_cli(self, *arguments, expected=0, environment=None):
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        if environment:
            env.update(environment)
        result = subprocess.run([sys.executable, "-m", "armor_opencode", *arguments], cwd=REPO,
                                env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(result.returncode, expected, result.stderr)
        return result

    def report(self, *arguments, expected=0, sources=None):
        source_args = []
        for source in sources or [self.db]:
            source_args.extend(("--source", str(source)))
        return json.loads(self.run_cli("report", *source_args, "--timezone", "UTC", "--format", "json", *arguments, expected=expected).stdout)

    def test_report_preserves_actual_repository_directory(self):
        self.session()
        self.message()
        self.assertEqual(self.report()["sessions"][0]["repo"], "/actual/project")
        self.sql("UPDATE session SET directory = NULL")
        self.assertNotIn("repo", self.report()["sessions"][0])

    def test_report_supports_session_schema_without_repository_directory(self):
        self.sql("DROP TABLE session")
        self.sql("CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, time_created INTEGER, time_updated INTEGER)")
        self.sql("INSERT INTO session VALUES ('s1', NULL, 1000, 1000)")
        self.message()
        report = self.report()
        self.assertTrue(report["metadata"]["scanComplete"])
        self.assertEqual(report["overview"]["tokens"], 24)
        self.assertNotIn("repo", report["sessions"][0])

    def test_multistep_uses_finish_parts_without_last_message_double_count(self):
        self.session()
        self.message(tokens=usage(1000, 1000))
        self.part("finish1", "step-finish", tokens=usage(total=24), cost=.1)
        self.part("finish2", "step-finish", created=2200, tokens=usage(20, 4, 6, 8, 10, total=48), cost=.2)
        self.part("tool1")
        report = self.report()
        self.assertEqual(report["overview"]["tokens"], 72)
        self.assertEqual(report["overview"]["breakdown"], {"input": 30, "output": 6, "reasoning": 9, "cacheRead": 12, "cacheWrite": 15})
        self.assertEqual(report["overview"]["steps"], 2)
        self.assertEqual(report["overview"]["messages"], 1)
        self.assertEqual(report["overview"]["toolCalls"], 1)
        self.assertEqual(report["overview"]["reportedTokens"], 72)
        self.assertAlmostEqual(report["overview"]["reportedCost"], .3)
        self.assertEqual([step["basis"] for step in report["traces"][0]["steps"]], ["step-finish", "step-finish"])

    def test_repeat_scan_refreshes_streamed_tool_tokens_and_deletions(self):
        self.session()
        self.message(tokens=usage(1, 0, 0, 0, 0))
        self.part("t", state={"status": "running", "time": {"start": 2100}})
        first = self.report()
        self.assertEqual(first["overview"]["tokens"], 1)
        self.assertEqual(first["overview"]["toolOutcomes"]["running"], 1)
        self.assertEqual(first["traces"][0]["tools"][0]["durationMs"], None)
        self.sql("UPDATE message SET data=?, time_updated=3000 WHERE id='m1'", (json.dumps({"role": "assistant", "providerID": "opencode", "modelID": "big-pickle", "time": {"created": 2000}, "tokens": usage(9, 0, 0, 0, 0)}),))
        self.sql("UPDATE part SET data=?, time_updated=3000 WHERE id='t'", (json.dumps({"type": "tool", "tool": "bash", "callID": "t", "state": {"status": "error", "time": {"start": 2100, "end": 2200}, "error": SECRET}}),))
        second = self.report()
        self.assertEqual(second["overview"]["tokens"], 9)
        self.assertEqual(second["overview"]["toolCalls"], 1)
        self.assertEqual(second["overview"]["toolOutcomes"]["running"], 0)
        self.assertEqual(second["overview"]["toolOutcomes"]["error"], 1)
        self.assertEqual(second["traces"][0]["tools"][0]["durationMs"], 100)
        self.sql("DELETE FROM part WHERE id='t'")
        self.assertEqual(self.report()["overview"]["toolCalls"], 0)

    def test_fork_clones_excluded_and_inherited_counts_tokens_retained(self):
        self.session()
        self.message(tokens=usage(10, 0, 0, 0, 0))
        self.part("original-tool")
        self.session("fork", created=5000, parent="s1")
        self.message("copy", "fork", created=2000, tokens=usage(10, 0, 0, 0, 0))
        self.part("copied-tool", message="copy", session="fork", created=5100)
        self.message("new", "fork", created=6000, tokens=usage(5, 0, 0, 0, 0))
        self.part("new-tool", message="new", session="fork", created=6100)
        report = self.report()
        self.assertEqual(report["overview"]["tokens"], 15)
        self.assertEqual(report["overview"]["toolCalls"], 2)
        self.assertEqual(report["overview"]["inheritedMessages"], 1)
        self.assertEqual(report["overview"]["inheritedToolCalls"], 1)
        self.assertEqual(report["overview"]["inheritedTokens"], 10)
        fork = next(row for row in report["sessions"] if row["id"] == "fork")
        self.assertEqual(fork["tokens"], 5)
        self.assertEqual(fork["inheritedTokens"], 10)

    def test_component_sum_primary_reported_discrepancy_not_budget_actual(self):
        self.session()
        self.message(tokens=usage(10, 2, 3, 4, 5, total=999))
        report = self.report("--total-budget", "24")
        self.assertEqual(report["overview"]["tokens"], 24)
        self.assertEqual(report["overview"]["reportedTokens"], 999)
        self.assertEqual(report["overview"]["budget"]["status"], "within")
        self.assertEqual(report["diagnostics"][0]["code"], "token_discrepancy")

    def test_budget_zero_over_target_and_overrides(self):
        self.session()
        self.message(tokens=usage(1, 0, 0, 0, 0))
        report = self.report("--session-budget", "0", "--total-budget", "0")
        self.assertEqual(report["overview"]["budget"], {"actual": 1, "limit": 0, "remaining": -1, "status": "exceeded"})
        self.assertEqual(report["sessions"][0]["budget"]["status"], "exceeded")
        config = self.root / "budgets.json"
        config.write_text(json.dumps({"sessionBudget": 1, "totalBudget": 5, "sessions": {"s1": 10}}))
        configured = self.report("--budget-config", str(config), "--total-budget", "2")
        self.assertEqual(configured["overview"]["budget"]["limit"], 2)
        self.assertEqual(configured["sessions"][0]["budget"]["limit"], 10)

    def test_valid_empty_database_has_known_zero_usage(self):
        report = self.report("--total-budget", "0")
        self.assertEqual(report["overview"]["tokens"], 0)
        self.assertEqual(report["overview"]["budget"]["status"], "within")
        self.assertTrue(report["metadata"]["scanComplete"])
        self.assertEqual(report["sessions"], [])

    def test_unknown_usage_does_not_turn_into_zero(self):
        self.session()
        self.message(tokens={"input": 8})
        report = self.report("--total-budget", "100")
        self.assertIsNone(report["overview"]["tokens"])
        self.assertEqual(report["overview"]["knownTokens"], 0)
        self.assertEqual(report["overview"]["breakdown"]["input"], 8)
        self.assertEqual(report["overview"]["budget"]["status"], "incomplete")
        self.assertIn("missing_usage", [row["code"] for row in report["diagnostics"]])

    def test_invalid_recorded_cost_preserves_usage_with_unknown_cost(self):
        self.session()
        for index, invalid in enumerate((10 ** 400, -1, True, "1")):
            self.message("cost" + str(index), cost=invalid)
        report = self.report()
        self.assertEqual(report["overview"]["tokens"], 96)
        self.assertIsNone(report["overview"]["reportedCost"])
        self.assertEqual(report["overview"]["knownReportedCost"], 0)

    def test_boolean_timestamp_cannot_create_inherited_fork_usage(self):
        self.session()
        self.message(time={"created": True, "completed": False})
        self.part("bad-time", state={"status": "completed", "time": {"start": True, "end": False}})
        report = self.report("--total-budget", "0")
        self.assertEqual(report["overview"]["tokens"], 24)
        self.assertEqual(report["overview"]["inheritedTokens"], 0)
        self.assertEqual(report["overview"]["toolCalls"], 1)
        self.assertEqual(report["overview"]["budget"]["status"], "exceeded")
        self.assertIsNone(report["traces"][0]["tools"][0]["durationMs"])

    def test_malformed_and_partial_source_scans_preserve_known_but_unknown_total(self):
        self.session()
        self.message()
        self.sql("INSERT INTO message VALUES ('bad','s1',3000,3000,'{invalid')")
        report = self.report("--total-budget", "100")
        self.assertFalse(report["metadata"]["scanComplete"])
        self.assertIsNone(report["overview"]["tokens"])
        self.assertEqual(report["overview"]["knownTokens"], 24)
        self.assertEqual(report["overview"]["budget"]["status"], "incomplete")
        self.sql("DELETE FROM message WHERE id='bad'")
        missing = self.root / "absent"
        report = self.report("--total-budget", "100", sources=[self.db, missing], expected=1)
        self.assertIsNone(report["overview"]["tokens"])
        self.assertEqual(report["overview"]["knownTokens"], 24)
        self.assertFalse(report["metadata"]["scanComplete"])

    def test_unsupported_sqlite_schema_has_nonzero_exit_and_unknown_usage(self):
        path = self.root / "unsupported.db"
        with sqlite3.connect(path) as connection:
            connection.execute("CREATE TABLE unrelated (data TEXT)")
        report = self.report("--total-budget", "0", sources=[path], expected=1)
        self.assertIsNone(report["overview"]["tokens"])
        self.assertEqual(report["overview"]["budget"]["status"], "incomplete")
        self.assertEqual(report["diagnostics"][0]["code"], "unsupported_schema")

    def test_all_model_ids_preserved_with_families_and_explicit_unknown(self):
        self.session()
        self.message("m1", model="muse-spark-1.3-contributor-free")
        self.message("m2", model="new-unregistered-model", provider="new-provider")
        self.message("m3", model=None, provider=None)
        report = self.report()
        models = {row["id"]: row for row in report["models"]}
        self.assertEqual(models["opencode/muse-spark-1.3-contributor-free"]["family"], "Unclassified")
        self.assertEqual(models["new-provider/new-unregistered-model"]["family"], "Unclassified")
        self.assertEqual(models["unknown/unknown"]["family"], "Unknown")
        self.assertEqual(report["overview"]["tokens"], 72)

    def test_session_model_and_inclusive_date_filters_in_timezone(self):
        self.session()
        self.message("m1", created=1704065400000, tokens=usage(1, 0, 0, 0, 0), model="big-pickle")
        self.message("m2", created=1704153600000, tokens=usage(2, 0, 0, 0, 0), model="union-alpha")
        self.session("s2")
        self.message("m3", session="s2", created=1704067200000, tokens=usage(4, 0, 0, 0, 0))
        utc = self.report("--since", "2024-01-01", "--until", "2024-01-01")
        self.assertEqual(utc["overview"]["tokens"], 4)
        india = self.report("--since", "2024-01-01", "--until", "2024-01-01", "--timezone", "Asia/Kolkata")
        self.assertEqual(india["overview"]["tokens"], 5)
        filtered = self.report("--session", "s1", "--model", "opencode/union-alpha")
        self.assertEqual(filtered["overview"]["tokens"], 2)
        self.assertEqual(len(filtered["models"]), 1)
        self.assertEqual(len(filtered["sessions"]), 1)

    def legacy(self, root, kind, identity, data, parent="group"):
        path = root / "storage" / kind / parent / (identity + ".json")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"id": identity, **data}), encoding="utf-8")

    def test_legacy_finish_timestamp_fallback_and_sensitive_content_excluded(self):
        root = self.root / "legacy"
        self.legacy(root, "session", "s1", {"time": {"created": 1000}, "title": SECRET, "directory": "/actual/legacy-project"})
        self.legacy(root, "message", "m1", {"sessionID": "s1", "role": "assistant", "providerID": "opencode", "modelID": "big-pickle", "time": {"created": 1704067200000, "completed": 1704067300000}, "tokens": usage(500), "content": SECRET})
        self.legacy(root, "part", "finish", {"messageID": "m1", "sessionID": "s1", "type": "step-finish", "tokens": usage(), "cost": 0})
        self.legacy(root, "part", "tool", {"messageID": "m1", "sessionID": "s1", "type": "tool", "tool": "read", "callID": "call", "state": {"status": "completed", "input": SECRET, "output": SECRET, "time": {"start": 1704067200000, "end": 1704067200010}}})
        report = self.report("--since", "2024-01-01", "--until", "2024-01-01", sources=[root])
        self.assertEqual(report["overview"]["tokens"], 24)
        self.assertEqual(report["overview"]["toolCalls"], 1)
        self.assertEqual(report["days"][0]["date"], "2024-01-01")
        self.assertEqual(report["sessions"][0]["repo"], "/actual/legacy-project")
        self.assertNotIn(SECRET, json.dumps(report))

    def test_multiple_roots_dedupe_newest_and_prefer_sqlite_over_migrated_legacy(self):
        self.session()
        self.message(tokens=usage(1, 0, 0, 0, 0))
        first, second = self.root / "legacy-a", self.root / "legacy-b"
        for root, updated, tokens in ((first, 2000, 2), (second, 3000, 3)):
            self.legacy(root, "session", "s1", {"time": {"created": 1000, "updated": updated}})
            self.legacy(root, "message", "m1", {"sessionID": "s1", "role": "assistant", "providerID": "opencode", "modelID": "big-pickle", "time": {"created": 1500, "updated": updated}, "tokens": usage(tokens, 0, 0, 0, 0)})
        legacy = self.report(sources=[first, second, first])
        self.assertEqual(legacy["overview"]["tokens"], 3)
        self.assertEqual(legacy["metadata"]["sourceCount"], 2)
        combined = self.report(sources=[first, self.db, second])
        self.assertEqual(combined["overview"]["tokens"], 1)
        self.assertEqual(combined["overview"]["messages"], 1)

    def test_duplicate_call_identity_counted_once_and_current_outcome_kept(self):
        self.session()
        self.message()
        self.part("p1", callID="same", state={"status": "running"})
        self.part("p2", created=3000, callID="same", state={"status": "completed"})
        report = self.report()
        self.assertEqual(report["overview"]["toolCalls"], 1)
        self.assertEqual(report["overview"]["toolOutcomes"]["completed"], 1)

    def test_orphan_unknown_tool_retained_without_fake_token_attribution(self):
        self.part("orphan", message="absent", session="missing", tool=None, state={"status": "unexpected", "time": {"start": 100, "end": 50}})
        report = self.report("--total-budget", "100")
        self.assertEqual(report["overview"]["toolCalls"], 1)
        self.assertEqual(report["overview"]["toolOutcomes"]["unknown"], 1)
        self.assertIsNone(report["overview"]["tokens"])
        self.assertEqual(report["models"][0]["id"], "unknown/unknown")
        tool = report["traces"][0]["tools"][0]
        self.assertIsNone(tool["tokens"])
        self.assertIsNone(tool["durationMs"])
        self.assertEqual(tool["tokenAttribution"], "unavailable")

    def test_json_privacy_preserves_untrusted_ids_without_content(self):
        malicious = '</script><img src=x onerror="globalThis.pwned=true">&\u2028'
        self.session(malicious)
        self.message(session=malicious, model=malicious)
        self.part("t", session=malicious, tool=malicious)
        report = self.report()
        serialized = json.dumps(report)
        self.assertNotIn(SECRET, serialized)
        self.assertNotIn(str(self.root), serialized)
        self.assertEqual(report["sessions"][0]["id"], malicious)
        self.assertEqual(report["models"][0]["modelID"], malicious)
        self.run_cli("report", "--source", str(self.db), "--format", "html", expected=2)

    def test_cli_trace_output_file_env_source_default_and_invalid_arguments(self):
        self.session()
        self.message()
        self.part("t")
        trace = self.run_cli("trace", "--session", "s1", "--source", str(self.db)).stdout
        self.assertIn("Usage steps", trace)
        self.assertIn("bash", trace)
        self.assertNotIn(SECRET, trace)
        output = self.root / "nested" / "report.json"
        self.run_cli("--format", "json", "--output", str(output), environment={"OPENCODE_DATA_DIR": str(self.root)})
        self.assertEqual(json.loads(output.read_text())["overview"]["toolCalls"], 1)
        for args in (("--session-budget", "-1"), ("--since", "invalid"), ("--since", "2024-01-02", "--until", "2024-01-01"), ("--timezone", "Not/AZone"), ("--model", "not-provider-model")):
            self.run_cli("report", *args, expected=2)

    def test_unknown_dates_excluded_with_diagnostic(self):
        self.session(created=None)
        self.message(created=None, time={})
        self.sql("UPDATE message SET time_created=NULL WHERE id='m1'")
        report = self.report("--since", "2024-01-01")
        self.assertEqual(report["overview"]["tokens"], 0)
        self.assertIn("unknown_date_excluded", [item["code"] for item in report["diagnostics"]])

    def test_output_cannot_overwrite_sqlite_sources_companions_or_aliases(self):
        self.session()
        self.message()
        original = self.db.read_bytes()
        symlink = self.root / "symlink-output.json"
        symlink.symlink_to(self.db)
        hardlink = self.root / "hardlink-output.json"
        os.link(self.db, hardlink)
        for source in (self.db, self.root, symlink):
            for output in (self.db, Path(str(self.db) + "-wal"), Path(str(self.db) + "-shm"), symlink, hardlink):
                result = self.run_cli("report", "--source", str(source), "--format", "json", "--output", str(output), expected=2)
                self.assertIn("Output must not", result.stderr)
                self.assertEqual(self.db.read_bytes(), original)
        valid = self.root / "safe-output.json"
        self.run_cli("report", "--source", str(self.db), "--format", "json", "--output", str(valid))
        self.assertEqual(json.loads(valid.read_text())["overview"]["tokens"], 24)
        self.assertEqual(self.db.read_bytes(), original)

    def test_output_cannot_overwrite_legacy_storage_or_budget_config(self):
        root = self.root / "legacy"
        self.legacy(root, "session", "s1", {"time": {"created": 1000}})
        protected = root / "storage" / "session" / "group" / "s1.json"
        original = protected.read_bytes()
        alias = self.root / "legacy-hardlink.json"
        os.link(protected, alias)
        for output in (protected, root / "storage" / "new-report.html", alias):
            self.run_cli("report", "--source", str(root), "--output", str(output), expected=2)
            self.assertEqual(protected.read_bytes(), original)
        config = self.root / "budget.json"
        config.write_text('{"totalBudget":100}')
        config_alias = self.root / "budget-alias.json"
        config_alias.symlink_to(config)
        for output in (config, config_alias):
            self.run_cli("report", "--source", str(self.db), "--budget-config", str(config), "--output", str(output), expected=2)
            self.assertEqual(config.read_text(), '{"totalBudget":100}')

    def test_live_wal_reads_current_committed_metadata_without_source_changes(self):
        with sqlite3.connect(self.db) as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("INSERT INTO session VALUES ('s1',NULL,?,?,1000,1000)", (SECRET, SECRET))
            connection.execute("INSERT INTO message VALUES ('m1','s1',2000,2000,?)", (json.dumps({"role": "assistant", "providerID": "opencode", "modelID": "big-pickle", "time": {"created": 2000}, "tokens": usage()}),))
            connection.commit()
            before = {path.name: path.read_bytes() for path in self.root.iterdir() if path.name != "opencode.db-shm"}
            report = self.report()
            after = {path.name: path.read_bytes() for path in self.root.iterdir() if path.name != "opencode.db-shm"}
            self.assertEqual(report["overview"]["tokens"], 24)
            self.assertEqual(before, after)

    def test_tool_outcomes_all_retained_and_bad_cache_is_incomplete(self):
        self.session()
        self.message(tokens={"input": 10, "output": 3, "cache": "invalid"})
        for index, state in enumerate(("pending", "running", "completed", "error", "unknown-state")):
            self.part("t" + str(index), state={"status": state})
        report = self.report("--total-budget", "100")
        self.assertEqual(report["overview"]["toolCalls"], 5)
        self.assertEqual(report["overview"]["toolOutcomes"], {"pending": 1, "running": 1, "completed": 1, "error": 1, "unknown": 1})
        self.assertIsNone(report["overview"]["tokens"])
        self.assertEqual(report["overview"]["budget"]["status"], "incomplete")


if __name__ == "__main__":
    unittest.main()
