(function(){
  var vscode;
  try { vscode = acquireVsCodeApi(); } catch(e) { document.body.innerHTML += "<div style=\"color:red;padding:10px\">vscode API error: "+e.message+"</div>"; return; }
  var msgs = document.getElementById("main");
  var thk  = document.getElementById("thk");
  var inp  = document.getElementById("inp");
  var sbtn = document.getElementById("sbtn");
  var es   = document.getElementById("es");
  var cxb  = document.getElementById("cxb");
  var cxbt = document.getElementById("cxbt");
  var apibt = document.getElementById("apibt");
  var leftbt = document.getElementById("leftbt");
  var rightbt = document.getElementById("rightbt");
  var newSessionBtn = document.getElementById("newSessionBtn");
  var scopeWs = document.getElementById("scopeWs");
  var scopeAll = document.getElementById("scopeAll");
  var dlist  = document.getElementById("dlist");
  var dsearch = document.getElementById("dsearch");
  var cbt  = document.getElementById("cbt");
  var modelSel = document.getElementById("modelSel");
  var modeSel = document.getElementById("modeSel");
  var sb   = document.getElementById("sb");
  var dot  = document.getElementById("dot");
  var ftMode = document.getElementById("ft-mode");
  var ftThink = document.getElementById("ft-think");
  var ftTokens = document.getElementById("ft-tokens");
  var ftCost = document.getElementById("ft-cost");
  var planBody = document.getElementById("plan-body");
  var planCnt = document.getElementById("plan-cnt");
  var todoBody = document.getElementById("todo-body");
  var todoCnt = document.getElementById("todo-cnt");
  var cxOn = false, busy = false;
  var cur = null, curText = "", curThk = null, curBubble = null;
  var toolMap = {};
  var sess = { tokens:0, cost:0, thinkMs:0 };
  var sessions = [], activeSessionId = null, currentWs = "";
  /* Smart scroll: only auto-stick to bottom when user is at/near bottom; otherwise leave alone. */
  var stick = true;
  var jumpBtn = document.createElement("button");
  jumpBtn.className = "jumpbtn"; jumpBtn.textContent = "↓ 跳到最新";
  jumpBtn.addEventListener("click", function(){ stick = true; msgs.scrollTop = msgs.scrollHeight; jumpBtn.classList.remove("show"); });
  msgs.appendChild(jumpBtn);
  msgs.addEventListener("scroll", function(){
    var nearBottom = (msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight) < 80;
    stick = nearBottom;
    jumpBtn.classList.toggle("show", !nearBottom && busy);
  }, { passive: true });
  /* Disable autoscroll on user wheel/touch scroll up. */
  msgs.addEventListener("wheel", function(e){ if (e.deltaY < 0) stick = false; }, { passive: true });
  function ascroll(){ if (stick) msgs.scrollTop = msgs.scrollHeight; else jumpBtn.classList.add("show"); }

  /* Auto narrow mode based on width */
  function checkNarrow(){
    if (window.innerWidth < 600) document.body.classList.add("narrow");
    else document.body.classList.remove("narrow");
  }
  window.addEventListener("resize", checkNarrow); checkNarrow();
  /* ▦ left button: toggle Plan/Todos column */
  leftbt.addEventListener("click", function(){ document.body.classList.toggle("no-left"); });
  /* ☰ right button: toggle Sessions column */
  rightbt.addEventListener("click", function(){ document.body.classList.toggle("no-right"); });
  /* Scope buttons: filter sessions by current workspace or all */
  var scopeMode = "ws"; /* "ws" | "all" */
  function setScope(m){ scopeMode = m; scopeWs.classList.toggle("on", m==="ws"); scopeAll.classList.toggle("on", m==="all"); renderSessions(); }
  scopeWs.addEventListener("click", function(){ setScope("ws"); });
  scopeAll.addEventListener("click", function(){ setScope("all"); });
  function newSession(){ vscode.postMessage({type:"sessionNew"}); resetChat(); }
  newSessionBtn.addEventListener("click", newSession);
  /* Panel headers: click to collapse */
  document.querySelectorAll(".pnl .ph").forEach(function(ph){
    ph.addEventListener("click", function(){
      var pn = ph.parentElement;
      var open = pn.dataset.open === "1";
      pn.dataset.open = open ? "0" : "1";
      var ch = ph.querySelector(".pchev"); if (ch) ch.textContent = open ? "▸" : "▾";
      var pb = pn.querySelector(".pb"); if (pb) pb.style.display = open ? "none" : "";
    });
  });

  function escHtml(s){
    return String(s).split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;").split("\"").join("&quot;");
  }
  function escapeHtml(s){
    return String(s||"").replace(/[&<>"\']/g, function(c){ return ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","\'":"&#39;"})[c]; });
  }

  function renderInline(t){
    var x = escHtml(t);
    x = x.replace(/`([^`\n]+)`/g, "<code class=\"ic\">$1</code>");
    x = x.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    x = x.replace(/(^|[\s(\[\"`])([\w./\-]+\.(?:ts|tsx|js|jsx|rs|py|go|java|c|cc|cpp|h|hpp|md|json|toml|yaml|yml|sh|ps1|html|css|scss|sql|rb|swift|kt|php|lua|vue|svelte))(?::(\d+)(?::(\d+))?)?(?=[\s,);:.!?\]\"`]|$)/g,
      function(_, pre, p, line, col){
        var disp = p + (line ? ":" + line : "") + (col ? ":" + col : "");
        return pre + "<a class=\"flink\" data-path=\"" + escHtml(p) + "\" data-line=\"" + (line || "") + "\">" + escHtml(disp) + "</a>";
      });
    return x;
  }
  function renderMd(s){
    /* Step 1: extract fenced code blocks as placeholders */
    var codes = [];
    var src = String(s||"").replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, function(_, lang, code){
      var L = (lang || "plaintext").toLowerCase();
      var raw = code.replace(/\n$/, "");
      codes.push({L:L, raw:raw});
      return "\u0000CB" + (codes.length-1) + "\u0000";
    });
    var lines = src.split(/\r?\n/);
    var out = [];
    var paraBuf = [];
    function flushPara(){
      if (!paraBuf.length) return;
      var joined = paraBuf.join(" ");
      /* If a paragraph is JUST a code-block placeholder, emit it raw */
      var only = joined.match(/^\s*\u0000CB(\d+)\u0000\s*$/);
      if (only){
        var c = codes[+only[1]], b64 = encodeURIComponent(c.raw);
        out.push("<pre class=\"cb\" data-code=\"" + b64 + "\"><div class=\"cb-h\"><span class=\"lang\">" + escHtml(c.L) + "</span><button class=\"cb-copy\">复制</button><button class=\"cb-insert\">插入</button></div><code>" + c.raw + "</code></pre>");
      } else {
        out.push("<p>" + renderInline(joined) + "</p>");
      }
      paraBuf = [];
    }
    var i = 0;
    while (i < lines.length){
      var ln = lines[i];
      var m;
      /* Headers ## Foo */
      if ((m = ln.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/))){
        flushPara();
        var lvl = m[1].length + 1; if (lvl > 6) lvl = 6;
        out.push("<h" + lvl + " class=\"mh\">" + renderInline(m[2]) + "</h" + lvl + ">");
        i++; continue;
      }
      /* HR */
      if (/^\s*[-*_]{3,}\s*$/.test(ln)){
        flushPara(); out.push("<hr class=\"mhr\"/>"); i++; continue;
      }
      /* Standalone code-block placeholder line */
      if (/^\s*\u0000CB\d+\u0000\s*$/.test(ln)){
        flushPara();
        var idx = +ln.match(/\u0000CB(\d+)\u0000/)[1];
        var cc = codes[idx], b64b = encodeURIComponent(cc.raw);
        out.push("<pre class=\"cb\" data-code=\"" + b64b + "\"><div class=\"cb-h\"><span class=\"lang\">" + escHtml(cc.L) + "</span><button class=\"cb-copy\">复制</button><button class=\"cb-insert\">插入</button></div><code>" + cc.raw + "</code></pre>");
        i++; continue;
      }
      /* Table: header | sep */
      if (i+1 < lines.length && /\|/.test(ln) && /^\s*\|?\s*:?-{2,}/.test(lines[i+1])){
        flushPara();
        function splitRow(r){ var p = r.split("|").map(function(x){return x.trim();}); if (p.length && p[0]==="") p.shift(); if (p.length && p[p.length-1]==="") p.pop(); return p; }
        var head = splitRow(ln); i += 2;
        var rows = [];
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== ""){ rows.push(splitRow(lines[i])); i++; }
        var ht = "<table class=\"mtbl\"><thead><tr>" + head.map(function(c){return "<th>" + renderInline(c) + "</th>";}).join("") + "</tr></thead><tbody>";
        ht += rows.map(function(r){ return "<tr>" + r.map(function(c){return "<td>" + renderInline(c) + "</td>";}).join("") + "</tr>"; }).join("");
        ht += "</tbody></table>";
        out.push(ht); continue;
      }
      /* Unordered list */
      if (/^\s*[-*+]\s+/.test(ln)){
        flushPara();
        var its = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])){ its.push(lines[i].replace(/^\s*[-*+]\s+/, "")); i++; }
        out.push("<ul class=\"mul\">" + its.map(function(x){return "<li>" + renderInline(x) + "</li>";}).join("") + "</ul>");
        continue;
      }
      /* Ordered list */
      if (/^\s*\d+\.\s+/.test(ln)){
        flushPara();
        var ord = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])){ ord.push(lines[i].replace(/^\s*\d+\.\s+/, "")); i++; }
        out.push("<ol class=\"mol\">" + ord.map(function(x){return "<li>" + renderInline(x) + "</li>";}).join("") + "</ol>");
        continue;
      }
      /* Blockquote */
      if (/^\s*>\s?/.test(ln)){
        flushPara();
        var bq = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])){ bq.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
        out.push("<blockquote class=\"mbq\">" + renderInline(bq.join(" ")) + "</blockquote>");
        continue;
      }
      /* Blank line = paragraph break */
      if (ln.trim() === ""){ flushPara(); i++; continue; }
      paraBuf.push(ln); i++;
    }
    flushPara();
    return out.join("");
  }

  function add(role, text){
    if (es) es.style.display = "none";
    var d = document.createElement("div");
    if (role === "user"){ d.className = "msgU"; d.textContent = text; }
    else if (role === "assistant"){
      d.className = "msgA";
      d.innerHTML = "<div class=\"lbl\">DEEP COPILOT</div><div class=\"msgC\">" + escHtml(text) + "</div>";
    } else { d.className = "err"; d.textContent = text; }
    if (thk && thk.parentNode === msgs) msgs.insertBefore(d, thk); else msgs.appendChild(d);
    ascroll();
  }

  function ensureBubble(){
    if (curBubble) return curBubble;
    if (es) es.style.display = "none";
    var d = document.createElement("div");
    d.className = "msgA";
    d.innerHTML = "<div class=\"lbl\">DEEP COPILOT</div>" +
      "<div class=\"thinkhead\" style=\"display:none\">▸ thinking</div>" +
      "<div class=\"thinkblk\" style=\"display:none\"></div>" +
      "<div class=\"tools\"></div><div class=\"msgC\"></div>";
    if (thk && thk.parentNode === msgs) msgs.insertBefore(d, thk); else msgs.appendChild(d);
    curBubble = d;
    cur = d.querySelector(".msgC");
    curThk = d.querySelector(".thinkblk");
    var thh = d.querySelector(".thinkhead");
    thh.addEventListener("click", function(){
      if (!curThk) return;
      var open = curThk.style.display === "block";
      curThk.style.display = open ? "none" : "block";
      thh.textContent = (open ? "▸ " : "▾ ") + (thh.dataset.label || "thinking");
    });
    curText = "";
    return d;
  }

  function shortArgs(s){
    try { var o = JSON.parse(s||"{}"); return JSON.stringify(o); } catch(e){ return String(s||"").slice(0,200); }
  }
  /* Copilot-style verb + target extraction (e.g. "Read crates/core/src/lib.rs") */
  var VERB = { read_file:"Read", write_file:"Write", list_dir:"List", grep_search:"Search", run_shell:"Run", update_plan:"Plan" };
  function toolTarget(name, argStr){
    var o; try { o = JSON.parse(argStr||"{}"); } catch(e){ return ""; }
    if (!o || typeof o !== "object") return "";
    if (name === "read_file"){
      var p = o.path || o.file || ""; if (!p) return "";
      if (o.start_line || o.end_line) return p + ":" + (o.start_line||1) + "-" + (o.end_line||"");
      return p;
    }
    if (name === "write_file") return o.path || o.file || "";
    if (name === "list_dir") return o.path || o.dir || ".";
    if (name === "grep_search") return (o.pattern || o.query || "") + (o.path ? "  in " + o.path : "");
    if (name === "run_shell") return o.command || o.cmd || "";
    if (name === "update_plan"){
      var p = (o.steps && o.steps.length) ? o.steps : ((o.plan && o.plan.length) ? o.plan : []);
      return p.length ? (p.length + " step" + (p.length>1?"s":"")) : "";
    }
    var v = o.path || o.file || o.query || o.pattern || o.command || ""; return String(v).slice(0,120);
  }

  function addToolCard(id, name, args, opts){
    opts = opts || {};
    ensureBubble();
    var holder = curBubble.querySelector(".tools");
    var d = document.createElement("div");
    d.className = "tool run";
    var verb = VERB[name] || name;
    var target = toolTarget(name, args);
    var statusTxt = opts.approval ? "等待批准" : "…";
    d.innerHTML = 
      "<div class=\"h\">" +
        "<span class=\"chev\">▶</span>" +
        "<span class=\"nm\">" + escHtml(verb) + "</span>" +
        "<span class=\"tgt\" title=\"" + escHtml(target) + "\">" + escHtml(target) + "</span>" +
        "<span class=\"st\">" + escHtml(statusTxt) + "</span>" +
      "</div>" +
      "<div class=\"b\"><div class=\"args\">" + escHtml(shortArgs(args)) + "</div><div class=\"out\"></div></div>";
    holder.appendChild(d);
    d.querySelector(".h").addEventListener("click", function(){ d.classList.toggle("open"); });
    if (opts.approval){
      d.classList.add("open");
      var ap = document.createElement("div");
      ap.className = "approve";
      ap.innerHTML = "<button class=\"btn-yes\">允许</button><button class=\"btn-no\">拒绝</button>";
      d.appendChild(ap);
      ap.querySelector(".btn-yes").addEventListener("click", function(){
        vscode.postMessage({type:"approve", id:id, decision:true}); ap.remove();
        d.querySelector(".st").textContent = "运行中";
      });
      ap.querySelector(".btn-no").addEventListener("click", function(){
        vscode.postMessage({type:"approve", id:id, decision:false}); ap.remove();
        d.querySelector(".st").textContent = "拒绝"; d.classList.remove("run"); d.classList.add("err");
      });
    }
    toolMap[id] = { root:d, body:d.querySelector(".b .out"), status:d.querySelector(".st") };
    ascroll();
    return d;
  }

  /* ─── Side panel renderers ─────────────────────────────────────────── */
  var ICONS = {pending:"⬜", in_progress:"🔄", done:"✅", blocked:"🚧"};
  function normStatus(s){
    var v = String(s || "").toLowerCase();
    if (v === "completed" || v === "complete" || v === "done") return "done";
    if (v === "inprogress") return "in_progress";
    if (v === "in_progress") return "in_progress";
    if (v === "blocked") return "blocked";
    return "pending";
  }
  function stepTitle(s, i){
    var t = (s && (s.title || s.text || s.step || s.content)) || "";
    t = String(t).trim();
    return t || ("Step " + (i + 1));
  }
  function renderPlan(steps, todos){
    if (!steps || !steps.length){
      planBody.innerHTML = "<div class=\"empty\">No active plan</div>"; planCnt.textContent = ""; renderTodos(todos || []); return;
    }
    var html = "<ul class=\"plan-list\">";
    steps.forEach(function(s, i){
      var st = normStatus(s && s.status);
      var ic = ICONS[st] || ICONS.pending;
      html += "<li class=\"st-" + st + "\"><span class=\"ic\">" + ic + "</span><span>" + (i+1) + ". " + escapeHtml(stepTitle(s, i)) + "</span></li>";
    });
    html += "</ul>";
    planBody.innerHTML = html;
    var done = steps.filter(function(s){return normStatus(s && s.status) === "done";}).length;
    planCnt.textContent = done + "/" + steps.length;
    renderTodos((todos && todos.length) ? todos : steps);
  }
  function renderTodos(items){
    if (!items || !items.length){
      todoBody.innerHTML = "<div class=\"empty\">No todos</div>"; todoCnt.textContent = ""; return;
    }
    var done = items.filter(function(s){ return !!(s && s.done) || normStatus(s && s.status) === "done"; }).length;
    var pct = Math.round((done / items.length) * 100);
    var html = "<div class=\"todo-stat\">" + done + " / " + items.length + " 完成 (" + pct + "%)</div>";
    html += "<div class=\"todo-bar\"><div class=\"fill\" style=\"width:" + pct + "%\"></div></div>";
    html += "<ul class=\"todo-list\">";
    items.forEach(function(s, i){
      var isDone = !!(s && s.done) || normStatus(s && s.status) === "done";
      if (isDone) return;
      var st = normStatus(s && s.status);
      var ic = ICONS[st] || ICONS.pending;
      html += "<li><span>" + ic + "</span><span>" + escapeHtml(stepTitle(s, i)) + "</span></li>";
    });
    html += "</ul>";
    todoBody.innerHTML = html; todoCnt.textContent = done + "/" + items.length;
  }
  function addTask(){ return null; }
  function updateTask(){ /* no-op since v0.16: Tasks panel removed; sessions drawer replaces it */ }

  /* ─── Footer / session metrics ─────────────────────────────────────── */
  function fmtCny(v){ return "¥" + (v||0).toFixed(4); }
  function fmtTokens(n){
    if (n >= 1e6) return (n/1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n/1e3).toFixed(1) + "K";
    return String(n);
  }
  function bumpUsage(u){
    sess.tokens += (u.total_tokens || 0);
    sess.cost += (u.cost_cny || 0);
    sess.thinkMs += (u.thinking_ms || 0);
    ftTokens.textContent = fmtTokens(sess.tokens) + " tokens";
    ftCost.textContent = fmtCny(sess.cost);
    ftThink.textContent = "🤔 " + (sess.thinkMs / 1000).toFixed(1) + "s";
  }

  /* ─── Composer ─────────────────────────────────────────────────────── */
  function autosize(){ inp.style.height = "36px"; inp.style.height = Math.min(inp.scrollHeight, 140) + "px"; }
  function setBusy(on){
    busy = !!on;
    sbtn.classList.toggle("stop", busy);
    sbtn.textContent = busy ? "\u23F9" : "\u2191";
    sbtn.title = busy ? "\u505C\u6B62\u751F\u6210 (Esc)" : "\u53D1\u9001";
    dot.className = "dot" + (busy ? " warn" : "");
  }
  function showCursor(){
    if (!cur) return;
    var ex = cur.querySelector(".tcur");
    if (!ex) cur.insertAdjacentHTML("beforeend", "<span class=\"tcur\">\u258D</span>");
  }
  function hideCursor(){
    if (curBubble){
      var ex = curBubble.querySelector(".msgC .tcur");
      if (ex) ex.remove();
    }
  }
  function doSend(){
    if (busy){ vscode.postMessage({type:"stop"}); return; }
    var t = inp.value.trim();
    if (!t) return;
    add("user", t);
    inp.value = ""; autosize();
    vscode.postMessage({type:"send", text:t});
  }
  function resetChat(){
    var nodes = msgs.querySelectorAll(".msgU,.msgA,.err");
    for (var i=0;i<nodes.length;i++) nodes[i].remove();
    if (es) es.style.display = "block";
    sess = { tokens:0, cost:0, thinkMs:0 };
    ftTokens.textContent = "0 tokens"; ftCost.textContent = "¥0.0000"; ftThink.textContent = "🤔 0.0s";
    renderPlan([]);
    curBubble = null; cur = null; curText = ""; curThk = null; toolMap = {};
  }
  inp.addEventListener("input", autosize);
  inp.addEventListener("keydown", function(e){
    if (e.key === "Enter" && !e.shiftKey){ e.preventDefault(); doSend(); }
    else if (e.key === "Escape" && busy){ e.preventDefault(); vscode.postMessage({type:"stop"}); }
  });
  sbtn.addEventListener("click", doSend);
  cxbt.addEventListener("click", function(){
    cxOn = !cxOn;
    cxbt.classList.toggle("active", cxOn);
    cxb.style.display = cxOn ? "block" : "none";
    vscode.postMessage({type:"contextToggle", active:cxOn});
  });
  modelSel.addEventListener("change", function(){
    vscode.postMessage({type:"setModel", model: modelSel.value});
  });
  modeSel.addEventListener("change", function(){
    modeSel.dataset.m = modeSel.value;
    vscode.postMessage({type:"setMode", mode: modeSel.value});
  });
  apibt.addEventListener("click", function(){ vscode.postMessage({type:"openApiSettings"}); });
  cbt.addEventListener("click", function(){
    resetChat();
    vscode.postMessage({type:"clear"});
  });

  /* ─── Message handler ──────────────────────────────────────────────── */
  window.addEventListener("message", function(e){
    var m = e.data;
    if (m.type === "thinking"){
      thk.style.display = m.show ? "block" : "none";
    } else if (m.type === "replyStart"){
      curBubble = null; cur = null; curThk = null; curText = ""; toolMap = {};
      ensureBubble(); ascroll();
      setBusy(true); showCursor();
    } else if (m.type === "newTurn"){
      curBubble = null; cur = null; curThk = null; curText = ""; ensureBubble();
      showCursor();
    } else if (m.type === "replyDelta"){
      ensureBubble();
      curText += (m.text || ""); cur.innerHTML = renderMd(curText);
      var th2 = curBubble.querySelector(".thinkhead");
      if (th2 && th2.style.display !== "none" && !th2.dataset.done) {
        th2.dataset.done = "1";
        th2.dataset.label = "thoughts";
        th2.textContent = (curThk && curThk.style.display === "block" ? "\u25BE " : "\u25B8 ") + "thoughts";
      }
      showCursor();
      ascroll();
    } else if (m.type === "thinkingDelta"){
      ensureBubble();
      var th = curBubble.querySelector(".thinkhead");
      if (th && th.style.display === "none") { th.style.display = "inline-block"; th.textContent = "▸ thinking…"; }
      /* keep thinkblk hidden until user clicks the head; just accumulate content */
      curThk.textContent += (m.text || "");
      ascroll();
    } else if (m.type === "toolStart"){
      addToolCard(m.id, m.name, m.args, {});
    } else if (m.type === "approvalRequest"){
      addToolCard(m.id, m.name, m.args, { approval:true });
    } else if (m.type === "autoApproval"){
      ensureBubble();
      var holder = curBubble.querySelector(".tools");
      var d = document.createElement("div");
      d.className = "tool " + (m.decision ? "ok" : "err");
      var verb2 = (VERB[m.name] || m.name);
      var tgt2 = toolTarget(m.name, m.args);
      var label = m.decision ? ("auto-allow · " + m.mode) : ("auto-deny · " + m.mode);
      d.innerHTML = "<div class=\"h\"><span class=\"chev\">▶</span><span class=\"nm\">" + escHtml(verb2) + "</span><span class=\"tgt\">" + escHtml(tgt2) + "</span><span class=\"st\">" + escHtml(label) + "</span></div>" +
        "<div class=\"b\"><div class=\"args\">" + escHtml(shortArgs(m.args)) + "</div></div>";
      holder.appendChild(d);
      d.querySelector(".h").addEventListener("click", function(){ d.classList.toggle("open"); });
    } else if (m.type === "toolResult"){
      var tc = toolMap[m.id];
      if (!tc){ tc = { root: addToolCard(m.id, m.name, "{}", {}), body:null, status:null };
        tc.body = tc.root.querySelector(".b .out"); tc.status = tc.root.querySelector(".st"); }
      tc.root.classList.remove("run");
      tc.root.classList.add(m.ok ? "ok" : "err");
      var out = String(m.output || "");
      var lines = out ? out.split(/\r?\n/).length : 0;
      var bytes = out.length;
      tc.status.textContent = m.ok ? (lines>1 ? lines + " lines" : (bytes ? bytes + "B" : "ok")) : "failed";
      tc.body.textContent = out;
      ascroll();
    } else if (m.type === "plan"){
      renderPlan(m.steps || [], m.todos || []);
    } else if (m.type === "usage"){
      bumpUsage(m.usage || {});
    } else if (m.type === "replyEnd"){
      hideCursor();
      setBusy(false);
      if (cur && m.empty && curText === "" && curBubble && !curBubble.querySelector(".tool")){ cur.textContent = "(no response)"; }
      curBubble = null; cur = null; curThk = null; curText = "";
    } else if (m.type === "reply"){
      add("assistant", m.text);
    } else if (m.type === "error"){
      add("error", m.text);
    } else if (m.type === "serverStatus"){
      sb.style.display = m.running ? "none" : "block";
      if (!m.running) sb.textContent = "⚠ 后端服务器未启动 — 发送时将自动启动";
      dot.className = "dot" + (m.running ? "" : " err");
    } else if (m.type === "modelInfo"){
      if (m.model){
        if (modelSel) modelSel.value = m.model;
        ftMode.textContent = "agent · " + m.model;
      }
      if (m.approvalMode){
        if (modeSel){ modeSel.value = m.approvalMode; modeSel.dataset.m = m.approvalMode; }
      }
    } else if (m.type === "status"){
      if (m.text){ sb.textContent = m.text; sb.style.display = "block"; } else sb.style.display = "none";
    } else if (m.type === "sessions"){
      sessions = m.items || []; activeSessionId = m.activeId || null;
      if (typeof m.currentWs === "string") currentWs = m.currentWs;
      renderSessions();
    } else if (m.type === "sessionLoaded"){
      activeSessionId = m.id || null;
      resetChat();
      var msgsArr = m.messages || [];
      for (var k=0; k<msgsArr.length; k++){
        var mm = msgsArr[k];
        if (mm.role === "user") add("user", mm.text || "");
        else if (mm.role === "assistant"){
          if (es) es.style.display = "none";
          var d = document.createElement("div");
          d.className = "msgA";
          d.innerHTML = "<div class=\"lbl\">DEEP COPILOT</div><div class=\"msgC\"></div>";
          if (thk && thk.parentNode === msgs) msgs.insertBefore(d, thk); else msgs.appendChild(d);
          d.querySelector(".msgC").innerHTML = renderMd(mm.text || "");
        }
      }
      renderSessions(); ascroll();
    }
  });

  /* ─── Sessions list rendering ──────────────────────────────────── */
  function relTime(ts){
    if (!ts) return "";
    var d = Date.now() - ts;
    if (d < 60000) return "刚刚";
    if (d < 3600000) return Math.floor(d/60000) + " 分钟前";
    if (d < 86400000) return Math.floor(d/3600000) + " 小时前";
    if (d < 7*86400000) return Math.floor(d/86400000) + " 天前";
    var dt = new Date(ts);
    return (dt.getMonth()+1) + "月" + dt.getDate() + "日";
  }
  function dayBucket(ts){
    var now = new Date();
    var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var yesterdayStart = todayStart - 86400000;
    var weekStart = todayStart - 6*86400000;
    if (ts >= todayStart) return "今天";
    if (ts >= yesterdayStart) return "昨天";
    if (ts >= weekStart) return "本周";
    return "更早";
  }
  function renderSessions(){
    var q = (dsearch && dsearch.value || "").trim().toLowerCase();
    var list = sessions.slice();
    if (scopeMode === "ws" && currentWs) list = list.filter(function(s){ return (s.ws||"") === currentWs; });
    if (q) list = list.filter(function(s){ return (s.title||"").toLowerCase().indexOf(q) >= 0 || (s.preview||"").toLowerCase().indexOf(q) >= 0; });
    if (!list.length){ dlist.innerHTML = '<div class="empty">' + (q ? "无匹配" : (scopeMode==="ws" ? "本工作区暂无会话" : "暂无会话")) + '</div>'; return; }
    var html = "", lastBucket = "";
    list.forEach(function(s){
      var b = dayBucket(s.updatedAt || s.createdAt || 0);
      if (b !== lastBucket){ html += '<div class="grp">' + b + '</div>'; lastBucket = b; }
      var act = (s.id === activeSessionId) ? " active" : "";
      html += '<div class="si' + act + '" data-id="' + s.id + '">' +
        '<div class="ti">' + escHtml(s.title || "Untitled") + '</div>' +
        '<div class="meta">' + escHtml(s.model || "") + " · " + (s.msgCount||0) + " msg · " + escHtml(relTime(s.updatedAt)) + '</div>' +
        (s.preview ? '<div class="pv">' + escHtml(s.preview) + '</div>' : "") +
        '<div class="ops"><button class="rn" title="重命名">✏</button><button class="dl" title="删除">🗑</button></div>' +
      '</div>';
    });
    dlist.innerHTML = html;
  }
  if (dsearch) dsearch.addEventListener("input", renderSessions);
  dlist.addEventListener("click", function(e){
    var btnRn = e.target.closest && e.target.closest("button.rn");
    var btnDl = e.target.closest && e.target.closest("button.dl");
    var item  = e.target.closest && e.target.closest(".si");
    if (!item) return;
    var id = item.dataset.id;
    if (btnDl){ e.stopPropagation(); if (confirm("删除该会话？")) vscode.postMessage({type:"sessionDelete", id:id}); return; }
    if (btnRn){
      e.stopPropagation();
      var cur = item.querySelector(".ti").textContent;
      var nv = prompt("重命名会话：", cur); if (nv != null) vscode.postMessage({type:"sessionRename", id:id, title:nv});
      return;
    }
    vscode.postMessage({type:"sessionLoad", id:id});
  });

  /* Click delegation: code-block copy/insert buttons + file path links */
  msgs.addEventListener("click", function(e){
    var t = e.target;
    if (t.classList.contains("cb-copy")){
      var pre = t.closest("pre.cb"); if (!pre) return;
      var code = decodeURIComponent(pre.getAttribute("data-code") || "");
      navigator.clipboard.writeText(code).then(function(){
        var orig = t.textContent; t.textContent = "✓ 已复制"; t.classList.add("copied");
        setTimeout(function(){ t.textContent = orig; t.classList.remove("copied"); }, 1500);
      });
      return;
    }
    if (t.classList.contains("cb-insert")){
      var pre2 = t.closest("pre.cb"); if (!pre2) return;
      var code2 = decodeURIComponent(pre2.getAttribute("data-code") || "");
      vscode.postMessage({type:"insert", code: code2});
      var orig2 = t.textContent; t.textContent = "✓ 已插入";
      setTimeout(function(){ t.textContent = orig2; }, 1500);
      return;
    }
    var a = t.closest && t.closest("a.flink");
    if (a){
      e.preventDefault();
      vscode.postMessage({type:"openFile", path: a.getAttribute("data-path"), line: parseInt(a.getAttribute("data-line") || "0", 10) || 0});
    }
  });

  vscode.postMessage({type:"ready"});
})();
