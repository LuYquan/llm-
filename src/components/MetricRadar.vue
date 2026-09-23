<script setup lang="ts">
import { computed } from 'vue';

export interface RadarScores {
  overshoot_score: number;
  speed_score: number;
  steady_score: number;
  damping_score: number;
  robust_score: number;
}

const props = withDefaults(
  defineProps<{
    scores?: RadarScores;
  }>(),
  {
    scores: () => ({
      overshoot_score: 85,
      speed_score: 75,
      steady_score: 90,
      damping_score: 80,
      robust_score: 88,
    }),
  }
);

// 5 个维度的标签与键
const axes = [
  { key: 'overshoot_score', label: '超调量 Mp' },
  { key: 'speed_score', label: '响应速度 tr' },
  { key: 'damping_score', label: '阻尼特性 ζ' },
  { key: 'robust_score', label: '系统鲁棒性' },
  { key: 'steady_score', label: '稳态精度 ess' },
];

const size = 220;
const center = size / 2;
const radius = 75;

// 计算多边形顶点坐标
function getCoords(index: number, total: number, r: number) {
  // 从正上方开始 ( - PI / 2 )
  const angle = (Math.PI * 2 * index) / total - Math.PI / 2;
  return {
    x: center + r * Math.cos(angle),
    y: center + r * Math.sin(angle),
  };
}

// 生成背景参考同心五边形
const backgroundPolygons = computed(() => {
  const levels = [0.25, 0.5, 0.75, 1.0];
  return levels.map((lvl) => {
    const points = axes
      .map((_, i) => {
        const { x, y } = getCoords(i, axes.length, radius * lvl);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
    return { points, level: lvl };
  });
});

// 计算当前得分数据多边形
const dataPolygon = computed(() => {
  const points = axes
    .map((axis, i) => {
      const score = Math.max(0, Math.min(100, (props.scores as any)[axis.key] ?? 50));
      const r = (score / 100) * radius;
      const { x, y } = getCoords(i, axes.length, r);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return points;
});

// 计算每个顶点的圆点与标签位置
const vertexPoints = computed(() => {
  return axes.map((axis, i) => {
    const score = Math.max(0, Math.min(100, (props.scores as any)[axis.key] ?? 50));
    const r = (score / 100) * radius;
    const { x, y } = getCoords(i, axes.length, r);

    // 标签坐标 (略向外偏移)
    const labelPos = getCoords(i, axes.length, radius + 22);

    return {
      x,
      y,
      score,
      labelX: labelPos.x,
      labelY: labelPos.y,
      label: axis.label,
    };
  });
});

// 计算综合平均分
const averageScore = computed(() => {
  const s = props.scores;
  const total =
    s.overshoot_score +
    s.speed_score +
    s.steady_score +
    s.damping_score +
    s.robust_score;
  return Math.round(total / 5);
});
</script>

<template>
  <div class="metric-radar-card">
    <div class="card-header">
      <div class="title-group">
        <span class="radar-icon">🎯</span>
        <span class="card-title">控制品质五维雷达</span>
      </div>
      <span class="overall-badge" :class="averageScore >= 80 ? 'badge-good' : 'badge-warn'">
        综合: {{ averageScore }} 分
      </span>
    </div>

    <div class="radar-container">
      <svg class="radar-svg" :viewBox="`0 0 ${size} ${size}`">
        <defs>
          <linearGradient id="radarGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.6" />
            <stop offset="100%" stop-color="#34d399" stop-opacity="0.3" />
          </linearGradient>
        </defs>

        <!-- 背景多边形网格 -->
        <polygon
          v-for="(grid, idx) in backgroundPolygons"
          :key="idx"
          :points="grid.points"
          class="grid-polygon"
          :class="{ 'grid-outer': grid.level === 1.0 }"
        />

        <!-- 轴线 -->
        <line
          v-for="(_, i) in axes"
          :key="i"
          :x1="center"
          :y1="center"
          :x2="getCoords(i, axes.length, radius).x"
          :y2="getCoords(i, axes.length, radius).y"
          class="axis-line"
        />

        <!-- 数据填充面 -->
        <polygon :points="dataPolygon" class="data-area" fill="url(#radarGrad)" />

        <!-- 顶点圆点 -->
        <circle
          v-for="(pt, idx) in vertexPoints"
          :key="idx"
          :cx="pt.x"
          :cy="pt.y"
          r="3"
          class="vertex-dot"
        />

        <!-- 轴标签与分值 -->
        <text
          v-for="(pt, idx) in vertexPoints"
          :key="'lbl-' + idx"
          :x="pt.labelX"
          :y="pt.labelY"
          text-anchor="middle"
          dominant-baseline="central"
          class="axis-text font-mono"
        >
          <tspan class="text-label">{{ pt.label }}</tspan>
          <tspan class="text-score" dx="3">({{ pt.score }})</tspan>
        </text>
      </svg>
    </div>
  </div>
</template>

<style scoped>
.metric-radar-card {
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.card-header {
  padding: 8px 12px;
  background-color: rgba(24, 34, 50, 0.6);
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.title-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.radar-icon {
  font-size: 13px;
}

.card-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.overall-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
}

.badge-good {
  background-color: rgba(16, 185, 129, 0.15);
  color: var(--accent-emerald);
  border: 1px solid rgba(16, 185, 129, 0.3);
}

.badge-warn {
  background-color: rgba(245, 158, 11, 0.15);
  color: var(--accent-amber);
  border: 1px solid rgba(245, 158, 11, 0.3);
}

.radar-container {
  padding: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.radar-svg {
  width: 100%;
  max-width: 260px;
  height: auto;
  overflow: visible;
}

.grid-polygon {
  fill: rgba(15, 23, 42, 0.4);
  stroke: rgba(51, 65, 85, 0.4);
  stroke-width: 1;
}

.grid-outer {
  stroke: rgba(100, 116, 139, 0.5);
}

.axis-line {
  stroke: rgba(51, 65, 85, 0.5);
  stroke-width: 1;
}

.data-area {
  stroke: #38bdf8;
  stroke-width: 2;
  transition: all 0.3s ease;
}

.vertex-dot {
  fill: #34d399;
  stroke: #0f172a;
  stroke-width: 1.5;
  transition: all 0.3s ease;
}

.axis-text {
  font-size: 9px;
  fill: var(--text-secondary);
}

.text-score {
  fill: var(--accent-cyan);
  font-weight: 600;
}

.font-mono {
  font-family: var(--font-mono);
}
</style>
