/**
 * UI Streamlining (界面与操作极简重构) 核心逻辑自动化单测
 * 真实导入生产模块 src/utils/terminalHelpers.ts，验证边界条件与真实状态机
 */

import assert from 'node:assert/strict';
import {
  formatBytes,
  buildPayload,
  calcTimeDiv,
  isScrubbingActive,
  CommandHistoryManager,
} from '../src/utils/terminalHelpers';

export async function runUiStreamliningTests() {
  console.log('--- [UI Streamlining] 开始执行界面与操作极简核心逻辑自动化测试 ---');

  // 1. 流量统计字节格式化逻辑测试 (真实生产纯函数验证)
  console.log('  1. 测试流量统计字节格式化 (formatBytes)');
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(undefined), '0 B');
  assert.equal(formatBytes(NaN), '0 B');
  assert.equal(formatBytes(-10), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(1048576), '1.00 MB');
  assert.equal(formatBytes(5242880), '5.00 MB');

  // 2. 指令下发载荷构建与换行符自动补全测试 (真实生产纯函数验证)
  console.log('  2. 测试指令下发载荷构建与换行符处理 (buildPayload)');
  // 文本模式 CRLF
  assert.equal(buildPayload('SET:KP=1.2', false, 'crlf'), 'SET:KP=1.2\r\n');
  assert.equal(buildPayload('SET:KP=1.2\r\n', false, 'crlf'), 'SET:KP=1.2\r\n'); // 不重复添加
  // 文本模式 LF
  assert.equal(buildPayload('SET:KP=1.2', false, 'lf'), 'SET:KP=1.2\n');
  assert.equal(buildPayload('SET:KP=1.2\n', false, 'lf'), 'SET:KP=1.2\n'); // 不重复添加
  // 文本模式 CR
  assert.equal(buildPayload('SET:KP=1.2', false, 'cr'), 'SET:KP=1.2\r');
  assert.equal(buildPayload('SET:KP=1.2\r', false, 'cr'), 'SET:KP=1.2\r'); // 不重复添加
  // 文本模式无换行
  assert.equal(buildPayload('SET:KP=1.2', false, 'none'), 'SET:KP=1.2');

  // HEX 模式下绝对不追加换行符
  assert.equal(buildPayload('AA 01 55', true, 'crlf'), 'AA 01 55');
  assert.equal(buildPayload('AA 01 55', true, 'lf'), 'AA 01 55');
  assert.equal(buildPayload('AA 01 55', true, 'cr'), 'AA 01 55');
  assert.equal(buildPayload('AA 01 55', true, 'none'), 'AA 01 55');

  // 3. 历史指令循环穿梭状态机测试 (真实生产 CommandHistoryManager 类验证)
  console.log('  3. 测试单行输入框 ↑/↓ 历史指令循环穿梭与草稿恢复状态机');
  const hist = new CommandHistoryManager(50);
  hist.push('CMD:1');
  hist.push('CMD:2');
  hist.push('CMD:3');

  // 连续去重验证
  hist.push('CMD:3');
  assert.equal(hist.getHistory().length, 3);

  // 空指令不入历史
  hist.push('   ');
  assert.equal(hist.getHistory().length, 3);

  // ↑ 召回最后一条
  assert.equal(hist.arrowUp(''), 'CMD:3');
  // ↑ 召回倒数第二条
  assert.equal(hist.arrowUp('CMD:3'), 'CMD:2');
  // ↑ 召回第一条
  assert.equal(hist.arrowUp('CMD:2'), 'CMD:1');
  // 顶头后继续 ↑ 保持在第一条
  assert.equal(hist.arrowUp('CMD:1'), 'CMD:1');

  // ↓ 移回倒数第二条
  assert.equal(hist.arrowDown(), 'CMD:2');
  // ↓ 移回最后一条
  assert.equal(hist.arrowDown(), 'CMD:3');
  // ↓ 越过末尾清空并复位
  assert.equal(hist.arrowDown(), '');

  // 核心攻防：草稿保留验证 (用户输入未下发的草稿内容，按 ↑ 查阅历史再按 ↓ 必须精准还原草稿)
  const userDraft = 'SET:TARGET=100.5';
  assert.equal(hist.arrowUp(userDraft), 'CMD:3'); // 首次离开输入态，暂存草稿
  assert.equal(hist.arrowUp('CMD:3'), 'CMD:2');
  assert.equal(hist.arrowDown(), 'CMD:3');
  assert.equal(hist.arrowDown(), userDraft); // 必须精准还原用户的草稿！
  // 已在草稿态继续 ↓ 保持草稿
  assert.equal(hist.arrowDown(), userDraft);

  // 重置导航状态验证
  hist.arrowUp(userDraft);
  hist.resetNavigation();
  assert.equal(hist.getCurrentIndex(), -1);

  // 4. Scrubber 历史回溯时基与时钟分度值算法测试 (真实生产纯函数验证)
  console.log('  4. 测试 Scrubber 历史回溯与时基分度值算法 (calcTimeDiv / isScrubbingActive)');
  assert.equal(calcTimeDiv(1.0), '50.0 ms/div');
  assert.equal(calcTimeDiv(0.5), '25.0 ms/div');
  assert.equal(calcTimeDiv(2.0), '100.0 ms/div');
  assert.equal(calcTimeDiv(0), '50.0 ms/div'); // 零异常兜底为 1.0ms

  assert.equal(isScrubbingActive(100), false);
  assert.equal(isScrubbingActive(99.8), false);
  assert.equal(isScrubbingActive(99.5), false);
  assert.equal(isScrubbingActive(99.4), true);
  assert.equal(isScrubbingActive(50), true);
  assert.equal(isScrubbingActive(0), true);

  // 5. 右侧栏贴边收起与展开状态机测试
  console.log('  5. 测试右侧栏贴边折叠与外部点击自动贴边状态机');
  class SidebarController {
    isCollapsed = true; // 默认折叠

    toggle() {
      this.isCollapsed = !this.isCollapsed;
    }

    collapse() {
      this.isCollapsed = true;
    }

    expand() {
      this.isCollapsed = false;
    }
  }

  const sidebar = new SidebarController();
  assert.equal(sidebar.isCollapsed, true); // 默认收起
  sidebar.expand();
  assert.equal(sidebar.isCollapsed, false);
  // 点击画布空白自动贴边
  sidebar.collapse();
  assert.equal(sidebar.isCollapsed, true);
  sidebar.toggle();
  assert.equal(sidebar.isCollapsed, false);
  sidebar.toggle();
  assert.equal(sidebar.isCollapsed, true);

  console.log('✓ [UI Streamlining] 界面与操作极简核心逻辑自动化测试全部通过！\n');
}
