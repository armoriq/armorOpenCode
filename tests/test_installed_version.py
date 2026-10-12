from email.parser import BytesParser
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest
import zipfile


def current_wheel() -> Path:
    checkout = Path(__file__).resolve().parents[1]
    project = (checkout / "pyproject.toml").read_text().split("[project]", 1)[1].split("\n[", 1)[0]
    match = re.search(r'^version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"\s*$', project, re.MULTILINE)
    if not match:
        raise ValueError("Project must declare a numeric release version")
    return checkout / "dist" / f"armor_opencode-{match.group(1)}-py3-none-any.whl"


class InstalledVersionTests(unittest.TestCase):
    def test_cli_reads_installed_distribution_version_after_version_bump(self):
        uv = shutil.which("uv")
        self.assertIsNotNone(uv, "uv is required for the installed CLI release check")
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            bumped = root / "armor_opencode-9.9.9-py3-none-any.whl"
            original = current_wheel()
            with zipfile.ZipFile(original) as source:
                metadata_name = next(name for name in source.namelist() if name.endswith(".dist-info/METADATA"))
                old_version = BytesParser().parsebytes(source.read(metadata_name))["Version"]
                old_prefix = f"armor_opencode-{old_version}.dist-info"
                with zipfile.ZipFile(bumped, "w") as target:
                    for name in source.namelist():
                        data = source.read(name)
                        new_name = name.replace(old_prefix, "armor_opencode-9.9.9.dist-info")
                        if name == metadata_name:
                            data = data.replace(f"Version: {old_version}\n".encode(), b"Version: 9.9.9\n")
                        elif name.endswith(".dist-info/RECORD"):
                            data = data.replace(old_prefix.encode(), b"armor_opencode-9.9.9.dist-info")
                        target.writestr(new_name, data)
            venv = root / "venv"
            import sys
            subprocess.run([uv, "--no-config", "venv", "--python", sys.executable, "--no-python-downloads", str(venv)], check=True, capture_output=True)
            python = venv / "bin/python"
            subprocess.run([uv, "--no-config", "pip", "install", "--python", str(python), "--no-index", "--no-deps", str(bumped)], check=True, capture_output=True)
            actual = subprocess.run([str(python), "-I", "-m", "armor_opencode", "--version"], cwd=root, check=True, capture_output=True, text=True)
            self.assertEqual(actual.stdout.strip(), "9.9.9")


if __name__ == "__main__":
    unittest.main()
