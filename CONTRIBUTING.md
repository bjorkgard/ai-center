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

- PR titles are checked by CI (`pr-title.yml`) because squash-merge uses the title as the commit message. Allowed types: feat, fix, docs, chore, test, refactor, perf, ci, build, style, revert, with an optional scope and `!`.
- Only maintainers merge to `main`.

## What CI runs and what you run

CI runs `vp check`, `vp test`, `vp build`, the workflow guard (`vp run check:workflows`) and `vp run e2e` (smoke tests in Chromium and Firefox) on every pull request.

`vp run e2e:local` runs on the Mac before a chunk PR: all three engines (Chromium, Firefox, WebKit), then it regenerates the screenshots. Update the README and the screenshots in `docs/img/` for every chunk.

## Releases and versions

`package.json` `version` is the single source of truth. semantic-release runs on every push to `main` (`release.yml`), reads the Conventional Commit messages since the last tag, bumps the version, writes `CHANGELOG.md`, commits `chore(release): X.Y.Z [skip ci]`, tags `vX.Y.Z` and creates the GitHub Release. Nothing is published to npm.

The seed version is `0.1.0`, with the tag `v0.1.0` on `main` (pushed by a maintainer). From there:

| Commit type                                | Release                                                           |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `feat:`                                    | minor (0.1.0 to 0.2.0)                                            |
| `fix:`                                     | patch                                                             |
| `feat!:` or a `BREAKING CHANGE:` footer    | major; this is the only way to reach 1.0.0, so do it deliberately |
| `docs:`, `chore:`, `test:` and other types | no release                                                        |

Dependabot titles follow the same rule: `fix(deps)` releases, `chore(deps)` does not.

Preview the next version and notes before merging:

```sh
GITHUB_TOKEN=$(gh auth token) vp run release:dry
```

`release:dry` needs a `GITHUB_TOKEN` so semantic-release can verify repository access. It prints "no release" when no commit since the last tag warrants one.

## Protecting `main`

A maintainer sets this up, in this order:

1. Push the seed tag `v0.1.0` on the commit that has `package.json` at `0.1.0`.
2. Merge the 02b PR. This is the first `release.yml` run; `main` is still open.
3. Create a repository ruleset on `main` that requires a pull request, requires the CI checks and the PR-title check, and blocks force pushes. Name the exact check names from a PR run (the 02b PR itself). Never require `release.yml` jobs: it runs only on push to `main`.
4. Put the GitHub Actions app on the ruleset bypass list so the `chore(release)` commit can push.
5. Run the ruleset acceptance check: a direct push to `main` from your account is refused, and a `fix:` PR merges with its `chore(release)` push and `vX.Y.Z` tag succeeding.

Fallback if a personal-account repository cannot list the Actions app as a bypass actor: create a deploy key with write access, add it to the bypass list, store the private key as a secret and pass it to `actions/checkout` as `ssh-key`. Also set semantic-release `repositoryUrl` to the SSH URL; otherwise it pushes over HTTPS with `GITHUB_TOKEN` and the ruleset refuses the push.

## Release runbook

1. Bad release: revert the PR and merge the revert as `fix: revert <title>`, which ships a patch. Never delete or move a published tag.
2. Bad binaries (from chunk 14b): `gh release edit vX.Y.Z --prerelease`, add a warning to the notes, then ship the fix.
3. Tag pushed but the GitHub Release is missing: `gh release create vX.Y.Z --notes-file <notes from CHANGELOG>`.
4. Release job red because the push was refused: check the ruleset bypass, then re-run the job.
5. Dependabot PR fails CI: close it, pin the old version with an ignore rule, open an issue.
