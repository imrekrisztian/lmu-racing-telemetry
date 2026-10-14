#!/usr/bin/env node
'use strict';

// Push, tag, and have CI build the Windows installer.
//
// The build runs on a windows-latest runner rather than here, because DuckDB
// ships one native binding per platform and npm installs only the host's --
// an installer cross-built on macOS would launch and then fail with no
// database engine. See .github/workflows/build.yml.
//
//   node scripts/release.js                 patch bump, push, tag, wait
//   node scripts/release.js --version minor
//   node scripts/release.js --version 1.2.0
//   node scripts/release.js --no-bump       tag the current version
//   node scripts/release.js --dry-run       show the plan, change nothing
//   node scripts/release.js --no-wait       do not follow the run
//   node scripts/release.js --yes           skip the confirmation

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const ROOT = path.join(__dirname, '..');
const WORKFLOW = 'build.yml';
const ARTIFACT = 'windows-installer';

const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const val = (f, d) => { const i = args.indexOf(`--${f}`); return i === -1 ? d : args[i + 1]; };

const DRY = has('dry-run');
const C = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
            cyan: '\x1b[36m', bold: '\x1b[1m', off: '\x1b[0m' };
const say = (s = '') => process.stdout.write(s + '\n');
const step = (n, s) => say(`${C.cyan}${n}${C.off} ${s}`);
const ok = (s) => say(`   ${C.green}✓${C.off} ${s}`);
const warn = (s) => say(`   ${C.yellow}!${C.off} ${s}`);
const die = (s, hint) => {
    say(`\n${C.red}✗ ${s}${C.off}`);
    if (hint) say(`${C.dim}  ${hint}${C.off}`);
    process.exit(1);
};

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
const tryRun = (cmd, a, opts = {}) =>
    spawnSync(cmd, a, { cwd: ROOT, encoding: 'utf8', ...opts });
const hasCommand = (cmd) => {
    const r = tryRun(process.platform === 'win32' ? 'where' : 'which', [cmd]);
    return r.status === 0;
};

function nextVersion(current, spec) {
    if (!spec || spec === 'patch' || spec === 'minor' || spec === 'major') {
        const [maj, min, pat] = current.split('.').map(Number);
        if (spec === 'major') return `${maj + 1}.0.0`;
        if (spec === 'minor') return `${maj}.${min + 1}.0`;
        return `${maj}.${min}.${pat + 1}`;
    }
    if (!/^\d+\.\d+\.\d+$/.test(spec)) die(`"${spec}" is not a version or a bump keyword`);
    return spec;
}

async function confirm(question) {
    if (has('yes') || DRY) return true;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((r) => rl.question(`${question} ${C.dim}[y/N]${C.off} `, r));
    rl.close();
    return /^y(es)?$/i.test(answer.trim());
}

async function main() {
    say(`${C.bold}Release — build the Windows installer on CI${C.off}`);
    if (DRY) say(`${C.yellow}dry run: nothing will be pushed${C.off}`);
    say();

    // --- preflight --------------------------------------------------------
    step('1/6', 'Checking the working tree');
    try { git('rev-parse', '--is-inside-work-tree'); }
    catch { die('Not a git repository.'); }

    const dirty = git('status', '--porcelain');
    if (dirty && !has('allow-dirty')) {
        die('Uncommitted changes — a release must be reproducible from the tag.',
            'Commit or stash them, or pass --allow-dirty if you know better.');
    }
    ok(dirty ? 'tree is dirty, continuing anyway' : 'tree is clean');

    const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
    ok(`on ${branch}`);

    let remote;
    try { remote = git('remote', 'get-url', 'origin'); }
    catch { die('No "origin" remote.', 'git remote add origin <url>'); }
    ok(`origin ${remote}`);

    // --- tests ------------------------------------------------------------
    step('2/6', 'Running the test suite');
    if (has('skip-tests')) {
        warn('skipped');
    } else if (DRY) {
        warn('skipped in a dry run');
    } else {
        const r = tryRun('npm', ['test'], { stdio: 'ignore', shell: process.platform === 'win32' });
        if (r.status !== 0) {
            die('Tests failed — not releasing.', 'Run "npm test" to see why, or pass --skip-tests.');
        }
        ok('passing');
    }

    // --- version ----------------------------------------------------------
    step('3/6', 'Version');
    const pkgPath = path.join(ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const version = has('no-bump') ? pkg.version : nextVersion(pkg.version, val('version'));
    const tag = `v${version}`;

    const existing = git('tag', '--list', tag);
    if (existing) die(`Tag ${tag} already exists.`, 'Pick another version, or delete the tag.');

    if (version !== pkg.version) {
        ok(`${pkg.version} → ${C.bold}${version}${C.off}`);
        if (!DRY) {
            pkg.version = version;
            fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
            git('add', 'package.json');
            git('commit', '-m', `Release ${tag}`);
        }
    } else {
        ok(`${version} (unchanged)`);
    }

    const ahead = git('rev-list', '--count', `origin/${branch}..HEAD`).trim();
    say();
    say(`   ${C.bold}${ahead}${C.off} commit(s) to push, tagged ${C.bold}${tag}${C.off}`);
    say(`   CI will build the installer on a windows-latest runner.`);
    say();

    if (!await confirm('Push and build?')) die('Cancelled.');

    // --- push -------------------------------------------------------------
    step('4/6', 'Pushing');
    if (DRY) {
        warn(`would run: git push origin ${branch} && git push origin ${tag}`);
    } else {
        const push = tryRun('git', ['push', 'origin', branch], { stdio: 'inherit' });
        if (push.status !== 0) {
            die('Push failed.',
                'Most often this is authentication. Sign in with GitHub Desktop, or\n' +
                '  install the GitHub CLI and run: gh auth login');
        }
        ok(`pushed ${branch}`);
        git('tag', '-a', tag, '-m', `Release ${tag}`);
        const pushTag = tryRun('git', ['push', 'origin', tag], { stdio: 'inherit' });
        if (pushTag.status !== 0) die(`Pushed ${branch} but the tag failed.`,
            `Retry with: git push origin ${tag}`);
        ok(`pushed ${tag} — this is what triggers the build`);
    }

    // --- follow the build -------------------------------------------------
    const slug = remote.replace(/^git@github\.com:/, '').replace(/^https:\/\/github\.com\//, '')
        .replace(/\.git$/, '');
    const actionsUrl = `https://github.com/${slug}/actions`;

    step('5/6', 'Build');
    if (!hasCommand('gh')) {
        warn('GitHub CLI not installed, so the run cannot be followed from here.');
        say();
        say(`   Watch it at ${C.cyan}${actionsUrl}${C.off}`);
        say(`   The installer is attached to the release when it finishes:`);
        say(`   ${C.cyan}https://github.com/${slug}/releases/tag/${tag}${C.off}`);
        say();
        say(`   ${C.dim}To follow and download automatically next time:${C.off}`);
        say(`   ${C.dim}brew install gh && gh auth login${C.off}`);
        return;
    }
    if (DRY) { warn('would follow the run with gh'); return; }

    // The run takes a moment to appear after the tag lands.
    let runId = null;
    for (let i = 0; i < 20 && !runId; i++) {
        const r = tryRun('gh', ['run', 'list', '--workflow', WORKFLOW, '--limit', '1',
            '--json', 'databaseId,headBranch,status']);
        if (r.status === 0 && r.stdout.trim()) {
            const [run] = JSON.parse(r.stdout);
            if (run) runId = run.databaseId;
        }
        if (!runId) await new Promise((res) => setTimeout(res, 3000));
    }
    if (!runId) {
        warn('Could not find the run; it may still be queueing.');
        say(`   ${C.cyan}${actionsUrl}${C.off}`);
        return;
    }
    ok(`run ${runId} started`);
    tryRun('gh', ['run', 'watch', String(runId), '--exit-status'], { stdio: 'inherit' });

    // --- fetch the installer ---------------------------------------------
    step('6/6', 'Downloading the installer');
    const out = path.join(ROOT, 'release');
    const dl = tryRun('gh', ['run', 'download', String(runId), '-n', ARTIFACT, '-D', out],
        { stdio: 'inherit' });
    if (dl.status !== 0) {
        warn('Download failed — the build may not have produced an artifact.');
        say(`   ${C.cyan}${actionsUrl}/runs/${runId}${C.off}`);
        return;
    }
    const files = fs.existsSync(out) ? fs.readdirSync(out).filter((f) => f.endsWith('.exe')) : [];
    say();
    for (const f of files) say(`   ${C.green}${path.join('release', f)}${C.off}`);
    say();
    say(`${C.bold}${C.green}Done.${C.off} Copy the installer to the Windows machine and run it.`);
}

main().catch((e) => die(e.message));
