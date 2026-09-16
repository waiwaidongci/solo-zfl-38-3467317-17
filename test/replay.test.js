// 幂等重放版本不滞后回归：
//  同键同内容的重放必须回放首次响应体、绝不重复落盘，但返回的 X-Version 必须是
//  当前已提交版本——状态推进后重放不得把客户端带回旧版本；按该返回值继续提交
//  检测/修复/放行不能再被 409 挡回。覆盖连续重放、穿插写入、穿插写失败、并发、重启持久化。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { once } from "node:events";

const DB = `/tmp/mast-replay-${process.pid}-${Math.random().toString(36).slice(2)}.json`;
process.env.DB_FILE = DB;
process.env.PORT = String(46000 + (process.pid % 10000));
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
  code: "R-" + Math.random().toString(36).slice(2, 7),
  material: "杉木", section: "圆管", allowableStress: 80,
  dims: { outerD: 100, innerD: 80 }, baselineVelocity: 3200,
  points: ["根部", "桅顶"], ...over,
});
const mildInspection = (over = {}) => ({
  inspector: "甲", point: "根部", crackDepth: 1, crackLength: 5,
  corrosionDepth: 0, corrosionWidth: 0, velocity: 3200, load: 5, cycles: 10, ...over,
});
const stopInspection = (over = {}) => ({
  inspector: "甲", point: "根部", crackDepth: 8, crackLength: 40,
  corrosionDepth: 3, corrosionWidth: 40, velocity: 2700, load: 50, cycles: 1000, ...over,
});

test("重放主体：回放首次响应体与记录ID，响应头标记 replay，且不重复落盘", async () => {
  const id = (await post("/api/masts", mastBody())).json.id;
  const payload = { ...mildInspection(), expectedVersion: v(), idempotencyKey: "body-1" };
  const first = await post(`/api/masts/${id}/inspections`, payload);
  assert.equal(first.status, 201);
  assert.equal(first.replay, null, "首次提交不是重放");
  const firstId = first.json.inspection.id;

  const replay = await post(`/api/masts/${id}/inspections`, payload);
  assert.equal(replay.status, 201);
  assert.equal(replay.replay, "true", "重放带 X-Idempotent-Replay 头");
  assert.equal(replay.json.inspection.id, firstId, "回放同一响应体");

  const m = (await state()).masts.find(x => x.id === id);
  assert.equal(m.inspections.length, 1, "重放绝不重复落盘");
});

test("当前版本：状态推进后重放返回当前版本，而不是首次提交的旧版本", async () => {
  const id = (await post("/api/masts", mastBody())).json.id;
  const keyPayload = { ...mildInspection(), expectedVersion: v(), idempotencyKey: "lag-1" };
  const first = await post(`/api/masts/${id}/inspections`, keyPayload);
  const firstVersion = Number(first.version);

  // 穿插若干其他写入推进版本
  await post(`/api/masts/${id}/inspections`, { ...mildInspection({ point: "桅顶", corrosionDepth: 1, corrosionWidth: 5 }), expectedVersion: v() });
  await post("/api/items/" + ((await raw("GET", "/api/items")).json.items[0].id || "MR-001") + "/logs",
    { step: "备注", note: "推进版本", expectedVersion: v() });
  const currentVersion = v();
  assert.ok(currentVersion > firstVersion, "前提：版本确已推进");

  // 原样重放：响应体仍是首次结果，但 X-Version 必须是当前版本
  const replay = await post(`/api/masts/${id}/inspections`, keyPayload);
  assert.equal(replay.json.inspection.id, first.json.inspection.id);
  assert.equal(Number(replay.version), currentVersion, "重放返回当前已提交版本，不回拨");
  assert.ok(Number(replay.version) > firstVersion);
});

test("重放后继续提交：客户端采用重放返回的版本，检测/修复/放行均不被 409 挡回", async () => {
  const id = (await post("/api/masts", mastBody())).json.id;
  const keyPayload = { ...mildInspection(), expectedVersion: v(), idempotencyKey: "continue-1" };
  const first = await post(`/api/masts/${id}/inspections`, keyPayload);
  // 模拟客户端断线重发：穿插一次别的写入后重放，并“采用重放返回的版本”
  await post(`/api/masts/${id}/inspections`, { ...mildInspection({ point: "桅顶" }), expectedVersion: v() });
  const replay = await post(`/api/masts/${id}/inspections`, keyPayload); // helper 已同步 version
  assert.equal(Number(replay.version), v());

  // 继续提交检测：必须成功（旧缺陷下这里会 409）
  const next = await post(`/api/masts/${id}/inspections`, { ...mildInspection({ point: "桅顶", corrosionDepth: 1, corrosionWidth: 5 }), expectedVersion: v() });
  assert.equal(next.status, 201);

  // 放行成功
  const rel = await post(`/api/masts/${id}/release`, { approver: "丁", expectedVersion: v() });
  assert.equal(rel.status, 200, "采用重放返回版本后放行不被过期版本挡回");
});

test("重放后继续冻结流程：重放返回当前版本，修复单与异人复检均成功", async () => {
  const id = (await post("/api/masts", mastBody())).json.id;
  // 首次检测直接打到停用线
  const keyPayload = { ...stopInspection(), expectedVersion: v(), idempotencyKey: "freeze-flow-1" };
  const first = await post(`/api/masts/${id}/inspections`, keyPayload);
  assert.equal(first.json.frozen, true);
  const frozenVersion = Number(first.version);
  // 穿插一次别的写入（日志）推进版本
  await post("/api/items/" + ((await raw("GET", "/api/items")).json.items[0].id || "MR-001") + "/logs",
    { step: "备注", note: "冻结期间推进版本", expectedVersion: v() });
  // 客户端重放冻结检测，拿到当前版本
  const replay = await post(`/api/masts/${id}/inspections`, keyPayload);
  assert.equal(replay.json.frozen, true);
  assert.ok(Number(replay.version) > frozenVersion);
  const m1 = (await state()).masts.find(x => x.id === id);
  assert.equal(m1.inspections.length, 1);

  // 用重放返回的版本开修复单 → 成功
  const rp = await post(`/api/masts/${id}/repairs`, { actions: ["焊补"], expectedVersion: v() });
  assert.equal(rp.status, 201);
  // 异人复检通过、指标回落 → 解冻成功
  const ck = await post(`/api/repairs/${rp.json.id}/recheck`, {
    reviewer: "乙", passed: true, crackDepth: 0, crackLength: 0, corrosionDepth: 0, corrosionWidth: 0,
    velocity: 3200, load: 5, cycles: 0, expectedVersion: v(),
  });
  assert.equal(ck.status, 201);
  const m2 = (await state()).masts.find(x => x.id === id);
  assert.equal(m2.frozen, false);
});

test("连续重放：多次原样重放结果一致、只落一条、版本始终为当前", async () => {
  const id = (await post("/api/masts", mastBody())).json.id;
  const payload = { ...mildInspection(), expectedVersion: v(), idempotencyKey: "multi-1" };
  const first = await post(`/api/masts/${id}/inspections`, payload);
  for (let i = 0; i < 3; i++) {
    await post(`/api/masts/${id}/inspections`, { ...mildInspection({ point: "桅顶" }), expectedVersion: v() });
    const r = await post(`/api/masts/${id}/inspections`, payload);
    assert.equal(r.json.inspection.id, first.json.inspection.id);
    assert.equal(Number(r.version), v(), "第" + (i + 1) + "次重放返回当前版本");
    assert.equal(r.replay, "true");
  }
  const m = (await state()).masts.find(x => x.id === id);
  // 首发 1 条 + 穿插 3 条 = 4 条；重放 3 次一条都不多
  assert.equal(m.inspections.length, 4);
});

test("穿插写入：重放前后其他写入正常生效，重放只回放不覆盖", async () => {
  const id = (await post("/api/masts", mastBody())).json.id;
  const keyPayload = { ...mildInspection({ crackDepth: 2, crackLength: 10 }), expectedVersion: v(), idempotencyKey: "interleave-1" };
  const first = await post(`/api/masts/${id}/inspections`, keyPayload);
  const before = await post(`/api/masts/${id}/inspections`, { ...mildInspection({ point: "桅顶", corrosionDepth: 4, corrosionWidth: 40 }), expectedVersion: v() });
  assert.equal(before.status, 201);
  const replay = await post(`/api/masts/${id}/inspections`, keyPayload);
  assert.equal(replay.json.inspection.id, first.json.inspection.id);
  const after = await post(`/api/masts/${id}/inspections`, { ...mildInspection({ point: "根部", crackDepth: 1, crackLength: 8 }), expectedVersion: v() });
  assert.equal(after.status, 201);
  const m = (await state()).masts.find(x => x.id === id);
  assert.equal(m.inspections.length, 3, "首发+前穿插+后穿插各一条，重放不落盘");
  assert.deepEqual(m.inspections.map(i => i.point), ["根部", "桅顶", "根部"]);
});

test("穿插写失败：失败整体回滚后重放仍回放首次结果并返回当前版本", async () => {
  const id = (await post("/api/masts", mastBody())).json.id;
  const payload = { ...mildInspection(), expectedVersion: v(), idempotencyKey: "fail-between-1" };
  const first = await post(`/api/masts/${id}/inspections`, payload);
  const versionAtFirst = v();

  // 制造一次写盘失败：状态不得改变、版本不前进
  await raw("POST", "/test/fail-next-write");
  const failed = await post(`/api/masts/${id}/inspections`, { ...stopInspection(), expectedVersion: v() });
  assert.equal(failed.status, 500);
  assert.equal(v(), versionAtFirst, "写失败回滚，版本不变");

  // 同键重放：仍是首次的温和检测结果（不是失败的停用检测），版本为当前
  const replay = await post(`/api/masts/${id}/inspections`, payload);
  assert.equal(replay.json.inspection.id, first.json.inspection.id);
  assert.equal(Number(replay.version), versionAtFirst);
  const m = (await state()).masts.find(x => x.id === id);
  assert.equal(m.inspections.length, 1);
  assert.equal(m.frozen, false, "失败的停用检测没有污染状态");
});

test("并发冲突：首发与重放并发为 201+replay；同版本异键并发为 201+409", async () => {
  const id = (await post("/api/masts", mastBody())).json.id;
  const same = { ...mildInspection(), expectedVersion: v(), idempotencyKey: "race-same" };
  const [a, b] = await Promise.all([
    post(`/api/masts/${id}/inspections`, same),
    post(`/api/masts/${id}/inspections`, same),
  ]);
  const replayed = [a, b].filter(r => r.replay === "true");
  const created = [a, b].filter(r => r.status === 201 && r.replay !== "true");
  assert.equal(replayed.length, 1);
  assert.equal(created.length, 1);
  assert.equal(replayed[0].json.inspection.id, created[0].json.inspection.id);
  // 重放方拿到的版本与首发提交后版本一致（当前版本），其继续写入不应 409
  const cont = await post(`/api/masts/${id}/inspections`, { ...mildInspection({ point: "桅顶" }), expectedVersion: v() });
  assert.equal(cont.status, 201);

  // 同版本、不同键：乐观锁只放行一条
  const stale = v();
  const payload = { ...mildInspection({ point: "桅顶", crackDepth: 1, crackLength: 4 }), expectedVersion: stale };
  const [c, d] = await Promise.all([
    post(`/api/masts/${id}/inspections`, { ...payload, idempotencyKey: "race-a" }),
    post(`/api/masts/${id}/inspections`, { ...payload, idempotencyKey: "race-b" }),
  ]);
  assert.deepEqual([c.status, d.status].sort((x, y) => x - y), [201, 409]);
});

test("重启持久化：进程重载后同键重放仍命中、返回当前版本且不重复落盘", async () => {
  const id = (await post("/api/masts", mastBody())).json.id;
  const payload = { ...mildInspection(), expectedVersion: v(), idempotencyKey: "persist-replay-1" };
  const first = await post(`/api/masts/${id}/inspections`, payload);
  const firstId = first.json.inspection.id;

  // 模拟重启：内存清空，从磁盘重新加载
  await store.simulateRestart();
  const s = await state();
  assert.equal(s.version, Number(first.version), "重启后版本不变");

  // 重启后用旧的 expectedVersion 原样重放：命中持久化的幂等记录
  const replay = await post(`/api/masts/${id}/inspections`, payload);
  assert.equal(replay.status, 201);
  assert.equal(replay.replay, "true");
  assert.equal(replay.json.inspection.id, firstId);
  assert.equal(Number(replay.version), s.version);
  const m = (await state()).masts.find(x => x.id === id);
  assert.equal(m.inspections.length, 1);
});

test("旧入口保持可用：无版本/无幂等键的旧客户端调用照常", async () => {
  const itemId = (await raw("GET", "/api/items")).json.items[0].id || "MR-001";
  const r = await post(`/api/items/${itemId}/logs`, { step: "备注", note: "旧客户端重放回归期间写入" });
  assert.ok([201, 423].includes(r.status));
});
