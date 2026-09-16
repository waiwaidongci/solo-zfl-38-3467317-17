import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nominalArea, inspectionLoss, brokenWireRatio, aggregateSectionLoss,
  fatigueDamage, allowedCycles, cycleStress, stressRatio, velocityDrop,
  evaluate, remainingLife, THRESHOLDS,
} from "../src/domain.js";

test("公称面积：四种截面", () => {
  assert.ok(Math.abs(nominalArea("圆管", { outerD: 120, innerD: 100 }) - 3455.75) < 0.1);
  assert.ok(Math.abs(nominalArea("实心圆杆", { diameter: 40 }) - 1256.64) < 0.1);
  assert.equal(nominalArea("矩形杆", { width: 60, thickness: 20 }), 1200);
  assert.ok(Math.abs(nominalArea("绳缆", { diameter: 40 }) - 0.65 * 1256.64) < 0.1);
  assert.throws(() => nominalArea("圆管", { outerD: 10, innerD: 12 }), /innerD_invalid/);
  assert.throws(() => nominalArea("矩形杆", { width: 0 }), /width_thickness_required/);
});

test("截面损失：裂纹长度截断到0.5倍特征尺寸，腐蚀与断丝叠加", () => {
  const mast = { section: "圆管", nominalArea: 1000, dims: { outerD: 100, innerD: 80 } };
  // 裂纹 1×200，圆管外径100 → 有效长度 50（0.5×100）→ 50/1000 = 5%
  const crack = inspectionLoss(mast, { crackDepth: 1, crackLength: 200 });
  assert.ok(Math.abs(crack - 0.05) < 1e-9);
  // 腐蚀 2×5 = 10 → 1%
  const cor = inspectionLoss(mast, { corrosionDepth: 2, corrosionWidth: 5 });
  assert.ok(Math.abs(cor - 0.01) < 1e-12);
  // 多条累计
  const total = aggregateSectionLoss(mast, [
    { crackDepth: 1, crackLength: 200 },
    { corrosionDepth: 2, corrosionWidth: 5 },
  ]);
  assert.ok(Math.abs(total - 0.06) < 1e-9);
  // 绳缆断丝占比
  const rope = { section: "绳缆", nominalArea: 100, dims: { wireCount: 100 } };
  assert.equal(brokenWireRatio(rope, { brokenWires: 12 }), 0.12);
  // 复检通过：旧损伤被修复核销（superseded），复检残余作为新基线计入
  const healed = aggregateSectionLoss(mast, [
    { crackDepth: 10, crackLength: 200, superseded: true },
    { crackDepth: 2, crackLength: 10 }, // 残余裂纹 2×10/1000 = 2%
  ]);
  assert.ok(Math.abs(healed - 0.02) < 1e-9);
});

test("疲劳：S-N 曲线与 Miner 累计随载荷/循环单调上升", () => {
  const N = allowedCycles(100);
  assert.equal(N, THRESHOLDS.snN0);
  assert.ok(allowedCycles(200) < allowedCycles(100));
  const mast = { section: "圆管", nominalArea: 1000, allowableStress: 100 };
  const dmg1 = fatigueDamage([{ load: 200, cycles: 1000 }], mast);
  const dmg2 = fatigueDamage([{ load: 200, cycles: 1000 }, { load: 200, cycles: 1000 }], mast);
  assert.ok(dmg2 > dmg1 && dmg1 > 0);
  // 200kN / 1000mm² = 200MPa；N = 2e6 * (100/200)^3 = 250000；1000/250000 = 0.004
  assert.ok(Math.abs(dmg1 - 0.004) < 1e-9);
});

test("应力比：剩余截面越小工作应力越高", () => {
  const mast = { nominalArea: 1000, allowableStress: 100 };
  // 100kN / 1000mm² = 100MPa → 1.0
  assert.ok(Math.abs(stressRatio(mast, 0, 100) - 1.0) < 1e-12);
  // 截面损失 50% 后，50kN 也能打到 1.0
  assert.ok(Math.abs(stressRatio(mast, 0.5, 50) - 1.0) < 1e-12);
  assert.equal(cycleStress(1, mast, 1000), 1);
});

test("声速衰减与阈值判定", () => {
  const mast = { baselineVelocity: 3200 };
  assert.ok(Math.abs(velocityDrop(mast, { velocity: 3040 }) - 0.05) < 1e-12);
  assert.equal(evaluate({ loss: 0, fatigue: 0, stress: 0, velocity: 0 }).grade, "正常");
  const mon = evaluate({ loss: 0.05 });
  assert.equal(mon.grade, "监测");
  assert.ok(mon.monitors.join().includes("剩余截面"));
  const stop = evaluate({ loss: 0.15 });
  assert.equal(stop.grade, "停用");
  assert.ok(stop.blockers.join().includes("停用线"));
  // 多个指标时取最严
  const mixed = evaluate({ loss: 0.06, fatigue: 0.9 });
  assert.equal(mixed.grade, "停用");
  assert.ok(mixed.blockers.some(b => b.includes("累计疲劳")));
  // 应力/声速各自独立越线
  assert.equal(evaluate({ stress: 1.0 }).grade, "停用");
  assert.equal(evaluate({ velocity: 0.12 }).grade, "停用");
  assert.equal(evaluate({ stress: 0.7 }).grade, "监测");
});

test("剩余寿命：按 S-N 余量给剩余循环与年数", () => {
  const mast = { section: "圆管", nominalArea: 1000, allowableStress: 100 };
  const inspections = [
    { at: "2025-01-01T00:00:00Z", load: 100, cycles: 100000 },
    { at: "2026-01-01T00:00:00Z", load: 100, cycles: 100000 },
  ];
  const fatigue = fatigueDamage(inspections, mast);
  const life = remainingLife(mast, inspections, fatigue, 0, 100);
  // 100MPa 下 N=2e6，距 0.8 的余量折算剩余循环
  assert.ok(life.cyclesLeft > 0 && life.cyclesLeft < 2_000_000);
  assert.ok(life.yearsLeft > 0);
  assert.ok(life.annualCycles >= 190000);
  assert.equal(typeof life.advice, "string");
  // 零载荷 → 寿命不被疲劳限制（null 表示无疲劳寿命上限）
  const idle = remainingLife(mast, [], 0, 0, 0);
  assert.equal(idle.cyclesLeft, null);
});

test("同批检测时间跨度过短时不推算年均循环（避免约0年的噪声）", () => {
  const mast = { section: "圆管", nominalArea: 1000, allowableStress: 100 };
  const t = "2026-09-16T08:00:00.000Z";
  const sameBatch = [
    { at: t, load: 100, cycles: 100000 },
    { at: "2026-09-16T08:00:01.000Z", load: 100, cycles: 100000 },
  ];
  const fatigue = fatigueDamage(sameBatch, mast);
  const life = remainingLife(mast, sameBatch, fatigue, 0, 100);
  assert.equal(life.annualCycles, 0, "1 秒跨度不推算年强度");
  assert.equal(life.yearsLeft, null, "无年强度时剩余年数为 null（页面显示数据不足）");
});
