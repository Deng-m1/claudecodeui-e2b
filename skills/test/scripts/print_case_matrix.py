#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from case_matrix import CASES, filter_cases  # noqa: E402


def render_markdown(cases: list[dict]) -> str:
    lines = [
        "| ID | Suite | Env | Destructive | Providers | Title |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for case in cases:
        lines.append(
            f"| {case['id']} | {case['suite']} | {case['env']} | "
            f"{'yes' if case['destructive'] else 'no'} | "
            f"{', '.join(case['providers'])} | {case['title']} |"
        )
    return "\n".join(lines)


def render_plain(cases: list[dict]) -> str:
    lines = []
    for case in cases:
        lines.append(
            f"{case['id']}  [{case['suite']}]  env={case['env']}  "
            f"destructive={'yes' if case['destructive'] else 'no'}"
        )
        lines.append(f"  providers: {', '.join(case['providers'])}")
        lines.append(f"  title: {case['title']}")
        lines.append(f"  summary: {case['summary']}")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Print the session bridge regression case matrix.")
    parser.add_argument("--suite", help="Filter by suite name, e.g. core, permission, e2b")
    parser.add_argument("--provider", help="Filter by provider, e.g. claude, codex, cursor, gemini, e2b")
    parser.add_argument(
        "--format",
        choices=["plain", "markdown"],
        default="plain",
        help="Output format",
    )
    parser.add_argument(
        "--read-only",
        action="store_true",
        help="Exclude destructive isolated-write cases",
    )
    args = parser.parse_args()

    cases = filter_cases(
        suite=args.suite,
        provider=args.provider,
        include_destructive=not args.read_only,
    )

    if not cases:
        print("No cases matched the requested filters.")
        return 1

    if args.format == "markdown":
        print(render_markdown(cases))
    else:
        print(render_plain(cases))

    print(f"\nTotal cases: {len(cases)} of {len(CASES)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
