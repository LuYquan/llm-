/**
 * 内置控制工程环路拓扑预设模板 (ProjectModel Templates)
 */

import type { ProjectModel } from './types';

export const BUILTIN_PROJECT_TEMPLATES: Record<string, () => ProjectModel> = {
  foc_3loop: () => ({
    version: 1,
    template: 'foc_3loop',
    sample_period_s: 0.001, // 1kHz 采样周期
    active_loop_id: 'current',
    loops: [
      {
        id: 'current',
        name: '电流内环',
        order: 0,
        structure: 'PI',
        plant_family: 'first_order',
        channels: { setpoint: 3, feedback: 4, output: 5 },
        param_limits: {
          kp: [0, 50],
          ki: [0, 5000],
          kd: [0, 0],
        },
        current_params: { kp: 10, ki: 200, kd: 0 },
        cmd_template: 'SET_PID 0 {kp} {ki} {kd}',
        state: 'untuned',
      },
      {
        id: 'speed',
        name: '速度中环',
        order: 1,
        structure: 'PI',
        plant_family: 'first_order_plus_delay',
        channels: { setpoint: 0, feedback: 1, output: 2 },
        param_limits: {
          kp: [0, 100],
          ki: [0, 1000],
          kd: [0, 5],
        },
        current_params: { kp: 5, ki: 20, kd: 0.1 },
        cmd_template: 'SET_PID 1 {kp} {ki} {kd}',
        state: 'untuned',
      },
      {
        id: 'position',
        name: '位置外环',
        order: 2,
        structure: 'P',
        plant_family: 'integrator_plus_lag',
        channels: { setpoint: 6, feedback: 7, output: 8 },
        param_limits: {
          kp: [0, 50],
          ki: [0, 0],
          kd: [0, 0],
        },
        current_params: { kp: 15, ki: 0, kd: 0 },
        cmd_template: 'SET_PID 2 {kp} {ki} {kd}',
        state: 'untuned',
      },
    ],
    sensor_notes: {
      speed: 'encoder M/T, 1000 ppr, 1st-order LPF fc=200Hz',
      current: 'in-line shunt resistor, 12-bit ADC',
    },
  }),

  drone_cascade: () => ({
    version: 1,
    template: 'drone_cascade',
    sample_period_s: 0.002, // 500Hz
    active_loop_id: 'rate',
    loops: [
      {
        id: 'rate',
        name: '角速度内环',
        order: 0,
        structure: 'PID',
        plant_family: 'first_order',
        channels: { setpoint: 'rate_sp', feedback: 'rate_act', output: 'rate_out' },
        param_limits: {
          kp: [0, 20],
          ki: [0, 50],
          kd: [0, 2],
        },
        current_params: { kp: 2.5, ki: 8.0, kd: 0.15 },
        cmd_template: 'SET_RATE_PID {kp} {ki} {kd}',
        state: 'untuned',
      },
      {
        id: 'angle',
        name: '角度外环',
        order: 1,
        structure: 'P',
        plant_family: 'integrator_plus_lag',
        channels: { setpoint: 'ang_sp', feedback: 'ang_act', output: 'ang_out' },
        param_limits: {
          kp: [0, 10],
          ki: [0, 0],
          kd: [0, 0],
        },
        current_params: { kp: 4.0, ki: 0, kd: 0 },
        cmd_template: 'SET_ANG_PID {kp}',
        state: 'untuned',
      },
    ],
    sensor_notes: {
      imu: 'BMI088 SPI 1kHz, gyro filter 100Hz',
    },
  }),

  temperature_single: () => ({
    version: 1,
    template: 'temperature_single',
    sample_period_s: 0.1, // 10Hz
    active_loop_id: 'temp',
    loops: [
      {
        id: 'temp',
        name: '温度控制环',
        order: 0,
        structure: 'PID',
        plant_family: 'first_order_plus_delay',
        channels: { setpoint: 'temp_sp', feedback: 'temp_act', output: 'heater_pwm' },
        param_limits: {
          kp: [0, 200],
          ki: [0, 50],
          kd: [0, 100],
        },
        current_params: { kp: 30, ki: 2.0, kd: 15 },
        cmd_template: 'SET_TEMP_PID {kp} {ki} {kd}',
        state: 'untuned',
      },
    ],
    sensor_notes: {
      temp: 'PT100 RTD with MAX31865',
    },
  }),

  generic_single: () => ({
    version: 1,
    template: 'generic_single',
    sample_period_s: 0.01, // 100Hz
    active_loop_id: 'loop_0',
    loops: [
      {
        id: 'loop_0',
        name: '通用控制环',
        order: 0,
        structure: 'PI',
        plant_family: 'first_order',
        channels: { setpoint: 'setpoint', feedback: 'actual', output: 'output' },
        param_limits: {
          kp: [0, 100],
          ki: [0, 500],
          kd: [0, 50],
        },
        current_params: { kp: 10, ki: 5, kd: 0 },
        cmd_template: 'SET_PID {kp} {ki} {kd}',
        state: 'untuned',
      },
    ],
  }),
};
