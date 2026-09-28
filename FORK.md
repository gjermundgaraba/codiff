# Fork context

This checkout is `gjermundgaraba/codiff`, a thin personal fork of
`nkzw-tech/codiff`. It adds attached reviews, which connect a Codiff window to
the agent that opened it. Machine-specific paths live in `FORK.local.md`, which
is gitignored and may be absent.

## Remotes and branches

- `origin`: `gjermundgaraba/codiff`
- `upstream`: `nkzw-tech/codiff`
- `main`: an unmodified mirror of upstream `main`
- `custom`: the branch that gets built and run: the latest upstream release tag
  plus a short stack of local commits

List the local changes with:

```sh
git log --oneline "$(git describe --tags --abbrev=0)..custom"
```

GitHub Actions are disabled on `origin`. The inherited workflows build releases
on any tag push and deploy the web app from `main`, and neither may run from the
fork.

## What the fork adds

- **Attached reviews** (`codiff --attach`). In an attached window, Ask sends
  the question to the agent that opened Codiff instead of starting a new agent
  run. A **Send to agent** button next to the copy button sends the same
  Markdown that Copy produces. The agent receives both with
  `codiff review next` and answers questions with `codiff review reply`.
  - Inbox: `electron/attached-review.cjs`, one folder of JSON files per
    repository under `~/.codiff/attached/`. No server; each file has one
    writer.
  - CLI: `bin/review-cli.js`. Agent guide: `bin/attached-review-guide.md`,
    printed by `codiff review guide`.
  - UI: `core/app/components/SendToAgentButton.tsx`.
  - The skills attach desktop walkthroughs by default when the agent's tool
    can run a background command and notify it on exit, and open them
    unattached otherwise.
  - Hooks in upstream files, all small: the Ask handler and the
    `sendAttachedFeedback` IPC in `electron/main.cjs`, `--attach` in
    `bin/arguments.js`, `bin/codiff.js`, `bin/codiff-app`, and
    `electron/main/command-line.cjs`, one launch option in `core/types.ts`, the
    preload bridge, the button in `core/App.tsx`, and an "attached mode" line
    plus a `--review` passthrough in each agent skill (`*/skills/codiff/`).
- **User-only agent skills**: the Claude and Pi skills set
  `disable-model-invocation: true`, and the Codex skill has
  `agents/openai.yaml` with `allow_implicit_invocation: false`, so agents only
  open Codiff when the user invokes the skill. OpenCode has no equivalent, so
  its skill stays model-invocable on purpose.
- **Ad hoc signing for local builds**: `APPLE_SIGNING_IDENTITY=-` in
  `forge.config.cjs`.

## Consumers

The agent skills ship inside the app bundle. Codiff's settings install them as
symlinks into the bundle (for example `~/.claude/skills/codiff`), so skill
changes reach agents as soon as a fork build is installed at
`/Applications/Codiff.app`, and only then.

## Working on the commit stack

- Keep each logical customization in its own commit on top of the release tag.
  Keep generated files and unrelated formatting out of those commits.
- Move to a new release by rebasing onto its tag (`git rebase vX.Y.Z`). Never
  merge `main` into the stack.
- A clean rebase does not prove compatibility. Stop and ask the user when an
  upstream change touches Ask (`codiff:askReviewAssistant`,
  `useAppReviewComments`), the review top bar actions, launch option parsing,
  the skill launchers, or window reuse in `focusOrCreateWindow`, or whenever you
  are unsure a customization still works. Do not remove, adapt, or disable a
  customization on your own.
- Prefer new files over edits to upstream-owned files, so rebases stay cheap.
- Push only when asked, with `git push --force-with-lease origin custom`.

## Upstream guardrails

Upstream's `AGENTS.md` still applies to code changes, except its release,
Homebrew tap, and pull request instructions: those are for the upstream
maintainer. Never open issues or pull requests against `nkzw-tech/codiff`, push
to it, upload releases, dispatch its workflows, or touch
`nkzw-tech/homebrew-tap`.

With both remotes present, `gh` may resolve to the upstream repository. Every
clone sets the fork as the default, and checks it before any `gh` command that
writes:

```sh
gh repo set-default gjermundgaraba/codiff
gh repo set-default --view
```

## Build and install

Check, test, build, and package:

```sh
vp check --fix
vp test
vpr build
rm -rf out && APPLE_SIGNING_IDENTITY=- npx electron-forge package
```

This produces `out/Codiff-darwin-arm64/Codiff.app`, signed ad hoc. There is no
Developer ID on this machine; do not sign with another identity.

Install by copying next to the target and renaming over it, keeping one backup:

```sh
find /Applications -maxdepth 1 -name 'Codiff.app.bak-*' -exec rm -rf {} +
mv /Applications/Codiff.app /Applications/Codiff.app.bak-<label>
ditto out/Codiff-darwin-arm64/Codiff.app /Applications/.Codiff.app.installing
mv /Applications/.Codiff.app.installing /Applications/Codiff.app
codesign --verify --deep --strict /Applications/Codiff.app
cmp out/Codiff-darwin-arm64/Codiff.app/Contents/_CodeSignature/CodeResources \
  /Applications/Codiff.app/Contents/_CodeSignature/CodeResources
```

`codiff --version` reports the upstream release for every fork build, so verify
with `cmp` instead. The `codiff` command is a symlink to
`/Applications/Codiff.app/Contents/Resources/app/bin/codiff-app`, which survives
reinstalls. Delete the backup once the user confirms the new build works.

Codiff is not installed through Homebrew, so `brew upgrade` cannot replace it.
Keep `"checkForUpdates": false` in `~/.codiff/codiff.jsonc`, and never use
**Check for Updates** or `codiff update`: both install the upstream
release over the fork build.

## Activating a new build

A running Codiff keeps the old build until it quits. Do not quit or restart it
unless the user asks; tell them a relaunch is needed.
