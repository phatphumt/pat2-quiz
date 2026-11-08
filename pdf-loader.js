(function () {
  "use strict";

  let workerSetup = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("โหลด PDF worker ไม่สำเร็จ"));
      document.head.appendChild(script);
    });
  }

  function configureWorker() {
    if (typeof window.pdfjsLib === "undefined") {
      return Promise.reject(new Error("PDF.js ยังไม่พร้อมใช้งาน"));
    }
    const lib = window.pdfjsLib;
    lib.GlobalWorkerOptions.workerSrc = "vendor/pdfjs/pdf.worker.min.js";

    // A file:// page cannot start a same-origin Worker from a blob URL in
    // Chrome. Loading the worker bundle into the page makes PDF.js use its
    // main-thread fake worker instead, without attempting a blocked Worker.
    if (location.protocol !== "file:") return Promise.resolve();
    if (window.pdfjsWorker && window.pdfjsWorker.WorkerMessageHandler) {
      return Promise.resolve();
    }
    if (!workerSetup) {
      workerSetup = loadScript("vendor/pdfjs/pdf.worker.min.js")
        .then(() => {
          if (!window.pdfjsWorker || !window.pdfjsWorker.WorkerMessageHandler) {
            throw new Error("PDF worker ยังไม่พร้อมใช้งาน");
          }
        })
        .catch((err) => {
          workerSetup = null;
          throw err;
        });
    }
    return workerSetup;
  }

  async function openFile(file) {
    await configureWorker();
    const data = new Uint8Array(await file.arrayBuffer());
    const task = window.pdfjsLib.getDocument({
      data,
      isEvalSupported: false,
      useSystemFonts: true
    });
    return task.promise;
  }

  async function pageInfo(doc, num) {
    const page = await doc.getPage(num);
    const viewport = page.getViewport({ scale: 1 });
    return { width: viewport.width, height: viewport.height };
  }

  async function renderPage(doc, num, targetWidth, opts) {
    const options = opts || {};
    const page = await doc.getPage(num);
    const base = page.getViewport({ scale: 1 });
    const maxScale = options.maxScale || 4;
    const scale = Math.max(0.2, Math.min(maxScale, targetWidth / base.width));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("เรนเดอร์หน้า PDF ไม่สำเร็จ");
    const url = URL.createObjectURL(blob);
    return { url, width: canvas.width, height: canvas.height };
  }

  function close(doc) {
    try { if (doc) doc.destroy(); } catch {}
  }

  window.PdfLoader = { openFile, pageInfo, renderPage, close };
})();
