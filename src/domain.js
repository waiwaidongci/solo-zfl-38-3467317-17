// 桅杆损伤与寿命领域计算（纯函数，便于单测）
//
// 损伤口径：
//  - 截面损失率 loss = 截面型缺损(裂纹+腐蚀) + 绳用桅杆断丝占比
//  - 应力比  stressRatio = 工作应力 / 许用应力（剩余截面会放大工作应力）
//  - 疲劳损伤 fatigue = Σ(新增循环 / S-N 曲线在该载荷下的允许循环)，Miner 累计
//  - 声速衰减 velocityDrop = 1 - v / v0（内部裂纹使超声速下降）
// 安全等级：停用线 / 监测线 / 正常，任一指标越线按最严等级取值。

export const SECTIONS = ["圆管", "实心圆杆", "矩形杆", "绳缆"];

// 监测线（持续跟踪）与停用线（立即冻结）阈值
export const THRESHOLDS = {
  lossMonitor: 0.05,      // 剩余截面损失 ≥5% 进入监测
  lossStop: 0.15,         // ≥15% 停用
  stressMonitor: 0.7,     // 应力比 ≥0.7 监测
  stressStop: 1.0,        // ≥许用应力停用
  fatigueMonitor: 0.3,    // Miner 累计 ≥0.3 监测
  fatigueStop: 0.8,       // ≥0.8 停用
  velocityMonitor: 0.05,  // 声速衰减 ≥5% 监测
  velocityStop: 0.12,     // ≥12% 停用
  // S-N 曲线：N = N0 * (refStress / stress)^m（应力以 MPa 计）
  snN0: 2_000_000,
  snM: 3,
  snRefStress: 100,
};

// 登记时由截面形状与尺寸计算公称面积（mm²）
// 圆管: π(D²-d²)/4；实心圆杆: πD²/4；矩形杆: b·t；绳缆: 按公称直径折减 0.65
export function nominalArea(section, dims = {}) {
  const { outerD, innerD, width, thickness, diameter } = dims;
  switch (section) {
    case "圆管": {
      const D = Number(outerD) || 0;
      const d = Number(innerD) || 0;
      if (D <= 0) throw new Error("outerD_required");
      if (d >= D) throw new Error("innerD_invalid");
      return (Math.PI * (D * D - d * d)) / 4;
    }
    case "实心圆杆": {
      const D = Number(diameter || outerD) || 0;
      if (D <= 0) throw new Error("diameter_required");
      return (Math.PI * D * D) / 4;
    }
    case "矩形杆": {
      const b = Number(width) || 0;
      const t = Number(thickness) || 0;
      if (b <= 0 || t <= 0) throw new Error("width_thickness_required");
      return b * t;
    }
    case "绳缆": {
      const D = Number(diameter || outerD) || 0;
      if (D <= 0) throw new Error("diameter_required");
      return 0.65 * (Math.PI * D * D) / 4;
    }
    default:
      throw new Error("section_invalid");
  }
}

// 单条检测记录造成的“本次截面损失”（相对公称面积）
// 裂纹按等效深度×长度估算（长度不超过0.5倍特征尺寸，防穿透高估）
// 腐蚀按坑深×坑宽估算；断丝按丝数占比
export function inspectionLoss(mast, ins) {
  const { section, nominalArea: area, dims } = mast;
  let lossArea = 0;
  const crackDepth = Number(ins.crackDepth) || 0;
  const crackLength = Number(ins.crackLength) || 0;
  if (crackDepth > 0 && crackLength > 0) {
    const feature = section === "矩形杆"
      ? Number(dims.thickness)
      : Number(dims.outerD || dims.diameter) || 0;
    const effLength = feature > 0 ? Math.min(crackLength, 0.5 * feature) : crackLength;
    lossArea += crackDepth * effLength;
  }
  const corDepth = Number(ins.corrosionDepth) || 0;
  const corWidth = Number(ins.corrosionWidth) || 0;
  if (corDepth > 0 && corWidth > 0) lossArea += corDepth * corWidth;
  return area > 0 ? lossArea / area : 0;
}

export function brokenWireRatio(mast, ins) {
  if (mast.section !== "绳缆") return 0;
  const total = Number(mast.dims.wireCount) || 0;
  const broken = Number(ins.brokenWires) || 0;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(1, broken / total));
}

// 由历次检测累计截面损失。复检通过时，服务层会把旧检测标记为 superseded，
// 复检记录本身作为修复后新基线，其残余缺损仍计入当前状态。
export function aggregateSectionLoss(mast, inspections) {
  let loss = 0;
  for (const ins of inspections) {
    if (ins.superseded) continue;
    loss += inspectionLoss(mast, ins) + brokenWireRatio(mast, ins);
  }
  return Math.min(loss, 1);
}

// Miner 累计疲劳：每条检测提交“本次新增循环”和当时载荷，按 S-N 允许循环累加
export function fatigueDamage(inspections, mast) {
  let dmg = 0;
  for (const ins of inspections) {
    if (ins.superseded) continue;
    const cycles = Number(ins.cycles) || 0;
    if (cycles <= 0) continue;
    const stress = cycleStress(Number(ins.load) || 0, mast, mast.nominalArea);
    const allowed = allowedCycles(stress);
    dmg += allowed > 0 ? cycles / allowed : 1;
  }
  return Math.min(dmg, 1);
}

export function allowedCycles(stressMpa) {
  if (stressMpa <= 0) return Infinity;
  const { snN0, snM, snRefStress } = THRESHOLDS;
  return snN0 * Math.pow(snRefStress / stressMpa, snM);
}

// 载荷 kN、面积 mm² → MPa
export function cycleStress(loadKn, mast, areaMm2) {
  const area = areaMm2 || mast.nominalArea;
  if (!area || area <= 0) return 0;
  return (Number(loadKn) || 0) * 1000 / area;
}

// 当前工作应力比，剩余截面越小应力越高
export function stressRatio(mast, loss, loadKn) {
  const allowed = Number(mast.allowableStress) || 0;
  const remainingArea = mast.nominalArea * (1 - loss);
  if (allowed <= 0 || remainingArea <= 0) return 0;
  return cycleStress(loadKn, mast, remainingArea) / allowed;
}

export function velocityDrop(mast, ins) {
  const v0 = Number(mast.baselineVelocity) || 0;
  const v = Number(ins.velocity) || 0;
  if (v0 <= 0 || v <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - v / v0));
}

// 判定单指标越线
function level(value, monitor, stop) {
  if (value >= stop) return 2;
  if (value >= monitor) return 1;
  return 0;
}

export const GRADE_LABEL = ["正常", "监测", "停用"];

// 汇总一次评估。loss/fatigue 为累计值，latest 为最新检测。
export function evaluate({ loss = 0, fatigue = 0, stress = 0, velocity = 0 }) {
  const T = THRESHOLDS;
  const checks = [
    { key: "loss", name: "剩余截面", value: loss, monitor: T.lossMonitor, stop: T.lossStop, fmt: "pct" },
    { key: "stress", name: "应力比", value: stress, monitor: T.stressMonitor, stop: T.stressStop, fmt: "ratio" },
    { key: "fatigue", name: "累计疲劳", value: fatigue, monitor: T.fatigueMonitor, stop: T.fatigueStop, fmt: "ratio" },
    { key: "velocity", name: "声速衰减", value: velocity, monitor: T.velocityMonitor, stop: T.velocityStop, fmt: "pct" },
  ];
  const gradeLevel = checks.reduce((mx, c) => Math.max(mx, level(c.value, c.monitor, c.stop)), 0);
  const blockers = checks.filter(c => level(c.value, c.monitor, c.stop) === 2)
    .map(c => `${c.name}达到停用线(${formatMetric(c.fmt, c.value)})`);
  const monitors = checks.filter(c => level(c.value, c.monitor, c.stop) >= 1)
    .map(c => `${c.name}${level(c.value, c.monitor, c.stop) === 2 ? "达停用线" : "达监测线"}(${formatMetric(c.fmt, c.value)})`);
  return {
    grade: GRADE_LABEL[gradeLevel],
    gradeLevel,
    loss, fatigue, stress, velocity,
    blockers, monitors,
  };
}

function formatMetric(fmt, v) {
  return fmt === "pct" ? `${(v * 100).toFixed(1)}%` : v.toFixed(2);
}

// 剩余寿命：给出疲劳剩余循环，以及在当前年循环强度下的剩余年数
// 同时依据截面/声速越线情况给出处置建议。
export function remainingLife(mast, inspections, fatigue, loss, latestLoadKn) {
  const usedStress = cycleStress(Number(latestLoadKn) || 0, mast, mast.nominalArea * (1 - loss));
  const allowed = allowedCycles(usedStress);
  const capacityLeft = Math.max(0, THRESHOLDS.fatigueStop - fatigue) / THRESHOLDS.fatigueStop;
  const cyclesLeft = Number.isFinite(allowed)
    ? Math.max(0, Math.round(allowed * (THRESHOLDS.fatigueStop - fatigue)))
    : null;
  const annual = annualCycleRate(inspections);
  const yearsLeft = cyclesLeft != null && annual > 0 ? cyclesLeft / annual : null;
  const advice = loss >= THRESHOLDS.lossStop
    ? "截面已达停用线，立即停用并安排修复复检"
    : fatigue >= THRESHOLDS.fatigueStop
      ? "疲劳累计达停用线，立即停用"
      : capacityLeft <= 0.25
        ? "寿命余量不足25%，缩短检测周期"
        : "按周期持续跟踪";
  return { cyclesLeft, yearsLeft: yearsLeft == null ? null : Number(yearsLeft.toFixed(2)), annualCycles: annual, advice };
}

// 由历次检测的累计循环推算年均循环强度（按首末检测时间跨度）
function annualCycleRate(inspections) {
  const withCycles = inspections.filter(i => (Number(i.cycles) || 0) > 0);
  if (withCycles.length < 2) return 0; // 单条记录无法估算年循环强度
  const total = withCycles.reduce((n, i) => n + Number(i.cycles), 0);
  const first = new Date(withCycles[0].at).getTime();
  const last = new Date(withCycles[withCycles.length - 1].at).getTime();
  const years = (last - first) / (365.25 * 24 * 3600 * 1000);
  // 时间跨度不足一天时无法可靠推算年强度，返回 0（剩余年数显示为“数据不足”）
  if (!years || years < 1 / 365) return 0;
  return total / years;
}
