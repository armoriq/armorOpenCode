import contextlib
import hashlib
import io
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

from armor_opencode.__main__ import main
from armor_opencode.catalog import MAX_BYTES, SOURCE_URL, load_catalog


REPO = Path(__file__).resolve().parents[1]


class CatalogCLI(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.catalog = self.root / "catalog.json"
        self.db = self.root / "opencode.db"
        with sqlite3.connect(self.db) as connection:
            connection.executescript("""
                CREATE TABLE session (id TEXT, time_created INTEGER, time_updated INTEGER);
                CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
                CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
                INSERT INTO session VALUES ('s1',1000,1000);
            """)
            for index, provider in enumerate(("p1", "p2")):
                data = {"role": "assistant", "providerID": provider, "modelID": "new-model", "time": {"created": 2000},
                        "tokens": {"input": 10, "output": 2, "reasoning": 3, "cache": {"read": 4, "write": 5}}, "cost": .75}
                connection.execute("INSERT INTO message VALUES (?, 's1', 2000, ?)", ("m" + str(index), json.dumps(data)))

    def tearDown(self):
        self.temp.cleanup()

    def raw(self, rates=None, **model):
        return json.dumps({"p1": {"id": "p1", "models": {"new-model": {"id": "new-model", "name": "New model name", "family": "new-family", "cost": rates if rates is not None else {"input": 1, "output": 2, "cache_read": .1, "cache_write": .2}, "limit": {"context": 500000, "output": 20000}, **model}}}}).encode()

    def refresh(self, raw=None, expected=0, output=None, error=None):
        response = MagicMock()
        response.__enter__.return_value = response
        response.read.side_effect = lambda length: (raw or self.raw())[:length]
        response.geturl.return_value = SOURCE_URL
        with patch("armor_opencode.catalog.urllib.request.urlopen", side_effect=error, return_value=response) as fetch:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                args = ["catalog", "refresh", "--output", str(output or self.catalog), "--source", str(self.db)]
                if expected:
                    with self.assertRaises(SystemExit) as raised:
                        main(args)
                    self.assertEqual(raised.exception.code, expected)
                else:
                    self.assertEqual(main(args), 0)
            return fetch

    def report(self, path=None, expected=0, *extra):
        result = subprocess.run([sys.executable, "-m", "armor_opencode", "report", "--source", str(self.db), "--format", "json", "--timezone", "UTC", "--model-catalog", str(path or self.catalog), *extra], cwd=REPO,
                                env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(result.returncode, expected, result.stderr)
        return json.loads(result.stdout) if expected == 0 else result

    def test_public_refresh_atomic_snapshot_and_exact_provider_metadata(self):
        fetch = self.refresh()
        request = fetch.call_args.args[0]
        self.assertEqual(request.full_url, SOURCE_URL)
        self.assertEqual(request.get_header("User-agent"), "armor-opencode/0.1")
        data = json.loads(self.catalog.read_bytes())
        self.assertEqual(data["sha256"], hashlib.sha256(self.raw()).hexdigest())
        self.assertEqual(list(self.root.glob('.model-catalog-*')), [])
        snapshot = load_catalog(self.catalog)
        with self.assertRaises(Exception):
            snapshot.sha256 = "change"
        report = self.report()
        models = {model["id"]: model for model in report["models"]}
        own = models["p1/new-model"]
        self.assertEqual(own["displayName"], "New model name")
        self.assertEqual(own["family"], "new-family")
        self.assertEqual(own["catalog"]["match"], "exact")
        self.assertEqual(own["catalog"]["contextWindow"], 500000)
        self.assertEqual(own["catalog"]["currentRates"]["input"], 1)
        self.assertEqual(own["catalog"]["ratesStatus"], "complete")
        self.assertEqual(models["p2/new-model"]["catalog"]["match"], "missing")
        self.assertEqual(models["p2/new-model"]["displayName"], "new-model")
        self.assertIsNone(models["p2/new-model"]["catalog"]["canonicalModelID"])

    def test_rate_refresh_does_not_reprice_recorded_cost_or_usage(self):
        self.refresh()
        first = self.report()
        self.refresh(self.raw({"input": 999, "output": 123, "cache_read": 7, "cache_write": 8}))
        second = self.report()
        self.assertEqual(first["overview"], second["overview"])
        self.assertEqual(second["overview"]["tokens"], 48)
        self.assertEqual(second["overview"]["reportedCost"], 1.5)
        self.assertEqual(second["models"][0]["catalog"]["currentRates"]["input"], 999)
        self.assertNotEqual(first["metadata"]["modelCatalog"]["sha256"], second["metadata"]["modelCatalog"]["sha256"])

    def test_partial_missing_and_conditional_rates_are_explicit(self):
        self.refresh(self.raw({"input": 0, "output": 0, "cache_read": 0, "tiers": [{"context": 200000, "input": 3}], "reasoning": 4, "input_audio": 5}))
        metadata = self.report()["models"][0]["catalog"]
        self.assertEqual(metadata["ratesStatus"], "partial")
        self.assertIsNone(metadata["currentRates"]["cacheWrite"])
        self.assertEqual(metadata["currentRates"]["input"], 0)
        self.assertTrue(metadata["hasConditionalRates"])
        self.assertEqual(metadata["unsupportedRateFields"], ["input_audio", "reasoning", "tiers"])
        self.assertEqual(metadata["currentRates"]["scope"], "base-components-only")
        self.refresh(self.raw({}, name=None, family=None))
        model = self.report()["models"][0]
        self.assertEqual(model["catalog"]["ratesStatus"], "missing")
        self.assertEqual(model["displayName"], "new-model")
        self.assertEqual(model["family"], "Unclassified")

    def test_invalid_rate_refresh_and_network_failure_preserve_old_file(self):
        self.refresh()
        previous = self.catalog.read_bytes()
        for value in (-1, float('nan'), float('inf'), True, "1"):
            self.refresh(self.raw({"input": value}), expected=2)
            self.assertEqual(self.catalog.read_bytes(), previous)
        self.refresh(expected=2, error=urllib.error.URLError("network failed"))
        self.assertEqual(self.catalog.read_bytes(), previous)

    def test_catalog_validation_fingerprint_bounds_and_timestamp(self):
        self.refresh()
        baseline = json.loads(self.catalog.read_bytes())
        for updates in ({"catalogSchemaVersion": 2}, {"catalogSchemaVersion": True}, {"sourceURL": "https://example.com"}, {"sha256": "invalid"}, {"fetchedAt": "invalid"}, {"fetchedAt": "2026-01-01T00:00:00"}, {"fetchedAt": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()}):
            self.catalog.write_text(json.dumps({**baseline, **updates}))
            self.report(expected=2)
        corrupted = json.loads(json.dumps(baseline))
        corrupted['providers']['p1']['models']['new-model']['cost']['input'] = 300
        self.catalog.write_text(json.dumps(corrupted))
        self.assertIn("fingerprint", self.report(expected=2).stderr)
        self.catalog.write_bytes(b' ' * (MAX_BYTES + 1))
        self.assertIn("size limit", self.report(expected=2).stderr)

    def test_stale_catalog_keeps_usage_and_marks_provenance(self):
        self.refresh()
        data = json.loads(self.catalog.read_bytes())
        data['fetchedAt'] = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat()
        self.catalog.write_text(json.dumps(data))
        report = self.report()
        self.assertEqual(report['metadata']['modelCatalog']['freshness'], 'stale')
        self.assertIn('model_catalog_stale', [item['code'] for item in report['diagnostics']])
        self.assertEqual(report['overview']['tokens'], 48)

    def test_refresh_and_report_reject_source_and_input_collisions(self):
        original = self.db.read_bytes()
        fetch = self.refresh(output=self.db, expected=2)
        fetch.assert_not_called()
        self.assertEqual(self.db.read_bytes(), original)
        self.refresh()
        snapshot = self.catalog.read_bytes()
        alias = self.root / 'catalog-hardlink.json'
        os.link(self.catalog, alias)
        self.report(None, 2, '--output', str(alias))
        self.assertEqual(self.catalog.read_bytes(), snapshot)
        self.report(None, 2, '--output', str(self.catalog))
        self.assertEqual(self.catalog.read_bytes(), snapshot)

    def test_report_without_catalog_never_fetches_or_infers_family(self):
        with patch("armor_opencode.catalog.urllib.request.urlopen") as fetch:
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(main(['report', '--source', str(self.db), '--format', 'json']), 0)
            fetch.assert_not_called()
        report = json.loads(output.getvalue())
        self.assertIsNone(report['metadata']['modelCatalog'])
        self.assertEqual(report['models'][0]['family'], 'Unclassified')
        self.assertEqual(report['models'][0]['catalog']['match'], 'not-configured')

    def test_malformed_catalog_shapes_utf8_and_huge_rates_fail_safely(self):
        self.refresh()
        before = self.catalog.read_bytes()
        for invalid in (False, 0, "", []):
            raw = json.loads(self.raw())
            for field in ('cost', 'limit'):
                changed = json.loads(json.dumps(raw))
                changed['p1']['models']['new-model'][field] = invalid
                self.refresh(json.dumps(changed).encode(), expected=2)
                self.assertEqual(self.catalog.read_bytes(), before)
        self.refresh(self.raw({'input': 10 ** 400}), expected=2)
        self.assertEqual(self.catalog.read_bytes(), before)
        self.refresh(self.raw().decode().encode('utf-16'), expected=2)
        self.assertEqual(self.catalog.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
