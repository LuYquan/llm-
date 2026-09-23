pub use crate::model::QualityScores as RadarMetrics;
use crate::model::StepMetrics;

/// 控制品质统一评分算法引擎 (engineering-decisions 4)
pub struct MetricScorer;

impl MetricScorer {
    pub fn score(metrics: &StepMetrics) -> RadarMetrics {
        let overshoot = metrics.overshoot_percent.or(metrics.overshoot_pct).unwrap_or(0.0);
        let ess = metrics.steady_state_error.unwrap_or(0.0);
        let is_stable = metrics.is_stable.unwrap_or(true);

        // 1. 超调得分 (Mp <= 5% -> 100分; Mp >= 50% -> 0分 线性衰减)
        let overshoot_score = if overshoot <= 5.0 {
            100.0
        } else if overshoot >= 50.0 {
            0.0
        } else {
            100.0 - ((overshoot - 5.0) / 45.0) * 100.0
        };

        // 2. 速度得分 (根据上升时间 tr 评定)
        let speed_score = match metrics.rise_time_s {
            Some(tr) => {
                if tr <= 0.3 {
                    100.0
                } else if tr >= 3.0 {
                    20.0
                } else {
                    100.0 - ((tr - 0.3) / 2.7) * 80.0
                }
            }
            None => 10.0,
        };

        // 3. 稳态得分 (根据稳态误差 ess 评定)
        let steady_score = if ess <= 0.01 {
            100.0
        } else if ess >= 1.0 {
            0.0
        } else {
            100.0 - ((ess - 0.01) / 0.99) * 100.0
        };

        // 4. 阻尼得分 (无超调或最佳欠阻尼比 ζ≈0.7 时接近 100)
        let damping_score = if !is_stable {
            10.0
        } else if overshoot <= 8.0 {
            95.0 + (8.0 - overshoot) * 0.625
        } else if overshoot >= 40.0 {
            15.0
        } else {
            95.0 - ((overshoot - 8.0) / 32.0) * 80.0
        };

        // 5. 鲁棒得分 (结合收敛稳定性与调节时间综合评定)
        let robust_score = if !is_stable {
            15.0
        } else {
            let base = 85.0;
            let ts_penalty = match metrics.settling_time_s {
                Some(ts) => (ts * 5.0).min(25.0),
                None => 30.0,
            };
            let ess_bonus = if ess < 0.02 { 15.0 } else { 0.0 };
            (base - ts_penalty + ess_bonus).clamp(10.0, 100.0)
        };

        RadarMetrics {
            overshoot_score: (overshoot_score * 10.0).round() / 10.0,
            speed_score: (speed_score * 10.0).round() / 10.0,
            steady_score: (steady_score * 10.0).round() / 10.0,
            damping_score: (damping_score * 10.0).round() / 10.0,
            robust_score: (robust_score * 10.0).round() / 10.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scorer_optimal_metrics() {
        let m = StepMetrics {
            rise_time_s: Some(0.25),
            overshoot_pct: Some(3.5),
            overshoot_percent: Some(3.5),
            settling_time_s: Some(0.8),
            steady_state_error: Some(0.005),
            y0: Some(0.0),
            y_target: Some(10.0),
            y_ss: Some(10.0),
            y_max: Some(10.35),
            is_stable: Some(true),
        };
        let scores = MetricScorer::score(&m);
        assert_eq!(scores.overshoot_score, 100.0);
        assert_eq!(scores.speed_score, 100.0);
        assert_eq!(scores.steady_score, 100.0);
        assert!(scores.damping_score >= 90.0);
        assert!(scores.robust_score >= 90.0);
    }

    #[test]
    fn test_scorer_high_overshoot_metrics() {
        let m = StepMetrics {
            rise_time_s: Some(0.5),
            overshoot_pct: Some(45.0),
            overshoot_percent: Some(45.0),
            settling_time_s: Some(3.0),
            steady_state_error: Some(0.2),
            y0: Some(0.0),
            y_target: Some(10.0),
            y_ss: Some(9.8),
            y_max: Some(14.5),
            is_stable: Some(true),
        };
        let scores = MetricScorer::score(&m);
        assert!(scores.overshoot_score < 20.0, "高超调得分应极低");
        assert!(scores.damping_score < 25.0, "高振荡阻尼得分应极低");
    }

    #[test]
    fn test_scorer_unstable_metrics() {
        let m = StepMetrics {
            rise_time_s: None,
            overshoot_pct: Some(80.0),
            overshoot_percent: Some(80.0),
            settling_time_s: None,
            steady_state_error: Some(2.5),
            y0: Some(0.0),
            y_target: Some(10.0),
            y_ss: Some(12.5),
            y_max: Some(18.0),
            is_stable: Some(false),
        };
        let scores = MetricScorer::score(&m);
        assert_eq!(scores.overshoot_score, 0.0);
        assert_eq!(scores.damping_score, 10.0);
        assert!(scores.robust_score <= 15.0);
    }
}
