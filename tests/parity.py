#!/usr/bin/env python3
"""Assert the Python renderer and the extension's JS renderer agree exactly.

Both implement the same nested-table layout — one for the CLI, one for the
browser. This diffs their markup on every recipe in recipes/ so a change to one
without the other fails loudly instead of drifting.

Usage: python3 tests/parity.py
"""

import difflib
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.dont_write_bytecode = True  # don't litter the project with __pycache__
sys.path.insert(0, str(ROOT))

import render_recipe  # noqa: E402

JS_DRIVER = """
import { renderArticle } from "%s";
import { readFileSync } from "node:fs";
const recipe = JSON.parse(readFileSync(process.argv[2], "utf8"));
process.stdout.write(renderArticle(recipe));
"""


def js_render(recipe_path):
    driver = ROOT / "tests" / ".parity-driver.mjs"
    driver.write_text(JS_DRIVER % (ROOT / "extension" / "shared" / "layout.js"))
    try:
        proc = subprocess.run(
            ["node", str(driver), str(recipe_path)],
            capture_output=True,
            text=True,
        )
    finally:
        driver.unlink(missing_ok=True)
    if proc.returncode != 0:
        raise RuntimeError(f"node failed:\n{proc.stderr}")
    return proc.stdout


def main():
    recipes = sorted((ROOT / "recipes").glob("*.json"))
    if not recipes:
        sys.exit("no recipes found to compare")

    failures = 0
    for path in recipes:
        recipe = json.loads(path.read_text())
        # article_html mutates the tree with layout bookkeeping; give each
        # renderer its own copy so neither sees the other's annotations.
        expected = render_recipe.article_html(json.loads(path.read_text()))
        actual = js_render(path)
        if expected == actual:
            print(f"ok   {path.name}  ({len(expected)} bytes identical)")
            continue
        failures += 1
        print(f"FAIL {path.name}")
        diff = difflib.unified_diff(
            expected.splitlines(), actual.splitlines(), "python", "javascript", lineterm=""
        )
        for line in list(diff)[:40]:
            print(f"     {line}")

    if failures:
        sys.exit(f"\n{failures} recipe(s) render differently")
    print(f"\n{len(recipes)} recipe(s) render identically in Python and JS")


if __name__ == "__main__":
    main()
