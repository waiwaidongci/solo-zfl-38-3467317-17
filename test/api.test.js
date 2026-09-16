// API 集成测试：正常 / 阈值 / 并发 / 回滚 / 持久化 / 冻结联动 / 修复异人复核 / 放行一次。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { once } from "node:events";

const DB = `/tmp/mast-api-${process.pid}-${Math.random().toString(36).slice(2)}.json`;
process.env.DB_FILE = DB;
process.env.PORT = String(40000 + (process.pid % 10000));
process.env.ALLOW_FAULTS = "1";
const { server } = await import("../server.js");
await once(server, "listening");
const base = `http://localhost:${server.address().port}`;

after(() => { server.close(); try { rmSync(DB); } catch {} });

async function req(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json", ...headers } : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, version: res.headers.get("x-version") };
}
let version = 0;
async function post(path, body, headers) { const r = await req("POST", path, body, headers); if (r.version) version = Number(r.version); return r; }
async function patch(path, body, headers) { const r = await req("PATCH", path, body, headers); if (r.version) version = Number(r.version); return r; }
async function getState() { const r = await req("GET", "/api/masts"); version = r.json.version; return r.json; }
async function getItems() { return (await req("GET", "/api/items")).json; }

const mastBody = (over = {}) => ({
  code: "M-" + Math.random().toString(36).slice(2, 7),
  material: "杉木", section: "圆管", allowableStress: 80,
  dims: { outerD: 100, innerD: 80 }, baselineVelocity: 3200,
  points: ["根部", "桅顶"], ...over,
});
const stopInspection = {
  inspector: "甲", point: "根部", crackDepth: 8, crackLength: 40, // 8×40/2827 ≈ 11.3%…补腐蚀越过15%
  corrosionDepth: 3, corrosionWidth: 40, load: 50, cycles: 1000, velocity: 2700,
};

test("正常流程：登记→检测→监测线持续跟踪→趋势快照", async () => {
  const reg = await post("/api/masts", mastBody());
  assert.equal(reg.status, 201);
  const id = reg.json.id;
  // 轻微裂纹 2×10 = 20/2827 = 0.7% 正常
  let r = await post(`/api/masts/${id}/inspections`, { ...{ inspector: "甲", point: "根部", crackDepth: 2, crackLength: 10, load: 10, cycles: 100, velocity: 3180 }, expectedVersion: version });
  assert.equal(r.status, 201);
  assert.equal(r.json.grade, "正常");
  // 追加腐蚀使截面损失越过 5% 监测线：腐蚀 4×40=160/2827=5.66%
  r = await post(`/api/masts/${id}/inspections`, { inspector: "甲", point: "根部", corrosionDepth: 4, corrosionWidth: 40, load: 10, cycles: 100, velocity: 3100, expectedVersion: version });
  assert.equal(r.json.grade, "监测");
  const s = await getState();
  const m = s.masts.find(x => x.id === id);
  assert.equal(m.tracking, true, "达到监测线后纳入持续跟踪");
  assert.equal(m.frozen, false);
  assert.ok(m.inspections.at(-1).snapshot.grade === "监测");
});

test("阈值：达到停用线立即冻结并给出阻断原因", async () => {
  const id = (await post("/api/masts", mastBody())).json.id;
  const r = await post(`/api/masts/${id}/inspections`, { ...stopInspection, expectedVersion: version });
  assert.equal(r.status, 201);
  assert.equal(r.json.grade, "停用");
  assert.equal(r.json.frozen, true);
  assert.ok(r.json.freezeReason.includes("停用线"));
  const m = (await getState()).masts.find(x => x.id === id);
  assert.equal(m.frozenAt != null, true);
});

test("冻结联动：关联桅杆冻结时旧工作台校准与交付被阻断", async () => {
  const items = await getItems();
  const itemId = items.items[0].id || items.items[0].code;
  const id = (await post("/api/masts", mastBody({ itemId }))).json.id;
  await post(`/api/masts/${id}/inspections`, { ...stopInspection, expectedVersion: version });
  // 交付被阻断
  let r = await patch(`/api/items/${itemId}`, { status: "已交付", expectedVersion: version });
  assert.equal(r.status, 423);
  assert.equal(r.json.error, "mast_frozen_block");
  assert.ok(r.json.blockers[0].reason);
  // 新增帆索校准任务被阻断
  r = await post(`/api/items/${itemId}/action`, { position: "后桅支索", tension: "紧", expectedVersion: version });
  assert.equal(r.status, 423);
  // 列表里带冻结横幅数据
  const after = await getItems();
  const item = after.items.find(i => (i.id || i.code) === itemId);
  assert.equal(item.freezeBlockers.length, 1);
});

test("修复：原检测人不能复核；复检未过不得解除冻结", async () => {
  const id = (await post("/api/masts", mastBody())).json.id;
  await post(`/api/masts/${id}/inspections`, { ...stopInspection, expectedVersion: version });
  // 非冻结不能建修复单（这里已冻结，成功）
  const rp = await post(`/api/masts/${id}/repairs`, { inspector: "甲", actions: ["焊补"], note: "裂纹修复", expectedVersion: version });
  assert.equal(rp.status, 201);
  const repairId = rp.json.id;
  // 原检测人复核 → 403
  let r = await post(`/api/repairs/${repairId}/recheck`, { reviewer: "甲", passed: true, expectedVersion: version });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "reviewer_must_be_different");
  // 别人复核但复检未过 → 维持冻结（表单可能提交字符串 "false"）
  r = await post(`/api/repairs/${repairId}/recheck`, { reviewer: "乙", passed: "false", note: "裂纹仍在", expectedVersion: version });
  assert.equal(r.status, 201);
  let m = (await getState()).masts.find(x => x.id === id);
  assert.equal(m.frozen, true);
  assert.equal(m.repairs[0].status, "复检未过");
  // 再开一张修复单，乙复核通过且残余指标低于监测线 → 解除冻结
  const rp2 = await post(`/api/masts/${id}/repairs`, { inspector: "甲", actions: ["换段"], expectedVersion: version });
  r = await post(`/api/repairs/${rp2.json.id}/recheck`, {
    reviewer: "乙", passed: true, velocity: 3180, load: 10, cycles: 0,
    crackDepth: 0, crackLength: 0, corrosionDepth: 0, corrosionWidth: 0, brokenWires: 0,
    expectedVersion: version,
  });
  assert.equal(r.status, 201);
  m = (await getState()).masts.find(x => x.id === id);
  assert.equal(m.frozen, false, "复检通过且指标回落应解除冻结");
  assert.equal(m.repairs[1].status, "复检通过");
});

test("复检通过但残余仍达停用线：继续冻结", async () => {
  const id = (await post("/api/masts", mastBody())).json.id;
  await post(`/api/masts/${id}/inspections`, { ...stopInspection, expectedVersion: version });
  const rp = await post(`/api/masts/${id}/repairs`, { inspector: "甲", expectedVersion: version });
  // 残余大裂纹依旧越过停用线
  const r = await post(`/api/repairs/${rp.json.id}/recheck`, {
    reviewer: "乙", passed: true, crackDepth: 12, crackLength: 40, expectedVersion: version,
  });
  assert.equal(r.status, 201);
  const m = (await getState()).masts.find(x => x.id === id);
  assert.equal(m.frozen, true);
});

test("多轮修复：第二次复检通过时核销全部旧损伤（含上一轮复检基线）", async () => {
  const id = (await post("/api/masts", mastBody())).json.id;
  // 第一轮：停用 → 修复 → 复检通过（残余小损伤 1%）
  await post(`/api/masts/${id}/inspections`, { ...stopInspection, expectedVersion: version });
  let rp = await post(`/api/masts/${id}/repairs`, { inspector: "甲", expectedVersion: version });
  await post(`/api/repairs/${rp.json.id}/recheck`, { reviewer: "乙", passed: true, crackDepth: 1, crackLength: 28, velocity: 3180, load: 5, cycles: 0, expectedVersion: version });
  let m = (await getState()).masts.find(x => x.id === id);
  assert.equal(m.frozen, false);
  const firstBaselineLoss = m.metrics.loss;
  assert.ok(firstBaselineLoss > 0 && firstBaselineLoss < 0.05);
  // 再次产生大损伤并冻结
  await post(`/api/masts/${id}/inspections`, { inspector: "甲", point: "桅顶", crackDepth: 8, crackLength: 40, velocity: 2700, load: 30, cycles: 100, expectedVersion: version });
  m = (await getState()).masts.find(x => x.id === id);
  assert.equal(m.frozen, true);
  // 第二轮修复复检通过，残余为 0：旧基线的 1% 必须被核销，否则仍会累计
  rp = await post(`/api/masts/${id}/repairs`, { inspector: "甲", expectedVersion: version });
  await post(`/api/repairs/${rp.json.id}/recheck`, { reviewer: "乙", passed: true, crackDepth: 0, crackLength: 0, velocity: 3200, load: 5, cycles: 0, expectedVersion: version });
  m = (await getState()).masts.find(x => x.id === id);
  assert.equal(m.frozen, false);
  assert.equal(m.metrics.loss, 0, "旧基线残余必须被第二轮修复核销");
  assert.equal(m.grade, "正常");
});

test("放行：冻结阻断、只能成功一次、新检测后须重新放行", async () => {
  const id = (await post("/api/masts", mastBody())).json.id;
  // 无检测不能放行
  let r = await post(`/api/masts/${id}/release`, { approver: "丙", expectedVersion: version });
  assert.equal(r.status, 409);
  // 一条小检测（正常级）
  await post(`/api/masts/${id}/inspections`, { inspector: "甲", point: "根部", crackDepth: 1, crackLength: 5, velocity: 3190, load: 5, cycles: 10, expectedVersion: version });
  r = await post(`/api/masts/${id}/release`, { approver: "丙", expectedVersion: version });
  assert.equal(r.status, 200);
  // 重复放行 → 409（只能成功一次）
  r = await post(`/api/masts/${id}/release`, { approver: "丙", expectedVersion: version });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "already_released");
  // 新检测使旧放行失效，可重新放行
  await post(`/api/masts/${id}/inspections`, { inspector: "甲", point: "桅顶", corrosionDepth: 1, corrosionWidth: 10, velocity: 3180, load: 5, cycles: 10, expectedVersion: version });
  let m = (await getState()).masts.find(x => x.id === id);
  assert.equal(m.release.invalidated, true);
  r = await post(`/api/masts/${id}/release`, { approver: "丙", expectedVersion: version });
  assert.equal(r.status, 200);
  // 冻结状态下放行 423
  const id2 = (await post("/api/masts", mastBody())).json.id;
  await post(`/api/masts/${id2}/inspections`, { ...stopInspection, expectedVersion: version });
  r = await post(`/api/masts/${id2}/release`, { approver: "丙", expectedVersion: version });
  assert.equal(r.status, 423);
});

test("并发-幂等：同一检测并发两次只成功一次", async () => {
  const id = (await post("/api/masts", mastBody())).json.id;
  const key = "dup-ins-" + id;
  const payload = { inspector: "甲", point: "根部", corrosionDepth: 2, corrosionWidth: 20, velocity: 3180, load: 5, cycles: 10, expectedVersion: version, idempotencyKey: key };
  const [a, b] = await Promise.all([
    post(`/api/masts/${id}/inspections`, payload),
    post(`/api/masts/${id}/inspections`, payload),
  ]);
  assert.ok(a.status === 201 || b.status === 201);
  const m = (await getState()).masts.find(x => x.id === id);
  assert.equal(m.inspections.length, 1, "幂等键重放不得重复落盘");
  // 登记也可幂等
  const body = mastBody({ code: "IDEMPOTENT-1" });
  const [c, d] = await Promise.all([
    req("POST", "/api/masts", body, { "Idempotency-Key": "reg-IDEMPOTENT-1" }),
    req("POST", "/api/masts", body, { "Idempotency-Key": "reg-IDEMPOTENT-1" }),
  ]);
  const s = await getState();
  assert.equal(s.masts.filter(x => x.code === "IDEMPOTENT-1").length, 1);
  assert.ok([c.status, d.status].includes(201));
});

test("并发-版本过期：过期版本写入被拒绝且状态不变", async () => {
  const id = (await post("/api/masts", mastBody())).json.id;
  const stale = version; // 登记后的版本
  // 先制造一次版本前进（加备注），让 stale 过期
  const items = await getItems();
  const itemId = items.items[0].id || items.items[0].code;
  await post(`/api/items/${itemId}/logs`, { step: "备注", note: "版本推进", expectedVersion: version });
  // 用同一个过期版本并发提交两条检测，都必须 409，且不得落盘任何一条
  const payload = { inspector: "甲", point: "桅顶", corrosionDepth: 1, corrosionWidth: 10, velocity: 3190, expectedVersion: stale };
  const results = await Promise.all([
    post(`/api/masts/${id}/inspections`, payload),
    post(`/api/masts/${id}/inspections`, payload),
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), [409, 409]);
  const m = (await getState()).masts.find(x => x.id === id);
  assert.equal(m.inspections.length, 0);
  // 用最新版本提交成功
  const ok = await post(`/api/masts/${id}/inspections`, { ...payload, point: "根部", expectedVersion: version });
  assert.equal(ok.status, 201);
});

test("回滚：写盘失败时损伤/冻结整体回滚", async () => {
  const id = (await post("/api/masts", mastBody())).json.id;
  const before = (await getState()).masts.find(x => x.id === id);
  await req("POST", "/test/fail-next-write");
  const r = await post(`/api/masts/${id}/inspections`, { ...stopInspection, expectedVersion: version });
  assert.equal(r.status, 500);
  // 内存状态也已回滚：未冻结、无检测
  const m = (await getState()).masts.find(x => x.id === id);
  assert.equal(m.frozen, false);
  assert.equal(m.inspections.length, 0);
  assert.equal(m.grade, "正常");
  // 版本号未前进
  const s = await getState();
  assert.equal(s.version, version, "失败事务不得占用版本号");
  assert.equal(before.id, m.id);
});

test("回滚：版本冲突在写入前判定，不产生任何落盘", async () => {
  const id = (await post("/api/masts", mastBody())).json.id;
  const v = version;
  await post(`/api/masts/${id}/inspections`, { inspector: "甲", point: "根部", crackDepth: 1, crackLength: 5, expectedVersion: version });
  const r = await req("POST", "/test/fail-next-write");
  assert.equal(r.status, 200);
  // 过期版本先报 409，写失败钩子不应被消耗
  const conflict = await post(`/api/masts/${id}/inspections`, { inspector: "甲", point: "根部", crackDepth: 1, crackLength: 5, expectedVersion: v });
  assert.equal(conflict.status, 409);
  const good = await post(`/api/masts/${id}/inspections`, { inspector: "甲", point: "根部", crackDepth: 1, crackLength: 5, expectedVersion: version });
  assert.equal(good.status, 500, "写失败钩子仍在，证明冲突事务没有触发写入");
  await getState();
});

test("持久化：重启进程后数据仍在（文件原子写）", async () => {
  const code = "PERSIST-" + Math.random().toString(36).slice(2, 7);
  const reg = await post("/api/masts", mastBody({ code }));
  await post(`/api/masts/${reg.json.id}/inspections`, { inspector: "甲", point: "根部", corrosionDepth: 6, corrosionWidth: 60, velocity: 2800, load: 10, cycles: 2000, expectedVersion: version });
  const before = (await getState()).masts.find(x => x.code === code);
  const frozenBefore = before.frozen;

  // 模拟重启：清掉内存缓存重新从磁盘加载
  const { store } = await import("../server.js");
  await store.simulateRestart();
  const after = (await getState()).masts.find(x => x.code === code);
  assert.equal(after.code, code);
  assert.equal(after.frozen, frozenBefore);
  assert.equal(after.inspections.length, 1);
  assert.ok(after.metrics.loss > 0.05);
  assert.equal(after.logs.some(l => l.step === "冻结"), true);
});

test("旧入口兼容：原页面/统计/备注接口保持可用", async () => {
  const home = await fetch(base + "/");
  assert.equal(home.status, 200);
  assert.ok((await home.text()).includes("古船模型帆索校准"));
  const stats = await req("GET", "/api/stats");
  assert.equal(stats.status, 200);
  assert.deepEqual(Object.keys(stats.json).sort(), ["待复核", "待检查", "已交付", "校准中"].sort());
  const itemId = (await getItems()).items.find(i => !i.freezeBlockers.length)?.id;
  if (itemId) {
    const r = await post(`/api/items/${itemId}/logs`, { step: "备注", note: "兼容回归", expectedVersion: version });
    assert.ok([201, 423].includes(r.status));
  }
});
