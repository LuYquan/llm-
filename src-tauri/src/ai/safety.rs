use crate::ai::rule_engine::PidParams;

/// 双重安全防线 (SafetyGuard - PRD 6.1 & engineering-decisions 3)
/// 拦截非法数值、正负号颠倒反转及超出极值的危险参数
pub struct SafetyGuard;

impl SafetyGuard {
    /// 严格校验新参数是否合法。通过则返回下发指令字符串，不通过则返回拦截原因
    pub fn validate_and_format_command(old: PidParams, new: PidParams) -> Result<String, String> {
        // 1. 非法数值硬拦截 (NaN, Infinity)
        if new.kp.is_nan() || new.kp.is_infinite() {
            return Err("【安全拦截】Kp 包含非法数值 (NaN / Inf)".to_string());
        }
        if new.ki.is_nan() || new.ki.is_infinite() {
            return Err("【安全拦截】Ki 包含非法数值 (NaN / Inf)".to_string());
        }
        if new.kd.is_nan() || new.kd.is_infinite() {
            return Err("【安全拦截】Kd 包含非法数值 (NaN / Inf)".to_string());
        }

        // 2. 符号反转硬拦截 (防止引入正反馈导致电机飞车发散)
        if old.kp > 0.0 && new.kp <= 0.0 {
            return Err("【安全拦截】Kp 符号发生反转或归零，严禁由正变负（防止正反馈发散）".to_string());
        }
        if old.kp < 0.0 && new.kp >= 0.0 {
            return Err("【安全拦截】Kp 符号发生反转，严禁由负变正".to_string());
        }

        if old.ki > 0.0 && new.ki < 0.0 {
            return Err("【安全拦截】Ki 符号发生反转（正变负）".to_string());
        }
        if old.ki < 0.0 && new.ki > 0.0 {
            return Err("【安全拦截】Ki 符号发生反转（负变正）".to_string());
        }

        if old.kd > 0.0 && new.kd < 0.0 {
            return Err("【安全拦截】Kd 符号发生反转（正变负）".to_string());
        }
        if old.kd < 0.0 && new.kd > 0.0 {
            return Err("【安全拦截】Kd 符号发生反转（负变正）".to_string());
        }

        // 3. 幅值极值保护 (默认 0.0 ~ 1000.0)
        let max_limit = 1000.0;
        if new.kp.abs() > max_limit {
            return Err(format!("【安全拦截】Kp 幅值超出保护极值 ({:.1} > {:.1})", new.kp.abs(), max_limit));
        }
        if new.ki.abs() > max_limit {
            return Err(format!("【安全拦截】Ki 幅值超出保护极值 ({:.1} > {:.1})", new.ki.abs(), max_limit));
        }
        if new.kd.abs() > max_limit {
            return Err(format!("【安全拦截】Kd 幅值超出保护极值 ({:.1} > {:.1})", new.kd.abs(), max_limit));
        }

        // 4. 格式化标准下发指令 (PRD 6.2)
        Ok(format!("SET:KP={:.3},KI={:.3},KD={:.3}\n", new.kp, new.ki, new.kd))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_safety_guard_valid_pid() {
        let old = PidParams { kp: 1.8, ki: 0.6, kd: 0.25 };
        let new = PidParams { kp: 2.0, ki: 0.7, kd: 0.3 };
        let res = SafetyGuard::validate_and_format_command(old, new);
        assert!(res.is_ok());
        assert_eq!(res.unwrap(), "SET:KP=2.000,KI=0.700,KD=0.300\n");
    }

    #[test]
    fn test_safety_guard_nan_and_inf_interception() {
        let old = PidParams { kp: 1.8, ki: 0.6, kd: 0.25 };
        let new_nan = PidParams { kp: f64::NAN, ki: 0.6, kd: 0.25 };
        assert!(SafetyGuard::validate_and_format_command(old, new_nan).is_err());

        let new_inf = PidParams { kp: 1.8, ki: f64::INFINITY, kd: 0.25 };
        assert!(SafetyGuard::validate_and_format_command(old, new_inf).is_err());
    }

    #[test]
    fn test_safety_guard_sign_reversal_interception() {
        let old = PidParams { kp: 1.8, ki: 0.6, kd: 0.25 };
        let new_neg_kp = PidParams { kp: -1.0, ki: 0.6, kd: 0.25 };
        let err = SafetyGuard::validate_and_format_command(old, new_neg_kp).unwrap_err();
        assert!(err.contains("符号发生反转"));

        let new_neg_ki = PidParams { kp: 1.8, ki: -0.5, kd: 0.25 };
        assert!(SafetyGuard::validate_and_format_command(old, new_neg_ki).is_err());
    }

    #[test]
    fn test_safety_guard_extreme_limit_interception() {
        let old = PidParams { kp: 1.8, ki: 0.6, kd: 0.25 };
        let new_extreme = PidParams { kp: 1500.0, ki: 0.6, kd: 0.25 };
        let err = SafetyGuard::validate_and_format_command(old, new_extreme).unwrap_err();
        assert!(err.contains("幅值超出保护极值"));
    }
}
