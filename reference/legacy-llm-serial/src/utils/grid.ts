/**
 * 自由网格几何计算纯函数 (VOFA+ 坐标与吸附算法)
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 将数值吸附到指定网格步长
 */
export function snap(val: number, gridSize: number): number {
  if (gridSize <= 0) return Math.round(val);
  return Math.round(val / gridSize) * gridSize;
}

/**
 * 边界限位保护：确保控件完整处于画布可见坐标系内 (x ≥ 0, y ≥ 0)
 */
export function clampToCanvas(
  x: number,
  y: number,
  w: number,
  h: number,
  canvasW: number,
  canvasH: number
): { x: number; y: number } {
  const clampedX = Math.max(0, Math.min(x, canvasW - w));
  const clampedY = Math.max(0, Math.min(y, canvasH - h));
  return { x: clampedX, y: clampedY };
}

/**
 * 尺寸规格化：确保宽度与高度满足最小尺寸并向上对齐网格步长
 */
export function normalizeSize(
  w: number,
  h: number,
  minW: number,
  minH: number,
  gridSize: number
): { w: number; h: number } {
  const snappedMinW = Math.ceil(minW / gridSize) * gridSize;
  const snappedMinH = Math.ceil(minH / gridSize) * gridSize;
  const snappedW = Math.max(snappedMinW, snap(w, gridSize));
  const snappedH = Math.max(snappedMinH, snap(h, gridSize));
  return { w: snappedW, h: snappedH };
}

/**
 * 屏幕鼠标绝对坐标换算为画布坐标 (含视口滚动偏移与抓取位移)
 */
export function clientToCanvas(
  clientX: number,
  clientY: number,
  canvasRect: { left: number; top: number },
  scrollLeft: number,
  scrollTop: number,
  grabOffsetX: number = 0,
  grabOffsetY: number = 0,
  gridSize: number = 20
): { x: number; y: number } {
  // 1. 相对画布视口的局部坐标
  const rawX = clientX - canvasRect.left;
  const rawY = clientY - canvasRect.top;

  // 2. 叠加上画布内部的滚动偏移量并减去抓取点偏差
  const canvasX = rawX + scrollLeft - grabOffsetX;
  const canvasY = rawY + scrollTop - grabOffsetY;

  // 3. 吸附网格并保证非负
  const snappedX = Math.max(0, snap(canvasX, gridSize));
  const snappedY = Math.max(0, snap(canvasY, gridSize));

  return { x: snappedX, y: snappedY };
}

/**
 * 寻找画布中不与现有控件重叠的空白网格放置点
 */
export function findFreeSpace(
  w: number,
  h: number,
  existingWidgets: Rect[],
  canvasW: number = 2400,
  gridSize: number = 20,
  startX: number = 20,
  startY: number = 20
): { x: number; y: number } {
  const originX = Math.max(0, Math.min(snap(startX, gridSize), Math.max(0, canvasW - w)));
  let curX = originX;
  let curY = Math.max(0, snap(startY, gridSize));

  const isOverlapping = (x: number, y: number): boolean => {
    for (const item of existingWidgets) {
      if (
        x < item.x + item.w &&
        x + w > item.x &&
        y < item.y + item.h &&
        y + h > item.y
      ) {
        return true;
      }
    }
    return false;
  };

  let loopGuard = 0;
  while (isOverlapping(curX, curY) && loopGuard++ < 1000) {
    curX += gridSize;
    if (curX + w > canvasW) {
      curX = originX;
      curY += gridSize;
    }
  }

  return { x: curX, y: curY };
}

export type ResizeHandle = 'n' | 's' | 'w' | 'e' | 'nw' | 'ne' | 'sw' | 'se';

export interface ResizeParams {
  handle: ResizeHandle;
  startX: number;
  startY: number;
  startW: number;
  startH: number;
  dx: number;
  dy: number;
  minW: number;
  minH: number;
  gridSize: number;
  canvasW: number;
  canvasH: number;
}

/**
 * 8向拉伸几何计算纯函数 (VOFA+ 多向边缘/边角拉伸吸附与最小尺寸/画布边界约束)
 */
export function computeResize(params: ResizeParams): { x: number; y: number; w: number; h: number } {
  const { handle, startX, startY, startW, startH, dx, dy, minW, minH, gridSize, canvasW, canvasH } = params;
  let newX = startX;
  let newY = startY;
  let newW = startW;
  let newH = startH;

  // 横向计算
  if (handle.includes('e')) {
    // 向东 (右边缘/右上/右下角) 调整：左边缘固定，改变宽度
    const targetW = snap(startW + dx, gridSize);
    newW = Math.max(minW, targetW);
    newW = Math.min(newW, Math.max(minW, canvasW - startX));
  } else if (handle.includes('w')) {
    // 向西 (左边缘/左上/左下角) 调整：右边缘固定，改变坐标与宽度
    const rightEdge = startX + startW;
    let targetX = snap(startX + dx, gridSize);
    targetX = Math.max(0, targetX);
    targetX = Math.min(rightEdge - minW, targetX);
    newX = targetX;
    newW = rightEdge - newX;
  }

  // 纵向计算
  if (handle.includes('s')) {
    // 向南 (下边缘/左下/右下角) 调整：上边缘固定，改变高度
    const targetH = snap(startH + dy, gridSize);
    newH = Math.max(minH, targetH);
    newH = Math.min(newH, Math.max(minH, canvasH - startY));
  } else if (handle.includes('n')) {
    // 向北 (上边缘/左上/右上角) 调整：下边缘固定，改变坐标与高度
    const bottomEdge = startY + startH;
    let targetY = snap(startY + dy, gridSize);
    targetY = Math.max(0, targetY);
    targetY = Math.min(bottomEdge - minH, targetY);
    newY = targetY;
    newH = bottomEdge - newY;
  }

  return { x: newX, y: newY, w: newW, h: newH };
}
