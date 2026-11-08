(function () {
  "use strict";

  const DEFAULT_KEY = (window.DEFAULT_KEY || []).slice();
  const LS_ANSWERS = "pat2-quiz-v2";
  const LS_KEY = "pat2-quiz-key-v1";
  const LS_INK_V3 = "pat2-quiz-ink-v3";
  const LS_INK_V2 = "pat2-quiz-ink-v2";
  const LS_POS = "pat2-quiz-pos-v1";
  const LS_EXAM = "pat2-quiz-exam-v1";
  const DEFAULT_EXAM = {
    title: "ชุดข้อสอบ",
    subtitle: "อ่านโจทย์ ทำข้อสอบ และตรวจคำตอบ"
  };
  const BUNDLED_PAGES = 20;
  const BUNDLED_BASE_WIDTH = 1158;
  const TOOL_RANGES = { pen: [1, 12], hl: [6, 30], eraser: [6, 40] };
  const TOOL_LABELS = { hand: "มือ", pen: "ปากกา", hl: "ไฮไลต์", eraser: "ยางลบ" };

  const $ = (id) => document.getElementById(id);
  const pageStack = $("pageStack");
  const pdfScroll = $("pdfScroll");
  const pageInfo = $("pageTotal");
  const pageInput = $("pageInput");
  const zoomInfo = $("zoomInfo");
  const pdfStatus = $("pdfStatus");
  const docChip = $("docChip");
  const omrGrid = $("omrGrid");
  const statusText = $("statusText");
  const resultBox = $("resultBox");
  const examDate = $("examDate");
  const studentName = $("studentName");
  const keyInfo = $("keyInfo");
  const progressBar = $("progressBar");
  const progressTrack = $("progressTrack");
  const progressLabel = $("progressLabel");
  const scoreChip = $("scoreChip");
  const saveChip = $("saveChip");
  const helpDialog = $("helpDialog");
  const examDialog = $("examDialog");
  const examTitleEl = $("examTitle");
  const examSubtitleEl = $("examSubtitle");
  const sheetSubject = $("sheetSubject");
  const examTitleInput = $("examTitleInput");
  const examSubtitleInput = $("examSubtitleInput");
  const openPdfLink = $("openPdfLink");
  const toastRegion = $("toastRegion");

  let key = loadKey();
  let answers = loadAnswers();
  let allInk = loadInk();
  let positions = loadPositions();
  let examInfo = loadExamInfo();

  let docId = "bundled";
  let baseWidth = BUNDLED_BASE_WIDTH;
  let docPages = BUNDLED_PAGES;
  let pageUrls = [];
  let fit = true;
  let zoom = 1;
  let graded = false;
  let currentPage = 1;
  let omrCols = 0;
  let loadingDoc = false;
  let inkReady = false;
  let pdfDoc = null;
  let externalUrl = null;
  let docGeneration = 0;

  let renderObserver = null;
  let renderQueue = [];
  let renderActive = 0;
  const pageRenderMeta = new Map();

  let inkSaveTimer = null;
  let posSaveTimer = null;
  let savedTimer = null;
  let zoomTimer = null;
  let resizeTimer = null;
  let scrollRaf = null;

  // ---------------- storage ----------------
  function loadKey() {
    const fallback = { list: DEFAULT_KEY.slice(), name: "" };
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return fallback;
      const s = JSON.parse(raw);
      if (s && Array.isArray(s.list) && s.list.length) {
        const list = s.list.map((v) => {
          const n = Number(v);
          return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
        });
        while (list.length && list[list.length - 1] === null) list.pop();
        if (list.length) return { list, name: s.name || "" };
      }
    } catch {}
    return fallback;
  }

  function persistKey() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(key)); } catch {}
  }

  function loadAnswers() {
    try {
      const raw = localStorage.getItem(LS_ANSWERS);
      if (!raw) return { map: {}, name: "", date: "" };
      const s = JSON.parse(raw);
      return { map: s.map || s.answers || {}, name: s.name || "", date: s.date || "" };
    } catch {
      return { map: {}, name: "", date: "" };
    }
  }

  function persistAnswers() {
    try {
      localStorage.setItem(LS_ANSWERS, JSON.stringify({
        map: answers.map,
        name: studentName.value || "",
        date: examDate.value || ""
      }));
    } catch {}
  }

  function migrateInkWidths(obj) {
    Object.keys(obj || {}).forEach((doc) => {
      const pages = obj[doc];
      if (!pages || typeof pages !== "object") return;
      Object.keys(pages).forEach((page) => {
        const strokes = pages[page];
        if (!Array.isArray(strokes)) return;
        strokes.forEach((s) => {
          if (s && s.t === "hl") {
            const old = Number(s.w) || 3;
            s.w = Math.min(30, Math.round(old * 3.6 * 10) / 10);
          }
        });
      });
    });
    return obj;
  }

  function loadInk() {
    try {
      const v3 = localStorage.getItem(LS_INK_V3);
      if (v3) return JSON.parse(v3) || {};
      const v2 = localStorage.getItem(LS_INK_V2);
      if (v2) {
        const migrated = migrateInkWidths(JSON.parse(v2) || {});
        try { localStorage.setItem(LS_INK_V3, JSON.stringify(migrated)); } catch {}
        return migrated;
      }
    } catch {}
    return {};
  }

  function loadPositions() {
    try { return JSON.parse(localStorage.getItem(LS_POS)) || {}; } catch { return {}; }
  }

  function persistPositions() {
    try { localStorage.setItem(LS_POS, JSON.stringify(positions)); } catch {}
  }

  // ---------------- exam info ----------------
  function normalizeExamInfo(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    const title = String(src.title || "").trim().slice(0, 80) || DEFAULT_EXAM.title;
    const subtitle = String(src.subtitle || "").trim().slice(0, 140);
    return { title, subtitle };
  }

  function loadExamInfo() {
    try {
      const raw = localStorage.getItem(LS_EXAM);
      if (raw) return normalizeExamInfo(JSON.parse(raw));
    } catch {}
    return { title: DEFAULT_EXAM.title, subtitle: DEFAULT_EXAM.subtitle };
  }

  function persistExamInfo() {
    try { localStorage.setItem(LS_EXAM, JSON.stringify(examInfo)); } catch {}
  }

  function applyExamInfo() {
    const title = examInfo.title || DEFAULT_EXAM.title;
    examTitleEl.textContent = title;
    examSubtitleEl.textContent = examInfo.subtitle;
    examSubtitleEl.classList.toggle("hidden", !examInfo.subtitle);
    sheetSubject.textContent = examInfo.subtitle || title;
    document.title = `${title} — กระดาษคำตอบ`;
  }

  // ---------------- feedback ----------------
  function toast(message, type, timeout) {
    const kind = type || "info";
    const div = document.createElement("div");
    div.className = "toast " + kind;
    div.setAttribute("role", "status");
    const iconName = kind === "success" ? "i-check" : kind === "error" ? "i-close" : "i-info";
    div.innerHTML = `<svg class="icon"><use href="#${iconName}"></use></svg><span></span>`;
    div.querySelector("span").textContent = message;
    toastRegion.appendChild(div);
    const life = timeout || (kind === "error" ? 7000 : 4000);
    setTimeout(() => {
      div.classList.add("leaving");
      setTimeout(() => div.remove(), 180);
    }, life);
  }

  function showSaved() {
    saveChip.classList.remove("hidden");
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => saveChip.classList.add("hidden"), 1300);
  }

  function setStatus(text, spinning) {
    if (!text) {
      pdfStatus.classList.add("hidden");
      pdfStatus.textContent = "";
      pdfStatus.classList.remove("spinning");
      return;
    }
    pdfStatus.textContent = text;
    pdfStatus.classList.toggle("spinning", !!spinning);
    pdfStatus.classList.remove("hidden");
  }

  function motionBehavior() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  }

  // ---------------- ink persistence ----------------
  function saveInk() {
    if (!inkReady) return;
    allInk[docId] = Ink.serialize();
    if (inkSaveTimer) clearTimeout(inkSaveTimer);
    inkSaveTimer = setTimeout(flushInk, 280);
  }

  function flushInk() {
    if (!inkReady) return;
    if (inkSaveTimer) {
      clearTimeout(inkSaveTimer);
      inkSaveTimer = null;
    }
    allInk[docId] = Ink.serialize();
    try {
      localStorage.setItem(LS_INK_V3, JSON.stringify(allInk));
      showSaved();
    } catch (err) {
      console.warn(err);
      toast("บันทึกลายเส้นไม่สำเร็จ — พื้นที่จัดเก็บของเบราว์เซอร์อาจเต็ม", "error", 8000);
      Ink.noteQuota();
    }
  }

  // ---------------- position persistence ----------------
  function offsetTopInScroll(el) {
    const er = el.getBoundingClientRect();
    const sr = pdfScroll.getBoundingClientRect();
    return er.top - sr.top + pdfScroll.scrollTop;
  }

  function captureAnchor() {
    const els = Array.from(pageStack.querySelectorAll(".page"));
    if (!els.length) return null;
    const y = pdfScroll.scrollTop;
    let chosen = els[0];
    for (const el of els) {
      if (offsetTopInScroll(el) <= y + 1) chosen = el;
      else break;
    }
    const top = offsetTopInScroll(chosen);
    const frac = Math.max(0, Math.min(1, (y - top) / Math.max(1, chosen.offsetHeight)));
    return { page: Number(chosen.dataset.page), frac };
  }

  function restoreAnchor(anchor) {
    const el = pageStack.querySelector(`.page[data-page="${anchor.page}"]`);
    if (!el) return;
    pdfScroll.scrollTop = Math.max(0, offsetTopInScroll(el) + anchor.frac * el.offsetHeight);
    updatePageInfo();
  }

  function savePositionNow() {
    if (!inkReady || !pageStack.querySelector(".page")) return;
    const anchor = captureAnchor();
    if (!anchor) return;
    positions[docId] = {
      page: anchor.page,
      frac: Math.round(anchor.frac * 1000) / 1000,
      fit: !!fit,
      zoom: Math.round(zoom * 1000) / 1000
    };
    persistPositions();
  }

  function schedulePositionSave() {
    if (!inkReady) return;
    if (posSaveTimer) clearTimeout(posSaveTimer);
    posSaveTimer = setTimeout(() => {
      posSaveTimer = null;
      savePositionNow();
    }, 350);
  }

  function restorePosition(id) {
    const pos = positions[id];
    if (pos) {
      fit = pos.fit !== false;
      const z = Number(pos.zoom);
      if (Number.isFinite(z) && z > 0) zoom = Math.max(0.3, Math.min(3.2, z));
    }
    applyZoom({ preserve: false });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const page = Math.max(1, Math.min(docPages, Number(pos && pos.page) || 1));
      const el = pageStack.querySelector(`.page[data-page="${page}"]`);
      if (el && pos) {
        pdfScroll.scrollTop = Math.max(0, offsetTopInScroll(el) + (Number(pos.frac) || 0) * el.offsetHeight);
      } else {
        pdfScroll.scrollTop = 0;
      }
      updatePageInfo();
      schedulePositionSave();
    }));
  }

  // ---------------- tool UI ----------------
  function setToolUI(tool) {
    document.querySelectorAll("#inkTools .tool").forEach((b) => {
      const active = b.dataset.tool === tool;
      b.classList.toggle("active", active);
      b.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function setColorUI(color) {
    document.querySelectorAll(".swatch").forEach((b) => {
      const active = b.dataset.color.toLowerCase() === color.toLowerCase();
      b.classList.toggle("active", active);
      b.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function updateHistoryButtons() {
    const canUndo = Ink.canUndo();
    const canRedo = Ink.canRedo();
    $("undoBtn").disabled = !canUndo;
    $("redoBtn").disabled = !canRedo;
    $("undoBtn").setAttribute("aria-disabled", canUndo ? "false" : "true");
    $("redoBtn").setAttribute("aria-disabled", canRedo ? "false" : "true");
  }

  function refreshToolControls() {
    const tool = Ink.getTool();
    setToolUI(tool);
    const colorTool = tool === "hl" ? "hl" : "pen";
    setColorUI(Ink.getColor(colorTool));
    $("swatches").setAttribute("aria-label", tool === "hl" ? "สีไฮไลต์" : "สีปากกา");

    const range = Ink.sizeRange(tool);
    const size = Ink.getSize(tool);
    $("sizeVal").textContent = tool === "hand" ? "—" : String(size);
    $("sizeDown").disabled = tool === "hand" || size <= range[0];
    $("sizeUp").disabled = tool === "hand" || size >= range[1];
    $("fingerToggle").checked = Ink.getDrawFinger();
    updateHistoryButtons();
  }

  function setTool(tool) {
    Ink.setTool(tool);
    refreshToolControls();
  }

  function changeSize(delta) {
    const tool = Ink.getTool();
    if (tool === "hand") return;
    const value = Ink.getSize(tool) + delta;
    Ink.setSize(value, tool);
    refreshToolControls();
  }

  function pickColor(color) {
    const tool = Ink.getTool() === "hl" ? "hl" : "pen";
    Ink.setColor(color, tool);
    refreshToolControls();
  }

  // ---------------- answer sheet ----------------
  function toAnswerList(value) {
    if (Array.isArray(value)) return value.slice();
    if (value && typeof value === "object") {
      const nums = Object.keys(value).filter((k) => /^\d+$/.test(k));
      if (nums.length) {
        const max = Math.max.apply(null, nums.map(Number));
        const out = [];
        for (let i = 1; i <= max; i++) {
          out.push(value[i] !== undefined ? value[i] : value[String(i)]);
        }
        return out;
      }
    }
    return null;
  }

  function parseKeyText(text) {
    const data = JSON.parse(text);
    let arr = toAnswerList(data);
    if (!arr && data && typeof data === "object") {
      arr = toAnswerList(data.answers) || toAnswerList(data.key) || toAnswerList(data.answerKey);
      if (!arr && data.answers && typeof data.answers === "object") arr = toAnswerList(data.answers.list);
    }
    if (!arr) throw new Error("ไม่พบรูปแบบเฉลยที่รองรับ");
    const out = arr.map((v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
    });
    while (out.length && out[out.length - 1] === null) out.pop();
    if (!out.length) throw new Error("ไม่มีคำตอบที่ถูกต้อง (ต้องเป็นเลข 1–5)");
    return out;
  }

  function renderKeyInfo() {
    const src = key.name ? key.name : "ค่าเริ่มต้น";
    keyInfo.textContent = `เฉลย: ${src} (${key.list.length} ข้อ)`;
  }

  function pruneAnswers() {
    let changed = false;
    const n = key.list.length;
    Object.keys(answers.map).forEach((q) => {
      const num = Number(q);
      const val = Number(answers.map[q]);
      if (!Number.isInteger(num) || num < 1 || num > n || !Number.isInteger(val) || val < 1 || val > 5) {
        delete answers.map[q];
        changed = true;
      }
    });
    if (changed) persistAnswers();
  }

  function omrColumns(n) {
    if (window.innerWidth <= 980) return 1;
    const width = omrGrid.clientWidth || Math.min(760, window.innerWidth - 80);
    let cols = Math.max(1, Math.floor((width + 16) / 206));
    if (n <= 10) cols = 1;
    else if (n <= 20) cols = Math.min(cols, 2);
    else cols = Math.min(cols, 3);
    return Math.max(1, Math.min(cols, n));
  }

  function buildOMR() {
    pruneAnswers();
    omrGrid.innerHTML = "";
    const n = key.list.length;
    omrCols = omrColumns(n);
    const perCol = Math.ceil(n / omrCols);
    if (!n) {
      omrGrid.innerHTML = '<div class="key-info">ไม่มีเฉลย — กรุณาอัปโหลดไฟล์เฉลย</div>';
      updateStatus();
      return;
    }
    for (let c = 0; c < omrCols; c++) {
      const col = document.createElement("div");
      col.className = "omr-col";
      for (let q = c * perCol + 1; q <= Math.min(n, (c + 1) * perCol); q++) {
        const row = document.createElement("div");
        row.className = "omr-row";
        row.dataset.q = String(q);
        const num = document.createElement("div");
        num.className = "qnum";
        num.textContent = q;
        row.appendChild(num);
        for (let v = 1; v <= 5; v++) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "bubble";
          btn.textContent = v;
          btn.dataset.q = String(q);
          btn.dataset.c = String(v);
          btn.setAttribute("aria-label", `ข้อ ${q} ตัวเลือก ${v}`);
          const selected = Number(answers.map[q]) === v;
          if (selected) btn.classList.add("selected");
          btn.setAttribute("aria-pressed", selected ? "true" : "false");
          btn.addEventListener("click", () => pick(q, v));
          row.appendChild(btn);
        }
        col.appendChild(row);
      }
      omrGrid.appendChild(col);
    }
    omrGrid.style.gridTemplateColumns = `repeat(${omrCols}, minmax(0, 1fr))`;
    updateStatus();
    clearMarks();
    if (graded) grade({ focus: false });
  }

  function pick(q, v) {
    if (Number(answers.map[q]) === v) delete answers.map[q];
    else answers.map[q] = v;
    graded = false;
    resultBox.classList.add("hidden");
    scoreChip.classList.add("hidden");
    clearMarks();
    omrGrid.querySelectorAll(`.bubble[data-q="${q}"]`).forEach((b) => {
      const selected = Number(answers.map[q]) === Number(b.dataset.c);
      b.classList.toggle("selected", selected);
      b.setAttribute("aria-pressed", selected ? "true" : "false");
    });
    updateStatus();
    persistAnswers();
    schedulePositionSave();
  }

  function clearMarks() {
    omrGrid.querySelectorAll(".omr-row").forEach((r) => r.classList.remove("correct", "wrong", "unanswered"));
    omrGrid.querySelectorAll(".bubble").forEach((b) => b.classList.remove("answer-key"));
  }

  function updateStatus() {
    const n = key.list.length;
    let answered = 0;
    Object.keys(answers.map).forEach((q) => {
      const num = Number(q);
      const val = Number(answers.map[q]);
      if (num >= 1 && num <= n && val >= 1 && val <= 5) answered++;
    });
    const pct = n ? Math.round((answered / n) * 100) : 0;
    statusText.textContent = `ตอบแล้ว ${answered} / ${n}`;
    progressLabel.textContent = `${answered} / ${n}`;
    progressBar.style.width = pct + "%";
    progressTrack.setAttribute("aria-valuemax", String(n));
    progressTrack.setAttribute("aria-valuenow", String(answered));
  }

  function scrollRowIntoView(q) {
    const row = omrGrid.querySelector(`.omr-row[data-q="${q}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: motionBehavior(), block: "center" });
    setTimeout(() => {
      const bubble = row.querySelector(".bubble");
      if (bubble) bubble.focus({ preventScroll: true });
    }, motionBehavior() === "auto" ? 0 : 300);
  }

  function focusBubble(q) {
    const bubble = omrGrid.querySelector(`.omr-row[data-q="${q}"] .bubble`);
    if (bubble) bubble.focus({ preventScroll: true });
  }

  function grade(opts) {
    const focus = !opts || opts.focus !== false;
    graded = true;
    clearMarks();
    const n = key.list.length;
    let correct = 0, wrong = 0, unanswered = 0, invalid = 0;
    let firstIssue = null;
    for (let q = 1; q <= n; q++) {
      const row = omrGrid.querySelector(`.omr-row[data-q="${q}"]`);
      if (!row) continue;
      const k = key.list[q - 1];
      const ans = answers.map[q] == null ? null : Number(answers.map[q]);
      const keyBubble = k ? row.querySelector(`.bubble[data-c="${k}"]`) : null;
      if (keyBubble) keyBubble.classList.add("answer-key");
      if (!k) {
        invalid++;
        row.classList.add("unanswered");
        if (firstIssue == null) firstIssue = q;
        continue;
      }
      if (ans == null) {
        unanswered++;
        row.classList.add("unanswered");
        if (firstIssue == null) firstIssue = q;
      } else if (ans === k) {
        correct++;
        row.classList.add("correct");
      } else {
        wrong++;
        row.classList.add("wrong");
        if (firstIssue == null) firstIssue = q;
      }
    }
    const scored = n - invalid;
    const pct = scored ? Math.round((correct / scored) * 100) : 0;
    resultBox.classList.remove("hidden");
    resultBox.innerHTML =
      `<div class="score">คะแนน ${correct} / ${scored} (${pct}%)</div>` +
      `<div class="detail">ถูก ${correct} ข้อ · ผิด ${wrong} ข้อ · ไม่ตอบ ${unanswered} ข้อ` +
      (invalid ? ` · เฉลยไม่ถูกต้อง ${invalid} ข้อ` : "") + `</div>` +
      `<div class="legend">` +
      `<span><span class="dot ok"></span>ถูก</span>` +
      `<span><span class="dot bad"></span>ผิด (วงแหวน = เฉลย)</span>` +
      `<span><span class="dot warn"></span>ไม่ตอบ</span>` +
      `</div>`;

    scoreChip.classList.remove("hidden", "ok", "warn", "bad");
    if (wrong === 0 && unanswered === 0 && invalid === 0) {
      scoreChip.classList.add("ok");
      scoreChip.textContent = `ถูก ${correct}/${scored}`;
    } else if (wrong > 0) {
      scoreChip.classList.add("bad");
      scoreChip.textContent = `ถูก ${correct}/${scored}`;
    } else {
      scoreChip.classList.add("warn");
      scoreChip.textContent = `ถูก ${correct}/${scored}`;
    }

    if (focus) {
      if (firstIssue != null) scrollRowIntoView(firstIssue);
      else resultBox.scrollIntoView({ behavior: motionBehavior(), block: "nearest" });
    }
  }

  function nextBlank() {
    const n = key.list.length;
    for (let q = 1; q <= n; q++) {
      if (answers.map[q] == null) {
        scrollRowIntoView(q);
        return;
      }
    }
    toast("ตอบครบทุกข้อแล้ว", "success");
  }

  function clearAnswers() {
    if (Object.keys(answers.map).length && !confirm("ล้างคำตอบทั้งหมด?")) return;
    answers.map = {};
    graded = false;
    resultBox.classList.add("hidden");
    scoreChip.classList.add("hidden", "ok", "warn", "bad");
    clearMarks();
    omrGrid.querySelectorAll(".bubble").forEach((b) => {
      b.classList.remove("selected");
      b.setAttribute("aria-pressed", "false");
    });
    updateStatus();
    persistAnswers();
    toast("ล้างคำตอบแล้ว", "info");
  }

  // ---------------- pages ----------------
  function revokeUrls() {
    pageUrls.forEach((u) => { try { URL.revokeObjectURL(u); } catch {} });
    pageUrls = [];
  }

  function closePdf() {
    if (pdfDoc) {
      try { window.PdfLoader.close(pdfDoc); } catch {}
      pdfDoc = null;
    }
  }

  function disconnectObserver() {
    if (renderObserver) {
      try { renderObserver.disconnect(); } catch {}
      renderObserver = null;
    }
    renderQueue = [];
    renderActive = 0;
    pageRenderMeta.clear();
  }

  function buildPages(items) {
    disconnectObserver();
    pageStack.innerHTML = "";
    items.forEach((it) => {
      const el = document.createElement("div");
      el.className = "page";
      el.dataset.page = String(it.num);
      const w = it.width || BUNDLED_BASE_WIDTH;
      const h = it.height || 1638;
      el.style.aspectRatio = `${w} / ${h}`;
      const img = document.createElement("img");
      img.className = "page-img";
      img.alt = `ข้อสอบหน้า ${it.num}`;
      img.decoding = "async";
      img.loading = it.eager ? "eager" : "lazy";
      img.width = Math.round(w);
      img.height = Math.round(h);
      const canvas = document.createElement("canvas");
      canvas.className = "ink";
      el.appendChild(img);
      el.appendChild(canvas);
      if (!it.src) {
        const ph = document.createElement("div");
        ph.className = "page-loading";
        ph.textContent = "กำลังเตรียมหน้า…";
        el.appendChild(ph);
        el.dataset.renderState = "idle";
        pageRenderMeta.set(it.num, {
          num: it.num,
          el,
          state: "idle",
          url: null,
          renderedWidth: 0,
          targetWidth: 0
        });
      } else {
        el.dataset.renderState = "bundled";
        img.addEventListener("load", () => {
          const ph = el.querySelector(".page-loading");
          if (ph) ph.remove();
          Ink.refresh(it.num);
        });
        img.addEventListener("error", () => {
          const ph = document.createElement("div");
          ph.className = "page-loading error";
          ph.textContent = "โหลดหน้านี้ไม่สำเร็จ";
          el.appendChild(ph);
        });
        img.src = it.src;
      }
      pageStack.appendChild(el);
    });
  }

  function attachInk() {
    pageStack.querySelectorAll(".page").forEach((el) => {
      Ink.attachPage(el, Number(el.dataset.page));
    });
  }

  function pageEls() {
    return Array.from(pageStack.querySelectorAll(".page"));
  }

  function displayedWidth() {
    const el = pageStack.querySelector(".page");
    return el ? el.getBoundingClientRect().width : baseWidth * zoom;
  }

  function effectiveZoom() {
    const w = displayedWidth();
    return w > 0 ? w / baseWidth : zoom;
  }

  function applyZoom(opts) {
    const preserve = !opts || opts.preserve !== false;
    const avail = Math.max(280, pdfScroll.clientWidth - 34);
    const targetW = fit
      ? Math.min(avail, Math.round(baseWidth * 1.6))
      : Math.round(baseWidth * zoom);
    const anchor = preserve ? captureAnchor() : null;
    pageStack.querySelectorAll(".page").forEach((p) => { p.style.width = targetW + "px"; });
    zoomInfo.textContent = fit ? "พอดี" : Math.round((targetW / baseWidth) * 100) + "%";
    requestAnimationFrame(() => {
      Ink.refreshAll();
      if (anchor) restoreAnchor(anchor);
      scheduleResolutionRefresh();
    });
  }

  function zoomBy(delta) {
    const current = effectiveZoom();
    fit = false;
    zoom = Math.max(0.3, Math.min(3.2, Math.round((current + delta) * 100) / 100));
    applyZoom();
    schedulePositionSave();
  }

  function fitWidth() {
    fit = true;
    applyZoom();
    schedulePositionSave();
  }

  function updatePageInfo() {
    const els = pageEls();
    if (!els.length) {
      pageInfo.textContent = "/ 1";
      pageInput.value = "1";
      return;
    }
    const probe = pdfScroll.scrollTop + 80;
    let cur = 1;
    for (const el of els) {
      if (offsetTopInScroll(el) <= probe) cur = Number(el.dataset.page);
      else break;
    }
    currentPage = cur;
    pageInfo.textContent = "/ " + els.length;
    pageInput.max = String(els.length);
    if (document.activeElement !== pageInput) pageInput.value = String(cur);
    Ink.setActivePage(cur);
    schedulePositionSave();
  }

  function goToPage(value, smooth) {
    const els = pageEls();
    if (!els.length) return;
    const n = Math.max(1, Math.min(els.length, Math.round(Number(value)) || 1));
    const el = els[n - 1];
    pdfScroll.scrollTo({
      top: Math.max(0, offsetTopInScroll(el)),
      behavior: smooth === false ? "auto" : motionBehavior()
    });
    currentPage = n;
    pageInput.value = String(n);
    Ink.setActivePage(n);
    schedulePositionSave();
  }

  // ---------------- lazy PDF rendering ----------------
  function setupLazyRendering(gen) {
    if (!("IntersectionObserver" in window)) {
      pageRenderMeta.forEach((meta) => queueRender(meta.num, gen));
      return;
    }
    renderObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) queueRender(Number(entry.target.dataset.page), gen);
      });
    }, { root: pdfScroll, rootMargin: "900px 0px" });
    pageStack.querySelectorAll('.page[data-render-state="idle"]').forEach((el) => {
      renderObserver.observe(el);
    });
    queueRender(1, gen);
    queueRender(2, gen);
  }

  function queueRender(num, gen) {
    if (gen !== docGeneration) return;
    const meta = pageRenderMeta.get(num);
    if (!meta || meta.state === "pending" || meta.state === "done" || meta.state === "error") return;
    meta.state = "pending";
    meta.el.dataset.renderState = "pending";
    renderQueue.push(num);
    pumpRenderQueue(gen);
  }

  function pumpRenderQueue(gen) {
    if (renderActive > 0 || gen !== docGeneration || !pdfDoc) return;
    const num = renderQueue.shift();
    if (num === undefined) return;
    const meta = pageRenderMeta.get(num);
    if (!meta || meta.state !== "pending") {
      pumpRenderQueue(gen);
      return;
    }
    renderActive = 1;
    renderPageFor(meta, gen);
  }

  function renderPageFor(meta, gen) {
    const doc = pdfDoc;
    if (!doc) {
      renderActive = 0;
      return;
    }
    const el = meta.el;
    const cssW = el.getBoundingClientRect().width || Math.round(baseWidth * zoom) || 800;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const target = Math.max(700, Math.min(2200, Math.round(cssW * dpr * 1.12)));
    meta.targetWidth = target;
    const ph = el.querySelector(".page-loading");
    if (ph && !ph.classList.contains("error")) ph.textContent = "กำลังเรนเดอร์…";

    window.PdfLoader.renderPage(doc, meta.num, target).then((rendered) => {
      if (gen !== docGeneration || doc !== pdfDoc) {
        try { URL.revokeObjectURL(rendered.url); } catch {}
        return;
      }
      if (meta.url) {
        try { URL.revokeObjectURL(meta.url); } catch {}
      }
      meta.url = rendered.url;
      meta.renderedWidth = rendered.width;
      meta.state = "done";
      pageUrls.push(rendered.url);
      el.dataset.renderState = "done";
      el.style.aspectRatio = `${rendered.width} / ${rendered.height}`;
      const img = el.querySelector("img");
      img.width = rendered.width;
      img.height = rendered.height;
      img.addEventListener("load", () => {
        const loading = el.querySelector(".page-loading");
        if (loading) loading.remove();
        Ink.refresh(meta.num);
      }, { once: true });
      img.src = rendered.url;
      if (renderObserver) {
        try { renderObserver.unobserve(el); } catch {}
      }
    }).catch((err) => {
      if (gen !== docGeneration) return;
      console.warn(err);
      meta.state = "error";
      el.dataset.renderState = "error";
      let loading = el.querySelector(".page-loading");
      if (!loading) {
        loading = document.createElement("div");
        loading.className = "page-loading";
        el.appendChild(loading);
      }
      loading.classList.add("error");
      loading.textContent = "โหลดหน้านี้ไม่สำเร็จ";
      toast(`โหลดหน้า ${meta.num} ไม่สำเร็จ`, "error");
    }).finally(() => {
      if (gen === docGeneration) {
        renderActive = 0;
        pumpRenderQueue(gen);
      }
    });
  }

  function scheduleResolutionRefresh() {
    if (zoomTimer) clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => {
      zoomTimer = null;
      if (!pdfDoc || !inkReady) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      pageStack.querySelectorAll('.page[data-render-state="done"]').forEach((el) => {
        const num = Number(el.dataset.page);
        const meta = pageRenderMeta.get(num);
        if (!meta) return;
        const cssW = el.getBoundingClientRect().width;
        const wanted = Math.max(700, Math.min(2200, Math.round(cssW * dpr * 1.12)));
        if (wanted > meta.renderedWidth * 1.25 && wanted > meta.renderedWidth + 200) {
          meta.state = "idle";
          el.dataset.renderState = "idle";
          queueRender(num, docGeneration);
        }
      });
    }, 320);
  }

  // ---------------- document loading ----------------
  function revokeExternalUrl() {
    if (externalUrl) {
      try { URL.revokeObjectURL(externalUrl); } catch {}
      externalUrl = null;
    }
  }

  function setExternalLink(href, title) {
    openPdfLink.href = href;
    openPdfLink.title = title || "เปิด PDF";
    openPdfLink.setAttribute("aria-label", title || "เปิด PDF");
  }

  function prepareNewDoc() {
    if (inkReady) {
      flushInk();
      savePositionNow();
    }
    inkReady = false;
  }

  async function loadBundled() {
    if (loadingDoc) return;
    loadingDoc = true;
    const gen = ++docGeneration;
    prepareNewDoc();
    setStatus("กำลังโหลดไฟล์ตัวอย่าง…", true);
    try {
      closePdf();
      revokeUrls();
      docId = "bundled";
      baseWidth = BUNDLED_BASE_WIDTH;
      docPages = BUNDLED_PAGES;
      fit = true;
      zoom = 1;
      const items = [];
      for (let i = 1; i <= BUNDLED_PAGES; i++) {
        items.push({
          num: i,
          src: `pages/page-${String(i).padStart(2, "0")}.png`,
          width: 1158,
          height: 1638,
          eager: i <= 3
        });
      }
      buildPages(items);
      Ink.setDocument(docId, allInk[docId] || (allInk[docId] = {}));
      attachInk();
      inkReady = true;
      applyZoom({ preserve: false });
      revokeExternalUrl();
      setExternalLink("pdf/source.pdf", "เปิด PDF ตัวอย่าง");
      docChip.textContent = `ไฟล์ตัวอย่าง · ${BUNDLED_PAGES} หน้า`;
      docChip.title = "ไฟล์ตัวอย่าง";
      setStatus("");
      updatePageInfo();
      restorePosition(docId);
    } catch (err) {
      console.error(err);
      setStatus("");
      toast("โหลดไฟล์ตัวอย่างไม่สำเร็จ", "error");
    } finally {
      if (gen === docGeneration) loadingDoc = false;
    }
  }

  async function loadUploaded(file) {
    if (loadingDoc) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
      toast("กรุณาเลือกไฟล์ PDF", "error");
      return;
    }
    loadingDoc = true;
    const gen = ++docGeneration;
    setStatus("กำลังอ่านไฟล์ PDF…", true);
    let pdf = null;
    try {
      pdf = await window.PdfLoader.openFile(file);
      if (gen !== docGeneration) {
        window.PdfLoader.close(pdf);
        return;
      }
      const count = pdf.numPages;
      let dims;
      if (count <= 80) {
        dims = await Promise.all(Array.from({ length: count }, (_, i) =>
          window.PdfLoader.pageInfo(pdf, i + 1).catch(() => ({ width: 1158, height: 1638 }))
        ));
      } else {
        const first = await window.PdfLoader.pageInfo(pdf, 1)
          .catch(() => ({ width: 1158, height: 1638 }));
        dims = Array.from({ length: count }, () => first);
      }
      if (gen !== docGeneration) {
        window.PdfLoader.close(pdf);
        return;
      }

      // The new PDF opened successfully: only now discard the old document.
      prepareNewDoc();
      closePdf();
      revokeUrls();
      pdfDoc = pdf;
      docId = `file|${file.name}|${file.size}|${file.lastModified || 0}`;
      baseWidth = dims[0].width || 1158;
      docPages = count;
      fit = true;
      zoom = 1;
      const items = [];
      for (let i = 1; i <= count; i++) {
        const d = dims[i - 1] || dims[0];
        items.push({ num: i, width: d.width, height: d.height, eager: i <= 2 });
      }
      buildPages(items);
      Ink.setDocument(docId, allInk[docId] || (allInk[docId] = {}));
      attachInk();
      inkReady = true;
      applyZoom({ preserve: false });
      revokeExternalUrl();
      externalUrl = URL.createObjectURL(file);
      setExternalLink(externalUrl, file.name);
      docChip.textContent = `${file.name} · ${count} หน้า`;
      docChip.title = file.name;
      updatePageInfo();
      setupLazyRendering(gen);
      restorePosition(docId);
      setStatus("");
      toast(`เปิด ${file.name} แล้ว (${count} หน้า)`, "success");
    } catch (err) {
      console.warn(err);
      if (pdf && pdf !== pdfDoc) window.PdfLoader.close(pdf);
      if (gen === docGeneration) {
        setStatus("");
        toast("เปิดไฟล์ PDF ไม่สำเร็จ: " + (err && err.message ? err.message : "ไฟล์อาจเสียหรือมีการใส่รหัสผ่าน"), "error");
      }
    } finally {
      if (gen === docGeneration) loadingDoc = false;
    }
  }

  // ---------------- wiring ----------------
  function wireTools() {
    document.querySelectorAll("#inkTools .tool").forEach((btn) => {
      btn.addEventListener("click", () => setTool(btn.dataset.tool));
    });
    document.querySelectorAll(".swatch").forEach((btn) => {
      btn.addEventListener("click", () => pickColor(btn.dataset.color));
    });
    $("sizeDown").addEventListener("click", () => changeSize(-1));
    $("sizeUp").addEventListener("click", () => changeSize(1));
    $("fingerToggle").addEventListener("change", (e) => Ink.setDrawFinger(e.target.checked));

    $("undoBtn").addEventListener("click", () => Ink.undo());
    $("redoBtn").addEventListener("click", () => Ink.redo());
    $("clearPageBtn").addEventListener("click", () => {
      if (Ink.clearPage(currentPage)) toast(`ล้างลายเส้นหน้า ${currentPage} แล้ว`, "info");
      else toast("หน้านี้ยังไม่มีลายเส้น", "info");
    });
    $("clearInkBtn").addEventListener("click", () => {
      if (!confirm("ล้างลายเส้นทั้งหมดของไฟล์นี้?")) return;
      if (Ink.clearDocument()) toast("ล้างลายเส้นทั้งหมดแล้ว", "info");
      else toast("ยังไม่มีลายเส้นให้ล้าง", "info");
    });

    $("uploadPdfBtn").addEventListener("click", () => $("pdfFile").click());
    $("pdfFile").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) loadUploaded(f);
      e.target.value = "";
    });
    $("resetPdfBtn").addEventListener("click", () => loadBundled());

    const panel = $("pdfPanel");
    ["dragenter", "dragover"].forEach((ev) =>
      panel.addEventListener(ev, (e) => {
        if (!e.dataTransfer) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        panel.classList.add("drag-over");
      })
    );
    ["dragleave", "dragend"].forEach((ev) =>
      panel.addEventListener(ev, () => panel.classList.remove("drag-over"))
    );
    panel.addEventListener("drop", (e) => {
      e.preventDefault();
      panel.classList.remove("drag-over");
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadUploaded(f);
    });
    panel.addEventListener("dragleave", (e) => {
      if (!e.relatedTarget || !panel.contains(e.relatedTarget)) panel.classList.remove("drag-over");
    });

    $("zoomIn").addEventListener("click", () => zoomBy(0.12));
    $("zoomOut").addEventListener("click", () => zoomBy(-0.12));
    $("fitWidth").addEventListener("click", fitWidth);
    $("prevPage").addEventListener("click", () => goToPage(currentPage - 1));
    $("nextPage").addEventListener("click", () => goToPage(currentPage + 1));

    pageInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        goToPage(pageInput.value);
        pageInput.blur();
      }
    });
    pageInput.addEventListener("change", () => goToPage(pageInput.value));

    $("uploadKeyBtn").addEventListener("click", () => $("keyFile").click());
    $("keyFile").addEventListener("change", async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!f) return;
      try {
        const list = parseKeyText(await f.text());
        key = { list, name: f.name };
        persistKey();
        renderKeyInfo();
        graded = false;
        resultBox.classList.add("hidden");
        scoreChip.classList.add("hidden", "ok", "warn", "bad");
        buildOMR();
        toast(`นำเข้าเฉลย ${list.length} ข้อแล้ว`, "success");
      } catch (err) {
        toast("อ่านไฟล์เฉลยไม่สำเร็จ: " + (err && err.message ? err.message : "รูปแบบไม่ถูกต้อง"), "error");
      }
    });
    $("resetKeyBtn").addEventListener("click", () => {
      key = { list: DEFAULT_KEY.slice(), name: "" };
      persistKey();
      renderKeyInfo();
      graded = false;
      resultBox.classList.add("hidden");
      scoreChip.classList.add("hidden", "ok", "warn", "bad");
      buildOMR();
      toast("คืนค่าเฉลยเริ่มต้นแล้ว", "success");
    });

    $("submitBtn").addEventListener("click", () => grade());
    $("clearBtn").addEventListener("click", clearAnswers);
    $("nextBlankBtn").addEventListener("click", nextBlank);

    $("editExamBtn").addEventListener("click", openExamDialog);
    $("examClose").addEventListener("click", closeExamDialog);
    $("examCancel").addEventListener("click", closeExamDialog);
    $("examForm").addEventListener("submit", (e) => {
      e.preventDefault();
      saveExamDialog();
    });
    examDialog.addEventListener("click", (e) => {
      if (e.target === examDialog) closeExamDialog();
    });

    $("helpBtn").addEventListener("click", openHelp);
    $("helpClose").addEventListener("click", () => helpDialog.close());
    $("helpDone").addEventListener("click", () => helpDialog.close());
    helpDialog.addEventListener("click", (e) => {
      if (e.target === helpDialog) helpDialog.close();
    });

    document.querySelectorAll(".mobile-tabs .tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".mobile-tabs .tab").forEach((t) => {
          const active = t === tab;
          t.classList.toggle("active", active);
          t.setAttribute("aria-selected", active ? "true" : "false");
        });
        $("pdfPanel").classList.toggle("active-panel", tab.dataset.tab === "pdf");
        $("sheetPanel").classList.toggle("active-panel", tab.dataset.tab === "sheet");
        if (tab.dataset.tab === "pdf") {
          requestAnimationFrame(() => {
            applyZoom({ preserve: true });
            updatePageInfo();
            Ink.refreshAll();
          });
        }
      });
    });

    pdfScroll.addEventListener("scroll", () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = null;
        updatePageInfo();
      });
    }, { passive: true });

    window.addEventListener("resize", handleResize);
    if ("ResizeObserver" in window) {
      const ro = new ResizeObserver(handleResize);
      ro.observe(pdfScroll);
    }

    window.addEventListener("beforeunload", () => {
      if (inkReady) flushInk();
      savePositionNow();
    });
  }

  function handleResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      applyZoom({ preserve: true });
      updatePageInfo();
      const cols = omrColumns(key.list.length);
      if (cols !== omrCols) buildOMR();
    }, 140);
  }

  function openExamDialog() {
    examTitleInput.value = examInfo.title;
    examSubtitleInput.value = examInfo.subtitle;
    if (typeof examDialog.showModal === "function") {
      if (!examDialog.open) examDialog.showModal();
    } else {
      examDialog.setAttribute("open", "");
    }
    requestAnimationFrame(() => {
      examTitleInput.focus();
      examTitleInput.select();
    });
  }

  function closeExamDialog() {
    if (examDialog.open) examDialog.close();
    else examDialog.removeAttribute("open");
  }

  function saveExamDialog() {
    examInfo = normalizeExamInfo({
      title: examTitleInput.value,
      subtitle: examSubtitleInput.value
    });
    persistExamInfo();
    applyExamInfo();
    closeExamDialog();
    toast("บันทึกข้อมูลชุดข้อสอบแล้ว", "success");
  }

  function openHelp() {
    if (typeof helpDialog.showModal === "function") {
      if (!helpDialog.open) helpDialog.showModal();
    } else {
      helpDialog.setAttribute("open", "");
    }
  }

  function wireKeyboard() {
    document.addEventListener("keydown", (e) => {
      if (examDialog.open) {
        if (e.key === "Escape") closeExamDialog();
        return;
      }
      if (helpDialog.open) {
        if (e.key === "Escape") helpDialog.close();
        return;
      }
      const target = e.target;
      const tag = target && target.tagName ? target.tagName.toLowerCase() : "";
      if (tag === "input" || tag === "textarea" || tag === "select" || (target && target.isContentEditable)) return;

      const mod = e.ctrlKey || e.metaKey;
      const keyLower = (e.key || "").toLowerCase();

      if (mod && keyLower === "z") {
        e.preventDefault();
        if (e.shiftKey) Ink.redo();
        else Ink.undo();
        return;
      }
      if (mod && keyLower === "y") {
        e.preventDefault();
        Ink.redo();
        return;
      }
      if (mod && (e.key === "+" || e.key === "=")) {
        e.preventDefault();
        zoomBy(0.12);
        return;
      }
      if (mod && e.key === "-") {
        e.preventDefault();
        zoomBy(-0.12);
        return;
      }
      if (e.key === "PageUp") {
        e.preventDefault();
        goToPage(currentPage - 1);
        return;
      }
      if (e.key === "PageDown") {
        e.preventDefault();
        goToPage(currentPage + 1);
        return;
      }
      if (e.key === "Escape") {
        setTool("hand");
        return;
      }
      if (e.key === "[") {
        changeSize(-1);
        return;
      }
      if (e.key === "]") {
        changeSize(1);
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        openHelp();
        return;
      }
      if (mod) return;
      const map = { p: "pen", h: "hl", e: "eraser", v: "hand" };
      const tool = map[keyLower];
      if (tool) {
        setTool(tool);
      }
    });
  }

  // ---------------- init ----------------
  function todayThai() {
    try {
      return new Date().toLocaleDateString("th-TH", {
        year: "numeric",
        month: "long",
        day: "numeric"
      });
    } catch {
      return new Date().toLocaleDateString();
    }
  }

  function init() {
    applyExamInfo();
    studentName.value = answers.name || "";
    studentName.addEventListener("input", persistAnswers);
    examDate.value = answers.date || todayThai();
    examDate.addEventListener("input", persistAnswers);

    Ink.init({ onChange: saveInk, onHistory: updateHistoryButtons });
    refreshToolControls();
    renderKeyInfo();
    buildOMR();
    wireTools();
    wireKeyboard();
    loadBundled();
  }

  init();
})();
