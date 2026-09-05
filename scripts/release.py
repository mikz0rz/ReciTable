#!/usr/bin/env python3
"""Start a release: bump the version in the manifest and open a changelog section.

    python3 scripts/release.py patch     # 0.2.0 -> 0.2.1
    python3 scripts/release.py minor     # 0.2.0 -> 0.3.0
    python3 scripts/release.py major     # 0.2.0 -> 1.0.0
    python3 scripts/release.py 1.2.3     # explicit

The manifest version is the single source of truth — the extension page and
Copy diagnostics read it from there. The script edits the two files and prints
the git commands that finish the release; it never touches git itself.

Rules of thumb for the number: a change that breaks the recipe-JSON format or
the renderer's markup is major, a new behaviour is minor, a fix is patch.
"""

import datetime
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "extension" / "manifest.json"
CHANGELOG = ROOT / "CHANGELOG.md"


def current_version() -> str:
    return json.loads(MANIFEST.read_text())["version"]


def bump(version: str, part: str) -> str:
    if re.fullmatch(r"\d+\.\d+\.\d+", part):
        return part
    major, minor, patch = (int(n) for n in version.split("."))
    return {
        "major": f"{major + 1}.0.0",
        "minor": f"{major}.{minor + 1}.0",
        "patch": f"{major}.{minor}.{patch + 1}",
    }.get(part, "")


def main() -> int:
    part = sys.argv[1] if len(sys.argv) == 2 else ""
    if not part:
        return sys.exit(f"usage: {sys.argv[0]} major|minor|patch|X.Y.Z")
    version = current_version()
    new = bump(version, part)
    if not new:
        return sys.exit(f"not a version or a bump level: {part!r}")
    if new == version:
        return sys.exit(f"{version} is already the version.")
    if new.split(".")[0] < version.split(".")[0]:
        return sys.exit(f"{new} does not come after {version}.")

    manifest = json.loads(MANIFEST.read_text())
    manifest["version"] = new
    MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")

    today = datetime.date.today().isoformat()
    log = CHANGELOG.read_text()
    entry = f"## {new} — {today}\n\n- (describe the change)\n\n"
    if "Unreleased" in log:
        log = log.replace("## Unreleased", f"## {new} — {today}", 1)
    else:
        head, sep, rest = log.partition("## ")
        log = head + entry + sep + rest
    CHANGELOG.write_text(log)

    print(f"manifest.json and CHANGELOG.md updated: {version} -> {new}")
    print("Fill in the changelog bullet, then finish the release with:")
    print(f"  git commit -am 'Bump version to {new}'")
    print(f"  git tag v{new}")
    print("  git push --tags origin main")


if __name__ == "__main__":
    main()
