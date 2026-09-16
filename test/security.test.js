// 三类真实缺陷的安全回归：
//  1) 复核身份必须绑定触发冻结的实际检测记录，不能信任请求自报的原检测人；
//  2) 检测/修复/复检/放行缺少版本条件时必须拒绝（428），并发不可能同时成功；
//  3) 幂等键必须限定 操作+资源+请求内容，跨资源/跨操作/异内容重键拒绝（409），
//     只有完全一致的重试才回放同一结果。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { once } from "node:events";

const DB = `/tmp/mast-sec-${process.pid}-${Math.random().toString(36).slice(2)}.json`;
process.env.DB_FILE = DB;
process.env.PORT = String(45000 + (process.pid % 10000));
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
async function getState() { const r = await req("GET", "/api/masts"); version = r.json.version; return r.json; }

const mastBody = (over = {}) => ({
  code: "S-" + Math.random().toString(36).slice(2, 7),
  material: "杉木", section: "圆管", allowableStress: 80,
  dims: { outerD: 100, innerD: 80 }, baselineVelocity: 3200,
  points: ["根部", "桅顶"], ...over,
});
const stopPayload = (over = {}) => ({
  inspector: "甲", point: "根部", crackDepth: 8, crackLength: 40,
  corrosionDepth: 3, corrosionWidth: 40, load: 50, cycles: 1000, velocity: 2700, ...over,
});
async function newFrozenMast(inspector = "甲") {
  const id = (await post("/api/masts", mastBody())).json.id;
  const r = await post(`/api/masts/${id}/inspections`, { ...stopPayload({ inspector }), expectedVersion: version });
  assert.equal(r.json.frozen, true);
  return id;
}

// ---------- 缺陷 1：复核身份绑定实际触发冻结的检测记录 ----------

test("越权复核：修复单忽略自报原检测人，触发记录本人无法复核", async () => {
  const id = await newFrozenMast("甲");
  let m = (await getState()).masts.find(x => x.id === id);
  const triggerInspectionId = m.inspections[0].id;
  assert.equal(m.frozenByInspection.inspector, "甲");
  assert.equal(m.frozenByInspection.inspectionId, triggerInspectionId);

  // 请求体里把“原检测人”伪造成乙 —— 服务端必须忽略
  const rp = await post(`/api/masts/${id}/repairs`, {
    inspector: "乙（伪造）", actions: ["焊补"], note: "冒名报修", expectedVersion: version,
  });
  assert.equal(rp.status, 201);
  assert.equal(rp.json.inspector, "甲", "修复单必须绑定触发冻结记录的操作者甲");
  assert.equal(rp.json.triggerInspectionId, triggerInspectionId);

  // 真正的触发记录操作者甲来复核 → 拒绝，哪怕修复单请求里写的是别人
  let r = await post(`/api/repairs/${rp.json.id}/recheck`, { reviewer: "甲", passed: true, expectedVersion: version });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "reviewer_must_be_different");
  assert.equal(r.json.triggerInspector, "甲");

  // 换触发记录本人之外的复核人，复检未过 → 维持冻结
  r = await post(`/api/repairs/${rp.json.id}/recheck`, { reviewer: "乙", passed: "false", expectedVersion: version });
  assert.equal(r.status, 201);
  m = (await getState()).masts.find(x => x.id === id);
  assert.equal(m.frozen, true);
});

test("解冻后身份绑定清除；再次冻结改绑新的触发检测人", async () => {
  const id = await newFrozenMast("甲");
  let rp = await post(`/api/masts/${id}/repairs`, { actions: ["换段"], expectedVersion: version });
  // 复检通过且指标回落，由乙复核 → 解冻，绑定清除
  await post(`/api/repairs/${rp.json.id}/recheck`, {
    reviewer: "乙", passed: true, velocity: 3200, load: 5, cycles: 0, expectedVersion: version,
  });
  let m = (await getState()).masts.find(x => x.id === id);
  assert.equal(m.frozen, false);
  assert.equal(m.frozenByInspection, null);

  // 丙的检测再次触发冻结 —— 新修复单绑定丙，乙（上轮复核人）反而可以复核
  await post(`/api/masts/${id}/inspections`, { ...stopPayload({ inspector: "丙", point: "桅顶" }), expectedVersion: version });
  m = (await getState()).masts.find(x => x.id === id);
  assert.equal(m.frozen, true);
  assert.equal(m.frozenByInspection.inspector, "丙");
  rp = await post(`/api/masts/${id}/repairs`, { actions: ["整段更换"], expectedVersion: version });
  assert.equal(rp.json.inspector, "丙");
  let denied = await post(`/api/repairs/${rp.json.id}/recheck`, { reviewer: "丙", passed: true, expectedVersion: version });
  assert.equal(denied.status, 403);
  const ok = await post(`/api/repairs/${rp.json.id}/recheck`, { reviewer: "乙", passed: true, velocity: 3200, load: 5, cycles: 0, expectedVersion: version });
  assert.equal(ok.status, 201);
  m = (await getState()).masts.find(x => x.id === id);
  assert.equal(m.frozen, false);
});

// ---------- 缺陷 2：无版本并发写必须拒绝 ----------

test("无版本条件：检测/修复/复检/放行单发也拒绝（428）", async () => {
  const id = await newFrozenMast("甲");
  let r = await post(`/api/masts/${id}/inspections`, stopPayload());
  assert.equal(r.status, 428);
  assert.equal(r.json.error, "version_required");
  r = await post(`/api/masts/${id}/repairs`, { actions: ["焊补"] });
  assert.equal(r.status, 428);
  const rp = await post(`/api/masts/${id}/repairs`, { actions: ["焊补"], expectedVersion: version });
  assert.equal(rp.status, 201);
  r = await post(`/api/repairs/${rp.json.id}/recheck`, { reviewer: "乙", passed: "false" });
  assert.equal(r.status, 428);
  r = await post(`/api/masts/${id}/release`, { approver: "丁" });
  assert.equal(r.status, 428);
});

test("无版本并发：两条检测并发都被拒绝，不可能同时成功", async () => {
  const id = (await post("/api/masts", mastBody())).json.id;
  const payload = stopPayload({ crackDepth: 1, crackLength: 5, corrosionDepth: 0, corrosionWidth: 0, velocity: 3200, load: 5, cycles: 10 });
  delete payload.expectedVersion;
  const [a, b] = await Promise.all([
    post(`/api/masts/${id}/inspections`, payload),
    post(`/api/masts/${id}/inspections`, payload),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [428, 428]);
  const m = (await getState()).masts.find(x => x.id === id);
  assert.equal(m.inspections.length, 0, "无版本并发不得有任何一条落盘");
  assert.equal(m.grade, "正常");
});

test("带版本并发：同一版本的两条提交最多成功一条，另一条 409", async () => {
  const id = (await post("/api/masts", mastBody())).json.id;
  const stale = version;
  const payload = { ...stopPayload({ crackDepth: 1, crackLength: 5, corrosionDepth: 0, corrosionWidth: 0, velocity: 3200, load: 5, cycles: 10 }), expectedVersion: stale };
  const [a, b] = await Promise.all([
    post(`/api/masts/${id}/inspections`, payload),
    post(`/api/masts/${id}/inspections`, payload),
  ]);
  const statuses = [a.status, b.status].sort((x, y) => x - y);
  assert.deepEqual(statuses, [201, 409]);
  const m = (await getState()).masts.find(x => x.id === id);
  assert.equal(m.inspections.length, 1);
});

test("幂等重试：同键同内容的网络重放即使版本已前进也回放同一结果，不重复落盘", async () => {
  const id = (await post("/api/masts", mastBody())).json.id;
  const v0 = version;
  const payload = {
    inspector: "甲", point: "根部", corrosionDepth: 2, corrosionWidth: 20,
    velocity: 3180, load: 5, cycles: 10, expectedVersion: v0, idempotencyKey: "retry-key-1",
  };
  const first = await post(`/api/masts/${id}/inspections`, payload);
  assert.equal(first.status, 201);
  const firstId = first.json.inspection.id;
  // 原样重试（版本号已过期，但同键同作用域同内容）→ 回放
  const replay = await post(`/api/masts/${id}/inspections`, payload);
  assert.equal(replay.status, 201);
  assert.equal(replay.json.inspection.id, firstId);
  const m = (await getState()).masts.find(x => x.id === id);
  assert.equal(m.inspections.length, 1);
});

// ---------- 缺陷 3：幂等键作用域（操作+资源+内容） ----------

test("跨资源重键：同一把键用于不同桅杆时拒绝且不回放旧响应", async () => {
  const a = (await post("/api/masts", mastBody())).json.id;
  const b = (await post("/api/masts", mastBody())).json.id;
  const key = "shared-cross-resource";
  const mk = id => ({
    inspector: "甲", point: "根部", corrosionDepth: 2, corrosionWidth: 20,
    velocity: 3180, load: 5, cycles: 10, expectedVersion: version, idempotencyKey: key,
  });
  const first = await post(`/api/masts/${a}/inspections`, mk(a));
  assert.equal(first.status, 201);
  const second = await post(`/api/masts/${b}/inspections`, mk(b));
  assert.equal(second.status, 409);
  assert.equal(second.json.error, "idempotency_key_reuse_conflict");
  assert.ok(second.json.savedScope.includes(a));
  assert.ok(second.json.requestScope.includes(b));
  const s = await getState();
  assert.equal(s.masts.find(x => x.id === a).inspections.length, 1);
  assert.equal(s.masts.find(x => x.id === b).inspections.length, 0, "冲突请求不得写入目标资源");
});

test("跨操作重键：同一把键用于检测与放行时拒绝", async () => {
  const id = await newFrozenMast("甲");
  const key = "shared-cross-op";
  const first = await post(`/api/masts/${id}/repairs`, { actions: ["焊补"], expectedVersion: version, idempotencyKey: key });
  assert.equal(first.status, 201);
  const second = await post(`/api/masts/${id}/release`, { approver: "丁", expectedVersion: version, idempotencyKey: key });
  assert.equal(second.status, 409);
  assert.equal(second.json.error, "idempotency_key_reuse_conflict");
});

test("同资源同键但请求内容不同：拒绝而非回放", async () => {
  const id = (await post("/api/masts", mastBody())).json.id;
  const key = "same-scope-diff-body";
  const basePayload = {
    inspector: "甲", point: "根部", corrosionDepth: 2, corrosionWidth: 20,
    velocity: 3180, load: 5, cycles: 10, expectedVersion: version, idempotencyKey: key,
  };
  const first = await post(`/api/masts/${id}/inspections`, basePayload);
  assert.equal(first.status, 201);
  // 同一资源同一操作，但腐蚀宽度不同（指纹不同）
  const tampered = await post(`/api/masts/${id}/inspections`, { ...basePayload, corrosionWidth: 45, expectedVersion: version });
  assert.equal(tampered.status, 409);
  assert.equal(tampered.json.error, "idempotency_key_reuse_conflict");
  const m = (await getState()).masts.find(x => x.id === id);
  assert.equal(m.inspections.length, 1);
  assert.equal(m.inspections[0].corrosionWidth, 20, "回放的是首次结果，篡改内容未写入");
});

test("幂等键通过 HTTP 头提交时同样受作用域约束", async () => {
  const a = (await post("/api/masts", mastBody())).json.id;
  const b = (await post("/api/masts", mastBody())).json.id;
  const bodyA = { inspector: "甲", point: "根部", crackDepth: 1, crackLength: 5, velocity: 3200, load: 5, cycles: 1, expectedVersion: version };
  const first = await post(`/api/masts/${a}/inspections`, bodyA, { "Idempotency-Key": "hdr-key" });
  assert.equal(first.status, 201);
  const bodyB = { inspector: "甲", point: "根部", crackDepth: 1, crackLength: 5, velocity: 3200, load: 5, cycles: 1, expectedVersion: version };
  const second = await post(`/api/masts/${b}/inspections`, bodyB, { "Idempotency-Key": "hdr-key" });
  assert.equal(second.status, 409);
});

// ---------- 失败回滚与旧入口保持可用 ----------

test("回滚：428/409/403 被拒及写盘失败都不推进版本、不改变冻结状态", async () => {
  const id = await newFrozenMast("甲");
  const v0 = version;
  await post(`/api/masts/${id}/inspections`, stopPayload()); // 428
  await post(`/api/masts/${id}/inspections`, { ...stopPayload(), expectedVersion: v0 - 1 }); // 409
  assert.equal((await getState()).version, v0, "428/409 被拒不推进版本");
  const rp = await post(`/api/masts/${id}/repairs`, { actions: ["x"], expectedVersion: version });
  assert.equal(rp.status, 201);
  const v1 = version;
  const denied = await post(`/api/repairs/${rp.json.id}/recheck`, { reviewer: "甲", passed: true, expectedVersion: version }); // 403
  assert.equal(denied.status, 403);
  assert.equal((await getState()).version, v1, "403 被拒不推进版本");

  // 写盘失败：整体回滚
  await req("POST", "/test/fail-next-write");
  const r = await post(`/api/masts/${id}/inspections`, { ...stopPayload({ point: "桅顶" }), expectedVersion: version });
  assert.equal(r.status, 500);
  const s = await getState();
  const m = s.masts.find(x => x.id === id);
  assert.equal(s.version, v1, "写失败事务不占用版本号");
  assert.equal(m.inspections.length, 1);
  assert.equal(m.frozen, true);
});

test("旧入口保持可用：无版本的旧接口调用不要求 428，冻结联动仍生效", async () => {
  const items = (await req("GET", "/api/items")).json;
  const itemId = items.items[0].id || items.items[0].code;
  // 旧风格：不带版本号的备注/建档仍成功
  const r = await post(`/api/items/${itemId}/logs`, { step: "备注", note: "旧客户端无版本号" });
  assert.ok([201, 423].includes(r.status));
  // 关联一根未冻结桅杆，旧操作不被阻断
  const free = (await post("/api/masts", mastBody({ code: "FREE-" + Math.random().toString(36).slice(2, 6), itemId }))).json.id;
  const act = await post(`/api/items/${itemId}/action`, { position: "侧支索", tension: "适中" });
  assert.equal(act.status, 201);
  // 该桅杆冻结后，旧入口立即被 423 阻断（无需版本号即可完成判定）
  await post(`/api/masts/${free}/inspections`, { ...stopPayload(), expectedVersion: version });
  const blocked = await post(`/api/items/${itemId}/action`, { position: "后支索", tension: "紧" });
  assert.equal(blocked.status, 423);
});
