const indexCount = document.getElementById("indexCount");
const runState = document.getElementById("runState");
const importBtn = document.getElementById("importBtn");
const importInfo = document.getElementById("importInfo");
const importPanel = document.getElementById("importPanel");
const galleryPath = document.getElementById("galleryPath");
const targetFile = document.getElementById("targetFile");
const clearCropBtn = document.getElementById("clearCropBtn");
const searchBtn = document.getElementById("searchBtn");
const canvas = document.getElementById("photoCanvas");
const ctx = canvas.getContext("2d");
const resultSummary = document.getElementById("resultSummary");
const results = document.getElementById("results");
const targetPreview = document.getElementById("targetPreview");

let image = new Image();
let imageFile = null;
let scale = 1;
let crop = null;
let dragging = false;
let dragStart = null;
let activeSearchTimer = null;

async function refreshStatus() {
  const res = await fetch("/api/status");
  const data = await res.json();
  indexCount.textContent = `有效索引：${data.count}`;
  runState.textContent = data.progress.running ? "导入中" : "空闲";
  if (importPanel && data.config) {
    importPanel.style.display = data.config.enableImport ? "" : "none";
  }

  const fileText = data.progress.totalFiles
    ? `；文件 ${data.progress.currentFileIndex || 0}/${data.progress.totalFiles}`
    : "";
  const pageText = data.progress.totalPages
    ? `；页 ${data.progress.currentPage || 0}/${data.progress.totalPages}，本页检测 ${data.progress.currentPageDetected || 0} 个`
    : "";
  const errorText = data.progress.errors && data.progress.errors.length
    ? `；最近错误：${data.progress.errors[data.progress.errors.length - 1]}`
    : "";

  importInfo.textContent = `${data.progress.message}${fileText}${pageText}；新增 ${data.progress.indexed}，跳过 ${data.progress.skipped}，失败 ${data.progress.failed}${errorText}`;
}

function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / Math.max(rect.width, 1)) * image.naturalWidth,
    y: ((event.clientY - rect.top) / Math.max(rect.height, 1)) * image.naturalHeight
  };
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (image.src) ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  if (crop) {
    ctx.save();
    ctx.strokeStyle = "#1677ff";
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 5]);
    ctx.strokeRect(crop.x * scale, crop.y * scale, crop.w * scale, crop.h * scale);
    ctx.fillStyle = "rgba(22,119,255,0.12)";
    ctx.fillRect(crop.x * scale, crop.y * scale, crop.w * scale, crop.h * scale);
    ctx.restore();
  }
}

function fitCanvas() {
  const maxWidth = Math.min(900, document.querySelector(".canvasWrap").clientWidth - 2);
  scale = Math.min(1, maxWidth / image.naturalWidth);
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  draw();
}

targetFile.addEventListener("change", () => {
  imageFile = targetFile.files[0] || null;
  crop = null;
  results.innerHTML = "";
  targetPreview.classList.remove("show");
  targetPreview.innerHTML = "";
  resultSummary.textContent = "暂无结果";
  if (!imageFile) return;
  image = new Image();
  image.onload = fitCanvas;
  image.src = URL.createObjectURL(imageFile);
});

canvas.addEventListener("mousedown", event => {
  if (!image.src) return;
  dragging = true;
  dragStart = canvasPoint(event);
  crop = { x: dragStart.x, y: dragStart.y, w: 1, h: 1 };
  draw();
});

canvas.addEventListener("mousemove", event => {
  if (!dragging || !dragStart) return;
  const p = canvasPoint(event);
  const x = Math.max(0, Math.min(dragStart.x, p.x));
  const y = Math.max(0, Math.min(dragStart.y, p.y));
  const w = Math.min(image.naturalWidth - x, Math.abs(p.x - dragStart.x));
  const h = Math.min(image.naturalHeight - y, Math.abs(p.y - dragStart.y));
  crop = { x, y, w, h };
  draw();
});

window.addEventListener("mouseup", () => {
  if (!dragging) return;
  dragging = false;
  if (crop && (crop.w < 10 || crop.h < 10)) crop = null;
  draw();
});

clearCropBtn.addEventListener("click", () => {
  crop = null;
  draw();
});

importBtn.addEventListener("click", async () => {
  const value = galleryPath.value.trim();
  if (!value) {
    importInfo.textContent = "请先填写 PDF、图片文件夹或 ZIP 路径。";
    return;
  }
  importBtn.disabled = true;
  try {
    const res = await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: value })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "导入失败");
    importInfo.textContent = "导入任务已开始。";
  } catch (err) {
    importInfo.textContent = err.message;
  } finally {
    importBtn.disabled = false;
  }
});

searchBtn.addEventListener("click", async () => {
  if (!imageFile) {
    resultSummary.textContent = "请先上传破损取证照片。";
    return;
  }
  searchBtn.disabled = true;
  resultSummary.textContent = "正在创建匹配任务。";
  results.innerHTML = "";
  targetPreview.classList.remove("show");
  targetPreview.innerHTML = "";
  try {
    const form = new FormData();
    form.append("image", imageFile);
    if (crop) form.append("crop", JSON.stringify(crop));
    const res = await fetch("/api/search", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "匹配失败");
    if (!data.taskId) throw new Error("没有收到匹配任务编号");
    startSearchPolling(data.taskId);
  } catch (err) {
    resultSummary.textContent = err.message;
    searchBtn.disabled = false;
  }
});

function startSearchPolling(taskId) {
  if (activeSearchTimer) clearInterval(activeSearchTimer);

  const poll = async () => {
    try {
      const res = await fetch(`/api/search-status?id=${encodeURIComponent(taskId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "无法读取匹配进度");
      renderSearchStatus(data);
      if (data.status === "done" || data.status === "error") {
        clearInterval(activeSearchTimer);
        activeSearchTimer = null;
        searchBtn.disabled = false;
      }
    } catch (err) {
      resultSummary.textContent = err.message;
      clearInterval(activeSearchTimer);
      activeSearchTimer = null;
      searchBtn.disabled = false;
    }
  };

  poll();
  activeSearchTimer = setInterval(poll, 1000);
}

function renderSearchStatus(data) {
  if (data.status === "error") {
    resultSummary.textContent = data.error || "匹配失败";
    return;
  }
  if (data.decoded) {
    resultSummary.textContent = `破损图已解码：${data.decoded}`;
    results.innerHTML = "";
    return;
  }

  const confidenceText = data.highConfidenceCount > 0
    ? `已找到 ${data.highConfidenceCount} 个不低于 ${data.threshold}% 的高相似候选，列表最多保留 5 个。`
    : `未找到不低于 ${data.threshold}% 的高相似候选，显示当前综合分最高的 Top 5。`;
  const scanned = data.fineProcessed || data.coarseProcessed || 0;
  const total = data.coarseCount || data.count || 0;
  const progressText = total ? `已扫描有效索引 ${scanned}/${total}` : "等待扫描有效索引";

  resultSummary.textContent = `${data.message}；有效索引 ${data.count || total} 条，${progressText}；目标图可信区域约 ${data.validRatio || 0}%。${confidenceText}`;
  renderTargetPreview(data.previewId);
  renderResults(data.results || []);
}

function renderTargetPreview(previewId) {
  if (!previewId) return;
  targetPreview.classList.add("show");
  targetPreview.innerHTML = `
    <img src="/api/preview?id=${encodeURIComponent(previewId)}" alt="裁剪后的目标二维码">
    <div>
      <strong>裁剪后的目标二维码</strong>
      <div class="hint">已做灰度、对比度增强和二值化，用于本次匹配参考。</div>
    </div>
  `;
}

function renderResults(items) {
  results.innerHTML = items.map((item, index) => `
    <article class="resultCard ${item.highConfidence ? "high" : ""}">
      <img src="/api/image?id=${encodeURIComponent(item.id)}" alt="候选二维码 ${index + 1}">
      <div class="resultMeta">
        <div><strong>#${index + 1}</strong> ${escapeHtml(item.name)}</div>
        ${item.resultText ? `<div>二维码数字：<strong>${escapeHtml(item.resultText)}</strong></div>` : ""}
        <div class="score">匹配分数：${item.score}</div>
        ${item.highConfidence ? `<div class="badge">高相似候选</div>` : ""}
        ${item.sourceType === "pdf" ? `<div>来源：PDF 第 ${item.sourcePage} 页</div>` : ""}
        <div class="path">${escapeHtml(item.path)}</div>
      </div>
    </article>
  `).join("");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

setInterval(refreshStatus, 1500);
refreshStatus();
