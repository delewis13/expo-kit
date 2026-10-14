# expo-kit

Shared tooling for Expo apps built on EAS. One package, one `expo-kit` command, one
`expo-kit.config.js` per app with a section per tool.

| Tool | What it does |
|---|---|
| `expo-kit release` | Bump the version → EAS builds → App Store review submission + Google Play rollout, with release notes from the repo. No store dashboards. |

## Install

```bash
npm install --save-dev github:delewis13/expo-kit#v0.1.0
```

```json
"scripts": {
  "release": "expo-kit release",
  "release:status": "expo-kit release status"
}
```

Upgrade by changing the tag. No runtime dependencies; needs Node 22+.

## `expo-kit release`

```bash
npm run release -- 1.4.0 --dry-run   # every check (git, notes, store access, builds), no changes
npm run release -- 1.4.0             # the release
npm run release -- 1.4.0 --platform ios
npm run release -- 1.4.0 --rebuild   # fresh builds even if this version already has some
npm run release:status               # where each store is
```

From a clean release branch that matches origin, it:

1. runs your quality gates, bumps the version, cuts the changelog, commits, and pushes;
2. starts the EAS builds with `--auto-submit`, so EAS uploads them when they finish;
3. waits for the builds, tags the build commit `vX.Y.Z`, and waits for the uploads (running
   `eas submit` itself if EAS's upload failed);
4. **iOS:** creates the App Store version, sets What's New + review notes, waits for Apple's build
   processing, attaches the build, sets automatic release after approval, submits for review;
5. **Android:** promotes the draft on the submit track to a full rollout with the release notes.

**Ctrl+C is safe once the builds are queued.** Running the same command again finds the version's
builds and carries on. Every step checks the current state first, so re-running after a failure is
always safe.

### Credentials

None are stored locally or in the repo. Each run fetches the App Store Connect API key and the
Google service-account key that EAS Submit already uses, from EAS, with your `eas login` session
(or `EXPO_TOKEN`), and keeps them in memory.

### Setup per app

**`eas.json`**: the submit profile (default `production`) needs:

```json
"submit": {
  "production": {
    "ios": { "ascAppId": "1234567890" },
    "android": { "track": "production", "releaseStatus": "draft" }
  }
}
```

`releaseStatus` must be `draft` (eas submit can't attach release notes, so the release adds them
and rolls the draft out). `ascAppId` is the Apple ID under App Information in App Store Connect.
Link the App Store Connect API key and Google service-account key to the app in EAS credentials.

**`expo-kit.config.js`** (optional; defaults shown):

```js
module.exports = {
  release: {
    branch: 'main',                 // releases are cut from here
    versionFile: 'app.json',        // where the marketing version lives (JSON or app.config.ts literal)
    changelog: null,                // e.g. 'docs/CHANGELOG.md' (Keep a Changelog, `## [Unreleased]`)
    gates: [],                      // npm scripts run before the bump, e.g. ['typecheck', 'lint', 'test']
    notes: {
      appStore: 'docs/APP_STORE_METADATA.md',
      play: 'docs/PLAY_STORE_METADATA.md',
    },
    profile: 'production',          // eas.json build + submit profile
  },
};
```

App ids, the project id, and the current version come from `npx expo config`, so `app.config.ts`
apps work. If the version is a literal in `app.config.ts`, point `versionFile` at it.

### Release notes

Write them before releasing, as fenced `text` blocks after an exact label line.

In the App Store file (What's New is required; review notes are optional, App Store Connect keeps
the last ones):

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

In the Play file (≤ 500 characters):

````md
1.4.0:

```text
Bug fixes and a new widget.
```
````

Only the stores being released need notes. To keep them honest in CI, an app can check its
current version's notes in its own tests:

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
