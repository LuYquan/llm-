use crate::model::{
    SerialFlowControl, SerialParity, SerialSettings, WriteRequest, WriteResultEvent, WriteStatus,
};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// 统一底层硬件 I/O 抽象 trait (PRD 4.1)
pub trait DataSource: Send + 'static {
    /// 异步读取一个未解码、未裁剪的原始字节块。
    fn read_chunk(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Option<Vec<u8>>, String>> + Send + '_>>;

    /// 向底层数据源发送字节流 (Step 4.1 & 7.1)
    fn write_bytes(&mut self, _request: WriteRequest) -> Result<(), String> {
        Err("当前数据源不支持串口写入".into())
    }

    /// 向底层数据源发送最高优先级急停字节流 (PR-001 W2 & W7)
    fn write_emergency_bytes(&mut self, _request: WriteRequest) -> Result<(), String> {
        Err("当前数据源不支持串口停止命令写入".into())
    }

    /// 是否处于连接/激活状态
    fn is_connected(&self) -> bool;

    /// 重置数据源内部状态
    fn reset(&mut self);

    /// 主动停止数据源并释放底层句柄与资源
    fn stop(&mut self) {}
}

struct SerialWriteQueue {
    emergency: VecDeque<WriteRequest>,
    normal: VecDeque<WriteRequest>,
}

enum SerialWriteTask {
    Emergency(WriteRequest),
    Normal(WriteRequest),
}

fn write_all_and_flush<W: std::io::Write>(
    writer: &mut W,
    bytes: &[u8],
) -> (std::io::Result<()>, usize) {
    let mut written = 0usize;
    let result = (|| -> std::io::Result<()> {
        while written < bytes.len() {
            match writer.write(&bytes[written..])? {
                0 => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::WriteZero,
                        "串口写入返回 0 字节",
                    ))
                }
                count => written += count,
            }
        }
        writer.flush()
    })();
    (result, written)
}

/// 物理串口数据源 (Step 2.3 & 2.4)
pub struct SerialDataSource {
    port_name: String,
    baud_rate: u32,
    is_connected: Arc<AtomicBool>,
    is_running: Arc<AtomicBool>,
    raw_rx: tokio::sync::mpsc::Receiver<Result<Vec<u8>, String>>,
    queue: Arc<(std::sync::Mutex<SerialWriteQueue>, std::sync::Condvar)>,
    result_app: AppHandle,
}

/// 文本协议解码器：只用于解析副本；调用方必须在此之前保留原始块。
pub fn process_serial_bytes(
    read_bytes: &[u8],
    line_buf: &mut Vec<u8>,
    dirty_counter: &AtomicU64,
) -> Vec<String> {
    line_buf.extend_from_slice(read_bytes);
    let mut lines = Vec::new();

    // 提取以 \n 结尾的每一行
    while let Some(pos) = line_buf.iter().position(|&b| b == b'\n') {
        if pos + 1 > 65_536 {
            line_buf.drain(..=pos);
            dirty_counter.fetch_add(1, Ordering::Relaxed);
            continue;
        }
        let line_bytes: Vec<u8> = line_buf.drain(..=pos).collect();
        match std::str::from_utf8(&line_bytes) {
            Ok(s) => {
                let trimmed = s.trim_end_matches(['\r', '\n']);
                if !trimmed.is_empty() {
                    lines.push(trimmed.to_string());
                }
            }
            Err(_) => {
                // 遇到乱码或非 UTF-8 字符时，静默丢弃单行，累计错误计数，不影响后续数据 (Step 7.3)
                dirty_counter.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    // 文本解析器最多保留 64 KiB 未完成行。调用方持有的原始块不会被裁剪。
    if line_buf.len() > 65_536 {
        dirty_counter.fetch_add(1, Ordering::Relaxed);
        line_buf.clear();
    }

    lines
}

impl SerialDataSource {
    pub fn open(
        port_name: &str,
        baud_rate: u32,
        settings: SerialSettings,
        app: AppHandle,
    ) -> Result<Self, String> {
        settings.validate()?;
        let normalized = crate::serial::normalize_port_name(port_name);
        let data_bits = match settings.data_bits {
            7 => serialport::DataBits::Seven,
            8 => serialport::DataBits::Eight,
            _ => unreachable!("SerialSettings::validate checks data bits"),
        };
        let parity = match settings.parity {
            SerialParity::None => serialport::Parity::None,
            SerialParity::Even => serialport::Parity::Even,
            SerialParity::Odd => serialport::Parity::Odd,
        };
        let stop_bits = match settings.stop_bits {
            1 => serialport::StopBits::One,
            2 => serialport::StopBits::Two,
            _ => unreachable!("SerialSettings::validate checks stop bits"),
        };
        let flow_control = match settings.flow_control {
            SerialFlowControl::None => serialport::FlowControl::None,
            SerialFlowControl::Hardware => serialport::FlowControl::Hardware,
        };
        let port = serialport::new(&normalized, baud_rate)
            .data_bits(data_bits)
            .parity(parity)
            .stop_bits(stop_bits)
            .flow_control(flow_control)
            .timeout(Duration::from_millis(50))
            .open()
            .map_err(|e| {
                let err_str = e.to_string();
                if err_str.contains("Access is denied") || err_str.contains("os error 5") {
                    format!(
                        "无法打开串口 [{}]: 端口已被其他程序占用 (Access is denied)",
                        port_name
                    )
                } else if err_str.contains("The system cannot find the file specified")
                    || err_str.contains("os error 2")
                {
                    format!(
                        "无法打开串口 [{}]: 端口未找到或设备已拔出 (Device not found)",
                        port_name
                    )
                } else {
                    format!("无法打开串口 [{}]: {}", port_name, e)
                }
            })?;

        let mut write_port = port
            .try_clone()
            .map_err(|e| format!("克隆串口写入句柄失败: {}", e))?;
        let queue = Arc::new((
            std::sync::Mutex::new(SerialWriteQueue {
                emergency: VecDeque::new(),
                normal: VecDeque::new(),
            }),
            std::sync::Condvar::new(),
        ));

        let (raw_tx, raw_rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, String>>(1000);
        let is_running = Arc::new(AtomicBool::new(true));
        let is_connected = Arc::new(AtomicBool::new(true));
        let port_name_cloned = port_name.to_string();
        let is_running_thread = is_running.clone();
        let is_connected_thread = is_connected.clone();
        let app_thread = app.clone();

        // 启动后台写入线程 (高优先级急停队列优先弹出)
        let is_running_write = is_running.clone();
        let port_name_write = port_name.to_string();
        let queue_write = queue.clone();
        let app_write = app.clone();

        std::thread::Builder::new()
            .name(format!("serial-writer-{}", port_name))
            .spawn(move || {
                let (lock, cvar) = &*queue_write;
                while is_running_write.load(Ordering::Relaxed) {
                    let mut q = lock.lock().unwrap();
                    while q.emergency.is_empty()
                        && q.normal.is_empty()
                        && is_running_write.load(Ordering::Relaxed)
                    {
                        q = match cvar.wait_timeout(q, Duration::from_millis(50)) {
                            Ok((guard, _)) => guard,
                            Err(poisoned) => poisoned.into_inner().0,
                        };
                    }
                    if !is_running_write.load(Ordering::Relaxed) {
                        break;
                    }
                    // 最高优先级急停优先处理
                    let task = if let Some(request) = q.emergency.pop_front() {
                        Some(SerialWriteTask::Emergency(request))
                    } else {
                        q.normal.pop_front().map(SerialWriteTask::Normal)
                    };
                    drop(q);

                    if let Some(task) = task {
                        let request = match task {
                            SerialWriteTask::Emergency(request)
                            | SerialWriteTask::Normal(request) => request,
                        };
                        let bytes = request.bytes.clone();
                        let (write_result, written) = write_all_and_flush(&mut write_port, &bytes);
                        let result = match write_result {
                            Ok(()) => WriteResultEvent::for_request(
                                &request,
                                WriteStatus::Written,
                                written,
                                None,
                            ),
                            Err(error) => {
                                tracing::warn!("串口 [{}] 写入失败: {}", port_name_write, error);
                                WriteResultEvent::for_request(
                                    &request,
                                    WriteStatus::Failed,
                                    written,
                                    Some(error.to_string()),
                                )
                            }
                        };
                        let _ = app_write.emit("serial://write-result", result);
                    }
                }
            })
            .map_err(|e| format!("启动串口写入线程失败: {}", e))?;

        std::thread::Builder::new()
            .name(format!("serial-reader-{}", port_name))
            .spawn(move || {
                let mut port = port;
                let mut read_buf = [0u8; 1024];
                while is_running_thread.load(Ordering::Relaxed) {
                    match port.read(&mut read_buf) {
                        Ok(0) => {
                            std::thread::sleep(Duration::from_millis(2));
                        }
                        Ok(n) => {
                            // 先完整交付驱动读到的字节；文本分行在管线解析副本上进行。
                            if raw_tx.blocking_send(Ok(read_buf[..n].to_vec())).is_err() {
                                return;
                            }
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                            // 正常非阻塞超时，继续循环
                            continue;
                        }
                        Err(e) => {
                            // 串口热插拔拔出或硬件异常 (Step 2.4 热插拔容错)
                            is_connected_thread.store(false, Ordering::SeqCst);
                            tracing::warn!("串口 [{}] 异常断开: {}", port_name_cloned, e);

                            // 通过 Tauri Event 通知前端
                            let _ = app_thread.emit(
                                "serial-disconnected",
                                serde_json::json!({
                                    "port": port_name_cloned,
                                    "reason": e.to_string()
                                }),
                            );

                            let _ = raw_tx.blocking_send(Err(format!("串口断开: {}", e)));
                            break;
                        }
                    }
                }
                is_connected_thread.store(false, Ordering::SeqCst);
            })
            .map_err(|e| format!("启动串口读取线程失败: {}", e))?;

        Ok(Self {
            port_name: port_name.to_string(),
            baud_rate,
            is_connected,
            is_running,
            raw_rx,
            queue,
            result_app: app,
        })
    }

    pub fn port_name(&self) -> &str {
        &self.port_name
    }

    pub fn baud_rate(&self) -> u32 {
        self.baud_rate
    }
}

impl DataSource for SerialDataSource {
    fn read_chunk(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Option<Vec<u8>>, String>> + Send + '_>> {
        Box::pin(async move {
            if !self.is_connected.load(Ordering::Relaxed)
                || !self.is_running.load(Ordering::Relaxed)
            {
                return Ok(None);
            }
            match self.raw_rx.recv().await {
                Some(Ok(bytes)) => Ok(Some(bytes)),
                Some(Err(e)) => Err(e),
                None => Ok(None),
            }
        })
    }

    fn is_connected(&self) -> bool {
        self.is_connected.load(Ordering::Relaxed)
    }

    fn write_bytes(&mut self, request: WriteRequest) -> Result<(), String> {
        if !self.is_connected.load(Ordering::Relaxed) {
            return Err("串口未连接".to_string());
        }
        let (lock, cvar) = &*self.queue;
        let mut q = lock.lock().unwrap();
        if q.normal.len() >= 200 {
            return Err("写入队列溢出".to_string());
        }
        q.normal.push_back(request);
        cvar.notify_one();
        Ok(())
    }

    fn write_emergency_bytes(&mut self, request: WriteRequest) -> Result<(), String> {
        if !self.is_connected.load(Ordering::Relaxed) {
            return Err("串口未连接".to_string());
        }
        let (lock, cvar) = &*self.queue;
        let mut q = lock.lock().unwrap();
        // 软件停止屏障清除尚未进入驱动写入线程的普通命令与旧停止命令。
        let mut canceled: Vec<WriteRequest> = q.normal.drain(..).collect();
        canceled.extend(q.emergency.drain(..));
        q.emergency.push_back(request);
        cvar.notify_one();
        drop(q);
        for request in canceled {
            let event = WriteResultEvent::for_request(
                &request,
                WriteStatus::Canceled,
                0,
                Some("软件停止屏障已清除待发请求".into()),
            );
            let _ = self.result_app.emit("serial://write-result", event);
        }
        Ok(())
    }

    fn reset(&mut self) {}

    fn stop(&mut self) {
        self.is_running.store(false, Ordering::SeqCst);
        self.is_connected.store(false, Ordering::SeqCst);
        if let Ok(mut queue) = self.queue.0.lock() {
            let mut pending: Vec<WriteRequest> = queue.normal.drain(..).collect();
            pending.extend(queue.emergency.drain(..));
            for request in pending {
                let event = WriteResultEvent::for_request(
                    &request,
                    WriteStatus::Canceled,
                    0,
                    Some("串口会话已关闭，待发请求已取消".into()),
                );
                let _ = self.result_app.emit("serial://write-result", event);
            }
        }
        self.queue.1.notify_all();
    }
}

impl Drop for SerialDataSource {
    fn drop(&mut self) {
        self.is_running.store(false, Ordering::SeqCst);
        self.is_connected.store(false, Ordering::SeqCst);
    }
}

/// Mock 仿真输出格式 (CSV 逗号分隔 / Teleplot 键值对)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MockFormat {
    Csv,
    Teleplot,
}

/// Mock 虚拟仿真数据源：以 100Hz 频率模拟二阶系统阶跃响应
///
/// 增强功能 (M1 Step 1.1):
/// 1. 支持标准二阶惯性系统 + PID 积分仿真；
/// 2. 支持输出 CSV (`10.0,9.2,30.1\n`) 与 Teleplot (`>sp:10\n>act:9.2\n>out:30\n`)；
/// 3. 支持混入偶发日志 (如 `[INFO] System Boot OK\n`, `[WARN] Battery Low\n`)；
/// 4. 支持触发 $10 \to 20$ 阶跃与调参响应。
pub struct MockDataSource {
    dt: f64,
    t: f64,
    step_index: u64,
    format: MockFormat,
    pending_lines: VecDeque<String>,
    manual_target: Option<f64>,
    inject_logs: bool,
    // 物理系统状态
    y: f64,
    dy: f64,
    // PID 控制器状态
    integral_err: f64,
    prev_err: f64,
    kp: f64,
    ki: f64,
    kd: f64,
    // 二阶系统参数 (自然频率与阻尼比)
    omega_n: f64,
    zeta: f64,
    is_active: bool,
}

impl MockDataSource {
    pub fn new() -> Self {
        Self {
            dt: 0.01, // 100Hz => 10ms
            t: 0.0,
            step_index: 0,
            format: MockFormat::Csv,
            pending_lines: VecDeque::new(),
            manual_target: None,
            inject_logs: true,
            y: 0.0,
            dy: 0.0,
            integral_err: 0.0,
            prev_err: 0.0,
            kp: 1.80,
            ki: 0.60,
            kd: 0.25,
            omega_n: 4.0, // 4 rad/s
            zeta: 0.35,   // 欠阻尼，典型阶跃超调 ~25%-30%
            is_active: true,
        }
    }

    /// 从指定仿真时刻开始初始化 (用于暂停后继续仿真避免时间跳跃)
    pub fn with_time(start_time: f64) -> Self {
        let mut source = Self::new();
        source.t = start_time;
        source.step_index = (start_time / source.dt).round() as u64;
        source
    }

    /// 指定格式初始化
    pub fn with_format(format: MockFormat) -> Self {
        let mut source = Self::new();
        source.format = format;
        source
    }

    /// 切换输出格式 (CSV ↔ Teleplot)
    pub fn set_format(&mut self, format: MockFormat) {
        self.format = format;
    }

    pub fn format(&self) -> MockFormat {
        self.format
    }

    /// 开启或关闭偶发日志注入
    pub fn set_inject_logs(&mut self, enable: bool) {
        self.inject_logs = enable;
    }

    /// 手动触发设定值阶跃 (如 10 -> 20)
    pub fn trigger_step(&mut self, target: f64) {
        self.manual_target = Some(target);
        if self.inject_logs {
            self.pending_lines
                .push_back(format!("[INFO] Step Target Changed to: {:.2}\n", target));
        }
    }

    /// 更新 PID 参数 (调参响应)
    pub fn update_pid(&mut self, kp: f64, ki: f64, kd: f64) {
        self.kp = kp;
        self.ki = ki;
        self.kd = kd;
        if self.inject_logs {
            self.pending_lines.push_back(format!(
                "[INFO] Applied New PID: Kp={:.2}, Ki={:.2}, Kd={:.2}\n",
                kp, ki, kd
            ));
        }
    }

    /// 计算当前时刻的目标设定值 (默认支持 0 -> 10 -> 20 自动循环阶跃)
    pub fn get_setpoint(&self) -> f64 {
        if let Some(target) = self.manual_target {
            return target;
        }

        if self.t < 1.0 {
            0.0
        } else if self.t < 7.0 {
            10.0
        } else if self.t < 14.0 {
            // 7s ~ 14s: 触发 10 -> 20 阶跃
            20.0
        } else if self.t < 21.0 {
            10.0
        } else {
            let cycle = ((self.t - 21.0) / 7.0).floor() as u64;
            if cycle % 2 == 0 {
                20.0
            } else {
                10.0
            }
        }
    }

    /// 执行一步物理模型与 PID 仿真积分
    pub fn step(&mut self) -> (f64, f64, f64) {
        let r = self.get_setpoint();
        let e = r - self.y;

        // PID 计算
        let p_out = self.kp * e;
        self.integral_err += self.ki * e * self.dt;
        // 积分抗饱和限幅
        self.integral_err = self.integral_err.clamp(-30.0, 30.0);

        let d_out = if self.t > 0.0 {
            self.kd * (e - self.prev_err) / self.dt
        } else {
            0.0
        };
        self.prev_err = e;

        let mut u = p_out + self.integral_err + d_out;
        u = u.clamp(-50.0, 50.0);

        // 二阶系统动力学: ddy + 2*zeta*wn*dy + wn^2*y = wn^2 * u
        let ddy =
            self.omega_n * self.omega_n * (u - self.y) - 2.0 * self.zeta * self.omega_n * self.dy;
        self.dy += ddy * self.dt;
        self.y += self.dy * self.dt;
        self.t += self.dt;
        self.step_index += 1;

        // 添加微小传感器高频抖动仿真 (±0.02)
        let noise = 0.02 * (137.0 * self.t).sin() + 0.01 * (283.0 * self.t).cos();
        let measured_y = self.y + noise;

        (r, measured_y, u)
    }

    /// 检查并生成偶发日志
    fn maybe_inject_occasional_logs(&mut self) {
        if !self.inject_logs {
            return;
        }

        match self.step_index {
            1 => {
                self.pending_lines
                    .push_back("[INFO] System Boot OK - Hardware Rev B\n".to_string());
            }
            100 => {
                self.pending_lines
                    .push_back("[INFO] Step Initiated: Target = 10.00\n".to_string());
            }
            700 => {
                self.pending_lines
                    .push_back("[INFO] Step Initiated: Target = 20.00 (10 -> 20)\n".to_string());
            }
            1200 => {
                self.pending_lines
                    .push_back("[WARN] Battery Low (20%)\n".to_string());
            }
            2000 => {
                self.pending_lines
                    .push_back("[INFO] Motor Temp: 42.5C (Nominal)\n".to_string());
            }
            _ => {}
        }
    }
}

impl Default for MockDataSource {
    fn default() -> Self {
        Self::new()
    }
}

impl DataSource for MockDataSource {
    fn read_chunk(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = Result<Option<Vec<u8>>, String>> + Send + '_>> {
        Box::pin(async move {
            if !self.is_active {
                return Ok(None);
            }

            // 如果当前待分发行队列为空，推进一步物理仿真并生成新数据行
            if self.pending_lines.is_empty() {
                // 维持 100Hz (10ms) 仿真节拍
                tokio::time::sleep(Duration::from_millis(10)).await;

                let (r, y, u) = self.step();

                // 注入偶发日志
                self.maybe_inject_occasional_logs();

                match self.format {
                    MockFormat::Csv => {
                        self.pending_lines
                            .push_back(format!("{:.2},{:.2},{:.2}\n", r, y, u));
                    }
                    MockFormat::Teleplot => {
                        self.pending_lines.push_back(format!(">sp:{:.2}\n", r));
                        self.pending_lines.push_back(format!(">act:{:.2}\n", y));
                        self.pending_lines.push_back(format!(">out:{:.2}\n", u));
                    }
                }
            }

            Ok(self.pending_lines.pop_front().map(String::into_bytes))
        })
    }

    fn is_connected(&self) -> bool {
        self.is_active
    }

    fn reset(&mut self) {
        self.t = 0.0;
        self.step_index = 0;
        self.y = 0.0;
        self.dy = 0.0;
        self.integral_err = 0.0;
        self.prev_err = 0.0;
        self.manual_target = None;
        self.pending_lines.clear();
        self.is_active = true;
    }

    fn stop(&mut self) {
        self.is_active = false;
        self.pending_lines.clear();
    }

    fn write_emergency_bytes(&mut self, request: WriteRequest) -> Result<(), String> {
        self.y = 0.0;
        self.dy = 0.0;
        self.pending_lines
            .push_back("[EMERGENCY] 最高优先级急停命令已生效，输出已切断至 0\n".to_string());
        self.write_bytes(request)
    }

    fn write_bytes(&mut self, request: WriteRequest) -> Result<(), String> {
        if let Ok(s) = std::str::from_utf8(&request.bytes) {
            let trimmed = s.trim();
            if trimmed.starts_with("SET:") {
                let mut kp = self.kp;
                let mut ki = self.ki;
                let mut kd = self.kd;
                for part in trimmed.trim_start_matches("SET:").split(',') {
                    let mut kv = part.split('=');
                    if let (Some(k), Some(v)) = (kv.next(), kv.next()) {
                        match k.trim().to_uppercase().as_str() {
                            "KP" => {
                                if let Ok(val) = v.trim().parse::<f64>() {
                                    kp = val;
                                }
                            }
                            "KI" => {
                                if let Ok(val) = v.trim().parse::<f64>() {
                                    ki = val;
                                }
                            }
                            "KD" => {
                                if let Ok(val) = v.trim().parse::<f64>() {
                                    kd = val;
                                }
                            }
                            _ => {}
                        }
                    }
                }
                self.update_pid(kp, ki, kd);
            } else if trimmed.contains("STOP") {
                self.pending_lines
                    .push_back("[EMERGENCY] 急停命令已生效，输出已切断至 0\n".to_string());
            } else {
                self.pending_lines
                    .push_back(format!("[ECHO] 收到指令: {}\n", trimmed));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct PartialWriter {
        output: Vec<u8>,
        max_chunk: usize,
        fail_after: Option<usize>,
    }

    impl Write for PartialWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if self
                .fail_after
                .is_some_and(|limit| self.output.len() >= limit)
            {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "injected write failure",
                ));
            }
            let remaining_before_failure = self
                .fail_after
                .map(|limit| limit.saturating_sub(self.output.len()))
                .unwrap_or(bytes.len());
            let count = bytes
                .len()
                .min(self.max_chunk)
                .min(remaining_before_failure);
            self.output.extend_from_slice(&bytes[..count]);
            Ok(count)
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn write_all_reports_partial_bytes_on_driver_failure() {
        let mut writer = PartialWriter {
            output: Vec::new(),
            max_chunk: 2,
            fail_after: Some(3),
        };
        let (result, written) = write_all_and_flush(&mut writer, b"ABCDE");
        assert_eq!(written, 3);
        assert_eq!(writer.output, b"ABC");
        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::BrokenPipe);
    }

    #[test]
    fn write_all_handles_partial_success_and_rejects_zero_progress() {
        let mut writer = PartialWriter {
            output: Vec::new(),
            max_chunk: 2,
            fail_after: None,
        };
        let (result, written) = write_all_and_flush(&mut writer, b"ABCDE");
        assert!(result.is_ok());
        assert_eq!(written, 5);
        assert_eq!(writer.output, b"ABCDE");

        let mut zero = PartialWriter {
            output: Vec::new(),
            max_chunk: 0,
            fail_after: None,
        };
        let (result, written) = write_all_and_flush(&mut zero, b"X");
        assert_eq!(written, 0);
        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::WriteZero);
    }

    #[test]
    fn test_mock_data_source_simulation() {
        let mut source = MockDataSource::new();
        // 前 100 步 (1s)，setpoint 应该为 0
        for _ in 0..100 {
            let (r, _, _) = source.step();
            assert_eq!(r, 0.0);
        }
        // 1s 之后阶跃到 10.0
        let (r, _, _) = source.step();
        assert_eq!(r, 10.0);

        // 步进若干步，y 应该逐渐上升
        for _ in 0..200 {
            source.step();
        }
        assert!(
            source.y > 5.0,
            "Actual response should rise towards setpoint"
        );
    }

    #[test]
    fn test_mock_step_10_to_20_and_pid_update() {
        let mut source = MockDataSource::new();
        // 推进到 7s (700 步) 自动阶跃到 20.0
        source.t = 7.1;
        assert_eq!(source.get_setpoint(), 20.0);

        // 手动触发阶跃到 25.0
        source.trigger_step(25.0);
        assert_eq!(source.get_setpoint(), 25.0);

        // 更新 PID 参数并验证响应
        source.update_pid(2.5, 0.8, 0.3);
        assert_eq!(source.kp, 2.5);
        assert_eq!(source.ki, 0.8);
        assert_eq!(source.kd, 0.3);
    }

    #[test]
    fn test_mock_format_csv_and_teleplot() {
        let mut csv_source = MockDataSource::with_format(MockFormat::Csv);
        csv_source.set_inject_logs(false);
        let (r, y, u) = csv_source.step();
        let csv_line = format!("{:.2},{:.2},{:.2}\n", r, y, u);
        assert!(csv_line.contains(','));
        assert!(!csv_line.starts_with('>'));

        let mut teleplot_source = MockDataSource::with_format(MockFormat::Teleplot);
        teleplot_source.set_inject_logs(false);
        let (r, y, u) = teleplot_source.step();
        let l1 = format!(">sp:{:.2}\n", r);
        let l2 = format!(">act:{:.2}\n", y);
        let l3 = format!(">out:{:.2}\n", u);
        assert!(l1.starts_with(">sp:"));
        assert!(l2.starts_with(">act:"));
        assert!(l3.starts_with(">out:"));
    }

    #[test]
    fn test_mock_log_injection() {
        let mut source = MockDataSource::new();
        source.step_index = 0; // step 0 -> 1 will trigger boot log
        source.step();
        source.maybe_inject_occasional_logs();
        assert!(source
            .pending_lines
            .iter()
            .any(|l| l.contains("[INFO] System Boot OK")));
    }

    #[test]
    fn test_mock_reset() {
        let mut source = MockDataSource::new();
        for _ in 0..150 {
            source.step();
        }
        assert!(source.t > 1.0);
        source.reset();
        assert_eq!(source.t, 0.0);
        assert_eq!(source.y, 0.0);
        assert_eq!(source.dy, 0.0);
        assert!(source.pending_lines.is_empty());
    }

    #[test]
    fn test_mock_with_time() {
        let mut source = MockDataSource::with_time(2.5);
        assert_eq!(source.t, 2.5);
        // t = 2.5 时应处于第一个阶跃高电平周期 (10.0)
        let (r, _, _) = source.step();
        assert_eq!(r, 10.0);
    }

    #[test]
    fn test_process_serial_bytes_normal_and_partial_chunks() {
        let dirty_counter = AtomicU64::new(0);
        let mut line_buf = Vec::new();

        // 阶段 1: 不完整块
        let lines1 = process_serial_bytes(b">sp:10.5", &mut line_buf, &dirty_counter);
        assert!(lines1.is_empty());
        assert_eq!(dirty_counter.load(Ordering::Relaxed), 0);

        // 阶段 2: 补全并包含下一行
        let lines2 = process_serial_bytes(b"\r\n>act:9.8\n", &mut line_buf, &dirty_counter);
        assert_eq!(lines2, vec![">sp:10.5", ">act:9.8"]);
        assert!(line_buf.is_empty());
        assert_eq!(dirty_counter.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn test_process_serial_bytes_garbled_non_utf8_recovery() {
        let dirty_counter = AtomicU64::new(0);
        let mut line_buf = Vec::new();

        // 模拟上电瞬态非 UTF-8 乱码 (如 0xFF, 0xFE, 0xC0) 紧随 \n
        let garbled = [0xFF, 0xFE, 0xC0, b'\n'];
        let lines_garbled = process_serial_bytes(&garbled, &mut line_buf, &dirty_counter);
        assert!(lines_garbled.is_empty(), "Garbled line should be dropped");
        assert_eq!(
            dirty_counter.load(Ordering::Relaxed),
            1,
            "Dirty counter should increment"
        );

        // 乱码后立即恢复正常数据解析
        let valid = b"CMD:OK\n";
        let lines_valid = process_serial_bytes(valid, &mut line_buf, &dirty_counter);
        assert_eq!(
            lines_valid,
            vec!["CMD:OK"],
            "Subsequent valid line must be recovered cleanly"
        );
        assert_eq!(dirty_counter.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn test_process_serial_bytes_overflow_protection() {
        let dirty_counter = AtomicU64::new(0);
        let mut line_buf = Vec::new();

        // 文本解析副本在 64 KiB 上限处清除；原始接收块由调用方单独保留。
        let huge_chunk = vec![b'A'; 65_537];
        let lines = process_serial_bytes(&huge_chunk, &mut line_buf, &dirty_counter);
        assert!(lines.is_empty());
        assert_eq!(
            dirty_counter.load(Ordering::Relaxed),
            1,
            "Buffer overflow should trigger dirty counter"
        );
        assert!(
            line_buf.is_empty(),
            "Line buffer should be wiped clean on overflow"
        );
    }

    #[test]
    fn test_process_serial_bytes_resyncs_after_oversized_line() {
        let dirty_counter = AtomicU64::new(0);
        let mut line_buf = Vec::new();
        let mut chunk = vec![b'A'; 65_537];
        chunk.extend_from_slice(b"\n>speed:12.5\n");

        let lines = process_serial_bytes(&chunk, &mut line_buf, &dirty_counter);
        assert_eq!(lines, vec![">speed:12.5"]);
        assert_eq!(dirty_counter.load(Ordering::Relaxed), 1);
        assert!(line_buf.is_empty());
    }
}
