// 真实浏览器走查（Playwright + Chromium）：
// 正常登记/检测 → 监测线 → 停用线冻结 → 旧入口交付被阻断 →
// 修复异人复核（本人被拒/复检未过/通过解除）→ 放行一次 → 并发只落一条 →
// 写失败整体回滚 → 重启后数据仍在。关键节点截图到 test/screenshots。
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dbFile = join("/tmp", `mast-e2e-${process.pid}.json`);
const shotDir = join(root, "test", "screenshots");
const port = 41200 + (process.pid % 5000);
const base = `http://localhost:${port}`;

function startServer() {
  return spawn(process.execPath, [join(root, "server.js")], {
    cwd: root,
    env: { ...process.env, DB_FILE: dbFile, PORT: String(port), ALLOW_FAULTS: "1" },
    stdio: "inherit",
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(base + "/api/stats"); if (r.ok) return; } catch {}
    await sleep(100);
  }
  throw new Error("server not up");
}
function check(name, cond) {
  if (!cond) { console.error("✗ " + name); process.exitCode = 1; throw new Error("走查断言失败: " + name); }
  console.log("✓ " + name);
}

rmSync(dbFile, { force: true });
mkdirSync(shotDir, { recursive: true });
let server = startServer();
await waitUp();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const alerts = [];
page.on("dialog", async d => { alerts.push(d.message()); await d.accept(); });
const shot = async (name, p = page) => { await p.screenshot({ path: join(shotDir, name + ".png"), fullPage: true }); };

try {
  // ---------- 旧入口仍可用 ----------
  await page.goto(base + "/");
  check("旧工作台页面可打开", (await page.title()).includes("古船模型帆索校准"));
  check("旧入口可跳转到桅杆损伤台", await page.locator('a[href="/masts"]').count() === 1);
  await shot("01-legacy-workbench");

  // ---------- 桅杆登记 ----------
  await page.goto(base + "/masts");
  await page.fill('#regForm [name=code]', "E2E-MAST");
  await page.fill('#regForm [name=material]', "杉木");
  await page.fill('#regForm [name=allowableStress]', "80");
  await page.fill('#regForm [name=outerD]', "100");
  await page.fill('#regForm [name=innerD]', "80");
  await page.fill('#regForm [name=baselineVelocity]', "3200");
  await page.fill('#regForm [name=points]', "根部,中段,桅顶");
  await page.selectOption('#regForm [name=itemId]', { index: 1 }); // 关联种子模型 MR-001
  await page.click('#regForm button');
  await page.waitForSelector('.mastline:has-text("E2E-MAST")');
  await page.click('.mastline:has-text("E2E-MAST")');
  check("登记后选中桅杆并显示正常等级", await page.locator('#head').innerText().then(t => t.includes("正常")));
  await shot("02-mast-registered");

  const fillIns = async (v) => {
    const f = '#insForm ';
    await page.fill(f + '[name=inspector]', v.inspector);
    await page.selectOption(f + '[name=point]', v.point);
    for (const k of ["crackDepth","crackLength","corrosionDepth","corrosionWidth","brokenWires","velocity","load","cycles"]) {
      await page.fill(f + `[name=${k}]`, String(v[k] ?? 0));
    }
    await page.click('#insForm button');
    await sleep(250);
  };

  // ---------- 正常 → 监测 ----------
  await fillIns({ inspector: "甲", point: "根部", crackDepth: 1, crackLength: 10, corrosionDepth: 4, corrosionWidth: 40, velocity: 3150, load: 10, cycles: 2000 });
  let head = await page.locator('#head').innerText();
  check("达到监测线：等级变监测并标记持续跟踪", head.includes("监测") && head.includes("持续跟踪"));
  check("寿命趋势图已渲染", await page.locator('#charts svg').count() >= 5);
  await shot("03-monitor-line");

  // ---------- 停用线：立即冻结 ----------
  await fillIns({ inspector: "甲", point: "中段", crackDepth: 8, crackLength: 40, corrosionDepth: 3, corrosionWidth: 40, velocity: 2700, load: 50, cycles: 50000 });
  head = await page.locator('#head').innerText();
  check("达到停用线：等级停用+已冻结", head.includes("停用") && head.includes("已冻结"));
  check("冻结横幅显示阻断原因", await page.locator('#freeze').innerText().then(t => t.includes("停用线")));
  check("放行按钮被禁用", await page.locator('#releaseBtn').isDisabled());
  await shot("04-frozen-stop-line");

  // ---------- 旧工作台：交付与校准被阻断 ----------
  await page.goto(base + "/");
  await page.waitForSelector('.card');
  check("旧工作台卡片出现冻结阻断横幅", await page.locator('.freezebanner').first().innerText().then(t => t.includes("E2E-MAST")));
  const sel = page.locator('.card select[data-status]').first();
  alerts.length = 0;
  await sel.selectOption("已交付");
  await sleep(300);
  check("旧入口交付被 423 阻断并弹错", alerts.some(a => a.includes("阻断")));
  const statusPill = await page.locator('.card .pill').first().innerText();
  check("状态未被改成已交付（仍为校准中）", statusPill.includes("校准中"));
  await shot("05-legacy-delivery-blocked");

  // ---------- 修复：本人复核被拒（身份以触发冻结的实际检测记录为准） ----------
  await page.goto(base + "/masts");
  await page.click('.mastline:has-text("E2E-MAST")');
  await sleep(200);
  // 页面上直接显示服务端绑定的触发检测操作者，表单已无“原检测人”字段
  check("修复区显示服务端绑定的触发检测人甲",
    await page.locator('#repairTrigger').innerText().then(t => t.includes("甲") && t.includes("操作者")));
  await page.fill('#repairForm [name=actions]', "焊补裂纹,更换腐段");
  await page.click('#repairForm button');
  await sleep(300);

  // 即使请求体伪造“原检测人=别人”，修复单仍必须绑定实际触发记录的操作者甲
  const forged = await page.evaluate(async () => {
    let s = await fetch('/api/masts').then(r => r.json());
    const m = s.masts.find(x => x.code === "E2E-MAST");
    const r = await fetch('/api/masts/' + m.id + '/repairs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inspector: "冒充者", actions: ["伪造"], expectedVersion: s.version }),
    }).then(x => x.json());
    // 立即由乙复检关闭该单（未过，维持冻结），避免遗留待复核单阻断后续放行
    s = await fetch('/api/masts').then(r => r.json());
    const close = await fetch('/api/repairs/' + r.id + '/recheck', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewer: "乙", passed: "false", crackDepth: 7, crackLength: 40, expectedVersion: s.version }),
    }).then(x => x.status);
    const s2 = await fetch('/api/masts').then(r => r.json());
    version = s2.version; // 同步页面版本号，供后续 UI 表单提交
    return { inspector: r.inspector, trigger: r.triggerInspectionId, closeStatus: close };
  }, );
  check("修复单忽略请求自报原检测人，绑定触发冻结的实际检测记录",
    forged.inspector === "甲" && !!forged.trigger && forged.closeStatus === 201);
  await page.click('.mastline:has-text("E2E-MAST")'); await sleep(200);

  await page.selectOption('#repairSel', { index: 0 });
  await page.fill('#recheckForm [name=reviewer]', "甲");
  await page.selectOption('#recheckForm [name=passed]', "true");
  alerts.length = 0;
  await page.click('#recheckForm button');
  await sleep(400);
  check("触发记录本人复核被拒绝（toast 403）", await page.locator('#toast').innerText().then(t => t.includes("reviewer_must_be_different")));

  // ---------- 他人复核但复检未过：维持冻结 ----------
  await page.fill('#recheckForm [name=reviewer]', "乙");
  await page.selectOption('#recheckForm [name=passed]', "false");
  await page.fill('#recheckForm [name=crackDepth]', "7");
  await page.fill('#recheckForm [name=crackLength]', "40");
  await page.click('#recheckForm button');
  await sleep(300);
  head = await page.locator('#head').innerText();
  check("复检未过：冻结不得解除", head.includes("已冻结") && (await page.locator('#releaseBox').innerText()).includes("复检未过"));
  await shot("06-recheck-failed-still-frozen");

  // ---------- 并发：同幂等键并发两条检测只落一条（在仍冻结时也会被记录） ----------
  const beforeCount = await page.$$eval('#history tr', rows => rows.length);
  const oneInserted = await page.evaluate(async () => {
    const ver = await fetch('/api/masts').then(r => r.json());
    const m = ver.masts.find(x => x.code === "E2E-MAST");
    const payload = { inspector: "甲", point: "桅顶", corrosionDepth: 1, corrosionWidth: 5, velocity: 3000, load: 5, cycles: 10, expectedVersion: ver.version, idempotencyKey: "e2e-dup" };
    const rs = await Promise.all([
      fetch('/api/masts/' + m.id + '/inspections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
      fetch('/api/masts/' + m.id + '/inspections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
    ]);
    const codes = rs.map(r => r.status);
    const after = await fetch('/api/masts').then(r => r.json());
    const mast = after.masts.find(x => x.code === "E2E-MAST");
    version = after.version; // 同步页面内版本号，避免后续表单提交版本过期
    return { codes, count: mast.inspections.filter(i => i.note === "" && i.point === "桅顶").length };
  });
  check("并发同键：一次201一次重放，且只落一条", oneInserted.codes.includes(201) && oneInserted.count === 1);

  // ---------- 无版本并发：两条都必须 428 ----------
  const noVersion = await page.evaluate(async () => {
    const m = (await fetch('/api/masts').then(r => r.json())).masts.find(x => x.code === "E2E-MAST");
    const body = { inspector: "甲", point: "桅顶", corrosionDepth: 1, corrosionWidth: 5, velocity: 3000, load: 5, cycles: 1 };
    const rs = await Promise.all([
      fetch('/api/masts/' + m.id + '/inspections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      fetch('/api/masts/' + m.id + '/inspections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    ]);
    const codes = await Promise.all(rs.map(async r => ({ s: r.status, e: (await r.json()).error })));
    return codes;
  });
  check("无版本并发检测全部 428 拒绝", noVersion.every(c => c.s === 428 && c.e === "version_required"));

  // ---------- 幂等键跨资源复用：必须 409，不能回放旧响应 ----------
  const keyScope = await page.evaluate(async () => {
    const s = await fetch('/api/masts').then(r => r.json());
    // 用 E2E-MAST 先占用键
    const m = s.masts.find(x => x.code === "E2E-MAST");
    const first = await fetch('/api/masts/' + m.id + '/repairs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions: ["占键"], expectedVersion: s.version, idempotencyKey: "scope-key-x" }),
    }).then(r => r.json());
    // 用乙复检关闭该单（未过，维持冻结），避免遗留待复核单阻断后续放行
    const sa = await fetch('/api/masts').then(r => r.json());
    await fetch('/api/repairs/' + first.id + '/recheck', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewer: "乙", passed: "false", crackDepth: 7, crackLength: 40, expectedVersion: sa.version }),
    });
    // 登记另一根桅杆后复用同一把键
    const reg = await fetch('/api/masts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: "E2E-OTHER", material: "杉木", section: "圆管", allowableStress: 80, dims: { outerD: 100, innerD: 80 }, points: ["根部"] }),
    }).then(r => r.json());
    const s2 = await fetch('/api/masts').then(r => r.json());
    const conflict = await fetch('/api/masts/' + reg.id + '/repairs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions: ["跨资源"], expectedVersion: s2.version, idempotencyKey: "scope-key-x" }),
    }).then(async r => ({ s: r.status, e: (await r.json()).error }));
    const s3 = await fetch('/api/masts').then(r => r.json());
    version = s3.version; // 同步页面版本变量，供后续 UI 表单提交
    return conflict;
  });
  check("同键跨资源/跨操作复用返回 409 且不回放", keyScope.s === 409 && keyScope.e === "idempotency_key_reuse_conflict");

  // ---------- 回滚：写盘失败时损伤/冻结整体回滚 ----------
  const before = await (await fetch(base + "/api/masts")).json();
  const mastId = before.masts.find(x => x.code === "E2E-MAST").id;
  await page.evaluate(() => fetch('/test/fail-next-write', { method: 'POST' }));
  const rollback = await page.evaluate(async (id) => {
    const s0 = await fetch('/api/masts').then(r => r.json());
    const m0 = s0.masts.find(x => x.id === id);
    const n0 = m0.inspections.length, v0 = s0.version, f0 = m0.frozen;
    const r = await fetch('/api/masts/' + id + '/inspections', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inspector: "甲", point: "桅顶", crackDepth: 20, crackLength: 40, expectedVersion: s0.version }),
    });
    const s1 = await fetch('/api/masts').then(r => r.json());
    const m1 = s1.masts.find(x => x.id === id);
    return { submitStatus: r.status, frozenBefore: f0, frozenAfter: m1.frozen, nBefore: n0, nAfter: m1.inspections.length, vBefore: v0, vAfter: s1.version };
  }, mastId);
  check("回滚：写失败返回500", rollback.submitStatus === 500);
  check("回滚：检测未落、冻结状态不变、版本不前进",
    rollback.nAfter === rollback.nBefore && rollback.frozenAfter === rollback.frozenBefore && rollback.vAfter === rollback.vBefore);

  // ---------- 幂等重放版本不滞后（真实浏览器路径） ----------
  const replayBlock = await page.evaluate(async () => {
    let s = await fetch('/api/masts').then(r => r.json());
    // 登记一根专用桅杆并提交一条带幂等键的温和检测
    const reg = await fetch('/api/masts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: "E2E-REPLAY", material: "杉木", section: "圆管", allowableStress: 80, dims: { outerD: 100, innerD: 80 }, baselineVelocity: 3200, points: ["根部", "桅顶"] }),
    }).then(r => r.json());
    const id = reg.id;
    const payload = { inspector: "甲", point: "根部", crackDepth: 1, crackLength: 5, corrosionDepth: 0, corrosionWidth: 0, velocity: 3200, load: 5, cycles: 10, expectedVersion: (await fetch('/api/masts').then(r => r.json())).version, idempotencyKey: "ui-replay-key" };
    const first = await fetch('/api/masts/' + id + '/inspections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const firstVersion = Number(first.headers.get('x-version'));
    const firstId = (await first.json()).inspection.id;

    // 穿插另一次写入推进版本
    s = await fetch('/api/masts').then(r => r.json());
    await fetch('/api/masts/' + id + '/inspections', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inspector: "甲", point: "桅顶", crackDepth: 1, crackLength: 5, velocity: 3200, load: 5, cycles: 10, expectedVersion: s.version }),
    });
    const currentVersion = (await fetch('/api/masts').then(r => r.json())).version;

    // 原样重放（仍带首次的旧 expectedVersion）：必须命中、回放同一记录、返回当前版本
    const replay = await fetch('/api/masts/' + id + '/inspections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const replayJson = await replay.json();
    const afterCount = (await fetch('/api/masts').then(r => r.json())).masts.find(x => x.id === id).inspections.length;
    return {
      firstId, firstVersion, currentVersion,
      replayStatus: replay.status,
      replayFlag: replay.headers.get('x-idempotent-replay'),
      replayVersion: Number(replay.headers.get('x-version')),
      replayId: replayJson.inspection && replayJson.inspection.id,
      afterCount,
      // 把“重放返回的当前版本”交回页面环境，供后续 UI 表单提交
      clientVersion: Number(replay.headers.get('x-version')),
      mastId: id,
    };
  });
  // 将重放返回的版本同步到页面内全局 version 变量（模拟客户端采用响应版本）
  check("重放命中并回放同一记录", replayBlock.replayStatus === 201 && replayBlock.replayFlag === "true" && replayBlock.replayId === replayBlock.firstId);
  check("重放只落一条（首发+穿插=2，重放不多落）", replayBlock.afterCount === 2);
  check("重放返回当前版本而非首次旧版本", replayBlock.replayVersion === replayBlock.currentVersion && replayBlock.replayVersion > replayBlock.firstVersion);

  // 采用重放返回的版本后，经 UI 表单继续提交检测不被 409 挡回
  await page.reload();
  await page.waitForSelector('.mastline:has-text("E2E-REPLAY")');
  await page.click('.mastline:has-text("E2E-REPLAY")');
  await sleep(200);
  await fillIns({ inspector: "甲", point: "桅顶", crackDepth: 1, crackLength: 6, corrosionDepth: 0, corrosionWidth: 0, brokenWires: 0, velocity: 3198, load: 5, cycles: 12 });
  const uiToast = await page.locator('#toast').innerText();
  check("重放后 UI 继续提交检测成功（不被过期版本挡回）", uiToast.includes("检测已提交"));
  const afterUi = (await (await fetch(base + "/api/masts")).json()).masts.find(x => x.code === "E2E-REPLAY");
  check("UI 检测确实新增一条（共3条）", afterUi.inspections.length === 3);
  // 该桅杆可正常放行，证明后续放行链路版本连续
  await page.fill('#approver', "复检官");
  await page.click('#releaseBtn');
  await sleep(300);
  check("重放后放行成功（版本连续）", await page.locator('#releaseBox').innerText().then(t => t.includes("已由 复检官 放行")));

  // ---------- 新修复单 + 异人复检通过：解除冻结 ----------
  // 前序裸 fetch 可能推进版本，先刷新页面数据
  await page.evaluate(() => location.reload());
  await page.waitForSelector('.mastline:has-text("E2E-MAST")');
  await page.click('.mastline:has-text("E2E-MAST")');
  await sleep(300);
  await page.fill('#repairForm [name=actions]', "整段更换");
  await page.click('#repairForm button');
  await sleep(300);
  // 选最新待复核单（下拉第二个）
  const opts = await page.locator('#repairSel option').count();
  await page.selectOption('#repairSel', { index: opts - 1 });
  await page.fill('#recheckForm [name=reviewer]', "乙");
  await page.selectOption('#recheckForm [name=passed]', "true");
  for (const k of ["crackDepth","crackLength","corrosionDepth","corrosionWidth","brokenWires"]) {
    await page.fill('#recheckForm [name=' + k + ']', "0");
  }
  await page.fill('#recheckForm [name=velocity]', "3180");
  await page.fill('#recheckForm [name=load]', "10");
  await page.fill('#recheckForm [name=cycles]', "0");
  await page.click('#recheckForm button');
  await sleep(400);
  head = await page.locator('#head').innerText();
  check("异人复检通过：冻结解除", !head.includes("已冻结") && head.includes("正常"));
  await shot("07-recheck-passed-unfrozen");

  // ---------- 放行只能成功一次 ----------
  await page.fill('#approver', "船政大臣");
  await page.click('#releaseBtn');
  await sleep(300);
  check("放行成功显示已放行", await page.locator('#releaseBox').innerText().then(t => t.includes("已由 船政大臣 放行")));
  check("放行后按钮消失，无法重复放行", await page.locator('#releaseBtn').count() === 0);
  await shot("08-released-once");

  // 新检测使旧放行失效，可重新放行
  await fillIns({ inspector: "丙", point: "桅顶", crackDepth: 1, crackLength: 5, corrosionDepth: 1, corrosionWidth: 5, velocity: 3175, load: 5, cycles: 10 });
  const rb = await page.locator('#releaseBox').innerText();
  check("新检测后旧放行失效，要求重新放行", rb.includes("须重新放行") && await page.locator('#releaseBtn').isEnabled());
  await page.fill('#approver', "船政大臣");
  await page.click('#releaseBtn');
  await sleep(300);
  check("重新放行成功", await page.locator('#releaseBox').innerText().then(t => t.includes("放行")));

  // ---------- 重放响应主体不漂移（真实浏览器路径，专用桅杆） ----------
  const snapshotDrift = await page.evaluate(async () => {
    const get = async () => (await fetch('/api/masts').then(r => r.json()));
    const reg = async (code) => (await fetch('/api/masts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, material: "杉木", section: "圆管", allowableStress: 80, dims: { outerD: 100, innerD: 80 }, baselineVelocity: 3200, points: ["根部", "桅顶"] }),
    }).then(r => r.json())).id;
    const post = async (p, b) => {
      const r = await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
      return { status: r.status, replay: r.headers.get('x-idempotent-replay'), xv: Number(r.headers.get('x-version')), json: await r.json() };
    };

    // —— 修复单：复检通过后重放，主体必须仍是首次“待复核” ——
    const rpMast = await reg("E2E-SNAP-RP");
    let s = await get();
    await post(`/api/masts/${rpMast}/inspections`, { inspector: "甲", point: "根部", crackDepth: 8, crackLength: 40, corrosionDepth: 3, corrosionWidth: 40, velocity: 2700, load: 50, cycles: 1000, expectedVersion: s.version });
    s = await get();
    const repairPayload = { actions: ["焊补裂纹"], note: "首次报修", expectedVersion: s.version, idempotencyKey: "snap-rp-key" };
    const firstRp = await post(`/api/masts/${rpMast}/repairs`, repairPayload);
    const rpId = firstRp.json.id;
    s = await get();
    await post(`/api/repairs/${rpId}/recheck`, { reviewer: "乙", passed: true, velocity: 3200, load: 5, cycles: 0, expectedVersion: s.version });
    const cur = await get();
    const replayRp = await post(`/api/masts/${rpMast}/repairs`, repairPayload);
    const currentRp = cur.masts.find(m => m.id === rpMast).repairs[0];

    // —— 放行：新检测使放行失效后重放，主体必须仍是首次有效放行 ——
    const relMast = await reg("E2E-SNAP-REL");
    s = await get();
    await post(`/api/masts/${relMast}/inspections`, { inspector: "甲", point: "根部", crackDepth: 1, crackLength: 5, velocity: 3198, load: 5, cycles: 10, expectedVersion: s.version });
    s = await get();
    const relPayload = { approver: "丁", note: "准予交付", expectedVersion: s.version, idempotencyKey: "snap-rel-key" };
    const firstRel = await post(`/api/masts/${relMast}/release`, relPayload);
    s = await get();
    await post(`/api/masts/${relMast}/inspections`, { inspector: "甲", point: "桅顶", crackDepth: 1, crackLength: 5, velocity: 3197, load: 5, cycles: 10, expectedVersion: s.version });
    const cur2 = await get();
    const replayRel = await post(`/api/masts/${relMast}/release`, relPayload);
    const currentRel = cur2.masts.find(m => m.id === relMast).release;

    return {
      repair: {
        replayFlag: replayRp.replay,
        bodyStatus: replayRp.json.status, bodyReviewer: replayRp.json.reviewer, bodyRecheck: replayRp.json.recheck,
        currentStatus: currentRp.status, currentReviewer: currentRp.reviewer,
        versionCurrent: replayRp.xv === cur.version,
        repairCount: cur.masts.find(m => m.id === rpMast).repairs.length,
      },
      release: {
        replayFlag: replayRel.replay,
        bodyApprover: replayRel.json.approver, bodyInvalidated: replayRel.json.invalidated, bodyAt: replayRel.json.at,
        firstAt: firstRel.json.at,
        currentInvalidated: currentRel.invalidated,
        versionCurrent: replayRel.xv === cur2.version,
      },
    };
  });
  check("修复单重放主体为首次待复核快照（无复核人/复检）",
    snapshotDrift.repair.replayFlag === "true"
    && snapshotDrift.repair.bodyStatus === "待复核"
    && snapshotDrift.repair.bodyReviewer === null
    && snapshotDrift.repair.bodyRecheck === null);
  check("重放不覆盖当前业务（修复单当前已复检通过）且不重复落盘",
    snapshotDrift.repair.currentStatus === "复检通过" && snapshotDrift.repair.currentReviewer === "乙"
    && snapshotDrift.repair.repairCount === 1);
  check("重放版本号单独反映当前状态", snapshotDrift.repair.versionCurrent);
  check("放行重放主体为首次有效放行（invalidated=false）",
    snapshotDrift.release.replayFlag === "true"
    && snapshotDrift.release.bodyApprover === "丁"
    && snapshotDrift.release.bodyInvalidated === false
    && snapshotDrift.release.bodyAt === snapshotDrift.release.firstAt);
  check("放行重放不覆盖当前失效状态", snapshotDrift.release.currentInvalidated === true && snapshotDrift.release.versionCurrent);

  // ---------- 持久化：重启服务后数据仍在 ----------
  await browser.close();
  server.kill();
  await sleep(500);
  server = startServer();
  await waitUp();
  const browser2 = await chromium.launch();
  const page2 = await browser2.newPage({ viewport: { width: 1360, height: 900 } });
  await page2.goto(base + "/masts");
  await page2.waitForSelector('.mastline:has-text("E2E-MAST")');
  await page2.click('.mastline:has-text("E2E-MAST")');
  const head2 = await page2.locator('#head').innerText();
  check("重启后桅杆与等级仍在", head2.includes("E2E-MAST") && head2.includes("正常"));
  const hist2 = await page2.locator('#history').innerText();
  check("重启后检测/复检/修复流水仍在", hist2.includes("修复单") && hist2.includes("复检"));
  const rel2 = await page2.locator('#releaseBox').innerText();
  check("重启后放行结论仍在", rel2.includes("船政大臣"));

  // 重启后同键重放仍命中持久化的幂等记录，返回当前版本且不重复落盘
  const replayAfterRestart = await page2.evaluate(async () => {
    const s = await fetch('/api/masts').then(r => r.json());
    const m = s.masts.find(x => x.code === "E2E-REPLAY");
    const before = m.inspections.length;
    // 指纹只看请求内容（剔除版本/幂等字段），expectedVersion 给过期值也应命中重放
    const r = await fetch('/api/masts/' + m.id + '/inspections', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inspector: "甲", point: "根部", crackDepth: 1, crackLength: 5, corrosionDepth: 0, corrosionWidth: 0, velocity: 3200, load: 5, cycles: 10, expectedVersion: 1, idempotencyKey: "ui-replay-key" }),
    });
    const j = await r.json();
    const after = (await fetch('/api/masts').then(r => r.json())).masts.find(x => x.code === "E2E-REPLAY");
    return {
      status: r.status, replay: r.headers.get('x-idempotent-replay'),
      xv: Number(r.headers.get('x-version')), current: s.version,
      count: after.inspections.length, before,
      grade: j.grade,
    };
  });
  check("重启后同键重放命中且不重复落盘",
    replayAfterRestart.status === 201 && replayAfterRestart.replay === "true"
    && replayAfterRestart.count === replayAfterRestart.before
    && replayAfterRestart.count === 3);
  check("重启后重放返回当前版本", replayAfterRestart.xv === replayAfterRestart.current);

  await shot("09-after-restart-persisted", page2);
  await browser2.close();

  console.log("\n浏览器走查全部通过，截图见 test/screenshots/");
  process.exitCode = 0;
} catch (err) {
  console.error(err);
  try { await page.screenshot({ path: join(shotDir, "FAIL.png"), fullPage: true }); } catch {}
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  server.kill();
  // 显式退出，避免子进程句柄/管道让 node 挂住
  setTimeout(() => process.exit(process.exitCode || 0), 300).unref();
}
