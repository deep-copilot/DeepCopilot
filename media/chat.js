(function(){
  var vscode;
  try { vscode = acquireVsCodeApi(); } catch(e) { document.body.innerHTML += "<div style=\"color:red;padding:10px\">vscode API error: "+e.message+"</div>"; return; }
  var msgs = document.getElementById("main");
  var thk  = document.getElementById("thk");
  var skillNoticeEl = document.getElementById("skill-notice");
  var inp  = document.getElementById("inp");
  var sbtn = document.getElementById("sbtn");
  var es   = document.getElementById("es");
  var apibt = document.getElementById("apibt");
  var edgeL = document.getElementById("edgeL");
  var edgeR = document.getElementById("edgeR");
  var newSessionBtn = document.getElementById("newSessionBtn");
  var scopeWs = document.getElementById("scopeWs");
  var scopeAll = document.getElementById("scopeAll");
  var dlist  = document.getElementById("dlist");
  var dsearch = document.getElementById("dsearch");
  var cbt  = document.getElementById("cbt");
  var modelPicker = document.getElementById("modelPicker");
  var modelBtn   = document.getElementById("modelBtn");
  var modelDrop  = document.getElementById("modelDrop");
  var _modelOpen = false;
  // Provider/model catalogue is populated dynamically from the extension on
  // the 'providersInfo' message (sourced from src/providers/*.json). The empty
  // defaults keep early UI code paths safe before that message arrives.
  var PROVIDER_MODELS    = { deepseek: [], openai: [], anthropic: [], custom: [] };
  var PROVIDER_URLS      = { deepseek: 'https://api.deepseek.com', openai: '', anthropic: '', custom: '' };
  var PROVIDER_KEY_LINKS = { deepseek: null, openai: null, anthropic: null, custom: null };
  var PROVIDER_DISPLAY   = { deepseek: 'DeepSeek', openai: 'OpenAI', anthropic: 'Anthropic', custom: 'Custom' };
  var PROVIDER_ORDER     = ['deepseek', 'openai', 'anthropic', 'custom'];
  var MODELS = PROVIDER_MODELS.deepseek;
  var _currentProvider = 'deepseek';

  function applyProvidersInfo(list) {
    if (!Array.isArray(list) || !list.length) return;
    PROVIDER_MODELS    = {};
    PROVIDER_URLS      = {};
    PROVIDER_KEY_LINKS = {};
    PROVIDER_DISPLAY   = {};
    PROVIDER_ORDER     = [];
    for (var i = 0; i < list.length; i++) {
      var p  = list[i];
      var id = p && p.id;
      if (!id) continue;
      PROVIDER_ORDER.push(id);
      PROVIDER_DISPLAY[id]   = p.displayName || id;
      PROVIDER_URLS[id]      = p.baseUrl || '';
      PROVIDER_KEY_LINKS[id] = p.apiKeyUrl || null;
      PROVIDER_MODELS[id] = (p.models || []).map(function(m) {
        return { value: m.id, name: m.displayName || m.id };
      });
    }
    // Refresh the <select id="s-provider"> options.
    var sel = document.getElementById('s-provider');
    if (sel) {
      sel.innerHTML = '';
      for (var j = 0; j < PROVIDER_ORDER.length; j++) {
        var pid = PROVIDER_ORDER[j];
        var opt = document.createElement('option');
        opt.value = pid;
        opt.textContent = PROVIDER_DISPLAY[pid] || pid;
        sel.appendChild(opt);
      }
    }
    // Re-apply current provider so MODELS / picker reflect the freshly loaded list.
    switchToProvider(_currentProvider);
  }

  function switchToProvider(provider) {
    _currentProvider = provider || 'deepseek';
    MODELS = PROVIDER_MODELS[_currentProvider] || [];
    var curModel = getSelectedModel();
    var modelBelongs = MODELS.some(function(m) { return m.value === curModel; });
    if (!modelBelongs) {
      var firstModel = MODELS.length ? MODELS[0].value : curModel;
      setModelUI(firstModel);
      if (MODELS.length) vscode.postMessage({ type: 'setModel', model: firstModel });
    }
  }

  function setModelUI(model) {
    var md = MODELS.find(function(x) { return x.value === model; });
    var displayName = md ? md.name : (model || (MODELS[0] && MODELS[0].name) || 'model');
    var effectiveVal = md ? md.value : (model || (MODELS[0] && MODELS[0].value) || '');
    if (modelPicker) modelPicker.dataset.model = effectiveVal;
    if (modelBtn) {
      modelBtn.textContent = '';
      var tn = document.createTextNode(displayName + '\u00a0');
      var chev = document.createElement('span');
      chev.className = 'mode-chev';
      chev.textContent = '\u25BE';
      modelBtn.appendChild(tn);
      modelBtn.appendChild(chev);
    }
    if (modelDrop) {
      var opts = modelDrop.querySelectorAll('.mo');
      for (var i = 0; i < opts.length; i++) opts[i].classList.toggle('sel', opts[i].dataset.model === effectiveVal);
    }
  }
  function getSelectedModel() {
    return modelPicker ? (modelPicker.dataset.model || (MODELS[0] && MODELS[0].value) || 'deepseek-v4-pro') : 'deepseek-v4-pro';
  }
  function openModelDrop() {
    if (!modelDrop || _modelOpen) return;
    var cur = getSelectedModel();
    if (!MODELS.length) {
      var placeholder = _currentProvider === 'ollama' ? 'llama3.2' : 'your-model-name';
      var label = _currentProvider === 'ollama' ? 'Ollama 模型名' : '自定义模型名';
      modelDrop.innerHTML = "<div class='mode-drop-hd'>" + label + "</div>" +
        "<div class='mo-custom-wrap'>" +
          "<input class='mo-custom-input' type='text' placeholder='" + placeholder + "' value='" + escHtml(cur) + "'/>" +
          "<button class='mo-custom-ok'>确认</button>" +
        "</div>";
      modelDrop.style.display = 'block';
      _modelOpen = true;
      var inp2 = modelDrop.querySelector('.mo-custom-input');
      var okBtn2 = modelDrop.querySelector('.mo-custom-ok');
      if (inp2) setTimeout(function() { inp2.focus(); }, 0);
      okBtn2 && okBtn2.addEventListener('click', function() {
        var v = inp2 ? inp2.value.trim() : '';
        if (v) { setModelUI(v); vscode.postMessage({ type: 'setModel', model: v }); }
        closeModelDrop();
      });
      inp2 && inp2.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); okBtn2 && okBtn2.click(); }
        if (e.key === 'Escape') { e.preventDefault(); closeModelDrop(); }
      });
      return;
    }
    var h = "<div class='mode-drop-hd'>切换模型</div>";
    for (var i = 0; i < MODELS.length; i++) {
      var md = MODELS[i];
      h += "<div class='mo" + (md.value === cur ? ' sel' : '') + "' data-model='" + md.value + "'>" +
           "<span class='mo-body'><span class='mo-name'>" + md.name + "</span></span>" +
           "<span class='mo-chk'>✓</span></div>";
    }
    modelDrop.innerHTML = h;
    modelDrop.style.display = 'block';
    _modelOpen = true;
  }
  function closeModelDrop() {
    if (!modelDrop || !_modelOpen) return;
    modelDrop.style.display = "none";
    _modelOpen = false;
  }
  /* ── Interaction Mode toggle (Agent ↔ Plan) ── */
  var iModePicker = document.getElementById("iModePicker");
  var iModeBtn    = document.getElementById("iModeBtn");
  var _curIMode   = "agent"; // tracks current interaction mode for ft-mode display
  var INTERACTION_MODES = [
    { value: "agent", icon: "tools",       name: "Agent", desc: "自主调用工具完成任务（文件读写、Shell、搜索等）" },
    { value: "plan",  icon: "list-ordered", name: "Plan",  desc: "只探索代码库、生成可审阅的计划，不执行任何写操作" },
  ];
  function setIModeUI(mode){
    var md = INTERACTION_MODES.find(function(x){ return x.value === mode; }) || INTERACTION_MODES[0];
    _curIMode = md.value;
    if (iModePicker) iModePicker.dataset.im = mode;
    if (iModeBtn) iModeBtn.innerHTML = "<i class='codicon codicon-" + md.icon + "'></i>\u00a0" + md.name + "\u00a0<span class='mode-chev'>\u25be</span>";
  }

  /* ── Approval Mode picker (Manual / Auto-Edit / Autopilot / Read-Only) ── */
  var modePicker = document.getElementById("modePicker");
  var modeBtn    = document.getElementById("modeBtn");
  var modeDrop   = document.getElementById("modeDrop");
  var _modeOpen  = false;
  var MODES = [
    { value: "manual",    icon: "shield",  name: "Manual",    desc: "每次操作前逐一确认，完全掌控执行过程" },
    { value: "auto-edit", icon: "edit",    name: "Auto-Edit", desc: "文件编辑自动执行，Shell 命令仍需手动确认" },
    { value: "autopilot", icon: "rocket",  name: "Autopilot", desc: "完全自动运行，无需任何手动确认（高风险）" },
    { value: "readonly",  icon: "eye",     name: "Read-Only", desc: "仅读取与分析，不执行任何写操作" },
  ];
  function setModeUI(mode){
    var md = MODES.find(function(x){ return x.value === mode; }) || MODES[0];
    if (modePicker) modePicker.dataset.m = mode;
    if (modeBtn) modeBtn.innerHTML = "<i class='codicon codicon-" + md.icon + "'></i> " + md.name + " <span class='mode-chev'>\u25BE</span>";
    if (modeDrop){ var opts = modeDrop.querySelectorAll(".mo"); for (var i=0;i<opts.length;i++) opts[i].classList.toggle("sel", opts[i].dataset.mode === mode); }
  }
  function openModeDrop(){
    if (!modeDrop || _modeOpen) return;
    var cur = modePicker ? (modePicker.dataset.m || "manual") : "manual";
    var h = "<div class='mode-drop-hd'>批准策略 (Approval Mode)</div>";
    for (var i=0;i<MODES.length;i++){
      var md = MODES[i];
      h += "<div class='mo" + (md.value === cur ? " sel" : "") + "' data-mode='" + md.value + "'>" +
           "<span class='mo-icon'><i class='codicon codicon-" + md.icon + "'></i></span>" +
           "<span class='mo-body'><span class='mo-name'>" + md.name + "</span><span class='mo-desc'>" + md.desc + "</span></span>" +
           "<span class='mo-chk'>✓</span></div>";
    }
    modeDrop.innerHTML = h;
    modeDrop.style.display = "block";
    _modeOpen = true;
  }
  function closeModeDrop(){
    if (!modeDrop || !_modeOpen) return;
    modeDrop.style.display = "none";
    _modeOpen = false;
  }
  var sb   = document.getElementById("sb");
  var dot  = null; // dot indicator removed
  // Issue #142 P3-3: footer model-text removed; replaced by #ft-ctx ring.
  var ftCtxBtn  = document.getElementById("ft-ctx");
  var ftCtxRing = document.getElementById("ft-ctx-ring");
  var ftCtxPct  = document.getElementById("ft-ctx-pct");
  var _lastCtx  = { tokens: 0, window: 0, pct: 0 };
  var _ctxPop   = null;
  function updateCtxRing(pct, tokens, win){
    _lastCtx = { tokens: tokens||0, window: win||0, pct: pct||0 };
    if (!ftCtxRing || !ftCtxPct) return;
    var p = Math.max(0, Math.min(100, Number(pct)||0));
    // circumference ≈ 2πr = 2*π*8 ≈ 50.265
    var C = 50.265;
    ftCtxRing.setAttribute('stroke-dashoffset', String(C * (1 - p/100)));
    ftCtxRing.setAttribute('stroke', p > 85 ? '#e57373' : (p > 65 ? '#ffb74d' : '#66bb6a'));
    ftCtxPct.textContent = (p|0) + '%';
    if (ftCtxBtn) ftCtxBtn.title = 'Context ' + (p|0) + '%  ' + Math.round((tokens||0)/1000) + 'K / ' + Math.round((win||0)/1000) + 'K — click for details';
  }
  function closeCtxPop(){ if (_ctxPop) { _ctxPop.remove(); _ctxPop = null; document.removeEventListener('mousedown', _ctxPopOutside, true); } }
  function _ctxPopOutside(e){ if (_ctxPop && !_ctxPop.contains(e.target) && e.target !== ftCtxBtn && !ftCtxBtn.contains(e.target)) closeCtxPop(); }
  function openCtxPop(){
    if (_ctxPop) { closeCtxPop(); return; }
    /* Escape any value that flows into innerHTML to satisfy CodeQL
       js/xss-through-dom — even though modelTxt / _curIMode originate from
       extension-side messages, treat them as untrusted. */
    function _esc(s){
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    var pop = document.createElement('div');
    pop.className = 'ft-ctx-pop';
    var pct = _lastCtx.pct|0;
    var tk = Math.round((_lastCtx.tokens||0)/1000);
    var wn = Math.round((_lastCtx.window||0)/1000);
    var modelTxt = (modelPicker && modelPicker.dataset.model) || 'unknown';
    pop.innerHTML =
      '<div class="ft-ctx-pop-h">Context usage</div>' +
      '<div class="ft-ctx-pop-row"><span>Used</span><b>' + tk + 'K / ' + wn + 'K (' + pct + '%)</b></div>' +
      '<div class="ft-ctx-pop-row"><span>Model</span><b>' + _esc(modelTxt) + '</b></div>' +
      '<div class="ft-ctx-pop-row"><span>Mode</span><b>' + _esc(_curIMode||'agent') + '</b></div>' +
      '<div class="ft-ctx-pop-tip">' +
        '<div><code>/context</code> — detailed token breakdown</div>' +
        '<div><code>/compact [focus]</code> — summarise history</div>' +
        '<div><code>/fork [title]</code> — branch this session</div>' +
      '</div>';
    document.body.appendChild(pop);
    _ctxPop = pop;
    // position above the button
    var r = ftCtxBtn.getBoundingClientRect();
    pop.style.left = Math.max(8, r.left) + 'px';
    pop.style.bottom = (window.innerHeight - r.top + 6) + 'px';
    setTimeout(function(){ document.addEventListener('mousedown', _ctxPopOutside, true); }, 0);
  }
  if (ftCtxBtn) ftCtxBtn.addEventListener('click', function(e){ e.stopPropagation(); openCtxPop(); });
  var ftTokens = document.getElementById("ft-tokens");
  var ftCost = document.getElementById("ft-cost");
  var ftCache = document.getElementById("ft-cache");
  var todoPop = document.getElementById("todo-pop");
  var todoPopList = document.getElementById("todo-pop-list");
  var todoPopCnt = document.getElementById("todo-pop-cnt");
  var busy = false;
  var cur = null, curText = "", curThk = null, curThkHead = null, curBubble = null;
  // Use real Map instances so that tool ids coming from extension messages
  // (e.g. `__proto__`, `constructor`) can never become a property write on a
  // plain object — eliminates the prototype-pollution / remote-property-
  // injection sink that CodeQL flags on `toolMap[id] = ...`.
  var toolMap = new Map();
  var _readTermCardMap = new Map(); // terminal name → card record, for read_terminal deduplication
  var _userMsgCount = 0; // tracks index of each .msgU for editUserMessage
  var _editPendingIdx = -1; // index of msgU being edited, set before postMessage
  var sess = { tokens:0, cost:0, cacheHit:0, promptTotal:0 };
  var sessions = [], activeSessionId = null, currentWs = "";
  /* Smart scroll: only auto-stick to bottom when user is at/near bottom; otherwise leave alone. */
  var stick = true;
  var jumpBtn = document.createElement("button");
  jumpBtn.className = "jumpbtn"; jumpBtn.textContent = "↓ 跳到最新";
  jumpBtn.addEventListener("click", function(){ stick = true; msgs.scrollTop = msgs.scrollHeight; jumpBtn.classList.remove("show"); });
  msgs.appendChild(jumpBtn);
  msgs.addEventListener("scroll", function(){
    var nearBottom = (msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight) < 120;
    stick = nearBottom;
    jumpBtn.classList.toggle("show", !nearBottom && busy);
  }, { passive: true });
  /* Disable autoscroll on user wheel/touch scroll up. */
  msgs.addEventListener("wheel", function(e){ if (e.deltaY < 0) stick = false; }, { passive: true });
  /* Issue #143: while replaying buffered events on session switch-back,
     suppress per-event RAF scroll-to-bottom; the replayEnd handler scrolls
     exactly once at the end. Without this flag every replyDelta /
     toolArgsDelta in the burst queues its own RAF, causing scrollbar
     jitter and visible flashing. */
  var _replaying = false;
  function ascroll(){
    if (_replaying) return;
    if (stick) requestAnimationFrame(function(){ msgs.scrollTop = msgs.scrollHeight; });
    else jumpBtn.classList.add("show");
  }

  /* Auto narrow mode based on width (use webview container width, not full VS Code window) */
  function checkNarrow(){
    var w = document.documentElement.clientWidth || window.innerWidth;
    document.body.classList.toggle("narrow", w < 600);
  }
  window.addEventListener("resize", checkNarrow);
  if (typeof ResizeObserver !== "undefined") {
    try { new ResizeObserver(checkNarrow).observe(document.documentElement); } catch(e){}
  }
  checkNarrow();
  /* Edge toggles: right panel only (left panel removed). */
  var _ui = {};
  try { _ui = (vscode.getState() && vscode.getState().ui) || {}; } catch(e){}
  function applyPanelState(){
    document.body.classList.toggle("no-right", _ui.rightCollapsed !== false);
  }
  function savePanelState(){
    try { var s = vscode.getState() || {}; s.ui = _ui; vscode.setState(s); } catch(e){}
  }
  applyPanelState();
  if (edgeR) edgeR.addEventListener("click", function(){
    _ui.rightCollapsed = !document.body.classList.contains("no-right");
    applyPanelState(); savePanelState();
  });
  /* Todo popup close button */
  var todoPopCloseBtn = document.getElementById("todo-pop-close");
  if (todoPopCloseBtn) todoPopCloseBtn.addEventListener("click", function(){
    if (todoPop) todoPop.style.display = "none";
  });
  /* Todo popup header: click to collapse/expand */
  var todoPopHd = document.getElementById("todo-pop-hd");
  if (todoPopHd) todoPopHd.addEventListener("click", function(e){
    if (e.target.closest("#todo-pop-close")) return;
    if (todoPop) todoPop.classList.toggle("collapsed");
  });
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

  /* Recognised file extensions for click-to-open links.
     Includes code, data, images, docs, archives, notebooks, scientific formats. */
  var FILE_EXT_RE = "(?:ts|tsx|js|jsx|mjs|cjs|rs|py|pyi|ipynb|go|java|kt|kts|c|cc|cpp|cxx|h|hpp|hxx|m|mm|cs|fs|rb|swift|php|lua|vue|svelte|dart|scala|sh|bash|zsh|ps1|psm1|bat|cmd|sql|md|markdown|rst|tex|bib|json|json5|jsonc|toml|yaml|yml|ini|cfg|conf|env|xml|html|htm|css|scss|sass|less|csv|tsv|tab|dat|log|txt|out|err|parquet|arrow|feather|hdf5|h5|nc|mat|npy|npz|pkl|pickle|pt|pth|onnx|safetensors|ckpt|bin|gguf|wav|mp3|mp4|mov|avi|webm|png|jpg|jpeg|gif|bmp|tiff|tif|svg|webp|ico|pdf|ps|eps|dvi|doc|docx|xls|xlsx|ppt|pptx|odt|ods|odp|rtf|zip|tar|gz|tgz|bz2|xz|7z|rar|inp|odb|cae|fil|msg|sta|prt|asm|step|stp|iges|igs|stl|obj|fbx|gltf|glb)";
  var FILE_LINK_PATH_RE = "[\\w./\\\\\\-]+\\." + FILE_EXT_RE;

  function makeFileLink(p, line, col){
    var disp = p + (line ? ":" + line : "") + (col ? ":" + col : "");
    return "<a class=\"flink\" data-path=\"" + escHtml(p) + "\" data-line=\"" + (line || "") + "\">" + escHtml(disp) + "</a>";
  }

  function renderInline(t){
    /* Park inline $...$ BEFORE escHtml so raw TeX is never HTML-entity-encoded.
       Critical: without this, > in math becomes &gt; which KaTeX rejects.
       After renderMd() pre-parks math as \u0000MATHn\u0000, this fallback
       handles any $...$ that still reaches renderInline() directly. */
    var mathStash = [];
    t = String(t||"").replace(/(?<!\$)\$([^\$\n]{1,200})\$(?!\$)/g, function(_, tex){
      mathStash.push(tex);
      return "\u0002M" + (mathStash.length - 1) + "\u0002";
    });
    var x = escHtml(t);
    var stash = [];
    function park(html){ stash.push(html); return "\u0001FL" + (stash.length - 1) + "\u0001"; }
    /* Step A: detect file paths INSIDE inline backticks first, so `foo.csv` becomes
       a clickable flink instead of a gray non-clickable <code>. Park as placeholder
       so later passes won't re-match the generated <a> tag. */
    var inlineFileRe = new RegExp("`(" + FILE_LINK_PATH_RE + ")(?::(\\d+)(?::(\\d+))?)?`", "g");
    x = x.replace(inlineFileRe, function(_, p, line, col){ return park(makeFileLink(p, line, col)); });
    /* Step B: bare file paths in still-plain text. Park each as a placeholder. */
    var bareFileRe = new RegExp("(^|[\\s(\\[\\\"'`>|])(" + FILE_LINK_PATH_RE + ")(?::(\\d+)(?::(\\d+))?)?(?=[\\s,);:.!?\\]\\\"'`<|]|$)", "g");
    x = x.replace(bareFileRe, function(_, pre, p, line, col){
      return pre + park(makeFileLink(p, line, col));
    });
    /* Step C: remaining backticks → inline code; bold; etc. */
    x = x.replace(/`([^`\n]+)`/g, "<code class=\"ic\">$1</code>");
    x = x.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    /* Step D: restore inline math with original (pre-escHtml) TeX. */
    x = x.replace(/\u0002M(\d+)\u0002/g, function(_, i){
      return renderMathSafe(mathStash[+i], false);
    });
    /* Step E: restore parked file-link HTML. */
    x = x.replace(/\u0001FL(\d+)\u0001/g, function(_, i){ return stash[+i]; });
    return x;
  }

  /* ─── #4 Phase 2: terminal-style block for shell langs ──────────── */
  var SHELL_LANGS = { bash:1, sh:1, zsh:1, shell:1, console:1, terminal:1, powershell:1, ps1:1, ps:1, pwsh:1, cmd:1, bat:1, batch:1, dos:1 };
  function isShellLang(L){ return !!SHELL_LANGS[String(L||"").toLowerCase()]; }
  function shellPrompt(L){
    L = String(L||"").toLowerCase();
    if (L === "powershell" || L === "ps1" || L === "ps" || L === "pwsh") return "PS&gt;";
    if (L === "cmd" || L === "bat" || L === "batch" || L === "dos") return "&gt;";
    return "$";
  }

  /* ─── #5 Phase 3: lightweight syntax highlighter ────────────────── */
  /* Each spec is a single regex with N alternation groups; classes[i] names group i+1. */
  var HL_ALIAS = { js:"js", javascript:"js", jsx:"js", ts:"js", tsx:"js", typescript:"js",
                   py:"py", python:"py",
                   json:"json", json5:"json",
                   css:"css", scss:"css", less:"css",
                   html:"html", xml:"html", svg:"html",
                   rs:"rs", rust:"rs",
                   go:"go", golang:"go",
                   c:"c", cpp:"c", "c++":"c", h:"c", hpp:"c", cc:"c",
                   java:"c", kotlin:"c", swift:"c",
                   md:"md", markdown:"md", yaml:"yaml", yml:"yaml", toml:"toml" };
  var HL_SPEC = {
    js: {
      re: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(const|let|var|function|class|extends|new|return|if|else|for|while|do|switch|case|break|continue|throw|try|catch|finally|async|await|yield|of|in|typeof|instanceof|delete|void|this|super|import|export|from|as|default|null|undefined|true|false|interface|type|enum)\b|\b(\d+(?:\.\d+)?)\b|([A-Za-z_$][\w$]*)(?=\s*\()/g,
      classes: ["c", "s", "k", "n", "f"],
    },
    py: {
      re: /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|\b(def|class|return|if|elif|else|for|while|try|except|finally|raise|with|as|import|from|pass|break|continue|lambda|yield|async|await|in|not|and|or|is|None|True|False|self|cls|global|nonlocal)\b|\b(\d+(?:\.\d+)?)\b|@([A-Za-z_]\w*)/g,
      classes: ["c", "s", "k", "n", "deco"],
    },
    json: {
      re: /("(?:[^"\\]|\\.)*")(?=\s*:)|("(?:[^"\\]|\\.)*")|\b(true|false|null)\b|\b(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/g,
      classes: ["key", "s", "k", "n"],
    },
    css: {
      re: /(\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(@[\w-]+|--[\w-]+|\$[\w-]+)|([#.][\w-]+)|\b([\w-]+)(?=\s*:)|\b(\d+(?:\.\d+)?)(px|em|rem|%|vh|vw|s|ms|deg|fr)?\b|(#[0-9a-fA-F]{3,8})/g,
      classes: ["c", "s", "k", "f", "n", "num", "unit", "hex"],
    },
    rs: {
      re: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|\b(fn|let|mut|const|static|if|else|match|for|while|loop|break|continue|return|struct|enum|trait|impl|pub|use|mod|crate|self|Self|super|as|where|move|ref|in|true|false|async|await|dyn|unsafe|extern|type)\b|\b(\d+(?:\.\d+)?)\b/g,
      classes: ["c", "s", "k", "n"],
    },
    go: {
      re: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`)|\b(func|var|const|type|struct|interface|map|chan|package|import|return|if|else|for|range|switch|case|default|break|continue|defer|go|select|fallthrough|true|false|nil|iota)\b|\b(\d+(?:\.\d+)?)\b/g,
      classes: ["c", "s", "k", "n"],
    },
    c: {
      re: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|\b(int|long|short|char|float|double|void|bool|signed|unsigned|const|static|extern|register|volatile|inline|struct|union|enum|typedef|sizeof|return|if|else|for|while|do|switch|case|default|break|continue|goto|public|private|protected|class|virtual|template|namespace|using|new|delete|this|true|false|null|nullptr)\b|\b(\d+(?:\.\d+)?)\b|(#\s*\w+)/g,
      classes: ["c", "s", "k", "n", "deco"],
    },
    yaml: {
      re: /(#[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|^(\s*[\w.-]+)(?=\s*:)|\b(true|false|null|yes|no)\b|\b(\d+(?:\.\d+)?)\b/gm,
      classes: ["c", "s", "key", "k", "n"],
    },
    toml: {
      re: /(#[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(\[[^\]\n]+\])|^(\s*[\w.-]+)(?=\s*=)|\b(true|false)\b|\b(\d+(?:\.\d+)?)\b/gm,
      classes: ["c", "s", "f", "key", "k", "n"],
    },
    md: {
      re: /^(#{1,6}\s[^\n]*)|^(\s*[-*+]\s)|(`[^`\n]+`)|(\*\*[^*\n]+\*\*|\*[^*\n]+\*|_[^_\n]+_)/gm,
      classes: ["k", "f", "s", "n"],
    },
  };
  function hl(raw, lang){
    var L = HL_ALIAS[String(lang||"").toLowerCase()];
    var spec = L && HL_SPEC[L];
    if (!spec) return escHtml(raw);
    var out = "", i = 0, m;
    spec.re.lastIndex = 0;
    while ((m = spec.re.exec(raw)) !== null){
      if (m.index > i) out += escHtml(raw.slice(i, m.index));
      var picked = false;
      for (var k = 1; k < m.length; k++){
        if (m[k] !== undefined){
          out += "<span class=\"hk-" + spec.classes[k-1] + "\">" + escHtml(m[k]) + "</span>";
          picked = true;
          break;
        }
      }
      if (!picked) out += escHtml(m[0]);
      i = m.index + m[0].length;
      if (m[0].length === 0) spec.re.lastIndex++;  // safety
    }
    out += escHtml(raw.slice(i));
    return out;
  }

  function buildCodeBlock(c){
    var b64 = encodeURIComponent(c.raw);
    var rawLines = c.raw.split(/\r?\n/);
    var FOLD_THRESHOLD = 24, FOLD_KEEP = 16;
    var foldable = rawLines.length > FOLD_THRESHOLD;

    if (isShellLang(c.L)){
      var prompt = shellPrompt(c.L);
      var body = "";
      for (var i = 0; i < rawLines.length; i++){
        var lnRaw = rawLines[i];
        var prev = i > 0 ? rawLines[i-1] : "";
        var continued = i > 0 && /\\\s*$/.test(prev);
        var blank = lnRaw.trim() === "";
        if (blank){ body += "\n"; continue; }
        if (continued){ body += "  " + escHtml(lnRaw) + "\n"; }
        else { body += "<span class=\"tprom\">" + prompt + "</span> " + escHtml(lnRaw) + "\n"; }
      }
      return "<pre class=\"cb tb" + (foldable ? " foldable" : "") + "\" data-code=\"" + b64 + "\" data-lang=\"" + escHtml(c.L) + "\" data-lines=\"" + rawLines.length + "\" data-keep=\"" + FOLD_KEEP + "\">" +
        "<div class=\"cb-h\">" +
          "<span class=\"lang\">\u25B6 " + escHtml(c.L) + "</span>" +
          "<button class=\"cb-run\" title=\"\u5728 VS Code \u7ec8\u7aef\u8fd0\u884c\">\u25B6 \u8fd0\u884c</button>" +
          "<button class=\"cb-term\" title=\"\u63d2\u5165\u7ec8\u7aef\u4f46\u4e0d\u6267\u884c\">\u2192 \u63d2\u5165\u7ec8\u7aef</button>" +
          "<button class=\"cb-copy\">\u590d\u5236</button>" +
        "</div>" +
        "<code>" + body + "</code>" +
        (foldable ? "<button class=\"cb-fold\">\u2026 \u5c55\u5f00\u5168\u90e8 " + rawLines.length + " \u884c</button>" : "") +
      "</pre>";
    }
    var highlighted = hl(c.raw, c.L);
    return "<pre class=\"cb" + (foldable ? " foldable" : "") + "\" data-code=\"" + b64 + "\" data-lang=\"" + escHtml(c.L) + "\" data-lines=\"" + rawLines.length + "\" data-keep=\"" + FOLD_KEEP + "\">" +
      "<div class=\"cb-h\">" +
        "<span class=\"lang\">" + escHtml(c.L) + "</span>" +
        "<button class=\"cb-copy\">\u590d\u5236</button>" +
        "<button class=\"cb-insert\">\u63d2\u5165\u7f16\u8f91\u5668</button>" +
        "<button class=\"cb-apply\" title=\"\u667a\u80fd Apply \u5230\u5f53\u524d\u6587\u4ef6\">\u2714 Apply</button>" +
        "<button class=\"cb-newfile\" title=\"\u4fdd\u5b58\u4e3a\u65b0\u6587\u4ef6\">\ud83d\udcc4 \u65b0\u5efa\u6587\u4ef6</button>" +
      "</div><code>" + highlighted + "</code>" +
      (foldable ? "<button class=\"cb-fold\">\u2026 \u5c55\u5f00\u5168\u90e8 " + rawLines.length + " \u884c</button>" : "") +
    "</pre>";
  }

  /* ─── KaTeX math rendering helpers ─────────────────────────────── */
  function renderMathSafe(tex, displayMode){
    if (typeof katex === "undefined") return "<code class=\"ic\">" + escHtml(tex) + "</code>";
    try {
      return katex.renderToString(tex, { displayMode: displayMode, throwOnError: false, output: "html" });
    } catch(e) {
      return "<code class=\"ic\">" + escHtml(tex) + "</code>";
    }
  }
  function renderMathBlock(m){
    return "<div class=\"math-block\">" + renderMathSafe(m.tex.trim(), true) + "</div>";
  }

  /* Extract the human-readable text from a run_shell result.
     shell.js returns a JSON object with a `text` field for normal exits;
     error/timeout paths return a plain string.  This helper handles both. */
  function getShellText(out) {
    try {
      var p = JSON.parse(out);
      if (p && p.text !== undefined) return p.text;
    } catch(e) {}
    return out;
  }

  /* Strip ANSI escape codes and collapse \r-overwrite progress bars.
     tqdm/rich etc. use \r to rewrite the current line — keep only the last
     overwrite so 100 progress-bar frames become 1 clean line. */
  function stripAnsi(s) {
    s = String(s || '');
    /* Collapse \r overwrites: keep the last segment on each \n-line */
    s = s.split('\n').map(function(line) {
      var parts = line.split('\r');
      return parts[parts.length - 1];
    }).join('\n');
    /* Strip ANSI/VT escape sequences */
    s = s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');           /* CSI: \e[...m */
    s = s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ''); /* OSC: title etc. */
    s = s.replace(/\x1b[@-Z\\-_]/g, '');                    /* 2-byte escapes */
    /* Remove leftover non-printable control chars (\n and \t are kept) */
    s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    /* Collapse 3+ consecutive blank lines to 2 */
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.trim();
  }

  function renderMd(s){
    /* ─── Whitelisted HTML passthrough (Issue #35) ───────────────
       Park raw <tag>/</tag> tokens for safe tags BEFORE any escaping
       so users / the model can use <details>, <kbd>, <mark>, etc.
       DOMPurify (loaded globally) sanitizes the final HTML as a
       defense-in-depth net for anything that slipped through. */
    var SAFE_HTML_TAGS = "details|summary|kbd|mark|sub|sup|abbr|ins|del|dfn|samp|var|br|hr|wbr|u|small|s|q|cite|figure|figcaption|p|strong|em|b|i|span|code|a|time|data|bdi|bdo|ruby|rt|rp|rb";
    var SAFE_TAG_RE = new RegExp(
      "<\\/?(?:" + SAFE_HTML_TAGS + ")(?:\\s+[a-zA-Z_:][\\w:.-]*(?:\\s*=\\s*(?:\"[^\"]*\"|'[^']*'|[^\\s>]+))?)*\\s*\\/?>",
      "gi"
    );
    var htmlToks = [];
    function parkHtml(tok){
      htmlToks.push(tok);
      return "\u0000HTML" + (htmlToks.length - 1) + "\u0000";
    }
    s = String(s||"").replace(SAFE_TAG_RE, function(tok){ return parkHtml(tok); });

    /* Step 0: extract display math $$...$$, \[...\] and inline \(...\) as
       placeholders (before code blocks so that math inside ``` isn't touched). */
    var maths = [];
    function parkMath(tex, display){
      maths.push({ display: display, tex: tex });
      return "\u0000MATH" + (maths.length - 1) + "\u0000";
    }
    var src0 = String(s||"")
      /* display: $$...$$ */
      .replace(/\$\$([\s\S]*?)\$\$/g, function(_, tex){ return parkMath(tex, true); })
      /* display: \[...\] */
      .replace(/\\\[([\s\S]*?)\\\]/g, function(_, tex){ return parkMath(tex, true); })
      /* inline: \(...\) */
      .replace(/\\\(([\s\S]*?)\\\)/g, function(_, tex){ return parkMath(tex, false); })
      /* inline: $...$ — must come AFTER $$...$$ so double-dollar is already gone.
         Parking here (before table/paragraph/renderInline) fixes two bugs:
         (a) | inside math (e.g. |\boldsymbol{\xi}|) no longer breaks table
             column splitting in splitRow(); and
         (b) raw TeX reaches KaTeX before any escHtml() call, so > is never
             corrupted into &gt; which KaTeX cannot parse. */
      .replace(/(?<!\$)\$([^\$\n]{1,200})\$(?!\$)/g, function(_, tex){ return parkMath(tex, false); });
    /* Step 1: extract fenced code blocks as placeholders */
    var codes = [];
    var src = String(src0||"").replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, function(_, lang, code){
      var L = (lang || "plaintext").toLowerCase();
      var raw = code.replace(/\n$/, "");
      codes.push({L:L, raw:raw});
      return "\u0000CB" + (codes.length-1) + "\u0000";
    });
    /* Step 1.5: extract raw HTML blocks as placeholders.
       When a line starts with a structural block-level HTML element
       (<table>, <ul>, <ol>, <dl>, <div>, <section>, <article>, <aside>,
       <header>, <footer>, <main>, <nav>, <blockquote>, <fieldset>)
       we collect lines until the root tag depth returns to 0, then park
       the whole block as \u0000HB{n}\u0000.  The Markdown line processor
       never sees the raw HTML; DOMPurify sanitises it in the final pass. */
    var htmlBlocks = [];
    var HB_TAGS = "table|ul|ol|dl|div|section|article|aside|header|footer|main|nav|blockquote|fieldset|h1|h2|h3|h4|h5|h6";
    var HB_START = new RegExp("^\\s*<(" + HB_TAGS + ")(\\s[^>]*)?>" , "i");
    (function(){
      var srcArr = src.split(/\r?\n/);
      var newArr = [];
      var si = 0;
      while (si < srcArr.length) {
        var sln = srcArr[si];
        var hbm = HB_START.exec(sln.trim());
        if (hbm) {
          var rtag = hbm[1].toLowerCase();
          var openRe  = new RegExp("<" + rtag + "[\\s>]", "gi");
          var closeRe = new RegExp("</" + rtag + "\\s*>", "gi");
          var bBuf = [sln];
          openRe.lastIndex = 0; closeRe.lastIndex = 0;
          var dep = (sln.match(openRe)||[]).length - (sln.match(closeRe)||[]).length;
          si++;
          while (si < srcArr.length && dep > 0) {
            var slk = srcArr[si];
            openRe.lastIndex = 0; closeRe.lastIndex = 0;
            dep += (slk.match(openRe)||[]).length - (slk.match(closeRe)||[]).length;
            bBuf.push(slk); si++;
          }
          htmlBlocks.push(bBuf.join("\n"));
          newArr.push("\u0000HB" + (htmlBlocks.length - 1) + "\u0000");
        } else { newArr.push(sln); si++; }
      }
      src = newArr.join("\n");
    })();
    var lines = src.split(/\r?\n/);
    var out = [];
    var paraBuf = [];
    function flushPara(){
      if (!paraBuf.length) return;
      var joined = paraBuf.join(" ");
      /* If a paragraph is JUST a code-block placeholder, emit it raw */
      var only = joined.match(/^\s*\u0000CB(\d+)\u0000\s*$/);
      if (only){
        out.push(buildCodeBlock(codes[+only[1]]));
      } else {
        /* If a paragraph is JUST a math placeholder, emit math block */
        var monly = joined.match(/^\s*\u0000MATH(\d+)\u0000\s*$/);
        if (monly){
          out.push(renderMathBlock(maths[+monly[1]]));
        } else {
          out.push("<p>" + renderInline(joined) + "</p>");
        }
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
        out.push(buildCodeBlock(codes[idx]));
        i++; continue;
      }
      /* Standalone display-math placeholder line */
      if (/^\s*\u0000MATH\d+\u0000\s*$/.test(ln)){
        flushPara();
        var midx = +ln.match(/\u0000MATH(\d+)\u0000/)[1];
        out.push(renderMathBlock(maths[midx]));
        i++; continue;
      }
      /* Standalone HTML-block placeholder line */
      if (/^\s*\u0000HB\d+\u0000\s*$/.test(ln)){
        flushPara();
        var hbIdx = +ln.match(/\u0000HB(\d+)\u0000/)[1];
        out.push("\u0000HBRAW" + hbIdx + "\u0000");
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
    /* Final pass: restore ALL math placeholders (display + inline) anywhere
       they survived — inside <p>, <li>, <td>, <th>, <blockquote>, etc.
       Done after the markdown HTML is fully assembled so we don't have to
       worry about which sub-renderer escaped or transformed the placeholder. */
    var finalHtml = out.join("");
    finalHtml = finalHtml.replace(/\u0000MATH(\d+)\u0000/g, function(_, idx){
      var m = maths[+idx];
      if (!m) return "";
      return m.display
        ? "<div class=\"math-block\">" + renderMathSafe(m.tex.trim(), true) + "</div>"
        : renderMathSafe(m.tex.trim(), false);
    });
    /* Restore raw HTML blocks FIRST so that any \u0000HTML{n}\u0000 tokens
       embedded inside them (parked by SAFE_TAG_RE before HB extraction) are
       still present when the HTML-token pass runs below. Reversing this order
       causes those embedded tokens to appear as literal "HTML12" text. */
    finalHtml = finalHtml.replace(/\u0000HBRAW(\d+)\u0000/g, function(_, idx){
      return htmlBlocks[+idx] || "";
    });
    /* Restore whitelisted HTML tag tokens (Issue #35).
       Must run AFTER HBRAW so tokens embedded inside HB blocks are caught. */
    finalHtml = finalHtml.replace(/\u0000HTML(\d+)\u0000/g, function(_, idx){
      return htmlToks[+idx] || "";
    });
    /* Defense-in-depth: DOMPurify strips anything not in the whitelist
       (scripts, event handlers, javascript: URIs, etc.). Code blocks and
       math output use plain tags & classes already on the allow-list. */
    if (typeof DOMPurify !== "undefined" && DOMPurify && DOMPurify.sanitize){
      try {
        finalHtml = DOMPurify.sanitize(finalHtml, {
          ADD_TAGS: ["details", "summary", "kbd", "mark", "sub", "sup", "abbr",
                     "ins", "del", "dfn", "samp", "var", "figure", "figcaption",
                     "h1", "h2", "h3", "h4", "h5", "h6",
                     "math", "annotation", "semantics", "mrow", "mi", "mo", "mn",
                     "msup", "msub", "mfrac", "msqrt", "mtext", "munder", "mover"],
          ADD_ATTR: ["open", "colspan", "rowspan", "data-path", "data-line",
                     "data-code", "data-lang", "data-lines", "data-keep",
                     "aria-hidden", "aria-label", "viewBox", "stroke", "stroke-width",
                     "stroke-linecap", "stroke-linejoin", "fill", "d"],
          FORBID_TAGS: ["script", "iframe", "object", "embed",
                        "style", "link", "meta", "base"],
          FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover",
                        "onfocus", "onblur", "onchange", "onsubmit",
                        "srcdoc", "formaction"],
          ALLOW_DATA_ATTR: true,
        });
      } catch(e){ /* fall through with unsanitized html */ }
    }
    return finalHtml;
  }

  /* ─── Throttled streaming render ────────────────────────────────
     Streaming chat responses can arrive as thousands of tiny chunks
     (one per token). Re-running the full renderMd → KaTeX → highlight
     pipeline on every chunk is O(N²) and freezes the webview for long
     replies (long code blocks, math, etc.). We coalesce updates into
     one DOM write per animation frame and force a final flush at
     transition points (newTurn, toolStart, replyEnd). */
  var _renderRafId = 0;
  var _renderLastTs = 0;
  function _doRender(){
    _renderRafId = 0;
    _renderLastTs = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    if (cur && cur.classList && cur.classList.contains("seg")){
      try { cur.innerHTML = renderMd(curText); } catch(e){}
    }
  }
  function scheduleRender(){
    if (_renderRafId) return;
    _renderRafId = (typeof requestAnimationFrame === "function")
      ? requestAnimationFrame(_doRender)
      : setTimeout(function(){ _doRender(); }, 16);
  }
  function flushRender(){
    if (_renderRafId){
      if (typeof cancelAnimationFrame === "function") {
        try { cancelAnimationFrame(_renderRafId); } catch(e){ clearTimeout(_renderRafId); }
      } else { clearTimeout(_renderRafId); }
      _renderRafId = 0;
    }
    _doRender();
  }

  /* ─── #6 Phase 4 helper: per-message hover action bar ──────────── */
  /* Clean icon-only buttons (Copilot / ChatGPT style). SVGs use currentColor
     so they inherit the descriptionForeground / foreground colors on hover. */
  var ICO_COPY  = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" d="M5.5 2.5h6a1 1 0 0 1 1 1v8M3.5 5.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z"/></svg>';
  var ICO_REGEN = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89M13.5 2.5v3h-3"/></svg>';
  var ICO_UP    = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" d="M6 13.5H3.5v-6H6m0 6 2.2 0a1.5 1.5 0 0 0 1.48-1.24l.6-3.3A1 1 0 0 0 9.3 7.75H6.8l.55-2.6A1.4 1.4 0 0 0 5.98 3.5L6 7.5v6Z"/></svg>';
  var ICO_DOWN  = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" d="M6 2.5H3.5v6H6m0-6 2.2 0a1.5 1.5 0 0 1 1.48 1.24l.6 3.3A1 1 0 0 1 9.3 8.25H6.8l.55 2.6A1.4 1.4 0 0 1 5.98 12.5L6 8.5v-6Z"/></svg>';
  function actionBarHtml(){
    return "<div class=\"msgActs\">" +
      "<button class=\"ma ma-copy\" title=\"\u590d\u5236\" aria-label=\"\u590d\u5236\">" + ICO_COPY + "</button>" +
      "<button class=\"ma ma-regen\" title=\"\u91cd\u65b0\u751f\u6210\" aria-label=\"\u91cd\u65b0\u751f\u6210\">" + ICO_REGEN + "</button>" +
      "<button class=\"ma ma-up\" title=\"\u6709\u7528\" aria-label=\"\u6709\u7528\">" + ICO_UP + "</button>" +
      "<button class=\"ma ma-down\" title=\"\u4e0d\u6709\u7528\" aria-label=\"\u4e0d\u6709\u7528\">" + ICO_DOWN + "</button>" +
    "</div>";
  }

  /* ─── #8 Phase 6: rich error card with optional Retry ────────── */
  function addErrorCard(m){
    if (es) es.style.display = "none";
    var d = document.createElement("div");
    d.className = "errCard";
    var title = escHtml(m.title || "请求失败");
    var body  = escHtml(m.text || "");
    var codeBadge = m.code ? "<span class=\"errCode\">HTTP " + m.code + "</span>" : "";
    var retryBtn = m.retryable ? "<button class=\"errRetry\">\ud83d\udd04 \u91cd\u8bd5</button>" : "";
    var rawDetails = m.raw && m.raw !== m.text
      ? "<details class=\"errRaw\"><summary>\u539f\u59cb\u9519\u8bef</summary><pre>" + escHtml(m.raw) + "</pre></details>"
      : "";
    d.innerHTML =
      "<div class=\"errHd\"><span class=\"errIco\">\u26a0</span><span class=\"errTitle\">" + title + "</span>" + codeBadge + "</div>" +
      "<div class=\"errBody\">" + body + "</div>" +
      "<div class=\"errFt\">" + retryBtn + "</div>" +
      rawDetails;
    if (thk && thk.parentNode === msgs) msgs.insertBefore(d, thk); else msgs.appendChild(d);
    ascroll();
  }

  function add(role, text){
    if (es) es.style.display = "none";
    var d = document.createElement("div");
    if (role === "user"){
      var idx = _userMsgCount++;
      d.className = "msgU";
      d.dataset.msgIdx = idx;
      d.dataset.origText = text || "";
      d.innerHTML = "<div class=\"msgU-body\">" + escHtml(text) + "</div>";
    } else if (role === "assistant"){
      d.className = "msgA";
      d.setAttribute("data-raw", text || "");
      d.innerHTML = "<div class=\"msgC\">" + escHtml(text) + "</div>";
    } else { d.className = "err"; d.textContent = text; }
    if (thk && thk.parentNode === msgs) msgs.insertBefore(d, thk); else msgs.appendChild(d);
    ascroll();
  }

  function ensureBubble(){
    if (curBubble) return curBubble;
    if (es) es.style.display = "none";
    var d = document.createElement("div");
    d.className = "msgA";
    d.innerHTML = "<div class=\"flow\"></div>";
    if (thk && thk.parentNode === msgs) msgs.insertBefore(d, thk); else msgs.appendChild(d);
    curBubble = d;
    cur = null;        /* no active text segment yet */
    curText = "";
    curThk = null;
    curThkHead = null;
    return d;
  }

  /* Restore reasoning display: create an inline collapsible thinking chip
     inside .flow. Called once per turn when the first thinkingDelta arrives.
     curThkHead / curThk are read by the thinkingDelta, replyDelta and
     newTurn handlers — do not rename those variables. */
  function makeThinkChip() {
    ensureBubble();
    var flow = curBubble.querySelector('.flow');
    if (!flow) return;

    var slot = document.createElement('div');
    slot.className = 'think-slot';

    var head = document.createElement('div');
    head.className = 'thinkhead';
    head.style.display = 'none'; // revealed on first thinkingDelta token
    head.innerHTML =
      '<span class="th-chev">\u25be</span>' +
      '<span class="th-lbl">Thinking\u2026</span>';

    var body = document.createElement('pre');
    body.className = 'thinkblk';
    body.style.display = 'block'; // expanded while streaming; collapsed on reply

    head.addEventListener('click', function() {
      var open = body.style.display === 'block';
      body.style.display = open ? 'none' : 'block';
      var chev = head.querySelector('.th-chev');
      if (chev) chev.textContent = open ? '\u25b8' : '\u25be';
    });

    slot.appendChild(head);
    slot.appendChild(body);
    flow.appendChild(slot);

    curThkHead = head;
    curThk = body;
  }

  /* Group the trailing run of consecutive tool elements (.tl-wrap and .tool
     cards) into a collapsible .tl-group. Called when text starts streaming
     after tools (GH Copilot look-ahead fold). */
  function groupTrailingToolLines(){
    if (!curBubble) return;
    var flow = curBubble.querySelector(".flow");
    if (!flow) return;
    var children = Array.from(flow.children);
    /* Collect trailing tool elements (.tl-wrap prose lines AND .tool cards) */
    var trailing = [];
    for (var i = children.length - 1; i >= 0; i--){
      var el = children[i];
      if (el.classList.contains("tl-wrap") ||
          (el.classList.contains("tool") && !el.classList.contains("tl-group"))) {
        trailing.unshift(el);
      } else { break; }
    }
    if (trailing.length >= 2) makeToolGroup(flow, trailing);
  }

  /* Extract the short verb label from a tool element (prose line or card). */
  function getToolVerb(el) {
    if (el.classList.contains("tl-wrap")) {
      var proseEl = el.querySelector(".tl-prose");
      return proseEl ? proseEl.textContent.trim().split(/\s+/)[0] : "Tool";
    }
    var nmEl = el.querySelector(".nm");
    return nmEl ? nmEl.textContent.trim() : "Tool";
  }

  /* Build a GH-Copilot-style semantic summary from a group of tool nodes.
     Returns an HTML string (safe — all dynamic values go through escHtml/chip).
     Examples:
       read_file ×3 same file  → "Reviewed <chip>bg-shell.js</chip>"
       read_file ×2 diff files → "Read <chip>a.js</chip> <chip>b.js</chip>"
       grep_search             → "Searched <chip>pattern</chip>"
       run_shell ×2 powershell → "Ran <chip>powershell</chip> ×2"          */
  function makeSemanticLabel(nodes) {
    function chip(s) {
      return '<span class="tl-chip">' + escHtml(String(s || "")) + '</span>';
    }
    var reads = [], writes = [], searches = [], shells = [], agents = [], others = [];
    nodes.forEach(function(el) {
      /* Determine kind from the .k-* class on the inner .tl or card root */
      var tlEl = el.classList.contains("tl-wrap") ? el.querySelector(".tl") : el;
      var kind = "other";
      ["read", "write", "search", "shell", "plan", "agent"].forEach(function(k) {
        if (tlEl && tlEl.classList.contains("k-" + k)) kind = k;
      });
      /* Primary <code> in .tl-prose holds the key target value */
      var codeEl = el.querySelector(".tl-prose code");
      var rawTarget = codeEl ? codeEl.textContent.trim()
                             : (el.querySelector(".tgt") ? el.querySelector(".tgt").textContent.trim() : "");
      /* Filename only (strip directory prefix) */
      var filename = rawTarget ? rawTarget.split(/[\/\\]/).pop() : "";
      if (kind === "read") {
        reads.push(filename || rawTarget);
      } else if (kind === "write") {
        writes.push(filename || rawTarget);
      } else if (kind === "search") {
        searches.push(rawTarget);
      } else if (kind === "shell") {
        /* Use verb (detected shell name) as identifier */
        var proseEl = el.querySelector(".tl-prose");
        var shVerb = proseEl ? proseEl.textContent.trim().split(/\s+/)[0] : "command";
        shells.push(shVerb);
      } else if (kind === "agent") {
        agents.push(rawTarget);
      } else {
        others.push(getToolVerb(el));
      }
    });

    var parts = [];

    if (reads.length > 0) {
      var uniq = [];
      reads.forEach(function(v) { if (v && uniq.indexOf(v) < 0) uniq.push(v); });
      if (uniq.length === 1) {
        parts.push("Reviewed " + chip(uniq[0]));
      } else if (uniq.length <= 3) {
        parts.push("Read " + uniq.map(chip).join(" "));
      } else {
        parts.push("Read " + reads.length + " files");
      }
    }

    if (writes.length > 0) {
      var uniq = [];
      writes.forEach(function(v) { if (v && uniq.indexOf(v) < 0) uniq.push(v); });
      if (uniq.length === 1) parts.push("Edited " + chip(uniq[0]));
      else parts.push("Edited " + writes.length + " files");
    }

    if (searches.length > 0) {
      if (searches.length > 1) {
        parts.push("Searched \xd7" + searches.length);
      } else {
        var pat = searches[0];
        parts.push("Searched " + (pat && pat.length <= 30 ? chip(pat) : ""));
      }
    }

    if (shells.length > 0) {
      var uniq = [];
      shells.forEach(function(v) { if (v && uniq.indexOf(v) < 0) uniq.push(v); });
      if (shells.length === 1) {
        parts.push("Ran " + chip(uniq[0] || "command"));
      } else if (uniq.length === 1) {
        parts.push("Ran " + chip(uniq[0]) + " \xd7" + shells.length);
      } else {
        parts.push("Ran " + shells.length + " commands");
      }
    }

    if (agents.length > 0) {
      parts.push("Sub-agent" + (agents.length > 1 ? " \xd7" + agents.length : ""));
    }

    var otherCounts = {};
    others.forEach(function(v) { otherCounts[v] = (otherCounts[v] || 0) + 1; });
    Object.keys(otherCounts).forEach(function(v) {
      parts.push(otherCounts[v] > 1 ? escHtml(v) + " \xd7" + otherCounts[v] : escHtml(v));
    });

    /* Fallback to mechanical label if nothing matched */
    if (!parts.length) {
      var verbCounts = {};
      nodes.forEach(function(el) {
        var v = getToolVerb(el);
        verbCounts[v] = (verbCounts[v] || 0) + 1;
      });
      return Object.keys(verbCounts).map(function(v) {
        return verbCounts[v] > 1 ? escHtml(v) + " \xd7" + verbCounts[v] : escHtml(v);
      }).join("  \xb7  ");
    }

    return parts.join(' <span class="tl-dot">\xb7</span> ');
  }

  /* Wrap a contiguous array of tool nodes into a single collapsible .tl-group. */
  function makeToolGroup(flow, nodes) {
    if (!nodes || nodes.length < 2) return;
    var labelHtml = makeSemanticLabel(nodes);
    var firstIco = nodes[0].querySelector(".ico");
    var icoHtml = firstIco ? firstIco.outerHTML : "";
    var grp = document.createElement("div");
    grp.className = "tl-group";
    var sumRow = document.createElement("div");
    sumRow.className = "tl-summary";
    sumRow.innerHTML = icoHtml + "<span class=\"tl-prose\">" + labelHtml + "</span><span class=\"tl-chev\">\u2228</span>";
    var listEl = document.createElement("div");
    listEl.className = "tl-list";
    /* Insert group in place of first node, then migrate all nodes into listEl */
    flow.insertBefore(grp, nodes[0]);
    nodes.forEach(function(n){ listEl.appendChild(n); });
    grp.appendChild(sumRow);
    grp.appendChild(listEl);
    (function(g){ sumRow.addEventListener("click", function(){ g.classList.toggle("open"); }); })(grp);
    return grp;
  }

  /* Scan the entire .flow and group ALL contiguous runs of tool elements.
     Called at replyEnd so every tool sequence (mid-turn or trailing) is folded. */
  function groupAllToolRuns() {
    if (!curBubble) return;
    var flow = curBubble.querySelector(".flow");
    if (!flow) return;
    /* Snapshot children before any DOM mutation */
    var children = Array.from(flow.children);
    var runs = [];
    var current = [];
    children.forEach(function(el) {
      var isTool = (el.classList.contains("tl-wrap") ||
                    (el.classList.contains("tool") && !el.classList.contains("tl-group")));
      if (isTool) {
        current.push(el);
      } else {
        if (current.length >= 2) runs.push(current.slice());
        current = [];
      }
    });
    if (current.length >= 2) runs.push(current);
    runs.forEach(function(run){ makeToolGroup(flow, run); });
  }

  /* Progressive live grouping: called after each toolResult.
     Dissolves any previous groups, then re-groups all completed (non-running)
     consecutive tool elements into one collapsible group, leaving the actively
     running tool visible below it. Preserves the user open/closed state. */
  function liveGroupCompleted() {
    if (!curBubble) return;
    var flow = curBubble.querySelector(".flow");
    if (!flow) return;
    /* Preserve open state of any existing group before dissolving */
    var existingGroups = Array.from(flow.querySelectorAll(":scope > .tl-group"));
    var wasOpen = existingGroups.some(function(g){ return g.classList.contains("open"); });
    /* Dissolve all existing groups back into the flow (preserving document order) */
    existingGroups.forEach(function(grp) {
      var list = grp.querySelector(".tl-list");
      if (list) Array.from(list.children).forEach(function(c){ flow.insertBefore(c, grp); });
      grp.remove();
    });
    /* Re-group consecutive COMPLETED (non-running) tool elements */
    var children = Array.from(flow.children);
    var runs = [], current = [];
    children.forEach(function(el) {
      var isTool = el.classList.contains("tl-wrap") ||
                   (el.classList.contains("tool") && !el.classList.contains("tl-group"));
      var isRunning = el.classList.contains("run") ||
                      !!(el.querySelector && el.querySelector(".tl.run"));
      if (isTool && !isRunning) {
        current.push(el);
      } else {
        if (current.length >= 2) runs.push(current.slice());
        current = [];
      }
    });
    if (current.length >= 2) runs.push(current);
    if (!runs.length) return;
    runs.forEach(function(run) {
      var grp = makeToolGroup(flow, run);
      if (grp && wasOpen) {
        grp.classList.add("open");
        var list = grp.querySelector(".tl-list");
        /* Scroll to bottom so the latest completed entry is visible */
        if (list) list.scrollTop = list.scrollHeight;
      }
    });
  }

  /* Ensure there is a current text segment to stream markdown into.
     A new segment is created after each tool card so text/tool order is
     preserved (Copilot-style interleaving). When text arrives AFTER tools,
     group those trailing tool lines first (GH Copilot look-ahead fold). */
  function ensureTextSegment(){
    ensureBubble();
    if (cur && cur.classList && cur.classList.contains("seg")) return cur;
    groupTrailingToolLines();
    var seg = document.createElement("div");
    seg.className = "msgC seg";
    curBubble.querySelector(".flow").appendChild(seg);
    cur = seg;
    curText = "";
    return seg;
  }

  function shortArgs(s){
    try { var o = JSON.parse(s||"{}"); return JSON.stringify(o); } catch(e){ return String(s||"").slice(0,200); }
  }
  /* Copilot-style verb + target extraction (e.g. "Read crates/core/src/lib.rs") */
  var TOOL_META = {
    read_file:    { verb:"Read",         icon:"codicon-file",          kind:"read"   },
    write_file:   { verb:"Edited",       icon:"codicon-edit",          kind:"write"  },
    list_dir:     { verb:"Listed",       icon:"codicon-folder-opened", kind:"read"   },
    grep_search:  { verb:"Searched",     icon:"codicon-search",        kind:"search" },
    run_shell:    { verb:"Ran",          icon:"codicon-terminal",      kind:"shell"  },
    read_terminal:{ verb:"Read terminal", icon:"codicon-terminal-view-icon", kind:"shell"  },
    update_plan:  { verb:"Updated plan", icon:"codicon-checklist",     kind:"plan"   },
    spawn_agent:  { verb:"Sub-agent",    icon:"codicon-robot",         kind:"agent"  }
  };
  /* Detect the program/shell being invoked so we can show "powershell" / "python" / "bash"
     as the verb (mirrors GH Copilot's "Ran terminal command: powershell" style). */
  function detectShell(cmd){
    var s = String(cmd||"").trim();
    if (!s) return "shell";
    /* strip leading "& " or env assignments */
    s = s.replace(/^&\s+/, "").replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, "");
    /* strip leading "cd dir &&" chains so "cd analysis && python foo.py" → "python foo.py" */
    s = s.replace(/^(?:cd\s+\S+\s*&&\s*)+/i, "");
    var first = s.split(/\s+/)[0] || "";
    /* trim quotes & path */
    first = first.replace(/^['\"]+|['\"]+$/g, "");
    var base = first.split(/[\\\/]/).pop().toLowerCase();
    base = base.replace(/\.(exe|cmd|bat|ps1)$/, "");
    if (!base) return "shell";
    if (base === "pwsh" || base === "powershell") return "powershell";
    if (base === "sh" || base === "bash" || base === "zsh" || base === "fish") return base;
    return base;
  }
  function toolMeta(name, argStr){
    var meta = TOOL_META[name] || { verb:name, icon:"codicon-tools", kind:"other" };
    if (name === "run_shell"){
      var o; try { o = JSON.parse(argStr||"{}"); } catch(e){ o = {}; }
      var sh = detectShell(o && (o.command || o.cmd));
      return { verb: sh, icon: meta.icon, kind: meta.kind, shell: sh };
    }
    return meta;
  }
  function toolTarget(name, argStr){
    var o; try { o = JSON.parse(argStr||"{}"); } catch(e){ return ""; }
    if (!o || typeof o !== "object") return "";
    if (name === "read_file"){
      var p = o.path || o.file || ""; if (!p) return "";
      if (o.start_line || o.end_line) return p + ", lines " + (o.start_line||1) + " to " + (o.end_line||"end");
      return p;
    }
    if (name === "write_file") return o.path || o.file || "";
    if (name === "list_dir") return o.path || o.dir || ".";
    if (name === "grep_search") return (o.pattern || o.query || "") + (o.path ? "  in " + o.path : "");
    if (name === "run_shell") {
      var rc = String(o.command || o.cmd || "").replace(/^(?:cd\s+\S+\s*&&\s*)+/i, "").trim();
      return rc.slice(0, 70);
    }
    if (name === "read_terminal"){
      var tn = o.terminal ? String(o.terminal) : "active terminal";
      var ln = o.lastN ? ", last " + o.lastN : "";
      return tn + ln;
    }
    if (name === "update_plan"){
      var p = (o.steps && o.steps.length) ? o.steps : ((o.plan && o.plan.length) ? o.plan : []);
      return p.length ? (p.length + " step" + (p.length>1?"s":"")) : "";
    }
    if (name === "spawn_agent") return o.description || (o.prompt && String(o.prompt).slice(0, 80)) || "";
    var v = o.path || o.file || o.query || o.pattern || o.command || ""; return String(v).slice(0,120);
  }

  /* Build an HTML prose sentence for a tool call (safe — all values go through escHtml/code). */
  function toolProseHtml(name, argStr, meta){
    var o; try { o = JSON.parse(argStr||"{}" ); } catch(e){ o = {}; }
    function code(s){ return "<code>" + escHtml(String(s||" ").slice(0,80)) + "</code>"; }
    var verb = escHtml(meta.verb);
    if (name === "read_file"){
      var p = o.path || o.file || ""; if (!p) return verb;
      var loc = (o.start_line || o.end_line) ? ", lines " + (o.start_line||1) + " to " + (o.end_line||"end") : "";
      return verb + " " + code(p) + escHtml(loc);
    }
    if (name === "write_file") return verb + " " + code(o.path || o.file || "");
    if (name === "list_dir")   return verb + " " + code(o.path || o.dir || ".");
    if (name === "grep_search"){
      var pat = o.pattern || o.query || "";
      var inPath = o.path || o.dir || "";
      return verb + " for " + code(pat) + (inPath ? " in " + code(inPath) : "");
    }
    if (name === "run_shell"){
      var cmd = String(o.command || o.cmd || "").replace(/^(?:cd\s+\S+\s*&&\s*)+/i, "").trim();
      return verb + " " + code(cmd.length > 60 ? cmd.slice(0,60) + "\u2026" : cmd);
    }
    if (name === "spawn_agent"){
      var lbl = String(o.description || (o.prompt && String(o.prompt).slice(0,60)) || "");
      return verb + ": " + code(lbl || "task");
    }
    var tgt = String(o.path || o.file || o.query || o.pattern || o.command || "");
    return verb + (tgt ? " " + code(tgt) : "");
  }

  /* Prose line tool row — no expandable body, result appended inline. */
  function addToolLine(id, name, args){
    ensureBubble();
    var holder = curBubble.querySelector(".flow");
    var wrap = document.createElement("div");
    wrap.className = "tl-wrap";
    var d = document.createElement("div");
    var meta = toolMeta(name, args);
    d.className = "tl run k-" + meta.kind;
    d.innerHTML =
      "<i class=\"ico codicon " + escHtml(meta.icon) + "\"></i>" +
      "<span class=\"tl-prose\">" + toolProseHtml(name, args, meta) + "</span>" +
      "<span class=\"tl-res\"></span>" +
      "<span class=\"tl-exp codicon codicon-chevron-right\" title=\"展开\"></span>";
    var detail = document.createElement("div");
    detail.className = "tl-detail";
    wrap.appendChild(d);
    wrap.appendChild(detail);
    holder.appendChild(wrap);
    if (cur && cur.classList && cur.classList.contains("seg")) { flushRender(); cur.setAttribute("data-raw", curText || ""); }
    cur = null; curText = "";
    /* Toggle expand on row click — only active after has-detail is set */
    d.addEventListener("click", function(){
      if (!d.classList.contains("has-detail")) return;
      var open = d.classList.toggle("open");
      detail.style.display = open ? "block" : "none";
      var rec = toolMap.get(id); if (rec) rec._userToggled = true;
    });
    toolMap.set(id, { root:d, body:detail, status:d.querySelector(".tl-res"), isLine:true, name:name, args:args, _startedAt:Date.now(), _userToggled:false });
    ascroll();
    return d;
  }

  function addToolCard(id, name, args, opts){
    opts = opts || {};
    ensureBubble();
    var holder = curBubble.querySelector(".flow");
    var d = document.createElement("div");
    var meta = toolMeta(name, args);
    d.className = "tool run k-" + meta.kind;
    var target = toolTarget(name, args);
    var statusTxt = opts.approval ? "等待批准" : "…";
    d.innerHTML = 
      "<div class=\"h\">" +
        "<span class=\"chev\">▶</span>" +
        "<i class=\"ico codicon " + escHtml(meta.icon) + "\"></i>" +
        "<span class=\"nm\">" + escHtml(meta.verb) + "</span>" +
        "<span class=\"tgt\" title=\"" + escHtml(target) + "\">" + escHtml(target) + "</span>" +
        "<span class=\"st\">" + escHtml(statusTxt) + "</span>" +
      "</div>" +
      "<div class=\"b\"><div class=\"out\"></div></div>";
    holder.appendChild(d);
    /* Tool card breaks the current text run; next replyDelta will start a new segment. */
    if (cur && cur.classList && cur.classList.contains("seg")) cur.setAttribute("data-raw", curText || "");
    cur = null; curText = "";
    d.querySelector(".h").addEventListener("click", function(){
      d.classList.toggle("open");
      /* User manually toggled — lock against auto-collapse on completion */
      var rec = toolMap.get(id); if (rec) rec._userToggled = true;
    });
    /* run_shell: start expanded so the live stdout tail is visible while
       the command is running (GH Copilot terminal-card convention).
       On completion, toolResult() will collapse it iff success and the user
       hasn't manually toggled. */
    if (name === "run_shell" && !opts.approval) {
      d.classList.add("open");
    }
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
    toolMap.set(id, {
      root:d, body:d.querySelector(".b .out"), status:d.querySelector(".st"),
      name:name, args:args,
      _startedAt: Date.now(),
      _liveBuf: "",          /* accumulated streamed bytes (shell live tail)   */
      _userToggled: false,   /* set when user clicks header — locks auto-state */
    });
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

  // ─── Pending-edits panel (Copilot-style review of agent writes) ─────────
  var _peWired = false;
  function _wirePendingEdits(){
    if (_peWired) return;
    var panel = document.getElementById('pending-edits-panel');
    if (!panel) return;
    _peWired = true;
    var keepAll    = document.getElementById('pe-keep-all');
    var discardAll = document.getElementById('pe-discard-all');
    if (keepAll)    keepAll.addEventListener('click',    function(){ vscode.postMessage({ type: 'keepAllEdits' }); });
    if (discardAll) discardAll.addEventListener('click', function(){ vscode.postMessage({ type: 'discardAllEdits' }); });
  }
  function _peLabel(key, fallback){
    /* uses keys placed on the panel header via data attrs would require more
       HTML plumbing; for now we keep the labels English-driven via fallback */
    return fallback;
  }
  function renderPendingEdits(items){
    var panel = document.getElementById('pending-edits-panel');
    if (!panel) return;
    _wirePendingEdits();
    if (!items || !items.length){
      panel.style.display = 'none';
      return;
    }
    panel.style.display = 'flex';
    var cnt = document.getElementById('pe-count');
    if (cnt) cnt.textContent = String(items.length);
    var list = document.getElementById('pe-list');
    if (!list) return;
    list.innerHTML = '';
    items.forEach(function(it){
      var li = document.createElement('li');
      li.className = 'pe-item';
      li.title = it.path || it.rel || '';
      /* clicking the row opens the native diff editor */
      li.addEventListener('click', function(ev){
        if (ev.target && ev.target.closest && ev.target.closest('.pe-actions')) return;
        vscode.postMessage({ type: 'openEditDiff', path: it.path });
      });

      var name = document.createElement('span');
      name.className = 'pe-item-name';
      var rel = String(it.rel || it.path || '');
      var slash = rel.lastIndexOf('/');
      if (slash >= 0){
        var dir = document.createElement('span');
        dir.className = 'pe-dir';
        dir.textContent = rel.slice(0, slash + 1);
        name.appendChild(dir);
        name.appendChild(document.createTextNode(rel.slice(slash + 1)));
      } else {
        name.textContent = rel;
      }
      li.appendChild(name);

      if (it.isNew || it.isDelete || it.binary){
        var tag = document.createElement('span');
        tag.className = 'pe-tag';
        tag.textContent = it.binary ? 'binary' : it.isNew ? 'new' : 'deleted';
        li.appendChild(tag);
      }

      var stats = document.createElement('span');
      stats.className = 'pe-stats';
      if (it.added > 0){
        var a = document.createElement('span'); a.className = 'pe-add'; a.textContent = '+' + it.added; stats.appendChild(a);
      }
      if (it.removed > 0){
        var r = document.createElement('span'); r.className = 'pe-del'; r.textContent = '-' + it.removed; stats.appendChild(r);
      }
      li.appendChild(stats);

      var acts = document.createElement('span');
      acts.className = 'pe-actions';
      var bDiscard = document.createElement('button');
      bDiscard.className = 'pe-act-discard';
      bDiscard.title = 'Discard';
      bDiscard.textContent = '✕';
      bDiscard.addEventListener('click', function(ev){
        ev.stopPropagation();
        vscode.postMessage({ type: 'discardEdit', path: it.path });
      });
      var bKeep = document.createElement('button');
      bKeep.className = 'pe-act-keep';
      bKeep.title = 'Keep';
      bKeep.textContent = '✓';
      bKeep.addEventListener('click', function(ev){
        ev.stopPropagation();
        vscode.postMessage({ type: 'keepEdit', path: it.path });
      });
      acts.appendChild(bDiscard);
      acts.appendChild(bKeep);
      li.appendChild(acts);

      list.appendChild(li);
    });
  }

  function renderPlan(steps, todos){
    var allItems = [];
    (steps || []).forEach(function(s, i){
      var st = normStatus(s && s.status);
      allItems.push({ text: stepTitle(s, i), st: st });
    });
    // Only append todos if they are a distinct non-empty array
    if (todos && todos.length && todos !== steps){
      todos.forEach(function(t, i){
        var st = !!(t && t.done) ? "done" : normStatus(t && t.status);
        allItems.push({ text: stepTitle(t, i), st: st });
      });
    }
    if (!allItems.length){
      if (todoPop) todoPop.style.display = "none";
      return;
    }
    var done = allItems.filter(function(x){ return x.st === "done"; }).length;
    if (todoPopCnt) todoPopCnt.textContent = done + "/" + allItems.length;
    var html = "";
    allItems.forEach(function(item){
      html += "<li class=\"tp-item tp-" + item.st + "\"><span class=\"tp-ic\"></span><span class=\"tp-label\">" + escapeHtml(item.text) + "</span></li>";
    });
    if (todoPopList) todoPopList.innerHTML = html;
    if (todoPop) {
      todoPop.classList.remove("collapsed");
      todoPop.style.display = "flex";
      /* Auto-hide when all tasks are done */
      if (done === allItems.length) {
        setTimeout(function(){ if (todoPop) todoPop.style.display = "none"; }, 600);
      }
    }
  }
  function addTask(){ return null; }
  function updateTask(){ /* no-op since v0.16: Tasks panel removed; sessions drawer replaces it */ }

  /* ─── Footer / session metrics ─────────────────────────────────────── */
  function fmtCny(v){
    v = v || 0;
    if (v === 0) return "¥0.0000";
    if (v < 0.0001) return "¥" + v.toExponential(2);
    if (v < 1) return "¥" + v.toFixed(4);
    return "¥" + v.toFixed(3);
  }
  function fmtTokens(n){
    if (n >= 1e6) return (n/1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n/1e3).toFixed(1) + "K";
    return String(n);
  }
  function bumpUsage(u){
    sess.tokens += (u.total_tokens || 0);
    sess.cost += (u.cost_cny || 0);
    var b = u.breakdown;
    if (b) {
      sess.cacheHit += (b.cache_hit_tokens || 0);
      sess.promptTotal += (b.prompt_tokens || 0);
    }
    ftTokens.textContent = fmtTokens(sess.tokens) + " tokens";
    ftCost.textContent = fmtCny(sess.cost);
    if (ftCache) {
      var rate = sess.promptTotal ? (sess.cacheHit / sess.promptTotal * 100) : 0;
      ftCache.textContent = "💾 " + rate.toFixed(0) + "%";
      ftCache.classList.toggle("good", rate >= 50);
    }
    /* Tooltip with per-turn breakdown */
    if (b) {
      var tip =
        "本次: " + (b.total_tokens||0) + " tok"
        + " (in " + (b.prompt_tokens||0)
        + (b.cache_hit_tokens ? ", cache " + b.cache_hit_tokens : "")
        + " / out " + (b.completion_tokens||0) + ")"
        + "\n累计: " + sess.tokens + " tok / " + fmtCny(sess.cost)
        + "\n缓存命中率: " + (sess.promptTotal ? (sess.cacheHit/sess.promptTotal*100).toFixed(1) + "%" : "-")
        + "  (" + sess.cacheHit + "/" + sess.promptTotal + " prompt tok)"
        + (u.model ? "\n模型: " + u.model : "")
        + (b.pricing ? "\n单价(¥/1M): in " + b.pricing.input
            + " · cache " + b.pricing.cache_hit
            + " · out " + b.pricing.output : "");
      ftTokens.title = tip;
      ftCost.title = tip;
      if (ftCache) ftCache.title = tip;
    }
  }

  /* ─── Account balance display ────────────────────────────────────────── */
  var ftBalance = document.getElementById("ft-balance");
  function updateBalance(b){
    if (!ftBalance) return;
    if (b.unsupported){ ftBalance.style.display = "none"; return; }
    ftBalance.style.display = "";
    if (!b.available){
      ftBalance.textContent = "⛔ 账户不可用";
      ftBalance.className = "pill balance-unavail";
      ftBalance.title = "账户不可用，请检查 API Key";
      return;
    }
    var cny = b.balance_cny || 0;
    var low = cny < 5;
    ftBalance.textContent = (low ? "⚠️ " : "💰 ") + fmtCny(cny);
    ftBalance.className = "pill" + (low ? " balance-low" : " balance-ok");
    ftBalance.title = "账户余额: " + fmtCny(cny)
      + "\n充值: " + fmtCny(b.topped_up_cny || 0)
      + "  赠送: " + fmtCny(b.granted_cny || 0)
      + "\n本次会话消耗: " + fmtCny(sess.cost)
      + "\n点击刷新";
  }
  if (ftBalance){
    ftBalance.addEventListener("click", function(){
      ftBalance.textContent = "💰 查询中…";
      vscode.postMessage({ type: "balanceRefresh" });
    });
  }

  /* ─── Composer ─────────────────────────────────────────────────────── */
  /* GH-Copilot-style auto-grow: textarea height tracks content, capped at MAX. */
  var INP_MIN = 36, INP_MAX = 200;
  function autosize(){
    /* Reset to min so scrollHeight reflects actual content (not previous height). */
    inp.style.height = INP_MIN + "px";
    var h = Math.min(inp.scrollHeight, INP_MAX);
    if (h < INP_MIN) h = INP_MIN;
    inp.style.height = h + "px";
    /* Show scrollbar only when content exceeds the cap. */
    inp.style.overflowY = (inp.scrollHeight > INP_MAX) ? "auto" : "hidden";
  }
  /* Run once after layout so initial height is correct. */
  setTimeout(autosize, 0);
  /* Re-run on window resize since wrapping changes line count. */
  window.addEventListener("resize", autosize);

  /* ─── #7 Phase 5: slash commands + @ context + history ─── */
  var pop = document.getElementById("pop");
  var popVisible = false, popItems = [], popSel = 0, popKind = "", popTrigStart = 0;
  var SLASH_CMDS = [
    { name: "/explain",  desc: "解释下面这段代码做了什么", expand: "请详细解释下列代码的功能、关键逻辑和潜在问题:\n\n" },
    { name: "/fix",      desc: "查找并修复 bug",           expand: "请审查下列代码,找出 bug 或潜在问题并给出修复版本:\n\n" },
    { name: "/tests",    desc: "为以下代码写单元测试",     expand: "请为下列代码编写完整的单元测试,覆盖正常路径与边界情况:\n\n" },
    { name: "/doc",      desc: "为代码补全文档/注释",       expand: "请为下列代码补全文档注释(JSDoc/docstring 等,按语言惯例):\n\n" },
    { name: "/refactor", desc: "重构以提升清晰度/性能",     expand: "请重构下列代码以提升可读性、模块化与性能,并解释每处改动的理由:\n\n" },
    { name: "/clear",    desc: "清空当前会话",             expand: "__CLEAR__" },
  ];
  var AT_CMDS = [
    { name: "@file",      desc: "附带当前打开的文件",   action: "refEditor" },
    { name: "@selection", desc: "附带编辑器中选中的代码", action: "refSelection" },
    { name: "@terminal",  desc: "附带终端选中文本",          action: "refTerminal" },
  ];
  // ── # context references (GitHub Copilot–style) ────────────────────────
  // Each entry is either:
  //   { name:"#file",  desc, ref:"file" }              → opens file picker (reuses fileSearch)
  //   { name:"#xxx",   desc, ref:"xxx" }               → resolveContextRef on extension side
  //   { name:"#yyy:",  desc, ref:"yyy", needsArg:true } → ref with inline argument
  var HASH_REFS = [
    { name: "#file",      desc: "工作区内某个文件",            ref: "file"                       },
    { name: "#selection", desc: "当前编辑器选中的代码",        ref: "selection"                  },
    { name: "#editor",    desc: "当前编辑器整文件",            ref: "editor"                     },
    { name: "#problems",  desc: "工作区诊断 / Problems",       ref: "problems"                   },
    { name: "#changes",   desc: "Git 未提交改动 (git diff)",   ref: "changes"                    },
    { name: "#terminal",  desc: "终端选中文本",                ref: "terminal"                   },
    { name: "#symbol:",   desc: "工作区符号(函数/类) 跟符号名", ref: "symbol",  needsArg: true    },
    { name: "#fetch:",    desc: "抓取 URL 内容 跟链接",         ref: "fetch",   needsArg: true    },
  ];

  // ── @file chips (attached files) ──────────────────────────────────────
  var atChipsEl = document.getElementById("at-chips");
  var attachedFiles = []; // [{ path, content }]
  var liveSelection = null; // { path, content, startLine, endLine, lang } — auto-synced with editor selection
  var _liveDismissedKey = null; // key of the selection the user explicitly dismissed via ×
  var _pendingAttachments = null; // snapshot of chips at send time, used to render in the sent bubble
  var pendingSkill  = null; // { name, content } — staged skill chip

  function renderSkillNotice() {
    if (!skillNoticeEl) return;
    if (pendingSkill) {
      skillNoticeEl.style.display = "inline-flex";
      skillNoticeEl.innerHTML = '/' + pendingSkill.name + ' <button class="skill-notice-x" title="移除">×</button>';
    } else {
      skillNoticeEl.style.display = "none";
      skillNoticeEl.innerHTML = "";
    }
  }

  function renderChips() {
    if (!atChipsEl) return;
    var liveHtml = '';
    if (liveSelection) {
      var lsName = liveSelection.path.replace(/^.*[\\/]/, '');
      var lsLine = (liveSelection.startLine !== undefined && liveSelection.endLine !== undefined)
        ? '<span class="chip-line">:' + liveSelection.startLine + (liveSelection.endLine !== liveSelection.startLine ? '-' + liveSelection.endLine : '') + '</span>'
        : '';
      // Issue #97: external files (outside any workspace folder) are shown
      // with a dimmer style and a tooltip that exposes the absolute path,
      // signalling that they are visible but NOT auto-included in the prompt.
      var extCls = liveSelection.external ? ' chip-external' : '';
      var extTip = liveSelection.external
        ? ('External (\u5916\u90e8\u6587\u4ef6, \u4e0d\u81ea\u52a8\u9644\u5e26): ' + liveSelection.path)
        : liveSelection.path;
      liveHtml = '<span class="chip chip-live'+extCls+'" title="'+escHtml(extTip)+'">' +
        '<span class="codicon codicon-selection chip-ico"></span>' +
        '<span class="chip-name">' + escHtml(lsName) + '</span>' + lsLine +
        '<button class="chip-x chip-x-live" title="取消选区">×</button></span>';
    }
    var html = attachedFiles.map(function(f, i){
      var name = f.path.replace(/^.*[\\/]/, '');
      var isLoading = f.content === null && !f.imageData;
      var lineLabel = (f.startLine !== undefined && f.endLine !== undefined)
        ? '<span class="chip-line">:' + f.startLine + (f.endLine !== f.startLine ? '-' + f.endLine : '') + '</span>'
        : '';
      if (f.isErr) {
        return '<span class="chip chip-err" data-i="'+i+'" title="'+escHtml(f.errText || '')+'">' +
          '<span class="chip-ico">⚠</span>' +
          '<span class="chip-name">' + escHtml(f.path) + '</span>' +
          '<button class="chip-x" data-i="'+i+'" title="移除">×</button></span>';
      }
      if (f.imageData) {
        return '<span class="chip" data-i="'+i+'" title="'+escHtml(f.path)+'">' +
          '<img class="chip-img" src="'+f.imageData+'" alt=""/>' +
          '<span class="chip-name">' + escHtml(name) + '</span>' + lineLabel +
          '<button class="chip-x" data-i="'+i+'" title="\u79fb\u9664">\u00d7</button></span>';
      }
      var icoHtml = isLoading
        ? '<span class="chip-spin chip-ico">\u29d6</span>'
        : f.isFolder
          ? '<span class="codicon codicon-folder-opened chip-ico"></span>'
          : '<span class="codicon codicon-file-text chip-ico"></span>';
      var trailLabel = f.isFolder ? '<span class="chip-line"> /</span>' : lineLabel;
      return '<span class="chip' + (isLoading ? ' loading' : '') + (f.isFolder ? ' chip-folder' : '') + '" data-i="'+i+'" title="'+escHtml(f.path)+'">' +
        icoHtml +
        '<span class="chip-name">' + escHtml(name) + '</span>' + trailLabel +
        '<button class="chip-x" data-i="'+i+'" title="\u79fb\u9664">\u00d7</button></span>';
    }).join('');
    var combined = liveHtml + html;
    if (!combined) { atChipsEl.innerHTML = ""; atChipsEl.style.display = "none"; }
    else { atChipsEl.style.display = "flex"; atChipsEl.innerHTML = combined; }
    renderSkillNotice();
  }

  function removeChip(i) {
    attachedFiles.splice(i, 1);
    renderChips();
  }

  atChipsEl && atChipsEl.addEventListener("click", function(e){
    var btn = e.target.closest(".chip-x");
    if (!btn) return;
    if (btn.classList.contains("chip-x-live")) {
      if (liveSelection) _liveDismissedKey = liveSelection.path + ':' + liveSelection.startLine + ':' + liveSelection.endLine;
      liveSelection = null; renderChips(); return;
    }
    removeChip(parseInt(btn.getAttribute("data-i"), 10));
  });

  skillNoticeEl && skillNoticeEl.addEventListener("click", function(e){
    var btn = e.target.closest(".skill-notice-x");
    if (!btn) return;
    pendingSkill = null;
    renderChips();
  });

  function requestFileContent(path) {
    vscode.postMessage({ type: "fileContent", path: path });
  }

  // Request file list from extension for @-popup
  var _fileSuggestTimer = null;
  function requestFileSuggest(q) {
    clearTimeout(_fileSuggestTimer);
    _fileSuggestTimer = setTimeout(function(){
      vscode.postMessage({ type: "fileSearch", query: q });
    }, 80);
  }

  // Drag-drop files onto input area
  var composerCard = document.getElementById("composer-card");
  if (composerCard) {
    composerCard.addEventListener("dragover", function(e){ e.preventDefault(); composerCard.classList.add("drag-over"); });
    composerCard.addEventListener("dragleave", function(){ composerCard.classList.remove("drag-over"); });
    composerCard.addEventListener("drop", function(e){
      e.preventDefault();
      composerCard.classList.remove("drag-over");
      var items = e.dataTransfer && e.dataTransfer.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === "string" && items[i].type === "text/plain") {
          items[i].getAsString(function(s){
            // VS Code Explorer drag gives the file path as text
            var p = s.trim().replace(/\\/g, '/');
            if (p && !attachedFiles.some(function(f){ return f.path === p; })) {
              requestFileContent(p);
            }
          });
        }
      }
    });
  }

  function showPop(items, kind, trigStart){
    popItems = items; popSel = 0; popKind = kind; popTrigStart = trigStart;
    if (!items.length){ hidePop(); return; }
    var html = "";
    for (var i = 0; i < items.length; i++){
      html += "<div class=\"popi" + (i === 0 ? " sel" : "") + "\" data-i=\"" + i + "\">" +
        "<span class=\"popn\">" + items[i].name + "</span>" +
        "<span class=\"popd\">" + items[i].desc + "</span></div>";
    }
    pop.innerHTML = html;
    pop.style.display = "block";
    popVisible = true;
  }
  function hidePop(){ if (popVisible){ pop.style.display = "none"; popVisible = false; popItems = []; } popKind = ""; popTrigStart = 0; }
  function movePop(d){
    popSel = (popSel + d + popItems.length) % popItems.length;
    var nodes = pop.querySelectorAll(".popi");
    for (var i = 0; i < nodes.length; i++) nodes[i].classList.toggle("sel", i === popSel);
  }
  function applyPop(){
    if (!popItems[popSel]) return;
    var it = popItems[popSel];
    if (popKind === "slash"){
      if (it.expand === "__CLEAR__"){ hidePop(); inp.value = ""; cbt && cbt.click(); return; }
      // Dynamic skill: stage as chip, let the user keep typing.
      if (it._skill) {
        // Remove the /skillname token from the input box, keep any text before it
        var before = inp.value.slice(0, popTrigStart);
        var after  = inp.value.slice(popTrigStart).replace(/^\S*\s?/, "");
        inp.value  = before + after;
        autosize();
        hidePop();
        pendingSkill = { name: it.name.slice(1), content: it._skillContent || "" };
        renderChips();
        setTimeout(function(){ inp.focus(); inp.setSelectionRange(before.length, before.length); }, 0);
        return;
      }
      // Replace "/xyz..." prefix at popTrigStart with the expansion text
      var before = inp.value.slice(0, popTrigStart);
      // Skip the trigger word (slash + non-space chars)
      var after = inp.value.slice(popTrigStart).replace(/^\S*\s?/, "");
      inp.value = before + it.expand + after;
      // Cursor after expansion text
      var pos = before.length + it.expand.length;
      autosize();
      setTimeout(function(){ inp.focus(); inp.setSelectionRange(pos, pos); }, 0);
    } else if (popKind === "at"){
      // Remove the @-token
      var b2 = inp.value.slice(0, popTrigStart);
      var a2 = inp.value.slice(popTrigStart).replace(/^\S*\s?/, "");
      inp.value = b2 + a2;
      autosize();
      if (it.filePath) {
        // File attach — request content, add chip
        var fp = it.filePath;
        if (!attachedFiles.some(function(f){ return f.path === fp; })) {
          attachedFiles.push({ path: fp, content: null }); // placeholder
          renderChips();
          requestFileContent(fp);
        }
      } else if (it.action === "refEditor") {
        vscode.postMessage({ type: "resolveContextRef", refType: "editor" });
      } else if (it.action === "refSelection") {
        vscode.postMessage({ type: "resolveContextRef", refType: "selection" });
      } else if (it.action === "refTerminal") {
        vscode.postMessage({ type: "resolveContextRef", refType: "terminal" });
      }
      setTimeout(function(){ inp.focus(); inp.setSelectionRange(b2.length, b2.length); }, 0);
    } else if (popKind === "hash"){
      // # context refs. The full token (e.g. "#symbol:Foo") starts at popTrigStart.
      var fullToken = inp.value.slice(popTrigStart).match(/^\S*/);
      fullToken = fullToken ? fullToken[0] : "";
      var bh = inp.value.slice(0, popTrigStart);
      var ah = inp.value.slice(popTrigStart + fullToken.length).replace(/^\s?/, "");
      // File picker branch: if user picked a concrete file suggestion (it.filePath is set)
      if (it.filePath) {
        inp.value = bh + ah; autosize();
        var fph = it.filePath;
        if (!attachedFiles.some(function(f){ return f.path === fph; })) {
          attachedFiles.push({ path: fph, content: null });
          renderChips();
          requestFileContent(fph);
        }
        setTimeout(function(){ inp.focus(); inp.setSelectionRange(bh.length, bh.length); }, 0);
        hidePop();
        return;
      }
      var ref = it.ref;
      // #file → open VS Code native file picker via extension host.
      // Result comes back as a 'filePickerResult' message.
      if (ref === "file") {
        inp.value = bh + ah; // remove the #file token from input
        autosize();
        hidePop();
        vscode.postMessage({ type: 'openFilePicker' });
        return;
      }
      // Refs that need an inline argument: leave the prefix in the input so user can type it
      if (it.needsArg) {
        var prefix = "#" + ref + ":";
        // Preserve whatever the user already typed after the colon, if any
        var existing = fullToken.startsWith(prefix) ? fullToken.slice(prefix.length) : "";
        inp.value = bh + prefix + existing + (ah ? (ah.startsWith(" ") ? ah : " " + ah) : "");
        var pos = bh.length + prefix.length + existing.length;
        autosize();
        setTimeout(function(){ inp.focus(); inp.setSelectionRange(pos, pos); }, 0);
        hidePop();
        return;
      }
      // Argument-less refs: resolve immediately on the extension side.
      inp.value = bh + ah; autosize();
      vscode.postMessage({ type: "resolveContextRef", refType: ref });
      setTimeout(function(){ inp.focus(); inp.setSelectionRange(bh.length, bh.length); }, 0);
    }
    hidePop();
  }
  pop.addEventListener("click", function(e){
    var it = e.target.closest(".popi"); if (!it) return;
    popSel = parseInt(it.getAttribute("data-i"), 10) || 0;
    applyPop();
  });

  function detectTrigger(){
    var v = inp.value;
    var caret = inp.selectionStart || 0;
    // Look backward from caret for nearest whitespace boundary
    var i = caret - 1;
    while (i >= 0 && !/\s/.test(v[i])) i--;
    var start = i + 1;
    var token = v.slice(start, caret);
    if (!token) { hidePop(); return; }
    if (token[0] === "/"){
      var q = token.slice(1).toLowerCase();
      var matches = SLASH_CMDS.filter(function(c){ return c.name.slice(1).startsWith(q); });
      showPop(matches, "slash", start);
    } else if (token[0] === "@"){
      var q2 = token.slice(1).toLowerCase();
      // If query looks like a file path fragment (contains / . or alphanums), do file search
      if (q2.length > 0) {
        requestFileSuggest(q2);
        // Show built-in @cmds while waiting for file results
        var m2 = AT_CMDS.filter(function(c){ return c.name.slice(1).startsWith(q2); });
        showPop(m2, "at", start);
      } else {
        var m3 = AT_CMDS.slice();
        showPop(m3, "at", start);
      }
    } else if (token[0] === "#"){
      // GitHub Copilot–style context-reference picker.
      var rest = token.slice(1);
      // If the user is in the middle of an argumented ref like "#symbol:Foo",
      // do not re-open the picker — they're typing the argument.
      if (rest.indexOf(":") !== -1) { hidePop(); return; }
      var q4 = rest.toLowerCase();
      var matches = HASH_REFS.filter(function(c){
        var n = c.name.slice(1).replace(/:$/, "");
        return n.startsWith(q4);
      });
      // When the user types "#somepath", also fall back to file-suggest
      // (mirrors @ behaviour so "#" can quickly attach files too).
      if (q4.length > 0) requestFileSuggest(q4);
      if (matches.length) {
        showPop(matches, "hash", start);
      } else if (q4.length > 0) {
        // No built-in matches but file search is in flight — preserve kind/start
        // so fileSearchResults can populate the popup when it arrives.
        // Explicitly clear stale items and hide the popup visually to avoid
        // showing stale suggestions that no longer match the current token.
        if (popVisible) { pop.style.display = "none"; popVisible = false; }
        popItems = [];
        popKind = "hash"; popTrigStart = start;
      } else {
        showPop(matches, "hash", start);
      }
    } else { hidePop(); }
  }

  /* ─── History recall state ─── */
  var histStack = [];   /* list of past user prompts in chronological order */
  var histIdx = -1;     /* current cursor in history when navigating */

  var DC_VERBS = [
    'Reasoning…','Synthesizing…','Cogitating…','Deliberating…','Computing…',
    'Inferring…','Distilling…','Modeling…','Weaving…','Decoding…',
    'Manifesting…','Orchestrating…','Ruminating…','Pondering…','Crafting…',
    'Assembling…','Percolating…','Ideating…','Transmuting…','Conjuring…'
  ];

  /* preserveTimerMap: pass true when hiding the spinner due to a session switch.
     Keeps _sessionTimerMap[_busySessionId] and _busySessionId intact so that
     the eventual replyEnd/stopped (which may fire while a different session is
     active) can still delete the correct map entry. */
  function setBusy(on, preserveTimerMap){
    busy = !!on;
    if (!busy) {
      if (!preserveTimerMap) {
        if (_busySessionId !== null) delete _sessionTimerMap[_busySessionId];
        _busySessionId = null;
      }
      _stopping = false; _busyStartTs = 0; _curPhase = ""; _curTool = ""; _verbTick = 0; _stopElapsedTimer();
      if (_dcSpinner && _dcSpinner.parentNode) { _dcSpinner.parentNode.removeChild(_dcSpinner); }
      _dcSpinner = null;
    } else if (!_busyStartTs) {
      _busyStartTs = Date.now();
      _busySessionId = activeSessionId;
      if (_busySessionId) _sessionTimerMap[_busySessionId] = _busyStartTs;
      _startElapsedTimer();
      var _sp = document.createElement("div");
      _sp.className = "dc-spinner";
      _sp.innerHTML =
        "<span class=\"dc-spinner-dot\"></span>" +
        "<span class=\"dc-spinner-text\">" + DC_VERBS[Math.floor(Math.random() * DC_VERBS.length)] + "</span>" +
        "<span class=\"dc-spinner-time\">0s</span>";
      msgs.appendChild(_sp);
      _dcSpinner = _sp;
    }
    sbtn.classList.toggle("stop", busy);
    sbtn.classList.toggle("stopping", _stopping);
    sbtn.textContent = busy ? "\u23F9" : "\u2191";
    sbtn.title = _stopping ? "\u6B63\u5728\u505C\u6B62\u2026" : (busy ? "\u505C\u6B62\u751F\u6210 (Esc)" : "\u53D1\u9001");
    sbtn.disabled = _stopping;
    if (dot) dot.className = "dot" + (busy ? " warn" : "");
    var pb = document.getElementById("prog");
    if (pb) pb.classList.toggle("on", busy);
    _renderStatus();
  }

  /* Issue #58: phase + elapsed indicator */
  var _stopping = false, _busyStartTs = 0, _elapsedTimer = null, _curPhase = "", _curTool = "", _dcSpinner = null, _verbTick = 0, _busySessionId = null;
  /* Per-session timer map: preserves each session's busy start timestamp across switches. */
  var _sessionTimerMap = {};
  var _phaseLabels = {
    thinking: "\u601D\u8003\u4E2D",
    streaming: "\u751F\u6210\u4E2D",
    waiting_first_token: "\u7B49\u5F85\u54CD\u5E94",
    tool_running: "\u5DE5\u5177\u8FD0\u884C",
    compacting: "\u538B\u7F29\u5386\u53F2"
  };
  function _fmtElapsed(ms){
    var s = Math.floor(ms/1000); var m = Math.floor(s/60); s = s%60;
    return (m<10?"0":"")+m+":"+(s<10?"0":"")+s;
  }
  function _renderStatus(){
    if (!_dcSpinner) return;
    _dcSpinner.classList.toggle("stopping", _stopping);
    var textEl = _dcSpinner.querySelector('.dc-spinner-text');
    if (_stopping) { if (textEl) textEl.textContent = 'Stopping…'; return; }
    var timeEl = _dcSpinner.querySelector('.dc-spinner-time');
    if (timeEl && _busyStartTs) {
      var elapsed = Math.floor((Date.now() - _busyStartTs) / 1000);
      var m = Math.floor(elapsed / 60), s = elapsed % 60;
      timeEl.textContent = m > 0 ? m + 'm' + s + 's' : s + 's';
    }
    _verbTick++;
    if (textEl) {
      // Cycle verbs every ~10s: display 8s, fade out at tick 8, swap at tick 0.
      // With a 1Hz tick: mod-10 gives 1s fade-out + 1s fade-in = 2s visible transition.
      var mod = _verbTick % 10;
      if (mod === 8) {
        textEl.classList.add('fade-out');
      } else if (mod === 0) {
        textEl.textContent = DC_VERBS[Math.floor(Math.random() * DC_VERBS.length)];
        textEl.classList.remove('fade-out');
      }
    }
    ascroll();
  }
  function _startElapsedTimer(){
    _stopElapsedTimer();
    _elapsedTimer = setInterval(_renderStatus, 1000);
  }
  function _stopElapsedTimer(){
    if (_elapsedTimer) { clearInterval(_elapsedTimer); _elapsedTimer = null; }
  }
  function showCursor(){ /* disabled: blinking cursor removed for cleaner UI */ }
  function hideCursor(){
    /* Cleanup any leftover cursors from older sessions */
    var olds = msgs.querySelectorAll(".tcur");
    for (var i=0; i<olds.length; i++) olds[i].parentNode && olds[i].parentNode.removeChild(olds[i]);
  }
  function doSend(){
    if (_stopping) return;
    if (busy){ vscode.postMessage({type:"stop"}); return; }
    var t = inp.value.trim();
    if (!t) return;
    // Pre-resolve any inline #<ref>:<arg> tokens (e.g. #symbol:Foo, #fetch:URL)
    // that the user did NOT commit with a trailing space. We strip them from
    // the visible text and forward them via `pendingRefs` so the extension
    // can resolve them BEFORE invoking the agent loop (race-free).
    // Trailing punctuation like `.`, `,`, `)`, `]`, `;`, `:` etc. is almost
    // always sentence punctuation, not part of a symbol/URL, so we trim it
    // from the captured value (mirrors URL auto-linker behavior).
    function _trimRefTrail(s){ return String(s).replace(/[.,;:!?)\]}>]+$/, ''); }
    var _pendingRefs = [];
    t = t.replace(/(^|\s)#(symbol|fetch):(\S+)/g, function(_, lead, ref, val){
      var clean = _trimRefTrail(val);
      if (!clean) return _;
      _pendingRefs.push({ refType: ref, value: clean });
      // Preserve any trailing punctuation as visible text after the ref is dropped.
      var trail = val.slice(clean.length);
      return (lead || "") + trail;
    }).trim();
    // Allow ref-only sends: when the user typed nothing but a #symbol:/#fetch:
    // token, dispatching the ref alone is the obvious intent. Only abort the
    // send when there is neither text nor any pending ref to forward.
    if (!t && !(_pendingRefs && _pendingRefs.length)) return;
    /* Push to history (dedupe consecutive duplicates); skip when text is empty. */
    if (t && (histStack.length === 0 || histStack[histStack.length - 1] !== t)) histStack.push(t);
    if (histStack.length > 50) histStack.shift();
    histIdx = histStack.length;
    hidePop();
    /* User bubble is now echoed by the provider via 'userEcho' so that the
       message survives session switches (replayed from the run's event log). */
    inp.value = ""; autosize();
    var toSend = { type:"send", text:t };
    var _allAtt = [];
    // Only forward the live selection as an attachment when it carries actual
    // selected content. Bare "file-open" chips are visual markers only; the
    // active editor's context is provided by the backend via the standard
    // attachment-block path so we avoid sending an "(empty)" placeholder.
    // Issue #97: external files (outside any workspace folder) are visible
    // via the chip but must NOT auto-leak into the prompt. The user must
    // explicitly attach them via right-click / #file picker if desired.
    if (liveSelection && liveSelection.content && !liveSelection.external) _allAtt.push(liveSelection);
    _allAtt = _allAtt.concat(attachedFiles.filter(function(f){ return !f.isErr && (f.content !== null || !!f.imageData); }));
    if (_allAtt.length) { toSend.attachments = _allAtt; }
    if (_pendingRefs && _pendingRefs.length) { toSend.pendingRefs = _pendingRefs; }
    // Snapshot visible chips so we can render them in the sent message bubble
    var _snapAtt = [];
    if (liveSelection) _snapAtt.push(liveSelection);
    _snapAtt = _snapAtt.concat(attachedFiles.filter(function(f){ return !f.isErr; }));
    _pendingAttachments = _snapAtt.length ? _snapAtt : null;
    if (pendingSkill) {
      // Only send the skill name — provider.js reads the full content from disk.
      toSend.skillName = pendingSkill.name;
      pendingSkill = null;
    }
    _liveDismissedKey = null; liveSelection = null; attachedFiles = []; renderChips();
    vscode.postMessage(toSend);
  }
  function resetChat(){
    var nodes = msgs.querySelectorAll(".msgU,.msgA,.err,.errCard");
    for (var i=0;i<nodes.length;i++) nodes[i].remove();
    if (es) es.style.display = "block";
    sess = { tokens:0, cost:0, cacheHit:0, promptTotal:0 };
    ftTokens.textContent = "0 tokens"; ftCost.textContent = "¥0.0000";
    if (ftCache) { ftCache.textContent = "💾 0%"; ftCache.classList.remove("good"); }
    renderPlan([]);
    curBubble = null; cur = null; curText = ""; curThk = null; toolMap = new Map(); _readTermCardMap = new Map(); _userMsgCount = 0; _editPendingIdx = -1;
  }
  // Detect "#<ref>:<arg>" tokens that have been explicitly committed by the
  // user. We commit when:
  //   • the token is followed by whitespace (space, tab, or newline), AND
  //   • the caret is NOT inside the token (i.e. user moved past it / pasted).
  // Otherwise leave the token alone — `doSend()` still has a fallback that
  // strips uncommitted tokens at send time, so nothing is lost.
  function commitHashRefArgs(){
    var v = inp.value;
    var caret = inp.selectionStart || 0;
    // Match each token plus the single whitespace char that follows.
    var re = /(^|\s)#(symbol|fetch):(\S+?)(\s)/g;
    var m, replaced = false;
    var ranges = []; // {start,end} of segments to drop
    while ((m = re.exec(v)) !== null) {
      var tokStart = m.index + (m[1] ? m[1].length : 0);
      var tokEnd   = m.index + m[0].length; // includes the trailing terminator
      // Skip if the caret is still inside this token — the user is typing.
      if (caret > tokStart && caret <= tokEnd) continue;
      // Strip trailing sentence punctuation from the captured value so
      // `#fetch:https://example.com.` doesn't send a URL ending in a dot.
      var rawVal = m[3];
      var cleanVal = rawVal.replace(/[.,;:!?)\]}>]+$/, '');
      if (!cleanVal) continue;
      vscode.postMessage({ type: "resolveContextRef", refType: m[2], value: cleanVal });
      ranges.push({ start: tokStart, end: tokEnd, lead: m[1] || "", keepTrail: rawVal.slice(cleanVal.length) });
      replaced = true;
    }
    if (replaced) {
      // Apply removals from the end so earlier offsets stay valid.
      var out = v;
      for (var i = ranges.length - 1; i >= 0; i--) {
        var r = ranges[i];
        // Keep the leading whitespace + any trailing punctuation we stripped
        // from the value, drop the ref token itself.
        out = out.slice(0, r.start) + (r.keepTrail || "") + out.slice(r.end);
      }
      inp.value = out;
      var newPos = Math.min(out.length, caret);
      try { inp.setSelectionRange(newPos, newPos); } catch (_e) {}
      autosize();
    }
  }
  inp.addEventListener("input", function(){ autosize(); detectTrigger(); commitHashRefArgs(); });
  inp.addEventListener("blur", function(){ setTimeout(hidePop, 150); });
  inp.addEventListener("keydown", function(e){
    /* ── #7 Phase 5: popover navigation ── */
    if (popVisible){
      if (e.key === "ArrowDown"){ e.preventDefault(); movePop(1); return; }
      if (e.key === "ArrowUp")  { e.preventDefault(); movePop(-1); return; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.isComposing)){
        e.preventDefault(); applyPop(); return;
      }
      if (e.key === "Escape"){ e.preventDefault(); hidePop(); return; }
    }
    /* ── History recall when input is empty ── */
    if (!popVisible && (e.key === "ArrowUp" || e.key === "ArrowDown") && inp.value === ""){
      if (histStack.length === 0) return;
      e.preventDefault();
      if (e.key === "ArrowUp"){
        histIdx = histIdx <= 0 ? histStack.length - 1 : histIdx - 1;
      } else {
        histIdx = histIdx >= histStack.length - 1 ? 0 : histIdx + 1;
      }
      inp.value = histStack[histIdx];
      autosize();
      // Move cursor to end on next tick
      setTimeout(function(){ inp.setSelectionRange(inp.value.length, inp.value.length); }, 0);
      return;
    }
    /* ── Ctrl/Cmd+K → clear chat ── */
    if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")){
      e.preventDefault();
      cbt && cbt.click();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing){ e.preventDefault(); doSend(); }
    else if (e.key === "Escape" && busy){ e.preventDefault(); _stopping = true; if (_dcSpinner) _dcSpinner.classList.add("stopping"); vscode.postMessage({type:"stop"}); }
  });
  sbtn.addEventListener("click", doSend);
  modelBtn && modelBtn.addEventListener("click", function(e){
    e.stopPropagation();
    _modelOpen ? closeModelDrop() : openModelDrop();
  });
  modelDrop && modelDrop.addEventListener("click", function(e){
    var opt = e.target.closest(".mo"); if (!opt) return;
    var model = opt.dataset.model;
    setModelUI(model);
    vscode.postMessage({type:"setModel", model: model});
    closeModelDrop();
  });
  iModeBtn && iModeBtn.addEventListener("click", function(e){
    e.stopPropagation();
    var next = _curIMode === "agent" ? "plan" : "agent";
    setIModeUI(next);
    vscode.postMessage({type:"setInteractionMode", mode: next});
  });
  modeBtn && modeBtn.addEventListener("click", function(e){
    e.stopPropagation();
    _modeOpen ? closeModeDrop() : openModeDrop();
  });
  modeDrop && modeDrop.addEventListener("click", function(e){
    var opt = e.target.closest(".mo"); if (!opt) return;
    var mode = opt.dataset.mode;
    setModeUI(mode);
    vscode.postMessage({type:"setMode", mode: mode});
    closeModeDrop();
  });
  document.addEventListener("click", function(e){
    if (modelPicker && !modelPicker.contains(e.target)) closeModelDrop();
    if (modePicker && !modePicker.contains(e.target)) closeModeDrop();
  });
  /* ── Settings Modal state ── */
  var _stgOpen = false;
  var _stgDsKeySet = false, _stgTvKeySet = false;
  var _stgOrigBaseUrl = '';
  var _stgOrigProvider = 'deepseek';
  var _stgTestTimers = {};

  var stgOverlay   = document.getElementById('settings-overlay');
  var stgProvider  = document.getElementById('s-provider');
  var stgDsKey     = document.getElementById('s-ds-key');
  var stgDsEye     = document.getElementById('s-ds-key-eye');
  var stgDsTest    = document.getElementById('s-ds-test');
  var stgDsResult  = document.getElementById('s-ds-result');
  var stgDsLink    = document.getElementById('s-ds-link');
  var stgBaseUrl   = document.getElementById('s-base-url');
  var stgBaseReset = document.getElementById('s-base-url-reset');
  var stgWsProvider = document.getElementById('s-ws-provider');
  var stgTvSection  = document.getElementById('s-tv-section');
  var stgTvKey     = document.getElementById('s-tv-key');
  var stgTvEye     = document.getElementById('s-tv-key-eye');
  var stgTvTest    = document.getElementById('s-tv-test');
  var stgTvResult  = document.getElementById('s-tv-result');
  var stgTvLink    = document.getElementById('s-tv-link');
  var stgDirtyBar  = document.getElementById('s-dirty-bar');
  var stgDiscard   = document.getElementById('s-discard');
  var stgCancelBtn = document.getElementById('settingsCancelBtn');
  var stgSaveBtn   = document.getElementById('settingsSaveBtn');
  var stgCloseBtn  = document.getElementById('settingsCloseBtn');

  function _stgIsDirty(){
    return (stgDsKey && stgDsKey.value !== '') ||
           (stgTvKey && stgTvKey.value !== '') ||
           (stgBaseUrl && stgBaseUrl.value !== _stgOrigBaseUrl) ||
           (stgProvider && stgProvider.value !== _stgOrigProvider);
  }
  function _stgUpdateDirtyBar(){
    if (stgDirtyBar) stgDirtyBar.style.display = _stgIsDirty() ? 'flex' : 'none';
  }
  function _stgSetResult(el, timer, state, text){
    if (!el) return;
    clearTimeout(_stgTestTimers[timer]);
    el.className = 'settings-test-result ' + (state || '');
    el.textContent = text || '';
    if (state === 'ok' || state === 'err'){
      _stgTestTimers[timer] = setTimeout(function(){
        el.style.opacity = '0';
        setTimeout(function(){ el.textContent = ''; el.style.opacity = ''; el.className = 'settings-test-result'; }, 400);
      }, 5000);
    }
  }
  function _stgUpdateWsProvider(){
    var v = stgWsProvider ? stgWsProvider.value : 'tavily';
    if (stgTvSection) stgTvSection.style.display = v === 'tavily' ? '' : 'none';
  }
  if (stgWsProvider) stgWsProvider.addEventListener('change', _stgUpdateWsProvider);

  function openSettingsModal(){
    if (_stgOpen) return;
    _stgOpen = true;
    if (stgOverlay) stgOverlay.style.display = 'flex';
    if (stgDsKey) stgDsKey.value = '';
    if (stgTvKey) stgTvKey.value = '';
    if (stgBaseUrl) stgBaseUrl.value = '';
    _stgOrigBaseUrl = '';
    _stgOrigProvider = 'deepseek';
    _stgDsKeySet = false; _stgTvKeySet = false;
    if (stgDirtyBar) stgDirtyBar.style.display = 'none';
    _stgSetResult(stgDsResult, 'ds', '', '');
    _stgSetResult(stgTvResult, 'tv', '', '');
    vscode.postMessage({ type: 'openApiSettings' });
    setTimeout(function(){ if (stgDsKey) stgDsKey.focus(); }, 80);
    document.addEventListener('keydown', _stgEscHandler);
  }
  function closeSettingsModal(force){
    if (!_stgOpen) return;
    if (!force && _stgIsDirty()){
      if (stgDirtyBar) stgDirtyBar.style.display = 'flex';
      return;
    }
    _stgOpen = false;
    if (stgOverlay) stgOverlay.style.display = 'none';
    document.removeEventListener('keydown', _stgEscHandler);
  }
  function _stgEscHandler(e){
    if (e.key === 'Escape') { e.preventDefault(); closeSettingsModal(false); }
  }

  stgOverlay && stgOverlay.addEventListener('click', function(e){
    if (e.target === stgOverlay) closeSettingsModal(false);
  });
  stgCloseBtn  && stgCloseBtn.addEventListener('click',  function(){ closeSettingsModal(false); });
  stgCancelBtn && stgCancelBtn.addEventListener('click', function(){ closeSettingsModal(true); });
  stgDiscard   && stgDiscard.addEventListener('click',   function(){
    if (stgDsKey) stgDsKey.value = '';
    if (stgTvKey) stgTvKey.value = '';
    if (stgBaseUrl) stgBaseUrl.value = _stgOrigBaseUrl;
    if (stgProvider) stgProvider.value = _stgOrigProvider;
    closeSettingsModal(true);
  });
  stgDsKey  && stgDsKey.addEventListener('input',  _stgUpdateDirtyBar);
  stgTvKey  && stgTvKey.addEventListener('input',  _stgUpdateDirtyBar);
  stgBaseUrl && stgBaseUrl.addEventListener('input', _stgUpdateDirtyBar);
  stgProvider && stgProvider.addEventListener('change', function(){
    var p = stgProvider.value;
    var defaultUrl = PROVIDER_URLS[p] || '';
    if (stgBaseUrl) stgBaseUrl.value = defaultUrl;
    var link = PROVIDER_KEY_LINKS[p];
    if (stgDsLink) {
      if (link) {
        stgDsLink.style.display = '';
        stgDsLink.textContent = '\u2197 ' + link.replace(/^https?:\/\//, '');
      } else {
        stgDsLink.style.display = 'none';
      }
    }
    _stgUpdateDirtyBar();
  });
  stgDsEye && stgDsEye.addEventListener('click', function(){
    if (!stgDsKey) return;
    stgDsKey.type = stgDsKey.type === 'password' ? 'text' : 'password';
  });
  stgTvEye && stgTvEye.addEventListener('click', function(){
    if (!stgTvKey) return;
    stgTvKey.type = stgTvKey.type === 'password' ? 'text' : 'password';
  });
  stgBaseReset && stgBaseReset.addEventListener('click', function(){
    if (stgBaseUrl) {
      var p = stgProvider ? stgProvider.value : 'deepseek';
      stgBaseUrl.value = PROVIDER_URLS[p] || 'https://api.deepseek.com';
      _stgUpdateDirtyBar();
    }
  });
  stgDsLink && stgDsLink.addEventListener('click', function(e){
    e.preventDefault();
    var p = stgProvider ? stgProvider.value : 'deepseek';
    var url = PROVIDER_KEY_LINKS[p] || 'https://platform.deepseek.com/api_keys';
    vscode.postMessage({ type: 'openExternal', url: url });
  });
  stgTvLink && stgTvLink.addEventListener('click', function(e){
    e.preventDefault();
    vscode.postMessage({ type: 'openExternal', url: 'https://app.tavily.com' });
  });
  stgDsTest && stgDsTest.addEventListener('click', function(){
    var key = stgDsKey ? stgDsKey.value.trim() : '';
    var url = stgBaseUrl ? stgBaseUrl.value.trim() : '';
    var provider = stgProvider ? stgProvider.value : 'deepseek';
    _stgSetResult(stgDsResult, 'ds', 'pending', '⟳ Testing...');
    if (stgDsTest) stgDsTest.disabled = true;
    vscode.postMessage({ type: 'testApiKey', which: 'ds', key: key || null, baseUrl: url || null, provider: provider });
  });
  stgTvTest && stgTvTest.addEventListener('click', function(){
    var key = stgTvKey ? stgTvKey.value.trim() : '';
    _stgSetResult(stgTvResult, 'tv', 'pending', '⟳ Testing...');
    if (stgTvTest) stgTvTest.disabled = true;
    vscode.postMessage({ type: 'testApiKey', which: 'tv', key: key || null });
  });
  stgSaveBtn && stgSaveBtn.addEventListener('click', function(){
    var dsKey      = stgDsKey     ? stgDsKey.value.trim()     : null;
    var tvKey      = stgTvKey     ? stgTvKey.value.trim()     : null;
    var baseUrl    = stgBaseUrl   ? stgBaseUrl.value.trim()   : null;
    var provider   = stgProvider  ? stgProvider.value         : 'deepseek';
    var wsProvider = stgWsProvider ? stgWsProvider.value : 'tavily';
    vscode.postMessage({
      type: 'saveApiSettings',
      dsKey:          dsKey   || null,
      tvKey:          tvKey   || null,
      baseUrl:        baseUrl !== null ? baseUrl : _stgOrigBaseUrl,
      provider:       provider,
      webSearchProvider: wsProvider,
      model:          getSelectedModel(),
    });
    switchToProvider(provider);
    closeSettingsModal(true);
  });

  apibt.addEventListener("click", function(){ openSettingsModal(); });
  cbt.addEventListener("click", function(){
    resetChat();
    vscode.postMessage({type:"clear"});
  });

  /* ─── Message handler ──────────────────────────────────────────────── */
  window.addEventListener("message", function(e){
    var m = e.data;
    if (m.type === "settingsLoaded"){
      _stgDsKeySet = !!m.dsKeySet;
      _stgTvKeySet = !!m.tvKeySet;
      _stgOrigBaseUrl = m.baseUrl || '';
      _stgOrigProvider = m.provider || 'deepseek';
      if (stgDsKey) { stgDsKey.value = ''; stgDsKey.placeholder = _stgDsKeySet ? (m.dsKeyHint || '(configured)') : 'sk-...'; }
      if (stgTvKey) { stgTvKey.value = ''; stgTvKey.placeholder = _stgTvKeySet ? (m.tvKeyHint || '(configured)') : 'tvly-...'; }
      if (stgBaseUrl) stgBaseUrl.value = _stgOrigBaseUrl;
      if (stgWsProvider) {
        stgWsProvider.value = m.webSearchProvider || 'tavily';
        _stgUpdateWsProvider();
      }
      if (stgProvider) {
        stgProvider.value = _stgOrigProvider;
        // Update the key link for the current provider
        var keyLink = PROVIDER_KEY_LINKS[_stgOrigProvider];
        if (stgDsLink) {
          if (keyLink) {
            stgDsLink.style.display = '';
            stgDsLink.textContent = '\u2197 ' + keyLink.replace(/^https?:\/\//, '');
          } else {
            stgDsLink.style.display = 'none';
          }
        }
      }
    } else if (m.type === "testApiKeyResult"){
      var which = m.which;
      var el = which === 'ds' ? stgDsResult : stgTvResult;
      var btn = which === 'ds' ? stgDsTest : stgTvTest;
      if (btn) btn.disabled = false;
      if (m.ok){
        _stgSetResult(el, which, 'ok', '\u2713 Connected \xb7 ' + (m.latency || 0) + 'ms');
      } else {
        _stgSetResult(el, which, 'err', '\u2717 ' + (m.error || 'Failed'));
      }
    } else if (m.type === "thinking"){
      thk.style.display = m.show ? "block" : "none";
    } else if (m.type === "userEcho"){
      add("user", m.text || "");
      if (_pendingAttachments && _pendingAttachments.length) {
        var _allU = msgs.querySelectorAll(".msgU");
        var _lastU = _allU[_allU.length - 1];
        if (_lastU) {
          var _atDiv = document.createElement("div");
          _atDiv.className = "msgU-attachments";
          _atDiv.innerHTML = _pendingAttachments.map(function(f) {
            var _n = f.path.replace(/^.*[\\/]/, '');
            var _ll = (f.startLine !== undefined && f.endLine !== undefined)
              ? ':' + f.startLine + (f.endLine !== f.startLine ? '-' + f.endLine : '') : '';
            return '<span class="chip chip-sent" title="' + escHtml(f.path) + '">' +
              (f.imageData ? '\ud83d\uddbc\ufe0f' : '\ud83d\udcc4') + ' ' + escHtml(_n) + _ll + '</span>';
          }).join('');
          _lastU.appendChild(_atDiv);
        }
        _pendingAttachments = null;
      }
    } else if (m.type === "editFillInput"){
      // Backend truncated history; remove all DOM nodes from the edited msg onward
      var editIdx = _editPendingIdx;
      _editPendingIdx = -1;
      if (editIdx >= 0){
        var allMsgU = msgs.querySelectorAll(".msgU");
        for (var ei = 0; ei < allMsgU.length; ei++){
          if (Number(allMsgU[ei].dataset.msgIdx) >= editIdx){
            // remove this and all subsequent message nodes
            var toRemove = [];
            var nd = allMsgU[ei];
            while (nd){
              var nx = nd.nextSibling;
              if (nd !== thk && nd !== jumpBtn) toRemove.push(nd);
              nd = nx;
            }
            toRemove.forEach(function(n){ if (n.parentNode === msgs) msgs.removeChild(n); });
            _userMsgCount = editIdx;
            break;
          }
        }
      }
      inp.value = m.text || ""; autosize(); inp.focus();
      if (es && msgs.querySelectorAll(".msgU,.msgA").length === 0) es.style.display = "block";
    } else if (m.type === "replyStart"){
      curBubble = null; cur = null; curThk = null; curThkHead = null; curText = ""; toolMap = new Map();
      ensureBubble(); ascroll();
      setBusy(true); showCursor();
    } else if (m.type === "newTurn"){
      /* Same bubble for the entire user→assistant turn (GH Copilot style).
         Seal any active thinking chip first, then reset text state so the
         next replyDelta starts a fresh segment after any tool cards. */
      if (curThkHead && !curThkHead.dataset.done) {
        curThkHead.dataset.done = "1";
        /* hide the entire thinking block — disappears once turn completes */
        var slot_nt = curThkHead.parentNode;
        if (slot_nt) slot_nt.style.display = "none";
      }
      curThk = null; curThkHead = null;
      if (cur && cur.classList && cur.classList.contains("seg")) { flushRender(); cur.setAttribute("data-raw", curText || ""); }
      cur = null; curText = "";
      showCursor();
    } else if (m.type === "replyDelta"){
      ensureTextSegment();
      curText += (m.text || "");
      scheduleRender();
      var th2 = curThkHead;
      if (th2 && !th2.dataset.done) {
        th2.dataset.done = "1";
        /* hide the entire thinking block once real reply begins */
        var slot2 = th2.parentNode;
        if (slot2) slot2.style.display = "none";
      }
      showCursor();
      ascroll();
    } else if (m.type === "thinkingDelta"){
      ensureBubble();
      if (curThk === null) {
        /* After a newTurn the previous thinking was sealed; create a new
           inline chip in .flow for this iteration's reasoning. */
        makeThinkChip();
      }
      var th = curThkHead;
      if (th && th.style.display === "none") {
        th.style.display = "inline-block";
        th.dataset.start = th.dataset.start || String(Date.now());
        /* default-collapsed — user can click to expand */
      }
      if (curThk) curThk.textContent += (m.text || "");
      /* keep view pinned to the latest reasoning text */
      if (curThk) curThk.scrollTop = curThk.scrollHeight;
      ascroll();
    } else if (m.type === "toolStart"){
      /* Shell, web-search and sub-agent calls get an expandable card so the
         user can click to see the full output. Everything else stays as a
         lightweight prose line (GH Copilot convention). */
      var _cardTools = { read_terminal:1 };
      if (_cardTools[m.name]) {
        if (m.name === 'read_terminal') {
          /* Reuse the existing card for the same terminal to prevent card flooding
             during background-job polling loops (e.g. run_shell_bg + read_terminal). */
          var _rtA; try { _rtA = JSON.parse(m.args || '{}'); } catch(e) { _rtA = {}; }
          var _rtKey = String(_rtA.terminal || '_active_');
          var _prev = _readTermCardMap.get(_rtKey);
          if (_prev && _prev.root && _prev.root.parentNode) {
            /* Reset card to running state in-place */
            _prev.root.classList.remove('ok', 'err');
            _prev.root.classList.add('run');
            if (_prev.status) _prev.status.textContent = '\u2026';
            if (_prev.body) _prev.body.textContent = '';
            _prev._startedAt = Date.now();
            _prev._userToggled = false;
            _prev.args = m.args;
            /* Break current text segment — same effect as addToolCard */
            if (cur && cur.classList && cur.classList.contains("seg")) cur.setAttribute("data-raw", curText || "");
            cur = null; curText = "";
            toolMap.set(m.id, _prev);
            ascroll();
          } else {
            addToolCard(m.id, m.name, m.args);
            var _rtRec = toolMap.get(m.id);
            if (_rtRec) { _rtRec._rtKey = _rtKey; _readTermCardMap.set(_rtKey, _rtRec); }
          }
        } else {
          addToolCard(m.id, m.name, m.args);
        }
      } else {
        /* Issue #162 Phase 0: reuse the existing placeholder created by an
           early toolArgsDelta (when the LLM streams `content` before `path`).
           Without this, toolStart would insert a SECOND .tl-wrap and overwrite
           toolMap[id] — orphaning the first row's _streamPre (stuck "streaming…"
           forever) and producing a fileless "Edited" ghost line. */
        var _existLine = toolMap.get(m.id);
        if (_existLine && _existLine.isLine && _existLine.root) {
          _existLine.name = m.name;
          _existLine.args = m.args;
          var _meta162 = toolMeta(m.name, m.args);
          var _cls162 = (_existLine.root.className || "").split(/\s+/)
            .filter(function(c){ return c && !/^k-/.test(c); });
          _cls162.push("k-" + _meta162.kind);
          _existLine.root.className = _cls162.join(" ");
          var _ico162 = _existLine.root.querySelector(".ico");
          if (_ico162) _ico162.className = "ico codicon " + _meta162.icon;
          var _prose162 = _existLine.root.querySelector(".tl-prose");
          if (_prose162) _prose162.innerHTML = toolProseHtml(m.name, m.args, _meta162);
        } else {
          addToolLine(m.id, m.name, m.args);
        }
      }
    } else if (m.type === "approvalRequest"){
      addToolCard(m.id, m.name, m.args, { approval:true });
    } else if (m.type === "autoApproval"){
      ensureBubble();
      var holder = curBubble.querySelector(".flow");
      var d = document.createElement("div");
      var meta2 = toolMeta(m.name, m.args);
      d.className = "tool k-" + meta2.kind + " " + (m.decision ? "ok" : "err");
      var tgt2 = toolTarget(m.name, m.args);
      var label = m.decision ? ("auto-allow · " + m.mode) : ("auto-deny · " + m.mode);
      d.innerHTML = "<div class=\"h\"><span class=\"chev\">▶</span><i class=\"ico codicon " + escHtml(meta2.icon) + "\"></i><span class=\"nm\">" + escHtml(meta2.verb) + "</span><span class=\"tgt\">" + escHtml(tgt2) + "</span><span class=\"st\">" + escHtml(label) + "</span></div>" +
        "<div class=\"b\"><div class=\"args\">" + escHtml(shortArgs(m.args)) + "</div></div>";
      holder.appendChild(d);
      if (cur && cur.classList && cur.classList.contains("seg")) { flushRender(); cur.setAttribute("data-raw", curText || ""); }
      cur = null; curText = "";
      d.querySelector(".h").addEventListener("click", function(){ d.classList.toggle("open"); });
    } else if (m.type === "toolArgsDelta"){
      var tcs = toolMap.get(m.id);
      if (!tcs){ addToolLine(m.id, m.name || "write_file", "{}"); tcs = toolMap.get(m.id); }
      var pre = tcs._streamPre;
      if (!pre){
        pre = document.createElement("pre");
        pre.className = "tl-stream";
        var codeEl = document.createElement("code");
        pre.appendChild(codeEl);
        /* Insert after the tool line so the live preview sits below the prose */
        var parent = tcs.root.parentNode;
        if (parent) parent.insertBefore(pre, tcs.root.nextSibling);
        tcs._streamPre = pre;
        tcs._streamCode = codeEl;
        tcs._streamBuf = "";
        tcs._streamPending = false;
      }
      tcs._streamBuf += (m.contentDelta || "");
      if (!tcs._streamPending){
        tcs._streamPending = true;
        var doStream = function(){
          tcs._streamPending = false;
          if (!tcs._streamCode) return;
          /* Limit displayed code to last 8000 chars to keep DOM cheap */
          var s = tcs._streamBuf;
          if (s.length > 8000) s = "…\n" + s.slice(-8000);
          tcs._streamCode.textContent = s;
          if (pre) pre.scrollTop = pre.scrollHeight;
        };
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(doStream);
        else setTimeout(doStream, 16);
      }
      ascroll();
    } else if (m.type === "toolArgsFinal"){
      var tcF = toolMap.get(m.id);
      if (tcF) tcF.args = m.args || tcF.args;
    } else if (m.type === "toolStreamDelta"){
      /* Live stdout/stderr chunks from a running tool (currently run_shell).
         Append to the card body as a <pre> so the user sees a tail-like
         preview while the command runs.  Throttled via requestAnimationFrame. */
      var tcSd = toolMap.get(m.id);
      if (!tcSd || !tcSd.body) return;
      tcSd._liveBuf = (tcSd._liveBuf || "") + (m.delta || "");
      /* Ensure a <pre class="live"> exists inside the body */
      var livePre = tcSd._livePre;
      if (!livePre){
        livePre = document.createElement("pre");
        livePre.className = "live-out";
        tcSd.body.appendChild(livePre);
        tcSd._livePre = livePre;
        /* Prose lines: auto-expand detail pane at stream start */
        if (tcSd.isLine) {
          tcSd.root.classList.add("has-detail", "open");
          tcSd.body.style.display = "block";
        }
      }
      if (!tcSd._livePending){
        tcSd._livePending = true;
        var doLive = function(){
          tcSd._livePending = false;
          if (!tcSd._livePre) return;
          /* Keep DOM cheap: show only the last 6000 chars */
          var s = tcSd._liveBuf;
          if (s.length > 6000) s = "…\n" + s.slice(-6000);
          tcSd._livePre.textContent = stripAnsi(s);
          /* Auto-scroll body to bottom */
          if (tcSd.body) tcSd.body.scrollTop = tcSd.body.scrollHeight;
        };
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(doLive);
        else setTimeout(doLive, 16);
      }
    } else if (m.type === "toolResult"){
      var tc = toolMap.get(m.id);
      if (!tc){ addToolLine(m.id, m.name || "tool", "{}"); tc = toolMap.get(m.id); }
      tc.root.classList.remove("run");
      tc.root.classList.add(m.ok ? "ok" : "err");
      if (tc._streamPre){
        tc._streamPre.classList.add("done");
        if (!m.ok) tc._streamPre.classList.add("err");
      }
      var out = String(m.output || "");
      var lines = out ? out.split(/\r?\n/).length : 0;
      var bytes = out.length;
      var resTxt;
      if (m.ok && (m.name === "write_file" || tc.name === "write_file")){
        try {
          var wargs = JSON.parse(tc.args || "{}");
          var wContent = String(wargs.content || wargs.text || "");
          var wLines = wContent ? wContent.split(/\r?\n/).length : 0;
          resTxt = wLines ? "+" + wLines + " lines" : "ok";
        } catch(e){ resTxt = "ok"; }
      } else if (m.ok && (m.name === "spawn_agent" || tc.name === "spawn_agent")){
        /* Sub-agent result is Markdown — render it, show iter/tool counts from metadata header */
        var itersMatch = out.match(/\((\d+) tool calls[^)]*\)/);
        resTxt = itersMatch ? itersMatch[0] : "done";
      } else if ((m.name === "run_shell" || tc.name === "run_shell")) {
        /* Shell: build a GH-Copilot-style summary "exit N · L lines · Ts".
           shell.js may return a structured JSON object; extract displayable text
           and the numeric exitCode from it so the card shows the correct status. */
        var elapsed = tc._startedAt ? ((Date.now() - tc._startedAt) / 1000) : 0;
        var elapsedStr = elapsed >= 10 ? elapsed.toFixed(0) + "s"
                       : elapsed >=  1 ? elapsed.toFixed(1) + "s"
                       :                 Math.max(1, Math.round(elapsed * 1000)) + "ms";
        /* Resolve display text: unwrap JSON text field when present */
        var shellDisplayOut = getShellText(out);
        var shellLines = shellDisplayOut ? shellDisplayOut.split(/\r?\n/).length : 0;
        var shellBytes = shellDisplayOut.length;
        /* Prefer the exitCode field forwarded by tool-executor; fall back to text parsing */
        var shellExitCode = (m.exitCode !== undefined) ? m.exitCode : null;
        if (m.ok){
          var exitLabel = shellExitCode !== null ? "exit " + shellExitCode : "exit 0";
          resTxt = exitLabel + " · " + (shellLines > 1 ? shellLines + " lines · " : (shellBytes ? shellBytes + "B · " : "")) + elapsedStr;
        } else {
          var exitTag;
          if (shellExitCode !== null) {
            exitTag = "exit " + shellExitCode;
          } else {
            var em = out.match(/^Exit (\S+):/) || shellDisplayOut.match(/^Exit (\S+):/);
            exitTag = em ? ("exit " + em[1]) : "failed";
          }
          resTxt = exitTag + " · " + elapsedStr;
        }
      } else {
        resTxt = m.ok ? (lines>1 ? lines + " lines" : (bytes ? bytes + "B" : "ok")) : "failed";
      }
      tc.status.textContent = resTxt;
      if (tc.body && out) {
        if (tc.isLine) {
          /* Prose line: run_shell/web_search/spawn_agent now use prose rows.
             Mirror per-tool card logic, using tc.body as the expandable detail pane. */
          if (tc.name === "run_shell" || m.name === "run_shell") {
            if (tc._livePre){ tc._livePre.remove(); tc._livePre = null; }
            var runShellBody = getShellText(out);
            var outPre = document.createElement("pre");
            outPre.className = "final-out";
            outPre.textContent = stripAnsi(runShellBody);
            tc.body.innerHTML = ""; tc.body.appendChild(outPre);
            tc.root.classList.add("has-detail");
            if (!tc._userToggled){
              /* Always collapse on completion (success or failure). */
              tc.root.classList.remove("open"); tc.body.style.display = "none";
            }
          } else if (tc.name === "spawn_agent" || m.name === "spawn_agent") {
            tc.body.innerHTML = renderMd(out);
            tc.root.classList.add("has-detail", "open");
            tc.body.style.display = "block";
          } else {
            tc.body.textContent = out;
            tc.root.classList.add("has-detail");
            if (!tc._userToggled){
              /* Always collapse on completion (success or failure). */
              tc.root.classList.remove("open"); tc.body.style.display = "none";
            }
          }
        } else if (tc.name === "spawn_agent" || m.name === "spawn_agent") {
          /* spawn_agent returns Markdown — render it inside the card body */
          tc.body.innerHTML = renderMd(out);
          if (!tc._userToggled) tc.root.classList.add("open");
        } else if (tc.name === "run_shell" || m.name === "run_shell") {
          /* Replace the streaming live tail with the final, complete output.
             Behaviour: always auto-collapse on completion (success or failure)
             — the header summary plus the row-level status dot is enough; users
             expand manually when they need to read full output. Respect any
             prior manual user toggle.
             When shell.js returns a structured JSON object, show the human-readable
             `text` field rather than raw JSON. */
          if (tc._livePre){ tc._livePre.remove(); tc._livePre = null; }
          var runShellBody = getShellText(out);
          var outPre = document.createElement("pre");
          outPre.className = "final-out";
          outPre.textContent = stripAnsi(runShellBody);
          tc.body.appendChild(outPre);
          if (!tc._userToggled){
            /* Always collapse on completion (success or failure). */
            tc.root.classList.remove("open");
          }
        } else if (tc.name === "read_terminal" || m.name === "read_terminal") {
          /* Terminal poll: strip ANSI/progress-bar noise; always collapse on
             completion (success or failure) — matches the unified UX with
             run_shell / web_search above. */
          tc.body.textContent = stripAnsi(out);
          if (!tc._userToggled){
            /* Always collapse on completion (success or failure). */
            tc.root.classList.remove("open");
          }
          /* Refresh dedup map so the next poll can find this card */
          if (tc._rtKey) _readTermCardMap.set(tc._rtKey, tc);
        } else if (tc.name === "web_search" || m.name === "web_search") {
          /* web_search: same rule as shell — always collapse on completion (success or failure). */
          tc.body.textContent = out;
          if (!tc._userToggled){
            /* Always collapse on completion (success or failure). */
            tc.root.classList.remove("open");
          }
        } else {
          tc.body.textContent = out;
          if (!tc._userToggled) tc.root.classList.remove("open");
        }
      }
      /* Issue #162 Phase 2: relocate the live stream preview (`.tl-stream`) into
         the detail pane on completion. Without this the preview stays inline
         under the row forever, and visually nothing distinguishes a finished
         write_file from an in-flight one. After the move the row collapses to a
         single tidy line (matching read_file UX) and the user can click to
         re-expand the patched content. */
      if (tc.isLine && tc._streamPre && tc.body && tc.root) {
        if (tc._streamPre.parentNode !== tc.body) {
          tc.body.appendChild(tc._streamPre);
        }
        tc.root.classList.add("has-detail");
        if (!tc._userToggled) {
          tc.root.classList.remove("open");
          tc.body.style.display = "none";
        }
      }
      liveGroupCompleted();
      ascroll();
    } else if (m.type === "plan"){
      renderPlan(m.steps || [], m.todos || []);
    } else if (m.type === "pendingEdits"){
      renderPendingEdits(m.items || []);
    } else if (m.type === "usage"){
      bumpUsage(m.usage || {});
    } else if (m.type === "ctxUsage"){
      // Issue #142 P3-3: footer ring (replaces old top bar).
      try { updateCtxRing(m.pct, m.tokens, m.window); } catch (_e) {}
    } else if (m.type === "progress"){
      if (m.phase) _curPhase = m.phase;
      _curTool = m.activeTool || "";
      _renderStatus();
    } else if (m.type === "stopping"){
      _stopping = true;
      setBusy(true);
    } else if (m.type === "stopped"){
      _stopping = false;
      setBusy(false);
    } else if (m.type === "replyEnd"){
      hideCursor();
      setBusy(false);
      flushRender();
      if (curBubble) {
        /* Aggregate raw text from all flow segments for copy / regenerate. */
        var segs = curBubble.querySelectorAll(".flow .msgC.seg");
        var rawAll = "";
        for (var si=0; si<segs.length; si++){
          var raw = segs[si].getAttribute("data-raw");
          rawAll += (raw != null ? raw : (segs[si].textContent || ""));
          if (si < segs.length-1) rawAll += "\n";
        }
        if (cur && cur.classList && cur.classList.contains("seg")){
          flushRender();
          cur.setAttribute("data-raw", curText || "");
        }
        if (m.empty && !rawAll.trim() && !curBubble.querySelector(".tool")){
          ensureTextSegment(); cur.textContent = "(no response)";
        }
        curBubble.setAttribute("data-raw", rawAll);
        /* Strip any stale action bars from previous turn bubbles, attach only to last */
        var prev = msgs.querySelectorAll(".msgA .msgActs");
        for (var pi=0; pi<prev.length; pi++) prev[pi].parentNode.removeChild(prev[pi]);
        curBubble.insertAdjacentHTML("beforeend", actionBarHtml());
        /* Group all contiguous tool runs (mid-turn and trailing). */
        groupAllToolRuns();
      }
      curBubble = null; cur = null; curThk = null; curText = "";
    } else if (m.type === "reply"){
      add("assistant", m.text);
    } else if (m.type === "contextRefError"){
      var errPath = '#' + m.refType + (m.value ? ':' + m.value : '');
      var existIdx = attachedFiles.findIndex(function(f){ return f.isErr && f.path === errPath; });
      if (existIdx >= 0) {
        attachedFiles[existIdx].errText = m.text;
      } else {
        attachedFiles.push({ path: errPath, content: '', isErr: true, errText: m.text });
      }
      renderChips();
    } else if (m.type === "error"){
      addErrorCard(m);
    } else if (m.type === "serverStatus"){
      sb.style.display = m.running ? "none" : "block";
      if (!m.running) sb.textContent = "⚠ 后端服务器未启动 — 发送时将自动启动";
      if (dot) dot.className = "dot" + (m.running ? "" : " err");
    } else if (m.type === "providersInfo"){
      applyProvidersInfo(m.providers);
    } else if (m.type === "modelInfo"){
      if (m.provider){ switchToProvider(m.provider); }
      if (m.model){
        setModelUI(m.model);
      }
      if (m.interactionMode){
        setIModeUI(m.interactionMode);
      }
      if (m.approvalMode){ setModeUI(m.approvalMode); }
    } else if (m.type === "balanceUpdate"){
      updateBalance(m);
    } else if (m.type === "status"){
      if (m.text){ sb.textContent = m.text; sb.style.display = "block"; } else sb.style.display = "none";
    } else if (m.type === "systemNotice"){
      // Issue #82: render a persistent in-conversation card so the user knows
      // a context-altering event happened (currently: AUTOCOMPACT). Distinct
      // from `status` which is transient and shown only in the status bar.
      // Use textContent + appendChild (no innerHTML) to avoid any XSS risk
      // from user-provided content flowing into the DOM (CodeQL js/xss).
      var _sn = document.createElement("div");
      _sn.className = "sys-notice" + (m.kind ? " sys-notice-" + m.kind : "");
      if (m.title){
        var _snTitleEl = document.createElement("div");
        _snTitleEl.className = "sys-notice-title";
        _snTitleEl.textContent = String(m.title);
        _sn.appendChild(_snTitleEl);
      }
      if (m.body){
        var _snBodyEl = document.createElement("div");
        _snBodyEl.className = "sys-notice-body";
        _snBodyEl.textContent = String(m.body);
        _sn.appendChild(_snBodyEl);
      }
      if (thk && thk.parentNode === msgs) msgs.insertBefore(_sn, thk); else msgs.appendChild(_sn);
      ascroll();
    } else if (m.type === "sessions"){
      sessions = m.items || []; activeSessionId = m.activeId || null;
      if (typeof m.currentWs === "string") currentWs = m.currentWs;
      renderSessions();
    } else if (m.type === "replayStart"){
      /* Issue #143: extension is about to flood us with buffered events
         from a background session. Suppress per-event ascroll() so we
         don't queue N RAF callbacks (visible scrollbar jitter / flash). */
      _replaying = true;
    } else if (m.type === "replayEnd"){
      _replaying = false;
      /* Scroll once, after the browser has applied all the DOM updates
         from the burst. Use RAF so we run after layout. */
      if (stick) requestAnimationFrame(function(){ msgs.scrollTop = msgs.scrollHeight; });
    } else if (m.type === "sessionLoaded"){
      activeSessionId = m.id || null;
      /* Only restore spinner timer if the extension confirms the run is still
         in-flight (m.busy === true).  Completed runs are deleted from memory
         on the extension side, so their events are never replayed — without
         this guard a stale _sessionTimerMap entry would resurrect the spinner
         for a session whose reply is long done. */
      var _savedTs = (m.busy && activeSessionId) ? _sessionTimerMap[activeSessionId] : 0;
      if (!m.busy && activeSessionId) delete _sessionTimerMap[activeSessionId];
      resetChat();
      /* Pass preserveTimerMap=true so that if the PREVIOUS session is still
         running in the background, its _sessionTimerMap entry is kept alive
         until replyEnd/stopped fires and can clean it up with the correct id. */
      setBusy(false, true);
      sb.style.display = "none";
      var msgsArr = m.messages || [];
      for (var k=0; k<msgsArr.length; k++){
        var mm = msgsArr[k];
        if (mm.role === "user") add("user", mm.text || "");
        else if (mm.role === "assistant"){
          if (es) es.style.display = "none";
          var d = document.createElement("div");
          d.className = "msgA";
          d.setAttribute("data-raw", mm.text || "");
          d.innerHTML = "<div class=\"lbl\">DEEP COPILOT</div><div class=\"msgC\"></div>";
          if (thk && thk.parentNode === msgs) msgs.insertBefore(d, thk); else msgs.appendChild(d);
          d.querySelector(".msgC").innerHTML = renderMd(mm.text || "");
          /* Action bar only on the very last assistant bubble (post-load) */
          if (k === msgsArr.length - 1) d.insertAdjacentHTML("beforeend", actionBarHtml());
        }
      }
      /* Restore timer if this session was mid-run when we switched away.
         Call setBusy(true) first so it creates the spinner and starts the
         interval; then override _busyStartTs with the real start time so
         the elapsed display shows the correct accumulated duration rather
         than resetting to 0. Also sync the map entry. */
      if (_savedTs) {
        setBusy(true);
        _busyStartTs = _savedTs;
        if (activeSessionId) _sessionTimerMap[activeSessionId] = _savedTs;
      }
      renderSessions(); ascroll();
    } else if (m.type === "fileSearchResults"){
      // Merge file suggestions into the current @ popup
      if (popVisible && popKind === "at") {
        var q3 = (m.query || "").toLowerCase();
        var fileItems = (m.files || []).map(function(fp){
          return { name: "@" + fp, desc: "附带文件", filePath: fp };
        });
        // Keep AT_CMDS entries that match, then append file results
        var builtIn = AT_CMDS.filter(function(c){ return c.name.slice(1).startsWith(q3); });
        var merged = builtIn.concat(fileItems).slice(0, 30);
        if (merged.length) showPop(merged, "at", popTrigStart);
      } else if (popKind === "hash") {
        // Same merge logic for the # picker — keep built-in refs first.
        // Note: popKind is checked without requiring popVisible because when
        // no built-in refs match, the popup is hidden while file results arrive.
        var q3h = (m.query || "").toLowerCase();
        var fileItemsH = (m.files || []).map(function(fp){
          return { name: "#" + fp, desc: "附带文件", filePath: fp, ref: "file" };
        });
        var builtH = HASH_REFS.filter(function(c){
          var n = c.name.slice(1).replace(/:$/, "");
          return n.startsWith(q3h);
        });
        var mergedH = builtH.concat(fileItemsH).slice(0, 30);
        if (mergedH.length) showPop(mergedH, "hash", popTrigStart);
      }
    } else if (m.type === "setLiveSelection") {
      var _inc = m.payload || null;
      if (_inc && _liveDismissedKey) {
        var _incKey = _inc.path + ':' + _inc.startLine + ':' + _inc.endLine;
        if (_incKey === _liveDismissedKey) { /* same selection, user dismissed it — skip */ }
        else { _liveDismissedKey = null; liveSelection = _inc; renderChips(); }
      } else {
        _liveDismissedKey = null; liveSelection = _inc; renderChips();
      }
    } else if (m.type === "clearLiveSelection") {
      _liveDismissedKey = null; liveSelection = null;
      renderChips();
    } else if (m.type === "addAttachment") {
      // Extension posted a file/selection attachment via the editor context menu command.
      var p = m.payload;
      if (p && p.path) {
        var isDup = attachedFiles.some(function(f){
          return f.path === p.path && f.startLine === p.startLine && f.endLine === p.endLine;
        });
        if (!isDup) {
          attachedFiles.push({
            path:      p.path,
            content:   p.content || '',
            startLine: p.startLine,
            endLine:   p.endLine,
            lang:      p.lang,
            isFolder:  !!p.isFolder
          });
          renderChips();
        }
      }
    } else if (m.type === "addPendingAttachment") {
      // Extension resolved an inline `#ref:arg` during send(): we need the
      // chip to appear inside the CURRENT user bubble (not the next turn's
      // input), so we splice it into the pending-snapshot array that
      // `userEcho` flushes. doSend() has already cleared `attachedFiles`.
      var pp = m.payload;
      if (pp && pp.path) {
        if (!_pendingAttachments) _pendingAttachments = [];
        var dup = _pendingAttachments.some(function(f){
          return f.path === pp.path && f.startLine === pp.startLine && f.endLine === pp.endLine;
        });
        if (!dup) _pendingAttachments.push(pp);
      }
    } else if (m.type === "filePickerResult") {
      // Native VS Code file picker result — add as chip
      if (m.path) {
        if (!attachedFiles.some(function(f){ return f.path === m.path; })) {
          attachedFiles.push({ path: m.path, content: null });
          renderChips();
          requestFileContent(m.path);
        }
      }
      inp.focus();
    } else if (m.type === "fileContentResult"){
      // Update the chip's content or imageData
      for (var fi = 0; fi < attachedFiles.length; fi++) {
        if (attachedFiles[fi].path === m.path) {
          if (m.error) {
            attachedFiles.splice(fi, 1); // remove failed chip
          } else if (m.imageData) {
            attachedFiles[fi].content   = null;
            attachedFiles[fi].imageData = m.imageData;
          } else {
            attachedFiles[fi].content = m.content || '';
          }
          renderChips();
          break;
        }
      }
    } else if (m.type === "skillList"){
      // Merge dynamically discovered skills into SLASH_CMDS.
      // Built-in static commands always take precedence; skills are appended.
      var existingNames = SLASH_CMDS.map(function(c){ return c.name; });
      (m.skills || []).forEach(function(sk){
        var slashName = "/" + sk.name;
        if (existingNames.indexOf(slashName) !== -1) return;
        var shortDesc = sk.desc.length > 72 ? sk.desc.slice(0, 69) + "\u2026" : sk.desc;
        SLASH_CMDS.push({
          name:          slashName,
          desc:          shortDesc,
          hint:          sk.hint || "",
          expand:        null,         // not used for skills
          _skill:        true,         // marks this as a dynamic skill
          _skillContent: sk.content || "", // full SKILL.md text (for chip staging)
        });
        existingNames.push(slashName);
      });
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
    // Pinned first, then by time
    list.sort(function(a,b){ return (b.pinned?1:0)-(a.pinned?1:0) || (b.updatedAt||0)-(a.updatedAt||0); });
    var html = "", lastBucket = "";
    list.forEach(function(s){
      var b = s.pinned ? "📌 已固定" : dayBucket(s.updatedAt || s.createdAt || 0);
      if (b !== lastBucket){ html += '<div class="grp">' + b + '</div>'; lastBucket = b; }
      var act = (s.id === activeSessionId) ? " active" : "";
      var bsy = s.busy ? " busy" : "";
      var pnd = s.pinned ? " pinned" : "";
      var unr = s.unread ? " unread" : "";
      html += '<div class="si' + act + bsy + pnd + unr + '" data-id="' + s.id + '">' +
        '<div class="ti">' +
          (s.busy ? '<span class="busy-dot" title="思考中…"></span>' : '') +
          (s.unread ? '<span class="unread-dot"></span>' : '') +
          escHtml(s.title || "Untitled") +
        '</div>' +
        '<div class="si-time">' + escHtml(relTime(s.updatedAt || s.createdAt || 0)) + '</div>' +
        '<div class="ops">' +
          '<button class="op-pin" title="' + (s.pinned ? '取消固定' : '固定') + '">' + (s.pinned ? '📌' : '📍') + '</button>' +
          '<button class="op-dl" title="删除">🗑</button>' +
        '</div>' +
      '</div>';
    });
    dlist.innerHTML = html;
  }
  if (dsearch) dsearch.addEventListener("input", renderSessions);
  // ── Inline rename ─────────────────────────────────────────────────────
  function startInlineRename(id){
    var si = dlist.querySelector('.si[data-id="'+id+'"]');
    if (!si) return;
    var tiEl = si.querySelector(".ti");
    var curTitle = "";
    tiEl.childNodes.forEach(function(n){ if (n.nodeType === 3) curTitle += n.nodeValue; });
    curTitle = curTitle.trim();
    var inp = document.createElement("input");
    inp.className = "si-rename-inp";
    inp.value = curTitle;
    tiEl.innerHTML = "";
    tiEl.appendChild(inp);
    inp.focus(); inp.select();
    var committed = false;
    function commit(){
      if (committed) return; committed = true;
      var nv = inp.value.trim();
      if (nv && nv !== curTitle) vscode.postMessage({type:"sessionRename", id:id, title:nv});
      else renderSessions();
    }
    inp.addEventListener("keydown", function(e){
      if (e.key === "Enter" && !e.isComposing){ e.preventDefault(); commit(); }
      else if (e.key === "Escape"){ e.preventDefault(); committed = true; renderSessions(); }
    });
    inp.addEventListener("blur", commit);
  }

  // ── right-click context menu ──────────────────────────────────────
  // ── Two-step delete: track pending state in JS (not DOM) since renderSessions() re-creates HTML ──
  var _pendingDeleteId = null, _pendingDeleteTimer = null;
  function deleteSession(id) {
    if (_pendingDeleteId === id) {
      clearTimeout(_pendingDeleteTimer); _pendingDeleteId = null; _pendingDeleteTimer = null;
      vscode.postMessage({type: "sessionDelete", id: id});
      return;
    }
    if (_pendingDeleteTimer) { clearTimeout(_pendingDeleteTimer); _pendingDeleteTimer = null; }
    var prevId = _pendingDeleteId;
    _pendingDeleteId = id;
    // Reset previous button if still in DOM
    if (prevId) {
      var pb = dlist.querySelector('.si[data-id="' + prevId + '"] .op-dl');
      if (pb) { pb.textContent = "\uD83D\uDDD1"; pb.title = "\u5220\u9664"; pb.style.color = ""; }
    }
    // Mark the target button
    var btn = dlist.querySelector('.si[data-id="' + id + '"] .op-dl');
    if (btn) { btn.textContent = "\u2713?"; btn.title = "\u518D\u6B21\u70B9\u51FB\u786E\u8BA4\u5220\u9664"; btn.style.color = "var(--vscode-errorForeground, #f44)"; }
    _pendingDeleteTimer = setTimeout(function() {
      _pendingDeleteId = null; _pendingDeleteTimer = null;
      var b = dlist.querySelector('.si[data-id="' + id + '"] .op-dl');
      if (b) { b.textContent = "\uD83D\uDDD1"; b.title = "\u5220\u9664"; b.style.color = ""; }
    }, 2500);
  }

  var ctxMenu = document.createElement("div");
  ctxMenu.id = "sess-ctx";
  ctxMenu.className = "sess-ctx";
  ctxMenu.style.display = "none";
  document.body.appendChild(ctxMenu);
  var _ctxId = null, _ctxPinned = false;
  function openCtx(e, id, pinned){
    _ctxId = id; _ctxPinned = pinned;
    ctxMenu.innerHTML =
      '<div class="ctx-item" data-action="pin">' + (pinned ? '📌 取消固定' : '📍 固定') + '</div>' +
      '<div class="ctx-item" data-action="unread">🔵 标记为未读</div>' +
      '<div class="ctx-sep"></div>' +
      '<div class="ctx-item" data-action="rename">✏️ 重命名</div>' +
      '<div class="ctx-item" data-action="archive">📦 存档</div>' +
      '<div class="ctx-sep"></div>' +
      '<div class="ctx-item danger" data-action="delete">🗑 删除</div>';
    var x = e.clientX, y = e.clientY;
    ctxMenu.style.display = "block";
    var mw = ctxMenu.offsetWidth, mh = ctxMenu.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight;
    if (x + mw > vw) x = vw - mw - 4;
    if (y + mh > vh) y = vh - mh - 4;
    ctxMenu.style.left = x + "px"; ctxMenu.style.top = y + "px";
  }
  function closeCtx(){ ctxMenu.style.display = "none"; _ctxId = null; }
  ctxMenu.addEventListener("click", function(e){
    var it = e.target.closest(".ctx-item"); if (!it || !_ctxId) return;
    var action = it.dataset.action, id = _ctxId;
    closeCtx();
    if (action === "pin")     vscode.postMessage({type:"sessionPin", id:id});
    else if (action === "unread")   vscode.postMessage({type:"sessionUnread", id:id});
    else if (action === "rename")   { startInlineRename(id); }
    else if (action === "archive")  vscode.postMessage({type:"sessionArchive", id:id});
    else if (action === "delete")   { deleteSession(id); }
  });
  document.addEventListener("click", closeCtx);
  document.addEventListener("contextmenu", function(e){
    var item = e.target.closest && e.target.closest(".si");
    if (!item) return;
    e.preventDefault();
    var pinned = item.classList.contains("pinned");
    openCtx(e, item.dataset.id, pinned);
  });

  dlist.addEventListener("click", function(e){
    var btnPin = e.target.closest && e.target.closest("button.op-pin");
    var btnDl  = e.target.closest && e.target.closest("button.op-dl");
    var item   = e.target.closest && e.target.closest(".si");
    if (!item) return;
    var id = item.dataset.id;
    if (btnDl){ e.stopPropagation(); deleteSession(id); return; }
    if (btnPin){ e.stopPropagation(); vscode.postMessage({type:"sessionPin", id:id}); return; }
    vscode.postMessage({type:"sessionLoad", id:id});
  });

  /* ── Inline user-message edit (GH Copilot style) ──────────────── */
  function enterEditMode(msgU){
    if (!msgU || msgU.classList.contains("editing")) return;
    /* If another bubble is being edited, cancel it first */
    var open = msgs.querySelector(".msgU.editing");
    if (open && open !== msgU) exitEditMode(open, false);
    var orig = msgU.dataset.origText || "";
    msgU.classList.add("editing");
    var editor = document.createElement("div");
    editor.className = "msgU-editor";
    editor.innerHTML =
      "<textarea spellcheck=\"false\"></textarea>" +
      "<div class=\"msgU-editor-bar\">" +
        "<span class=\"hint\">Enter \u63d0\u4ea4 \u00b7 Shift+Enter \u6362\u884c \u00b7 Esc \u53d6\u6d88</span>" +
        "<button class=\"btn-cancel\" type=\"button\">\u53d6\u6d88</button>" +
        "<button class=\"btn-save\" type=\"button\">\u63d0\u4ea4</button>" +
      "</div>";
    msgU.appendChild(editor);
    var ta = editor.querySelector("textarea");
    ta.value = orig;
    /* Auto-grow textarea to content */
    function grow(){
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 240) + "px";
    }
    ta.addEventListener("input", grow);
    setTimeout(function(){ grow(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
    var btnSave = editor.querySelector(".btn-save");
    var btnCancel = editor.querySelector(".btn-cancel");
    btnSave.addEventListener("click", function(){ submitEdit(msgU); });
    btnCancel.addEventListener("click", function(){ exitEditMode(msgU, false); });
    ta.addEventListener("keydown", function(e){
      if (e.key === "Escape"){ e.preventDefault(); exitEditMode(msgU, false); return; }
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing){ e.preventDefault(); submitEdit(msgU); return; }
    });
  }
  function exitEditMode(msgU, keepText){
    if (!msgU || !msgU.classList.contains("editing")) return;
    msgU.classList.remove("editing");
    var editor = msgU.querySelector(".msgU-editor");
    if (editor) editor.remove();
    if (!keepText){
      /* Restore original bubble content from origText */
      var body = msgU.querySelector(".msgU-body");
      if (body) body.textContent = msgU.dataset.origText || "";
    }
  }
  function submitEdit(msgU){
    var editor = msgU.querySelector(".msgU-editor");
    if (!editor) return;
    var ta = editor.querySelector("textarea");
    var newText = (ta.value || "").trim();
    if (!newText){ exitEditMode(msgU, false); return; }
    var idx = Number(msgU.dataset.msgIdx);
    /* Remove all DOM nodes from this bubble onward (provider replay will rebuild) */
    var allMsgU = msgs.querySelectorAll(".msgU");
    for (var i = 0; i < allMsgU.length; i++){
      if (Number(allMsgU[i].dataset.msgIdx) >= idx){
        var n = allMsgU[i];
        while (n){
          var nx = n.nextSibling;
          if (n !== thk && n !== jumpBtn && n.parentNode === msgs) msgs.removeChild(n);
          n = nx;
        }
        break;
      }
    }
    _userMsgCount = idx;
    _editPendingIdx = -1;
    /* Tell extension to truncate AND resend in one step */
    vscode.postMessage({ type: "editUserSubmit", index: idx, text: newText });
  }

  /* Click delegation: code-block copy/insert buttons + file path links */
  msgs.addEventListener("click", function(e){
    var t = e.target;
    /* Ignore clicks inside the active editor (textarea/buttons) */
    if (t.closest && t.closest(".msgU-editor")) return;
    /* Edit user message — click on entire bubble.
       Allowed even during streaming: provider will stop the active run
       before resending the edited prompt. */
    if (t.closest(".msgU")){
      var msgU = t.closest(".msgU");
      if (!msgU) return;
      if (msgU.classList.contains("editing")) return;
      enterEditMode(msgU);
      return;
    }
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
    if (t.classList.contains("cb-term")){
      var preT = t.closest("pre.cb"); if (!preT) return;
      var codeT = decodeURIComponent(preT.getAttribute("data-code") || "");
      var langT = preT.getAttribute("data-lang") || "";
      vscode.postMessage({type:"insertTerminal", code: codeT, lang: langT});
      var origT = t.textContent; t.textContent = "✓ 已插入";
      setTimeout(function(){ t.textContent = origT; }, 1500);
      return;
    }
    if (t.classList.contains("cb-run")){
      var preR = t.closest("pre.cb"); if (!preR) return;
      var codeR = decodeURIComponent(preR.getAttribute("data-code") || "");
      var langR = preR.getAttribute("data-lang") || "";
      vscode.postMessage({type:"runTerminal", code: codeR, lang: langR});
      var origR = t.textContent; t.textContent = "▶ 运行中…";
      setTimeout(function(){ t.textContent = origR; }, 1800);
      return;
    }
    if (t.classList.contains("cb-fold")){
      var preF = t.closest("pre.cb"); if (!preF) return;
      preF.classList.toggle("expanded");
      t.textContent = preF.classList.contains("expanded")
        ? "\u2191 \u6298\u53e0"
        : "\u2026 \u5c55\u5f00\u5168\u90e8 " + (preF.getAttribute("data-lines") || "?") + " \u884c";
      return;
    }
    if (t.classList.contains("cb-apply")){
      var preA = t.closest("pre.cb"); if (!preA) return;
      var codeA = decodeURIComponent(preA.getAttribute("data-code") || "");
      var langA = preA.getAttribute("data-lang") || "";
      vscode.postMessage({type:"codeBlockApply", code: codeA, lang: langA});
      var origA = t.textContent; t.textContent = "✓ 应用中…";
      setTimeout(function(){ t.textContent = origA; }, 2000);
      return;
    }
    if (t.classList.contains("cb-newfile")){
      var preN = t.closest("pre.cb"); if (!preN) return;
      var codeN = decodeURIComponent(preN.getAttribute("data-code") || "");
      var langN = preN.getAttribute("data-lang") || "";
      vscode.postMessage({type:"codeBlockCreate", code: codeN, lang: langN});
      var origN = t.textContent; t.textContent = "✓ 已创建";
      setTimeout(function(){ t.textContent = origN; }, 2000);
      return;
    }
    /* ── File path link → open in main editor (left side) ── */
    var fl = t.closest && t.closest("a.flink");
    if (fl){
      e.preventDefault();
      var fp = fl.getAttribute("data-path") || "";
      var ln = parseInt(fl.getAttribute("data-line") || "0", 10) || 0;
      if (fp) vscode.postMessage({ type: "openFile", path: fp, line: ln });
      return;
    }
    /* ── #8 Phase 6: error card retry ── */
    if (t.classList.contains("errRetry")){
      if (busy) return;
      var card = t.closest(".errCard"); if (card) card.parentNode.removeChild(card);
      vscode.postMessage({type:"regenerate"});
      return;
    }
    /* ── #6 Phase 4: per-message action bar ── */
    var maBtn = t.closest && t.closest(".ma");
    if (maBtn){
      var bub = maBtn.closest(".msgA"); if (!bub) return;
      var raw = bub.getAttribute("data-raw") || "";
      if (maBtn.classList.contains("ma-copy")){
        vscode.postMessage({type:"copy", code: raw});
        maBtn.classList.add("copied");
        setTimeout(function(){ maBtn.classList.remove("copied"); }, 1500);
        return;
      }
      if (maBtn.classList.contains("ma-regen")){
        if (busy) return;
        /* Remove this assistant bubble (and any later ones) from the DOM */
        var nx = bub.nextSibling;
        while (nx){
          var rm = nx; nx = nx.nextSibling;
          if (rm.nodeType === 1 && (rm.classList.contains("msgA") || rm.classList.contains("err"))) rm.parentNode.removeChild(rm);
        }
        /* Also remove the preceding user bubble — the provider will re-emit
           `userEcho` when re-handling the prompt, so leaving the old user
           bubble would cause it to appear twice. Decrement _userMsgCount so
           edit-message indexing stays in sync. */
        var prevU = bub.previousSibling;
        while (prevU && !(prevU.nodeType === 1 && prevU.classList && prevU.classList.contains("msgU"))) {
          prevU = prevU.previousSibling;
        }
        if (prevU) {
          prevU.parentNode.removeChild(prevU);
          if (_userMsgCount > 0) _userMsgCount--;
        }
        bub.parentNode.removeChild(bub);
        vscode.postMessage({type:"regenerate"});
        return;
      }
      if (maBtn.classList.contains("ma-up") || maBtn.classList.contains("ma-down")){
        var sib = bub.querySelectorAll(".ma-up,.ma-down");
        for (var si=0; si<sib.length; si++) sib[si].classList.remove("active");
        maBtn.classList.add("active");
        vscode.postMessage({type:"feedback", value: maBtn.classList.contains("ma-up") ? "up" : "down"});
        return;
      }
    }
    var a = t.closest && t.closest("a.flink");
    if (a){
      e.preventDefault();
      vscode.postMessage({type:"openFile", path: a.getAttribute("data-path"), line: parseInt(a.getAttribute("data-line") || "0", 10) || 0});
    }
  });

  vscode.postMessage({type:"ready"});
})();
