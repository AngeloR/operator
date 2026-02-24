# Contributing

Thanks for helping improve `operator`.

This project accepts contributions from both humans and AI agents. This guide defines the shared workflow so changes are safe, reviewable, and easy to merge.

## Workflow

### 1) Start from up-to-date `main`

```bash
git checkout main
git pull --ff-only
```

### 2) Create a branch for every change

Do not commit directly to `main`.

Use an issue-based branch name:

- `issue-<number>-<short-description>`
- Example: `issue-3-contributing-workflows`

```bash
git checkout -b issue-<number>-<short-description>
```

### 3) Make focused commits

- Keep changes scoped to one task or issue.
- Use clear commit messages. Conventional commit format is preferred.

Examples:

- `docs(#3): add contributor workflow and PR checklist`
- `refactor(#8): split runtime process helpers`
- `fix(#12): handle missing sender allowlist`

## Local Development

Install dependencies:

```bash
bun install
```

Run the relay locally:

```bash
bun run src/index.ts
```

Run checks before opening a PR:

```bash
bunx tsc --noEmit
bun test
```

## Pull Request Expectations

Every PR should include:

- A clear description of what changed and why.
- Risk notes (behavioral changes, config impact, or migration concerns).
- Verification notes with exact commands run and results.
- Links to related issues/PRs.

PR titles should use conventional commit style when possible, for example:

- `docs: add contributor workflows`
- `refactor: split index runtime modules`

## AI Contributor Guardrails

If you are contributing with an AI coding agent:

- Follow the same branch-only workflow (never commit to `main`).
- Prefer small, reviewable diffs over large rewrites.
- Preserve existing behavior unless the issue requires behavior changes.
- Do not introduce secrets, credentials, or private tokens into commits.
- Run project checks locally (`bunx tsc --noEmit`, `bun test`) before opening a PR.
- Include a short verification section in the PR body.

## Pre-PR Checklist

- [ ] Branch is not `main`.
- [ ] Changes are scoped to the issue.
- [ ] `bunx tsc --noEmit` passes.
- [ ] `bun test` passes.
- [ ] PR description includes summary, risk, and verification.
- [ ] Related issue/PR links are included.
