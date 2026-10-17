#!/usr/bin/env python3
"""Bump the version in Cargo.toml. Replaces the old pnpm version bump."""

import argparse
import re
import sys
from pathlib import Path

RELEASE_TYPES = {
    "patch",
    "minor",
    "major",
    "prepatch",
    "preminor",
    "premajor",
    "prerelease",
}


def parse_version(version: str) -> tuple[int, int, int, str | None]:
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?", version)
    if not match:
        raise SystemExit(f"Unsupported Cargo.toml version '{version}'")
    major, minor, patch, pre = match.groups()
    return int(major), int(minor), int(patch), pre


def bump(version: str, release_type: str) -> str:
    major, minor, patch, pre = parse_version(version)
    if release_type == "major":
        return f"{major + 1}.0.0"
    if release_type == "minor":
        return f"{major}.{minor + 1}.0"
    if release_type == "patch":
        return f"{major}.{minor}.{patch + 1}"
    if release_type == "premajor":
        return f"{major + 1}.0.0-rc.0"
    if release_type == "preminor":
        return f"{major}.{minor + 1}.0-rc.0"
    if release_type == "prepatch":
        return f"{major}.{minor}.{patch + 1}-rc.0"
    if release_type == "prerelease":
        if pre is None:
            raise SystemExit("Cannot bump prerelease: current version is not a prerelease")
        if pre.startswith("rc."):
            number = pre.removeprefix("rc.")
            if number.isdigit():
                return f"{major}.{minor}.{patch}-rc.{int(number) + 1}"
        raise SystemExit(f"Cannot bump prerelease suffix '{pre}'")
    raise SystemExit(f"Unsupported release type '{release_type}'")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--release-type", default="patch")
    args = parser.parse_args()
    release_type = args.release_type.strip()
    if release_type not in RELEASE_TYPES:
        raise SystemExit(
            f"Unsupported release type '{release_type}'. Supported types: {', '.join(sorted(RELEASE_TYPES))}"
        )

    path = Path("Cargo.toml")
    text = path.read_text()
    match = re.search(r'(?m)^version = "([^"]+)"', text)
    if not match:
        raise SystemExit("Cargo.toml version is missing")
    current = match.group(1)
    updated = bump(current, release_type)
    path.write_text(text[: match.start(1)] + updated + text[match.end(1) :], encoding="utf-8")

    output = Path(__import__("os").environ["GITHUB_OUTPUT"]) if "GITHUB_OUTPUT" in __import__("os").environ else None
    line = f"bump_type={release_type}\n"
    if output:
        with output.open("a", encoding="utf-8") as handle:
            handle.write(line)
    else:
        print(line, end="")
    print(f"{current} -> {updated}", file=sys.stderr)


if __name__ == "__main__":
    main()
