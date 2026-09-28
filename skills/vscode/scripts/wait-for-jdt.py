#!/usr/bin/env python3

import argparse
import subprocess
import time
from datetime import datetime
from pathlib import Path


def newest_mtime(root: Path) -> float:
    if not root.exists():
        return 0.0
    return max((path.stat().st_mtime for path in root.rglob("*") if path.is_file()), default=0.0)


def jdt_processes() -> list[str]:
    result = subprocess.run(
        ["ps", "-axo", "pid=,command="],
        capture_output=True,
        text=True,
        check=False,
    )
    return [
        line.strip()
        for line in result.stdout.splitlines()
        if "org.eclipse.equinox.launcher" in line
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description="Wait until JDT workspace metadata stops changing")
    parser.add_argument("--storage", required=True, type=Path, help="Red Hat Java workspace-storage directory")
    parser.add_argument("--expected-java", help="Required Java executable substring")
    parser.add_argument("--interval", type=float, default=2.0)
    parser.add_argument("--stable-checks", type=int, default=3)
    parser.add_argument("--timeout", type=float, default=120.0)
    args = parser.parse_args()

    if args.interval <= 0 or args.stable_checks <= 0 or args.timeout <= 0:
        parser.error("interval, stable-checks, and timeout must be positive")

    deadline = time.monotonic() + args.timeout
    previous = None
    stable = 0

    while time.monotonic() < deadline:
        processes = jdt_processes()
        matching = [line for line in processes if not args.expected_java or args.expected_java in line]
        stamps = (
            newest_mtime(args.storage / "jdt_ws"),
            newest_mtime(args.storage / "ss_ws"),
        )

        if matching and stamps == previous and any(stamps):
            stable += 1
        else:
            stable = 0
        previous = stamps

        if stable >= args.stable_checks:
            print(f"jdt_processes={len(matching)}")
            for process in matching:
                print(process)
            print(
                "jdt_ws_newest="
                + (datetime.fromtimestamp(stamps[0]).isoformat(timespec="seconds") if stamps[0] else "none")
            )
            print(
                "ss_ws_newest="
                + (datetime.fromtimestamp(stamps[1]).isoformat(timespec="seconds") if stamps[1] else "none")
            )
            print(f"stable_checks={stable}")
            return 0

        time.sleep(args.interval)

    print("JDT did not stabilize before timeout", flush=True)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
