# Contributing

## Setup

```sh
vp install
vp dev
```

The Node version is pinned in `.node-version`; Vite+ installs and uses it.

## Pre-commit hook

`vp install` sets up a pre-commit hook. It runs `vp staged`, which runs `vp check --fix` on staged files, so formatting and lint problems are fixed or reported before each commit.

## Branches and pull requests

- Branch names are `chunk/NN-slug`, for example `chunk/01-scaffold`.
- One pull request per chunk, with a Conventional Commit title such as `feat: ...` or `fix: ...`.

Release and CI sections are added in chunk 02b.
