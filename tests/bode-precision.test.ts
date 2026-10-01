import assert from 'node:assert/strict';
import { computeBode, evalControllerFreq } from '../src/core/control/computeBode.ts';
import { BandwidthChecker } from '../src/core/control/bandwidthChecker.ts';
import { estimateLoopBandwidth } from '../src/core/control/loopBandwidth.ts';
import type { ControlLoop } from '../src/core/project/types';

let cases = 0;
function check(name: string, verify: () => void) { verify(); cases++; console.log('  bode precision: ' + name); }
function close(actual: number, expected: number, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected}, received ${actual}`);
}

check('signed PD participates in the complex response and crossover', () => {
  const response = evalControllerFreq({ kp: -2, kd: -0.5 }, 2);
  close(response.re, -2);
  close(response.im, -1);
  close(response.mag, Math.sqrt(5));
  // |(-2 - .5 jω)/(1 + jω)| = 1 exactly at ω = 2.
  const result = computeBode({ family: 'fopdt', k: -1, t: 1, tau: 0 }, { kp: -2, kd: -0.5 }, { sampleTime: 0.001, pointsCount: 1000 });
  close(result.omega_c!, 2, 1e-9);
});

check('signed filtered PD and PID retain every coefficient', () => {
  // At ω=2, -.5*jω/(1+.1*jω) = -5/26 - j*25/26.
  const pd = evalControllerFreq({ kp: -2, kd: -0.5, tf: 0.1 }, 2);
  close(pd.re, -57 / 26);
  close(pd.im, -25 / 26);
  const pid = evalControllerFreq({ kp: -2, ki: -3, kd: -0.5, tf: 0.1 }, 2);
  close(pid.re, -57 / 26);
  close(pid.im, 7 / 13); // -Ki/ω - 25/26 = 3/2 - 25/26.
  close(pid.mag, Math.hypot(-57 / 26, 7 / 13));
  close(pid.phaseRad, Math.atan2(7 / 13, -57 / 26));
  const plant = { family: 'fopdt' as const, k: -1, t: 1, tau: 0 };
  const pdBode = computeBode(plant, { kp: -2, kd: -0.5, tf: 0.1 }, { sampleTime: 0.001, pointsCount: 1000 });
  // With x=ω², the PD unity condition is .01*x² + .52*x - 3 = 0.
  close(pdBode.omega_c!, Math.sqrt((Math.sqrt(0.3904) - 0.52) / 0.02), 1e-9);
  // The full PID unity condition is x³ + 52*x² - 9*x - 900 = 0.
  let low = 0, high = 10;
  for (let iteration = 0; iteration < 60; iteration++) {
    const x = (low + high) / 2;
    if (x * x * x + 52 * x * x - 9 * x - 900 > 0) high = x;
    else low = x;
  }
  const pidBode = computeBode(plant, { kp: -2, ki: -3, kd: -0.5, tf: 0.1 }, { sampleTime: 0.001, pointsCount: 1000 });
  close(pidBode.omega_c!, Math.sqrt((low + high) / 2), 1e-9);
});

check('a negative magnitude smaller than display precision is not a crossover', () => {
  const result = computeBode({ family: 'fopdt', k: 1, t: 1e-6, tau: 0 }, { kp: 1 - 1e-7 }, { sampleTime: 0.001, pointsCount: 1000 });
  assert.ok(result.curve.every(point => point.mag_db < 0));
  assert.equal(result.omega_c, null);
  assert.equal(result.phase_margin, null);
  assert.equal(result.is_stable, null);
});

check('a flat unity response does not invent a distinguished crossover', () => {
  const result = computeBode({ family: 'transfer_function', numerator: [1], denominator: [1], tau: 0 }, { kp: 1 }, { sampleTime: 0.001 });
  assert.equal(result.omega_c, null);
  assert.equal(result.phase_margin, null);
  assert.equal(result.is_stable, null);
});

const loop: ControlLoop = {
  id: 'inner', order: 0, structure: 'P', plant_family: 'first_order', channels: { setpoint: 'r', feedback: 'y', output: 'u' },
  param_limits: { kp: [0, 10], ki: [0, 10], kd: [0, 10] }, cmd_template: '', state: 'identified', sample_time: 0.001,
  current_params: { kp: 2, ki: 0, kd: 0 },
};
check('the model-to-hierarchy path cannot round a 2.99999 ratio into a pass', () => {
  const make = (id: string, order: number, crossover: number): ControlLoop => ({ ...loop, id, order, identified_model: { family: 'fopdt', k: 1, t: Math.sqrt(3) / crossover, tau: 0 } });
  const inner = estimateLoopBandwidth(make('inner', 0, 8.99997));
  const outer = estimateLoopBandwidth(make('outer', 1, 3));
  assert.equal(inner.source, 'model-estimate');
  assert.equal(outer.source, 'model-estimate');
  close(inner.info.omega_c, 8.99997, 1e-9);
  close(outer.info.omega_c, 3, 1e-9);
  const report = BandwidthChecker.checkHierarchy([inner.info, outer.info]);
  close(report.pairs[0].ratio!, 2.99999, 1e-9);
  assert.equal(report.passed, false);
});

check('a crossover below the default scan stays unknown until covered explicitly', () => {
  const plant = { family: 'fopdt' as const, k: 1, t: Math.sqrt(3) / 0.01, tau: 0 };
  const outside = computeBode(plant, { kp: 2 }, { sampleTime: 0.001, pointsCount: 1000 });
  assert.equal(outside.omega_c, null);
  assert.equal(outside.is_stable, null);
  const covered = computeBode(plant, { kp: 2 }, { sampleTime: 0.001, omegaMin: 0.001, omegaMax: 1, pointsCount: 1000 });
  close(covered.omega_c!, 0.01, 1e-11);
});

check('curve and phase margin values preserve calculation precision', () => {
  const plant = { family: 'fopdt' as const, k: 1, t: 0.83, tau: 0.117 };
  const ts = 0.001;
  const result = computeBode(plant, { kp: 2 }, { sampleTime: ts, omegaMin: 0.1, omegaMax: 100, pointsCount: 37 });
  const exactCrossover = Math.sqrt(3) / plant.t;
  close(result.omega_c!, exactCrossover, 1e-9);
  const expectedMargin = 180 - (Math.atan(exactCrossover * plant.t) + exactCrossover * (plant.tau + 1.5 * ts)) * 180 / Math.PI;
  close(result.phase_margin!, expectedMargin, 1e-8);
  const first = result.curve[1];
  close(first.omega, Math.pow(10, -1 + 3 / 36), 1e-14);
  close(first.mag_db, 20 * Math.log10(2 / Math.hypot(1, first.omega * plant.t)), 1e-12);
  assert.notEqual(result.phase_margin, Number(result.phase_margin!.toFixed(2)));
  assert.notEqual(result.omega_c, Number(result.omega_c!.toFixed(4)));
});

check('gain margin retains the response precision at a known phase crossing', () => {
  const ts = 0.001;
  // Choose delay to put the -π phase crossing exactly at ω=2, a scan point.
  const tau = (Math.PI - Math.atan(2)) / 2 - 1.5 * ts;
  const result = computeBode({ family: 'fopdt', k: 1, t: 1, tau }, { kp: 2 }, { sampleTime: ts, omegaMin: 1, omegaMax: 4, pointsCount: 3 });
  close(result.omega_pi!, 2, 1e-12);
  close(result.gain_margin_db!, -20 * Math.log10(2 / Math.sqrt(5)), 1e-12);
  assert.notEqual(result.gain_margin_db, Number(result.gain_margin_db!.toFixed(2)));
});

check('an explicitly provided sub-microsecond period controls the delay phase', () => {
  const ts = 1e-8;
  const result = computeBode({ family: 'fopdt', k: 1, t: 1, tau: 0 }, { kp: 2 }, { sampleTime: ts, omegaMin: 10, omegaMax: 20, pointsCount: 2 });
  close(result.curve[0].delay_phase_deg, -1.5 * 10 * ts * 180 / Math.PI, 1e-15);
  close(result.curve[1].delay_phase_deg, -1.5 * 20 * ts * 180 / Math.PI, 1e-15);
  for (const sampleTime of [0, -1, NaN, Infinity]) assert.throws(() => computeBode({ family: 'fopdt', k: 1, t: 1, tau: 0 }, { kp: 2 }, { sampleTime }));
});

console.log('Bode precision regression: ' + cases + ' cases passed.');
