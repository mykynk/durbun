#!/usr/bin/env node
/**
 * `npm run release:check`: every check a release needs, on this Mac, one after the other. It stops at the
 * first problem and says what failed, what to do and how to continue from that step.
 *
 *   npm run release:check                         # everything, from the git state to the iOS build
 *   npm run release:check -- --list               # the steps and their ids
 *   npm run release:check -- --from flutter-durbun  # continue after fixing a step
 *   npm run release:check -- --skip pod-lint      # leave steps out (comma separated)
 *   npm run release:check -- --only versions,changelog  # just these steps
 *   npm run release:check -- --rehearse           # on any branch: no clean-tree, main, tag or date checks
 *
 * It changes nothing: no install, no build of the Mac app, no tag, no upload. Building, signing and
 * publishing follow in CONTRIBUTING.md ("Releasing"); the last lines print that order.
 * Flutter suites run one at a time with --concurrency=2, and the check waits for no one: when another
 * flutter test is running on this Mac it stops and asks to run again later.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { changelogDate, changelogSection } from './release-notes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** YYYY-MM-DD in local time. */
export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Problems with the version's CHANGELOG.md section ([] when it is ready). */
export function changelogProblems(text, version, today, { rehearse = false } = {}) {
  const problems = [];
  // An empty "## [Unreleased]" stays on top: the next version's entries go there.
  const unreleased = /^## \[Unreleased\][^\n]*\n([\s\S]*?)(?=^## \[|(?![\s\S]))/m.exec(text);
  if (!unreleased) problems.push('CHANGELOG.md has no "## [Unreleased]" heading. Keep it, empty, above the release section: the next entries go there.');
  else if (unreleased[1].split('\n').some((l) => l.trim() && !/^\[[^\]]+\]: /.test(l))) problems.push(`CHANGELOG.md still has entries under "## [Unreleased]". Move them into "## [${version}]".`);
  if (!changelogSection(text, version)) problems.push(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section with entries. Move the entries of the release under that heading.`);
  else {
    const date = changelogDate(text, version);
    if (!date) problems.push(`The "## [${version}]" heading in CHANGELOG.md has no date: write it as "## [${version}] - ${today}".`);
    else if (!rehearse && date !== today) problems.push(`The "## [${version}]" heading in CHANGELOG.md is dated ${date}; the release goes out today, ${today}.`);
  }
  return problems;
}

/** Tracked files that look like signing keys or secrets (App Store Connect keys, certificates, .env files). */
export function trackedSecrets(files) {
  return files.filter((f) => f && (/\.(p8|p12|pfx|cer|pem|key|mobileprovision|provisionprofile)$/i.test(f) || /(^|\/)AuthKey_[^/]*$/.test(f) || /(^|\/)\.env(\.[^/]*)?$/.test(f)) && !/(^|\/)\.env\.example$/.test(f));
}

/**
 * Electron ships Chromium security fixes in patch releases: the release uses the newest patch of its major.
 * `npmOut` is `npm view electron@<major> version --json` (one version or a list).
 */
export function electronPatchProblems(installed, npmOut) {
  let list;
  try {
    const parsed = JSON.parse(npmOut);
    list = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return ['The answer of npm about Electron could not be read; run again, or --skip electron.'];
  }
  const parse = (v) => String(v).replace(/^[^\d]*/, '').split('-')[0].split('.').map(Number);
  const newer = (a, b) => {
    for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
    return false;
  };
  const stable = list.filter((v) => typeof v === 'string' && !v.includes('-'));
  const latest = stable.reduce((best, v) => (!best || newer(parse(v), parse(best)) ? v : best), undefined);
  if (!latest) return [];
  return newer(parse(latest), parse(installed))
    ? [`Electron ${latest} is out; the app pins ${installed}. Raise "electron" in apps/desktop/package.json to ${latest}, install it in apps/desktop, run the Mac app tests, then run this check again.`]
    : [];
}

/**
 * The steps, in order. A step runs `run` (commands, each [cmd, args, cwd?]) or `check` (a function that
 * returns a list of problems). `needs` names a tool that must be on PATH; `git` steps are left out by
 * --rehearse.
 */
export function releaseSteps(version) {
  const flutter = 'sdks/flutter/durbun';
  const dio = 'sdks/flutter/durbun_dio';
  return [
    { id: 'git-clean', git: true, title: 'Working tree is clean', check: ({ sh }) => (sh('git', ['status', '--porcelain']).out.trim() ? ['There are uncommitted changes (git status). Commit or remove them first.'] : []) },
    {
      id: 'git-main',
      git: true,
      title: 'On the main branch',
      check: ({ sh }) => {
        const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim();
        return branch === 'main' ? [] : [`The release is made from main; this is "${branch}". Merge, then run the check on main.`];
      },
    },
    {
      id: 'tag-free',
      git: true,
      title: `Tag v${version} does not exist yet`,
      check: ({ sh }) => {
        if (sh('git', ['rev-parse', '-q', '--verify', `refs/tags/v${version}`]).status === 0) return [`Tag v${version} already exists here. A published tag never moves (Swift Package Manager caches it): raise the version instead.`];
        const remote = sh('git', ['ls-remote', '--tags', 'origin', `refs/tags/v${version}`]);
        if (remote.status !== 0) return ['GitHub (origin) could not be asked whether the tag exists. Check the connection and run again.'];
        return remote.out.trim() ? [`Tag v${version} already exists on GitHub. Raise the version instead.`] : [];
      },
    },
    {
      id: 'secrets',
      title: 'No signing keys or secrets in the repository',
      check: ({ sh }) => {
        const found = trackedSecrets(sh('git', ['ls-files']).out.split('\n'));
        return found.length ? [`These tracked files look like keys or secrets: ${found.join(', ')}. Remove them from git (and rotate the key) before a public tag.`] : [];
      },
    },
    { id: 'versions', title: `Every part carries version ${version}`, run: [['node', ['scripts/check-versions.mjs']]], fix: 'Write the version everywhere with `node scripts/check-versions.mjs --write X.Y.Z`.' },
    {
      id: 'changelog',
      title: 'CHANGELOG.md has the release section',
      check: ({ rehearse }) => changelogProblems(readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version, localDate(), { rehearse }),
    },
    {
      id: 'electron',
      title: 'Electron has the latest patch of its major version',
      check: ({ sh }) => {
        const installed = JSON.parse(readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8')).devDependencies?.electron ?? '';
        const major = String(installed).replace(/^[^\d]*/, '').split('.')[0];
        const view = sh('npm', ['view', `electron@${major}`, 'version', '--json']);
        if (view.status !== 0) return ['npm could not be asked for the latest Electron patch. Check the connection and run again, or --skip electron.'];
        return electronPatchProblems(installed, view.out);
      },
    },
    { id: 'typecheck', title: 'Type checks (protocol, server, UI, JS SDK)', run: [['npm', ['run', 'typecheck']]] },
    { id: 'test', title: 'Server, UI and JS SDK tests', run: [['npm', ['test']]] },
    { id: 'test-scripts', title: 'Script tests', run: [['npm', ['run', 'test:scripts']]] },
    { id: 'build', title: 'Server and UI build', run: [['npm', ['run', 'build']]] },
    { id: 'react-native', title: 'React Native package build', run: [['npm', ['run', 'build', '-w', '@durbun/react-native']]] },
    { id: 'js-pack', title: 'JS SDK package contents', run: [['npm', ['pack', '--dry-run'], 'sdks/js']] },
    { id: 'desktop', title: 'Mac app type check and tests', run: [['npm', ['--prefix', 'apps/desktop', 'run', 'typecheck']], ['npm', ['run', 'app:test']]] },
    {
      id: 'flutter-idle',
      needs: 'flutter',
      title: 'No other flutter test is running',
      check: ({ sh }) => {
        const n = sh('ps', ['-axo', 'comm']).out.split('\n').filter((l) => /flutter_tester/.test(l)).length;
        return n > 0 ? [`${n} flutter_tester process(es) are running (another session's tests). Wait until they end: two suites at once overload this Mac.`] : [];
      },
    },
    {
      id: 'flutter-durbun',
      needs: 'flutter',
      title: 'Flutter SDK (durbun): analyze, tests, native core copies',
      run: [
        ['flutter', ['pub', 'get'], flutter],
        ['flutter', ['analyze'], flutter],
        ['flutter', ['test', '--concurrency=2', '-r', 'failures-only'], flutter],
        ['dart', ['run', 'tool/sync_native.dart', '--check'], flutter],
      ],
      fix: 'A native core drift is fixed with `dart run tool/sync_native.dart` in sdks/flutter/durbun.',
    },
    {
      id: 'flutter-dio',
      needs: 'flutter',
      title: 'Flutter SDK (durbun_dio): analyze, tests',
      run: [
        ['flutter', ['pub', 'get'], dio],
        ['flutter', ['analyze'], dio],
        ['flutter', ['test', '--concurrency=2', '-r', 'failures-only'], dio],
      ],
    },
    {
      id: 'pub-dry-run',
      needs: 'dart',
      title: 'pub.dev packages (dry run)',
      run: [
        ['dart', ['pub', 'publish', '--dry-run'], flutter],
        ['dart', ['pub', 'publish', '--dry-run'], dio],
      ],
    },
    {
      id: 'android',
      title: 'Android SDK: unit tests, AARs, no-op API parity',
      run: [
        ['./gradlew', ['--no-daemon', '--max-workers=2', ':durbun:testDebugUnitTest', ':durbun:assembleDebug', ':durbun-noop:assembleRelease'], 'sdks/android'],
        ['python3', ['-I', 'tools/check-binary-compat.py'], 'sdks/android'],
      ],
    },
    {
      id: 'ios',
      needs: 'xcodebuild',
      title: 'iOS SDK: macOS build and tests, iOS Simulator build',
      run: [
        ['swift', ['build', '-j', '2'], 'sdks/ios'],
        ['swift', ['test', '-j', '2'], 'sdks/ios'],
        ['xcodebuild', ['-scheme', 'Durbun', '-destination', 'generic/platform=iOS Simulator', '-quiet', 'build'], 'sdks/ios'],
      ],
    },
    { id: 'pod-lint', needs: 'pod', title: 'CocoaPods spec', run: [['pod', ['lib', 'lint', 'Durbun.podspec', '--quick']]] },
  ];
}

/** After the checks: what remains, in the order CONTRIBUTING.md gives. */
export function nextSteps(version) {
  return [
    `All checks passed for ${version}. Next (CONTRIBUTING.md, "Releasing"):`,
    '  1. Build the Mac app with the signing variables set: npm run app:release',
    '     (it also writes durbun-update-mac-arm64.json and durbun-update-mac-x64.json, the in-app update feeds)',
    '  2. Sign, notarize and staple each DMG with the commands it prints, then write the checksums last:',
    '     cd apps/desktop/release && shasum -a 256 *.dmg *.zip durbun-update-mac-*.json > SHA256SUMS.txt',
    `  3. Tag and push only now: git tag -a v${version} -m "Dürbün ${version}" && git push origin v${version}`,
    `  4. node scripts/release-notes.mjs ${version} > notes.md, then draft the release with every file:`,
    `     gh release create v${version} --draft --verify-tag --title "Dürbün ${version}" --notes-file notes.md \\`,
    '       apps/desktop/release/*.dmg apps/desktop/release/*.zip apps/desktop/release/durbun-update-mac-*.json apps/desktop/release/SHA256SUMS.txt',
    '  5. Publish the draft, then the packages: pub.dev, npm, Maven Central, CocoaPods.',
  ];
}

export function parseArgs(argv) {
  const opts = { list: false, rehearse: false, from: undefined, skip: new Set(), only: new Set(), help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') opts.list = true;
    else if (a === '--rehearse') opts.rehearse = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--from') opts.from = argv[++i];
    else if (a.startsWith('--from=')) opts.from = a.slice(7);
    else if (a === '--skip') for (const id of String(argv[++i] ?? '').split(',')) id && opts.skip.add(id.trim());
    else if (a.startsWith('--skip=')) for (const id of a.slice(7).split(',')) id && opts.skip.add(id.trim());
    else if (a === '--only') for (const id of String(argv[++i] ?? '').split(',')) id && opts.only.add(id.trim());
    else if (a.startsWith('--only=')) for (const id of a.slice(7).split(',')) id && opts.only.add(id.trim());
    else throw new Error(`Unknown option "${a}" (see --help)`);
  }
  return opts;
}

/** The steps to run: from --from on, only --only, without --skip and (with --rehearse) without the git steps. */
export function selectSteps(steps, opts) {
  const ids = steps.map((s) => s.id);
  const only = opts.only ?? new Set();
  for (const id of [opts.from, ...opts.skip, ...only].filter(Boolean)) if (!ids.includes(id)) throw new Error(`No step "${id}". Steps: ${ids.join(', ')}`);
  const start = opts.from ? ids.indexOf(opts.from) : 0;
  return steps.slice(start).filter((s) => !opts.skip.has(s.id) && !(opts.rehearse && s.git) && (only.size === 0 || only.has(s.id)));
}

const defaultSh = (cmd, args, cwd = root) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const defaultRun = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, stdio: 'inherit' }).status ?? 1;
const defaultHas = (tool) => spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).status === 0;

/**
 * Runs the steps until one fails. `io` is injectable for tests: sh (captured output), run (inherited
 * output, returns the exit code), has (is a tool on PATH), print. Returns { ok, failed? }.
 */
export function runSteps(steps, opts, io = {}) {
  const sh = io.sh ?? defaultSh;
  const run = io.run ?? defaultRun;
  const has = io.has ?? defaultHas;
  const print = io.print ?? ((line) => console.log(line));
  const total = steps.length;
  for (const [i, step] of steps.entries()) {
    print(`\n[${i + 1}/${total}] ${step.title}  (${step.id})`);
    let problems = [];
    if (step.needs && !has(step.needs)) {
      problems = [`"${step.needs}" is not installed or not on PATH. Install it, or leave this step out with --skip ${step.id} and run it on a Mac that has it.`];
    } else if (step.check) {
      try {
        problems = step.check({ sh, rehearse: opts.rehearse });
      } catch (err) {
        problems = [String(err?.message ?? err)];
      }
    } else {
      for (const [cmd, args, cwd] of step.run) {
        print(`  $ ${cwd ? `(${cwd}) ` : ''}${[cmd, ...args].join(' ')}`);
        const code = run(cmd, args, path.join(root, cwd ?? '.'));
        if (code !== 0) {
          problems = [`\`${[cmd, ...args].join(' ')}\` failed (exit ${code})${cwd ? ` in ${cwd}` : ''}; its output is above.${step.fix ? ` ${step.fix}` : ''}`];
          break;
        }
      }
    }
    if (problems.length > 0) {
      print(`✖ ${step.title}`);
      for (const p of problems) print(`  ${p}`);
      print(`  After fixing it: npm run release:check -- --from ${step.id}${opts.rehearse ? ' --rehearse' : ''}`);
      return { ok: false, failed: step.id };
    }
    print(`✓ ${step.title}`);
  }
  return { ok: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`✖ ${err.message}`);
    process.exit(2);
  }
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const all = releaseSteps(version);
  if (opts.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 16).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
    process.exit(0);
  }
  if (opts.list) {
    for (const s of all) console.log(`${s.id.padEnd(16)} ${s.title}${s.git ? '  (left out by --rehearse)' : ''}`);
    process.exit(0);
  }
  let steps;
  try {
    steps = selectSteps(all, opts);
  } catch (err) {
    console.error(`✖ ${err.message}`);
    process.exit(2);
  }
  console.log(`Release check for Dürbün ${version}${opts.rehearse ? ' (rehearsal: no git, tag or date checks)' : ''}: ${steps.length} steps.`);
  const result = runSteps(steps, opts);
  if (!result.ok) process.exit(1);
  console.log('');
  if (opts.only.size > 0) console.log(`✓ ${steps.length} step(s) passed.`);
  else for (const line of nextSteps(version)) console.log(line);
  if (opts.rehearse || opts.from || opts.skip.size > 0 || opts.only.size > 0) console.log('\nNote: this run left steps out; run the whole check once before releasing.');
}
