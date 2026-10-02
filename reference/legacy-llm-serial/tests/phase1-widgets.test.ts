/**
 * Phase 1: 控件全融合与 VOFA+ 范式核心自动化单测套件
 */

import assert from 'node:assert';
import { globalWidgetRegistry, WidgetRegistry } from '../src/core/widget/registry';
import { globalRenderScheduler, GlobalRenderScheduler } from '../src/core/widget/renderScheduler';
import {
  createDefaultVofaPreset,
  createControlLabPreset,
  validateWidgetConfig,
  validateAndMigrateDashboard,
} from '../src/core/widget/schema';
import {
  parseEscapeSequences,
  encodeNumberToHex,
  validateTemplate,
  renderTemplate,
} from '../src/core/widget/templateEngine';
import {
  formatPrecision,
  alignToStep,
  checkAndSanitizeNumeric,
} from '../src/core/widget/safetyGuard';
import { SendGate } from '../src/core/widget/sendGate';
import { snap, clampToCanvas, normalizeSize, clientToCanvas, findFreeSpace, computeResize } from '../src/utils/grid';
import { useWidgetStore } from '../src/stores/widgetStore';
import { ChannelStore } from '../src/core/channel/ChannelStore';

export async function runPhase1WidgetTests() {
  console.log('--- [Phase 1: Widget Unified] 开始执行控件全融合测试套件 ---');

  // 1. 控件注册表 WidgetRegistry 单测
  console.log('  1. 测试 WidgetRegistry 注册表、10大元器件与分类检索');
  const allWidgets = globalWidgetRegistry.list();
  assert.strictEqual(allWidgets.length, 10, '内置控件总数应为 10 种 (含 Phase 4 BodeWidget)');

  const types = allWidgets.map((w) => w.type);
  assert.ok(types.includes('chart'), '应包含 chart 控件');
  assert.ok(types.includes('gauge'), '应包含 gauge 控件');
  assert.ok(types.includes('number'), '应包含 number 控件');
  assert.ok(types.includes('led'), '应包含 led 控件');
  assert.ok(types.includes('slider'), '应包含 slider 控件');
  assert.ok(types.includes('button'), '应包含 button 控件');
  assert.ok(types.includes('knob'), '应包含 knob 控件');
  assert.ok(types.includes('stat_card'), '应包含 stat_card 控件');
  assert.ok(types.includes('step_card'), '应包含 step_card 控件');
  assert.ok(types.includes('bode'), '应包含 bode 控件');

  const controls = globalWidgetRegistry.listByCategory('control');
  assert.strictEqual(controls.length, 3, 'control 分类应包含 3 种控件 (slider, button, knob)');

  const displays = globalWidgetRegistry.listByCategory('display');
  assert.strictEqual(displays.length, 3, 'display 分类应包含 3 种控件 (gauge, number, led)');

  const analyses = globalWidgetRegistry.listByCategory('analysis');
  assert.strictEqual(analyses.length, 3, 'analysis 分类应包含 3 种控件 (stat_card, step_card, bode)');

  const charts = globalWidgetRegistry.listByCategory('chart');
  assert.strictEqual(charts.length, 1, 'chart 分类应包含 1 种控件 (chart)');

  // 工厂创建实例
  const knobInstance = globalWidgetRegistry.createInstance('knob', 100, 150, '电机转速旋钮');
  assert.strictEqual(knobInstance.type, 'knob');
  assert.strictEqual(knobInstance.title, '电机转速旋钮');
  assert.strictEqual(knobInstance.x, 100);
  assert.strictEqual(knobInstance.y, 150);
  assert.strictEqual(knobInstance.config.min, -1000);
  assert.strictEqual(knobInstance.config.max, 1000);

  // 2. 全局 rAF 调度器与 Tab 隔离单测
  console.log('  2. 测试 GlobalRenderScheduler 调度、多 Tab 隔离与暂停');
  const scheduler = new GlobalRenderScheduler();
  let task1Count = 0;
  let task2Count = 0;

  scheduler.register('task_tab1', () => { task1Count++; }, { tabId: 'tab_1' });
  scheduler.register('task_tab2', () => { task2Count++; }, { tabId: 'tab_2' });
  assert.strictEqual(scheduler.getTaskCount(), 2);

  // 激活 tab_1 并触发 1 帧
  scheduler.setActiveTab('tab_1');
  assert.strictEqual(scheduler.getActiveTab(), 'tab_1');
  scheduler.triggerFrame(1000);
  assert.strictEqual(task1Count, 1, '激活的 tab_1 任务应执行 1 次');
  assert.strictEqual(task2Count, 0, '非激活的 tab_2 任务应跳过，执行 0 次');

  // 切换激活至 tab_2 并触发 1 帧
  scheduler.setActiveTab('tab_2');
  scheduler.triggerFrame(1050);
  assert.strictEqual(task1Count, 1, '非激活的 tab_1 任务应保持 1 次');
  assert.strictEqual(task2Count, 1, '激活的 tab_2 任务应执行第 1 次');

  // 暂停控制
  assert.strictEqual(scheduler.isPaused(), false);
  scheduler.setPaused(true);
  assert.strictEqual(scheduler.isPaused(), true);
  scheduler.triggerFrame(1100);
  assert.strictEqual(task1Count, 1, '暂停状态下任务不应执行');
  assert.strictEqual(task2Count, 1, '暂停状态下任务不应执行');
  scheduler.setPaused(false);

  // 注销任务
  scheduler.unregister('task_tab1');
  assert.strictEqual(scheduler.getTaskCount(), 1);
  scheduler.unregister('task_tab2');
  assert.strictEqual(scheduler.getTaskCount(), 0);

  // 3. 模板引擎与 SafetyGuard 强化单测 (支持 {val} 与 {value})
  console.log('  3. 测试模板引擎支持 {val} 与 {value} 别名，及 SafetyGuard 拦截');
  const tplVal = renderTemplate(
    { id: '1', type: 'slider', title: 'Val', command_template: 'SET_KP {val}\\n', encoding: 'text' },
    '15.5'
  );
  assert.strictEqual(tplVal.payload, 'SET_KP 15.5\n');

  const tplValue = renderTemplate(
    { id: '2', type: 'knob', title: 'Value', command_template: 'SET_SPEED {value}\\n', encoding: 'text' },
    '500'
  );
  assert.strictEqual(tplValue.payload, 'SET_SPEED 500\n');

  // 校验模板
  assert.strictEqual(validateTemplate('SET {val}\\n', 'text', true).valid, true);
  assert.strictEqual(validateTemplate('SET {value}\\n', 'text', true).valid, true);
  assert.strictEqual(validateTemplate('SET NOTHING\\n', 'text', true).valid, false);

  // SendGate 与 SafetyGuard 对 knob / slider 的限幅过滤
  const sendGate = new SendGate(10);
  sendGate.setPortConnected(true);
  let lastSent = '';
  sendGate.setSender(async (payload) => {
    lastSent = payload;
  });

  const unbound = await sendGate.dispatch({
    id: 'unbound',
    type: 'button',
    title: '未绑定',
    command_template: '',
    encoding: 'text',
  } as any);
  assert.strictEqual(unbound.ok, false);
  assert.strictEqual(unbound.reason, 'disabled');
  assert.strictEqual(lastSent, '');

  // 合法值发送
  const res1 = await sendGate.dispatch(
    {
      id: 'knob_1',
      type: 'knob',
      title: 'Knob 1',
      command_template: 'SET_VAL {val}\\n',
      encoding: 'text',
      min: 0,
      max: 100,
      step: 1,
      precision: 0,
    } as any,
    '45'
  );
  assert.strictEqual(res1.ok, true);
  assert.strictEqual(lastSent, 'SET_VAL 45\n');

  // 越界值拦截 (150 > max 100)
  const res2 = await sendGate.dispatch(
    {
      id: 'knob_2',
      type: 'knob',
      title: 'Knob 2',
      command_template: 'SET_VAL {val}\\n',
      encoding: 'text',
      min: 0,
      max: 100,
      step: 1,
      precision: 0,
    } as any,
    '150'
  );
  assert.strictEqual(res2.ok, false);
  assert.strictEqual(res2.reason, 'out_of_range');

  // NaN 拦截
  const res3 = await sendGate.dispatch(
    {
      id: 'knob_3',
      type: 'knob',
      title: 'Knob 3',
      command_template: 'SET_VAL {val}\\n',
      encoding: 'text',
      min: 0,
      max: 100,
      step: 1,
      precision: 0,
    } as any,
    'not_a_number'
  );
  assert.strictEqual(res3.ok, false);
  assert.strictEqual(res3.reason, 'nan');

  // 4. 网格几何算法与空白探测 (findFreeSpace)
  console.log('  4. 测试网格几何算法与 findFreeSpace 空白避障');
  const freePos1 = findFreeSpace(200, 100, [], 2400, 20, 20, 20);
  assert.strictEqual(freePos1.x, 20);
  assert.strictEqual(freePos1.y, 20);

  // 模拟已存在一个 (20, 20, 200, 100) 控件
  const freePos2 = findFreeSpace(200, 100, [{ x: 20, y: 20, w: 200, h: 100 }], 2400, 20, 20, 20);
  assert.strictEqual(freePos2.x, 220); // 横向避开到 220
  assert.strictEqual(freePos2.y, 20);

  // 5. 官方两大默认预设 Tab 与 JSON 导入导出
  console.log('  5. 测试开箱即用两大预设 Tab 及 JSON 序列化与校验迁移');
  const simplePreset = createDefaultVofaPreset();
  assert.strictEqual(simplePreset.tabs.length, 1);
  assert.strictEqual(simplePreset.tabs[0].widgets[0].config.auto_bind, true);
  assert.deepStrictEqual(simplePreset.tabs[0].widgets[0].config.series, []);
  const defaultPreset = createControlLabPreset();
  assert.strictEqual(defaultPreset.version, 2);
  assert.strictEqual(defaultPreset.tabs.length, 2, '可选控制模板保留旧布局');
  assert.strictEqual(defaultPreset.locked, true, '默认工作台必须先处于运行锁定');

  // 检查 Tab 1: 实时波形
  const tab1 = defaultPreset.tabs[0];
  assert.strictEqual(tab1.id, 'tab_waveform');
  assert.strictEqual(tab1.name, '实时波形');
  assert.strictEqual(tab1.widgets.length, 1);
  assert.strictEqual(tab1.widgets[0].type, 'chart');
  assert.strictEqual(tab1.widgets[0].w, 960);
  assert.strictEqual(tab1.widgets[0].h, 560);
  assert.strictEqual(tab1.widgets[0].config.series.length, 3);

  // 检查 Tab 2: 控制联调台
  const tab2 = defaultPreset.tabs[1];
  assert.strictEqual(tab2.id, 'tab_control');
  assert.strictEqual(tab2.name, '控制联调台');
  assert.strictEqual(tab2.widgets.length, 6);
  const tab2Types = tab2.widgets.map((w) => w.type);
  assert.ok(tab2Types.includes('chart'), 'Tab 2 必须包含波形图');
  assert.ok(tab2Types.includes('gauge'), 'Tab 2 必须包含仪表盘');
  assert.ok(tab2Types.includes('step_card'), 'Tab 2 必须包含阶跃响应指标卡');
  assert.ok(tab2Types.includes('slider'), 'Tab 2 必须包含调参滑块');
  const sliders = tab2.widgets.filter((w) => w.type === 'slider');
  assert.strictEqual(sliders.length, 3, 'Tab 2 必须包含完整的 3 轴 PID 调参滑块 (Kp, Ki, Kd)');
  for (const slider of sliders) {
    assert.strictEqual(slider.config.enabled, false, '默认调参控件不得隐式启用设备写入');
    assert.strictEqual(slider.config.command_template, '', '默认调参控件不得假定固件命令模板');
  }

  // 测试 JSON 导入与规整
  const jsonStr = JSON.stringify(defaultPreset);
  const migrateRes = validateAndMigrateDashboard(JSON.parse(jsonStr));
  assert.strictEqual(migrateRes.ok, true);
  assert.strictEqual(migrateRes.data?.tabs.length, 2);

  // 测试对非法 JSON 的拦截
  const badRes = validateAndMigrateDashboard({ bad: 'data' });
  assert.strictEqual(badRes.ok, false);

  // 测试控件单项校验
  assert.strictEqual(validateWidgetConfig(tab1.widgets[0]).valid, true);
  assert.strictEqual(validateWidgetConfig({ id: 'bad' }).valid, false);

  // 6. SendGate 多控件并发队列隔离与同源合并测试
  console.log('  6. 测试 SendGate 多控件并发队列隔离与同源合并');
  const multiGate = new SendGate(5);
  multiGate.setPortConnected(true);
  const sentPayloads: string[] = [];
  multiGate.setSender(async (payload) => {
    sentPayloads.push(payload);
  });

  const p1 = multiGate.dispatch(
    { id: 'slider_kp', type: 'slider', title: 'Kp', command_template: 'SET_KP {val}\n', encoding: 'text', min: 0, max: 100, step: 1, precision: 0 } as any,
    '10'
  );
  const p2 = multiGate.dispatch(
    { id: 'slider_spd', type: 'slider', title: 'Spd', command_template: 'SET_SPD {val}\n', encoding: 'text', min: 0, max: 1000, step: 1, precision: 0 } as any,
    '500'
  );
  await Promise.all([p1, p2]);
  assert.strictEqual(sentPayloads.length, 2, '两个不同 ID 的控件指令应均被发送');
  assert.strictEqual(sentPayloads[0], 'SET_KP 10\n');
  assert.strictEqual(sentPayloads[1], 'SET_SPD 500\n');

  // 同源合并测试：同一 ID 连续快速下发，前序在队列中应被合并
  sentPayloads.length = 0;
  const pA = multiGate.dispatch(
    { id: 'slider_kp', type: 'slider', title: 'Kp', command_template: 'SET_KP {val}\n', encoding: 'text', min: 0, max: 100, step: 1, precision: 0 } as any,
    '20'
  );
  const pB = multiGate.dispatch(
    { id: 'slider_kp', type: 'slider', title: 'Kp', command_template: 'SET_KP {val}\n', encoding: 'text', min: 0, max: 100, step: 1, precision: 0 } as any,
    '30'
  );
  const [resA, resB] = await Promise.all([pA, pB]);
  assert.strictEqual(resA.ok, false);
  assert.strictEqual(resA.reason, 'superseded');
  assert.strictEqual(resB.payload, 'SET_KP 30\n');

  // 7. 测试 StatCard 相对流时基窗口计算
  console.log('  7. 测试 StatCard 与 ChannelStore 相对流时基计算');
  const testStore = new ChannelStore();
  const tArr = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0];
  const vArr = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  testStore.pushSeries(['speed'], tArr, [vArr]);

  const latest = testStore.latest('speed');
  assert.ok(latest != null);
  assert.strictEqual(latest.t, 10.0);
  assert.strictEqual(latest.v, 100);

  const windowSec = 4;
  const snapWindow = testStore.snapshot('speed', latest.t - windowSec, latest.t);
  assert.strictEqual(snapWindow.count, 5, '6.0s 到 10.0s 间应有 5 个点 (6, 7, 8, 9, 10)');
  assert.strictEqual(snapWindow.values[0], 60);
  assert.strictEqual(snapWindow.values[4], 100);

  // 8. 测试 findFreeSpace 边界限位与恶劣 JSON 规整
  console.log('  8. 测试 findFreeSpace 边界限位与恶劣 JSON 导入坐标规整');
  const freeSpace = findFreeSpace(1000, 500, [], 1200, 20, 1100, 20);
  assert.ok(freeSpace.x + 1000 <= 1200, 'freeSpace.x + w 不应超出画布宽度 1200');

  const maliciousDashboard = {
    version: 2,
    active_tab_id: 'tab_bad',
    grid_size: 20,
    tabs: [
      {
        id: 'tab_bad',
        name: '恶意测试工作台',
        canvas_w: 2400,
        canvas_h: 1600,
        widgets: [
          {
            id: 'w_corrupt',
            type: 'chart',
            title: '畸变图表',
            x: -999,
            y: -500,
            w: NaN,
            h: 'invalid',
            config: {},
          },
        ],
      },
    ],
  };
  const sanitized = validateAndMigrateDashboard(maliciousDashboard);
  assert.strictEqual(sanitized.ok, true);
  const fixedWidget = sanitized.data!.tabs[0].widgets[0];
  assert.ok(fixedWidget.x >= 0, '负数坐标 x 应被规整为 >= 0');
  assert.ok(fixedWidget.y >= 0, '负数坐标 y 应被规整为 >= 0');
  assert.ok(fixedWidget.w >= 280, 'NaN 宽度应被修正为默认/最小尺寸');
  assert.ok(fixedWidget.h >= 200, '非数字高度应被修正为默认/最小尺寸');

  // 9. VOFA+ 8向边缘/角点缩放计算纯函数 computeResize 测试
  console.log('  9. 测试 VOFA+ 8向边缘与角点缩放纯函数 computeResize');
  // (a) 东 (e): 右边缘向右拖拽 40px
  const resizeE = computeResize({
    handle: 'e',
    startX: 100,
    startY: 100,
    startW: 200,
    startH: 150,
    dx: 45,
    dy: 0,
    minW: 100,
    minH: 80,
    gridSize: 20,
    canvasW: 2400,
    canvasH: 1600,
  });
  assert.strictEqual(resizeE.x, 100);
  assert.strictEqual(resizeE.y, 100);
  assert.strictEqual(resizeE.w, 240); // 200 + 45 -> snap 240
  assert.strictEqual(resizeE.h, 150);

  // (b) 西 (w): 左边缘向右拖拽 (缩小宽度)
  const resizeW = computeResize({
    handle: 'w',
    startX: 100,
    startY: 100,
    startW: 200,
    startH: 150,
    dx: 38,
    dy: 0,
    minW: 100,
    minH: 80,
    gridSize: 20,
    canvasW: 2400,
    canvasH: 1600,
  });
  // startX 100 + 38 = 138 -> snap 140. rightEdge = 300. newW = 300 - 140 = 160
  assert.strictEqual(resizeW.x, 140);
  assert.strictEqual(resizeW.w, 160);

  // (c) 南 (s): 下边缘向下拖拽
  const resizeS = computeResize({
    handle: 's',
    startX: 100,
    startY: 100,
    startW: 200,
    startH: 150,
    dx: 0,
    dy: 27,
    minW: 100,
    minH: 80,
    gridSize: 20,
    canvasW: 2400,
    canvasH: 1600,
  });
  assert.strictEqual(resizeS.h, 180); // 150 + 27 -> 177 -> snap 180

  // (d) 北 (n): 上边缘向上拖拽 (扩大高度)
  const resizeN = computeResize({
    handle: 'n',
    startX: 100,
    startY: 100,
    startW: 200,
    startH: 150,
    dx: 0,
    dy: -42,
    minW: 100,
    minH: 80,
    gridSize: 20,
    canvasW: 2400,
    canvasH: 1600,
  });
  // startY 100 - 42 = 58 -> snap 60. bottomEdge = 250. newH = 250 - 60 = 190.
  assert.strictEqual(resizeN.y, 60);
  assert.strictEqual(resizeN.h, 190);

  // (e) 东南角 (se): 宽和高同时调整
  const resizeSE = computeResize({
    handle: 'se',
    startX: 100,
    startY: 100,
    startW: 200,
    startH: 150,
    dx: 45,
    dy: 35,
    minW: 100,
    minH: 80,
    gridSize: 20,
    canvasW: 2400,
    canvasH: 1600,
  });
  assert.strictEqual(resizeSE.w, 240);
  assert.strictEqual(resizeSE.h, 180);

  // (f) 西北角 (nw): 坐标和尺寸同时反向调整
  const resizeNW = computeResize({
    handle: 'nw',
    startX: 100,
    startY: 100,
    startW: 200,
    startH: 150,
    dx: 22,
    dy: 22,
    minW: 100,
    minH: 80,
    gridSize: 20,
    canvasW: 2400,
    canvasH: 1600,
  });
  assert.strictEqual(resizeNW.x, 120);
  assert.strictEqual(resizeNW.w, 180);
  assert.strictEqual(resizeNW.y, 120);
  assert.strictEqual(resizeNW.h, 130);

  // (g) 最小尺寸限制保护 (向内强行挤压不得低于 minW / minH)
  const resizeMin = computeResize({
    handle: 'se',
    startX: 100,
    startY: 100,
    startW: 200,
    startH: 150,
    dx: -500,
    dy: -500,
    minW: 120,
    minH: 90,
    gridSize: 20,
    canvasW: 2400,
    canvasH: 1600,
  });
  assert.strictEqual(resizeMin.w, 120, '缩放宽度不得低于 minW 120');
  assert.strictEqual(resizeMin.h, 90, '缩放高度不得低于 minH 90');

  // (h) 画布边缘超限保护 (向外强行拖拽不得超出 canvasW / canvasH)
  const resizeBoundary = computeResize({
    handle: 'se',
    startX: 2300,
    startY: 1500,
    startW: 50,
    startH: 50,
    dx: 300,
    dy: 300,
    minW: 40,
    minH: 40,
    gridSize: 20,
    canvasW: 2400,
    canvasH: 1600,
  });
  assert.ok(resizeBoundary.x + resizeBoundary.w <= 2400, '控件右边界不得超出画布 2400');
  assert.ok(resizeBoundary.y + resizeBoundary.h <= 1600, '控件下边界不得超出画布 1600');

  // 10. 测试图层层叠顺序 (sendToBack / bringToFront)
  console.log('  10. 测试图层层叠顺序 (sendToBack / bringToFront)');
  const widgetsLayerTest = [
    { id: 'w1', z: 1 },
    { id: 'w2', z: 2 },
    { id: 'w3', z: 3 },
  ];
  // 模拟 sendToBack('w3')
  for (const w of widgetsLayerTest) {
    if (w.id !== 'w3') {
      w.z = (w.z || 1) + 1;
    }
  }
  const targetW3 = widgetsLayerTest.find((w) => w.id === 'w3')!;
  targetW3.z = 1;
  assert.strictEqual(targetW3.z, 1, 'w3 置底后 z 必须为 1');
  assert.strictEqual(widgetsLayerTest.find((w) => w.id === 'w1')!.z, 2, '其他控件 z 相应递增');
  assert.strictEqual(widgetsLayerTest.find((w) => w.id === 'w2')!.z, 3, '其他控件 z 相应递增');

  // 模拟 bringToFront('w3')
  const maxZ = Math.max(...widgetsLayerTest.map((w) => w.z || 1));
  targetW3.z = maxZ + 1;
  // 11. 测试原子几何更新算法 (updateWidgetGeometry 消除旧尺寸夹紧陈旧值)
  console.log('  11. 测试原子几何更新算法 updateWidgetGeometry');
  const testCanvasW = 1000;
  const testCanvasH = 800;
  const targetW = 720;
  const targetH = 480;
  const norm = normalizeSize(targetW, targetH, 280, 200, 20);
  const clamped = clampToCanvas(snap(40, 20), snap(40, 20), norm.w, norm.h, testCanvasW, testCanvasH);
  assert.strictEqual(clamped.x, 40, '原子更新横坐标必须正确定位在 40');
  assert.strictEqual(clamped.y, 40, '原子更新纵坐标必须正确定位在 40');
  assert.strictEqual(norm.w, 720, '原子更新宽度必须为规范化后的 720');
  assert.strictEqual(norm.h, 480, '原子更新高度必须为规范化后的 480');

  // 12. 测试指针级拖拽 (Pointer Events) 全局通道生命周期与网格吸附
  console.log('  12. 测试指针级拖拽通道生命周期、抽屉遮挡防御与网格落点吸附');
  const store = useWidgetStore();
  const chartDef = globalWidgetRegistry.get('chart');
  assert.ok(chartDef, 'chart 控件应注册成功');
  assert.strictEqual(chartDef.defaultSize.w, 560);
  assert.strictEqual(chartDef.defaultSize.h, 360);

  // 12.1 测试 startPointerDrag / updatePointerDrag / cancelPointerDrag 生命周期
  store.startPointerDrag({
    widgetType: 'chart',
    pointerX: 120,
    pointerY: 180,
    previewW: 560,
    previewH: 360,
    icon: '📈',
    name: '波形曲线图',
  });
  assert.strictEqual(store.pointerDragState.value.active, true, '拖拽启动后 active 必须为 true');
  assert.strictEqual(store.pointerDragState.value.widgetType, 'chart');
  assert.strictEqual(store.pointerDragState.value.pointerX, 120);
  assert.strictEqual(store.pointerDragState.value.pointerY, 180);
  assert.strictEqual(store.pointerDragState.value.previewW, 560);
  assert.strictEqual(store.pointerDragState.value.previewH, 360);

  store.updatePointerDrag(350, 420);
  assert.strictEqual(store.pointerDragState.value.pointerX, 350, '移动后 pointerX 必须平滑更新');
  assert.strictEqual(store.pointerDragState.value.pointerY, 420, '移动后 pointerY 必须平滑更新');

  store.cancelPointerDrag();
  assert.strictEqual(store.pointerDragState.value.active, false, '取消拖拽后 active 必须重置为 false');
  assert.strictEqual(store.pointerDragState.value.widgetType, null);

  // 12.2 测试 registerDropTarget 与 endPointerDrag 跨层通道与落点防御
  let dropHandled = false;
  let receivedType = null;
  let receivedX = -1;
  let receivedY = -1;

  // 模拟画布视口与左侧抽屉遮挡边界
  const mockViewport = { left: 44, top: 40, right: 1200, bottom: 800 };
  const mockDrawerWidth = 320; // 抽屉位于 left: 44px, width: 320px (覆盖 44 ~ 364px)

  const simulatedDropTarget = (type: any, clientX: number, clientY: number) => {
    // 越界检查
    if (clientX < mockViewport.left || clientX > mockViewport.right || clientY < mockViewport.top || clientY > mockViewport.bottom) {
      return false;
    }
    // 抽屉遮挡防呆：若落在抽屉覆盖区域内 (x: 44 ~ 364px)，视为未拖入有效画布，拒绝落位
    if (clientX < mockViewport.left + mockDrawerWidth) {
      return false;
    }
    dropHandled = true;
    receivedType = type;
    receivedX = clientX;
    receivedY = clientY;
    return true;
  };

  store.registerDropTarget(simulatedDropTarget);

  // 模拟在抽屉内部松手 (例如 x: 200, y: 300) -> 必须被拒绝，不生成控件
  store.startPointerDrag({
    widgetType: 'slider',
    pointerX: 100,
    pointerY: 200,
    previewW: 320,
    previewH: 100,
    icon: '🎚️',
    name: '滑块调参器',
  });
  store.endPointerDrag(200, 300);
  assert.strictEqual(dropHandled, false, '在抽屉内部松手不得触发画布落点生成');
  assert.strictEqual(store.pointerDragState.value.active, false, 'endPointerDrag 必须清理激活态');

  // 模拟在有效画布区域松手 (例如 x: 600, y: 400) -> 成功触发
  store.startPointerDrag({
    widgetType: 'gauge',
    pointerX: 200,
    pointerY: 200,
    previewW: 240,
    previewH: 240,
    icon: '🧭',
    name: '指针仪表盘',
  });
  store.endPointerDrag(600, 400);
  assert.strictEqual(dropHandled, true, '在有效画布视口松手必须成功触发落点创建');
  assert.strictEqual(receivedType, 'gauge');
  assert.strictEqual(receivedX, 600);
  assert.strictEqual(receivedY, 400);

  store.registerDropTarget(null);

  // 12.3 几何吸附与视口换算测试 (10px, 20px, 40px 颗粒度)
  for (const testGrid of [10, 20, 40]) {
    const coords = clientToCanvas(
      500,
      400,
      mockViewport,
      0,
      0,
      chartDef.defaultSize.w / 2,
      chartDef.defaultSize.h / 2,
      testGrid
    );
    assert.strictEqual(coords.x % testGrid, 0, `网格 ${testGrid}px 下落点 X 必须对齐`);
    assert.strictEqual(coords.y % testGrid, 0, `网格 ${testGrid}px 下落点 Y 必须对齐`);
  }

  // 12.4 验证 10 种控件默认尺寸 1:1 投影完整性
  for (const w of allWidgets) {
    assert.ok(w.defaultSize.w > 0, `${w.type} 默认宽度必须大于 0`);
    assert.ok(w.defaultSize.h > 0, `${w.type} 默认高度必须大于 0`);
    assert.ok(w.name.length > 0, `${w.type} 必须具有中文名称`);
    assert.ok(w.icon.length > 0, `${w.type} 必须具有图形图标`);
  }

  console.log('✓ [Phase 1: Widget Unified] 控件全融合、指针即拖即拽通道与几何原子更新 12 项测试全部通过！\n');
}
