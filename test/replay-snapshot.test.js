// 幂等重放响应主体快照回归：
//  同键同内容的重放必须返回首次提交时的完整响应快照——后续的复检、核销、放行失效
//  等业务变更不得漂移进历史响应；只有 X-Version 单独反映当前状态。
//  覆盖检测/修复单/放行三类响应，以及连续重放、并发重放、穿插修改、写失败回滚、重启。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { once } from "node:events";

const DB = `/tmp/mast-snap-${process.pid}-${Math.random().toString(36).slice(2)}.json`;
process.env.DB_FILE = DB;
process.env.PORT = String(47000 + (process.pid % 10000));
process.env.ALLOW_FAULTS = "1";
const { server, store } = await import("../server.js");
await once(server, "listening");
const base = `http://localhost:${server.address().port}`;

after(() => { server.close(); try { rmSync(DB); } catch {} });

async function raw(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json", ...headers } : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, version: res.headers.get("x-version"), replay: res.headers.get("x-idempotent-replay") };
}
let version = 0;
async function post(path, body, headers) { const r = await raw("POST", path, body, headers); if (r.version) version = Number(r.version); return r; }
async function state() { const r = await raw("GET", "/api/masts"); version = r.json.version; return r.json; }
const v = () => version;

const mastBody = (over = {}) => ({
  code: "SN-" + Math.random().toString(36).slice(2, 7),
  material: "杉木", section: "圆管", allowableStress: 80,
  dims: { outerD: 100, innerD: 80 }, baselineVelocity: 3200,
  points: ["根部", "桅顶"], ...over,
});
const stopPayload = (over = {}) => ({
  inspector: "甲", point: "根部", crackDepth: 8, crackLength: 40,
  corrosionDepth: 3, corrosionWidth: 40, velocity: 2700, load: 50, cycles: 1000, ...over,
});
async function frozenMast() {
  const id = (await post("/api/masts", mastBody())).json.id;
  await post(`/api/masts/${id}/inspections`, { ...stopPayload(), expectedVersion: v() });
  return id;
}
async function unfreeze(id) {
  const rp = await post(`/api/masts/${id}/repairs`, { actions: ["整段更换"], expectedVersion: v() });
  await post(`/api/repairs/${rp.json.id}/recheck`, {
    reviewer: "乙", passed: true, crackDepth: 0, crackLength: 0, corrosionDepth: 0, corrosionWidth: 0,
    velocity: 3200, load: 5, cycles: 0, expectedVersion: v(),
  });
}

test("修复单重放：主体保持首次的待复核快照，不带回后来的复核状态", async () => {
  const id = await frozenMast();
  const payload = { actions: ["焊补裂纹"], note: "首次报修", expectedVersion: v(), idempotencyKey: "rp-snap-1" };
  const first = await post(`/api/masts/${id}/repairs`, payload);
  assert.equal(first.json.status, "待复核");
  assert.equal(first.json.reviewer, null);
  assert.equal(first.json.recheck, null);
  const repairId = first.json.id;

  // 异人复检未过 → 修复单被改为“复检未过”，并挂上 reviewer/recheck
  const fail = await post(`/api/repairs/${repairId}/recheck`,
    { reviewer: "乙", passed: "false", crackDepth: 7, crackLength: 40, expectedVersion: v() });
  assert.equal(fail.status, 201);

  // 同键重放修复单：必须仍是首次提交时的“待复核”快照
  const replay = await post(`/api/masts/${id}/repairs`, payload);
  assert.equal(replay.replay, "true");
  assert.equal(replay.json.id, repairId);
  assert.equal(replay.json.status, "待复核", "重放不得带回复检未过状态");
  assert.equal(replay.json.reviewer, null, "重放不得带回复核人");
  assert.equal(replay.json.recheck, null, "重放不得带回复检记录");
  assert.deepEqual(replay.json.actions, ["焊补裂纹"]);

  // 当前业务状态仍是“复检未过”（重放没有覆盖业务）
  const m = (await state()).masts.find(x => x.id === id);
  assert.equal(m.repairs.find(r => r.id === repairId).status, "复检未过");
  assert.equal(m.repairs.length, 1, "重放不重复落盘修复单");
});

test("修复单重放：复检通过后主体仍是待复核，当前状态已是通过且已解冻", async () => {
  const id = await frozenMast();
  const payload = { actions: ["换段"], expectedVersion: v(), idempotencyKey: "rp-snap-2" };
  const first = await post(`/api/masts/${id}/repairs`, payload);
  const repairId = first.json.id;
  // 复检通过、解冻
  await post(`/api/repairs/${repairId}/recheck`, {
    reviewer: "乙", passed: true, velocity: 3200, load: 5, cycles: 0, expectedVersion: v(),
  });
  // 重放修复单
  const replay = await post(`/api/masts/${id}/repairs`, payload);
  assert.equal(replay.json.status, "待复核", "主体冻结在首次提交时刻");
  assert.equal(replay.json.reviewer, null);
  // 但 X-Version 是当前版本，且当前业务已解冻
  const s = await state();
  assert.equal(Number(replay.version), s.version, "版本号单独反映当前已提交状态");
  const m = s.masts.find(x => x.id === id);
  assert.equal(m.frozen, false);
  assert.equal(m.repairs[0].status, "复检通过");
});

test("检测重放：复检核销后主体仍是首次快照（未核销、首次等级/冻结标志）", async () => {
  const id = await frozenMast();
  const payload = { ...stopPayload(), expectedVersion: v(), idempotencyKey: "in-snap-1" };
  const first = await post(`/api/masts/${id}/inspections`, payload);
  assert.equal(first.json.grade, "停用");
  assert.equal(first.json.frozen, true);
  const insId = first.json.inspection.id;
  assert.equal(first.json.inspection.superseded, undefined);

  // 修复复检通过：旧检测被标记核销 superseded=true，桅杆解冻回正常
  await unfreeze(id);

  const replay = await post(`/api/masts/${id}/inspections`, payload);
  assert.equal(replay.replay, "true");
  assert.equal(replay.json.inspection.id, insId);
  assert.equal(replay.json.inspection.superseded, undefined, "重放快照不含后来的核销标记");
  assert.equal(replay.json.grade, "停用", "外层 grade 也保持首次提交快照");
  assert.equal(replay.json.frozen, true, "外层 frozen 保持首次快照，不被当前解冻状态带回");
  assert.ok(replay.json.freezeReason.includes("停用线"));
  // 当前实际状态已解冻、旧检测已核销（重放不改变业务）
  const m = (await state()).masts.find(x => x.id === id);
  assert.equal(m.frozen, false);
  assert.equal(m.grade, "正常");
  assert.equal(m.inspections.find(i => i.id === insId).superseded, true);
  // 触发冻结检测 1 条 + 带幂等键检测 1 条 + 复检 1 条 = 3 条；重放不多落
  assert.equal(m.inspections.length, 3);
});

test("放行重放：新检测使放行失效后，主体仍是首次有效放行（invalidated=false）", async () => {
  const id = (await post("/api/masts", mastBody())).json.id;
  // 一条温和检测到正常级
  await post(`/api/masts/${id}/inspections`, {
    inspector: "甲", point: "根部", crackDepth: 1, crackLength: 5,
    corrosionDepth: 0, corrosionWidth: 0, velocity: 3198, load: 5, cycles: 10, expectedVersion: v(),
  });
  const payload = { approver: "丁", note: "准予交付", expectedVersion: v(), idempotencyKey: "rel-snap-1" };
  const first = await post(`/api/masts/${id}/release`, payload);
  assert.equal(first.status, 200);
  assert.equal(first.json.invalidated, false);
  assert.equal(first.json.approver, "丁");

  // 新检测 → 当前放行结论失效
  await post(`/api/masts/${id}/inspections`, {
    inspector: "甲", point: "桅顶", crackDepth: 1, crackLength: 5,
    corrosionDepth: 0, corrosionWidth: 0, velocity: 3197, load: 5, cycles: 10, expectedVersion: v(),
  });
  const cur = (await state()).masts.find(x => x.id === id);
  assert.equal(cur.release.invalidated, true, "前提：当前放行已失效");

  // 同键重放：主体仍是首次有效放行
  const replay = await post(`/api/masts/${id}/release`, payload);
  assert.equal(replay.replay, "true");
  assert.equal(replay.json.approver, "丁");
  assert.equal(replay.json.invalidated, false, "重放不得带回后来的失效标记");
  assert.equal(replay.json.at, first.json.at);
  assert.equal(Number(replay.version), v(), "版本号仍反映当前状态");
  // 重放没有创建第二条放行
  const after = (await state()).masts.find(x => x.id === id);
  assert.equal(after.release.invalidated, true, "业务状态仍是失效，等待重新放行");
});

test("连续重放与并发重放：主体始终等于首次快照，且只落一条", async () => {
  const id = await frozenMast();
  const payload = { actions: ["焊补"], expectedVersion: v(), idempotencyKey: "rp-race-snap" };
  const first = await post(`/api/masts/${id}/repairs`, payload);
  const repairId = first.json.id;
  // 复检未过改变业务对象
  await post(`/api/repairs/${repairId}/recheck`,
    { reviewer: "乙", passed: "false", crackDepth: 7, crackLength: 40, expectedVersion: v() });

  // 连续 3 次重放
  for (let i = 0; i < 3; i++) {
    const r = await post(`/api/masts/${id}/repairs`, payload);
    assert.equal(r.replay, "true");
    assert.equal(r.json.status, "待复核");
    assert.equal(r.json.reviewer, null);
    assert.equal(Number(r.version), v());
  }
  // 并发 2 次重放
  const rs = await Promise.all([
    post(`/api/masts/${id}/repairs`, payload),
    post(`/api/masts/${id}/repairs`, payload),
  ]);
  for (const r of rs) {
    assert.equal(r.json.status, "待复核");
    assert.equal(r.json.reviewer, null);
    assert.equal(r.json.id, repairId);
  }
  const m = (await state()).masts.find(x => x.id === id);
  assert.equal(m.repairs.length, 1, "连续/并发重放都不重复落盘");
  assert.equal(m.repairs[0].status, "复检未过", "当前业务状态不受重放影响");
});

test("穿插写失败：回滚后重放仍返回首次快照，失败内容不污染", async () => {
  const id = (await post("/api/masts", mastBody())).json.id;
  const payload = {
    inspector: "甲", point: "根部", crackDepth: 1, crackLength: 5,
    corrosionDepth: 0, corrosionWidth: 0, velocity: 3198, load: 5, cycles: 10,
    expectedVersion: v(), idempotencyKey: "in-fail-snap",
  };
  const first = await post(`/api/masts/${id}/inspections`, payload);
  assert.equal(first.json.grade, "正常");
  const verAfterFirst = v();

  // 一次停用级写入失败（整体回滚）
  await raw("POST", "/test/fail-next-write");
  const failed = await post(`/api/masts/${id}/inspections`, { ...stopPayload(), expectedVersion: v() });
  assert.equal(failed.status, 500);
  assert.equal(v(), verAfterFirst);

  // 重放首次：仍是正常级快照，不含失败写入的停用状态
  const replay = await post(`/api/masts/${id}/inspections`, payload);
  assert.equal(replay.json.grade, "正常");
  assert.equal(replay.json.frozen, false);
  assert.equal(replay.json.inspection.id, first.json.inspection.id);
  const m = (await state()).masts.find(x => x.id === id);
  assert.equal(m.inspections.length, 1);
  assert.equal(m.grade, "正常");
});

test("重启后重放：持久化的响应快照与首次完全一致，不随后续状态漂移", async () => {
  const id = await frozenMast();
  const payload = { actions: ["焊补"], note: "重启前报修", expectedVersion: v(), idempotencyKey: "rp-restart-snap" };
  const first = await post(`/api/masts/${id}/repairs`, payload);
  const repairId = first.json.id;
  await post(`/api/repairs/${repairId}/recheck`,
    { reviewer: "乙", passed: "false", crackDepth: 7, crackLength: 40, expectedVersion: v() });

  // 重启：从磁盘重新加载
  await store.simulateRestart();
  const s = await state();
  const replay = await post(`/api/masts/${id}/repairs`, payload);
  assert.equal(replay.replay, "true");
  assert.equal(replay.json.status, "待复核", "重启后重放仍是首次快照");
  assert.equal(replay.json.reviewer, null);
  assert.equal(replay.json.note, "重启前报修");
  assert.equal(Number(replay.version), s.version);
  const m = s.masts.find(x => x.id === id);
  assert.equal(m.repairs.length, 1);
  assert.equal(m.repairs[0].status, "复检未过", "当前业务为复检未过，快照与业务相互独立");
});

test("旧入口保持可用：无幂等键的旧客户端写入不受快照机制影响", async () => {
  const itemId = (await raw("GET", "/api/items")).json.items[0].id || "MR-001";
  const r = await post(`/api/items/${itemId}/logs`, { step: "备注", note: "快照回归期间写入" });
  assert.ok([201, 423].includes(r.status));
});
