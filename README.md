# expo-kit

Shared tooling for Expo apps built on EAS. There is no per-app config: every app is set up the
same way (the [conventions](#conventions)), and `expo-kit check` lists anything an app does
differently.

| Command | What it does |
|---|---|
| `expo-kit check` | Every way this app differs from the conventions, all at once, plus whether EAS holds the store keys. |
| `expo-kit release` | Bump the version → EAS builds → App Store review submission + Google Play rollout, with release notes from the repo. No store dashboards. |

## Install

```bash
npm install --save-dev github:delewis13/expo-kit#v0.2.0
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

The bundle id, package name, and EAS project id come from `npx expo config`.

## `expo-kit release`

```bash
npm run release -- 1.4.0 --dry-run   # every check (conventions, git, notes, store access, builds), no changes
npm run release -- 1.4.0             # the release
npm run release -- 1.4.0 --platform ios
npm run release -- 1.4.0 --rebuild   # fresh builds even if this version already has some
npm run release:status               # where each store is
```

From a clean `main` that matches origin, it:

1. runs the quality gates, bumps `app.json`, cuts the changelog, commits, and pushes;
2. starts the EAS builds with `--auto-submit`, so EAS uploads them when they finish;
3. waits for the builds, tags the build commit `vX.Y.Z`, and waits for the uploads (running
   `eas submit` itself if EAS's upload failed);
4. **iOS:** creates the App Store version, sets What's New + review notes, waits for Apple's build
   processing, attaches the build, sets automatic release after approval, submits for review;
5. **Android:** promotes the production draft to a full rollout with the release notes.

**Ctrl+C is safe once the builds are queued.** Running the same command again finds the version's
builds and carries on. Every step checks the current state first, so re-running after a failure is
always safe.

**Credentials:** none are stored locally or in the repo. Each run fetches the store keys EAS Submit
already uses, from EAS, with your `eas login` session (or `EXPO_TOKEN`), and keeps them in memory.

### Release notes

Write them before releasing, as fenced `text` blocks after an exact label line.

In `docs/APP_STORE_METADATA.md` (What's New is required; review notes are optional, App Store
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
