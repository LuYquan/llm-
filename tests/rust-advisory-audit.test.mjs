import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { advisoryExitCode, summarizeAdvisoryReport, resolveEvidenceOutput, verifyBoundAuditEvidence } from '../scripts/rust-advisory-audit.mjs';

const report = () => ({ vulnerabilities: { found: false, count: 0, list: [] }, warnings: {}, settings: { ignore: [], target_arch: [], target_os: [], severity: null, informational_warnings: ['unmaintained','unsound','notice'] } });
const finding = { advisory: { id: 'RUSTSEC-fixture', title: 'Fixture' }, package: { name: 'fixture', version: '1.0.0' } };
test('an advisory scan with no known findings retains its scope', () => {
  const result = summarizeAdvisoryReport(report());
  assert.equal(result.status, 'no-known-findings');
  assert.equal(result.yankedStatus, 'not-checked');
  assert.equal(advisoryExitCode(result, true), 0);
});
test('informational unsoundness and maintenance warnings fail the strict gate', () => {
  const result = summarizeAdvisoryReport({ ...report(), warnings: { unsound: [finding], unmaintained: [finding] } });
  assert.equal(result.status, 'warnings-found');
  assert.equal(result.warningCount, 2);
  assert.equal(advisoryExitCode(result), 0);
  assert.equal(advisoryExitCode(result, true), 2);
  assert.deepEqual(result.findings.map(item => item.kind), ['unsound', 'unmaintained']);
});
test('vulnerabilities fail ordinary and strict scans', () => {
  const result = summarizeAdvisoryReport({ ...report(), vulnerabilities: { found: true, count: 1, list: [finding] } });
  assert.equal(advisoryExitCode(result), 2);
  assert.equal(advisoryExitCode(result, true), 2);
});
test('missing, contradictory or malformed evidence cannot be a clean report', () => {
  for (const invalid of [null, {}, { ...report(), vulnerabilities: { found: true, count: 0, list: [] } }, { ...report(), vulnerabilities: { found: false, count: 1, list: [] } }, { ...report(), warnings: [] }, { ...report(), warnings: { unsound: {} } }, { ...report(), warnings: { unsound: [{}] } }]) {
    assert.throws(() => summarizeAdvisoryReport(invalid));
  }
});
test('ignored advisories and narrower scan configuration cannot imply an all-lock scan', () => {
  for (const settings of [undefined, { ...report().settings, ignore:['RUSTSEC-fixture'] }, { ...report().settings, target_os:['windows'] }, { ...report().settings, target_arch:['x86_64'] }, { ...report().settings, severity:'high' }, { ...report().settings, informational_warnings:['unmaintained'] }, { ...report().settings, informational_warnings:'unmaintained,unsound,notice' }]) {
    assert.throws(() => summarizeAdvisoryReport({ ...report(), settings }));
  }
});
test('evidence paths reject both outside and inside-workspace junction redirection', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-audit-path-'));
  const fixtureRoot = path.join(fixture, 'workspace');
  fs.mkdirSync(path.join(fixtureRoot,'output'), { recursive: true });
  const outside = path.join(fixture, 'other-tree');
  const inside = path.join(fixtureRoot, 'ordinary-fixture');
  fs.mkdirSync(outside); fs.mkdirSync(inside);
  fs.symlinkSync(outside, path.join(fixtureRoot,'output','outside'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(inside, path.join(fixtureRoot,'output','inside'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(()=>resolveEvidenceOutput('output/outside/absent',fixtureRoot));
  assert.throws(()=>resolveEvidenceOutput('output/inside/absent',fixtureRoot));
  assert.throws(()=>resolveEvidenceOutput('ordinary-fixture/logs',fixtureRoot));
  assert.throws(()=>resolveEvidenceOutput('output/../ordinary-fixture',fixtureRoot));
  assert.equal(resolveEvidenceOutput('output/new/logs',fixtureRoot),path.join(fs.realpathSync(fixtureRoot),'output','new','logs'));
  const noOutputRoot = path.join(fixture,'fresh-root'); fs.mkdirSync(noOutputRoot);
  assert.equal(resolveEvidenceOutput('output/new',noOutputRoot),path.join(fs.realpathSync(noOutputRoot),'output','new'));
  assert.equal(fs.existsSync(path.join(inside,'absent')),false);
  assert.equal(fs.existsSync(path.join(outside,'absent')),false);
});
test('build binding rejects omitted identity, different locks, tampered bytes and forged findings', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(),'llm-audit-binding-'));
  const lock = 'A'.repeat(64);
  const raw = JSON.stringify(report());
  const metadata = { completedAt:'2026-10-01T00:00:00Z', toolVersion:'cargo-audit 0.22.2', toolSha256:'B'.repeat(64), databaseCommit:'c'.repeat(40), databaseCommitTime:'2026-09-30T00:00:00Z', lockfile:'src-tauri/Cargo.lock', lockSha256:lock, commandExitCode:0, reportSha256:crypto.createHash('sha256').update(raw).digest('hex').toUpperCase(), strict:false, sourceUnchanged:true };
  const summary = { ...metadata, ...summarizeAdvisoryReport(report()), exitCode:0 };
  const write = (candidate = summary, bytes = raw) => {
    fs.writeFileSync(path.join(fixture,'summary.json'),JSON.stringify(candidate));
    fs.writeFileSync(path.join(fixture,'metadata.json'),JSON.stringify(metadata));
    fs.writeFileSync(path.join(fixture,'report.json'),bytes);
  };
  write(); assert.equal(verifyBoundAuditEvidence(fixture,lock).status,'no-known-findings');
  assert.throws(()=>verifyBoundAuditEvidence(fixture,'D'.repeat(64)));
  for (const candidate of [{status:'no-known-findings',vulnerabilityCount:0,warningCount:0},{...summary,sourceUnchanged:false},{...summary,toolSha256:undefined},{...summary,warningCount:1},{...summary,exitCode:2},{...summary,commandExitCode:1}]) {
    write(candidate); assert.throws(()=>verifyBoundAuditEvidence(fixture,lock));
  }
  write(summary, raw+' '); assert.throws(()=>verifyBoundAuditEvidence(fixture,lock));
});
