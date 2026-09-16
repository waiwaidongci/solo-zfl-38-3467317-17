// 桅杆业务服务：登记、检测、修复单+异人复核、复检、放行、与旧工作台冻结联动。
// 所有写操作通过 store.mutate 串行事务执行；服务层只在 db 上做原地变更并返回结果。

import {
  SECTIONS, nominalArea, aggregateSectionLoss, fatigueDamage,
  stressRatio, velocityDrop, evaluate, remainingLife,
} from "./domain.js";
import { HttpError } from "./store.js";

let seq = 0;
export function genId(prefix) {
  seq = (seq + 1) % 100000;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}`;
}

function required(value, code) {
  if (value === undefined || value === null || String(value).trim() === "") throw new HttpError(400, code);
  return value;
}

// 依据全部历史检测重算桅杆快照（等级/寿命/冻结/阻断原因），每次写后调用
function recompute(mast) {
  const activeInspections = mast.inspections.filter(i => !i.superseded);
  const loss = aggregateSectionLoss(mast, activeInspections);
  const fatigue = fatigueDamage(activeInspections, mast);
  const latest = mast.inspections[mast.inspections.length - 1];
  const loadKn = latest ? Number(latest.load) || 0 : 0;
  const stress = stressRatio(mast, loss, loadKn);
  const velocity = latest ? velocityDrop(mast, latest) : 0;
  const ev = evaluate({ loss, fatigue, stress, velocity });
  const life = remainingLife(mast, activeInspections, fatigue, loss, loadKn);

  const prevGrade = mast.grade;
  mast.metrics = { loss, fatigue, stress, velocity };
  mast.grade = ev.grade;
  mast.gradeLevel = ev.gradeLevel;
  mast.remainingLife = life;

  // 达到监测线：纳入持续跟踪
  if (ev.gradeLevel >= 1) mast.tracking = true;
  // 达到停用线：立即冻结校准和交付（修复复检通过后才能解除）
  if (ev.gradeLevel >= 2) {
    if (mast.frozen !== true) {
      mast.frozen = true;
      mast.freezeReason = ev.blockers.join("；") || "指标达到停用线";
      mast.frozenAt = latest ? latest.at : new Date().toISOString();
      mast.logs.push({ at: new Date().toISOString(), step: "冻结", note: mast.freezeReason });
    } else {
      mast.freezeReason = ev.blockers.join("；") || mast.freezeReason;
    }
  }
  // 已有放行结论后又出现新检测（或评级变差），放行结论失效，必须重新放行
  if (mast.release && ev.gradeLevel !== 0 && mast.release.at < (latest?.at || "")) {
    mast.release.invalidated = true;
  }
  return { ev, prevGrade };
}

export function createMast(input) {
  const code = required(input.code, "code_required");
  const section = required(input.section, "section_required");
  if (!SECTIONS.includes(section)) throw new HttpError(400, "section_invalid");
  const dims = input.dims || {};
  const allowableStress = Number(input.allowableStress);
  if (!(allowableStress > 0)) throw new HttpError(400, "allowableStress_required");
  const material = required(input.material, "material_required");
  const area = nominalArea(section, dims);
  return {
    id: genId("MA"),
    code,
    material,
    section,
    dims,
    nominalArea: Number(area.toFixed(3)),
    allowableStress,
    baselineVelocity: Number(input.baselineVelocity) || null,
    points: input.points || [],
    itemId: input.itemId || null,
    grade: "正常",
    gradeLevel: 0,
    tracking: false,
    frozen: false,
    freezeReason: null,
    frozenAt: null,
    sectionReset: null,
    fatigueReset: null,
    metrics: { loss: 0, fatigue: 0, stress: 0, velocity: 0 },
    remainingLife: null,
    inspections: [],
    repairs: [],
    release: null,
    version: 0, // 每次写后同步为 db.version，便于前端乐观并发
    logs: [{ at: new Date().toISOString(), step: "登记", note: `${material} · ${section} · 许用${allowableStress}MPa` }],
  };
}

export function registerMast(db, input) {
  if (db.masts.some(m => m.code === input.code)) throw new HttpError(409, "mast_code_exists");
  if (input.itemId && !db.items.some(i => (i.id || i.code) === input.itemId)) {
    throw new HttpError(400, "item_not_found");
  }
  const mast = createMast(input);
  db.masts.push(mast);
  return mast;
}

export function addInspection(db, mastId, input) {
  const mast = mustFind(db, mastId);
  const inspector = required(input.inspector, "inspector_required");
  const point = required(input.point, "point_required");
  if (!mast.points.includes(point)) throw new HttpError(400, "point_unknown");
  const ins = {
    id: genId("IN"),
    kind: "检测",
    at: input.at || new Date().toISOString(),
    inspector,
    point,
    crackDepth: num(input.crackDepth),
    crackLength: num(input.crackLength),
    corrosionDepth: num(input.corrosionDepth),
    corrosionWidth: num(input.corrosionWidth),
    brokenWires: num(input.brokenWires),
    velocity: num(input.velocity),
    load: num(input.load),
    cycles: num(input.cycles),
    note: input.note || "",
  };
  mast.inspections.push(ins);
  // 新检测使旧放行结论失效（无论评级如何，都需要重新评估）
  if (mast.release) mast.release.invalidated = true;
  recompute(mast);
  ins.snapshot = { loss: mast.metrics.loss, fatigue: mast.metrics.fatigue, grade: mast.grade };
  mast.logs.push({
    at: ins.at, step: "检测",
    note: `${inspector}@${point} → ${mast.grade}（损失${pct(mast.metrics.loss)} 疲劳${mast.metrics.fatigue.toFixed(2)}）`,
  });
  return ins;
}

export function createRepair(db, mastId, input) {
  const mast = mustFind(db, mastId);
  if (!mast.frozen) throw new HttpError(423, "mast_not_frozen");
  const inspector = required(input.inspector, "inspector_required");
  const repair = {
    id: genId("RP"),
    at: input.at || new Date().toISOString(),
    inspector,                    // 原检测/报修人
    note: input.note || "",
    actions: input.actions || [],
    status: "待复核",
    reviewer: null,
    recheck: null,
  };
  mast.repairs.push(repair);
  mast.logs.push({ at: repair.at, step: "修复单", note: `${inspector} 报修，等待非本人复核` });
  return repair;
}

// 复核 + 复检：修复单只能由原检测人以外的人复核；复检不通过不得解除冻结
export function recheckRepair(db, repairId, input) {
  const { mast, repair } = findRepair(db, repairId);
  if (repair.status !== "待复核") throw new HttpError(409, "repair_not_pending");
  const reviewer = required(input.reviewer, "reviewer_required");
  if (reviewer === repair.inspector) throw new HttpError(403, "reviewer_must_be_different");
  // 表单可能提交字符串 "false"，不能直接 Boolean()（非空字符串恒为真）
  const passed = input.passed === true || input.passed === "true";
  const recheck = {
    id: genId("CK"),
    kind: "复检",
    at: input.at || new Date().toISOString(),
    reviewer,
    point: input.point || mast.points[0] || "",
    passed,
    crackDepth: num(input.crackDepth),
    crackLength: num(input.crackLength),
    corrosionDepth: num(input.corrosionDepth),
    corrosionWidth: num(input.corrosionWidth),
    brokenWires: num(input.brokenWires),
    velocity: num(input.velocity),
    load: num(input.load),
    cycles: num(input.cycles),
    note: input.note || "",
  };
  repair.reviewer = reviewer;
  repair.recheck = recheck;
  repair.status = passed ? "复检通过" : "复检未过";
  repair.reviewedAt = recheck.at;
  mast.inspections.push(recheck);

  if (!passed) {
    // 复检未过：冻结不得解除，阻断原因保持并补充记录
    mast.logs.push({ at: recheck.at, step: "复检未过", note: `${reviewer} 复核未通过，维持冻结` });
    recompute(mast);
    recheck.snapshot = { loss: mast.metrics.loss, fatigue: mast.metrics.fatigue, grade: mast.grade };
    return repair;
  }

  // 复检通过：修复前的全部历史损伤/疲劳（含上一轮复检的旧基线）由本次修复核销，
  // 本次复检数据作为唯一新基线继续参评
  for (const old of mast.inspections) {
    if (old.id !== recheck.id) old.superseded = true;
  }
  mast.sectionReset = { at: recheck.at, repairId: repair.id };
  mast.fatigueReset = { at: recheck.at, repairId: repair.id };
  if (recheck.velocity > 0) mast.baselineVelocity = recheck.velocity; // 声速基线同步重置
  mast.tracking = false;
  mast.logs.push({ at: recheck.at, step: "复检通过", note: `${reviewer} 复核通过，以复检数据为新基线` });
  recompute(mast);
  if (mast.gradeLevel < 2) {
    mast.frozen = false;
    mast.freezeReason = null;
    mast.frozenAt = null;
    mast.logs.push({ at: new Date().toISOString(), step: "解除冻结", note: "停用线指标已消除" });
  } else {
    // 复检数据显示仍达停用线：继续冻结（freezeReason 已由 recompute 按最新指标更新）
    mast.frozen = true;
  }
  return repair;
}

export function releaseMast(db, mastId, input) {
  const mast = mustFind(db, mastId);
  const approver = required(input.approver, "approver_required");
  if (mast.frozen) throw new HttpError(423, "mast_frozen", { reason: mast.freezeReason });
  if (mast.gradeLevel >= 2) throw new HttpError(423, "mast_at_stop_line");
  if (mast.inspections.length === 0) throw new HttpError(409, "no_inspection");
  // 放行只能成功一次：已有且未失效的放行结论时拒绝重复放行
  if (mast.release && !mast.release.invalidated) throw new HttpError(409, "already_released");
  const blockers = buildBlockers(mast);
  if (blockers.length) throw new HttpError(423, "mast_blocked", { blockers });
  mast.release = {
    at: new Date().toISOString(),
    approver,
    grade: mast.grade,
    note: input.note || "",
    invalidated: false,
  };
  mast.logs.push({ at: mast.release.at, step: "放行", note: `${approver} 放行（等级：${mast.grade}）` });
  return mast.release;
}

export function buildBlockers(mast) {
  const blockers = [];
  if (mast.frozen) blockers.push(`桅杆冻结：${mast.freezeReason || "达停用线"}`);
  if (mast.gradeLevel >= 2) blockers.push("当前安全等级为停用");
  const pending = (mast.repairs || []).filter(r => r.status === "待复核");
  if (pending.length) blockers.push(`有 ${pending.length} 张修复单待非本人复核`);
  // 复检未过只在桅杆仍处冻结/停用时阻断；后续修复复检通过解冻后，历史未过记录不再永久阻断
  const failed = (mast.repairs || []).filter(r => r.status === "复检未过");
  if (failed.length && (mast.frozen || mast.gradeLevel >= 2)) {
    blockers.push(`有 ${failed.length} 张修复单复检未过，冻结不得解除`);
  }
  return blockers;
}

// 旧工作台联动：关联桅杆冻结时阻断校准与交付
export function assertItemUnblocked(db, item, action) {
  if (!item) return;
  const linked = db.masts.filter(m => m.itemId && (item.id || item.code) === m.itemId);
  const frozen = linked.filter(m => m.frozen);
  if (frozen.length) {
    throw new HttpError(423, "mast_frozen_block", {
      action,
      blockers: frozen.map(m => ({ mastCode: m.code, reason: m.freezeReason })),
    });
  }
}

function mustFind(db, id) {
  const mast = db.masts.find(m => m.id === id || m.code === id);
  if (!mast) throw new HttpError(404, "mast_not_found");
  return mast;
}
function findRepair(db, id) {
  for (const mast of db.masts) {
    const repair = mast.repairs.find(r => r.id === id);
    if (repair) return { mast, repair };
  }
  throw new HttpError(404, "repair_not_found");
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function pct(v) { return `${(v * 100).toFixed(1)}%`; }
