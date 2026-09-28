#!/usr/bin/env python3

import argparse
import json
from collections import Counter
from pathlib import Path

IDENTITY_FIELDS = (
    "resource",
    "startLineNumber",
    "startColumn",
    "severity",
    "message",
)
REQUIRED_FIELDS = set(IDENTITY_FIELDS)
SEVERITY_NAMES = {8: "error", 4: "warning", 2: "information", 1: "hint"}


def load_diagnostics(path: Path) -> list[dict]:
    data = json.loads(path.read_text())
    if not isinstance(data, list):
        raise ValueError(f"{path}: root value is not an array")

    for index, item in enumerate(data):
        if not isinstance(item, dict):
            raise ValueError(f"{path}: item {index} is not an object")
        missing = REQUIRED_FIELDS - item.keys()
        if missing:
            raise ValueError(f"{path}: item {index} is missing {sorted(missing)}")
    return data


def identity(item: dict) -> tuple:
    return tuple(item[field] for field in IDENTITY_FIELDS)


def counts(items: list[dict]) -> str:
    severities = Counter(item["severity"] for item in items)
    parts = [f"total={len(items)}"]
    for severity in (8, 4, 2, 1):
        parts.append(f"{SEVERITY_NAMES[severity]}={severities.get(severity, 0)}")
    return " ".join(parts)


def print_item(prefix: str, item: dict) -> None:
    print(
        f'{prefix} {item["resource"]}:{item["startLineNumber"]}:'
        f'{item["startColumn"]} severity={item["severity"]} {item["message"]}'
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare VS Code diagnostics by exact identity")
    parser.add_argument("before", type=Path)
    parser.add_argument("after", type=Path)
    parser.add_argument("--detail-limit", type=int, default=50)
    args = parser.parse_args()

    before = load_diagnostics(args.before)
    after = load_diagnostics(args.after)
    before_by_id = {identity(item): item for item in before}
    after_by_id = {identity(item): item for item in after}

    removed = [before_by_id[key] for key in before_by_id.keys() - after_by_id.keys()]
    added = [after_by_id[key] for key in after_by_id.keys() - before_by_id.keys()]

    print(f"before {counts(before)}")
    print(f"after  {counts(after)}")
    print(f"removed={len(removed)} added={len(added)}")

    if len(removed) + len(added) <= args.detail_limit:
        sort_key = lambda item: (
            item["resource"],
            item["startLineNumber"],
            item["startColumn"],
            item["severity"],
            item["message"],
        )
        for item in sorted(removed, key=sort_key):
            print_item("REMOVED", item)
        for item in sorted(added, key=sort_key):
            print_item("ADDED", item)
    else:
        for label, items in (("removed", removed), ("added", added)):
            by_message = Counter(item["message"] for item in items)
            print(label.upper())
            for message, count in by_message.most_common():
                print(f"{count}x {message}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
