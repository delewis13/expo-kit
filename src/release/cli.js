// `expo-kit release`: one-command App Store + Google Play release for an Expo app on EAS.
//
//   expo-kit release 1.4.0              bump + changelog cut + commit/push, start the EAS builds
//                                       (EAS uploads them itself), then finish: tag, App Store
//                                       review submission, Play rollout with notes
//   expo-kit release 1.4.0 --dry-run    every check (git, notes, store access, builds), no changes
//   expo-kit release 1.4.0 --platform ios
//   expo-kit release 1.4.0 --rebuild    start fresh builds even if this version has some
//   expo-kit release 1.4.0 --local      build with `eas build` from this folder instead of remotely
//   expo-kit release status             what each store currently shows
//
// Builds are remote by default: an EAS Workflow (.eas/workflows/release.yml) builds and submits the
// pushed HEAD commit, which EAS checks out from GitHub, so nothing uploads from this machine and
// local node_modules can't leak into the build. --local keeps `eas build`, which uploads this folder.
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
const { CONVENTIONS, githubLinkProblem } = require('./conventions');
const { git, checkCleanAndPushed, headCommit, originUrl, isAncestor } = require('./git');
const { findRoot, read, resolveExpoConfig, loadApp, loadConformingApp, loadReleaseNotes } = require('./project');

const USAGE = `usage:
  expo-kit release <X.Y.Z> [--dry-run] [--platform ios|android|all] [--rebuild] [--local]
  expo-kit release status

Builds run remotely by default: the EAS Workflow ${CONVENTIONS.workflow} builds the pushed commit, so
nothing uploads from this machine. --local builds with \`eas build\` from this folder instead.

The app must follow the expo-kit conventions: "expo-kit check" lists anything it does differently.`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logger = (prefix) => (message) => console.log(`[${prefix}] ${message}`);
const log = logger('release');

const POLL_MS = 30 * 1000;
const WORKFLOW_POLL_MS = 10 * 1000;
const BUILD_FAILED = new Set(['ERRORED', 'CANCELED', 'PENDING_CANCEL']);
const SUBMISSION_ACTIVE = new Set(['AWAITING_BUILD', 'IN_QUEUE', 'IN_PROGRESS']);

const write = (root, rel, text) => fs.writeFileSync(path.join(root, rel), text);
const exec = (root, cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });
const { branch, profile, playTrack, appJson, changelog, workflow } = CONVENTIONS;
const short = (commit) => commit.slice(0, 7);
const platformLabel = (platform) => (platform === 'ios' ? 'iOS' : 'Android');

function localDate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** How the user invoked us, so "run this again" hints are copy-pasteable. */
function rerunCommand(version, { platform, local }) {
  const script = process.env.npm_lifecycle_event;
  const base = script ? `npm run ${script} -- ${version}` : `npx expo-kit release ${version}`;
  return [base, platform !== 'all' && `--platform ${platform}`, local && '--local'].filter(Boolean).join(' ');
}

/** The files the version bump rewrites, as `{ relPath: newText }`. Throws before any change. */
function plannedEdits({ root, expo }, version) {
  return {
    [appJson]: notes.bumpVersionText(read(root, appJson), expo.version, version, appJson),
    [changelog]: notes.cutChangelog(read(root, changelog), version, localDate(), changelog),
  };
}

function prepare(project, version) {
  const { root } = project;
  const edits = plannedEdits(project, version);
  log('Running the quality gates…');
  for (const gate of CONVENTIONS.gates) exec(root, 'npm', ['run', '-s', gate]);
  const originals = Object.fromEntries(Object.keys(edits).map((rel) => [rel, read(root, rel)]));
  for (const [rel, text] of Object.entries(edits)) write(root, rel, text);
  const resolved = resolveExpoConfig(root).version;
  if (resolved !== version) {
    for (const [rel, text] of Object.entries(originals)) write(root, rel, text);
    throw new Error(
      `bumped ${appJson}, but the Expo config still resolves to ${resolved}: ` +
        `app.config.* must take the version from ${appJson}`,
    );
  }
  log(`Bumped to ${version}: ${Object.keys(edits).join(', ')}`);
  git(root, 'add', ...Object.keys(edits));
  exec(root, 'git', ['commit', '-m', `Release ${version}`]);
  exec(root, 'git', ['push', 'origin', branch]);
}

/**
 * The tag for `builds` (`{ platform: build }`, in `platforms` order). When the platforms were built
 * from different commits, each one's commit goes in the message, and the tag points at the newer
 * commit (the one that contains the other); if neither contains the other, at the first
 * platform's (iOS when releasing both). `isAncestor(a, b)` answers "is a an ancestor of b".
 */
function tagPlan(version, builds, platforms, { head, isAncestor: ancestor = () => false }) {
  const tag = `v${version}`;
  const commits = platforms.map((p) => builds[p].gitCommitHash ?? head);
  const mixed = new Set(commits).size > 1;
  const summary = platforms
    .map((p, i) => `${platformLabel(p)} ${builds[p].buildNumber}${mixed ? ` @${short(commits[i])}` : ''}`)
    .join(', ');
  if (!mixed) return { tag, commit: commits[0], message: `${tag} (${summary})`, warning: null };

  const [first, second] = commits;
  const commit = ancestor(first, second) ? second : first;
  const why = commit === second || ancestor(second, first) ? 'the newer one' : `neither contains the other, so ${platformLabel(platforms[0])}'s`;
  const builtFrom = platforms.map((p, i) => `${platformLabel(p)} ${builds[p].buildNumber} from ${short(commits[i])}`);
  return {
    tag,
    commit,
    message: `${tag} (${summary})`,
    warning: `the builds come from different commits (${builtFrom.join(', ')}): tagging ${short(commit)} (${why})`,
  };
}

function tagRelease(root, { tag, commit, message, warning }) {
  if (warning) log(`WARNING: ${warning}`);
  if (git(root, 'tag', '--list', tag)) {
    const tagged = git(root, 'rev-list', '-n', '1', tag);
    if (tagged !== commit) log(`WARNING: ${tag} already points at ${short(tagged)}, not ${short(commit)}`);
    return;
  }
  git(root, 'tag', '-a', tag, commit, '-m', message);
  git(root, 'push', '--quiet', 'origin', tag);
  log(`Tagged ${tag} on ${short(commit)} (${message.slice(tag.length + 2, -1)})`);
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
 * Polls the workflow run until EAS has created a build for each of `platforms`, and resolves to
 * `{ platform: buildId }`. If the run ends without exposing one, looks the build up by version and
 * commit instead.
 */
async function waitForWorkflowBuilds(runId, platforms, { projectId, version, commit }) {
  for (;;) {
    const run = await eas.getWorkflowRun(runId);
    const { ids, skipped, done } = eas.workflowBuilds(run, platforms);
    const detail = `${run.status}${run.errors.length ? `: ${run.errors.join('; ')}` : ''}`;
    if (skipped.length) throw new Error(`workflow run ${run.url} isn't building ${skipped.join(' + ')} (${detail})`);
    const missing = platforms.filter((p) => !ids[p]);
    if (!missing.length) return ids;
    if (done) {
      for (const platform of missing) {
        const build = await eas.findLatestBuild({ projectId, platform, version, profile, gitCommitHash: commit });
        if (!build) throw new Error(`workflow run ${run.url} ended without a ${platform} build (${detail})`);
        ids[platform] = build.id;
      }
      return ids;
    }
    await sleep(WORKFLOW_POLL_MS);
  }
}

/**
 * Waits for the build's EAS upload to the store. If EAS never queued one (or it failed), uploads
 * it now with `eas submit`, which submits the build from EAS's servers. With `workflow`, a build
 * whose workflow submit job hasn't finished yet counts as an upload on its way.
 */
async function ensureUploaded(platform, buildId, root, platformLog, { workflow: fromWorkflow = false } = {}) {
  let waiting = false;
  for (;;) {
    const build = await eas.getBuild(buildId, { workflow: fromWorkflow });
    const { submissions } = build;
    if (submissions.some((s) => s.status === 'FINISHED')) {
      platformLog('Uploaded to the store by EAS');
      return;
    }
    if (build.workflowUploadPending || submissions.some((s) => SUBMISSION_ACTIVE.has(s.status))) {
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

/** Throws unless `eas workflow:run --ref` can build this repo: the EAS project is linked to origin. */
async function checkGitHubLink(root, projectId) {
  let linked;
  try {
    linked = await eas.linkedGitHubRepo(projectId);
  } catch (error) {
    log(`WARNING: couldn't check the EAS project's GitHub link (${error.message}); eas workflow:run fails if it's missing`);
    return;
  }
  const problem = githubLinkProblem(linked, originUrl(root));
  if (problem) throw new Error(problem);
}

async function status() {
  const { expo, files } = loadApp(findRoot());
  if (expo.error) throw new Error(`\`npx expo config\` failed: ${expo.error}`);
  const ascAppId = JSON.parse(files['eas.json']).submit?.[profile]?.ios?.ascAppId;
  const creds = await eas.fetchStoreCredentials(expo);
  const [ios, android] = await Promise.all([
    creds.asc && ascAppId ? appStore.versionStatus({ credentials: creds.asc, appId: ascAppId }) : null,
    creds.play && expo.packageName
      ? play.trackStatus({ serviceAccount: creds.play, packageName: expo.packageName, track: playTrack })
      : null,
  ]);
  console.log('App Store (newest first):');
  if (!ios) console.log('  not set up (no App Store Connect key in EAS, or no ascAppId in eas.json)');
  for (const v of (ios ?? []).slice(0, 3)) console.log(`  ${v.version}  ${v.state}  (${v.releaseType})`);
  console.log(`Google Play ${playTrack} track:`);
  if (!android) console.log('  not set up (no Google service-account key in EAS)');
  for (const r of android ?? []) {
    console.log(`  ${r.name}  codes ${r.versionCodes.join(',')}  ${r.status}${r.hasNotes ? '' : '  (no release notes)'}`);
  }
}

async function release(version, options) {
  notes.assertSemver(version);
  const remote = !options.local;
  const platforms = options.platform === 'all' ? ['ios', 'android'] : [options.platform];
  const project = loadConformingApp(findRoot(), { workflow: remote });
  const { root, expo, ascAppId } = project;
  log(
    remote
      ? `Remote build: the EAS Workflow ${workflow} builds the pushed commit (nothing uploads from here; --local to build from this folder)`
      : 'Local build: eas build uploads this folder',
  );

  const releaseNotes = loadReleaseNotes(root, version, platforms);
  log(`Store notes for ${version} found and within limits`);

  const order = notes.compareVersions(version, expo.version);
  if (order < 0) throw new Error(`${version} is older than the app's current ${expo.version}`);
  const needsPrepare = order > 0;
  try {
    if (remote || needsPrepare) checkCleanAndPushed(root, branch);
  } catch (error) {
    if (needsPrepare) throw error;
    throw new Error(`${error.message} (remote builds build the pushed ${branch}; or release with --local)`);
  }
  if (remote) {
    await checkGitHubLink(root, expo.projectId);
    log(`Remote build ready: ${workflow} present, ${branch} clean and in sync with origin, GitHub repo linked`);
  }
  if (needsPrepare) plannedEdits(project, version);

  const creds = await eas.fetchStoreCredentials(expo);
  if (platforms.includes('ios')) {
    if (!creds.asc) throw new Error('EAS has no App Store Connect API key linked for submissions');
    const versions = await appStore.versionStatus({ credentials: creds.asc, appId: ascAppId });
    if (!releaseNotes.whatsNew && !appStore.isFirstVersion(versions, version)) {
      throw new Error(`${CONVENTIONS.notes.appStore} has no "What's New in This Version (${version}):" text block`);
    }
  }
  if (platforms.includes('android')) {
    if (!creds.play) throw new Error('EAS has no Google service-account key linked for submissions');
    await play.checkAccess({ serviceAccount: creds.play, packageName: expo.packageName });
  }
  log(`Store access OK (${platforms.join(' + ')})`);

  // Remote builds come from HEAD (after the bump commit, if this run makes one), and only a build
  // of that commit counts as this version's build.
  let commit = remote && !needsPrepare ? headCommit(root) : undefined;

  // The version's existing builds, unless this run bumps the version (then none can exist yet).
  const buildIds = {};
  const toStart = [];
  for (const platform of platforms) {
    const existing =
      needsPrepare || options.rebuild
        ? null
        : await eas.findLatestBuild({ projectId: expo.projectId, platform, version, profile, gitCommitHash: commit });
    if (existing && BUILD_FAILED.has(existing.status)) {
      throw new Error(
        `the latest ${platform} build of ${version}${commit ? ` at ${short(commit)}` : ''} ${existing.status}` +
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

  // A run of the workflow still going at this commit (say, Ctrl+C before its builds existed).
  const activeRun =
    remote && commit && toStart.length && !options.rebuild
      ? await eas.findActiveWorkflowRun({ projectId: expo.projectId, fileName: path.basename(workflow), commit })
      : null;

  if (options['dry-run']) {
    const at = commit ? short(commit) : 'the release commit';
    const startStep = remote
      ? activeRun
        ? `follow workflow run ${activeRun.id}, already building ${at}`
        : `start ${workflow} for ${toStart.join(' + ')} at ${at} (EAS builds and submits from GitHub)`
      : `start ${toStart.join(' + ')} build(s) with auto-submit`;
    const steps = [
      needsPrepare && `bump ${expo.version} → ${version}, cut the changelog, commit + push`,
      toStart.length && startStep,
      `wait for builds + uploads, tag v${version}, and submit`,
    ].filter(Boolean);
    log(`Dry run (${remote ? 'remote' : 'local'} build): would ${steps.join('; ')}.`);
    return;
  }

  if (needsPrepare) prepare(project, version);
  if (remote) commit = headCommit(root);

  let run = null;
  if (toStart.length && remote) {
    if (activeRun) {
      run = activeRun;
      log(`Following workflow run ${run.id}, already building ${short(commit)}`);
    } else {
      log(`Starting ${workflow} on EAS for ${toStart.join(' + ')} at ${short(commit)}…`);
      run = await eas.startWorkflowRun(workflow, {
        cwd: root,
        ref: commit,
        platform: toStart.length === 2 ? 'all' : toStart[0],
      });
      log(`Started workflow run ${run.id}: ${run.url}`);
    }
  } else if (toStart.length) {
    log(`Starting ${toStart.join(' + ')} build(s) on EAS…`);
    Object.assign(buildIds, await eas.startBuilds(toStart, { cwd: root, profile }));
    for (const platform of toStart) log(`${platform}: started build ${buildIds[platform]}`);
  }
  log(
    'Safe to Ctrl+C from here: EAS finishes the builds and uploads them without this process. ' +
      `To finish later, run: ${rerunCommand(version, options)}`,
  );
  if (run) {
    const started = await waitForWorkflowBuilds(run.id, toStart, { projectId: expo.projectId, version, commit });
    for (const platform of toStart) log(`${platform}: workflow started build ${started[platform]}`);
    Object.assign(buildIds, started);
  }

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
    if (remote && b.gitCommitHash && b.gitCommitHash !== commit) {
      throw new Error(`the ${platform} build ${b.id} is from ${short(b.gitCommitHash)}, not ${short(commit)}`);
    }
  }
  tagRelease(
    root,
    tagPlan(version, builds, platforms, { head: headCommit(root), isAncestor: (a, b) => isAncestor(root, a, b) }),
  );

  const tasks = platforms.map(async (platform) => {
    const platformLog = logger(platform);
    const build = builds[platform];
    await ensureUploaded(platform, build.id, root, platformLog, { workflow: remote });
    if (platform === 'ios') {
      await appStore.releaseVersion({
        credentials: creds.asc,
        appId: ascAppId,
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
        track: playTrack,
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

/** `{ command, options }` from the command line. Builds are remote unless `options.local`. */
function parseCommandLine(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      rebuild: { type: 'boolean', default: false },
      local: { type: 'boolean', default: false },
      platform: { type: 'string', default: 'all' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  return { command: positionals[0], options: values };
}

async function main(argv) {
  const { command, options } = parseCommandLine(argv);
  if (options.help || !command) {
    console.log(USAGE);
    if (!options.help) process.exitCode = 1;
    return;
  }
  if (!['all', 'ios', 'android'].includes(options.platform)) {
    throw new Error('--platform must be ios, android, or all');
  }
  if (command === 'status') return status();
  return release(command, options);
}

function run(argv) {
  main(argv).catch((error) => {
    console.error(`\n[release] FAILED: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { run, parseCommandLine, rerunCommand, tagPlan };
