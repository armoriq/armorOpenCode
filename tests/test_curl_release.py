import hashlib
import json
import re
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock
import zipfile

from scripts.build_curl_release import load_staged_release, stage_release


class CurlReleaseTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        checkout = Path(__file__).resolve().parents[1]
        project = (checkout / "pyproject.toml").read_text().split("[project]", 1)[1].split("\n[", 1)[0]
        match = re.search(r'^version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"\s*$', project, re.MULTILINE)
        self.assertIsNotNone(match, "Project must declare a numeric release version")
        self.version = match.group(1)
        self.filename = f"armor_opencode-{self.version}-py3-none-any.whl"
        self.wheel = checkout / "dist" / self.filename
        self.assertTrue(self.wheel.is_file(), f"Build the current wheel with uv build before release checks: {self.wheel}")

    def altered_wheel(self, replacements=None, extra=None):
        path = self.root / self.wheel.name
        with zipfile.ZipFile(self.wheel) as source, zipfile.ZipFile(path, "w") as target:
            for name in source.namelist():
                target.writestr(name, (replacements or {}).get(name, source.read(name)))
            for name, content in (extra or {}).items():
                target.writestr(name, content)
        return path

    def test_stages_only_versioned_release_and_stable_installer(self):
        output = self.root / "bundle"
        release = stage_release(self.wheel, output)
        self.assertEqual(release.version, self.version)
        self.assertEqual(load_staged_release(output), release)
        public_files = {str(p.relative_to(output)) for p in (output / "public").rglob("*") if p.is_file()}
        self.assertEqual(public_files, {
            "public/install_armoropencode.sh",
            f"public/releases/armor-opencode/{self.version}/{self.filename}",
            f"public/releases/armor-opencode/{self.version}/install_armoropencode.sh",
            f"public/releases/armor-opencode/{self.version}/release.json",
        })
        script = output / "public/install_armoropencode.sh"
        self.assertNotIn("@@", script.read_text())
        self.assertIn("WHEEL_SHA256='" + hashlib.sha256(self.wheel.read_bytes()).hexdigest() + "'", script.read_text())
        subprocess.run(["/bin/bash", "-n", str(script)], check=True)
        manifest = json.loads((output / "safety-manifest.json").read_text())
        for filename, digest in manifest["assets"].items():
            self.assertEqual(hashlib.sha256((output / filename).read_bytes()).hexdigest(), digest)

    def test_source_changes_do_not_change_validated_release_bytes(self):
        wheel = self.altered_wheel()
        original = wheel.read_bytes()
        original_read_text = Path.read_text

        def read_template(path, *args, **kwargs):
            text = original_read_text(path, *args, **kwargs)
            if path.name == "install_armoropencode.sh.in":
                wheel.write_bytes(b"replaced after validation")
            return text

        output = self.root / "bundle"
        with mock.patch.object(Path, "read_text", autospec=True, side_effect=read_template):
            release = stage_release(wheel, output)
        staged = output / "public/releases/armor-opencode" / self.version / release.wheel.filename
        self.assertEqual(staged.read_bytes(), original)
        self.assertEqual(release.wheel.sha256, hashlib.sha256(original).hexdigest())
        self.assertIn("WHEEL_SHA256='" + release.wheel.sha256 + "'", (output / "public/install_armoropencode.sh").read_text())

    def test_existing_output_is_preserved(self):
        output = self.root / "existing"
        output.mkdir()
        (output / "keep").write_text("original")
        with self.assertRaises(FileExistsError):
            stage_release(self.wheel, output)
        self.assertEqual(list(output.iterdir()), [output / "keep"])
        self.assertEqual((output / "keep").read_text(), "original")

    def test_data_archive_is_refused_without_output(self):
        wheel = self.altered_wheel(extra={"output/report.json": b'{"private":true}'})
        with self.assertRaisesRegex(ValueError, "unexpected or missing"):
            stage_release(wheel, self.root / "refused")
        self.assertFalse((self.root / "refused").exists())

    def test_wrong_package_metadata_is_refused(self):
        metadata = f"armor_opencode-{self.version}.dist-info/METADATA"
        with zipfile.ZipFile(self.wheel) as archive:
            original = archive.read(metadata)
        wheel = self.altered_wheel(replacements={metadata: original.replace(b"Name: armor-opencode", b"Name: different-package")})
        with self.assertRaisesRegex(ValueError, "do not agree"):
            stage_release(wheel, self.root / "refused")

    def test_archive_comments_are_refused_before_output(self):
        wheel = self.altered_wheel()
        with zipfile.ZipFile(wheel, "a") as archive:
            archive.comment = b"/Users/private-user/history"
        with self.assertRaisesRegex(ValueError, "comments and extra metadata"):
            stage_release(wheel, self.root / "refused")
        self.assertFalse((self.root / "refused").exists())

    def test_entry_comments_and_extra_metadata_are_refused_before_output(self):
        for field, value in (("comment", b"/Users/private-user/history"), ("extra", b"\x01\x00\x04\x00data")):
            with self.subTest(field=field):
                wheel = self.root / self.filename
                with zipfile.ZipFile(self.wheel) as source, zipfile.ZipFile(wheel, "w") as target:
                    for original in source.infolist():
                        entry = zipfile.ZipInfo(original.filename)
                        setattr(entry, field, value)
                        target.writestr(entry, source.read(original.filename))
                with self.assertRaisesRegex(ValueError, "comments and extra metadata"):
                    stage_release(wheel, self.root / "refused")
                self.assertFalse((self.root / "refused").exists())

    def test_private_machine_path_is_refused(self):
        wheel = self.altered_wheel(replacements={"armor_opencode/__init__.py": b"PRIVATE = '/Users/private-user/history'"})
        with self.assertRaisesRegex(ValueError, "private machine data"):
            stage_release(wheel, self.root / "refused")

    def test_additional_nested_python_module_is_accepted(self):
        wheel = self.altered_wheel(extra={"armor_opencode/plugins/example.py": b"ENABLED = True\n"})
        output = self.root / "expanded"
        release = stage_release(wheel, output)
        self.assertEqual(load_staged_release(output).wheel.payload, wheel.read_bytes())
        self.assertEqual(release.version, self.version)

    def test_traversal_duplicate_and_symlink_modules_are_refused(self):
        wheel = self.altered_wheel(extra={"armor_opencode/../secret.py": b"secret"})
        with self.assertRaisesRegex(ValueError, "unsafe path"):
            stage_release(wheel, self.root / "traversal")
        wheel = self.altered_wheel()
        with zipfile.ZipFile(wheel, "a") as archive:
            archive.writestr("armor_opencode/__init__.py", b"duplicate")
        with self.assertRaisesRegex(ValueError, "duplicate"):
            stage_release(wheel, self.root / "duplicate")
        wheel = self.altered_wheel()
        with zipfile.ZipFile(wheel, "a") as archive:
            entry = zipfile.ZipInfo("armor_opencode/linked.py")
            entry.create_system = 3
            entry.external_attr = 0o120777 << 16
            archive.writestr(entry, b"external")
        with self.assertRaisesRegex(ValueError, "symlinks"):
            stage_release(wheel, self.root / "symlink")

    def test_dependencies_require_locked_wheelhouse(self):
        metadata = f"armor_opencode-{self.version}.dist-info/METADATA"
        with zipfile.ZipFile(self.wheel) as archive:
            original = archive.read(metadata)
        wheel = self.altered_wheel(replacements={metadata: original.replace(b"Requires-Python:", b"Requires-Dist: requests\nRequires-Python:")})
        with self.assertRaisesRegex(ValueError, "locked wheelhouse"):
            stage_release(wheel, self.root / "dependencies")

    def test_runtime_template_change_creates_new_release_identity(self):
        first = stage_release(self.wheel, self.root / "first")
        original = Path.read_text
        def changed(path, *args, **kwargs):
            text = original(path, *args, **kwargs)
            return text.replace("PYTHON_VERSION='3.14.6'", "PYTHON_VERSION='3.14.7'") if path.name == "install_armoropencode.sh.in" else text
        with mock.patch.object(Path, "read_text", autospec=True, side_effect=changed):
            second = stage_release(self.wheel, self.root / "second")
        self.assertEqual(first.wheel, second.wheel)
        self.assertNotEqual(first.release_id, second.release_id)
        self.assertIn(second.release_id.encode(), (self.root / "second/public/install_armoropencode.sh").read_bytes())

    def test_invalid_public_base_creates_no_output(self):
        for url in ("http://example.com", "https://user:pass@example.com", "https://example.com/a/../b", "https://example.com?secret=yes"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                stage_release(self.wheel, self.root / "invalid", url)
            self.assertFalse((self.root / "invalid").exists())

    def test_bootstrap_is_outside_public_and_forwards_arguments(self):
        output = self.root / "bootstrap"
        stage_release(self.wheel, output, "https://storage.googleapis.com/example-release-bucket")
        bootstrap = output / "landing/install_armoropencode.sh"
        subprocess.run(["/bin/bash", "-n", str(bootstrap)], check=True)
        self.assertIn('bash "$installer" "$@"', bootstrap.read_text())
        self.assertIn("--proto '=https'", bootstrap.read_text())
        stage_release(self.wheel, self.root / "loopback", "http://127.0.0.1:8769")
        self.assertFalse((self.root / "loopback/landing").exists())


if __name__ == "__main__":
    unittest.main()
