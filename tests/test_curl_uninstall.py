import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from scripts.build_curl_release import current_wheel, stage_release


class CurlUninstallTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.base = Path(self.scratch.name)
        self.bundle = self.base / "bundle"
        stage_release(current_wheel(), self.bundle)
        self.script = self.bundle / "public/install_armoropencode.sh"
        self.root = self.base / "install"
        self.bin = self.base / "bin"
        self.launcher = self.bin / "armor-opencode"
        self.owner = "armoriq:armor-opencode:installer-v1"

    def uninstall(self):
        return subprocess.run(["/bin/bash", str(self.script), "--uninstall", "--install-dir", str(self.root),
                               "--bin-dir", str(self.bin), "--no-modify-path"],
                              env={**os.environ, "PATH": "/usr/bin:/bin"}, capture_output=True, text=True)

    def owned_root(self):
        self.root.mkdir()
        (self.root / ".owner").write_text(self.owner + "\n")
        self.bin.mkdir()

    def test_missing_command_is_idempotent_without_creating_root(self):
        for _ in range(2):
            result = self.uninstall()
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.root.exists())
        self.assertFalse(self.bin.exists())

    def test_removes_only_owned_launcher_and_preserves_all_other_files(self):
        self.owned_root()
        self.launcher.write_text(f"#!/bin/sh\n# {self.owner}\nexit 0\n")
        preserved = [self.root / "report.json", self.root / "credentials.json", self.root / "opencode.json", self.bin / "unrelated"]
        for path in preserved:
            path.write_text("preserve exact contents")
        (self.root / "releases").mkdir()
        environment = self.root / "releases/ready"
        environment.write_text("preserve old runtime")
        result = self.uninstall()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.launcher.exists())
        self.assertEqual([path.read_text() for path in preserved], ["preserve exact contents"] * len(preserved))
        self.assertEqual(environment.read_text(), "preserve old runtime")
        self.assertFalse((self.root / ".install-lock").exists())
        self.assertFalse((self.bin / ".armor-opencode-install-lock").exists())
        self.assertEqual(self.uninstall().returncode, 0)

    def test_foreign_launcher_is_refused(self):
        self.owned_root()
        self.launcher.write_text("#!/bin/sh\n# unrelated owner\nexit 0\n")
        before = self.launcher.read_bytes()
        result = self.uninstall()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Foreign launcher", result.stderr)
        self.assertEqual(self.launcher.read_bytes(), before)

    def test_held_lock_preserves_launcher(self):
        self.owned_root()
        self.launcher.write_text(f"#!/bin/sh\n# {self.owner}\nexit 0\n")
        (self.root / ".install-lock").mkdir()
        before = self.launcher.read_bytes()
        result = self.uninstall()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Another install holds", result.stderr)
        self.assertEqual(self.launcher.read_bytes(), before)
        self.assertTrue((self.root / ".install-lock").exists())

    def test_known_legacy_symlink_is_removed_without_removing_environment(self):
        self.root.mkdir()
        (self.root / "venv/bin").mkdir(parents=True)
        target = self.root / "venv/bin/armor-opencode"
        target.write_text("legacy environment retained")
        self.bin.mkdir()
        self.launcher.symlink_to(target)
        result = self.uninstall()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.launcher.is_symlink())
        self.assertEqual(target.read_text(), "legacy environment retained")
        self.assertFalse((self.root / ".owner").exists())


if __name__ == "__main__":
    unittest.main()
