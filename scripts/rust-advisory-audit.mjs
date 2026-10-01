import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();

/** Warnings remain findings even when cargo-audit itself exits successfully. */
export function summarizeAdvisoryReport(report) {
  if (!report?.vulnerabilities || typeof report.vulnerabilities.found !== 'boolean'
    || !Number.isInteger(report.vulnerabilities.count) || !Array.isArray(report.vulnerabilities.list)
    || report.vulnerabilities.count !== report.vulnerabilities.list.length
    || report.vulnerabilities.found !== (report.vulnerabilities.count > 0)
    || !report.warnings || typeof report.warnings !== 'object' || Array.isArray(report.warnings)
    || !Array.isArray(report.settings?.ignore) || report.settings.ignore.length
    || !Array.isArray(report.settings?.target_arch) || report.settings.target_arch.length
    || !Array.isArray(report.settings?.target_os) || report.settings.target_os.length
    || report.settings.severity !== null
    || !Array.isArray(report.settings.informational_warnings)
    || !['unmaintained', 'unsound', 'notice'].every(kind => report.settings.informational_warnings.includes(kind))) {
    throw new Error('Invalid cargo-audit report; missing or inconsistent findings.');
  }
  const findings = [];
  const collect = (item, kind) => {
    if (!item?.advisory?.id || !item.package?.name || !item.package?.version) throw new Error('Invalid advisory identity.');
    findings.push({ kind, id: item.advisory.id, package: item.package.name, version: item.package.version, title: item.advisory.title ?? null });
  };
  for (const item of report.vulnerabilities.list) collect(item, 'vulnerability');
  for (const [kind, items] of Object.entries(report.warnings)) {
    if (!Array.isArray(items)) throw new Error('Invalid advisory warning collection.');
    for (const item of items) collect(item, kind);
  }
  const warningCount = findings.length - report.vulnerabilities.count;
  return {
    status: report.vulnerabilities.count ? 'vulnerabilities-found' : warningCount ? 'warnings-found' : 'no-known-findings',
    vulnerabilityCount: report.vulnerabilities.count, warningCount, findings,
    yankedStatus: 'not-checked', targetFilter: 'none',
    limits: ['Pinned advisory database and lockfile only; no guarantee about undisclosed vulnerabilities.', 'Yanked registry status is not checked.', 'Warnings are not approval for distribution; target reachability must be reviewed separately.'],
  };
}

export function advisoryExitCode(summary, strict = false) {
  return summary.vulnerabilityCount > 0 || (strict && summary.warningCount > 0) ? 2 : 0;
}

/** Restrict all evidence writes to the real output tree, including junction ancestors. */
export function resolveEvidenceOutput(relative, projectRoot = root) {
  if (path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..') || !relative.startsWith('output/')) throw new Error('Evidence output must be a safe path below output/.');
  const realRoot = fs.realpathSync(projectRoot);
  const outputRoot = path.join(realRoot, 'output');
  if (fs.existsSync(outputRoot) && fs.realpathSync(outputRoot) !== outputRoot) throw new Error('The output root must not redirect to another tree.');
  const output = path.resolve(realRoot, relative);
  let ancestor = output;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const realAncestor = fs.realpathSync(ancestor);
  if (realAncestor !== outputRoot && !realAncestor.startsWith(outputRoot + path.sep)
    && !(ancestor === realRoot && !fs.existsSync(outputRoot))) throw new Error('Evidence output escaped the output tree.');
  return output;
}

/** The build accepts a saved scan only with complete identity and original report bytes. */
export function verifyBoundAuditEvidence(directory, expectedLockSha256) {
  const summary = JSON.parse(fs.readFileSync(path.join(directory, 'summary.json'), 'utf8'));
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'metadata.json'), 'utf8'));
  const reportBytes = fs.readFileSync(path.join(directory, 'report.json'));
  const digest = /^[A-F0-9]{64}$/;
  if (summary.sourceUnchanged !== true || summary.lockfile !== 'src-tauri/Cargo.lock'
    || summary.lockSha256 !== expectedLockSha256 || !digest.test(summary.lockSha256)
    || !digest.test(summary.toolSha256) || !digest.test(summary.reportSha256)
    || !/^[a-f0-9]{40,64}$/.test(summary.databaseCommit ?? '')
    || !/^cargo-audit \d+\.\d+\.\d+$/.test(summary.toolVersion ?? '')
    || !Number.isFinite(Date.parse(summary.databaseCommitTime)) || !Number.isFinite(Date.parse(summary.completedAt))
    || typeof summary.strict !== 'boolean' || !Number.isInteger(summary.commandExitCode)
    || summary.reportSha256 !== sha256(reportBytes)) throw new Error('Incomplete or mismatched advisory binding.');
  for (const key of ['completedAt','toolVersion','toolSha256','databaseCommit','databaseCommitTime','lockfile','lockSha256','commandExitCode','reportSha256','strict','sourceUnchanged']) {
    if (summary[key] !== metadata[key]) throw new Error('Advisory metadata differs from summary.');
  }
  const derived = summarizeAdvisoryReport(JSON.parse(reportBytes));
  for (const key of ['status','vulnerabilityCount','warningCount','findings','yankedStatus','targetFilter','limits']) {
    if (JSON.stringify(summary[key]) !== JSON.stringify(derived[key])) throw new Error('Advisory summary differs from report.');
  }
  if (summary.exitCode !== advisoryExitCode(derived, summary.strict)
    || summary.exitCode !== 0 || summary.commandExitCode !== 0) throw new Error('Advisory scan did not pass the selected build policy.');
  return summary;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error || result.signal) throw new Error(`Audit command failed: ${result.error?.message ?? result.signal}`);
  return result;
}

function gitValue(db, args) {
  const result = run('git', ['-C', db, ...args]);
  if (result.status !== 0) throw new Error('Cannot verify advisory database Git identity.');
  return result.stdout.trim();
}

export function runRustAdvisoryAudit(options) {
  if (!options.tool || !options.db) throw new Error('Specify --tool/--db or LLM_SERIAL_AUDIT_TOOL/LLM_SERIAL_AUDIT_DB. No tool installation or database fetch is performed.');
  const tool = fs.realpathSync(path.resolve(options.tool));
  const db = fs.realpathSync(path.resolve(options.db));
  const relative = options.output ?? `output/rust-advisory/${Date.now()}-${process.pid}`;
  const output = resolveEvidenceOutput(relative);
  if (fs.existsSync(output)) throw new Error('Audit output already exists; refusing to overwrite evidence.');
  if (gitValue(db, ['status', '--porcelain'])) throw new Error('Advisory database has local changes; use a clean pinned database.');
  const databaseCommit = gitValue(db, ['rev-parse', 'HEAD']);
  const databaseCommitTime = gitValue(db, ['log', '-1', '--format=%cI']);
  const versionResult = run(tool, ['--version']);
  if (versionResult.status !== 0 || !/^cargo-audit \d+\.\d+\.\d+/.test(versionResult.stdout.trim())) throw new Error('Cannot verify cargo-audit version.');
  const toolVersion = versionResult.stdout.trim();
  const toolHash = sha256(fs.readFileSync(tool));
  const lockfile = path.join(root, 'src-tauri', 'Cargo.lock');
  const lockHash = sha256(fs.readFileSync(lockfile));
  fs.mkdirSync(output, { recursive: true });
  const args = ['audit', '--file', lockfile, '--db', db, '--no-fetch', '--no-yanked', '--json'];
  const result = run(tool, args);
  fs.writeFileSync(path.join(output, 'report.json'), result.stdout ?? '');
  fs.writeFileSync(path.join(output, 'stderr.log'), result.stderr ?? '');
  const metadata = {
    completedAt: new Date().toISOString(), toolVersion, toolSha256: toolHash,
    databaseCommit, databaseCommitTime, lockfile: 'src-tauri/Cargo.lock', lockSha256: lockHash,
    arguments: ['audit', '--file', 'src-tauri/Cargo.lock', '--db', 'pinned-local-database', '--no-fetch', '--no-yanked', '--json'],
    commandExitCode: result.status, reportSha256: sha256(result.stdout ?? ''), strict: Boolean(options.strict),
    sourceUnchanged: lockHash === sha256(fs.readFileSync(lockfile)) && toolHash === sha256(fs.readFileSync(tool))
      && databaseCommit === gitValue(db, ['rev-parse', 'HEAD']) && gitValue(db, ['status', '--porcelain']) === '',
  };
  fs.writeFileSync(path.join(output, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
  if (!metadata.sourceUnchanged) throw new Error('Audit inputs changed during execution.');
  const summary = summarizeAdvisoryReport(JSON.parse(result.stdout));
  // A nonzero process without vulnerability findings is a tool error, not a clean audit.
  if (result.status !== 0 && summary.vulnerabilityCount === 0) throw new Error(`cargo-audit exited ${result.status}; inspect saved stderr.`);
  const exitCode = advisoryExitCode(summary, Boolean(options.strict));
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ ...metadata, ...summary, exitCode }, null, 2) + '\n');
  return { ...summary, exitCode, output: relative };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const options = { tool: process.env.LLM_SERIAL_AUDIT_TOOL, db: process.env.LLM_SERIAL_AUDIT_DB, strict: false };
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--strict') options.strict = true;
      else if (['--tool', '--db', '--output'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) options[args[i].slice(2)] = args[++i];
      else throw new Error(`Invalid audit argument: ${args[i]}`);
    }
    const result = runRustAdvisoryAudit(options);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
