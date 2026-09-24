# CLAUDE.md

Project-specific instructions for Claude Code when working in this repo.

## Branch workflow

- Always do work on local branches, never commit directly to `main`/`master`.
- Do not delete branches yourself (locally or remotely) once work is merged —
  the user handles branch cleanup (locally or via the distribution/remote).
  Do not bring it up or offer to clean up branches; leave them alone.
- Never use git worktrees (or worktree-isolated agents) for work in this repo
  — work directly on a local branch in the main working directory, checked
  out normally, so the user can see changes in their working tree as they
  happen.

## CMP rule

When the user says **"CMP"**, it means: **C**ommit, **M**erge, **P**ush branch.
On this instruction, do all three in sequence:
1. Commit the current branch's changes (with a proper commit message).
2. Merge the current branch into `main` (or the base branch).
3. Push the resulting branch(es) to the remote.

## BCMP rule

When the user says **"BCMP"**, it means: **B**ranch, **C**ommit, **M**erge, **P**ush.
Use this when there are uncommitted changes and no feature branch has been
created yet. On this instruction, do all four in sequence:
1. Create and switch to a new local branch for the change (e.g. `feature/what-this-does`).
2. Stage and commit the changes (with a proper commit message).
3. Merge that branch into `main` (or the base branch).
4. Push the resulting branch(es) to the remote.
