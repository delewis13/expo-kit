# expo-kit

Shared tooling for Expo apps built on EAS. There is no per-app config: every app is set up the
same way (the [conventions](#conventions)), and `expo-kit check` lists anything an app does
differently.

| Command | What it does |
|---|---|
| `expo-kit check` | Every way this app differs from the conventions, all at once, plus whether EAS holds the store keys and is linked to the GitHub repo. |
| `expo-kit release` | Bump the version → EAS builds → App Store review submission + Google Play rollout, with release notes from the repo. No store dashboards. |

## Install

```bash
npm install --save-dev github:delewis13/expo-kit#v0.4.0
npx expo-kit check
```

Upgrade by changing the tag. No runtime dependencies; needs Node 22+.

## Conventions

| What | Rule |
|---|---|
| Branch | The repo's default branch is `main`; releases are cut from it, clean and in sync with origin. |
| Version | `expo.version` in `app.json`. An `app.config.*` must take it from there (export a function and use `config.version`). |
| Changelog | `docs/CHANGELOG.md` with a `## [Unreleased]` section (Keep a Changelog). A release refuses an empty one. |
| Quality gates | npm scripts `typecheck`, `lint`, and `test`, each running once (no watch mode). They run before the version bump. |
| Release notes | `docs/APP_STORE_METADATA.md` and `docs/PLAY_STORE_METADATA.md` (format below). |
| npm scripts | `"release": "expo-kit release"`, `"release:status": "expo-kit release status"`. |
| EAS | The `production` build and submit profile. `submit.production.ios.ascAppId` set; `submit.production.android` is `{ "track": "production", "releaseStatus": "draft" }`. |
| Store keys | The App Store Connect API key and Google service-account key are linked to the app for EAS Submit (`eas credentials`). |
| Release workflow | `.eas/workflows/release.yml`, a copy of [`templates/release.yml`](templates/release.yml) (see [remote builds](#remote-builds-the-default)). Not needed with `--local`. |
| GitHub link | The EAS project is connected to the repo `origin` points at (expo.dev → project → Project settings → GitHub). Not needed with `--local`. |

The bundle id, package name, and EAS project id come from `npx expo config`.

## `expo-kit release`

```bash
npm run release -- 1.4.0 --dry-run   # every check (conventions, git, notes, store access, builds), no changes
npm run release -- 1.4.0             # the release
npm run release -- 1.4.0 --platform ios
npm run release -- 1.4.0 --rebuild   # fresh builds even if this version already has some
npm run release -- 1.4.0 --local     # build with `eas build` from this folder instead of remotely
npm run release:status               # where each store is
```

From a clean `main` that matches origin, it:

1. runs the quality gates, bumps `app.json`, cuts the changelog, commits, and pushes;
2. starts the EAS builds: by default the release workflow builds and submits the pushed commit
   ([remote builds](#remote-builds-the-default)); with `--local`, `eas build --auto-submit` uploads
   this folder;
3. waits for the builds, tags the build commit `vX.Y.Z` ([tags](#tags)), and waits for the uploads
   (running `eas submit --id` itself if EAS's upload failed; that submits the build from EAS's
   servers, so nothing uploads from your machine);
4. **iOS:** creates the App Store version, sets What's New + review notes, waits for Apple's build
   processing, attaches the build, sets automatic release after approval, submits for review;
5. **Android:** promotes the production draft to a full rollout with the release notes.

**Ctrl+C is safe once the builds are queued.** Running the same command again finds the version's
builds and carries on. Every step checks the current state first, so re-running after a failure is
always safe.

### Remote builds (the default)

`eas build` compresses and uploads your working folder, about 35 MB per platform. That's slow on a
bad connection, and whatever is in your local `node_modules` ends up in the build (stray codegen
output once made both builds fail with a runtime-version/fingerprint mismatch). Remote builds avoid
both: the release runs `eas workflow:run .eas/workflows/release.yml --ref <HEAD SHA>`, and EAS checks
that exact commit out from GitHub. Nothing uploads from your machine.

Set it up once per app:

1. **Link GitHub.** On [expo.dev](https://expo.dev), open the project → Project settings → GitHub,
   install the Expo GitHub app, and connect the repo `origin` points at.
2. **Add the workflow.** Copy [`templates/release.yml`](templates/release.yml) to
   `.eas/workflows/release.yml` (`cp node_modules/@delewis13/expo-kit/templates/release.yml
   .eas/workflows/`), then commit and push it. EAS reads it from the commit being built, so it has
   to be on `main` before the release.
3. Run `npx expo-kit check`. It reports a missing or changed workflow file and a missing GitHub link.

What remote builds need on every run, even when the version is already bumped or you pass
`--rebuild`: a clean `main` whose HEAD equals `origin/main`. The release passes the full HEAD SHA,
never a branch name, so the build and the tag are the same commit. An existing build of this version
only counts if it was built from that commit. Otherwise the release starts a fresh one. If a
workflow run for that commit is still going (say you pressed Ctrl+C before its builds existed), a
re-run follows it instead of starting another.

`--dry-run` says which mode it would use and checks everything above, without starting anything.

The workflow builds both platforms with the `production` build profile and submits each build with
the `production` submit profile. It takes a `platform` input (`all`, `ios`, or `android`), so
`--platform` works in either mode. It only runs from `eas workflow:run`, never on a push:

```yaml
name: expo-kit release

on:
  workflow_dispatch:
    inputs:
      platform:
        type: choice
        options: [all, ios, android]
        default: all
        description: Which platforms to build and submit

jobs:
  build_ios:
    name: Build iOS
    if: ${{ inputs.platform != 'android' }}
    type: build
    params:
      platform: ios
      profile: production

  build_android:
    name: Build Android
    if: ${{ inputs.platform != 'ios' }}
    type: build
    params:
      platform: android
      profile: production

  submit_ios:
    name: Submit iOS
    needs: [build_ios]
    type: submit
    params:
      build_id: ${{ needs.build_ios.outputs.build_id }}
      profile: production

  submit_android:
    name: Submit Android
    needs: [build_android]
    type: submit
    params:
      build_id: ${{ needs.build_android.outputs.build_id }}
      profile: production
```

You can add things like `runs_on` or hooks. Keep the job names, profiles, the `if` lines, and the
`needs`, which `expo-kit check` looks for.

**`--local`** keeps the old behaviour exactly: `eas build` uploads this folder, the git checks only
run when the release bumps the version, and any existing build of the version is reused,
whichever commit it came from. It needs neither the workflow file nor the GitHub link.

### Tags

`vX.Y.Z` is an annotated tag on the commit the builds came from, e.g. `v3.2.0 (iOS 37, Android 38)`.
If the platforms were built from different commits (for example, a later
`--rebuild --platform android --local`), the message lists each one,
e.g. `v3.2.0 (iOS 37 @abc1234, Android 38 @def5678)`, and the release logs a warning naming both.
The tag then points at the newer commit (the one that contains the other). If neither contains the
other, it points at iOS's. An existing tag is never moved; the release warns if it points elsewhere.

**Credentials:** none are stored locally or in the repo. Each run fetches the store keys EAS Submit
already uses, from EAS, with your `eas login` session (or `EXPO_TOKEN`), and keeps them in memory.

### Release notes

Write them before releasing, as fenced `text` blocks after an exact label line.

In `docs/APP_STORE_METADATA.md` (What's New is required from the second App Store version on;
Apple rejects it on the first, so the release skips it there. Review notes are optional; App Store
Connect keeps the last ones):

````md
What's New in This Version (1.4.0):

```text
Bug fixes and a new widget.
```

App Review notes (1.4.0):

```text
Add the widget from the home screen.
```
````

In `docs/PLAY_STORE_METADATA.md` (≤ 500 characters):

````md
1.4.0:

```text
Bug fixes and a new widget.
```
````

Only the stores being released need notes. An app can pin its current version's notes in its own
tests:

```js
const { loadReleaseNotes } = require('@delewis13/expo-kit/release');
loadReleaseNotes(projectRoot, version); // throws if a block is missing or over a store limit
```

### Still needs a dashboard

The first release of a new app (Apple's API can't create the app record; Play needs the first
bundle uploaded by hand), replying to App Review rejections, accepting new Apple/Google
agreements, Play policy declarations, and store listing content (description, keywords,
screenshots).

## Development

```bash
npm test
```

Try a local change in an app without tagging: `npm install --save-dev ../expo-kit` (switch back
to the git tag before committing, or EAS installs will fail).
