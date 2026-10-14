// `expo-kit release`: one-command App Store + Google Play release for an Expo app on EAS.
//
//   expo-kit release 1.4.0              bump + changelog cut + commit/push, start the EAS builds
//                                       (EAS uploads them itself), then finish: tag, App Store
//                                       review submission, Play rollout with notes
//   expo-kit release 1.4.0 --dry-run    every check (git, notes, store access, builds), no changes
//   expo-kit release 1.4.0 --platform ios
//   expo-kit release 1.4.0 --rebuild    start fresh builds even if this version has some
//   expo-kit release status             what each store currently shows
//
// Ctrl+C is safe once the builds are queued: EAS builds and uploads without this process, and
// running the same command again finds the version's builds and carries on from wherever things
// are. Every step checks the current state first, so re-running is always safe.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseArgs } = require('util');

const notes = require('./notes');
const eas = require('./eas');
const appStore = require('./app-store-connect');
const play = require('./google-play');
const { checkSubmitProfile } = require('./config');
const { findRoot, read, resolveExpoConfig, loadProject, loadReleaseNotes } = require('./project');

const USAGE = `usage:
  expo-kit release <X.Y.Z> [--dry-run] [--platform ios|android|all] [--rebuild]
  expo-kit release status

Settings come from the "release" section of expo-kit.config.js (see the expo-kit README).`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logger = (prefix) => (message) => console.log(`[${prefix}] ${message}`);
const log = logger('release');

const POLL_MS = 30 * 1000;
const BUILD_FAILED = new Set(['ERRORED', 'CANCELED', 'PENDING_CANCEL']);
const SUBMISSION_ACTIVE = new Set(['AWAITING_BUILD', 'IN_QUEUE', 'IN_PROGRESS']);

const write = (root, rel, text) => fs.writeFileSync(path.join(root, rel), text);
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const exec = (root, cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });

function localDate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** How the user invoked us, so "run this again" hints are copy-pasteable. */
function rerunCommand(version, platform) {
  const script = process.env.npm_lifecycle_event;
  const base = script ? `npm run ${script} -- ${version}` : `npx expo-kit release ${version}`;
  return platform === 'all' ? base : `${base} --platform ${platform}`;
}

/** Releases start from a clean, pushed branch so the build commit is the one on origin. */
function checkGitForPrepare(root, branch) {
  const current = git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (current !== branch) throw new Error(`releases are cut from ${branch} (on ${current})`);
  if (git(root, 'status', '--porcelain')) throw new Error('the working tree has uncommitted changes');
  git(root, 'fetch', '--quiet', 'origin', branch);
  if (git(root, 'rev-parse', 'HEAD') !== git(root, 'rev-parse', `origin/${branch}`)) {
    throw new Error(`${branch} is not in sync with origin/${branch}: pull or push first`);
  }
}

/** The files the version bump rewrites, as `{ relPath: newText }`. Throws before any change. */
function plannedEdits({ root, config, expo }, version) {
  const edits = {
    [config.versionFile]: notes.bumpVersionText(read(root, config.versionFile), expo.version, version, config.versionFile),
  };
  if (config.changelog) {
    edits[config.changelog] = notes.cutChangelog(read(root, config.changelog), version, localDate(), config.changelog);
  }
  return edits;
}

function prepare(project, version) {
  const { root, config } = project;
  const edits = plannedEdits(project, version);
  if (config.gates.length) {
    log('Running the quality gates…');
    for (const gate of config.gates) exec(root, 'npm', ['run', '-s', gate]);
  }
  const originals = Object.fromEntries(Object.keys(edits).map((rel) => [rel, read(root, rel)]));
  for (const [rel, text] of Object.entries(edits)) write(root, rel, text);
  const resolved = resolveExpoConfig(root).version;
  if (resolved !== version) {
    for (const [rel, text] of Object.entries(originals)) write(root, rel, text);
    throw new Error(
      `bumped ${config.versionFile}, but the Expo config still resolves to ${resolved}: ` +
        'set release.versionFile to the file the app version comes from',
    );
  }
  log(`Bumped to ${version}: ${Object.keys(edits).join(', ')}`);
  git(root, 'add', ...Object.keys(edits));
  exec(root, 'git', ['commit', '-m', `Release ${version}`]);
  exec(root, 'git', ['push', 'origin', config.branch]);
}

function tagRelease(root, version, commit, builds) {
  const tag = `v${version}`;
  if (git(root, 'tag', '--list', tag)) {
    const tagged = git(root, 'rev-list', '-n', '1', tag);
    if (tagged !== commit) log(`WARNING: ${tag} already points at ${tagged.slice(0, 7)}, not ${commit.slice(0, 7)}`);
    return;
  }
  const summary = Object.entries(builds)
    .map(([platform, b]) => `${platform === 'ios' ? 'iOS' : 'Android'} ${b.buildNumber}`)
    .join(', ');
  git(root, 'tag', '-a', tag, commit, '-m', `${tag} (${summary})`);
  git(root, 'push', '--quiet', 'origin', tag);
  log(`Tagged ${tag} on ${commit.slice(0, 7)} (${summary})`);
}

/** Polls EAS until the build is FINISHED. */
async function waitForEasBuild(buildId, platformLog) {
  let last = null;
  for (;;) {
    const build = await eas.getBuild(buildId);
    if (build.status !== last) platformLog(`EAS build ${build.id}: ${build.status}`);
    last = build.status;
    if (build.status === 'FINISHED') return build;
    if (BUILD_FAILED.has(build.status)) {
      throw new Error(`EAS build ${build.id} ${build.status}${build.error ? `: ${build.error}` : ''}`);
    }
    await sleep(POLL_MS);
  }
}

/**
 * Waits for the build's EAS upload to the store. If EAS never queued one (or it failed), uploads
 * it now with `eas submit`.
 */
async function ensureUploaded(platform, buildId, { root, profile }, platformLog) {
  let waiting = false;
  for (;;) {
    const { submissions } = await eas.getBuild(buildId);
    if (submissions.some((s) => s.status === 'FINISHED')) {
      platformLog('Uploaded to the store by EAS');
      return;
    }
    if (submissions.some((s) => SUBMISSION_ACTIVE.has(s.status))) {
      if (!waiting) platformLog('Waiting for the EAS upload…');
      waiting = true;
      await sleep(POLL_MS);
      continue;
    }
    for (const s of submissions) platformLog(`Earlier EAS upload ${s.status}: ${s.error ?? 'no detail'}`);
    platformLog('Uploading with eas submit…');
    await eas.submitBuild(platform, buildId, { cwd: root, profile });
    return;
  }
}

async function status() {
  const { submit, expo } = loadProject(findRoot());
  const creds = await eas.fetchStoreCredentials(expo);
  const [ios, android] = await Promise.all([
    creds.asc && submit.ascAppId ? appStore.versionStatus({ credentials: creds.asc, appId: submit.ascAppId }) : null,
    creds.play && expo.packageName
      ? play.trackStatus({ serviceAccount: creds.play, packageName: expo.packageName, track: submit.playTrack })
      : null,
  ]);
  console.log('App Store (newest first):');
  if (!ios) console.log('  not set up (no App Store Connect key in EAS, or no ascAppId in eas.json)');
  for (const v of (ios ?? []).slice(0, 3)) console.log(`  ${v.version}  ${v.state}  (${v.releaseType})`);
  console.log(`Google Play ${submit.playTrack} track:`);
  if (!android) console.log('  not set up (no Google service-account key in EAS)');
  for (const r of android ?? []) {
    console.log(`  ${r.name}  codes ${r.versionCodes.join(',')}  ${r.status}${r.hasNotes ? '' : '  (no release notes)'}`);
  }
}

async function release(version, options) {
  notes.assertSemver(version);
  const platforms = options.platform === 'all' ? ['ios', 'android'] : [options.platform];
  const project = loadProject(findRoot());
  const { root, config, submit, expo } = project;
  const profile = config.profile;
  checkSubmitProfile(submit, platforms, profile);

  const releaseNotes = loadReleaseNotes(root, version, platforms, config);
  log(`Store notes for ${version} found and within limits`);

  const order = notes.compareVersions(version, expo.version);
  if (order < 0) throw new Error(`${version} is older than the app's current ${expo.version}`);
  const needsPrepare = order > 0;
  if (needsPrepare) {
    checkGitForPrepare(root, config.branch);
    plannedEdits(project, version);
  }

  const creds = await eas.fetchStoreCredentials(expo);
  if (platforms.includes('ios')) {
    if (!creds.asc) throw new Error('EAS has no App Store Connect API key linked for submissions');
    await appStore.versionStatus({ credentials: creds.asc, appId: submit.ascAppId });
  }
  if (platforms.includes('android')) {
    if (!creds.play) throw new Error('EAS has no Google service-account key linked for submissions');
    await play.checkAccess({ serviceAccount: creds.play, packageName: expo.packageName });
  }
  log(`Store access OK (${platforms.join(' + ')})`);

  // The version's existing builds, unless this run bumps the version (then none can exist yet).
  const buildIds = {};
  const toStart = [];
  for (const platform of platforms) {
    const existing =
      needsPrepare || options.rebuild
        ? null
        : await eas.findLatestBuild({ projectId: expo.projectId, platform, version, profile });
    if (existing && BUILD_FAILED.has(existing.status)) {
      throw new Error(
        `the latest ${platform} build of ${version} ${existing.status}` +
          `${existing.error ? ` (${existing.error})` : ''}: fix it, then re-run with --rebuild`,
      );
    }
    if (existing) {
      log(`${platform}: found build ${existing.id} (${existing.status})`);
      buildIds[platform] = existing.id;
    } else {
      toStart.push(platform);
    }
  }

  if (options['dry-run']) {
    const steps = [
      needsPrepare && `bump ${expo.version} → ${version}${config.changelog ? ', cut the changelog' : ''}, commit + push`,
      toStart.length && `start ${toStart.join(' + ')} build(s) with auto-submit`,
      `wait for builds + uploads, tag v${version}, and submit`,
    ].filter(Boolean);
    log(`Dry run: would ${steps.join('; ')}.`);
    return;
  }

  if (needsPrepare) prepare(project, version);

  if (toStart.length) {
    log(`Starting ${toStart.join(' + ')} build(s) on EAS…`);
    Object.assign(buildIds, await eas.startBuilds(toStart, { cwd: root, profile }));
    for (const platform of toStart) log(`${platform}: started build ${buildIds[platform]}`);
  }
  log(
    'Safe to Ctrl+C from here: EAS finishes the builds and uploads them without this process. ' +
      `To finish later, run: ${rerunCommand(version, options.platform)}`,
  );

  const builds = {};
  await Promise.all(
    platforms.map(async (platform) => {
      builds[platform] = await waitForEasBuild(buildIds[platform], logger(platform));
    }),
  );
  for (const [platform, b] of Object.entries(builds)) {
    if (b.appVersion !== version) {
      throw new Error(`the ${platform} build ${b.id} is version ${b.appVersion}, not ${version}`);
    }
  }
  tagRelease(root, version, builds[platforms[0]].gitCommitHash ?? git(root, 'rev-parse', 'HEAD'), builds);

  const tasks = platforms.map(async (platform) => {
    const platformLog = logger(platform);
    const build = builds[platform];
    await ensureUploaded(platform, build.id, { root, profile }, platformLog);
    if (platform === 'ios') {
      await appStore.releaseVersion({
        credentials: creds.asc,
        appId: submit.ascAppId,
        version,
        buildNumber: build.buildNumber,
        whatsNew: releaseNotes.whatsNew,
        reviewNotes: releaseNotes.reviewNotes,
        log: platformLog,
      });
    } else {
      await play.releaseOnTrack({
        serviceAccount: creds.play,
        packageName: expo.packageName,
        track: submit.playTrack,
        version,
        versionCode: build.buildNumber,
        notes: releaseNotes.playNotes,
        log: platformLog,
      });
    }
  });
  const results = await Promise.allSettled(tasks);
  const failures = results.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
  if (failures.length) throw new Error(failures.join('\n  '));
  log(`${version} is with the stores. Check progress any time with: npx expo-kit release status`);
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      rebuild: { type: 'boolean', default: false },
      platform: { type: 'string', default: 'all' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    if (!values.help) process.exitCode = 1;
    return;
  }
  if (!['all', 'ios', 'android'].includes(values.platform)) {
    throw new Error('--platform must be ios, android, or all');
  }
  if (command === 'status') return status();
  return release(command, values);
}

function run(argv) {
  main(argv).catch((error) => {
    console.error(`\n[release] FAILED: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { run };
