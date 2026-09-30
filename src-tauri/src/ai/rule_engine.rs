pub use crate::model::PidParams;
use crate::model::StepMetrics;
use serde::{Deserialize, Serialize};

/// 统一结构化 AI 诊断建议输出 (PRD 5.2)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AiDiagnosisResult {
    /// 诊断来源 ("offline_rules" | "deepseek" | "openai" | "ollama")
    pub provider: String,
    /// 诊断结论
    pub diagnosis: String,
    /// 推荐的新 PID 参数
    pub recommendation: PidParams,
    /// 调整依据与控制工程学原理
    pub rationale: String,
    /// 风险预警
    pub risk_warning: String,
}

/// 内置离线控制理论规则引擎 (M5 Step 5.3)
/// 在无网络或未配 API Key 时自动生效，基于控制工程理论给出确定性调参建议
pub struct OfflineRuleEngine;

impl OfflineRuleEngine {
    /// 生成单句离线简明建议 (PRD 2.4.2 & engineering-decisions 6)
    pub fn generate_advice(metrics: &StepMetrics) -> Option<String> {
        let is_stable = metrics.is_stable?;
        let mp = metrics.overshoot_percent.or(metrics.overshoot_pct)?;
        let ess = metrics.steady_state_error?;
        if !mp.is_finite() || !ess.is_finite() {
            return None;
        }

        if !is_stable {
            Some(
                "系统发散振荡，处于失稳状态。建议大幅降低 Kp 与 Ki，增大 Kd 提供阻尼。".to_string(),
            )
        } else if mp > 20.0 {
            Some(format!(
                "超调量达 {:.1}% 偏高。建议下调 Kp，增大 Kd 提高阻尼。",
                mp
            ))
        } else if ess > 0.05 {
            Some(format!(
                "存在稳态静差 (ess = {:.3})。建议适度增大积分增益 Ki 消除偏差。",
                ess
            ))
        } else if metrics.rise_time_s.map_or(false, |tr| tr > 1.5) && mp <= 5.0 {
            Some("响应较迟缓（过阻尼）。建议适当增大比例增益 Kp 加快响应。".to_string())
        } else {
            Some("控制品质良好，动态与稳态指标均在推荐范围内。".to_string())
        }
    }

    pub fn diagnose(
        current: PidParams,
        metrics: &StepMetrics,
    ) -> Result<AiDiagnosisResult, String> {
        let is_stable = metrics
            .is_stable
            .ok_or_else(|| "稳定性未计算，拒绝生成 PID 候选".to_string())?;
        let mp = metrics
            .overshoot_percent
            .or(metrics.overshoot_pct)
            .ok_or_else(|| "缺少有效超调量，拒绝生成 PID 候选".to_string())?;
        let ess = metrics
            .steady_state_error
            .ok_or_else(|| "缺少稳态误差，拒绝生成 PID 候选".to_string())?;
        if !mp.is_finite() || !ess.is_finite() {
            return Err("分析指标包含非有限数值，拒绝生成 PID 候选".to_string());
        }
        let mut new_kp = current.kp;
        let mut new_ki = current.ki;
        let mut new_kd = current.kd;

        let diagnosis: String;
        let rationale: String;
        let risk_warning: String;

        if !is_stable {
            // 1. 系统失稳 / 发散振荡
            new_kp = (current.kp * 0.60).max(0.01);
            new_ki = (current.ki * 0.50).max(0.0);
            new_kd = (current.kd * 1.30).max(0.01);

            diagnosis = "系统发散振荡，处于失稳状态。比例增益过高或相位裕度严重不足。".to_string();
            rationale = "失稳时应优先压制开环增益，大幅削减 Kp 与 Ki 以阻止能量积累，同时增大 Kd 提供阻尼。".to_string();
            risk_warning =
                "高风险：禁止继续增大增益！下发前请务必确认电机或执行机构未卡死。".to_string();
        } else if mp > 20.0 {
            // 2. 超调过大 (Mp > 20%)
            new_kp = (current.kp * 0.80).max(0.01);
            new_kd = (current.kd * 1.35).max(0.01);
            if ess <= 0.05 {
                new_ki = (current.ki * 0.90).max(0.0);
            }

            diagnosis = format!(
                "系统超调量达 {:.1}% (远高于 10% 推荐上限)，阻尼比偏低，动态振荡剧烈。",
                mp
            );
            rationale = "下调比例增益 Kp 降低阶跃响应初段加速度，增大微分增益 Kd 引入超前相位阻尼，可显著削平超调峰值。".to_string();
            risk_warning =
                "注意：若微分增益 Kd 调整过大，可能引入高频测量噪声，需观察输出控制量是否平滑。"
                    .to_string();
        } else if mp > 5.0 && ess > 0.05 {
            // 3. 伴随轻度超调与明显稳态误差
            new_ki = (current.ki * 1.30).max(0.01);
            new_kd = (current.kd * 1.15).max(0.01);

            diagnosis = format!(
                "系统存在稳态静差 (ess = {:.3})，且伴有轻微超调 ({:.1}%)。",
                ess, mp
            );
            rationale =
                "增大积分增益 Ki 以消除终值偏差，同步微调 Kd 维持阻尼，避免积分增强引起额外超调。"
                    .to_string();
            risk_warning = "积分增大后注意防范积分饱和现象。".to_string();
        } else if ess > 0.05 {
            // 4. 单纯稳态静差过大
            new_ki = (current.ki * 1.35).max(0.01);

            diagnosis = format!(
                "系统响应平稳但存在稳态静差 (ess = {:.3})，静态定位精度不足。",
                ess
            );
            rationale =
                "增大积分增益 Ki 加快低频误差累积，迫使被控量完全逼近目标设定值。".to_string();
            risk_warning =
                "轻微风险：积分动作生效有滞后性，请观察调节时间是否符合预期。".to_string();
        } else if metrics.rise_time_s.map_or(false, |tr| tr > 1.5) && mp <= 5.0 {
            // 5. 响应迟缓 / 过阻尼
            new_kp = (current.kp * 1.25).max(0.01);
            new_ki = (current.ki * 1.10).max(0.0);

            diagnosis = format!(
                "系统处于过阻尼状态，上升时间较长 (tr = {:.2}s)，动态响应迟钝。",
                metrics.rise_time_s.unwrap_or(0.0)
            );
            rationale = "适度提高比例增益 Kp，加快动态过渡响应速度，在无超调前提下压缩调节时间。"
                .to_string();
            risk_warning =
                "提升 Kp 会压缩相位裕度，注意观察下一次阶跃是否出现意外振荡。".to_string();
        } else {
            // 6. 控制品质优良
            diagnosis =
                "系统控制品质优良！超调量、上升时间及稳态误差均在理想控制范围内。".to_string();
            rationale = "当前参数已达到良好的阻尼比与稳态精度，推荐维持当前参数。".to_string();
            risk_warning = "无需调整，当前参数稳定可靠。".to_string();
        }

        // 保留两位小数
        let recommendation = PidParams {
            kp: (new_kp * 100.0).round() / 100.0,
            ki: (new_ki * 100.0).round() / 100.0,
            kd: (new_kd * 100.0).round() / 100.0,
        };

        Ok(AiDiagnosisResult {
            provider: "offline_rules".to_string(),
            diagnosis,
            recommendation,
            rationale,
            risk_warning,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_metrics(overshoot: f64, ess: f64, tr: Option<f64>, stable: bool) -> StepMetrics {
        StepMetrics {
            rise_time_s: tr,
            overshoot_pct: Some(overshoot),
            overshoot_percent: Some(overshoot),
            settling_time_s: Some(1.0),
            steady_state_error: Some(ess),
            y0: Some(0.0),
            y_target: Some(10.0),
            y_ss: Some(10.0 - ess),
            y_max: Some(10.0 * (1.0 + overshoot / 100.0)),
            is_stable: Some(stable),
        }
    }

    #[test]
    fn test_rule_engine_divergent_response() {
        let current = PidParams {
            kp: 5.0,
            ki: 2.0,
            kd: 0.1,
        };
        let m = dummy_metrics(120.0, 0.0, None, false);
        let res = OfflineRuleEngine::diagnose(current, &m).unwrap();

        assert_eq!(res.provider, "offline_rules");
        assert!(res.recommendation.kp < current.kp, "失稳时应降低 Kp");
        assert!(res.recommendation.ki < current.ki, "失稳时应降低 Ki");
        assert!(res.recommendation.kd > current.kd, "失稳时应增大 Kd");
        assert!(res.risk_warning.contains("高风险"));
    }

    #[test]
    fn test_rule_engine_high_overshoot() {
        let current = PidParams {
            kp: 2.0,
            ki: 0.5,
            kd: 0.2,
        };
        let m = dummy_metrics(35.0, 0.01, Some(0.3), true);
        let res = OfflineRuleEngine::diagnose(current, &m).unwrap();

        assert!(res.recommendation.kp < current.kp, "高超调时应降低 Kp");
        assert!(res.recommendation.kd > current.kd, "高超调时应增大 Kd");
    }

    #[test]
    fn test_rule_engine_steady_state_error() {
        let current = PidParams {
            kp: 1.5,
            ki: 0.1,
            kd: 0.2,
        };
        let m = dummy_metrics(2.0, 0.50, Some(0.5), true);
        let res = OfflineRuleEngine::diagnose(current, &m).unwrap();

        assert!(res.recommendation.ki > current.ki, "有稳态静差时应增大 Ki");
    }

    #[test]
    fn test_rule_engine_sluggish_response() {
        let current = PidParams {
            kp: 0.5,
            ki: 0.1,
            kd: 0.2,
        };
        let m = dummy_metrics(0.0, 0.01, Some(3.5), true);
        let res = OfflineRuleEngine::diagnose(current, &m).unwrap();

        assert!(res.recommendation.kp > current.kp, "迟缓响应时应增大 Kp");
    }

    #[test]
    fn test_rule_engine_nominal_good() {
        let current = PidParams {
            kp: 1.8,
            ki: 0.6,
            kd: 0.25,
        };
        let m = dummy_metrics(3.0, 0.01, Some(0.4), true);
        let res = OfflineRuleEngine::diagnose(current, &m).unwrap();

        assert_eq!(res.recommendation, current, "良好状态下应维持参数");
        assert!(res.diagnosis.contains("控制品质优良"));
    }

    #[test]
    fn test_generate_advice() {
        let m1 = dummy_metrics(30.0, 0.01, Some(0.3), true);
        let advice1 = OfflineRuleEngine::generate_advice(&m1).unwrap();
        assert!(advice1.contains("超调量"));

        let m2 = dummy_metrics(3.0, 0.2, Some(0.3), true);
        let advice2 = OfflineRuleEngine::generate_advice(&m2).unwrap();
        assert!(advice2.contains("稳态静差"));
    }

    #[test]
    fn missing_stability_evidence_does_not_generate_advice_or_pid_candidate() {
        let mut metrics = dummy_metrics(3.0, 0.01, Some(0.4), true);
        metrics.is_stable = None;
        assert!(OfflineRuleEngine::generate_advice(&metrics).is_none());
        let result = OfflineRuleEngine::diagnose(
            PidParams {
                kp: 1.0,
                ki: 0.1,
                kd: 0.01,
            },
            &metrics,
        );
        assert_eq!(result.unwrap_err(), "稳定性未计算，拒绝生成 PID 候选");
    }
}
