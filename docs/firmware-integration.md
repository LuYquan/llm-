# 《LLM串口》下位机对接与通信协议指南 (Firmware Integration Guide)

> **适用固件平台**：STM32、ESP32、Arduino、RP2040、TI C2000、GD32 等各类嵌入式 MCU / DSP  
> **适用版本**：v0.1.0+

---

## 1. 通信协议概述

《LLM串口》采用**统一自适应流分流引擎 (Stream Demuxer)**。在单一物理串口连接下，下位机既可以高频上报用于绘制曲线的数值数据，也可以直接输出用于调试的纯文本日志（如 `printf`），上位机将自动识别并分别送入波形画布和日志控制台。

### 1.1 核心通信规则
1. **帧结束符**：每一行数据必须以换行符 `\n` (`0x0A`) 结尾（亦兼容 `\r\n`，系统会自动剔除 `\r`）；
2. **字符编码**：建议采用标准 **UTF-8** 编码；
3. **文本最大长度**：文本解析单行最多累积 65,536 字节（64 KiB），超出会丢弃该解析行并计数；已接收原始字节不因文本解析限制而改写；
4. **推荐频率与通道数**：
   - 推荐数据发送频率：**20Hz ~ 200Hz**（常规 PID 调试建议 50Hz 或 100Hz）；
   - 最大测试稳定吞吐：**1000Hz (单行 3 通道 @ 115200/921600)**；
   - 推荐通道数：**1 ~ 8 个通道**。

---

## 2. 上行数据流格式规范 (MCU -> 上位机)

上位机支持两种上报数据格式：**CSV 纯数值格式** 与 **Teleplot 键值格式**。

### 2.1 格式一：CSV 纯数值格式（推荐，带宽占用最低）

每行发送一组逗号分隔的浮点数或整数，末尾加 `\n`。

#### 语法规则
```text
数值1,数值2,数值3,... \n
```
- 各字段间使用英文逗号 `,` 分隔；
- 字段内容必须为有效数字（支持负数、小数、科学计数法，如 `-12.5`、`1.02e-2`）；
- 严禁包含空字段（如 `1.0,,3.0`）或尾随逗号（如 `1.0,2.0,`）；
- 若没有显式指定通道名，上位机将默认依次命名为 `ch0, ch1, ch2...`。

#### 自定义通道表头（可选）
下位机可以在上电初始化完成时，通过发送以 `#` 开头的行来显式声明通道名称：
```text
#target,actual,output\n
```
上位机收到该行后，会自动将后续的 CSV 列分别命名为 `target`、`actual`、`output`。

#### 数据示例
```text
#target,actual,output
100.0,0.0,0.0
100.0,15.2,85.0
100.0,45.8,70.5
100.0,88.1,30.2
100.0,105.3,10.0
```

---

### 2.2 格式二：Teleplot 键值对格式（语义清晰，异步多变量）

每个变量独立为一行，以大于号 `>` 开头，变量名与数值间用英文冒号 `:` 分隔。

#### 语法规则
```text
>变量名:数值\n
```
- `变量名`：英文字母、数字或下划线组合；
- `数值`：有效的数字字符串。

#### 多变量时序对齐机制
下位机在同一控制周期内可以先后发送多个 Teleplot 行：
```text
>target:100.0
>actual:85.4
>pwm:60.0
```
上位机内部具有 10ms 时间对齐窗口，会自动将同一个控制周期内连续收到的不同变量打包合并为一个时间采样点。

---

### 2.3 格式三：调试文本日志 (与波形自动分流)

任何**非纯数值 CSV**且**不以 `>` 开头**的文本行，都会被自动识别为系统日志并送入【日志抽屉】：
```text
[INFO] System initialized successfully.
Motor driver ready, supply voltage: 24.1V
Current Mode: SPEED_CONTROL
[WARN] Temperature is rising: 58.2 C
```

> **注意**：如果普通文本日志中含有逗号（如 `Boot completed, 4 sensors found`），只要第一个逗号前的单词不是纯数字，系统均能智能识别为文本日志，不会引发波形解析报错。

---

## 3. 下行参数写入与控制协议 (上位机 -> MCU)

当在上位机执行“AI 核准下发”、“滑块调参”或“动作按键”时，上位机将通过串口向 MCU 发送控制指令。

### 3.1 默认 PID 参数写入模板
AI 调参面板默认采用如下 ASCII 文本格式下发参数：
```text
PID,{loop},{kp},{ki},{kd}\n
```
**实际发送报文示例**：
```text
PID,speed,1.250,0.080,0.320\n
```
- `{loop}`：当前被调回路名称（如 `speed`、`position`、`angle`）；
- `{kp}`、`{ki}`、`{kd}`：经过 SafetyGuard 安全限幅校验后的浮点数字符串（默认保留 3 位小数）。

### 3.2 自定义指令模板与占位符
在【设置】或【控件配置】中，用户可以自由修改下发模板以适配自身现有固件协议。支持以下占位符：

| 占位符 | 说明 | 示例 |
|---|---|---|
| `{val}` | 单一数值（用于滑块或输入框） | `SET:SPEED={val}\n` $\to$ `SET:SPEED=120.5\n` |
| `{loop}` | 目标回路名称 | `CMD:{loop}:KP={kp}\n` |
| `{kp}` | 比例增益 $K_p$ | `1.250` |
| `{ki}` | 积分增益 $K_i$ | `0.080` |
| `{kd}` | 微分增益 $K_d$ | `0.320` |

### 3.3 HEX 十六进制协议
对于按键与滑块控件，亦支持配置为十六进制 HEX 编码：
- 配置示例：`AA 01 {val} 55`
- 上位机自动将 `{val}` 按照选定的二进制格式（如 `u16le`、`f32le`）转换为 HEX 字节串后下发。

---

## 4. 下位机参考代码示例

### 4.1 STM32 HAL 库极简接入示例 (DMA 发送)

```c
#include "main.h"
#include <stdio.h>
#include <string.h>

extern UART_HandleTypeDef huart1;
static char tx_buffer[128];

/**
 * @brief 在控制定时器中断中周期调用 (例如 10ms / 100Hz)
 */
void Report_PID_Data(float target, float actual, float output) {
    // 采用极简 CSV 格式上报
    int len = snprintf(tx_buffer, sizeof(tx_buffer), "%.2f,%.2f,%.2f\n", target, actual, output);
    if (len > 0) {
        // 使用 DMA 或中断非阻塞发送，避免阻塞控制闭环
        HAL_UART_Transmit_DMA(&huart1, (uint8_t *)tx_buffer, len);
    }
}
```

### 4.2 STM32 下位机参数解析与接收示例 (`sscanf` 极简版)

```c
/**
 * @brief 串口接收到以 '\n' 结尾的一行指令后调用
 */
void Process_Command(char *cmd_line) {
    char loop_name[16];
    float kp = 0.0f, ki = 0.0f, kd = 0.0f;

    // 解析格式：PID,{loop},{kp},{ki},{kd}
    if (sscanf(cmd_line, "PID,%15[^,],%f,%f,%f", loop_name, &kp, &ki, &kd) == 4) {
        if (strcmp(loop_name, "speed") == 0) {
            Set_Speed_PID(kp, ki, kd);
            printf("[INFO] Speed PID Updated: Kp=%.3f, Ki=%.3f, Kd=%.3f\n", kp, ki, kd);
        } else if (strcmp(loop_name, "position") == 0) {
            Set_Position_PID(kp, ki, kd);
        }
    } 
    // 急停指令处理
    else if (strcmp(cmd_line, "ESTOP") == 0) {
        Emergency_Shutdown_Motors();
        printf("[WARN] EMERGENCY STOP EXECUTED!\n");
    }
}
```

### 4.3 Arduino / ESP32 示例代码

```cpp
void setup() {
    Serial.begin(115200);
    // 上电声明通道名称
    Serial.println("#target,actual,output");
}

void loop() {
    static unsigned long last_time = 0;
    if (millis() - last_time >= 10) { // 100Hz
        last_time = millis();

        float target = 100.0;
        float actual = Read_Sensor();
        float output = Calculate_PID(target, actual);

        // 输出波形数据
        Serial.print(target, 2);
        Serial.print(",");
        Serial.print(actual, 2);
        Serial.print(",");
        Serial.println(output, 2);
    }

    // 接收上位机调参指令
    if (Serial.available()) {
        String line = Serial.readStringUntil('\n');
        line.trim();
        if (line.startsWith("SET:SPD=")) {
            float val = line.substring(8).toFloat();
            Set_Target_Speed(val);
        }
    }
}
```

---

## 5. 通信优化与避坑建议

1. **避免在中断中执行阻塞式 `printf`**：
   在 115200 波特率下，每秒最多传输约 11,520 字节。若单行数据长 40 字节，在 1kHz 频率下发送将产生 40,000 字节/秒，导致串口缓冲区溢出并阻塞 MCU。建议调高波特率至 460800 或 921600，或者使用 DMA 循环发送。
2. **浮点数格式化精度**：
   `printf` 时建议使用 `%.2f` 或 `%.3f`，既能保证控制精度，又能显著削减字符长度。
3. **下位机安全看门狗**：
   工业和机器人应用中，下位机应当配备通信超时保护机制：若连续 500ms 未收到上位机心跳或数据，建议下位机主动降速或关闭电机，防范意外断线。
