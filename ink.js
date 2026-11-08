(function () {
  "use strict";

  const PREF_KEY = "pat2-quiz-prefs-v2";
  const LEGACY_PREF_KEY = "pat2-quiz-prefs-v1";
  const MAX_HISTORY = 80;

  const DEFAULT_PREFS = {
    tool: "hand",
    penColor: "#dc2626",
    hlColor: "#f59e0b",
    sizes: { pen: 3, hl: 12, eraser: 18 },
    drawFinger: false
  };
  const SIZE_RANGES = { pen: [1, 12], hl: [6, 30], eraser: [6, 40] };

  const pages = new Map();
  let prefs = loadPrefs();
  let store = {};
  let undoStack = [];
  let redoStack = [];
  let onChange = function () {};
  let onHistory = function () {};
  let lastPenAt = 0;
  let lastActivePage = 1;
  let warnedQuota = false;

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function normalizePrefs(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    const out = Object.assign({}, DEFAULT_PREFS, src);
    const sizes = Object.assign({}, DEFAULT_PREFS.sizes, src.sizes || {});
    out.tool = ["hand", "pen", "hl", "eraser"].includes(out.tool) ? out.tool : "hand";
    out.sizes = {
      pen: clamp(Math.round(Number(sizes.pen) || DEFAULT_PREFS.sizes.pen), 1, 12),
      hl: clamp(Math.round(Number(sizes.hl) || DEFAULT_PREFS.sizes.hl), 6, 30),
      eraser: clamp(Math.round(Number(sizes.eraser) || DEFAULT_PREFS.sizes.eraser), 6, 40)
    };
    if (!/^#[0-9a-f]{6}$/i.test(out.penColor || "")) out.penColor = DEFAULT_PREFS.penColor;
    if (!/^#[0-9a-f]{6}$/i.test(out.hlColor || "")) out.hlColor = DEFAULT_PREFS.hlColor;
    out.drawFinger = !!out.drawFinger;
    return out;
  }

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(PREF_KEY);
      if (raw) return normalizePrefs(JSON.parse(raw));
      const legacy = localStorage.getItem(LEGACY_PREF_KEY);
      if (legacy) {
        const old = JSON.parse(legacy) || {};
        const color = /^#[0-9a-f]{6}$/i.test(old.color || "") ? old.color : "#dc2626";
        const width = clamp(Math.round(Number(old.width) || 3), 1, 12);
        const migrated = normalizePrefs({
          tool: old.tool,
          penColor: color,
          hlColor: color,
          sizes: {
            pen: width,
            hl: clamp(Math.round(width * 3.6), 6, 30),
            eraser: 18
          },
          drawFinger: old.drawFinger
        });
        try { localStorage.setItem(PREF_KEY, JSON.stringify(migrated)); } catch {}
        return migrated;
      }
    } catch {}
    return normalizePrefs(DEFAULT_PREFS);
  }

  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {}
  }

  function reportQuota() {
    if (warnedQuota) return;
    warnedQuota = true;
    console.warn("บันทึกลายเส้นไม่สำเร็จ: พื้นที่ localStorage อาจเต็ม");
  }

  function pressureOf(e) {
    if (e.pointerType === "pen") {
      const p = typeof e.pressure === "number" ? e.pressure : 0.5;
      return p > 0 ? clamp(p, 0.05, 1) : 0.5;
    }
    return 0.5;
  }

  function effectiveTool(e) {
    const barrelEraser =
      e.pointerType === "eraser" ||
      (e.pointerType === "pen" && e.button === 5) ||
      (e.pointerType === "pen" && (e.buttons & 32) === 32);
    return barrelEraser ? "eraser" : prefs.tool;
  }

  // ---------- history ----------
  function snapshot() {
    const snap = {};
    Object.keys(store).forEach((key) => { snap[key] = (store[key] || []).slice(); });
    return snap;
  }

  function applySnapshot(snap) {
    Object.keys(store).forEach((key) => {
      if (!(key in snap)) delete store[key];
    });
    Object.keys(snap).forEach((key) => {
      store[key] = snap[key].slice();
    });
    pages.forEach((p) => {
      p.strokes = store[p.num] || (store[p.num] = []);
      redraw(p);
    });
  }

  function notifyHistory() {
    try { onHistory(); } catch (err) { console.error(err); }
  }

  function commit(before) {
    undoStack.push(before);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
    onChange();
    notifyHistory();
  }

  // ---------- rendering ----------
  function drawStroke(ctx, s, w, h) {
    const pts = s.pts;
    if (!pts || !pts.length) return;
    ctx.save();
    ctx.strokeStyle = s.c;
    ctx.fillStyle = s.c;
    if (s.t === "hl") {
      ctx.globalAlpha = 0.32;
      ctx.lineCap = "butt";
      ctx.lineJoin = "round";
    } else {
      ctx.globalAlpha = 1;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    }

    if (pts.length === 1) {
      const p = pts[0];
      const radius = s.t === "hl"
        ? Math.max(1, s.w / 2)
        : Math.max(0.6, (s.w * (0.4 + 0.9 * p.p)) / 2);
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    if (s.t === "hl") {
      // One path per highlighter stroke: overlapping segments would otherwise
      // compound the alpha and create dark joints.
      ctx.lineWidth = Math.max(1, s.w);
      ctx.beginPath();
      ctx.moveTo(pts[0].x * w, pts[0].y * h);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x * w, pts[i].y * h);
      ctx.stroke();
      ctx.restore();
      return;
    }

    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const pr = (a.p + b.p) / 2;
      const width = Math.max(1, s.w * (0.35 + 1.05 * pr));
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(a.x * w, a.y * h);
      ctx.lineTo(b.x * w, b.y * h);
      ctx.stroke();
    }
    ctx.restore();
  }

  function redraw(p) {
    const r = p.canvas.getBoundingClientRect();
    const w = Math.max(1, r.width), h = Math.max(1, r.height);
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (p.canvas.width !== bw || p.canvas.height !== bh) {
      p.canvas.width = bw;
      p.canvas.height = bh;
    }
    p.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    p.ctx.clearRect(0, 0, w, h);
    p.w = w;
    p.h = h;
    const list = p.strokes;
    for (let i = 0; i < list.length; i++) drawStroke(p.ctx, list[i], w, h);
  }

  // ---------- eraser ----------
  function eraseAt(p, x, y) {
    const R = prefs.sizes.eraser;
    const keep = [];
    let removed = 0;
    for (const s of p.strokes) {
      const half = Math.max(1.5, s.w * 0.8);
      const hit = s.pts.some((pt) => {
        const dx = (pt.x - x) * p.w;
        const dy = (pt.y - y) * p.h;
        const lim = R + half;
        return dx * dx + dy * dy <= lim * lim;
      });
      if (hit) removed++;
      else keep.push(s);
    }
    if (removed) {
      p.strokes = keep;
      store[p.num] = keep;
      p.changed = true;
      redraw(p);
    }
  }

  // ---------- pointers ----------
  function pageFromEvent(e) {
    const el = e.currentTarget.closest(".page");
    const num = Number(el && el.dataset.page);
    return pages.get(num);
  }

  function posIn(p, clientX, clientY) {
    const r = p.canvas.getBoundingClientRect();
    return { x: (clientX - r.left) / r.width, y: (clientY - r.top) / r.height };
  }

  function hideRing(p) {
    if (p && p.ring) p.ring.style.display = "none";
  }

  function updateRing(p, e) {
    if (!p || !p.ring) return;
    if (effectiveTool(e) !== "eraser" || e.pointerType === "touch") {
      hideRing(p);
      return;
    }
    const r = p.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (x < 0 || y < 0 || x > r.width || y > r.height) {
      hideRing(p);
      return;
    }
    const R = prefs.sizes.eraser;
    p.ring.style.width = (R * 2) + "px";
    p.ring.style.height = (R * 2) + "px";
    p.ring.style.left = x + "px";
    p.ring.style.top = y + "px";
    p.ring.style.display = "block";
  }

  function onDown(e) {
    const p = pageFromEvent(e);
    if (!p) return;
    const tool = effectiveTool(e);

    if (e.pointerType === "touch") {
      if (!prefs.drawFinger) return;
      if (Date.now() - lastPenAt < 2000) return;
    }
    if (e.pointerType === "pen") lastPenAt = Date.now();
    if (tool === "hand") return;

    e.preventDefault();
    lastActivePage = p.num;
    try { p.canvas.setPointerCapture(e.pointerId); } catch {}

    p.beforeDoc = snapshot();
    p.changed = false;
    p.activePointer = e.pointerId;
    p.activeTool = tool;

    if (tool === "eraser") {
      p.erasing = true;
      const c = posIn(p, e.clientX, e.clientY);
      eraseAt(p, c.x, c.y);
      updateRing(p, e);
      return;
    }

    const c = posIn(p, e.clientX, e.clientY);
    const isHl = tool === "hl";
    p.drawing = {
      t: isHl ? "hl" : "pen",
      c: isHl ? prefs.hlColor : prefs.penColor,
      w: isHl ? prefs.sizes.hl : prefs.sizes.pen,
      pts: [{ x: c.x, y: c.y, p: pressureOf(e) }]
    };
    drawStroke(p.ctx, p.drawing, p.w, p.h);
  }

  function onMove(e) {
    const p = pageFromEvent(e);
    if (!p) return;
    updateRing(p, e);
    if (!p.activePointer || e.pointerId !== p.activePointer) return;
    e.preventDefault();

    if (p.erasing) {
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of (evs.length ? evs : [e])) {
        const c = posIn(p, ev.clientX, ev.clientY);
        eraseAt(p, c.x, c.y);
      }
      updateRing(p, e);
      return;
    }
    if (!p.drawing) return;

    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const list = evs.length ? evs : [e];
    const d = p.drawing;
    const w = p.w, h = p.h;
    const ctx = p.ctx;

    for (const ev of list) {
      const c = posIn(p, ev.clientX, ev.clientY);
      let pr = pressureOf(ev);
      const prev = d.pts[d.pts.length - 1];
      pr = prev ? prev.p * 0.65 + pr * 0.35 : pr;
      d.pts.push({ x: c.x, y: c.y, p: pr });
      if (!prev) continue;

      ctx.save();
      ctx.strokeStyle = d.c;
      ctx.globalAlpha = d.t === "hl" ? 0.32 : 1;
      ctx.lineCap = d.t === "hl" ? "butt" : "round";
      ctx.lineJoin = "round";
      const width = d.t === "hl"
        ? Math.max(1, d.w)
        : Math.max(1, d.w * (0.35 + 1.05 * pr));
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(prev.x * w, prev.y * h);
      ctx.lineTo(c.x * w, c.y * h);
      ctx.stroke();
      ctx.restore();
    }
    p.changed = true;
  }

  function onUp(e) {
    const p = pageFromEvent(e);
    if (!p || !p.activePointer || e.pointerId !== p.activePointer) return;
    const before = p.beforeDoc;

    if (p.drawing) {
      p.strokes.push(p.drawing);
      p.drawing = null;
      p.changed = true;
    }
    p.erasing = false;
    p.activePointer = null;
    p.activeTool = null;
    p.beforeDoc = null;

    if (p.changed && before) {
      p.changed = false;
      commit(before);
    }
    try { p.canvas.releasePointerCapture(e.pointerId); } catch {}
  }

  function onCancel(e) {
    const p = pageFromEvent(e);
    if (!p) return;
    if (p.beforeDoc) {
      applySnapshot(p.beforeDoc);
      p.beforeDoc = null;
    }
    p.drawing = null;
    p.erasing = false;
    p.changed = false;
    p.activePointer = null;
    p.activeTool = null;
    try { p.canvas.releasePointerCapture(e.pointerId); } catch {}
  }

  function onHover(e) {
    const p = pageFromEvent(e);
    if (p) updateRing(p, e);
  }

  function onLeave(e) {
    const p = pageFromEvent(e);
    if (p) hideRing(p);
  }

  // ---------- public ----------
  const Ink = {
    init(opts) {
      if (opts && opts.onChange) onChange = opts.onChange;
      if (opts && opts.onHistory) onHistory = opts.onHistory;
    },

    setDocument(docId, inkObj) {
      pages.clear();
      store = inkObj || {};
      undoStack = [];
      redoStack = [];
      notifyHistory();
    },

    attachPage(el, num) {
      const canvas = el.querySelector("canvas.ink");
      if (!canvas) return;
      const ring = document.createElement("div");
      ring.className = "eraser-ring";
      el.appendChild(ring);

      const p = {
        num,
        el,
        canvas,
        ring,
        ctx: canvas.getContext("2d"),
        strokes: store[num] || (store[num] = []),
        beforeDoc: null,
        changed: false,
        drawing: null,
        erasing: false,
        activePointer: null,
        activeTool: null,
        w: 1,
        h: 1
      };
      pages.set(num, p);
      canvas.addEventListener("pointerdown", onDown);
      canvas.addEventListener("pointermove", onMove);
      canvas.addEventListener("pointerup", onUp);
      canvas.addEventListener("pointercancel", onCancel);
      canvas.addEventListener("pointerleave", onLeave);
      canvas.addEventListener("pointerenter", onHover);
      Ink.applyToolTo(canvas);
      redraw(p);
    },

    detachAll() {
      pages.forEach((p) => {
        try { p.canvas.replaceWith(p.canvas.cloneNode(false)); } catch {}
      });
      pages.clear();
    },

    refresh(num) {
      const p = pages.get(num);
      if (p) redraw(p);
    },

    refreshAll() {
      pages.forEach(redraw);
      applyAllTools();
    },

    serialize() {
      const out = {};
      Object.keys(store).forEach((key) => {
        const list = store[key];
        if (list && list.length) out[key] = list;
      });
      return out;
    },

    getStore() { return store; },

    strokeCount() {
      let n = 0;
      Object.keys(store).forEach((key) => { n += (store[key] || []).length; });
      return n;
    },

    setTool(tool) {
      prefs.tool = ["hand", "pen", "hl", "eraser"].includes(tool) ? tool : "hand";
      savePrefs();
      applyAllTools();
    },
    getTool() { return prefs.tool; },

    setColor(color, tool) {
      const t = tool || prefs.tool;
      if (t === "hl") prefs.hlColor = color;
      else prefs.penColor = color;
      savePrefs();
    },
    getColor(tool) {
      const t = tool || prefs.tool;
      return t === "hl" ? prefs.hlColor : prefs.penColor;
    },

    setSize(value, tool) {
      const t = tool || prefs.tool;
      if (!SIZE_RANGES[t]) return;
      const range = SIZE_RANGES[t];
      prefs.sizes[t] = clamp(Math.round(Number(value) || range[0]), range[0], range[1]);
      savePrefs();
    },
    getSize(tool) {
      const t = tool || prefs.tool;
      return prefs.sizes[t] || prefs.sizes.pen;
    },
    getSizes() { return Object.assign({}, prefs.sizes); },
    sizeRange(tool) { return (SIZE_RANGES[tool] || SIZE_RANGES.pen).slice(); },

    setWidth(w) { this.setSize(w, prefs.tool === "hand" ? "pen" : prefs.tool); },
    getWidth() { return this.getSize(prefs.tool === "hand" ? "pen" : prefs.tool); },

    setDrawFinger(on) { prefs.drawFinger = !!on; savePrefs(); applyAllTools(); },
    getDrawFinger() { return prefs.drawFinger; },

    applyToolTo(canvas) {
      const hand = prefs.tool === "hand";
      const eraser = prefs.tool === "eraser";
      canvas.style.pointerEvents = hand ? "none" : "auto";
      canvas.style.cursor = eraser ? "none" : hand ? "default" : "crosshair";
      canvas.style.touchAction = prefs.drawFinger && !hand ? "none" : "pan-y";
      canvas.classList.toggle("pen-mode", !hand && !eraser);
      canvas.classList.toggle("eraser-mode", eraser);
      if (hand || !eraser) {
        pages.forEach((p) => hideRing(p));
      }
    },

    undo() {
      if (!undoStack.length) return false;
      redoStack.push(snapshot());
      applySnapshot(undoStack.pop());
      onChange();
      notifyHistory();
      return true;
    },

    redo() {
      if (!redoStack.length) return false;
      undoStack.push(snapshot());
      applySnapshot(redoStack.pop());
      onChange();
      notifyHistory();
      return true;
    },

    canUndo() { return undoStack.length > 0; },
    canRedo() { return redoStack.length > 0; },

    clearPage(num) {
      const p = pages.get(num);
      if (!p || !p.strokes.length) return false;
      const before = snapshot();
      p.strokes = [];
      store[num] = p.strokes;
      redraw(p);
      commit(before);
      return true;
    },

    clearDocument() {
      let changed = false;
      pages.forEach((p) => { if (p.strokes.length) changed = true; });
      if (!changed) return false;
      const before = snapshot();
      pages.forEach((p) => {
        if (p.strokes.length) {
          p.strokes = [];
          store[p.num] = p.strokes;
          redraw(p);
        }
      });
      commit(before);
      return true;
    },

    lastActivePage() { return lastActivePage; },
    setActivePage(num) { lastActivePage = num; },
    noteQuota() { reportQuota(); }
  };

  function applyAllTools() {
    pages.forEach((p) => Ink.applyToolTo(p.canvas));
  }

  window.Ink = Ink;
})();
