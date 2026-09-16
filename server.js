import http from "node:http";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, HttpError, bodyFingerprint } from "./src/store.js";
import {
  registerMast, addInspection, createRepair, recheckRepair,
  releaseMast, assertItemUnblocked,
} from "./src/service.js";
import { workbenchPage, mastsPage } from "./src/pages.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbFile = process.env.DB_FILE || join(__dirname, "data", "model-rigging-calibration.json");
const port = Number(process.env.PORT || 3038);
const ALLOW_FAULTS = process.env.ALLOW_FAULTS === "1"; // 测试用：开放写失败注入

function seed() {
  return {
    version: 1,
    idempotency: {},
    "items": [
      {
        "code": "MR-001",
        "shipType": "福船",
        "scale": "1:48",
        "mastCount": 3,
        "riggingMaterial": "蜡线",
        "owner": "周宁",
        "dueDate": "2026-06-28",
        "status": "校准中",
        "tasks": [
          { "id": "T-1", "position": "前桅侧支索", "tension": "偏松", "status": "调整中", "logs": [{ "at": "2026-06-12", "note": "已缩短2mm" }] }
        ],
        "logs": []
      }
    ],
    masts: [],
  };
}

const store = new Store(dbFile, seed);
const statLabels = ["待检查", "校准中", "待复核", "已交付"];
// 桅杆冻结时禁止进入/保持的旧工作台状态
const DELIVERY_STAGES = new Set(["校准中", "待复核", "已交付"]);

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function newId() { return "MR-" + Date.now(); }
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) if (stats[item.status] !== undefined) stats[item.status] += 1;
  return stats;
}
function summarize(db, item) {
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  const linked = db.masts.filter(m => m.itemId && (item.id || item.code) === m.itemId);
  const freezeBlockers = linked.filter(m => m.frozen).map(m => ({ mastId: m.id, mastCode: m.code, reason: m.freezeReason }));
  return { ...item, logCount, frozenMastCount: freezeBlockers.length, freezeBlockers };
}

// 统一事务出口：解析版本/幂等键，捕获冲突与回滚错误
// opts.requireVersion：该写操作必须带版本条件（检测/修复/复检/放行），缺失返 428
async function commit(res, req, mutator, { status = 200, requireVersion = false, scope } = {}) {
  const input = req._body || {};
  const idempotencyKey = req.headers["idempotency-key"] || input.idempotencyKey || undefined;
  // 作用域默认精确到“操作 + 资源路径”，跨资源/跨操作的同键重放会被存储层拒绝
  const scopeKey = scope || `${req.method} ${new URL(req.url, "http://x").pathname}`;
  try {
    const out = await store.mutate(
      {
        expectedVersion: input.expectedVersion,
        requireVersion,
        idempotencyKey,
        scope: scopeKey,
        fingerprint: bodyFingerprint(input),
      },
      db => mutator(db, input)
    );
    // 重放时响应体不变，但 X-Version 返回当前已提交版本（见 store.mutate）
    const headers = { "X-Version": String(out.version) };
    if (out.replay) headers["X-Idempotent-Replay"] = "true";
    return send(res, out.status || status, out.body, headers);
  } catch (err) {
    return handleError(res, err);
  }
}

function handleError(res, err) {
  if (err instanceof HttpError) {
    return send(res, err.status, { error: err.code, ...err, status: undefined, code: undefined, message: undefined });
  }
  return send(res, 500, { error: err.message });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (["POST", "PUT", "PATCH"].includes(req.method)) {
      try { req._body = await body(req); } catch { return send(res, 400, { error: "bad_json" }); }
    }
    const db = await store.read();

    // ---------- 页面（旧入口保持可用） ----------
    if (req.method === "GET" && url.pathname === "/") return html(res, workbenchPage());
    if (req.method === "GET" && url.pathname === "/masts") return html(res, mastsPage());

    // ---------- 旧工作台 API ----------
    if (req.method === "GET" && url.pathname === "/api/items")
      return send(res, 200, { version: db.version, items: db.items.map(i => summarize(db, i)) });

    if (req.method === "POST" && url.pathname === "/api/items") {
      return commit(res, req, (d, input) => {
        const item = { id: newId(), ...input, logs: [{ at: new Date().toISOString(), step: "建档", note: "创建模型" }], tasks: [] };
        d.items.unshift(item);
        return { status: 201, body: summarize(d, item) };
      }, { status: 201 });
    }

    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      return commit(res, req, (d, input) => {
        const item = d.items.find(x => x.id === patch[1] || x.code === patch[1]);
        if (!item) throw new HttpError(404, "item_not_found");
        // 桅杆达停用线冻结时：状态进入校准/复核/交付一律阻断
        if (input.status && input.status !== item.status && DELIVERY_STAGES.has(input.status)) {
          assertItemUnblocked(d, item, `状态变更为${input.status}`);
        }
        Object.assign(item, input);
        delete item.expectedVersion;
        delete item.idempotencyKey;
        item.logs ||= [];
        if (input.status) item.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + item.status });
        return { body: summarize(d, item) };
      });
    }

    const logRoute = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (logRoute && req.method === "POST") {
      return commit(res, req, (d, input) => {
        const item = d.items.find(x => x.id === logRoute[1] || x.code === logRoute[1]);
        if (!item) throw new HttpError(404, "item_not_found");
        item.logs ||= [];
        item.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
        return { status: 201, body: summarize(d, item) };
      }, { status: 201 });
    }

    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      return commit(res, req, (d, input) => {
        const item = d.items.find(x => x.id === action[1] || x.code === action[1]);
        if (!item) throw new HttpError(404, "item_not_found");
        // 冻结期间立即阻断校准作业
        assertItemUnblocked(d, item, "新增帆索校准任务");
        item.logs ||= [];
        item.tasks ||= [];
        item.tasks.push({ id: "T-" + Date.now(), position: input.position, tension: input.tension, status: "待检查", logs: [{ at: new Date().toISOString(), note: input.note || "新增帆索任务" }] });
        item.status = "校准中";
        item.logs.push({ at: new Date().toISOString(), step: "帆索", note: input.position + " · " + input.tension });
        return { status: 201, body: summarize(d, item) };
      }, { status: 201 });
    }

    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));

    // ---------- 测试钩子：模拟下一次写盘失败（验证整体回滚） ----------
    if (ALLOW_FAULTS && req.method === "POST" && url.pathname === "/test/fail-next-write") {
      store.failNextWrite = true;
      return send(res, 200, { ok: true });
    }

    // ---------- 桅杆 API ----------
    if (req.method === "GET" && url.pathname === "/api/masts") {
      return send(res, 200, { version: db.version, masts: db.masts });
    }
    if (req.method === "POST" && url.pathname === "/api/masts") {
      return commit(res, req, (d, input) => ({ status: 201, body: registerMast(d, input) }), { status: 201 });
    }

    const mastInspections = url.pathname.match(/^\/api\/masts\/([^/]+)\/inspections$/);
    if (mastInspections && req.method === "POST") {
      return commit(res, req, (d, input) => {
        const ins = addInspection(d, mastInspections[1], input);
        const mast = d.masts.find(m => m.id === mastInspections[1] || m.code === mastInspections[1]);
        return { status: 201, body: { inspection: ins, snapshot: ins.snapshot, grade: mast.grade, frozen: mast.frozen, freezeReason: mast.freezeReason, remainingLife: mast.remainingLife } };
      }, { status: 201, requireVersion: true });
    }

    const mastRepairs = url.pathname.match(/^\/api\/masts\/([^/]+)\/repairs$/);
    if (mastRepairs && req.method === "POST") {
      return commit(res, req, (d, input) => ({ status: 201, body: createRepair(d, mastRepairs[1], input) }), { status: 201, requireVersion: true });
    }

    const recheck = url.pathname.match(/^\/api\/repairs\/([^/]+)\/recheck$/);
    if (recheck && req.method === "POST") {
      return commit(res, req, (d, input) => ({ status: 201, body: recheckRepair(d, recheck[1], input) }), { status: 201, requireVersion: true });
    }

    const release = url.pathname.match(/^\/api\/masts\/([^/]+)\/release$/);
    if (release && req.method === "POST") {
      return commit(res, req, (d, input) => ({ body: releaseMast(d, release[1], input) }), { requireVersion: true });
    }

    send(res, 404, { error: "not_found" });
  } catch (error) {
    handleError(res, error);
  }
});

server.listen(port, () => console.log("古船模型帆索校准（含桅杆损伤与寿命放行）listening on http://localhost:" + port));

export { server, store };
