#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from case_matrix import filter_cases  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Emit a markdown regression report template.")
    parser.add_argument("--suite", help="Filter by suite name")
    parser.add_argument("--provider", help="Filter by provider")
    parser.add_argument("--read-only", action="store_true", help="Exclude destructive cases")
    args = parser.parse_args()

    cases = filter_cases(
        suite=args.suite,
        provider=args.provider,
        include_destructive=not args.read_only,
    )

    if not cases:
        print("No cases matched the requested filters.", file=sys.stderr)
        return 1

    print("# Session Bridge Regression Report")
    print()
    print("## Summary")
    print()
    print("- Target repo: ")
    print("- Runtime: ")
    print("- Provider focus: ")
    print("- Result: pass/fail/partial")
    print("- Tester notes: ")
    print()
    print("## Environment")
    print()
    print("- Current branch: ")
    print("- Dirty working tree before test: ")
    print("- Dirty working tree after test: ")
    print("- Backend status: ")
    print("- Frontend status: ")
    print()
    print("## Cases")
    print()

    for case in cases:
        print(f"### {case['id']}: {case['title']}")
        print()
        print(f"- Suite: {case['suite']}")
        print(f"- Env: {case['env']}")
        print(f"- Providers: {', '.join(case['providers'])}")
        print(f"- Destructive: {'yes' if case['destructive'] else 'no'}")
        print(f"- Expected: {case['summary']}")
        print("- Result: ")
        print("- Evidence: ")
        print("- Notes: ")
        print()

    print("## Failures")
    print()
    print("- None recorded.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
