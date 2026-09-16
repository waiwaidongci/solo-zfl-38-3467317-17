// 两个 HTML 页面：旧工作台（入口保持可用）与桅杆损伤检测/寿命放行台。

export function workbenchPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古船模型帆索校准</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:90px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    nav a { margin-left:12px; font-size:14px; } .freezebanner { background:#fbeae6; border:1px solid var(--warn); color:var(--warn); border-radius:8px; padding:10px 12px; margin-bottom:10px; font-weight:700; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古船模型帆索校准</h1><div class="meta">模型、帆索任务和校准记录串联</div></div><div><nav><a href="/masts">桅杆损伤与寿命放行 →</a></nav><button id="reload">刷新</button></div></header>
  <main>
    <section>
      <form id="createForm"><h2>新增模型</h2><div id="fields"></div><label>初始状态</label><select name="status">${["待检查","校准中","待复核","已交付"].map(s => '<option>'+s+'</option>').join('')}</select><button>保存模型</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>新增帆索任务</h2><label>选择模型</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button>提交记录</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${["待检查","校准中","待复核","已交付"].map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>创建模型后可拆分帆索任务，逐条记录松紧状态、调整备注和完成时间。</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const fields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];
    const stages = ["待检查","校准中","待复核","已交付"];
    const extraFields = [["position","索具位置"],["tension","松紧状态"],["note","调整备注"]];
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    let items = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
    }
    function esc(s){ return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+esc(item.id || item.code)+'">'+esc(item.code || item.id)+' · '+esc(item.name || item.shipType || item.source || item.plateSize || '')+'</option>').join('');
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => {
        try { await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value, expectedVersion: window.__dbVersion }) }); await load(); }
        catch (e) { alert('操作被阻断：'+e.message); await load(); }
      });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.note; const note = prompt('记录备注'); if (note) { await api('/api/items/'+id+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } });
    }
    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+esc(item[key] ?? '')+'</div>').join('');
      const tasks = (item.tasks || []).map(t => '<div class="meta">任务 '+esc(t.position)+' · '+esc(t.status)+' · '+esc(t.tension)+'</div>').join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+esc(l.step)+'：'+esc(l.note)+'</div>').join('');
      const freeze = item.freezeBlockers && item.freezeBlockers.length ? '<div class="freezebanner">[停] 关联桅杆已冻结，校准与交付阻断：'+item.freezeBlockers.map(b=>esc(b.mastCode)+' '+esc(b.reason)).join('；')+'</div>' : '';
      return '<article class="card"><h3>'+esc(item.code || item.id)+'</h3><span class="pill">'+esc(item.status)+'</span>'+freeze+main+tasks+'<label>状态</label><select data-status="'+esc(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select><button class="secondary" data-note="'+esc(item.id || item.code)+'">追加备注</button><div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    async function load() {
      const data = await api('/api/items');
      items = data.items || data; window.__dbVersion = data.version || window.__dbVersion;
      render();
    }
    createForm.onsubmit = async event => { event.preventDefault(); await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); await load(); };
    actionForm.onsubmit = async event => { event.preventDefault();
      try { await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(actionForm).entries())) }); actionForm.reset(); await load(); }
      catch (e) { alert('新增帆索任务被阻断：'+e.message); }
    };
    document.querySelector('#statusFilter').onchange = render; document.querySelector('#search').oninput = render; document.querySelector('#reload').onclick = load;
    renderForms(); load();
  </script>
</body>
</html>`;
}

export function mastsPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>桅杆损伤检测与寿命放行</title>
  <style>
    :root { --bg:#eef2ea; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#3f6b4a; --warn:#9b4937; --mon:#b47a2c; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:20px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; }
    h1 { margin:0; font-size:24px; } h2,h3 { margin:0 0 10px; } nav a { font-size:14px; }
    main { display:grid; grid-template-columns:minmax(320px,400px) 1fr; gap:18px; padding:18px 28px; align-items:start; }
    form,.panel,.card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; margin-bottom:14px; }
    label { display:block; margin:8px 0 4px; color:var(--muted); font-size:12px; }
    input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 12px; font-weight:700; cursor:pointer; margin-top:10px; }
    button.gray { background:#69736a; } button:disabled { opacity:.45; cursor:not-allowed; }
    .row { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .meta { color:var(--muted); font-size:12px; }
    .list { display:grid; gap:8px; }
    .mastline { display:flex; justify-content:space-between; gap:8px; border:1px solid var(--line); border-radius:8px; padding:9px 12px; cursor:pointer; background:#fff; }
    .mastline.active { border-color:var(--accent); box-shadow:0 0 0 2px rgba(63,107,74,.2); }
    .pill { display:inline-block; border-radius:999px; padding:2px 10px; font-size:12px; font-weight:700; }
    .g0 { background:#e4f1e4; color:#2c6134; } .g1 { background:#fbf0dc; color:var(--mon); } .g2 { background:#fbe3dd; color:var(--warn); }
    .freezebanner { background:#fbe3dd; border:2px solid var(--warn); color:var(--warn); border-radius:8px; padding:12px; font-weight:700; margin-bottom:12px; }
    .blocker { background:#fbe3dd; color:var(--warn); border-radius:6px; padding:7px 10px; font-size:13px; margin:5px 0; font-weight:700; }
    .oknote { color:#2c6134; font-weight:700; }
    .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    table { width:100%; border-collapse:collapse; font-size:12px; } th,td { border-bottom:1px solid var(--line); padding:5px 6px; text-align:left; }
    .chartbox { background:#fafcf8; border:1px solid var(--line); border-radius:8px; padding:8px; }
    .toast { position:fixed; right:20px; bottom:20px; max-width:380px; background:#20241f; color:#fff; padding:12px 16px; border-radius:8px; font-size:13px; display:none; z-index:9; }
    .toast.err { background:var(--warn); }
    @media (max-width:960px){ main{grid-template-columns:1fr;padding:12px;} }
  </style>
</head>
<body>
  <header><div><h1>桅杆损伤检测与寿命放行</h1><div class="meta">裂纹 · 腐蚀 · 断丝 · 声速 · 载荷循环 → 剩余截面 / 累计疲劳 → 安全等级与剩余寿命</div></div>
    <nav><a href="/">← 返回帆索校准工作台</a></nav></header>
  <main>
    <div>
      <form id="regForm" class="panel">
        <h2>① 桅杆登记</h2>
        <div class="row">
          <div><label>桅杆编号</label><input name="code" required placeholder="MAST-01"></div>
          <div><label>材料</label><input name="material" required placeholder="杉木 / Q345钢"></div>
        </div>
        <div class="row">
          <div><label>截面形式</label><select name="section" id="sectionSel"><option>圆管</option><option>实心圆杆</option><option>矩形杆</option><option>绳缆</option></select></div>
          <div><label>许用应力 MPa</label><input name="allowableStress" type="number" step="0.1" required></div>
        </div>
        <div class="row">
          <div><label>外径/直径 mm</label><input name="outerD" type="number" step="0.01"></div>
          <div><label>内径 mm（圆管）</label><input name="innerD" type="number" step="0.01"></div>
        </div>
        <div class="row">
          <div><label>宽 mm（矩形）</label><input name="width" type="number" step="0.01"></div>
          <div><label>厚 mm（矩形）</label><input name="thickness" type="number" step="0.01"></div>
        </div>
        <div class="row">
          <div><label>丝数（绳缆）</label><input name="wireCount" type="number"></div>
          <div><label>基准声速 m/s</label><input name="baselineVelocity" type="number" step="0.1"></div>
        </div>
        <label>检测点（逗号分隔）</label><input name="points" placeholder="根部,中段,桅顶">
        <label>关联模型（可选）</label><select name="itemId" id="itemSel"><option value="">不关联</option></select>
        <button>登记桅杆</button>
      </form>
      <div class="panel"><h2>桅杆列表</h2><div class="list" id="mastList"></div></div>
    </div>

    <div id="detail" class="panel" style="display:none">
      <div id="head"></div>
      <div id="freeze"></div>
      <div class="grid2">
        <form id="insForm">
          <h2>② 录入检测（本次新增量）</h2>
          <div class="row"><div><label>检测点</label><select name="point" id="pointSel"></select></div><div><label>检测人</label><input name="inspector" required></div></div>
          <div class="row"><div><label>裂纹深 mm</label><input name="crackDepth" type="number" step="0.01" value="0"></div><div><label>裂纹长 mm</label><input name="crackLength" type="number" step="0.01" value="0"></div></div>
          <div class="row"><div><label>腐蚀深 mm</label><input name="corrosionDepth" type="number" step="0.01" value="0"></div><div><label>腐蚀宽 mm</label><input name="corrosionWidth" type="number" step="0.01" value="0"></div></div>
          <div class="row"><div><label>断丝数（绳缆）</label><input name="brokenWires" type="number" value="0"></div><div><label>声速 m/s</label><input name="velocity" type="number" step="0.1"></div></div>
          <div class="row"><div><label>本次载荷 kN</label><input name="load" type="number" step="0.01" value="0"></div><div><label>新增载荷循环</label><input name="cycles" type="number" value="0"></div></div>
          <label>备注</label><input name="note"><button>提交检测</button>
        </form>
        <div>
          <h2>③ 损伤与寿命</h2>
          <div id="charts"></div>
        </div>
      </div>

      <div class="grid2" style="margin-top:12px">
        <form id="repairForm">
          <h2>④ 修复（冻结后报修）</h2>
          <div id="repairTrigger" class="meta"></div>
          <div class="row"><div><label>修复措施</label><input name="actions" placeholder="焊补/换丝/涂护"></div><div><label>&nbsp;</label><input name="note" placeholder="说明（可选）"></div></div>
          <button class="gray">提交修复单</button>
        </form>
        <form id="recheckForm">
          <h2>⑤ 复核 + 复检（须非原检测人）</h2>
          <label>修复单</label><select name="repairId" id="repairSel"></select>
          <div class="row"><div><label>复核人</label><input name="reviewer" required></div><div><label>复检结论</label><select name="passed"><option value="true">通过</option><option value="false">未过</option></select></div></div>
          <div class="row"><div><label>残余裂纹深</label><input name="crackDepth" type="number" step="0.01" value="0"></div><div><label>残余裂纹长</label><input name="crackLength" type="number" step="0.01" value="0"></div></div>
          <div class="row"><div><label>残余腐蚀深</label><input name="corrosionDepth" type="number" step="0.01" value="0"></div><div><label>残余腐蚀宽</label><input name="corrosionWidth" type="number" step="0.01" value="0"></div></div>
          <div class="row"><div><label>残余断丝</label><input name="brokenWires" type="number" value="0"></div><div><label>复检声速</label><input name="velocity" type="number" step="0.1"></div></div>
          <div class="row"><div><label>当前载荷 kN</label><input name="load" type="number" step="0.01" value="0"></div><div><label>新增循环</label><input name="cycles" type="number" value="0"></div></div>
          <button class="gray">提交复检</button>
        </form>
      </div>

      <div style="margin-top:12px">
        <h2>⑥ 放行</h2>
        <div id="releaseBox"></div>
      </div>
      <div style="margin-top:12px"><h2>检测/修复流水</h2><div id="history"></div></div>
    </div>
  </main>
  <div class="toast" id="toast"></div>
  <script>
  ${mastsScript()}
  </script>
</body>
</html>`;
}

function mastsScript() {
  return String.raw`
    let masts = [], current = null, version = 0;
    const $ = s => document.querySelector(s);
    function toast(msg, err){ const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(()=>t.style.display='none', 4200); }
    async function api(path, options={}) {
      options.headers = { 'Content-Type': 'application/json', ...(options.headers||{}) };
      const res = await fetch(path, options);
      const xv = res.headers.get('x-version');
      if (xv) version = Number(xv);
      const data = await res.json().catch(()=>({}));
      if (!res.ok) { const e = new Error((data && data.error) || '请求失败'); e.status = res.status; e.data = data; throw e; }
      return data;
    }
    const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    const pct = v => (v*100).toFixed(1)+'%';

    async function loadItems() {
      const data = await api('/api/items');
      const items = data.items || data; version = data.version || version;
      $('#itemSel').innerHTML = '<option value="">不关联</option>' + items.map(i => '<option value="'+esc(i.id||i.code)+'">'+esc(i.code)+'</option>').join('');
    }
    async function loadMasts(keepId) {
      const data = await api('/api/masts'); version = data.version || version; masts = data.masts || [];
      if (keepId && masts.some(m => m.id === keepId)) current = masts.find(m => m.id === keepId);
      renderList(); renderDetail();
    }
    function renderList() {
      $('#mastList').innerHTML = masts.map(m => '<div class="mastline'+(current&&current.id===m.id?' active':'')+'" data-id="'+esc(m.id)+'"><span><b>'+esc(m.code)+'</b> <span class="meta">'+esc(m.material)+' · '+esc(m.section)+'</span></span><span class="pill g'+m.gradeLevel+'">'+esc(m.grade)+(m.frozen?' [停]':'')+(m.tracking?' [跟]':'')+(m.release&&!m.release.invalidated?' [放行]':'')+'</span></div>').join('')
        || '<div class="meta">尚未登记桅杆</div>';
      document.querySelectorAll('.mastline').forEach(el => el.onclick = () => { current = masts.find(m => m.id === el.dataset.id); renderList(); renderDetail(); });
    }
    function renderDetail() {
      if (!current) { $('#detail').style.display = 'none'; return; }
      $('#detail').style.display = 'block';
      $('#head').innerHTML = '<h2>'+esc(current.code)+' <span class="pill g'+current.gradeLevel+'">'+esc(current.grade)+'</span>'
        + (current.frozen?'<span class="pill g2">已冻结</span>':'')
        + (current.tracking?'<span class="pill g1">持续跟踪</span>':'')
        + (current.release&&!current.release.invalidated?'<span class="pill g0">已放行</span>':'')+'</h2>'
        + '<div class="meta">'+esc(current.material)+' · '+esc(current.section)+' · 公称面积 '+current.nominalArea+'mm² · 许用 '+current.allowableStress+'MPa · 检测点：'+esc((current.points||[]).join('、'))+(current.itemId?' · 关联模型 '+esc(current.itemId):'')+'</div>';
      $('#freeze').innerHTML = current.frozen
        ? '<div class="freezebanner">[停] 已达停用线，校准与交付立即冻结。阻断原因：'+esc(current.freezeReason||'指标达停用线')+'。须由非原检测人复核修复，复检通过方可解除。</div>' : '';
      $('#pointSel').innerHTML = (current.points||[]).map(p=>'<option>'+esc(p)+'</option>').join('');
      renderCharts(); renderRepairs(); renderRelease(); renderHistory();
    }
    function gauge(label, value, monitor, stop, fmt) {
      const w=260, h=30, x0=6;
      const wm = (monitor*w).toFixed(1), ws = (stop*w).toFixed(1);
      const wv = Math.min(value, stop*1.25)/ (stop*1.25) * w;
      const color = value>=stop?'#9b4937':value>=monitor?'#b47a2c':'#3f6b4a';
      return '<div class="chartbox"><div class="meta">'+label+'：'+fmt(value)+'　监测线 '+fmt(monitor)+' / 停用线 '+fmt(stop)+'</div>'
        + '<svg viewBox="0 0 '+w+' '+h+'" width="100%" height="'+h+'">'
        + '<rect x="'+x0+'" y="12" width="'+wm+'" height="10" fill="#dcecdd"/>'
        + '<rect x="'+(x0+Number(wm))+'" y="12" width="'+(ws-wm)+'" height="10" fill="#f4e4c8"/>'
        + '<rect x="'+(x0+Number(ws))+'" y="12" '+(w-ws)+' width="'+Math.max(0,w-ws)+'" height="10" fill="#f2d3cc"/>'
        + '<rect x="'+(x0+wv-3).toFixed(1)+'" y="6" width="6" height="22" rx="2" fill="'+color+'"/></svg></div>';
    }
    function trendChart(series) {
      const w=520,h=170,pad=30;
      if (series.length < 1) return '<div class="meta">暂无检测，录入后显示寿命趋势</div>';
      const xs = series.map((_,i)=>pad + i*(w-2*pad)/Math.max(1,series.length-1));
      const path = (key, max) => series.map((s,i)=> (i?'L':'M')+xs[i].toFixed(1)+' '+(h-pad - (s[key]/max)*(h-2*pad)).toFixed(1)).join(' ');
      const dots = (key,max,color) => series.map((s,i)=>'<circle cx="'+xs[i].toFixed(1)+'" cy="'+(h-pad-(s[key]/max)*(h-2*pad)).toFixed(1)+'" r="3" fill="'+color+'"/>').join('');
      const labels = series.map((s,i)=>'<text x="'+xs[i].toFixed(1)+'" y="'+(h-8)+'" font-size="9" text-anchor="middle" fill="#687066">'+(i+1)+'</text>').join('');
      return '<svg viewBox="0 0 '+w+' '+h+'" width="100%"><line x1="'+pad+'" y1="'+(h-pad)+'" x2="'+(w-pad)+'" y2="'+(h-pad)+'" stroke="#d4ddd0"/>'
        + '<line x1="'+pad+'" y1="'+pad+'" x2="'+pad+'" y2="'+(h-pad)+'" stroke="#d4ddd0"/>'
        + '<path d="'+path('loss',0.2)+'" fill="none" stroke="#9b4937" stroke-width="2"/>'+dots('loss',0.2,'#9b4937')
        + '<path d="'+path('fatigue',1)+'" fill="none" stroke="#b47a2c" stroke-width="2" stroke-dasharray="4 3"/>'+dots('fatigue',1,'#b47a2c')
        + '<text x="'+(w-pad)+'" y="14" font-size="10" fill="#9b4937" text-anchor="end">截面损失</text>'
        + '<text x="'+(w-pad)+'" y="26" font-size="10" fill="#b47a2c" text-anchor="end">累计疲劳</text>'+labels+'</svg>';
    }
    function renderCharts() {
      const m = current.metrics || {};
      const life = current.remainingLife || {};
      const series = (current.inspections||[]).filter(i=>i.kind==='检测' || (i.kind==='复检'&&!i.passed)).map(i=>i.snapshot || {});
      $('#charts').innerHTML =
        gauge('剩余截面损失', m.loss||0, 0.05, 0.15, pct)
        + gauge('应力比', m.stress||0, 0.7, 1.0, v=>v.toFixed(2))
        + gauge('累计疲劳(Miner)', m.fatigue||0, 0.3, 0.8, v=>v.toFixed(2))
        + gauge('声速衰减', m.velocity||0, 0.05, 0.12, pct)
        + '<div class="chartbox" style="margin-top:8px"><div class="meta">寿命趋势（按检测次序）</div>'+trendChart(series)+'</div>'
        + '<div class="meta" style="margin-top:6px">剩余寿命：疲劳剩余循环 '+(life.cyclesLeft==null?'∞':life.cyclesLeft.toLocaleString())
          + (life.yearsLeft!=null?' · 约 '+life.yearsLeft+' 年':' · 剩余年数数据不足')+' · 年均循环 '+(life.annualCycles||0).toFixed(0)+'<br>建议：'+esc(life.advice||'—')+'</div>';
    }
    function renderRepairs() {
      const pend = (current.repairs||[]).filter(r=>r.status==='待复核');
      $('#repairSel').innerHTML = pend.map(r=>'<option value="'+esc(r.id)+'">'+esc(r.id)+' · 触发检测人 '+esc(r.inspector)+'</option>').join('') || '<option value="">无待复核修复单</option>';
      const t = current.frozenByInspection;
      $('#repairTrigger').innerHTML = current.frozen && t
        ? '冻结触发检测：<b>'+esc(t.inspectionId)+'</b> · 操作者 <b>'+esc(t.inspector)+'</b> · '
          +'复核人不得为同一人（原检测人由服务端绑定，报修时无需填写）'
        : '未冻结时无需修复；冻结由哪条检测触发，就只能由该检测人之外的人复核。';
    }
    function renderRelease() {
      const released = current.release && !current.release.invalidated;
      const blockers = [];
      if (current.frozen) blockers.push('桅杆冻结：'+(current.freezeReason||'达停用线'));
      if (current.gradeLevel>=2 && !current.frozen) blockers.push('当前安全等级为停用');
      const pend = (current.repairs||[]).filter(r=>r.status==='待复核').length;
      const failed = (current.repairs||[]).filter(r=>r.status==='复检未过').length;
      if (pend) blockers.push('有 '+pend+' 张修复单待非本人复核');
      if (failed && (current.frozen || current.gradeLevel>=2)) blockers.push('有 '+failed+' 张修复单复检未过，冻结不得解除');
      if (!(current.inspections||[]).length) blockers.push('尚无检测记录');
      $('#releaseBox').innerHTML =
        blockers.map(b=>'<div class="blocker">[停] '+esc(b)+'</div>').join('')
        + (released ? '<div class="oknote">已由 '+esc(current.release.approver)+' 放行（'+esc(current.release.at)+'，等级 '+esc(current.release.grade)+'）</div>'
          : (current.release && current.release.invalidated ? '<div class="blocker" style="background:#fbf0dc;color:#b47a2c">原有放行已因新检测失效，须重新放行</div>' : '')
            + '<div class="row"><div><label>放行人</label><input id="approver" placeholder="放行负责人"></div><div><label>&nbsp;</label><button id="releaseBtn" '+(blockers.length?'disabled':'')+'>放行（只能成功一次）</button></div></div>');
      const btn = $('#releaseBtn');
      if (btn) btn.onclick = async () => {
        const approver = $('#approver').value.trim();
        if (!approver) return toast('请填写放行人', true);
        try { await api('/api/masts/'+current.id+'/release', { method:'POST', body: JSON.stringify({ approver, expectedVersion: version, idempotencyKey: 'rel-'+current.id+'-'+Date.now() }) }); toast('放行成功'); await loadMasts(current.id); }
        catch (e) { toast('放行失败：'+e.message+(e.data&&e.data.reason?'（'+e.data.reason+'）':''), true); await loadMasts(current.id); }
      };
    }
    function renderHistory() {
      const rows = [];
      for (const i of current.inspections||[]) rows.push(i);
      const hist = rows.slice().sort((a,b)=> a.at<b.at?1:-1);
      const repairs = (current.repairs||[]).map(r=>'<tr><td>'+esc(r.at)+'</td><td>修复单</td><td>'+esc(r.inspector)+'</td><td>'+esc(r.status)+(r.reviewer?' / 复核 '+esc(r.reviewer):'')+'</td><td>'+esc((r.actions||[]).join(','))+'</td></tr>').join('');
      $('#history').innerHTML = '<table><tr><th>时间</th><th>类型</th><th>人员</th><th>结论</th><th>要点</th></tr>'
        + hist.map(i=>'<tr><td>'+esc(i.at)+'</td><td>'+esc(i.kind)+'</td><td>'+esc(i.inspector||i.reviewer)+'</td><td>'+esc(i.snapshot&&i.snapshot.grade||'')+(i.kind==='复检'?(i.passed?'通过':'未过'):'')+'</td><td>'+esc(i.point||'')+' 裂纹'+(i.crackDepth||0)+' 腐蚀'+(i.corrosionDepth||0)+' 断丝'+(i.brokenWires||0)+' 声速'+(i.velocity||'-')+' 循环'+(i.cycles||0)+'</td></tr>').join('')
        + repairs + '</table>';
    }

    async function mutate(path, body, ok) {
      try { const r = await api(path, { method:'POST', body: JSON.stringify({ ...body, expectedVersion: version }) }); version = r.version || version; toast(ok); return r; }
      catch (e) {
        const hint = e.status===409 ? '（版本过期或幂等键冲突，已刷新请重试）'
          : e.status===428 ? '（缺少版本条件，已刷新请重试）'
          : e.status===403 ? '（复核人必须不是触发冻结的检测人）' : '';
        toast('提交失败：'+e.message+hint, true);
        await loadMasts(current && current.id).catch(()=>{});
        return null;
      }
    }

    $('#regForm').onsubmit = async e => { e.preventDefault();
      const f = new FormData($('#regForm'));
      const body = {
        code: f.get('code'), material: f.get('material'), section: f.get('section'),
        allowableStress: f.get('allowableStress'), baselineVelocity: f.get('baselineVelocity') || null,
        points: String(f.get('points')||'').split(',').map(s=>s.trim()).filter(Boolean),
        itemId: f.get('itemId') || null,
        dims: { outerD: f.get('outerD')||undefined, innerD: f.get('innerD')||undefined, width: f.get('width')||undefined, thickness: f.get('thickness')||undefined, wireCount: f.get('wireCount')||undefined },
      };
      try { const r = await api('/api/masts', { method:'POST', body: JSON.stringify(body), headers:{'Idempotency-Key':'reg-'+f.get('code')} }); toast('桅杆已登记'); $('#regForm').reset(); await loadMasts(r.id); }
      catch (e) { toast('登记失败：'+e.message, true); }
    };
    $('#insForm').onsubmit = async e => { e.preventDefault();
      if (!current) return;
      const f = new FormData($('#insForm'));
      const body = Object.fromEntries(f.entries());
      body.idempotencyKey = 'ins-'+current.id+'-'+Date.now()+'-'+Math.random().toString(36).slice(2,6);
      const r = await mutate('/api/masts/'+current.id+'/inspections', body, '检测已提交');
      if (r) { $('#insForm').reset(); await loadMasts(current.id); if (r.grade==='停用') toast('达到停用线，校准与交付已冻结', true); }
    };
    const idKey = p => p+'-'+Date.now()+'-'+Math.random().toString(36).slice(2,8);
    $('#repairForm').onsubmit = async e => { e.preventDefault();
      if (!current) return;
      const f = new FormData($('#repairForm'));
      // 不再提交“原检测人”：服务端按触发冻结的实际检测记录绑定
      const r = await mutate('/api/masts/'+current.id+'/repairs',
        { actions: String(f.get('actions')).split(',').map(s=>s.trim()).filter(Boolean), note: f.get('note'), idempotencyKey: idKey('rp') },
        '修复单已提交，等待非本人复核');
      if (r) { $('#repairForm').reset(); await loadMasts(current.id); }
    };
    $('#recheckForm').onsubmit = async e => { e.preventDefault();
      if (!current) return;
      const f = new FormData($('#recheckForm'));
      const repairId = f.get('repairId');
      if (!repairId) return toast('没有待复核的修复单', true);
      const body = Object.fromEntries(f.entries()); delete body.repairId;
      body.idempotencyKey = idKey('ck');
      const r = await mutate('/api/repairs/'+repairId+'/recheck', body, '复检已提交');
      if (r) { $('#recheckForm').reset(); await loadMasts(current.id); }
    };
    loadItems().then(loadMasts);
  `;
}
