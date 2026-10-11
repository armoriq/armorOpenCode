import contextlib
from email.message import Message
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

from scripts.build_curl_release import current_wheel, load_staged_release, stage_release
from scripts.publish_curl_release import Destination, main, publish


class CloudProtocol:
    def __init__(self):
        self.objects = {}
        self.calls = []
        self.generation = 0
        self.public_failure = None
        self.stable_conflict = False
        self.auth_failure = False
        self.timeout_after_stable = False
        self.bucket_auth_failure = False
        self.project_metadata = {"projectNumber": "123456789"}
        self.bucket_metadata = {"projectNumber": "123456789", "labels": {"armor-opencode-releases": "true"}}

    def put(self, path, payload, content_type="text/x-shellscript", cache_control="no-store"):
        self.generation += 1
        self.objects[path] = (self.generation, payload, content_type, cache_control)

    def run(self, command, **kwargs):
        self.calls.append(command)
        if self.auth_failure:
            return subprocess.CompletedProcess(command, 1, b"", b"HTTPError 403: permission denied")
        if command[1:3] == ["projects", "describe"]:
            return subprocess.CompletedProcess(command, 0, json.dumps(self.project_metadata).encode(), b"")
        if command[2:4] == ["buckets", "describe"]:
            if self.bucket_auth_failure:
                return subprocess.CompletedProcess(command, 1, b"", b"HTTPError 403: permission denied")
            return subprocess.CompletedProcess(command, 0, json.dumps(self.bucket_metadata).encode(), b"")
        uri = next(arg for arg in command if arg.startswith("gs://"))
        path = uri.split("/", 3)[3]
        if command[2:4] == ["objects", "describe"]:
            if path not in self.objects:
                return subprocess.CompletedProcess(command, 1, b"", f"{uri} not found: 404.".encode())
            return subprocess.CompletedProcess(command, 0, json.dumps({"generation": str(self.objects[path][0]), "contentType": self.objects[path][2], "cacheControl": self.objects[path][3]}).encode(), b"")
        if command[2] == "cat":
            return subprocess.CompletedProcess(command, 0, self.objects[path][1], b"")
        if command[2] == "cp":
            expected = int(next(arg.split("=", 1)[1] for arg in command if arg.startswith("--if-generation-match=")))
            if path == "install_armoropencode.sh" and self.stable_conflict:
                self.put(path, b"concurrent publisher")
            actual = self.objects.get(path, (0,))[0]
            if actual != expected:
                return subprocess.CompletedProcess(command, 1, b"", b"HTTPError 412: generation conflict")
            content_type = next(arg.split("=", 1)[1] for arg in command if arg.startswith("--content-type="))
            cache_control = next(arg.split("=", 1)[1] for arg in command if arg.startswith("--cache-control="))
            self.put(path, Path(command[3]).read_bytes(), content_type, cache_control)
            if path == "install_armoropencode.sh" and self.timeout_after_stable:
                raise subprocess.TimeoutExpired(command, 600)
            return subprocess.CompletedProcess(command, 0, b"", b"")
        raise AssertionError(command)

    def open(self, url, timeout):
        path = url.split("/", 4)[4]
        if path == self.public_failure:
            raise OSError("public download blocked")
        generation, payload, content_type, cache_control = self.objects[path]
        response = io.BytesIO(payload)
        response.status = 200
        response.headers = Message()
        response.headers["Content-Type"] = content_type
        response.headers["Cache-Control"] = cache_control
        return response


class PublishProtocolTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.output = self.root / "release"
        self.destination = Destination("example-release-bucket", "example-project", "publisher@example.com")
        self.release = stage_release(current_wheel(), self.output, self.destination.public_base)
        self.cloud = CloudProtocol()

    def apply(self):
        with mock.patch("subprocess.run", side_effect=self.cloud.run), mock.patch("scripts.publish_curl_release.urlopen", side_effect=self.cloud.open):
            return publish(load_staged_release(self.output), self.destination)

    def test_dry_run_never_contacts_cloud(self):
        with mock.patch("subprocess.run", side_effect=AssertionError("cloud command during dry run")), mock.patch("scripts.publish_curl_release.urlopen", side_effect=AssertionError("HTTP during dry run")), contextlib.redirect_stdout(io.StringIO()) as output:
            main(["--release", str(self.output), "--bucket", self.destination.bucket,
                  "--project", self.destination.project, "--account", self.destination.account])
        self.assertIn("Dry run. No cloud commands", output.getvalue())
        self.assertFalse((self.output / "publication-receipt.json").exists())

    def test_first_publish_and_retry_preserve_immutable_generations(self):
        receipt = self.apply()
        generations = {path: value[0] for path, value in self.cloud.objects.items()}
        again = self.apply()
        self.assertEqual({path: value[0] for path, value in self.cloud.objects.items()}, generations)
        self.assertEqual(again["stable_generation"], receipt["stable_generation"])
        self.assertEqual(len(self.cloud.objects), 4)
        self.assertEqual(receipt["project_number"], "123456789")
        self.assertEqual(receipt["project"], "example-project")
        self.assertEqual(receipt["bucket"], "example-release-bucket")
        upload_calls = [call for call in self.cloud.calls if call[2] == "cp"]
        self.assertTrue(all("--if-generation-match=0" in call for call in upload_calls))
        self.assertEqual(next(arg for arg in upload_calls[-1] if arg.startswith("gs://")), "gs://example-release-bucket/install_armoropencode.sh")
        self.assertIn("--cache-control=no-store", upload_calls[-1])
        for call in self.cloud.calls:
            self.assertIn("--account=publisher@example.com", call)
            self.assertIn("--project=example-project", call)

    def test_same_version_changed_bytes_leave_stable_unchanged(self):
        self.apply()
        stable = self.cloud.objects["install_armoropencode.sh"]
        versioned_script = f"releases/armor-opencode/{self.release.version}/install_armoropencode.sh"
        self.cloud.put(versioned_script, b"changed immutable object", cache_control="public,max-age=31536000,immutable")
        with self.assertRaisesRegex(RuntimeError, "Bump the project version"):
            self.apply()
        self.assertEqual(self.cloud.objects["install_armoropencode.sh"], stable)

    def test_public_asset_failure_prevents_stable_promotion(self):
        self.cloud.put("install_armoropencode.sh", b"previous release")
        before = self.cloud.objects["install_armoropencode.sh"]
        self.cloud.public_failure = f"releases/armor-opencode/{self.release.version}/release.json"
        with self.assertRaisesRegex(OSError, "public download blocked"):
            self.apply()
        self.assertEqual(self.cloud.objects["install_armoropencode.sh"], before)
        self.cloud.public_failure = None
        self.apply()
        self.assertEqual(self.cloud.objects["install_armoropencode.sh"][1], (self.output / "public/install_armoropencode.sh").read_bytes())

    def test_concurrent_stable_writer_is_not_overwritten(self):
        self.cloud.stable_conflict = True
        with self.assertRaisesRegex(RuntimeError, "conflicted"):
            self.apply()
        self.assertEqual(self.cloud.objects["install_armoropencode.sh"][1], b"concurrent publisher")

    def test_permission_failure_is_not_treated_as_missing_object(self):
        self.cloud.auth_failure = True
        with self.assertRaisesRegex(RuntimeError, "Authentication and permission"):
            self.apply()
        self.assertEqual(self.cloud.objects, {})
        self.assertEqual(len(self.cloud.calls), 1)

    def test_wrong_bucket_project_stops_before_object_inspection(self):
        self.cloud.bucket_metadata["projectNumber"] = "987654321"
        with self.assertRaisesRegex(ValueError, "different project"):
            self.apply()
        self.assertEqual(self.cloud.objects, {})
        self.assertEqual(len(self.cloud.calls), 2)
        self.assertEqual(self.cloud.calls[0][1:3], ["projects", "describe"])
        self.assertEqual(self.cloud.calls[1][1:4], ["storage", "buckets", "describe"])

    def test_bucket_without_release_label_stops_before_object_inspection(self):
        self.cloud.bucket_metadata["labels"] = {"unrelated-purpose": "true"}
        with self.assertRaisesRegex(ValueError, "armor-opencode-releases=true"):
            self.apply()
        self.assertEqual(self.cloud.objects, {})
        self.assertEqual(len(self.cloud.calls), 2)

    def test_missing_project_numbers_stop_before_object_inspection(self):
        for metadata in (self.cloud.project_metadata, self.cloud.bucket_metadata):
            original = metadata.pop("projectNumber")
            with self.assertRaisesRegex(ValueError, "projectNumber"):
                self.apply()
            self.assertEqual(self.cloud.objects, {})
            metadata["projectNumber"] = original

    def test_bucket_permission_failure_stops_before_object_inspection(self):
        self.cloud.bucket_auth_failure = True
        with self.assertRaisesRegex(RuntimeError, "Authentication and permission"):
            self.apply()
        self.assertEqual(self.cloud.objects, {})
        self.assertEqual(len(self.cloud.calls), 2)

    def test_failure_after_promotion_reports_changed_stable_state(self):
        self.cloud.public_failure = "install_armoropencode.sh"
        with self.assertRaisesRegex(RuntimeError, "may already be promoted"):
            self.apply()
        self.assertEqual(self.cloud.objects["install_armoropencode.sh"][1], (self.output / "public/install_armoropencode.sh").read_bytes())

    def test_same_stable_bytes_with_cacheable_metadata_are_repromoted(self):
        self.apply()
        stable = self.cloud.objects["install_armoropencode.sh"]
        self.cloud.put("install_armoropencode.sh", stable[1], stable[2], "public,max-age=3600")
        wrong_generation = self.cloud.objects["install_armoropencode.sh"][0]
        self.apply()
        repaired = self.cloud.objects["install_armoropencode.sh"]
        self.assertGreater(repaired[0], wrong_generation)
        self.assertEqual(repaired[3], "no-store")
        stable_upload = [call for call in self.cloud.calls if call[2] == "cp"][-1]
        self.assertIn(f"--if-generation-match={wrong_generation}", stable_upload)

    def test_timeout_after_successful_promotion_reconciles_identical_state(self):
        self.cloud.timeout_after_stable = True
        receipt = self.apply()
        self.assertEqual(receipt["stable_generation"], self.cloud.objects["install_armoropencode.sh"][0])

    def test_immutable_metadata_mismatch_stops_before_stable_write(self):
        self.apply()
        stable = self.cloud.objects["install_armoropencode.sh"]
        path = f"releases/armor-opencode/{self.release.version}/release.json"
        original = self.cloud.objects[path]
        self.cloud.put(path, original[1], "text/html", original[3])
        with self.assertRaisesRegex(RuntimeError, "unexpected metadata"):
            self.apply()
        self.assertEqual(self.cloud.objects["install_armoropencode.sh"], stable)

    def test_tampering_extra_files_and_symlinks_fail_before_cloud(self):
        script = self.output / "public/install_armoropencode.sh"
        original = script.read_bytes()
        script.write_bytes(b"modified")
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            load_staged_release(self.output)
        script.write_bytes(original)
        extra = self.output / "public/credentials.json"
        extra.write_text("private")
        with self.assertRaisesRegex(ValueError, "unexpected"):
            load_staged_release(self.output)
        extra.unlink()
        extra.symlink_to(script)
        with self.assertRaisesRegex(ValueError, "symlink"):
            load_staged_release(self.output)
        self.assertEqual(self.cloud.calls, [])

    def test_validated_payload_survives_local_source_change(self):
        release = load_staged_release(self.output)
        (self.output / "public/install_armoropencode.sh").write_bytes(b"modified after capture")
        with mock.patch("subprocess.run", side_effect=self.cloud.run), mock.patch("scripts.publish_curl_release.urlopen", side_effect=self.cloud.open):
            publish(release, self.destination)
        stable = next(asset for asset in release.assets if asset.path == "install_armoropencode.sh")
        self.assertEqual(self.cloud.objects[stable.path][1], stable.payload)


if __name__ == "__main__":
    unittest.main()
