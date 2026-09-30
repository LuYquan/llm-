# 《VOFA+ 用户迁移与协议快速上手指南》

> 本文档面向习惯使用 VOFA+ 的嵌入式软件工程师、电机控制与机器人算法工程师，旨在帮助您无需修改下位机代码，即可零成本无缝迁移至《LLM串口》高保真控制调试工作台。

---

## 一、为什么选择《LLM串口》？

VOFA+ 是一款优秀的虚拟仪表与波形显示工具，但在深度控制工程调参中存在以下瓶颈：
1. **分析与调参断层**：VOFA+ 仅负责被动绘制波形，无法从阶跃波形中反算受控对象传递函数与 PID 参数；
2. **串级多环无约束**：无法管理多环整定依赖，极易因外环带宽倒置或过冲引发炸机震荡；
3. **缺乏智能辅助**：工程师仍需凭肉眼估计超调量与调节时间，频繁手算试凑。

《LLM串口》在**完全兼容 VOFA+ 官方协议（RawData / FireWater / JustFloat）**与控件画布交互的基础上，融合了**控制理论工具链（L2）**与**确定性本地安全防线（SafetyGuard）**，兼具虚拟仪表直观性与工业级控制理论自洽性。

---

## 二、三大兼容协议与固件 C 代码片段

《LLM串口》协议引擎可根据串口流或配置实时热切换，支持下位机主流传输方式：

### 2.1 FireWater 协议 (文本 CSV 格式)

- **适用场景**：调试阶段、低波特率（如 115200bps）、直观文本打印、单片机算力有限。
- **协议格式**：每个数据帧包含逗号或制表符分隔的浮点数字符串，以 `\n` 或 `\r\n` 结尾。
- **Teleplot 格式支持**：兼容 `>name:value\n` 键值对推送。

#### STM32 HAL / C 语言示例
```c
#include <stdio.h>

void Send_FireWater_Data(float target, float feedback, float output) {
    // 打印三个通道：目标值, 实测值, 控制输出
    printf("%.2f,%.2f,%.2f\n", target, feedback, output);
}
```

#### ESP-IDF / Arduino 示例
```cpp
void loop() {
    float actual_speed = read_encoder_speed();
    float target_speed = get_target();
    Serial.printf("%.2f,%.2f\n", target_speed, actual_speed);
    delay(10); // 100Hz 发送
}
```

---

### 2.2 JustFloat 协议 (高吞吐小端二进制浮点)

- **适用场景**：高频流式监控（1kHz ~ 10kHz）、高速串口（如 921600bps 或 2Mbps）、节省单片机格式化耗时与带宽。
- **协议格式**：连续发送 N 个 IEEE 754 标准 `float32` 小端单精度浮点数（每个 4 字节），帧末尾追加 4 字节尾帧：`0x00, 0x00, 0x80, 0x7F`（即浮点 NaN 的字节模式）。

#### STM32 HAL 零拷贝发送示例
```c
#include <stdint.h>
#include "stm32f4xx_hal.h"

extern UART_HandleTypeDef huart1;

// 定义 JustFloat 数据帧结构体 (对齐为 1 字节)
#pragma pack(push, 1)
typedef struct {
    float ch0;                  // 目标值
    float ch1;                  // 采样反馈
    float ch2;                  // PWM 控制量
    uint8_t tail[4];            // 0x00, 0x00, 0x80, 0x7F
} JustFloat_Packet_t;
#pragma pack(pop)

void Send_JustFloat_DMA(float target, float feedback, float pwm) {
    static JustFloat_Packet_t pkt = {
        .tail = { 0x00, 0x00, 0x80, 0x7F }
    };
    
    pkt.ch0 = target;
    pkt.ch1 = feedback;
    pkt.ch2 = pwm;
    
    // 通过串口 DMA 零阻塞下发
    HAL_UART_Transmit_DMA(&huart1, (uint8_t*)&pkt, sizeof(pkt));
}
```

> **提示**：在软件顶栏协议下拉菜单选择 `JustFloat`，并可在通道配置中指定预期通道数（如 3），即便现场存在强电磁干扰造成瞬态丢包，协议引擎也将依靠尾帧在下一帧立即自愈！

---

### 2.3 RawData 协议 (紧凑型原始二进制)

- **适用场景**：极致压缩字节、固定通道数的整型数据采集（如 ADC 12位原始读数 `u16le`、陀螺仪 `i16le` 等）。
- **协议格式**：无需帧头尾，连续由 `format` 类型组成的数据包。

---

## 三、VOFA+ 控件画布迁移指南

### 3.1 挂锁机制（锁定运行 / 解锁编辑）
- 点击画布右上角挂锁图标（🔒 / 🔓）即可在**设计态**与**运行调参态**间丝滑切换；
- **解锁态 (🔓)**：可在左侧抽屉拖拽控件、调整大小、右键复制或删除；
- **锁定态 (🔒)**：控件禁止误拖动，滑块、旋钮、动作按键响应交互与参数下发。

### 3.2 控件输出与指令模板绑定
例如需要通过滑块微调电机速度环比例增益 $K_p$，只需双击滑块打开配置面板：
- **指令模板**：`SET:SPEED:KP={val}\n`
- **量程范围**：`0.0 ~ 50.0`，步长 `0.1`
- **节流模式**：默认 `50ms` 节流，避免高频拖动冲垮下位机串口接收 FIFO。

---

## 四、常见问题与排错

1. **波形出现阶梯断层或帧率低？**
   - 检查串口波特率与发送频率。推荐 1kHz 采样率下使用 921600bps + `JustFloat` 协议。
2. **文本与波形同时发送时，波形解析错乱？**
   - 在 `FireWater` 模式下，非数值格式的调试打印行（如 `[INFO] Motor Init OK`）会被协议引擎自动分流至左侧主终端日志窗，数值行自动喂入波形引擎，二者天然解耦。
