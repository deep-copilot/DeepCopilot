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
  var edgeL = document.getElementById("edgeL");
  var edgeR = document.getElementById("edgeR");
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
  var ftTokens = document.getElementById("ft-tokens");
  var ftCost = document.getElementById("ft-cost");
  var ftCache = document.getElementById("ft-cache");
  var planBody = document.getElementById("plan-body");
  var planCnt = document.getElementById("plan-cnt");
  var todoBody = document.getElementById("todo-body");
  var todoCnt = document.getElementById("todo-cnt");
  var cxOn = false, busy = false;
  var cur = null, curText = "", curThk = null, curBubble = null;
  var toolMap = {};
  var sess = { tokens:0, cost:0, cacheHit:0, promptTotal:0 };
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
  /* Edge toggles: collapsed by default; persist state. */
  var _ui = {};
  try { _ui = (vscode.getState() && vscode.getState().ui) || {}; } catch(e){}
  function applyPanelState(){
    document.body.classList.toggle("no-left", _ui.leftCollapsed !== false);
    document.body.classList.toggle("no-right", _ui.rightCollapsed !== false);
  }
  function savePanelState(){
    try { var s = vscode.getState() || {}; s.ui = _ui; vscode.setState(s); } catch(e){}
  }
  applyPanelState();
  edgeL.addEventListener("click", function(){
    _ui.leftCollapsed = !document.body.classList.contains("no-left");
    applyPanelState(); savePanelState();
  });
  edgeR.addEventListener("click", function(){
    _ui.rightCollapsed = !document.body.classList.contains("no-right");
    applyPanelState(); savePanelState();
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
    /* Step D: restore parked file-link HTML. */
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
      "</div><code>" + highlighted + "</code>" +
      (foldable ? "<button class=\"cb-fold\">\u2026 \u5c55\u5f00\u5168\u90e8 " + rawLines.length + " \u884c</button>" : "") +
    "</pre>";
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
        out.push(buildCodeBlock(codes[+only[1]]));
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
        out.push(buildCodeBlock(codes[idx]));
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
    if (role === "user"){ d.className = "msgU"; d.textContent = text; }
    else if (role === "assistant"){
      d.className = "msgA";
      d.setAttribute("data-raw", text || "");
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
      "<div class=\"thinkhead\" style=\"display:none\"><span class=\"th-dot\"></span><span class=\"th-chev\">▸</span><span class=\"th-lbl\">thinking…</span></div>" +
      "<div class=\"thinkblk\" style=\"display:none\"></div>" +
      "<div class=\"flow\"></div>";
    if (thk && thk.parentNode === msgs) msgs.insertBefore(d, thk); else msgs.appendChild(d);
    curBubble = d;
    cur = null;        /* no active text segment yet */
    curText = "";
    curThk = d.querySelector(".thinkblk");
    var thh = d.querySelector(".thinkhead");
    thh.addEventListener("click", function(){
      var blk = thh.parentNode.querySelector(".thinkblk");
      if (!blk) return;
      var open = blk.style.display === "block";
      blk.style.display = open ? "none" : "block";
      var chev = thh.querySelector(".th-chev");
      if (chev) chev.textContent = open ? "▸" : "▾";
    });
    return d;
  }

  /* Ensure there is a current text segment to stream markdown into.
     A new segment is created after each tool card so text/tool order is
     preserved (Copilot-style interleaving). */
  function ensureTextSegment(){
    ensureBubble();
    if (cur && cur.classList && cur.classList.contains("seg")) return cur;
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
    read_file:    { verb:"Read",     icon:"\uD83D\uDCC4", kind:"read"    },
    write_file:   { verb:"Edited",   icon:"\u270E",       kind:"write"   },
    list_dir:     { verb:"Listed",   icon:"\uD83D\uDCC1", kind:"read"    },
    grep_search:  { verb:"Searched", icon:"\uD83D\uDD0D", kind:"search"  },
    run_shell:    { verb:"Ran",      icon:"\u25B6",       kind:"shell"   },
    update_plan:  { verb:"Updated plan", icon:"\uD83D\uDCCB", kind:"plan" }
  };
  /* Detect the program/shell being invoked so we can show "powershell" / "python" / "bash"
     as the verb (mirrors GH Copilot's "Ran terminal command: powershell" style). */
  function detectShell(cmd){
    var s = String(cmd||"").trim();
    if (!s) return "shell";
    /* strip leading "& " or env assignments */
    s = s.replace(/^&\s+/, "").replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, "");
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
    var meta = TOOL_META[name] || { verb:name, icon:"\u2699", kind:"other" };
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
    var holder = curBubble.querySelector(".flow");
    var d = document.createElement("div");
    var meta = toolMeta(name, args);
    d.className = "tool run k-" + meta.kind;
    var target = toolTarget(name, args);
    var statusTxt = opts.approval ? "等待批准" : "…";
    d.innerHTML = 
      "<div class=\"h\">" +
        "<span class=\"chev\">▶</span>" +
        "<span class=\"ico\">" + escHtml(meta.icon) + "</span>" +
        "<span class=\"nm\">" + escHtml(meta.verb) + "</span>" +
        "<span class=\"tgt\" title=\"" + escHtml(target) + "\">" + escHtml(target) + "</span>" +
        "<span class=\"st\">" + escHtml(statusTxt) + "</span>" +
      "</div>" +
      "<div class=\"b\"><div class=\"args\">" + escHtml(shortArgs(args)) + "</div><div class=\"out\"></div></div>";
    holder.appendChild(d);
    /* Tool card breaks the current text run; next replyDelta will start a new segment. */
    if (cur && cur.classList && cur.classList.contains("seg")) cur.setAttribute("data-raw", curText || "");
    cur = null; curText = "";
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
    { name: "@file",      desc: "附带当前打开的文件",   action: "ctxOn" },
    { name: "@selection", desc: "附带编辑器中选中的代码", action: "ctxOn" },
    { name: "@terminal",  desc: "附带终端最近输出(占位)", action: "noop" },
  ];

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
  function hidePop(){ if (popVisible){ pop.style.display = "none"; popVisible = false; popItems = []; } }
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
      // Remove the @-token and apply action
      var b2 = inp.value.slice(0, popTrigStart);
      var a2 = inp.value.slice(popTrigStart).replace(/^\S*\s?/, "");
      inp.value = b2 + a2;
      autosize();
      if (it.action === "ctxOn" && !cxOn){ cxbt.click(); }
      setTimeout(function(){ inp.focus(); inp.setSelectionRange(b2.length, b2.length); }, 0);
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
      var m2 = AT_CMDS.filter(function(c){ return c.name.slice(1).startsWith(q2); });
      showPop(m2, "at", start);
    } else { hidePop(); }
  }

  /* ─── History recall state ─── */
  var histStack = [];   /* list of past user prompts in chronological order */
  var histIdx = -1;     /* current cursor in history when navigating */

  function setBusy(on){
    busy = !!on;
    sbtn.classList.toggle("stop", busy);
    sbtn.textContent = busy ? "\u23F9" : "\u2191";
    sbtn.title = busy ? "\u505C\u6B62\u751F\u6210 (Esc)" : "\u53D1\u9001";
    dot.className = "dot" + (busy ? " warn" : "");
    var pb = document.getElementById("prog");
    if (pb) pb.classList.toggle("on", busy);
  }
  function showCursor(){ /* disabled: blinking cursor removed for cleaner UI */ }
  function hideCursor(){
    /* Cleanup any leftover cursors from older sessions */
    var olds = msgs.querySelectorAll(".tcur");
    for (var i=0; i<olds.length; i++) olds[i].parentNode && olds[i].parentNode.removeChild(olds[i]);
  }
  function doSend(){
    if (busy){ vscode.postMessage({type:"stop"}); return; }
    var t = inp.value.trim();
    if (!t) return;
    /* Push to history (dedupe consecutive duplicates) */
    if (histStack.length === 0 || histStack[histStack.length - 1] !== t) histStack.push(t);
    if (histStack.length > 50) histStack.shift();
    histIdx = histStack.length;
    hidePop();
    /* User bubble is now echoed by the provider via 'userEcho' so that the
       message survives session switches (replayed from the run's event log). */
    inp.value = ""; autosize();
    vscode.postMessage({type:"send", text:t});
  }
  function resetChat(){
    var nodes = msgs.querySelectorAll(".msgU,.msgA,.err");
    for (var i=0;i<nodes.length;i++) nodes[i].remove();
    if (es) es.style.display = "block";
    sess = { tokens:0, cost:0, cacheHit:0, promptTotal:0 };
    ftTokens.textContent = "0 tokens"; ftCost.textContent = "¥0.0000";
    if (ftCache) { ftCache.textContent = "💾 0%"; ftCache.classList.remove("good"); }
    renderPlan([]);
    curBubble = null; cur = null; curText = ""; curThk = null; toolMap = {};
  }
  inp.addEventListener("input", function(){ autosize(); detectTrigger(); });
  inp.addEventListener("blur", function(){ setTimeout(hidePop, 150); });
  inp.addEventListener("keydown", function(e){
    /* ── #7 Phase 5: popover navigation ── */
    if (popVisible){
      if (e.key === "ArrowDown"){ e.preventDefault(); movePop(1); return; }
      if (e.key === "ArrowUp")  { e.preventDefault(); movePop(-1); return; }
      if (e.key === "Tab" || e.key === "Enter"){
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
    } else if (m.type === "userEcho"){
      add("user", m.text || "");
    } else if (m.type === "replyStart"){
      curBubble = null; cur = null; curThk = null; curText = ""; toolMap = {};
      ensureBubble(); ascroll();
      setBusy(true); showCursor();
    } else if (m.type === "newTurn"){
      /* Same bubble for the entire user→assistant turn (GH Copilot style).
         Just close out the current text segment so the next replyDelta
         starts a fresh one positioned after any tool cards. */
      if (cur && cur.classList && cur.classList.contains("seg")) cur.setAttribute("data-raw", curText || "");
      cur = null; curText = "";
      showCursor();
    } else if (m.type === "replyDelta"){
      ensureTextSegment();
      curText += (m.text || ""); cur.innerHTML = renderMd(curText);
      var th2 = curBubble.querySelector(".thinkhead");
      if (th2 && th2.style.display !== "none" && !th2.dataset.done) {
        th2.dataset.done = "1";
        th2.classList.add("done");
        var secs = th2.dataset.start ? Math.round((Date.now() - parseInt(th2.dataset.start,10))/1000) : 0;
        var lbl = "Thought" + (secs ? " for " + secs + "s" : "");
        th2.dataset.label = lbl;
        /* auto-collapse once real reply begins */
        if (curThk) curThk.style.display = "none";
        var lblEl = th2.querySelector(".th-lbl"); if (lblEl) lblEl.textContent = lbl;
        var chevEl = th2.querySelector(".th-chev"); if (chevEl) chevEl.textContent = "▸";
      }
      showCursor();
      ascroll();
    } else if (m.type === "thinkingDelta"){
      ensureBubble();
      var th = curBubble.querySelector(".thinkhead");
      if (th && th.style.display === "none") {
        th.style.display = "inline-block";
        th.dataset.start = String(Date.now());
        /* default-expand so user sees streaming reasoning */
        if (curThk) curThk.style.display = "block";
      }
      curThk.textContent += (m.text || "");
      if (th && !th.dataset.done) {
        var es2 = th.dataset.start ? Math.round((Date.now() - parseInt(th.dataset.start,10))/1000) : 0;
        var lbl3 = "Thinking… " + es2 + "s";
        th.dataset.label = lbl3;
        var lblEl3 = th.querySelector(".th-lbl"); if (lblEl3) lblEl3.textContent = lbl3;
        var chevEl3 = th.querySelector(".th-chev");
        if (chevEl3) chevEl3.textContent = (curThk && curThk.style.display === "block" ? "\u25BE" : "\u25B8");
      }
      /* keep view pinned to the latest reasoning text */
      if (curThk && curThk.style.display === "block") curThk.scrollTop = curThk.scrollHeight;
      ascroll();
    } else if (m.type === "toolStart"){
      addToolCard(m.id, m.name, m.args, {});
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
      d.innerHTML = "<div class=\"h\"><span class=\"chev\">▶</span><span class=\"ico\">" + escHtml(meta2.icon) + "</span><span class=\"nm\">" + escHtml(meta2.verb) + "</span><span class=\"tgt\">" + escHtml(tgt2) + "</span><span class=\"st\">" + escHtml(label) + "</span></div>" +
        "<div class=\"b\"><div class=\"args\">" + escHtml(shortArgs(m.args)) + "</div></div>";
      holder.appendChild(d);
      if (cur && cur.classList && cur.classList.contains("seg")) cur.setAttribute("data-raw", curText || "");
      cur = null; curText = "";
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
      }
      curBubble = null; cur = null; curThk = null; curText = "";
    } else if (m.type === "reply"){
      add("assistant", m.text);
    } else if (m.type === "error"){
      addErrorCard(m);
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
      /* When switching sessions, reset busy/status to a clean state. If the
         newly-foregrounded session has an in-flight run, the provider will
         immediately replay its buffered events (replyStart, deltas, etc.)
         which will set busy back to true. */
      setBusy(false);
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
      var bsy = s.busy ? " busy" : "";
      html += '<div class="si' + act + bsy + '" data-id="' + s.id + '">' +
        '<div class="ti">' +
          (s.busy ? '<span class="busy-dot" title="思考中…"></span>' : '') +
          escHtml(s.title || "Untitled") +
        '</div>' +
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
