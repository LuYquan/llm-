import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let previousOutputTimestamp = 0;
function defaultOutput(root = sourceRoot) {
  let timestamp = Math.max(Date.now(), previousOutputTimestamp + 1);
  let relative;
  do {
    relative = `output/dependency-inventory/${new Date(timestamp++).toISOString().replace(/[-:.]/g, '')}-${process.pid}`;
  } while (fs.existsSync(path.resolve(root, relative)));
  previousOutputTimestamp = timestamp - 1;
  return relative;
}
const textName = /licen[cs]e|copying|notice|copyright/i;
const maxTextBytes = 2 * 1024 * 1024;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
const inside = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort(compare).map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function inventoryDigest(inventory) {
  return sha256(canonicalJson(inventory));
}

function safePath(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || path.isAbsolute(relative)
    || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('unsafe-relative-path');
  }
  const absolute = path.resolve(root, relative);
  if (!inside(root, absolute)) throw new Error('path-outside-root');
  // Check existing ancestors too: an absent leaf below a symlink is not safe.
  let ancestor = absolute;
  while (!fs.existsSync(ancestor) && ancestor !== root) ancestor = path.dirname(ancestor);
  if (!inside(fs.realpathSync(root), fs.realpathSync(ancestor))) throw new Error('symlink-outside-root');
  return absolute;
}

function readSource(root, relative) {
  const absolute = safePath(root, relative);
  const bytes = fs.readFileSync(absolute);
  return { bytes, absolute, sha256: sha256(bytes) };
}

function parseCargoLock(text) {
  const version = Number(text.match(/^version = (\d+)\s*$/m)?.[1]);
  if (![3, 4].includes(version)) throw new Error('unsupported-cargo-lock-version');
  const packages = text.split(/^\[\[package\]\]\s*$/m).slice(1).map(section => {
    const fields = {};
    for (const match of section.matchAll(/^(name|version|source|checksum) = (".*")\s*$/gm)) {
      fields[match[1]] = JSON.parse(match[2]);
    }
    if (!fields.name || !fields.version) throw new Error('invalid-cargo-lock-package');
    return fields;
  });
  if (!packages.length) throw new Error('empty-cargo-lock');
  return { version, packages };
}

const cargoKey = pkg => `cargo:${pkg.name}@${pkg.version}|${pkg.source ?? 'workspace'}`;
const applies = (values, current) => {
  if (!values?.length) return true;
  const positive = values.filter(value => !value.startsWith('!'));
  return !values.includes(`!${current}`) && (!positive.length || positive.includes(current));
};

/** Collect facts only. No package scripts, network, approval inference or Cargo invocation. */
export function collectDependencyInventory(options = {}) {
  const root = fs.realpathSync(path.resolve(options.root ?? sourceRoot));
  const target = options.target ?? 'x86_64-pc-windows-msvc';
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const registryRoot = path.resolve(options.cargoRegistryRoot ?? path.join(os.homedir(), '.cargo', 'registry', 'src'));
  const diagnostics = [];
  const noticeCandidates = [];
  const inputs = {};
  const issue = (code, id, detail = null, severity = 'error') => diagnostics.push({ code, id, detail, severity });
  const readInput = relative => {
    try {
      const result = readSource(root, relative);
      inputs[relative] = result.sha256;
      return result.bytes.toString('utf8');
    } catch {
      issue('input-unavailable', relative);
      return null;
    }
  };
  const parseJson = (text, id) => {
    if (text === null) return null;
    try { return JSON.parse(text); } catch { issue('invalid-json', id); return null; }
  };
  const textEvidence = (directory, id, declaredFile = null) => {
    const evidence = [];
    let names;
    try {
      names = fs.readdirSync(directory).filter(name => textName.test(name) && fs.lstatSync(path.join(directory, name)).isFile());
      if (declaredFile) names.push(declaredFile);
    } catch {
      issue('license-directory-unavailable', id);
      return evidence;
    }
    for (const name of [...new Set(names)].sort(compare)) {
      try {
        const absolute = safePath(directory, name);
        if (!fs.statSync(absolute).isFile()) throw new Error('not-file');
        if (fs.statSync(absolute).size > maxTextBytes) {
          issue('license-text-too-large', id, name);
          continue;
        }
        const bytes = fs.readFileSync(absolute);
        let utf8Text = true;
        try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { utf8Text = false; }
        if (bytes.includes(0)) utf8Text = false;
        const item = { file: name, bytes: bytes.length, sha256: sha256(bytes), utf8Text };
        evidence.push(item);
        if (!utf8Text) issue('license-text-encoding-review', id, name, 'pending');
        const folder = sha256(id).slice(0, 20);
        const outputRelativePath = `notice-candidates/${folder}/${name.replaceAll('/', '__')}`;
        noticeCandidates.push({ dependencyId: id, file: name, outputRelativePath, sha256: item.sha256, bytes });
      } catch {
        issue('license-text-unavailable-or-unsafe', id, name);
      }
    }
    if (!evidence.length) issue('license-text-evidence-missing', id, null, 'pending');
    return evidence;
  };
  const declaration = (value, id) => {
    const raw = value ?? null;
    const status = typeof value === 'string' && value.trim() ? 'pending-human-review' : 'pending-declaration';
    issue(status === 'pending-declaration' ? 'license-declaration-missing' : 'license-declaration-review', id, null, 'pending');
    return { raw, status, spdxParsed: false, authorized: false };
  };

  const packageJson = parseJson(readInput('package.json'), 'package.json');
  const npmLock = parseJson(readInput('package-lock.json'), 'package-lock.json');
  const cargoLockText = readInput('src-tauri/Cargo.lock');
  const cargoManifestText = readInput('src-tauri/Cargo.toml');
  const product = { status: 'pending-owner-decision', licenseFilePresent: false, npmDeclaration: packageJson?.license ?? null };
  try {
    const absolute = safePath(root, 'LICENSE');
    if (fs.existsSync(absolute)) {
      product.licenseFilePresent = true;
      product.licenseFileSha256 = readSource(root, 'LICENSE').sha256;
    }
  } catch { issue('product-license-path-unsafe', 'product'); }
  issue('product-license-pending', 'product', null, 'pending');

  const npm = { lockfileVersion: npmLock?.lockfileVersion ?? null, packages: [] };
  if (npmLock && npmLock.lockfileVersion !== 3) issue('unsupported-npm-lock-version', 'npm');
  if (npmLock?.packages?.['']?.version !== packageJson?.version) issue('npm-root-version-mismatch', 'npm');
  for (const [relative, locked] of Object.entries(npmLock?.packages ?? {}).sort(([a], [b]) => compare(a, b))) {
    if (!relative) continue;
    const id = `npm:${relative}@${locked.version ?? 'unknown'}`;
    const item = {
      id, path: relative, version: locked.version ?? null, integrity: locked.integrity ?? null,
      dev: Boolean(locked.dev), devOptional: Boolean(locked.devOptional), optional: Boolean(locked.optional),
      os: locked.os ?? [], cpu: locked.cpu ?? [], declaration: declaration(locked.license, id),
      installed: false, applicability: 'unverified', licenseTexts: [],
    };
    npm.packages.push(item);
    try {
      if (!relative.startsWith('node_modules/')) throw new Error('not-node-modules');
      const directory = safePath(root, relative);
      const compatible = applies(item.os, platform) && applies(item.cpu, arch);
      if (!fs.existsSync(path.join(directory, 'package.json'))) {
        item.applicability = item.optional && !compatible ? 'optional-not-applicable' : 'expected-package-missing';
        item.reason = item.applicability === 'optional-not-applicable' ? 'locked-os-or-cpu-excludes-current-platform' : 'no-installed-manifest';
        if (item.applicability === 'expected-package-missing') issue('npm-installed-evidence-missing', id);
        continue;
      }
      const manifest = readSource(directory, 'package.json');
      const local = JSON.parse(manifest.bytes.toString('utf8'));
      item.installed = true;
      item.applicability = compatible ? 'installed-compatible' : 'installed-outside-platform';
      item.installedManifestSha256 = manifest.sha256;
      item.installedName = local.name ?? null;
      item.installedVersion = local.version ?? null;
      item.installedDeclaration = local.license ?? null;
      if (local.version !== locked.version) issue('npm-installed-version-mismatch', id);
      const expectedName = locked.name ?? relative.slice(relative.lastIndexOf('node_modules/') + 'node_modules/'.length);
      if (local.name !== expectedName) issue('npm-installed-name-mismatch', id);
      if (canonicalJson(local.license ?? null) !== canonicalJson(locked.license ?? null)) issue('npm-installed-license-mismatch', id);
      if (!compatible) issue('npm-installed-platform-mismatch', id);
      item.licenseTexts = textEvidence(directory, id);
    } catch {
      item.applicability = 'unsafe-or-invalid-evidence';
      issue('npm-package-evidence-unsafe-or-invalid', id);
    }
  }

  let parsedCargo = { version: null, packages: [] };
  if (cargoLockText !== null) {
    try { parsedCargo = parseCargoLock(cargoLockText); } catch { issue('cargo-lock-unparseable', 'cargo'); }
  }
  const cargo = { lockfileVersion: parsedCargo.version, metadataStatus: 'not-provided', metadataMatchesLockCapture: false, packages: [], targetGraph: { root: null, nodes: [] } };
  const metadataPath = options.metadataPath;
  const metadataResultPath = options.metadataResultPath;
  let metadata = null;
  let metadataResult = null;
  const evidence = { collectorSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))), nodeVersion: process.versions.node };
  const readMetadata = relative => {
    try {
      if (!relative.startsWith('output/')) throw new Error('not-output-evidence');
      const input = readSource(root, relative);
      return { data: JSON.parse(input.bytes.toString('utf8')), sha256: input.sha256 };
    } catch { issue('cargo-metadata-unavailable-or-unsafe', 'cargo', relative); return null; }
  };
  if (metadataResultPath) {
    const result = readMetadata(metadataResultPath);
    metadataResult = result?.data ?? null;
    if (result) evidence.cargoMetadataResultSha256 = result.sha256;
  }
  if (metadataPath) {
    const result = readMetadata(metadataPath);
    metadata = result?.data ?? null;
    if (result) evidence.cargoMetadataJsonSha256 = result.sha256;
  }
  if (metadataResult?.exitCode !== 0 || !metadata) {
    cargo.metadataStatus = metadataResult ? 'capture-failed' : 'not-verified';
    issue('cargo-metadata-evidence-missing', 'cargo', null, 'pending');
    metadata = null;
  } else if (metadataResult.offline !== true || metadataResult.locked !== true || metadataResult.target !== target
    || metadataResult.cargoLockUnchanged === false || metadataResult.cargoLockSha256 !== inputs['src-tauri/Cargo.lock']) {
    cargo.metadataStatus = 'capture-identity-mismatch';
    issue('cargo-metadata-capture-identity-mismatch', 'cargo');
    metadata = null;
  } else if (!Array.isArray(metadata.packages) || !Array.isArray(metadata.resolve?.nodes)) {
    cargo.metadataStatus = 'invalid-shape';
    issue('cargo-metadata-invalid-shape', 'cargo');
    metadata = null;
  } else {
    cargo.metadataStatus = 'captured-offline';
    cargo.metadataMatchesLockCapture = true;
  }
  const metadataPackages = new Map((metadata?.packages ?? []).map(pkg => [cargoKey(pkg), pkg]));
  const idMap = new Map((metadata?.packages ?? []).map(pkg => [pkg.id, cargoKey(pkg)]));
  for (const locked of parsedCargo.packages.sort((a, b) => compare(cargoKey(a), cargoKey(b)))) {
    const id = cargoKey(locked);
    const local = metadataPackages.get(id);
    const item = { id, name: locked.name, version: locked.version, source: locked.source ?? null, checksum: locked.checksum ?? null,
      inCollectedTargetGraph: Boolean(local), declaration: local ? declaration(local.license, id) : { raw: null, status: 'not-collected', spdxParsed: false, authorized: false },
      licenseFileDeclaration: local?.license_file ?? null, licenseTexts: [] };
    cargo.packages.push(item);
    if (locked.source?.startsWith('registry+') && !locked.checksum) issue('cargo-registry-checksum-missing', id);
    if (!local) { issue('cargo-license-not-collected', id, null, 'pending'); continue; }
    if (!local.source) {
      item.sourceKind = 'workspace';
      continue;
    }
    if (!local.source.startsWith('registry+')) {
      issue('cargo-source-needs-explicit-review', id, null, 'pending');
      continue;
    }
    try {
      const manifestAbsolute = path.resolve(local.manifest_path);
      if (!inside(registryRoot, manifestAbsolute) || !inside(fs.realpathSync(registryRoot), fs.realpathSync(manifestAbsolute))) throw new Error('outside-registry-source');
      const directory = path.dirname(manifestAbsolute);
      const manifest = readSource(directory, 'Cargo.toml');
      item.installedManifestSha256 = manifest.sha256;
      item.licenseTexts = textEvidence(directory, id, local.license_file);
      // Some Cargo source caches do not carry this legacy per-file checksum map.
      // Its absence limits integrity evidence; it must not suppress available texts.
      const checksumPath = safePath(directory, '.cargo-checksum.json');
      if (!fs.existsSync(checksumPath)) {
        item.cacheChecksumEvidence = 'not-present';
        item.cacheChecksumMatchesLock = null;
        item.cachedFileHashesMatch = null;
        issue('cargo-cached-checksum-evidence-missing', id, null, 'pending');
      } else {
        const checksumFile = readSource(directory, '.cargo-checksum.json');
        const checksums = JSON.parse(checksumFile.bytes.toString('utf8'));
        item.cacheChecksumEvidence = 'local-map-present';
        item.cachedPackageChecksum = checksums.package ?? null;
        item.cacheChecksumMatchesLock = checksums.package === locked.checksum;
        if (!item.cacheChecksumMatchesLock) issue('cargo-cached-package-checksum-mismatch', id);
        item.cachedFileHashesMatch = true;
        for (const file of ['Cargo.toml', ...item.licenseTexts.map(text => text.file)]) {
          const actual = file === 'Cargo.toml' ? manifest.sha256 : item.licenseTexts.find(text => text.file === file)?.sha256;
          if (!checksums.files?.[file] || checksums.files[file].toUpperCase() !== actual) {
            item.cachedFileHashesMatch = false;
            issue('cargo-cached-file-hash-unverified', id, file);
          }
        }
      }
    } catch { issue('cargo-source-evidence-unavailable-or-unsafe', id); }
  }
  for (const [id] of metadataPackages) {
    if (!cargo.packages.some(pkg => pkg.id === id)) issue('cargo-metadata-package-not-in-lock', id);
  }
  if (metadata) {
    cargo.targetGraph.root = idMap.get(metadata.resolve.root) ?? null;
    if (!cargo.targetGraph.root) issue('cargo-metadata-root-missing', 'cargo');
    cargo.targetGraph.nodes = metadata.resolve.nodes.map(node => ({
      id: idMap.get(node.id) ?? 'unmapped', features: [...(node.features ?? [])].sort(compare),
      dependencies: (node.deps ?? []).map(dep => ({ name: dep.name, id: idMap.get(dep.pkg) ?? 'unmapped',
        kinds: (dep.dep_kinds ?? []).map(kind => ({ kind: kind.kind ?? 'normal', target: kind.target ?? null })).sort((a, b) => compare(canonicalJson(a), canonicalJson(b)))
      })).sort((a, b) => compare(canonicalJson(a), canonicalJson(b))),
    })).sort((a, b) => compare(a.id, b.id));
    if (cargo.targetGraph.nodes.some(node => node.id === 'unmapped' || node.dependencies.some(dep => dep.id === 'unmapped'))) issue('cargo-metadata-graph-unmapped', 'cargo');
    const own = (metadata.packages ?? []).find(pkg => pkg.id === metadata.resolve.root);
    product.cargoDeclaration = own?.license ?? null;
    const manifestVersion = cargoManifestText?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    if (own?.version !== manifestVersion) issue('cargo-workspace-version-mismatch', 'cargo');
  }

  const assets = [];
  for (const relative of ['src/assets', 'src-tauri/icons']) {
    try {
      const directory = safePath(root, relative);
      if (!fs.existsSync(directory)) continue;
      for (const name of fs.readdirSync(directory).sort(compare)) {
        const file = `${relative}/${name}`;
        const absolute = safePath(root, file);
        if (!fs.statSync(absolute).isFile()) {
          issue('asset-subdirectory-not-collected', file, null, 'pending');
          continue;
        }
        const asset = readSource(root, file);
        assets.push({ path: file, bytes: asset.bytes.length, sha256: asset.sha256, rightsStatus: 'pending-owner-evidence' });
        issue('asset-rights-pending', file, null, 'pending');
      }
    } catch { issue('asset-evidence-unavailable-or-unsafe', relative); }
  }
  noticeCandidates.sort((a, b) => compare(a.outputRelativePath, b.outputRelativePath));
  diagnostics.sort((a, b) => compare(canonicalJson(a), canonicalJson(b)));
  const inventory = {
    formatVersion: 1, scope: { target, platform, arch, cargoGraph: 'recorded-metadata-not-proof-of-executable-contents', licenseReview: 'human-review-required', sources: 'locked-dependencies-and-explicit-assets' },
    inputs, product, npm, cargo, assets: assets.sort((a, b) => compare(a.path, b.path)),
    noticeCandidates: noticeCandidates.map(({ bytes, ...candidate }) => candidate), diagnostics,
  };
  const summary = {
    npmLocked: npm.packages.length, npmInstalled: npm.packages.filter(pkg => pkg.installed).length,
    npmOptionalNotApplicable: npm.packages.filter(pkg => pkg.applicability === 'optional-not-applicable').length,
    npmWithTextEvidence: npm.packages.filter(pkg => pkg.licenseTexts.length).length,
    cargoLocked: cargo.packages.length, cargoInMetadata: cargo.packages.filter(pkg => pkg.inCollectedTargetGraph).length,
    cargoWithTextEvidence: cargo.packages.filter(pkg => pkg.licenseTexts.length).length,
    assetsPending: assets.length, noticeCandidateFiles: noticeCandidates.length,
    verificationErrors: diagnostics.filter(item => item.severity === 'error').length,
    pendingReviewItems: diagnostics.filter(item => item.severity === 'pending').length,
    strictPassed: diagnostics.length === 0,
  };
  return { report: { inventorySha256: inventoryDigest(inventory), inventory, evidence, summary }, noticeCandidates };
}

function safeOutputPath(root, relative) {
  if (!relative.startsWith('output/')) throw new Error('output-directory-must-be-under-output');
  const absolute = safePath(root, relative);
  const trueOutputRoot = path.join(fs.realpathSync(root), 'output');
  let ancestor = absolute;
  while (!fs.existsSync(ancestor) && ancestor !== root) ancestor = path.dirname(ancestor);
  const realAncestor = fs.realpathSync(ancestor);
  // A not-yet-created output/ may have the workspace as its existing ancestor.
  // Existing output junctions must stay inside the physical root/output tree.
  if (!(ancestor === root && !fs.existsSync(trueOutputRoot)) && !inside(trueOutputRoot, realAncestor)) {
    throw new Error('output-path-outside-true-output-root');
  }
  return absolute;
}

function outputDirectory(root, relative) {
  const absolute = safeOutputPath(root, relative);
  fs.mkdirSync(absolute, { recursive: true });
  safeOutputPath(root, relative);
  return absolute;
}

export function captureCargoMetadata({ root = sourceRoot, output = defaultOutput(root), target = 'x86_64-pc-windows-msvc', run = spawnSync } = {}) {
  root = fs.realpathSync(root);
  outputDirectory(root, output);
  const before = readSource(root, 'src-tauri/Cargo.lock').sha256;
  const args = ['metadata', '--locked', '--offline', '--format-version', '1', '--filter-platform', target, '--manifest-path', 'src-tauri/Cargo.toml'];
  const result = run('cargo', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CARGO_NET_OFFLINE: 'true' } });
  const after = readSource(root, 'src-tauri/Cargo.lock').sha256;
  fs.writeFileSync(safeOutputPath(root, `${output}/cargo-metadata.json`), result.stdout ?? '');
  fs.writeFileSync(safeOutputPath(root, `${output}/cargo-metadata.stderr.log`), result.stderr ?? '');
  const record = { command: ['cargo', ...args].join(' '), target, offline: true, locked: true, exitCode: result.status ?? null,
    cargoLockSha256: before, cargoLockUnchanged: before === after, signal: result.signal ?? null, executionError: Boolean(result.error),
    stdoutBytes: Buffer.byteLength(result.stdout ?? ''), stderrBytes: Buffer.byteLength(result.stderr ?? '') };
  fs.writeFileSync(safeOutputPath(root, `${output}/cargo-metadata.result.json`), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function writeDependencyInventory(collection, { root = sourceRoot, output = defaultOutput(root) } = {}) {
  root = fs.realpathSync(root);
  const directory = outputDirectory(root, output);
  for (const candidate of collection.noticeCandidates) {
    const relative = `${output}/${candidate.outputRelativePath}`;
    const absolute = safeOutputPath(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(safeOutputPath(root, relative), candidate.bytes);
  }
  fs.writeFileSync(safeOutputPath(root, `${output}/dependency-inventory.json`), `${JSON.stringify(collection.report, null, 2)}\n`);
  fs.writeFileSync(safeOutputPath(root, `${output}/dependency-inventory.sha256`), `${collection.report.inventorySha256}\n`);
  return directory;
}

export function runCli(args = process.argv.slice(2), { runCargo = spawnSync } = {}) {
  const options = { root: sourceRoot };
  const values = { '--root': 'root', '--output': 'output', '--metadata': 'metadataPath', '--metadata-result': 'metadataResultPath', '--cargo-registry-root': 'cargoRegistryRoot', '--target': 'target', '--platform': 'platform', '--arch': 'arch' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--strict') options.strict = true;
    else if (args[i] === '--capture-cargo') options.capture = true;
    else if (values[args[i]] && args[i + 1] && !args[i + 1].startsWith('--')) options[values[args[i]]] = args[++i];
    else throw new Error(`unsupported-or-incomplete-option: ${args[i]}`);
  }
  // Resolve once: capture, metadata references and the inventory share this run.
  options.output ??= defaultOutput(options.root);
  if (options.capture) {
    captureCargoMetadata({ ...options, run: runCargo });
    options.metadataPath ??= `${options.output}/cargo-metadata.json`;
    options.metadataResultPath ??= `${options.output}/cargo-metadata.result.json`;
  }
  const collection = collectDependencyInventory(options);
  writeDependencyInventory(collection, options);
  console.log(JSON.stringify({ output: options.output, inventorySha256: collection.report.inventorySha256, ...collection.report.summary }, null, 2));
  return options.strict && !collection.report.summary.strictPassed ? 2 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = runCli(); }
  catch (error) { console.error(`Dependency evidence collection failed: ${error.message}`); process.exitCode = 1; }
}
