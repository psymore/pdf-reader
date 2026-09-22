# CLAUDE.md

Project-specific instructions for Claude Code when working in this repo.

## Branch workflow

- Always do work on local branches, never commit directly to `main`/`master`.
- Do not delete branches yourself (locally or remotely) once work is merged —
  the user handles branch cleanup (locally or via the distribution/remote).
  Do not bring it up or offer to clean up branches; leave them alone.

## CMP rule

When the user says **"CMP"**, it means: **C**ommit, **M**erge, **P**ush branch.
On this instruction, do all three in sequence:
1. Commit the current branch's changes (with a proper commit message).
2. Merge the current branch into `main` (or the base branch).
3. Push the resulting branch(es) to the remote.
