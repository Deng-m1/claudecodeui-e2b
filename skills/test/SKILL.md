---
name: test
description: Comprehensive regression testing for session bridge systems and browser UI flows that support local and E2B/cloud runtimes, multi-session chat, session creation, resume, session switching, reconnect, permission prompts, history loading, provider launch selection, auth/login, and git workflow validation. Use when Codex needs to plan or execute complete test coverage for session routing bugs, message mixing bugs, reconnect bugs, browser-side hangs, permission scoping bugs, provider launch bugs, or read-only/local-vs-isolated test strategy decisions.
---

# Test

Use this skill to run session-bridge regression safely and completely.

## Workflow

1. Run `scripts/preflight.sh --repo <repo>` first to capture branch, dirty state, listeners, and basic process health without modifying files.
2. Read [references/session-bridge-regression-plan.md](./references/session-bridge-regression-plan.md) for bridge semantics and [references/browser-e2e-regression-plan.md](./references/browser-e2e-regression-plan.md) for browser coverage.
3. Use `python scripts/print_case_matrix.py` to list the full matrix or filter by suite/provider.
4. Treat the current project working tree as read-only unless the user explicitly approves writes in that tree.
5. Run the browser suite with `scripts/run_browser_suite.sh` when UI responsiveness, launcher selection, or provider boot flow needs validation.
6. Run write-path regression only in an isolated clone or E2B sandbox. Use `scripts/prepare_isolated_clone.sh --source <repo>` when a local disposable clone is needed.
7. Use `python scripts/report_template.py` to emit a markdown report skeleton before or after execution.

## Safety Rules

- Do not modify the current repo working tree for regression unless the user explicitly asks for that.
- Treat `new session`, `session switch`, and `resume` as different concepts. Verify each explicitly.
- Test reconnect separately from simple switching. Reconnect must prove writer rebinding, not only history reload.
- Test permission prompts with at least one background session active, because that is where scoping bugs usually surface.
- Prefer browser assertions for UI lag reports. A clean backend script pass does not prove the page is responsive.
- Keep evidence tied to `sessionId`, provider, runtime, and exact case ID.

## Resources

- [references/session-bridge-regression-plan.md](./references/session-bridge-regression-plan.md): Full test document, coverage map, execution order, and expected outcomes.
- [references/browser-e2e-regression-plan.md](./references/browser-e2e-regression-plan.md): Headless browser coverage, env vars, and expected UI assertions.
- `scripts/preflight.sh`: Read-only environment snapshot for the target repo.
- `scripts/run_browser_suite.sh`: Wrapper for Playwright auth, launcher, provider-smoke, and session-flow browser tests.
- `scripts/prepare_isolated_clone.sh`: Create a disposable local clone for write-path regression.
- `scripts/print_case_matrix.py`: Print the complete case list or filtered subsets.
- `scripts/report_template.py`: Generate a markdown test report skeleton from the case matrix.
