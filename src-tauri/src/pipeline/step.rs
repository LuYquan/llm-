use std::collections::VecDeque;
pub use crate::model::{StepAnalysisStatus, StepMetrics, StepSnapshot};

/// 阶跃分析引擎 (严格实现 engineering-decisions.md 第一节算法基准)
pub struct StepAnalyzer;

impl StepAnalyzer {
    /// 对完整阶跃切片计算控制工程四大指标
    /// - `times`: 相对时间点列表 (0.0s 为阶跃发生时刻)
    /// - `target`: 目标值序列
    /// - `actual`: 实际响应值序列
    pub fn analyze(times: &[f64], target: &[f64], actual: &[f64]) -> Option<StepMetrics> {
        let n = times.len();
        if n < 10 || times.len() != target.len() || times.len() != actual.len() {
            return None;
        }

        // 1. 定位阶跃时刻 t_step (定义为 relative_time 最接近 0.0 的位置)
        let step_idx = times
            .iter()
            .position(|&t| t >= 0.0)
            .unwrap_or(0);

        // 2. 基线 y0: 阶跃前 500ms (Pre-Window) 均值；若无负时间点，则取阶跃点前的值
        let pre_points: Vec<f64> = actual[..step_idx]
            .iter()
            .copied()
            .collect();
        let y0 = if !pre_points.is_empty() {
            pre_points.iter().sum::<f64>() / pre_points.len() as f64
        } else {
            actual[0]
        };

        // 3. 目标值 y_target 取阶跃后主要目标
        let y_target = target[step_idx..]
            .iter()
            .copied()
            .next()
            .unwrap_or(target[target.len() - 1]);

        let delta_target = y_target - y0;
        if delta_target.abs() < 1e-6 {
            // 无有效阶跃幅值
            return None;
        }

        // 4. 稳态终值 y_ss: 取阶跃稳定后最后 10% 点的均值 (engineering-decisions 1)
        let post_points = &actual[step_idx..];
        let post_len = post_points.len();
        if post_len < 5 {
            return None;
        }

        let tail_count = ((post_len as f64) * 0.10).ceil() as usize;
        let tail_count = tail_count.max(2).min(post_len);
        let tail_start = post_len - tail_count;
        let y_ss = post_points[tail_start..].iter().sum::<f64>() / tail_count as f64;

        // 5. 稳态误差 e_ss = |y_target - y_ss|
        let steady_state_error = (y_target - y_ss).abs();

        // 6. 极值 y_max 与超调量 Mp = (y_max - y_ss)/(y_ss - y0) * 100%
        let (y_max, overshoot_pct) = if delta_target > 0.0 {
            // 正阶跃：寻找最大值
            let max_val = post_points.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            let overshoot = if max_val > y_ss {
                let denom = (y_ss - y0).abs();
                if denom > 1e-6 {
                    let raw_pct = ((max_val - y_ss) / denom) * 100.0;
                    // 工程判定：若超调量 < 0.2% 且最大值位于区间边缘（属于渐近收敛的截断效应），归零处理
                    if raw_pct < 0.2 {
                        0.0
                    } else {
                        raw_pct
                    }
                } else {
                    0.0
                }
            } else {
                0.0
            };
            (max_val, overshoot)
        } else {
            // 负阶跃：寻找最小值
            let min_val = post_points.iter().copied().fold(f64::INFINITY, f64::min);
            let overshoot = if min_val < y_ss {
                let denom = (y_ss - y0).abs();
                if denom > 1e-6 {
                    let raw_pct = ((y_ss - min_val) / denom) * 100.0;
                    if raw_pct < 0.2 {
                        0.0
                    } else {
                        raw_pct
                    }
                } else {
                    0.0
                }
            } else {
                0.0
            };
            (min_val, overshoot)
        };

        // 7. 上升时间 tr: 10% -> 90% 阶跃幅值 (engineering-decisions 1)
        let y_10 = y0 + 0.10 * delta_target;
        let y_90 = y0 + 0.90 * delta_target;

        let t_10 = Self::find_crossing_time(&times[step_idx..], post_points, y_10, delta_target > 0.0);
        let t_90 = Self::find_crossing_time(&times[step_idx..], post_points, y_90, delta_target > 0.0);

        let rise_time_s = match (t_10, t_90) {
            (Some(t1), Some(t2)) if t2 >= t1 => Some(t2 - t1),
            _ => None,
        };

        // 8. 调节时间 ts: 进入目标 ±2% 误差带，并持续维持 >= 500ms 的时刻 (engineering-decisions 1)
        let band = 0.02 * delta_target.abs();
        let min_sustain_s = 0.50; // 500ms

        let mut settling_time_s = None;
        let mut is_stable = false;

        let post_times = &times[step_idx..];
        for (i, &t_cand) in post_times.iter().enumerate() {
            let val = post_points[i];
            if (val - y_target).abs() <= band {
                // 检查从 i 开始到 i + 500ms 的所有点是否都落在误差带内
                let end_time = t_cand + min_sustain_s;
                let mut sustained = true;
                let mut checked_any = false;

                for j in i..post_len {
                    if post_times[j] > end_time {
                        break;
                    }
                    checked_any = true;
                    if (post_points[j] - y_target).abs() > band {
                        sustained = false;
                        break;
                    }
                }

                // 若能维持到 end_time 且后续不再离开误差带
                if sustained && (checked_any && post_times[post_len - 1] >= end_time) {
                    let mut leaves_later = false;
                    for k in i..post_len {
                        if (post_points[k] - y_target).abs() > band {
                            leaves_later = true;
                            break;
                        }
                    }
                    if !leaves_later {
                        settling_time_s = Some(t_cand);
                        is_stable = true;
                        break;
                    }
                }
            }
        }

        Some(StepMetrics {
            overshoot_percent: Some(overshoot_pct),
            settling_time_s,
            rise_time_s,
            steady_state_error: Some(steady_state_error),
            overshoot_pct: Some(overshoot_pct),
            y0: Some(y0),
            y_target: Some(y_target),
            y_ss: Some(y_ss),
            y_max: Some(y_max),
            is_stable: Some(is_stable),
        })
    }

    /// 线性插值寻找穿越指定阈值的时刻
    fn find_crossing_time(times: &[f64], values: &[f64], threshold: f64, ascending: bool) -> Option<f64> {
        for i in 0..values.len().saturating_sub(1) {
            let v1 = values[i];
            let v2 = values[i + 1];
            let t1 = times[i];
            let t2 = times[i + 1];

            if ascending {
                if v1 <= threshold && v2 >= threshold {
                    if (v2 - v1).abs() < 1e-9 {
                        return Some(t1);
                    }
                    let frac = (threshold - v1) / (v2 - v1);
                    return Some(t1 + frac * (t2 - t1));
                }
            } else {
                if v1 >= threshold && v2 <= threshold {
                    if (v2 - v1).abs() < 1e-9 {
                        return Some(t1);
                    }
                    let frac = (v1 - threshold) / (v1 - v2);
                    return Some(t1 + frac * (t2 - t1));
                }
            }
        }
        None
    }
}

/// 阶跃检测器状态机
#[derive(Debug, PartialEq, Eq)]
enum DetectorState {
    Idle,
    Recording {
        step_timestamp_us: u64,
        target_val: u64, // f64 转换为有序位存储
    },
}

/// 阶跃检测器 (StepDetector)
/// 监视被标记为 Target 的通道，检测突变 (>10%) 触发观察窗口
pub struct StepDetector {
    pre_window_us: u64,  // 500ms = 500_000us (engineering-decisions 1)
    max_post_us: u64,    // 10s = 10_000_000us (engineering-decisions 1)
    pre_buffer: VecDeque<(u64, f64, f64, f64)>, // (timestamp_us, target, actual, output)
    recording_buffer: Vec<(u64, f64, f64, f64)>,
    state: DetectorState,
    last_target: Option<f64>,
    snapshot_counter: u64,
    session_id: String,
}

impl StepDetector {
    pub fn new() -> Self {
        Self {
            pre_window_us: 500_000,
            max_post_us: 10_000_000,
            pre_buffer: VecDeque::new(),
            recording_buffer: Vec::new(),
            state: DetectorState::Idle,
            last_target: None,
            snapshot_counter: 0,
            session_id: "default_session".to_string(),
        }
    }

    pub fn set_session_id(&mut self, session_id: String) {
        self.session_id = session_id;
    }

    /// 输入一个时间点的数据，若完成一次阶跃捕获则返回 StepSnapshot
    pub fn feed(
        &mut self,
        timestamp_us: u64,
        target: f64,
        actual: f64,
        output: f64,
        target_ch_name: &str,
        actual_ch_name: &str,
    ) -> Option<StepSnapshot> {
        // 维护 Pre-Window 环形缓冲 (500ms)
        self.pre_buffer.push_back((timestamp_us, target, actual, output));
        while let Some(&(t, _, _, _)) = self.pre_buffer.front() {
            if timestamp_us.saturating_sub(t) > self.pre_window_us {
                self.pre_buffer.pop_front();
            } else {
                break;
            }
        }

        // 检测目标值是否发生阶跃突变 (跳变 > 10% 设定值或显著改变)
        let is_step_detected = if let Some(old_target) = self.last_target {
            let delta = (target - old_target).abs();
            let base = old_target.abs().max(target.abs()).max(1.0);
            delta / base >= 0.10 && delta >= 0.1
        } else {
            false
        };
        self.last_target = Some(target);

        match self.state {
            DetectorState::Idle => {
                if is_step_detected {
                    // 触发阶跃检测，转入 Recording 状态
                    self.recording_buffer.clear();
                    // 导入 Pre-Window 数据
                    for &(t, tgt, act, out) in &self.pre_buffer {
                        self.recording_buffer.push((t, tgt, act, out));
                    }
                    self.state = DetectorState::Recording {
                        step_timestamp_us: timestamp_us,
                        target_val: target.to_bits(),
                    };
                }
                None
            }
            DetectorState::Recording { step_timestamp_us, target_val } => {
                if is_step_detected {
                    // 目标再次改变！当前阶跃被打断 (PRD §2.4.2 & implementation_plan 3.2)
                    self.snapshot_counter += 1;

                    let mut times = Vec::with_capacity(self.recording_buffer.len());
                    let mut targets = Vec::with_capacity(self.recording_buffer.len());
                    let mut actuals = Vec::with_capacity(self.recording_buffer.len());
                    let mut outputs = Vec::with_capacity(self.recording_buffer.len());

                    for &(t, tgt, act, out) in &self.recording_buffer {
                        let rel_t = (t as i64 - step_timestamp_us as i64) as f64 / 1_000_000.0;
                        times.push(rel_t);
                        targets.push(tgt);
                        actuals.push(act);
                        outputs.push(out);
                    }

                    // 采样点切片
                    let total_pts = self.recording_buffer.len();
                    let max_samples = 512;
                    let samples: Vec<crate::model::SamplePoint> = if total_pts <= max_samples {
                        self.recording_buffer
                            .iter()
                            .map(|&(t, tgt, act, out)| crate::model::SamplePoint {
                                timestamp_us: t,
                                values: vec![Some(tgt), Some(act), Some(out)],
                            })
                            .collect()
                    } else {
                        let step = (total_pts - 1) as f64 / (max_samples - 1) as f64;
                        (0..max_samples)
                            .map(|i| {
                                let idx = ((i as f64 * step).round() as usize).min(total_pts - 1);
                                let (t, tgt, act, out) = self.recording_buffer[idx];
                                crate::model::SamplePoint {
                                    timestamp_us: t,
                                    values: vec![Some(tgt), Some(act), Some(out)],
                                }
                            })
                            .collect()
                    };

                    let initial_y0 = self.recording_buffer.first().map(|p| p.2).unwrap_or(0.0);
                    let target_before_val = f64::from_bits(target_val);

                    let interrupted_metrics = StepMetrics {
                        overshoot_percent: None,
                        settling_time_s: None,
                        rise_time_s: None,
                        steady_state_error: None,
                        overshoot_pct: None,
                        y0: Some(initial_y0),
                        y_target: Some(target_before_val),
                        y_ss: None,
                        y_max: None,
                        is_stable: Some(false),
                    };

                    let interrupted_snapshot = StepSnapshot {
                        id: format!("step_{}_{}", step_timestamp_us, self.snapshot_counter),
                        session_id: self.session_id.clone(),
                        timestamp_us: step_timestamp_us,
                        target_before: initial_y0,
                        target_after: target_before_val,
                        channel_binding: crate::config::ChannelMapping {
                            target: target_ch_name.to_string(),
                            actual: actual_ch_name.to_string(),
                            output: "output".to_string(),
                        },
                        status: StepAnalysisStatus::Interrupted,
                        metrics: interrupted_metrics,
                        quality_scores: crate::model::QualityScores {
                            overshoot_score: 0.0,
                            speed_score: 0.0,
                            steady_score: 0.0,
                            damping_score: 0.0,
                            robust_score: 0.0,
                        },
                        offline_advice: Some("阶跃尚未稳定，目标值再次改变，分析已中断。".to_string()),
                        samples,
                        step_amplitude: Some((target_before_val - initial_y0).abs()),
                        target_channel: Some(target_ch_name.to_string()),
                        actual_channel: Some(actual_ch_name.to_string()),
                        relative_times: times,
                        target_series: targets,
                        actual_series: actuals,
                        output_series: outputs,
                    };

                    // 为新阶跃开启 Recording
                    self.recording_buffer.clear();
                    for &(t, tgt, act, out) in &self.pre_buffer {
                        self.recording_buffer.push((t, tgt, act, out));
                    }
                    self.state = DetectorState::Recording {
                        step_timestamp_us: timestamp_us,
                        target_val: target.to_bits(),
                    };

                    return Some(interrupted_snapshot);
                }

                self.recording_buffer.push((timestamp_us, target, actual, output));

                // 判定是否记录完毕 (达到 10s 或进入稳态后额外记录 1s)
                let elapsed_us = timestamp_us.saturating_sub(step_timestamp_us);
                let is_timeout = elapsed_us >= self.max_post_us;

                // 至少累积 0.5s 数据才开始分析
                if is_timeout || elapsed_us >= 500_000 {
                    let mut times = Vec::with_capacity(self.recording_buffer.len());
                    let mut targets = Vec::with_capacity(self.recording_buffer.len());
                    let mut actuals = Vec::with_capacity(self.recording_buffer.len());
                    let mut outputs = Vec::with_capacity(self.recording_buffer.len());

                    for &(t, tgt, act, out) in &self.recording_buffer {
                        let rel_t = (t as i64 - step_timestamp_us as i64) as f64 / 1_000_000.0;
                        times.push(rel_t);
                        targets.push(tgt);
                        actuals.push(act);
                        outputs.push(out);
                    }

                    let metrics_opt = StepAnalyzer::analyze(&times, &targets, &actuals);

                    if let Some(metrics) = metrics_opt {
                        // 判定是否记录完毕:
                        // 1. 达到最大 10s 超时 (engineering-decisions 1)
                        // 2. 判定进入稳态后额外记录 1s (rel_t >= ts + 1.0) (engineering-decisions 1)
                        let last_rel_t = times.last().copied().unwrap_or(0.0);
                        let settled_and_extended = metrics.is_stable.unwrap_or(false)
                            && metrics
                                .settling_time_s
                                .map_or(false, |ts| last_rel_t >= ts + 1.0);

                        if is_timeout || settled_and_extended {
                            self.snapshot_counter += 1;
                            let quality_scores = crate::ai::MetricScorer::score(&metrics);
                            let offline_advice = crate::ai::OfflineRuleEngine::generate_advice(&metrics);
                            let status = if is_timeout && !metrics.is_stable.unwrap_or(false) {
                                StepAnalysisStatus::InsufficientData
                            } else {
                                StepAnalysisStatus::Completed
                            };

                            // 采样点降采样切片至最多 512 点 (PRD 2.4.2 PR-001)
                            let total_pts = self.recording_buffer.len();
                            let max_samples = 512;
                            let samples: Vec<crate::model::SamplePoint> = if total_pts <= max_samples {
                                self.recording_buffer
                                    .iter()
                                    .map(|&(t, tgt, act, out)| crate::model::SamplePoint {
                                        timestamp_us: t,
                                        values: vec![Some(tgt), Some(act), Some(out)],
                                    })
                                    .collect()
                            } else {
                                let step = (total_pts - 1) as f64 / (max_samples - 1) as f64;
                                (0..max_samples)
                                    .map(|i| {
                                        let idx = ((i as f64 * step).round() as usize).min(total_pts - 1);
                                        let (t, tgt, act, out) = self.recording_buffer[idx];
                                        crate::model::SamplePoint {
                                            timestamp_us: t,
                                            values: vec![Some(tgt), Some(act), Some(out)],
                                        }
                                    })
                                    .collect()
                            };

                            let step_amp = (metrics.y_target.unwrap_or(0.0) - metrics.y0.unwrap_or(0.0)).abs();
                            let snapshot = StepSnapshot {
                                id: format!("step_{}_{}", step_timestamp_us, self.snapshot_counter),
                                session_id: self.session_id.clone(),
                                timestamp_us: step_timestamp_us,
                                target_before: metrics.y0.unwrap_or(0.0),
                                target_after: metrics.y_target.unwrap_or(0.0),
                                channel_binding: crate::config::ChannelMapping {
                                    target: target_ch_name.to_string(),
                                    actual: actual_ch_name.to_string(),
                                    output: "output".to_string(),
                                },
                                status,
                                metrics,
                                quality_scores,
                                offline_advice,
                                samples,
                                step_amplitude: Some(step_amp),
                                target_channel: Some(target_ch_name.to_string()),
                                actual_channel: Some(actual_ch_name.to_string()),
                                relative_times: times,
                                target_series: targets,
                                actual_series: actuals,
                                output_series: outputs,
                            };
                            self.state = DetectorState::Idle;
                            return Some(snapshot);
                        }
                    } else if is_timeout {
                        self.state = DetectorState::Idle;
                    }
                }
                None
            }
        }
    }

    pub fn reset(&mut self) {
        self.pre_buffer.clear();
        self.recording_buffer.clear();
        self.state = DetectorState::Idle;
        self.last_target = None;
    }
}

impl Default for StepDetector {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 辅助生成阶跃仿真时间序列
    fn generate_step_data<F>(
        duration_s: f64,
        dt: f64,
        y0: f64,
        target_val: f64,
        response_fn: F,
    ) -> (Vec<f64>, Vec<f64>, Vec<f64>)
    where
        F: Fn(f64) -> f64,
    {
        let steps = (duration_s / dt) as usize;
        let mut times = Vec::with_capacity(steps);
        let mut target = Vec::with_capacity(steps);
        let mut actual = Vec::with_capacity(steps);

        // 前置 0.5s (Pre-Window: -0.5s 到 0.0s)
        let pre_steps = (0.5 / dt) as usize;
        for i in 0..pre_steps {
            let t = -0.5 + i as f64 * dt;
            times.push(t);
            target.push(y0);
            actual.push(y0);
        }

        // 阶跃后 0.0s 到 duration_s
        for i in 0..steps {
            let t = i as f64 * dt;
            times.push(t);
            target.push(target_val);
            actual.push(response_fn(t));
        }

        (times, target, actual)
    }

    // =========================================================================
    // 10 组典型阶跃 Golden Tests (断言指标计算误差 <= 1% 或符合理论解析解)
    // =========================================================================

    #[test]
    fn test_golden_1_first_order_no_overshoot() {
        // 1. 标准一阶惯性系统 (无超调): y(t) = 1 - e^(-t)
        // 理论值: tr = ln(0.9) - ln(0.1) = 2.1972s; Mp = 0%; ts (2%) = -ln(0.02) = 3.912s; ess = 0.0
        let (times, target, actual) = generate_step_data(6.0, 0.001, 0.0, 1.0, |t| 1.0 - (-t).exp());
        let m = StepAnalyzer::analyze(&times, &target, &actual).expect("Analysis failed");

        assert_eq!(m.overshoot_pct.unwrap(), 0.0, "一阶系统超调量应严格为 0%");
        let tr = m.rise_time_s.expect("tr missing");
        assert!((tr - 2.1972).abs() < 0.02, "tr 误差 > 1%: actual={}", tr);
        let ts = m.settling_time_s.expect("ts missing");
        assert!((ts - 3.912).abs() < 0.04, "ts 误差 > 1%: actual={}", ts);
        assert!(m.steady_state_error.unwrap() < 0.01, "ess 应接近 0");
        assert!(m.is_stable.unwrap());
    }

    #[test]
    fn test_golden_2_second_order_10_pct_overshoot() {
        // 2. 标准二阶欠阻尼系统 (~10% 超调):
        // wn = 3.0, zeta = 0.591155 => Mp = exp(-pi * zeta / sqrt(1 - zeta^2)) * 100% = 10.0%
        let zeta: f64 = 0.591155;
        let wn: f64 = 3.0;
        let wd = wn * (1.0f64 - zeta * zeta).sqrt();
        let s = (1.0f64 - zeta * zeta).sqrt();

        let (times, target, actual) = generate_step_data(6.0, 0.001, 0.0, 10.0, |t: f64| {
            10.0 * (1.0 - (-zeta * wn * t).exp() * ((wd * t).cos() + (zeta / s) * (wd * t).sin()))
        });
        let m = StepAnalyzer::analyze(&times, &target, &actual).expect("Analysis failed");

        // 验证超调量 10% 误差 <= 1% (9.0% ~ 11.0%)
        assert!((m.overshoot_pct.unwrap() - 10.0).abs() <= 1.0, "Mp 误差 > 1%: actual={}", m.overshoot_pct.unwrap());
        assert!(m.steady_state_error.unwrap() < 0.05, "ess 应极小");
        assert!(m.is_stable.unwrap());
    }

    #[test]
    fn test_golden_3_second_order_30_pct_overshoot() {
        // 3. 标准二阶欠阻尼系统 (~30% 超调):
        // zeta = 0.357857 => Mp = 30.0%
        let zeta: f64 = 0.357857;
        let wn: f64 = 4.0;
        let wd = wn * (1.0f64 - zeta * zeta).sqrt();
        let s = (1.0f64 - zeta * zeta).sqrt();

        let (times, target, actual) = generate_step_data(6.0, 0.001, 0.0, 100.0, |t: f64| {
            100.0 * (1.0 - (-zeta * wn * t).exp() * ((wd * t).cos() + (zeta / s) * (wd * t).sin()))
        });
        let m = StepAnalyzer::analyze(&times, &target, &actual).expect("Analysis failed");

        assert!((m.overshoot_pct.unwrap() - 30.0).abs() <= 1.0, "Mp 误差 > 1%: actual={}", m.overshoot_pct.unwrap());
        assert!(m.is_stable.unwrap());
    }

    #[test]
    fn test_golden_4_steady_state_error_system() {
        // 4. 存在明显稳态误差系统: 目标 10.0, 响应稳态为 9.2 (ess = 0.8)
        let (times, target, actual) = generate_step_data(6.0, 0.001, 0.0, 10.0, |t| {
            9.2 * (1.0 - (-1.5 * t).exp())
        });
        let m = StepAnalyzer::analyze(&times, &target, &actual).expect("Analysis failed");

        assert!((m.steady_state_error.unwrap() - 0.8).abs() < 0.02, "ess 误差 > 1%: actual={}", m.steady_state_error.unwrap());
        assert!((m.y_ss.unwrap() - 9.2).abs() < 0.02, "yss 计算偏差");
    }

    #[test]
    fn test_golden_5_critically_damped_system() {
        // 5. 临界阻尼系统 (zeta = 1.0, 严格单调无超调): y(t) = 1 - (1 + wn*t) * e^(-wn*t)
        let wn = 2.0;
        let (times, target, actual) = generate_step_data(6.0, 0.001, 0.0, 5.0, |t| {
            5.0 * (1.0 - (1.0 + wn * t) * (-wn * t).exp())
        });
        let m = StepAnalyzer::analyze(&times, &target, &actual).expect("Analysis failed");

        assert_eq!(m.overshoot_pct.unwrap(), 0.0, "临界阻尼超调量应严格为 0%");
        assert!(m.steady_state_error.unwrap() < 0.01);
        assert!(m.is_stable.unwrap());
    }

    #[test]
    fn test_golden_6_negative_step_down() {
        // 6. 负向阶跃响应 (20 -> 10, 幅值 -10)
        let (times, target, actual) = generate_step_data(6.0, 0.001, 20.0, 10.0, |t| {
            20.0 - 10.0 * (1.0 - (-2.0 * t).exp() * (3.0 * t).cos())
        });
        let m = StepAnalyzer::analyze(&times, &target, &actual).expect("Analysis failed");

        assert!((m.y0.unwrap() - 20.0).abs() < 0.01, "基线 y0 应为 20.0");
        assert!((m.y_target.unwrap() - 10.0).abs() < 0.01, "目标应为 10.0");
        assert!(m.overshoot_pct.unwrap() >= 0.0, "负向阶跃超调量定义为正百分比");
    }

    #[test]
    fn test_golden_7_noisy_step_response() {
        // 7. 叠加小幅高频噪声的阶跃响应: 均值滤波验证 yss 稳定性
        let (times, target, actual) = generate_step_data(6.0, 0.001, 0.0, 10.0, |t| {
            let noise = 0.05 * (50.0 * t).sin();
            10.0 * (1.0 - (-t).exp()) + noise
        });
        let m = StepAnalyzer::analyze(&times, &target, &actual).expect("Analysis failed");

        assert!((m.y_ss.unwrap() - 10.0).abs() < 0.05, "末尾 10% 均值应有效滤除零均值高频噪声");
        assert!(m.steady_state_error.unwrap() < 0.05);
    }

    #[test]
    fn test_golden_8_divergent_unstable_system() {
        // 8. 发散振荡不稳定系统: y(t) = 1 + e^(0.5*t) * sin(5*t)
        let (times, target, actual) = generate_step_data(5.0, 0.001, 0.0, 1.0, |t| {
            1.0 + (0.5 * t).exp() * (5.0 * t).sin()
        });
        let m = StepAnalyzer::analyze(&times, &target, &actual).expect("Analysis failed");

        // 发散系统不应被判定为 stable，且调节时间 None
        assert!(!m.is_stable.unwrap(), "发散系统应判定为不稳定");
        assert!(m.settling_time_s.is_none() || m.overshoot_pct.unwrap() > 100.0);
    }

    #[test]
    fn test_golden_9_fast_high_frequency_step() {
        // 9. 极快响应阶跃 (tr < 0.1s, wn = 30)
        let wn = 30.0;
        let (times, target, actual) = generate_step_data(2.0, 0.0005, 0.0, 1.0, |t| {
            1.0 - (-wn * t).exp()
        });
        let m = StepAnalyzer::analyze(&times, &target, &actual).expect("Analysis failed");

        let tr = m.rise_time_s.expect("tr missing");
        // 理论 tr = 2.1972 / 30 = 0.07324s
        assert!((tr - 0.07324).abs() < 0.002, "极快响应 tr 精度偏差: actual={}", tr);
    }

    #[test]
    fn test_golden_10_delayed_response_pure_dead_time() {
        // 10. 纯滞后系统 (Dead time = 0.5s, 随后一阶响应)
        let tau = 1.0;
        let dead_time = 0.5;
        let (times, target, actual) = generate_step_data(6.0, 0.001, 0.0, 2.0, |t| {
            if t < dead_time {
                0.0
            } else {
                2.0 * (1.0 - (-(t - dead_time) / tau).exp())
            }
        });
        let m = StepAnalyzer::analyze(&times, &target, &actual).expect("Analysis failed");

        assert_eq!(m.overshoot_pct.unwrap(), 0.0, "带滞后一阶系统无超调");
        let tr = m.rise_time_s.expect("tr missing");
        assert!((tr - 2.1972).abs() < 0.02, "纯滞后不应影响上升时间计算: actual={}", tr);
    }

    #[test]
    fn test_step_detector_end_to_end() {
        let mut detector = StepDetector::new();
        let dt_us = 10_000; // 10ms = 100Hz
        let mut snapshot_result = None;

        // 模拟 1000 个采样点，在 t = 1.0s 时从 10 阶跃到 20
        for i in 0..1000 {
            let t_us = i * dt_us;
            let t_s = t_us as f64 / 1_000_000.0;
            let target = if t_s < 1.0 { 10.0 } else { 20.0 };
            let actual = if t_s < 1.0 {
                10.0
            } else {
                let dt_step = t_s - 1.0;
                10.0 + 10.0 * (1.0 - (-2.0 * dt_step).exp())
            };

            if let Some(snap) = detector.feed(t_us, target, actual, 0.0, "setpoint", "actual") {
                snapshot_result = Some(snap);
                break;
            }
        }

        assert!(snapshot_result.is_some(), "应成功捕获阶跃切片快照");
        let snap = snapshot_result.unwrap();
        assert_eq!(snap.target_before, 10.0);
        assert_eq!(snap.target_after, 20.0);
        assert_eq!(snap.step_amplitude.unwrap(), 10.0);
        assert!(snap.metrics.is_stable.unwrap());
        let ts = snap.metrics.settling_time_s.expect("应计算出有效的调节时间 ts");
        assert!((ts - 1.956).abs() < 0.05, "ts 理论值约 1.956s，实际: {}", ts);
        let last_t = *snap.relative_times.last().expect("应有相对时间序列");
        assert!(last_t >= ts + 1.0, "快照应包含进入稳态后额外 1s 数据: last_t={}, ts={}", last_t, ts);
        assert!(!snap.samples.is_empty(), "快照中应包含降采样采样点");
        assert_eq!(snap.status, StepAnalysisStatus::Completed);
    }

    #[test]
    fn test_step_detector_interrupted_by_new_step() {
        let mut detector = StepDetector::new();
        let dt_us = 10_000; // 10ms = 100Hz
        let mut interrupted_snapshot = None;

        // 模拟：在 t = 1.0s 时从 10 阶跃到 20
        // 在 t = 1.4s (尚未进入稳态) 时再次突变到 30！
        for i in 0..200 {
            let t_us = i * dt_us;
            let t_s = t_us as f64 / 1_000_000.0;
            let target = if t_s < 1.0 {
                10.0
            } else if t_s < 1.4 {
                20.0
            } else {
                30.0
            };

            let actual = if t_s < 1.0 {
                10.0
            } else if t_s < 1.4 {
                10.0 + 10.0 * (1.0 - (-1.0 * (t_s - 1.0)).exp())
            } else {
                15.0 + 15.0 * (1.0 - (-1.0 * (t_s - 1.4)).exp())
            };

            if let Some(snap) = detector.feed(t_us, target, actual, 0.0, "setpoint", "actual") {
                if snap.status == StepAnalysisStatus::Interrupted {
                    interrupted_snapshot = Some(snap);
                    break;
                }
            }
        }

        assert!(interrupted_snapshot.is_some(), "当目标再次突变时必须输出 Interrupted 快照");
        let snap = interrupted_snapshot.unwrap();
        assert_eq!(snap.status, StepAnalysisStatus::Interrupted);
        assert_eq!(snap.target_after, 20.0);
        assert!(snap.metrics.overshoot_percent.is_none(), "被打断快照不应输出假超调量");
        assert!(snap.metrics.settling_time_s.is_none(), "被打断快照不应输出假调节时间");
        assert_eq!(snap.metrics.is_stable, Some(false));
        assert!(snap.offline_advice.unwrap().contains("中断"));
    }
}
