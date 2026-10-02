import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalJson, collectDependencyInventory, captureCargoMetadata, writeDependencyInventory, runCli } from '../scripts/dependency-inventory.mjs';

const sha = value => crypto.createHash('sha256').update(value).digest('hex').toUpperCase();
const roots = [];
after(() => {
  const tempRoot = fs.realpathSync(os.tmpdir());
  for (const root of roots) {
    assert.ok(root.startsWith(`${tempRoot}${path.sep}`));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'llm-dependency-fixture-')));
  roots.push(root);
  const put = (relative, bytes) => {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, bytes);
  };
  const json = (relative, object) => put(relative, `${JSON.stringify(object, null, 2)}\n`);
  const lock = { lockfileVersion: 3, packages: {
    '': { name: 'fixture', version: '1.0.0' },
    'node_modules/tiny': { version: '1.0.0', license: 'MIT', integrity: 'sha512-fixture-only' },
    'node_modules/other-platform': { version: '1.0.0', license: 'MIT OR Apache-2.0', dev: true, optional: true, os: ['linux'], cpu: ['arm64'] },
  } };
  json('package.json', { name: 'fixture', version: '1.0.0' });
  json('package-lock.json', lock);
  json('node_modules/tiny/package.json', { name: 'tiny', version: '1.0.0', license: 'MIT' });
  put('node_modules/tiny/LICENSE', 'Fixture MIT license text.\n');
  put('node_modules/tiny/ThirdPartyNoticeText.txt', 'Fixture bundled notice.\n');
  put('src-tauri/Cargo.toml', '[package]\nname = "fixture"\nversion = "1.0.0"\n');
  const cargoSource = 'registry+https://github.com/rust-lang/crates.io-index';
  const checksum = 'a'.repeat(64);
  put('src-tauri/Cargo.lock', `version = 4\n\n[[package]]\nname = "fixture"\nversion = "1.0.0"\n\n[[package]]\nname = "small"\nversion = "1.0.0"\nsource = "${cargoSource}"\nchecksum = "${checksum}"\n`);
  const registryRelative = 'cache/cargo-registry/src';
  const crateRelative = `${registryRelative}/fixture-registry/small-1.0.0`;
  const cargoManifest = '[package]\nname = "small"\nversion = "1.0.0"\nlicense = "MIT OR Apache-2.0"\n';
  const cargoLicense = 'Fixture Rust license text.\n';
  put(`${crateRelative}/Cargo.toml`, cargoManifest);
  put(`${crateRelative}/LICENSE-MIT`, cargoLicense);
  json(`${crateRelative}/.cargo-checksum.json`, { package: checksum, files: { 'Cargo.toml': sha(cargoManifest).toLowerCase(), 'LICENSE-MIT': sha(cargoLicense).toLowerCase() } });
  put('src/assets/avatar.png', 'fixture-asset-bytes');
  const rootId = `path+file://${root}/src-tauri#fixture@1.0.0`;
  const crateId = 'registry+fixture#small@1.0.0';
  const metadata = { packages: [
    { id: rootId, name: 'fixture', version: '1.0.0', source: null, license: null, license_file: null, manifest_path: path.join(root, 'src-tauri/Cargo.toml') },
    { id: crateId, name: 'small', version: '1.0.0', source: cargoSource, license: 'MIT OR Apache-2.0', license_file: null, manifest_path: path.join(root, crateRelative, 'Cargo.toml') },
  ], resolve: { root: rootId, nodes: [
    { id: rootId, features: ['z', 'a'], deps: [{ name: 'small', pkg: crateId, dep_kinds: [{ kind: null, target: 'cfg(windows)' }] }] },
    { id: crateId, features: [], deps: [] },
  ] } };
  const metadataPath = 'output/evidence/cargo-metadata.json';
  const metadataResultPath = 'output/evidence/cargo-metadata.result.json';
  const result = { exitCode: 0, target: 'x86_64-pc-windows-msvc', offline: true, locked: true, cargoLockUnchanged: true, cargoLockSha256: sha(fs.readFileSync(path.join(root, 'src-tauri/Cargo.lock'))) };
  json(metadataPath, metadata);
  json(metadataResultPath, result);
  return { root, put, json, lock, metadata, result, crateRelative, options: { root, platform: 'win32', arch: 'x64', target: 'x86_64-pc-windows-msvc', cargoRegistryRoot: path.join(root, registryRelative), metadataPath, metadataResultPath } };
}

const codes = collection => collection.report.inventory.diagnostics.map(item => item.code);

test('collects text/notice hashes, normalized target graph and non-applicable optional evidence', () => {
  const f = fixture();
  const collected = collectDependencyInventory(f.options);
  assert.equal(collected.report.summary.verificationErrors, 0);
  assert.equal(collected.report.summary.npmInstalled, 1);
  assert.equal(collected.report.summary.npmOptionalNotApplicable, 1);
  assert.equal(collected.report.summary.noticeCandidateFiles, 3);
  assert.equal(collected.report.inventory.cargo.metadataStatus, 'captured-offline');
  assert.equal(collected.report.inventory.cargo.targetGraph.root, 'cargo:fixture@1.0.0|workspace');
  const own = collected.report.inventory.cargo.targetGraph.nodes.find(node => node.id.endsWith('|workspace'));
  assert.deepEqual(own.features, ['a', 'z']);
  assert.equal(own.dependencies[0].kinds[0].kind, 'normal');
  assert.equal(collected.report.inventory.product.status, 'pending-owner-decision');
  assert.equal(collected.report.summary.strictPassed, false);
});

test('missing license text is an explicit pending item, not approved from the declaration', () => {
  const f = fixture();
  fs.unlinkSync(path.join(f.root, 'node_modules/tiny/LICENSE'));
  fs.unlinkSync(path.join(f.root, 'node_modules/tiny/ThirdPartyNoticeText.txt'));
  const collected = collectDependencyInventory(f.options);
  assert.ok(codes(collected).includes('license-text-evidence-missing'));
  assert.equal(collected.report.inventory.npm.packages.find(pkg => pkg.installed).declaration.authorized, false);
});

test('installed version and lockfile version mismatch are verification failures', () => {
  const f = fixture();
  f.json('node_modules/tiny/package.json', { name: 'tiny', version: '2.0.0', license: 'MIT' });
  f.lock.lockfileVersion = 2;
  f.json('package-lock.json', f.lock);
  const collected = collectDependencyInventory(f.options);
  assert.ok(codes(collected).includes('npm-installed-version-mismatch'));
  assert.ok(codes(collected).includes('unsupported-npm-lock-version'));
});

test('path traversal in a lock entry never reads or copies outside dependency evidence', () => {
  const f = fixture();
  f.lock.packages['node_modules/../../outside'] = { version: '1.0.0', license: 'MIT' };
  f.json('package-lock.json', f.lock);
  const collected = collectDependencyInventory(f.options);
  assert.ok(codes(collected).includes('npm-package-evidence-unsafe-or-invalid'));
  assert.equal(collected.noticeCandidates.length, 3);
  assert.throws(() => writeDependencyInventory(collected, { root: f.root, output: '../outside' }), /under-output/);
});

test('a dependency junction/symlink outside the authorized root is rejected', () => {
  const f = fixture();
  const outside = fixture();
  f.lock.packages['node_modules/escape'] = { version: '1.0.0', license: 'MIT' };
  f.json('package-lock.json', f.lock);
  fs.symlinkSync(path.join(outside.root, 'node_modules/tiny'), path.join(f.root, 'node_modules/escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const collected = collectDependencyInventory(f.options);
  assert.ok(codes(collected).includes('npm-package-evidence-unsafe-or-invalid'));
  assert.equal(collected.noticeCandidates.length, 3);
});

test('an output junction outside output cannot receive copied notices or inventory', () => {
  const f = fixture();
  const outside = fixture();
  fs.symlinkSync(outside.root, path.join(f.root, 'output/escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const collected = collectDependencyInventory(f.options);
  assert.throws(() => writeDependencyInventory(collected, { root: f.root, output: 'output/escape' }), /symlink-outside-root/);
  assert.equal(fs.existsSync(path.join(outside.root, 'dependency-inventory.json')), false);
});

test('an output junction into a non-output directory inside the workspace is rejected before mkdir/copy', () => {
  const f = fixture();
  const ordinary = path.join(f.root, 'ordinary-review-fixture');
  fs.mkdirSync(ordinary);
  fs.symlinkSync(ordinary, path.join(f.root, 'output/inside-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const collected = collectDependencyInventory(f.options);
  assert.throws(() => writeDependencyInventory(collected, { root: f.root, output: 'output/inside-alias/new-run' }), /outside-true-output-root/);
  assert.deepEqual(fs.readdirSync(ordinary), []);
});

test('capture refuses a workspace-internal output redirect before invoking Cargo or mkdir', () => {
  const f = fixture();
  const ordinary = path.join(f.root, 'ordinary-capture-fixture');
  fs.mkdirSync(ordinary);
  fs.symlinkSync(ordinary, path.join(f.root, 'output/capture-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  let invoked = false;
  assert.throws(() => captureCargoMetadata({ root: f.root, output: 'output/capture-alias/new-run', run: () => { invoked = true; throw new Error('must-not-run'); } }), /outside-true-output-root/);
  assert.equal(invoked, false);
  assert.deepEqual(fs.readdirSync(ordinary), []);
});

test('a nested notice directory redirect is rejected before copying candidate bytes', () => {
  const f = fixture();
  const ordinary = path.join(f.root, 'ordinary-notice-fixture');
  fs.mkdirSync(ordinary);
  fs.mkdirSync(path.join(f.root, 'output/candidates'));
  fs.symlinkSync(ordinary, path.join(f.root, 'output/candidates/notice-candidates'), process.platform === 'win32' ? 'junction' : 'dir');
  const collected = collectDependencyInventory(f.options);
  assert.throws(() => writeDependencyInventory(collected, { root: f.root, output: 'output/candidates' }), /outside-true-output-root/);
  assert.deepEqual(fs.readdirSync(ordinary), []);
});

test('the output root itself cannot be a junction into a different workspace directory', () => {
  const f = fixture();
  const collected = collectDependencyInventory(f.options);
  fs.renameSync(path.join(f.root, 'output'), path.join(f.root, 'saved-fixture-evidence'));
  const ordinary = path.join(f.root, 'ordinary-root-fixture');
  fs.mkdirSync(ordinary);
  fs.symlinkSync(ordinary, path.join(f.root, 'output'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => writeDependencyInventory(collected, { root: f.root, output: 'output/new-run' }), /outside-true-output-root/);
  assert.deepEqual(fs.readdirSync(ordinary), []);
});

test('Rust manifest/declared license-file traversal outside registry source is rejected', () => {
  const f = fixture();
  f.metadata.packages[1].license_file = '../../outside-license';
  f.json(f.options.metadataPath, f.metadata);
  const collected = collectDependencyInventory(f.options);
  assert.ok(codes(collected).includes('license-text-unavailable-or-unsafe'));
  f.metadata.packages[1].manifest_path = path.join(f.root, 'package.json');
  f.json(f.options.metadataPath, f.metadata);
  assert.ok(codes(collectDependencyInventory(f.options)).includes('cargo-source-evidence-unavailable-or-unsafe'));
});

test('changing license text changes inventory identity and detects Cargo cache file mismatch', () => {
  const f = fixture();
  const before = collectDependencyInventory(f.options);
  f.put(`${f.crateRelative}/LICENSE-MIT`, 'Changed fixture license text.\n');
  const afterChange = collectDependencyInventory(f.options);
  assert.notEqual(afterChange.report.inventorySha256, before.report.inventorySha256);
  assert.ok(codes(afterChange).includes('cargo-cached-file-hash-unverified'));
});

test('missing Cargo checksum map retains available license texts and leaves integrity pending', () => {
  const f = fixture();
  fs.unlinkSync(path.join(f.root, f.crateRelative, '.cargo-checksum.json'));
  const collected = collectDependencyInventory(f.options);
  const crate = collected.report.inventory.cargo.packages.find(pkg => pkg.name === 'small');
  assert.equal(crate.licenseTexts.length, 1);
  assert.equal(crate.cacheChecksumEvidence, 'not-present');
  assert.equal(crate.cacheChecksumMatchesLock, null);
  assert.ok(codes(collected).includes('cargo-cached-checksum-evidence-missing'));
  assert.equal(collected.report.summary.verificationErrors, 0);
  assert.equal(collected.noticeCandidates.length, 3);
});

test('stable sorting and normalized paths make inventory digest independent of fixture root and input order', () => {
  const a = fixture();
  const b = fixture();
  b.lock.packages = Object.fromEntries(Object.entries(b.lock.packages).reverse());
  // Restore identical lock bytes: input hashes intentionally bind byte-level lock changes.
  b.json('package-lock.json', a.lock);
  b.metadata.packages.reverse();
  b.metadata.resolve.nodes.reverse();
  b.json(b.options.metadataPath, b.metadata);
  const ca = collectDependencyInventory(a.options);
  const cb = collectDependencyInventory(b.options);
  assert.equal(ca.report.inventorySha256, cb.report.inventorySha256);
  assert.notEqual(ca.report.evidence.cargoMetadataJsonSha256, cb.report.evidence.cargoMetadataJsonSha256);
  assert.equal(canonicalJson({ z: 1, a: 2 }), canonicalJson({ a: 2, z: 1 }));
});

test('failed offline capture preserves exit evidence and does not infer missing crates', () => {
  const f = fixture();
  const capture = captureCargoMetadata({ root: f.root, output: 'output/failed', run: (command, args, options) => {
    assert.equal(command, 'cargo');
    assert.ok(args.includes('--offline'));
    assert.ok(args.includes('--locked'));
    assert.equal(options.env.CARGO_NET_OFFLINE, 'true');
    return { status: 101, stdout: '', stderr: 'fixture offline failure', signal: null };
  } });
  assert.equal(capture.exitCode, 101);
  const collected = collectDependencyInventory({ ...f.options, metadataPath: 'output/failed/cargo-metadata.json', metadataResultPath: 'output/failed/cargo-metadata.result.json' });
  assert.equal(collected.report.inventory.cargo.metadataStatus, 'capture-failed');
  assert.ok(codes(collected).includes('cargo-metadata-evidence-missing'));
  assert.equal(collected.report.summary.cargoLocked, 2);
  assert.equal(collected.report.summary.cargoInMetadata, 0);
});

test('metadata capture bound to another lock digest is not accepted', () => {
  const f = fixture();
  f.result.cargoLockSha256 = 'b'.repeat(64);
  f.json(f.options.metadataResultPath, f.result);
  const collected = collectDependencyInventory(f.options);
  assert.equal(collected.report.inventory.cargo.metadataStatus, 'capture-identity-mismatch');
  assert.ok(codes(collected).includes('cargo-metadata-capture-identity-mismatch'));
});

test('copies exact authorized text bytes and leaves approval pending', () => {
  const f = fixture();
  const collected = collectDependencyInventory(f.options);
  writeDependencyInventory(collected, { root: f.root, output: 'output/candidates' });
  for (const candidate of collected.noticeCandidates) {
    assert.equal(sha(fs.readFileSync(path.join(f.root, 'output/candidates', candidate.outputRelativePath))), candidate.sha256);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'output/candidates/dependency-inventory.json'), 'utf8')).summary.strictPassed, false);
});

test('strict CLI exits nonzero for pending product/dependency/asset review without invoking Cargo', () => {
  const f = fixture();
  const script = fileURLToPath(new URL('../scripts/dependency-inventory.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script, '--root', f.root, '--output', 'output/strict', '--metadata', f.options.metadataPath, '--metadata-result', f.options.metadataResultPath, '--cargo-registry-root', f.options.cargoRegistryRoot, '--platform', 'win32', '--arch', 'x64', '--strict'], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 2, run.stderr);
  assert.equal(JSON.parse(run.stdout).strictPassed, false);
  assert.equal(fs.existsSync(path.join(f.root, 'LICENSE')), false);
});

test('default CLI ordinary and strict outputs preserve previous runs even in the same millisecond', t => {
  const f = fixture();
  const legacyRelative = 'output/dependency-inventory-20261001/dependency-inventory.json';
  f.put(legacyRelative, 'Existing frozen fixture evidence.\n');
  const summaries = [];
  t.mock.method(console, 'log', value => summaries.push(JSON.parse(value)));
  t.mock.method(Date, 'now', () => Date.UTC(2026, 9, 1));
  let cargoCalls = 0;
  const runCargo = () => { cargoCalls++; throw new Error('must-not-invoke-Cargo'); };
  const args = ['--root', f.root, '--platform', 'win32', '--arch', 'x64'];
  assert.equal(runCli(args, { runCargo }), 0);
  const first = summaries[0];
  assert.match(first.output, /^output\/dependency-inventory\/\d{8}T\d{9}Z-\d+$/);
  const inventory = path.join(f.root, first.output, 'dependency-inventory.json');
  const before = fs.readFileSync(inventory);
  f.put('node_modules/tiny/LICENSE', 'Changed evidence for the next fixture run.\n');
  assert.equal(runCli([...args, '--strict'], { runCargo }), 2);
  const second = summaries[1];
  assert.match(second.output, /^output\/dependency-inventory\/\d{8}T\d{9}Z-\d+$/);
  assert.notEqual(second.output, first.output);
  assert.notEqual(second.inventorySha256, first.inventorySha256);
  assert.deepEqual(fs.readFileSync(inventory), before);
  assert.equal(fs.readFileSync(path.join(f.root, legacyRelative), 'utf8'), 'Existing frozen fixture evidence.\n');
  assert.equal(fs.existsSync(path.join(f.root, second.output, 'dependency-inventory.json')), true);
  assert.equal(cargoCalls, 0);
});

test('default CLI capture and inventory use one generated directory with a fake offline runner', t => {
  const f = fixture();
  let summary;
  let cargoCalls = 0;
  t.mock.method(console, 'log', value => { summary = JSON.parse(value); });
  const runCargo = (command, args, options) => {
    cargoCalls++;
    assert.equal(command, 'cargo');
    assert.ok(args.includes('--locked'));
    assert.ok(args.includes('--offline'));
    assert.equal(options.env.CARGO_NET_OFFLINE, 'true');
    return { status: 0, stdout: JSON.stringify(f.metadata), stderr: '', signal: null };
  };
  assert.equal(runCli(['--root', f.root, '--capture-cargo', '--cargo-registry-root', f.options.cargoRegistryRoot, '--platform', 'win32', '--arch', 'x64'], { runCargo }), 0);
  assert.equal(cargoCalls, 1);
  assert.match(summary.output, /^output\/dependency-inventory\/\d{8}T\d{9}Z-\d+$/);
  const directory = path.join(f.root, summary.output);
  for (const filename of ['cargo-metadata.json', 'cargo-metadata.stderr.log', 'cargo-metadata.result.json', 'dependency-inventory.json', 'dependency-inventory.sha256']) {
    assert.equal(fs.existsSync(path.join(directory, filename)), true, filename);
  }
  const report = JSON.parse(fs.readFileSync(path.join(directory, 'dependency-inventory.json'), 'utf8'));
  assert.equal(report.inventory.cargo.metadataStatus, 'captured-offline');
  assert.equal(report.summary.cargoInMetadata, 2);
  assert.equal(summary.inventorySha256, report.inventorySha256);
  assert.equal(fs.readdirSync(path.join(f.root, 'output/dependency-inventory')).length, 1);
});
