const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");
const readline = require("readline");
const os = require("os");
const sharp = require("sharp");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const IMPORT_DIR = path.join(DATA_DIR, "imports");
const PDF_ITEM_DIR = path.join(DATA_DIR, "pdf_items");
const IMPORT_JOB_DIR = path.join(DATA_DIR, "import_jobs");
const PDF_BATCH_JOB_FILE = path.join(IMPORT_JOB_DIR, "pdf_batch.json");
const INDEX_FILE = path.join(DATA_DIR, "index.jsonl");
const MANUAL21_FILE = path.join(DATA_DIR, "manual21.jsonl");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const QR_INDEX_DIR = path.join(DATA_DIR, "qr_index");
const QR_SHARD_DIR = path.join(QR_INDEX_DIR, "shards");
const QR_MANIFEST_FILE = path.join(QR_INDEX_DIR, "manifest.json");
const QR_SOURCE_FILE = path.join(QR_INDEX_DIR, "sources.jsonl");
const QR_SOURCE_STATE_FILE = path.join(QR_INDEX_DIR, "sources.state.json");
const QR_CODES_FILE = path.join(QR_INDEX_DIR, "codes.txt");
const PUBLIC_DIR = path.join(ROOT, "public");
const PORT = Number(process.env.PORT || 8787);
const LOAD_LEGACY_INDEX = process.env.LOAD_LEGACY_INDEX === "1";
const PDF_IMPORT_PAGE_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.PDF_IMPORT_PAGE_CONCURRENCY || 1)));
const QR_IMPORT_ITEM_CONCURRENCY_MIN = Math.max(1, Math.min(32, Number(process.env.QR_IMPORT_ITEM_CONCURRENCY_MIN || 2)));
const QR_IMPORT_ITEM_CONCURRENCY_MAX = Math.max(QR_IMPORT_ITEM_CONCURRENCY_MIN, Math.min(64, Number(process.env.QR_IMPORT_ITEM_CONCURRENCY || 16)));
const IMPORT_MEMORY_LOW_FREE_RATIO = Number(process.env.IMPORT_MEMORY_LOW_FREE_RATIO || 0.18);
const IMPORT_MEMORY_HIGH_FREE_RATIO = Number(process.env.IMPORT_MEMORY_HIGH_FREE_RATIO || 0.35);
const IMPORT_MEMORY_CHECK_MS = Math.max(500, Number(process.env.IMPORT_MEMORY_CHECK_MS || 1500));

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"]);
const PDF_EXTS = new Set([".pdf"]);
const FEATURE_SIZE = 64;
const HIGH_FEATURE_SIZE = 260;
const BLOCKS = 16;
const MODULE_GRID = 29;
const MODULE_GRIDS = [21, 25, 29, 33];
const HIGH_SAMPLE_GRIDS = [25, 29];
const HIGH_SAMPLE_PADS = [1];
const COARSE_KEEP = 50000;
const FINE_KEEP = 5;
const HIGH_SCORE_THRESHOLD = 95;
const QR_GRID = 21;
const QR_MODULES = QR_GRID * QR_GRID;
const QR_PACKED_BYTES = Math.ceil(QR_MODULES / 8);
const QR_RECORD_SIZE = 80;
const QR_SHARD_SIZE = 100000;
const QR_BIN_ID_PREFIX = "qrbin:";
const QR_EXTRACTION_MODE = "crop-sharp-v2";

let indexItems = [];
let indexById = new Map();
let manual21ById = new Map();
let qrBinManifest = null;
let qrBinSources = [];
let qrBinSourceByHash = new Map();
let qrBinSourceState = new Map();
let importRunning = false;
let importProgress = {
  running: false,
  scanned: 0,
  indexed: 0,
  skipped: 0,
  failed: 0,
  errors: [],
  totalFiles: 0,
  currentFile: "",
  currentFileIndex: 0,
  currentPage: 0,
  totalPages: 0,
  currentPageDetected: 0,
  message: "空闲"
};
let pdfjsCache = null;
const searchTasks = new Map();
let adaptiveQrImportConcurrency = Math.min(4, QR_IMPORT_ITEM_CONCURRENCY_MAX);
let importMemoryMonitor = null;

function storedPathToRuntime(value) {
  if (typeof value !== "string") return value;
  if (!path.isAbsolute(value)) return path.join(ROOT, value);
  const marker = `${path.sep}data${path.sep}`;
  const idx = value.lastIndexOf(marker);
  if (idx === -1) return value;
  return path.join(ROOT, value.slice(idx + 1));
}

function runtimePathToStored(value) {
  if (typeof value !== "string") return value;
  const normalizedRoot = path.resolve(ROOT);
  const normalizedValue = path.resolve(value);
  if (normalizedValue === normalizedRoot || normalizedValue.startsWith(`${normalizedRoot}${path.sep}`)) {
    return path.relative(ROOT, normalizedValue);
  }
  return value;
}

function indexItemForStorage(item) {
  return {
    ...item,
    path: runtimePathToStored(item.path),
    sourcePdf: runtimePathToStored(item.sourcePdf)
  };
}

function compactIndexItemForRuntime(item) {
  const feature = item.feature || {};
  return {
    id: item.id,
    path: storedPathToRuntime(item.path),
    name: item.name,
    size: item.size,
    hash: item.hash,
    resultText: item.resultText || null,
    sourceType: item.sourceType || "image",
    sourcePdf: storedPathToRuntime(item.sourcePdf),
    sourcePage: item.sourcePage || null,
    sourceIndex: item.sourceIndex || null,
    importedAt: item.importedAt || null,
    feature: {
      width: feature.width || 0,
      height: feature.height || 0,
      manual21: feature.manual21 || null,
      modules: feature.modules || null
    }
  };
}

async function ensureDirs() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  await fsp.mkdir(IMPORT_DIR, { recursive: true });
  await fsp.mkdir(PDF_ITEM_DIR, { recursive: true });
  await fsp.mkdir(IMPORT_JOB_DIR, { recursive: true });
  await fsp.mkdir(QR_SHARD_DIR, { recursive: true });
}

function sendJson(res, data, status = 200) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length
  });
  res.end(body);
}

function sendText(res, text, status = 200) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function safeJoin(base, urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const target = path.normalize(path.join(base, decoded));
  if (!target.startsWith(base)) return null;
  return target;
}

async function readRequestBody(req, maxBytes = 200 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const body = await readRequestBody(req, 20 * 1024 * 1024);
  return JSON.parse(body.toString("utf8") || "{}");
}

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!match) throw new Error("缺少 multipart boundary");
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const parts = [];
  let start = buffer.indexOf(boundary);
  while (start !== -1) {
    start += boundary.length;
    if (buffer[start] === 45 && buffer[start + 1] === 45) break;
    if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), start);
    if (headerEnd === -1) break;
    const rawHeaders = buffer.slice(start, headerEnd).toString("utf8");
    let dataStart = headerEnd + 4;
    let next = buffer.indexOf(boundary, dataStart);
    if (next === -1) break;
    let dataEnd = next - 2;
    if (dataEnd < dataStart) dataEnd = next;
    const disposition = /content-disposition:[^\r\n]+/i.exec(rawHeaders)?.[0] || "";
    const name = /name="([^"]+)"/i.exec(disposition)?.[1] || "";
    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1] || "";
    const type = /content-type:\s*([^\r\n]+)/i.exec(rawHeaders)?.[1]?.trim() || "";
    parts.push({ name, filename, type, data: buffer.slice(dataStart, dataEnd) });
    start = next;
  }
  return parts;
}

async function loadIndex() {
  indexItems = [];
  indexById = new Map();
  try {
    const stream = fs.createReadStream(INDEX_FILE, { encoding: "utf8" });
    const lines = readline.createInterface({
      input: stream,
      crlfDelay: Infinity
    });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const item = compactIndexItemForRuntime(JSON.parse(line));
      indexItems.push(item);
      indexById.set(item.id, item);
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

async function loadManual21Index() {
  manual21ById = new Map();
  try {
    const stream = fs.createReadStream(MANUAL21_FILE, { encoding: "utf8" });
    const lines = readline.createInterface({
      input: stream,
      crlfDelay: Infinity
    });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const item = JSON.parse(line);
      if (item.id && item.modules) manual21ById.set(item.id, item.modules);
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

function emptyQrBinManifest() {
  return {
    version: 1,
    grid: QR_GRID,
    recordSize: QR_RECORD_SIZE,
    shardSize: QR_SHARD_SIZE,
    packedBytes: QR_PACKED_BYTES,
    totalRecords: 0,
    sourceCount: 0,
    updatedAt: new Date().toISOString()
  };
}

async function loadQrBinaryIndex() {
  try {
    qrBinManifest = JSON.parse(await fsp.readFile(QR_MANIFEST_FILE, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    qrBinManifest = emptyQrBinManifest();
  }

  qrBinSources = [];
  qrBinSourceByHash = new Map();
  qrBinSourceState = new Map();
  try {
    const stream = fs.createReadStream(QR_SOURCE_FILE, { encoding: "utf8" });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const source = JSON.parse(line);
      source.path = storedPathToRuntime(source.path);
      qrBinSources[source.id] = source;
      if (source.hash && source.itemCount > 0 && source.extractionMode === QR_EXTRACTION_MODE) {
        qrBinSourceByHash.set(source.hash, source);
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  try {
    const stateText = await fsp.readFile(QR_SOURCE_STATE_FILE, "utf8");
    if (!stateText.trim()) throw new Error("empty source state");
    const state = JSON.parse(stateText);
    for (const row of Object.values(state.sources || {})) {
      if (row.hash) qrBinSourceState.set(row.hash, row);
    }
  } catch (err) {
    if (err.code !== "ENOENT" && !(err instanceof SyntaxError) && err.message !== "empty source state") throw err;
  }
}

async function saveQrBinManifest() {
  qrBinManifest.updatedAt = new Date().toISOString();
  qrBinManifest.sourceCount = qrBinSources.filter(source => source && source.itemCount > 0).length;
  await fsp.writeFile(QR_MANIFEST_FILE, JSON.stringify(qrBinManifest, null, 2), "utf8");
}

async function appendQrBinSource(source) {
  const item = {
    id: source.id ?? qrBinSources.length,
    path: runtimePathToStored(source.path),
    name: source.name,
    hash: source.hash,
    startRecord: source.startRecord || 0,
    itemCount: source.itemCount || 0,
    extractionMode: source.extractionMode || QR_EXTRACTION_MODE,
    importedAt: new Date().toISOString()
  };
  await fsp.appendFile(QR_SOURCE_FILE, JSON.stringify(item) + "\n", "utf8");
  item.path = storedPathToRuntime(item.path);
  qrBinSources[item.id] = item;
  if (item.hash && item.itemCount > 0 && item.extractionMode === QR_EXTRACTION_MODE) qrBinSourceByHash.set(item.hash, item);
  await saveQrBinManifest();
  return item;
}

async function saveQrBinSourceState() {
  const sources = {};
  for (const [hash, row] of qrBinSourceState) sources[hash] = row;
  const tmpFile = `${QR_SOURCE_STATE_FILE}.tmp`;
  await fsp.writeFile(tmpFile, JSON.stringify({ updatedAt: new Date().toISOString(), sources }, null, 2), "utf8");
  await fsp.rename(tmpFile, QR_SOURCE_STATE_FILE);
}

async function fileSizeOrZero(filePath) {
  try {
    return (await fsp.stat(filePath)).size;
  } catch (err) {
    if (err.code === "ENOENT") return 0;
    throw err;
  }
}

async function truncateQrBinRecords(recordCount) {
  const safeCount = Math.max(0, recordCount);
  const shardCount = Math.ceil(safeCount / QR_SHARD_SIZE);
  const keepLastSize = safeCount % QR_SHARD_SIZE;
  for (let shardIndex = shardCount; ; shardIndex += 1) {
    const shard = qrShardPath(shardIndex);
    try {
      await fsp.unlink(shard);
    } catch (err) {
      if (err.code === "ENOENT") break;
      throw err;
    }
  }
  if (safeCount > 0 && keepLastSize > 0) {
    await fsp.truncate(qrShardPath(shardCount - 1), keepLastSize * QR_RECORD_SIZE);
  }
  qrBinManifest.totalRecords = safeCount;
  await saveQrBinManifest();
}

async function restoreQrBinCheckpoint(sourceState) {
  if (!sourceState) return;
  if (Number.isSafeInteger(sourceState.totalRecordsAfterCompleted)) {
    await truncateQrBinRecords(sourceState.totalRecordsAfterCompleted);
  }
  if (Number.isSafeInteger(sourceState.codesSizeAfterCompleted)) {
    await fsp.truncate(QR_CODES_FILE, sourceState.codesSizeAfterCompleted);
  }
}

function packModuleValues(moduleValues) {
  const values = Buffer.isBuffer(moduleValues) ? moduleValues : Buffer.from(moduleValues);
  const packed = Buffer.alloc(QR_PACKED_BYTES);
  for (let i = 0; i < Math.min(values.length, QR_MODULES); i += 1) {
    if (values[i]) packed[i >> 3] |= 1 << (i & 7);
  }
  return packed;
}

function unpackModuleValues(packed) {
  const values = new Uint8Array(QR_MODULES);
  for (let i = 0; i < QR_MODULES; i += 1) {
    values[i] = (packed[i >> 3] >> (i & 7)) & 1;
  }
  return values;
}

function packedTargetFromManualFeature(feature) {
  const values = Buffer.from(feature.modules.values, "base64");
  const mask = Buffer.from(feature.modules.mask, "base64");
  return {
    values: packModuleValues(values),
    mask: packModuleValues(mask),
    cells: values,
    cellMask: mask,
    known: feature.known
  };
}

const POPCOUNT8 = Uint8Array.from({ length: 256 }, (_, n) => {
  let v = n;
  let c = 0;
  while (v) {
    v &= v - 1;
    c += 1;
  }
  return c;
});

function scorePackedQr(target, candidatePacked) {
  if (!target.known) return 0;
  let mismatch = 0;
  for (let i = 0; i < QR_PACKED_BYTES; i += 1) {
    mismatch += POPCOUNT8[(target.values[i] ^ candidatePacked[i]) & target.mask[i]];
  }
  return Math.round(((target.known - mismatch) / target.known) * 10000) / 100;
}

function unpackPackedQr(packed) {
  const values = new Uint8Array(QR_MODULES);
  for (let i = 0; i < QR_MODULES; i += 1) values[i] = (packed[i >> 3] >> (i & 7)) & 1;
  return values;
}

function tolerantPackedQrScore(target, candidatePacked) {
  if (!target.known) return 0;
  const candidate = unpackPackedQr(candidatePacked);
  let score = 0;
  for (let i = 0; i < QR_MODULES; i += 1) {
    if (!target.cellMask[i]) continue;
    if (target.cells[i] === candidate[i]) {
      score += 1;
      continue;
    }
    const x = i % QR_GRID;
    const y = Math.floor(i / QR_GRID);
    let near = false;
    const neighbors = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1]
    ];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= QR_GRID || ny >= QR_GRID) continue;
      if (candidate[ny * QR_GRID + nx] === target.cells[i]) {
        near = true;
        break;
      }
    }
    if (near) score += 0.6;
  }
  return Math.round((score / target.known) * 10000) / 100;
}

function qrShardPath(shardIndex) {
  return path.join(QR_SHARD_DIR, `shard_${String(shardIndex).padStart(6, "0")}.bin`);
}

function qrBinId(recordNo) {
  return `${QR_BIN_ID_PREFIX}${recordNo}`;
}

function parseQrBinId(id) {
  if (typeof id !== "string" || !id.startsWith(QR_BIN_ID_PREFIX)) return null;
  const n = Number(id.slice(QR_BIN_ID_PREFIX.length));
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

async function appendCodeText(text) {
  const value = text ? String(text) : "";
  const bytes = Buffer.from(value + "\n", "utf8");
  const offset = await fsp.open(QR_CODES_FILE, "a+").then(async handle => {
    try {
      const stat = await handle.stat();
      await handle.write(bytes, 0, bytes.length, stat.size);
      return stat.size;
    } finally {
      await handle.close();
    }
  });
  return { offset, length: Math.max(0, bytes.length - 1) };
}

function writeUInt48LE(buf, value, offset) {
  let n = BigInt(value);
  for (let i = 0; i < 6; i += 1) {
    buf[offset + i] = Number(n & 0xffn);
    n >>= 8n;
  }
}

function readUInt48LE(buf, offset) {
  let n = 0n;
  for (let i = 5; i >= 0; i -= 1) n = (n << 8n) + BigInt(buf[offset + i]);
  return Number(n);
}

function makeQrBinRecord({ packed, codeOffset, codeLength, sourceId, page, itemIndex }) {
  const record = Buffer.alloc(QR_RECORD_SIZE);
  packed.copy(record, 0, 0, QR_PACKED_BYTES);
  writeUInt48LE(record, codeOffset, 56);
  record.writeUInt16LE(Math.min(codeLength, 65535), 62);
  record.writeUInt32LE(sourceId >>> 0, 64);
  record.writeUInt16LE(Math.min(page || 0, 65535), 68);
  record.writeUInt16LE(Math.min(itemIndex || 0, 65535), 70);
  return record;
}

async function appendQrBinRecord(args) {
  const recordNo = qrBinManifest.totalRecords;
  const shardIndex = Math.floor(recordNo / QR_SHARD_SIZE);
  const record = makeQrBinRecord(args);
  await fsp.appendFile(qrShardPath(shardIndex), record);
  qrBinManifest.totalRecords += 1;
  if (qrBinManifest.totalRecords % 1000 === 0) await saveQrBinManifest();
  return recordNo;
}

function decodeQrBinRecord(recordNo, record) {
  const sourceId = record.readUInt32LE(64);
  const source = qrBinSources[sourceId] || {};
  const page = record.readUInt16LE(68);
  const itemIndex = record.readUInt16LE(70);
  return {
    id: qrBinId(recordNo),
    recordNo,
    packed: record.subarray(0, QR_PACKED_BYTES),
    codeOffset: readUInt48LE(record, 56),
    codeLength: record.readUInt16LE(62),
    sourceId,
    source,
    sourcePage: page || null,
    sourceIndex: itemIndex || null
  };
}

async function readQrBinRecord(recordNo) {
  if (!qrBinManifest || recordNo < 0 || recordNo >= qrBinManifest.totalRecords) return null;
  const shardIndex = Math.floor(recordNo / QR_SHARD_SIZE);
  const offset = (recordNo % QR_SHARD_SIZE) * QR_RECORD_SIZE;
  const handle = await fsp.open(qrShardPath(shardIndex), "r");
  try {
    const record = Buffer.alloc(QR_RECORD_SIZE);
    const { bytesRead } = await handle.read(record, 0, QR_RECORD_SIZE, offset);
    if (bytesRead !== QR_RECORD_SIZE) return null;
    return decodeQrBinRecord(recordNo, record);
  } finally {
    await handle.close();
  }
}

async function readQrCodeText(meta) {
  if (!meta || !meta.codeLength) return null;
  const handle = await fsp.open(QR_CODES_FILE, "r");
  try {
    const buf = Buffer.alloc(meta.codeLength);
    await handle.read(buf, 0, meta.codeLength, meta.codeOffset);
    return buf.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function publicQrBinSearchResult(row) {
  const code = await readQrCodeText(row.meta);
  const sourceName = row.meta.source?.name || "PDF图库";
  const name = row.meta.sourcePage
    ? `${sourceName} 第${row.meta.sourcePage}页 #${row.meta.sourceIndex || "?"}${code ? ` ${code}` : ""}`
    : `${sourceName}${code ? ` ${code}` : ""}`;
  return {
    id: row.meta.id,
    name,
    path: "二进制轻量索引",
    resultText: code,
    sourceType: "qrbin",
    sourcePdf: row.meta.source?.path || null,
    sourcePage: row.meta.sourcePage,
    coarseDistance: 0,
    score: row.score,
    highConfidence: row.score >= HIGH_SCORE_THRESHOLD
  };
}

async function renderPackedQrPng(packed, outputSize = 260) {
  const values = unpackModuleValues(packed);
  const quiet = 4;
  const moduleSize = Math.max(1, Math.floor(outputSize / (QR_GRID + quiet * 2)));
  const qrSize = moduleSize * QR_GRID;
  const offset = Math.floor((outputSize - qrSize) / 2);
  const rects = [];
  for (let y = 0; y < QR_GRID; y += 1) {
    for (let x = 0; x < QR_GRID; x += 1) {
      const idx = y * QR_GRID + x;
      if (!values[idx]) continue;
      rects.push(`<rect x="${offset + x * moduleSize}" y="${offset + y * moduleSize}" width="${moduleSize}" height="${moduleSize}" fill="#000"/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${outputSize}" height="${outputSize}" viewBox="0 0 ${outputSize} ${outputSize}"><rect width="100%" height="100%" fill="white"/><g>${rects.join("")}</g></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function getTotalIndexCount() {
  return (qrBinManifest?.totalRecords || 0) + indexItems.length;
}

function isActiveQrBinSource(source) {
  return source && source.itemCount > 0 && source.extractionMode === QR_EXTRACTION_MODE;
}

function getActiveQrBinRecordEstimate() {
  return qrBinSources.reduce((total, source) => {
    if (!isActiveQrBinSource(source)) return total;
    return total + (source.itemCount || 0);
  }, 0);
}

function moduleGridFromBits(bits, mask = null, size = FEATURE_SIZE, grid = MODULE_GRID) {
  const modules = [];
  const moduleMask = [];
  const step = size / grid;
  for (let gy = 0; gy < grid; gy += 1) {
    for (let gx = 0; gx < grid; gx += 1) {
      const x0 = Math.floor(gx * step);
      const x1 = Math.floor((gx + 1) * step);
      const y0 = Math.floor(gy * step);
      const y1 = Math.floor((gy + 1) * step);
      let total = 0;
      let count = 0;
      let valid = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const idx = y * size + x;
          total += bits[idx];
          count += 1;
          if (!mask || mask[idx] !== 0) valid += 1;
        }
      }
      modules.push(total / Math.max(count, 1) >= 0.5 ? 1 : 0);
      moduleMask.push(valid / Math.max(count, 1) >= 0.45 ? 1 : 0);
    }
  }
  return {
    grid,
    values: Buffer.from(Uint8Array.from(modules)).toString("base64"),
    mask: Buffer.from(Uint8Array.from(moduleMask)).toString("base64")
  };
}

function moduleGridFromFeature(feature) {
  const bits = Buffer.from(feature.bits, "base64");
  const mask = feature.mask ? Buffer.from(feature.mask, "base64") : null;
  return moduleGridFromBits(bits, mask);
}

function bitBoundingBox(bits, size = FEATURE_SIZE) {
  let minX = size;
  let minY = size;
  let maxX = 0;
  let maxY = 0;
  let found = false;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!bits[y * size + x]) continue;
      found = true;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!found) return { minX: 0, minY: 0, maxX: size - 1, maxY: size - 1, width: size, height: size };
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function sampledModuleGridFromBits(bits, mask = null, size = FEATURE_SIZE, grid = 25, padModules = 1) {
  const box = bitBoundingBox(bits, size);
  const moduleSize = Math.max(box.width, box.height) / Math.max(grid - 1, 1);
  const centerX = (box.minX + box.maxX) / 2;
  const centerY = (box.minY + box.maxY) / 2;
  const left = centerX - moduleSize * (grid - 1) / 2 - moduleSize * padModules;
  const top = centerY - moduleSize * (grid - 1) / 2 - moduleSize * padModules;
  const step = moduleSize * (grid + padModules * 2) / grid;
  const values = [];
  const validMask = [];

  for (let gy = 0; gy < grid; gy += 1) {
    for (let gx = 0; gx < grid; gx += 1) {
      const cx = Math.round(left + (gx + 0.5) * step);
      const cy = Math.round(top + (gy + 0.5) * step);
      let total = 0;
      let count = 0;
      let valid = 0;
      for (let yy = -1; yy <= 1; yy += 1) {
        for (let xx = -1; xx <= 1; xx += 1) {
          const x = cx + xx;
          const y = cy + yy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const idx = y * size + x;
          total += bits[idx];
          count += 1;
          if (!mask || mask[idx] !== 0) valid += 1;
        }
      }
      values.push(total / Math.max(count, 1) >= 0.45 ? 1 : 0);
      validMask.push(valid / Math.max(count, 1) >= 0.45 ? 1 : 0);
    }
  }

  return {
    grid,
    values: Buffer.from(Uint8Array.from(values)).toString("base64"),
    mask: Buffer.from(Uint8Array.from(validMask)).toString("base64")
  };
}

function sampleKey(grid, padModules) {
  return `${grid}:${padModules}`;
}

function highSampleGridsFromBits(bits, mask = null, size = HIGH_FEATURE_SIZE) {
  const samples = {};
  for (const grid of HIGH_SAMPLE_GRIDS) {
    for (const pad of HIGH_SAMPLE_PADS) {
      samples[sampleKey(grid, pad)] = sampledModuleGridFromBits(bits, mask, size, grid, pad);
    }
  }
  return samples;
}

function connectedBlackComponents(bits, size) {
  const seen = new Uint8Array(bits.length);
  const queue = new Int32Array(bits.length);
  const components = [];

  for (let start = 0; start < bits.length; start += 1) {
    if (!bits[start] || seen[start]) continue;
    let head = 0;
    let tail = 0;
    let area = 0;
    let minX = size;
    let minY = size;
    let maxX = 0;
    let maxY = 0;
    queue[tail++] = start;
    seen[start] = 1;

    while (head < tail) {
      const idx = queue[head++];
      const x = idx % size;
      const y = Math.floor(idx / size);
      area += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      const neighbors = [];
      if (x > 0) neighbors.push(idx - 1);
      if (x + 1 < size) neighbors.push(idx + 1);
      if (y > 0) neighbors.push(idx - size);
      if (y + 1 < size) neighbors.push(idx + size);
      for (const next of neighbors) {
        if (bits[next] && !seen[next]) {
          seen[next] = 1;
          queue[tail++] = next;
        }
      }
    }

    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    const ratio = width / Math.max(height, 1);
    const fill = area / Math.max(width * height, 1);
    components.push({
      minX,
      minY,
      maxX,
      maxY,
      width,
      height,
      area,
      ratio,
      fill,
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2
    });
  }

  return components;
}

function detectFinderCenters(bits, size = HIGH_FEATURE_SIZE) {
  const minSide = size * 0.075;
  const maxSide = size * 0.42;
  const candidates = connectedBlackComponents(bits, size)
    .filter(c => (
      c.width >= minSide &&
      c.height >= minSide &&
      c.width <= maxSide &&
      c.height <= maxSide &&
      c.ratio >= 0.62 &&
      c.ratio <= 1.42 &&
      c.fill >= 0.34 &&
      c.fill <= 0.88
    ))
    .sort((a, b) => b.area - a.area)
    .slice(0, 12);

  if (candidates.length < 3) return [];

  let best = null;
  for (let i = 0; i < candidates.length - 2; i += 1) {
    for (let j = i + 1; j < candidates.length - 1; j += 1) {
      for (let k = j + 1; k < candidates.length; k += 1) {
        const tri = [candidates[i], candidates[j], candidates[k]];
        const pairs = [
          { a: 0, b: 1, d: distanceSq(tri[0], tri[1]) },
          { a: 0, b: 2, d: distanceSq(tri[0], tri[2]) },
          { a: 1, b: 2, d: distanceSq(tri[1], tri[2]) }
        ].sort((a, b) => b.d - a.d);
        const hyp = pairs[0];
        const legs = pairs.slice(1);
        const rightIndex = [0, 1, 2].find(n => n !== hyp.a && n !== hyp.b);
        if (rightIndex === undefined) continue;
        const legRatio = Math.sqrt(legs[0].d / Math.max(legs[1].d, 1));
        if (legRatio < 0.55 || legRatio > 1.85) continue;
        const p = tri[rightIndex];
        const p1 = tri[legs[0].a === rightIndex ? legs[0].b : legs[0].a];
        const p2 = tri[legs[1].a === rightIndex ? legs[1].b : legs[1].a];
        const v1 = { x: p1.cx - p.cx, y: p1.cy - p.cy };
        const v2 = { x: p2.cx - p.cx, y: p2.cy - p.cy };
        const dot = Math.abs((v1.x * v2.x + v1.y * v2.y) / Math.max(Math.sqrt(legs[0].d * legs[1].d), 1));
        const spread = Math.sqrt(legs[0].d + legs[1].d);
        const score = spread * (1 - Math.min(dot, 1)) * (1 - Math.abs(1 - Math.min(legRatio, 1 / legRatio)));
        if (!best || score > best.score) best = { score, tri };
      }
    }
  }

  return (best ? best.tri : candidates.slice(0, 3)).map(c => ({ x: c.cx, y: c.cy }));
}

function distanceSq(a, b) {
  const dx = a.cx - b.cx;
  const dy = a.cy - b.cy;
  return dx * dx + dy * dy;
}

function canonicalFinderAssignment(centers) {
  if (centers.length !== 3) return null;
  let tl = 0;
  let tr = 0;
  let bl = 0;
  for (let i = 1; i < centers.length; i += 1) {
    if (centers[i].x + centers[i].y < centers[tl].x + centers[tl].y) tl = i;
    if (centers[i].x - centers[i].y > centers[tr].x - centers[tr].y) tr = i;
    if (centers[i].y - centers[i].x > centers[bl].y - centers[bl].x) bl = i;
  }
  if (new Set([tl, tr, bl]).size !== 3) return null;
  return [tl, tr, bl];
}

function finderAlignedGridFromBits(bits, centers, assignment, size = HIGH_FEATURE_SIZE, grid = 25) {
  const tl = centers[assignment[0]];
  const tr = centers[assignment[1]];
  const bl = centers[assignment[2]];
  const xAxis = { x: (tr.x - tl.x) / (grid - 7), y: (tr.y - tl.y) / (grid - 7) };
  const yAxis = { x: (bl.x - tl.x) / (grid - 7), y: (bl.y - tl.y) / (grid - 7) };
  const values = [];
  const mask = [];

  for (let my = 0; my < grid; my += 1) {
    for (let mx = 0; mx < grid; mx += 1) {
      const cx = tl.x + (mx - 3) * xAxis.x + (my - 3) * yAxis.x;
      const cy = tl.y + (mx - 3) * xAxis.y + (my - 3) * yAxis.y;
      let total = 0;
      let count = 0;
      for (let yy = -1; yy <= 1; yy += 1) {
        for (let xx = -1; xx <= 1; xx += 1) {
          const x = Math.round(cx + xx);
          const y = Math.round(cy + yy);
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          total += bits[y * size + x];
          count += 1;
        }
      }
      values.push(total / Math.max(count, 1) >= 0.45 ? 1 : 0);
      mask.push(count > 0 ? 1 : 0);
    }
  }

  return {
    grid,
    values: Buffer.from(Uint8Array.from(values)).toString("base64"),
    mask: Buffer.from(Uint8Array.from(mask)).toString("base64")
  };
}

function finderSamplesFromBits(bits, size = HIGH_FEATURE_SIZE, includeVariants = false) {
  const centers = detectFinderCenters(bits, size);
  if (centers.length !== 3) return { finderSample: null, finderSamples: null };
  const canonical = canonicalFinderAssignment(centers);
  const finderSample = canonical ? finderAlignedGridFromBits(bits, centers, canonical, size, 25) : null;
  if (!includeVariants) return { finderSample, finderSamples: null };
  const assignments = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0]
  ];
  return {
    finderSample,
    finderSamples: assignments.map(assignment => finderAlignedGridFromBits(bits, centers, assignment, size, 25))
  };
}

function getFeatureModuleGrid(feature, grid) {
  if (!feature.moduleGrids) feature.moduleGrids = {};
  if (!feature.moduleGrids[grid]) {
    const bits = Buffer.from(feature.bits, "base64");
    const mask = feature.mask ? Buffer.from(feature.mask, "base64") : null;
    feature.moduleGrids[grid] = moduleGridFromBits(bits, mask, FEATURE_SIZE, grid);
  }
  return feature.moduleGrids[grid];
}

function getFeatureSampledModuleGrid(feature, grid, padModules = 1) {
  const key = sampleKey(grid, padModules);
  if (feature.highSamples && feature.highSamples[key]) return feature.highSamples[key];
  if (!feature.sampledModuleGrids) feature.sampledModuleGrids = {};
  if (!feature.sampledModuleGrids[key]) {
    const bits = Buffer.from(feature.bits, "base64");
    const mask = feature.mask ? Buffer.from(feature.mask, "base64") : null;
    feature.sampledModuleGrids[key] = sampledModuleGridFromBits(bits, mask, FEATURE_SIZE, grid, padModules);
  }
  return feature.sampledModuleGrids[key];
}

async function appendIndex(item) {
  await fsp.appendFile(INDEX_FILE, JSON.stringify(indexItemForStorage(item)) + "\n", "utf8");
  indexItems.push(item);
  indexById.set(item.id, item);
}

async function writeState(extra = {}) {
  const state = {
    updatedAt: new Date().toISOString(),
    count: getTotalIndexCount(),
    ...extra
  };
  await fsp.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

async function fileHash(filePath) {
  const hash = crypto.createHash("sha1");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function* walkFiles(root) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

async function loadPdfJs() {
  if (pdfjsCache) return pdfjsCache;
  const pdfjsPath = require.resolve("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfjs = await import(pathToFileURL(pdfjsPath).href);
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
  pdfjsCache = pdfjs;
  return pdfjsCache;
}

function pdfLoadOptions(data) {
  const pdfjsRoot = path.dirname(path.dirname(require.resolve("pdfjs-dist/package.json")));
  const wasmUrl = `${pathToFileURL(path.join(pdfjsRoot, "wasm")).href}/`;
  return {
    data,
    disableWorker: true,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    wasmUrl,
    verbosity: 0
  };
}

function naturalCompare(a, b) {
  return a.localeCompare(b, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
}

async function collectImportFiles(source) {
  const stat = await fsp.stat(source);
  if (!stat.isDirectory()) return [source];
  const files = [];
  for await (const file of walkFiles(source)) files.push(file);
  return files.sort((a, b) => naturalCompare(path.basename(a), path.basename(b)));
}

async function saveBatchJob(extra = {}) {
  const job = {
    updatedAt: new Date().toISOString(),
    ...importProgress,
    ...extra
  };
  await fsp.writeFile(PDF_BATCH_JOB_FILE, JSON.stringify(job, null, 2), "utf8");
}

function importMemoryStatus() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = Math.max(0, total - free);
  const rss = process.memoryUsage().rss;
  return {
    totalMb: Math.round(total / 1024 / 1024),
    freeMb: Math.round(free / 1024 / 1024),
    usedMb: Math.round(used / 1024 / 1024),
    rssMb: Math.round(rss / 1024 / 1024),
    freeRatio: total ? free / total : 0,
    rssRatio: total ? rss / total : 0
  };
}

function adjustQrImportConcurrency() {
  const mem = importMemoryStatus();
  if (mem.freeRatio <= IMPORT_MEMORY_LOW_FREE_RATIO && adaptiveQrImportConcurrency > QR_IMPORT_ITEM_CONCURRENCY_MIN) {
    adaptiveQrImportConcurrency = Math.max(QR_IMPORT_ITEM_CONCURRENCY_MIN, Math.floor(adaptiveQrImportConcurrency / 2));
  } else if (mem.freeRatio >= IMPORT_MEMORY_HIGH_FREE_RATIO && adaptiveQrImportConcurrency < QR_IMPORT_ITEM_CONCURRENCY_MAX) {
    adaptiveQrImportConcurrency += 1;
  }
  importProgress.importConcurrency = adaptiveQrImportConcurrency;
  importProgress.memoryFreeMb = mem.freeMb;
  importProgress.memoryUsedMb = mem.usedMb;
  importProgress.processMemoryMb = mem.rssMb;
  return {
    concurrency: adaptiveQrImportConcurrency,
    memory: mem
  };
}

function startImportMemoryMonitor() {
  if (importMemoryMonitor) clearInterval(importMemoryMonitor);
  adaptiveQrImportConcurrency = Math.min(4, QR_IMPORT_ITEM_CONCURRENCY_MAX);
  adjustQrImportConcurrency();
  importMemoryMonitor = setInterval(() => {
    if (!importRunning) return;
    adjustQrImportConcurrency();
  }, IMPORT_MEMORY_CHECK_MS);
}

function stopImportMemoryMonitor() {
  if (importMemoryMonitor) {
    clearInterval(importMemoryMonitor);
    importMemoryMonitor = null;
  }
}

function median(values, fallback) {
  const nums = values.filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (nums.length === 0) return fallback;
  return nums[Math.floor(nums.length / 2)];
}

function clusterPositions(values, tolerance) {
  const sorted = [...values].sort((a, b) => a - b);
  const clusters = [];
  for (const value of sorted) {
    const last = clusters[clusters.length - 1];
    if (!last || Math.abs(last.center - value) > tolerance) {
      clusters.push({ center: value, values: [value] });
    } else {
      last.values.push(value);
      last.center = last.values.reduce((sum, v) => sum + v, 0) / last.values.length;
    }
  }
  return clusters.map(c => c.center);
}

function textItemsToQrCrops(textItems, pageWidth, pageHeight) {
  const numeric = textItems
    .map(item => ({
      text: String(item.str || "").trim(),
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height
    }))
    .filter(item => /^\d{6,}$/.test(item.text) && item.width > 10);

  if (numeric.length === 0) return [];

  const columns = clusterPositions(numeric.map(item => item.x + item.width / 2), 60);
  const rows = clusterPositions(numeric.map(item => item.y), 60);
  const colSpacing = median(columns.slice(1).map((x, i) => x - columns[i]), pageWidth / Math.max(columns.length, 4));
  const rowSpacing = median(rows.slice(1).map((y, i) => y - rows[i]), pageHeight / Math.max(rows.length, 3));

  return numeric.map((item, idx) => {
    const centerX = item.x + item.width / 2;
    const sizeByText = item.width * 0.58;
    const sizeByGrid = Math.min(colSpacing * 0.42, rowSpacing * 0.68);
    const size = Math.max(48, Math.min(sizeByText, sizeByGrid));
    const gap = Math.max(6, item.height * 0.35);
    const left = Math.round(Math.max(0, centerX - size / 2));
    const top = Math.round(Math.max(0, item.y - gap - size));
    const width = Math.round(Math.min(size, pageWidth - left));
    const height = Math.round(Math.min(size, pageHeight - top));
    return {
      index: idx + 1,
      text: item.text,
      crop: { left, top, width, height }
    };
  }).filter(item => item.crop.width >= 32 && item.crop.height >= 32);
}

async function detectQrCropsFromPagePng(pngBuffer) {
  const { data, info } = await sharp(pngBuffer)
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  const totalPixels = width * height;
  const black = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i += 1) black[i] = data[i] < 105 ? 1 : 0;

  const radius = Math.max(2, Math.round(width / 450));
  const sat = new Uint32Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let row = 0;
    for (let x = 0; x < width; x += 1) {
      row += black[y * width + x];
      sat[(y + 1) * (width + 1) + x + 1] = sat[y * (width + 1) + x + 1] + row;
    }
  }

  const dilated = new Uint8Array(totalPixels);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const sum = sat[(y1 + 1) * (width + 1) + x1 + 1]
        - sat[y0 * (width + 1) + x1 + 1]
        - sat[(y1 + 1) * (width + 1) + x0]
        + sat[y0 * (width + 1) + x0];
      if (sum > 0) dilated[y * width + x] = 1;
    }
  }

  const seen = new Uint8Array(totalPixels);
  const queueX = new Int32Array(totalPixels);
  const queueY = new Int32Array(totalPixels);
  const candidates = [];
  const minSize = Math.max(42, width * 0.045);
  const maxSize = Math.max(90, width * 0.19);

  for (let sy = 0; sy < height; sy += 1) {
    for (let sx = 0; sx < width; sx += 1) {
      const startIndex = sy * width + sx;
      if (!dilated[startIndex] || seen[startIndex]) continue;

      let head = 0;
      let tail = 0;
      let minX = sx;
      let maxX = sx;
      let minY = sy;
      let maxY = sy;
      let area = 0;
      let blackPixels = 0;
      queueX[tail] = sx;
      queueY[tail] = sy;
      tail += 1;
      seen[startIndex] = 1;

      while (head < tail) {
        const x = queueX[head];
        const y = queueY[head];
        head += 1;
        const idx = y * width + x;
        area += 1;
        blackPixels += black[idx];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;

        if (x + 1 < width) {
          const ni = y * width + x + 1;
          if (dilated[ni] && !seen[ni]) {
            seen[ni] = 1;
            queueX[tail] = x + 1;
            queueY[tail] = y;
            tail += 1;
          }
        }
        if (x > 0) {
          const ni = y * width + x - 1;
          if (dilated[ni] && !seen[ni]) {
            seen[ni] = 1;
            queueX[tail] = x - 1;
            queueY[tail] = y;
            tail += 1;
          }
        }
        if (y + 1 < height) {
          const ni = (y + 1) * width + x;
          if (dilated[ni] && !seen[ni]) {
            seen[ni] = 1;
            queueX[tail] = x;
            queueY[tail] = y + 1;
            tail += 1;
          }
        }
        if (y > 0) {
          const ni = (y - 1) * width + x;
          if (dilated[ni] && !seen[ni]) {
            seen[ni] = 1;
            queueX[tail] = x;
            queueY[tail] = y - 1;
            tail += 1;
          }
        }
      }

      const boxWidth = maxX - minX + 1;
      const boxHeight = maxY - minY + 1;
      const ratio = boxWidth / boxHeight;
      const fill = blackPixels / Math.max(area, 1);
      if (
        boxWidth >= minSize &&
        boxHeight >= minSize &&
        boxWidth <= maxSize &&
        boxHeight <= maxSize &&
        ratio >= 0.74 &&
        ratio <= 1.26 &&
        fill >= 0.06
      ) {
        const side = Math.max(boxWidth, boxHeight) + Math.round(radius * 3);
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const left = Math.max(0, Math.round(centerX - side / 2));
        const top = Math.max(0, Math.round(centerY - side / 2));
        candidates.push({
          text: null,
          crop: {
            left,
            top,
            width: Math.min(Math.round(side), width - left),
            height: Math.min(Math.round(side), height - top)
          }
        });
      }
    }
  }

  candidates.sort((a, b) => {
    const dy = a.crop.top - b.crop.top;
    return Math.abs(dy) > 20 ? dy : a.crop.left - b.crop.left;
  });

  return candidates.map((item, index) => ({
    ...item,
    index: index + 1
  }));
}

async function renderPdfPageItems(pdfjs, page, scale = 2.4) {
  const { createCanvas, DOMMatrix, ImageData, Path2D } = require("@napi-rs/canvas");
  globalThis.DOMMatrix = globalThis.DOMMatrix || DOMMatrix;
  globalThis.ImageData = globalThis.ImageData || ImageData;
  globalThis.Path2D = globalThis.Path2D || Path2D;

  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext("2d");
  await page.render({ canvasContext: context, viewport }).promise;

  const textContent = await page.getTextContent();
  const textItems = textContent.items.map(item => {
    const tx = pdfjs.Util.transform(viewport.transform, item.transform);
    const height = Math.abs(tx[3]) || Math.abs(item.height * scale) || 12;
    return {
      str: item.str,
      x: tx[4],
      y: tx[5] - height,
      width: (item.width || 0) * scale,
      height
    };
  });

  const png = await canvas.encode("png");
  let crops = textItemsToQrCrops(textItems, canvas.width, canvas.height);
  if (crops.length === 0) crops = await detectQrCropsFromPagePng(png);
  return { png, width: canvas.width, height: canvas.height, crops };
}

async function extractPdfPageItems(pdfPath, pageNumber, scale = 2.4) {
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await fsp.readFile(pdfPath));
  const doc = await pdfjs.getDocument(pdfLoadOptions(data)).promise;
  try {
    const page = await doc.getPage(pageNumber);
    return await renderPdfPageItems(pdfjs, page, scale);
  } finally {
    await doc.destroy();
  }
}

function extractZip(zipPath) {
  return new Promise((resolve, reject) => {
    const base = path.basename(zipPath, path.extname(zipPath)).replace(/[^\w.-]+/g, "_");
    const target = path.join(IMPORT_DIR, `${base}_${Date.now()}`);
    fs.mkdirSync(target, { recursive: true });
    const ps = spawn("powershell", [
      "-NoProfile",
      "-Command",
      "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
      zipPath,
      target
    ], { windowsHide: true });
    let err = "";
    ps.stderr.on("data", chunk => { err += chunk.toString(); });
    ps.on("close", code => {
      if (code === 0) resolve(target);
      else reject(new Error(err || `ZIP 解压失败，退出码 ${code}`));
    });
  });
}

function toBitArray(raw) {
  const bits = new Uint8Array(raw.length);
  let sum = 0;
  for (const v of raw) sum += v;
  const threshold = sum / raw.length;
  for (let i = 0; i < raw.length; i += 1) bits[i] = raw[i] < threshold ? 1 : 0;
  return bits;
}

function toFixedThresholdBitArray(raw, threshold = 145) {
  const bits = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bits[i] = raw[i] < threshold ? 1 : 0;
  return bits;
}

function confidenceMask(raw) {
  const mask = new Uint8Array(raw.length);
  let sum = 0;
  for (const v of raw) sum += v;
  const threshold = sum / raw.length;
  let valid = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const reliable = Math.abs(raw[i] - threshold) >= 18;
    mask[i] = reliable ? 1 : 0;
    valid += reliable ? 1 : 0;
  }
  if (valid / raw.length < 0.35) {
    mask.fill(1);
    valid = raw.length;
  }
  return { mask, valid };
}

function suppressLargeInteriorWhiteDamage(bits, mask, size = FEATURE_SIZE) {
  const seen = new Uint8Array(bits.length);
  const queue = new Int32Array(bits.length);
  const minArea = Math.round(bits.length * 0.018);

  for (let start = 0; start < bits.length; start += 1) {
    if (bits[start] !== 0 || seen[start]) continue;
    let head = 0;
    let tail = 0;
    let area = 0;
    let touchesBorder = false;
    let minX = size;
    let maxX = 0;
    let minY = size;
    let maxY = 0;
    queue[tail++] = start;
    seen[start] = 1;

    while (head < tail) {
      const idx = queue[head++];
      const x = idx % size;
      const y = Math.floor(idx / size);
      area += 1;
      if (x === 0 || y === 0 || x === size - 1 || y === size - 1) touchesBorder = true;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      const neighbors = [];
      if (x > 0) neighbors.push(idx - 1);
      if (x + 1 < size) neighbors.push(idx + 1);
      if (y > 0) neighbors.push(idx - size);
      if (y + 1 < size) neighbors.push(idx + size);
      for (const next of neighbors) {
        if (bits[next] === 0 && !seen[next]) {
          seen[next] = 1;
          queue[tail++] = next;
        }
      }
    }

    const boxW = maxX - minX + 1;
    const boxH = maxY - minY + 1;
    const compact = area / Math.max(boxW * boxH, 1);
    if (!touchesBorder && area >= minArea && boxW >= 7 && boxH >= 7 && compact >= 0.42) {
      for (let i = 0; i < tail; i += 1) mask[queue[i]] = 0;
    }
  }
}

function blockFeatures(bits, size = FEATURE_SIZE, blocks = BLOCKS) {
  const step = size / blocks;
  const out = [];
  for (let by = 0; by < blocks; by += 1) {
    for (let bx = 0; bx < blocks; bx += 1) {
      let total = 0;
      let count = 0;
      const y0 = Math.floor(by * step);
      const y1 = Math.floor((by + 1) * step);
      const x0 = Math.floor(bx * step);
      const x1 = Math.floor((bx + 1) * step);
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          total += bits[y * size + x];
          count += 1;
        }
      }
      out.push(Math.round((total / Math.max(count, 1)) * 255));
    }
  }
  return out;
}

function projectionFeatures(bits, size = FEATURE_SIZE) {
  const rows = [];
  const cols = [];
  for (let y = 0; y < size; y += 1) {
    let total = 0;
    for (let x = 0; x < size; x += 1) total += bits[y * size + x];
    rows.push(Math.round((total / size) * 255));
  }
  for (let x = 0; x < size; x += 1) {
    let total = 0;
    for (let y = 0; y < size; y += 1) total += bits[y * size + x];
    cols.push(Math.round((total / size) * 255));
  }
  return { rows, cols };
}

function edgeDensity(bits, size = FEATURE_SIZE) {
  let changes = 0;
  let total = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 1; x < size; x += 1) {
      changes += bits[y * size + x] !== bits[y * size + x - 1] ? 1 : 0;
      total += 1;
    }
  }
  for (let y = 1; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      changes += bits[y * size + x] !== bits[(y - 1) * size + x] ? 1 : 0;
      total += 1;
    }
  }
  return changes / total;
}

async function imageFeature(filePath, crop, options = {}) {
  let img = sharp(filePath, { failOn: "none" }).rotate();
  const meta = await img.metadata();
  if (!meta.width || !meta.height) throw new Error("无法读取图片尺寸");
  if (crop) {
    const left = Math.max(0, Math.round(crop.x));
    const top = Math.max(0, Math.round(crop.y));
    const width = Math.max(8, Math.min(Math.round(crop.w), meta.width - left));
    const height = Math.max(8, Math.min(Math.round(crop.h), meta.height - top));
    img = img.extract({ left, top, width, height });
  }
  if (options.autoTrim) {
    try {
      const currentMeta = await img.metadata();
      if (currentMeta.width && currentMeta.height && currentMeta.width !== currentMeta.height) {
        const side = Math.max(currentMeta.width, currentMeta.height);
        const left = Math.floor((side - currentMeta.width) / 2);
        const right = side - currentMeta.width - left;
        const top = Math.floor((side - currentMeta.height) / 2);
        const bottom = side - currentMeta.height - top;
        img = img.extend({ top, bottom, left, right, background: "white" });
      }
    } catch {
      // Keep the original crop if square padding cannot be applied.
    }
  }
  const resized = img
    .resize(FEATURE_SIZE, FEATURE_SIZE, { fit: "fill" })
    .grayscale();
  const highResized = img
    .clone()
    .resize(HIGH_FEATURE_SIZE, HIGH_FEATURE_SIZE, { fit: "fill" })
    .grayscale();
  const highGrayRaw = await highResized.clone().raw().toBuffer();
  const highNormalizedRaw = await highResized.clone().normalize().raw().toBuffer();
  const highBits = toBitArray(highNormalizedRaw);
  const highConfidence = options.maskUncertain ? confidenceMask(highGrayRaw) : null;
  if (highConfidence) suppressLargeInteriorWhiteDamage(highBits, highConfidence.mask, HIGH_FEATURE_SIZE);
  const finderSamples = finderSamplesFromBits(highBits, HIGH_FEATURE_SIZE, Boolean(options.finderVariants));
  const grayRaw = await resized.clone().raw().toBuffer();
  const normalizedRaw = await resized.clone().normalize().raw().toBuffer();
  const bits = toBitArray(normalizedRaw);
  const confidence = options.maskUncertain ? confidenceMask(grayRaw) : null;
  if (confidence) suppressLargeInteriorWhiteDamage(bits, confidence.mask);
  const blocks = blockFeatures(bits);
  const projections = projectionFeatures(bits);
  const density = bits.reduce((sum, v) => sum + v, 0) / bits.length;
  return {
    width: meta.width,
    height: meta.height,
    blocks,
    rows: projections.rows,
    cols: projections.cols,
    density,
    edge: edgeDensity(bits),
    bits: Buffer.from(bits).toString("base64"),
    mask: confidence ? Buffer.from(confidence.mask).toString("base64") : null,
    modules: moduleGridFromBits(bits, confidence ? confidence.mask : null),
    highSamples: highSampleGridsFromBits(highBits, highConfidence ? highConfidence.mask : null),
    finderSample: finderSamples.finderSample,
    finderSamples: finderSamples.finderSamples,
    manual21: (await manualGridFeatureFromSharp(img.clone(), 21, { normalize: true })).modules,
    validRatio: confidence ? Math.round((confidence.valid / bits.length) * 10000) / 100 : 100
  };
}

function coarseDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.blocks.length; i += 1) {
    const d = a.blocks[i] - b.blocks[i];
    sum += d * d;
  }
  let proj = 0;
  for (let i = 0; i < a.rows.length; i += 1) {
    proj += Math.abs(a.rows[i] - b.rows[i]);
    proj += Math.abs(a.cols[i] - b.cols[i]);
  }
  const density = Math.abs(a.density - b.density) * 1800;
  const edge = Math.abs(a.edge - b.edge) * 900;
  return Math.sqrt(sum / a.blocks.length) + proj / 128 + density + edge;
}

function damagedQrCoarseDistance(target, candidate) {
  let blockPenalty = 0;
  let blockEvidence = 0;
  for (let i = 0; i < target.blocks.length; i += 1) {
    const bx = i % BLOCKS;
    const by = Math.floor(i / BLOCKS);
    if (isFinderZoneNormalized((bx + 0.5) / BLOCKS, (by + 0.5) / BLOCKS)) continue;
    const evidence = target.blocks[i] / 255;
    if (evidence < 0.08) continue;
    const missingBlack = Math.max(0, target.blocks[i] - candidate.blocks[i]);
    const excessBlack = Math.max(0, candidate.blocks[i] - target.blocks[i]) * 0.18;
    blockPenalty += (missingBlack * missingBlack + excessBlack * excessBlack) * (0.35 + evidence);
    blockEvidence += 1;
  }

  let projectionPenalty = 0;
  let projectionEvidence = 0;
  for (let i = 0; i < target.rows.length; i += 1) {
    if (target.rows[i] > 18) {
      projectionPenalty += Math.max(0, target.rows[i] - candidate.rows[i]);
      projectionPenalty += Math.max(0, candidate.rows[i] - target.rows[i]) * 0.12;
      projectionEvidence += 1;
    }
    if (target.cols[i] > 18) {
      projectionPenalty += Math.max(0, target.cols[i] - candidate.cols[i]);
      projectionPenalty += Math.max(0, candidate.cols[i] - target.cols[i]) * 0.12;
      projectionEvidence += 1;
    }
  }

  const blockScore = blockEvidence ? Math.sqrt(blockPenalty / blockEvidence) : 999;
  const projectionScore = projectionEvidence ? projectionPenalty / projectionEvidence : 999;
  const densityPenalty = Math.max(0, target.density - candidate.density) * 500;
  return blockScore + projectionScore + densityPenalty;
}

function isFinderZoneNormalized(x, y) {
  const inLeft = x < 0.31;
  const inRight = x > 0.69;
  const inTop = y < 0.31;
  const inBottom = y > 0.69;
  return (inLeft && inTop) || (inRight && inTop) || (inLeft && inBottom);
}

function dataModuleWeight(index, size = FEATURE_SIZE) {
  const x = (index % size) / (size - 1);
  const y = Math.floor(index / size) / (size - 1);
  return isFinderZoneNormalized(x, y) ? 0.12 : 1;
}

function rotateBits(bits, size, turns) {
  if (turns === 0) return bits;
  const out = new Uint8Array(bits.length);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let nx = x;
      let ny = y;
      if (turns === 1) {
        nx = size - 1 - y;
        ny = x;
      } else if (turns === 2) {
        nx = size - 1 - x;
        ny = size - 1 - y;
      } else if (turns === 3) {
        nx = y;
        ny = size - 1 - x;
      }
      out[ny * size + nx] = bits[y * size + x];
    }
  }
  return out;
}

function fineScore(targetFeature, itemFeature) {
  return moduleGridScoreBest(targetFeature, itemFeature);
  const a = Buffer.from(targetFeature.bits, "base64");
  const b0 = Buffer.from(itemFeature.bits, "base64");
  const mask = targetFeature.mask ? Buffer.from(targetFeature.mask, "base64") : null;
  let best = 0;
  for (let r = 0; r < 4; r += 1) {
    const b = rotateBits(b0, FEATURE_SIZE, r);
    let blackHit = 0;
    let blackTotal = 0;
    let whiteHit = 0;
    let whiteTotal = 0;
    for (let i = 0; i < a.length; i += 1) {
      if (mask && mask[i] === 0) continue;
      const weight = dataModuleWeight(i);
      if (weight <= 0) continue;
      if (a[i] === 1) {
        blackTotal += weight;
        if (b[i] === 1) blackHit += weight;
      } else {
        whiteTotal += weight;
        if (b[i] === 0) whiteHit += weight;
      }
    }
    if (blackTotal < a.length * 0.04) continue;
    const blackRecall = blackHit / blackTotal;
    const whiteAgreement = whiteTotal ? whiteHit / whiteTotal : 0;
    best = Math.max(best, blackRecall * 0.68 + whiteAgreement * 0.32);
  }
  return Math.round(best * 10000) / 100;
}

function moduleGridScoreBest(targetFeature, itemFeature) {
  let best = 0;
  const finderScore = finderAlignedScore(targetFeature, itemFeature);
  if (finderScore > best) best = finderScore;
  for (const grid of MODULE_GRIDS) {
    const score = moduleGridScoreForGrid(targetFeature, itemFeature, grid);
    if (score > best) best = score;
  }
  for (const grid of MODULE_GRIDS) {
    for (const pad of [0, 0.5, 1]) {
      const score = sampledModuleGridScoreForGrid(targetFeature, itemFeature, grid, pad);
      if (score > best) best = score;
    }
  }
  return Math.round(best * 100) / 100;
}

function finderAlignedScore(targetFeature, itemFeature) {
  const targetSamples = targetFeature.finderSamples || (targetFeature.finderSample ? [targetFeature.finderSample] : []);
  const itemSamples = itemFeature.finderSample ? [itemFeature.finderSample] : (itemFeature.finderSamples || []);
  if (!targetSamples.length || !itemSamples.length) return 0;
  let best = 0;
  for (const targetSample of targetSamples) {
    for (const itemSample of itemSamples) {
      const rawScore = moduleGridScore(
        { modules: targetSample },
        { modules: itemSample },
        { blackWeight: 0.92, whiteWeight: 0.08 }
      );
      const adjustedScore = rawScore >= 85 ? 100 - (100 - rawScore) * 0.55 : rawScore;
      if (adjustedScore > best) best = adjustedScore;
    }
  }
  return Math.round(best * 100) / 100;
}

function moduleGridScoreForGrid(targetFeature, itemFeature, grid) {
  const targetModules = getFeatureModuleGrid(targetFeature, grid);
  const itemModules = getFeatureModuleGrid(itemFeature, grid);
  return moduleGridScore(
    { modules: targetModules },
    { modules: itemModules }
  );
}

function sampledModuleGridScoreForGrid(targetFeature, itemFeature, grid, padModules) {
  const targetModules = getFeatureSampledModuleGrid(targetFeature, grid, padModules);
  const itemModules = getFeatureSampledModuleGrid(itemFeature, grid, padModules);
  return moduleGridScore(
    { modules: targetModules },
    { modules: itemModules },
    { blackWeight: 0.92, whiteWeight: 0.08 }
  );
}

function rotateGrid(values, grid, turns) {
  if (turns === 0) return values;
  const out = new Uint8Array(values.length);
  for (let y = 0; y < grid; y += 1) {
    for (let x = 0; x < grid; x += 1) {
      let nx = x;
      let ny = y;
      if (turns === 1) {
        nx = grid - 1 - y;
        ny = x;
      } else if (turns === 2) {
        nx = grid - 1 - x;
        ny = grid - 1 - y;
      } else if (turns === 3) {
        nx = y;
        ny = grid - 1 - x;
      }
      out[ny * grid + nx] = values[y * grid + x];
    }
  }
  return out;
}

function moduleGridScore(targetFeature, itemFeature, weights = {}) {
  const grid = targetFeature.modules.grid || MODULE_GRID;
  const target = Buffer.from(targetFeature.modules.values, "base64");
  const targetMask = Buffer.from(targetFeature.modules.mask, "base64");
  const candidate0 = Buffer.from(itemFeature.modules.values, "base64");
  const blackWeight = weights.blackWeight ?? 0.72;
  const whiteWeight = weights.whiteWeight ?? 0.28;
  let best = 0;

  for (let r = 0; r < 4; r += 1) {
    const candidate = rotateGrid(candidate0, grid, r);
    let blackHit = 0;
    let blackTotal = 0;
    let whiteHit = 0;
    let whiteTotal = 0;
    for (let i = 0; i < target.length; i += 1) {
      if (targetMask[i] === 0) continue;
      const x = (i % grid) / (grid - 1);
      const y = Math.floor(i / grid) / (grid - 1);
      const weight = isFinderZoneNormalized(x, y) ? 0.08 : 1;
      if (target[i] === 1) {
        blackTotal += weight;
        if (candidate[i] === 1) blackHit += weight;
      } else {
        whiteTotal += weight;
        if (candidate[i] === 0) whiteHit += weight;
      }
    }
    if (blackTotal < 10) continue;
    const blackRecall = blackHit / blackTotal;
    const whiteAgreement = whiteTotal ? whiteHit / whiteTotal : 0;
    const score = blackRecall * blackWeight + whiteAgreement * whiteWeight;
    if (score > best) best = score;
  }

  return Math.round(best * 10000) / 100;
}

function renderModuleGridPng(moduleGrid, outPath, outputSize = 260) {
  const grid = moduleGrid.grid || 25;
  const values = Buffer.from(moduleGrid.values, "base64");
  const quiet = 4;
  const moduleSize = Math.max(1, Math.floor(outputSize / (grid + quiet * 2)));
  const qrSize = moduleSize * grid;
  const offset = Math.floor((outputSize - qrSize) / 2);
  const rects = [];
  for (let y = 0; y < grid; y += 1) {
    for (let x = 0; x < grid; x += 1) {
      if (values[y * grid + x] !== 1) continue;
      rects.push(`<rect x="${offset + x * moduleSize}" y="${offset + y * moduleSize}" width="${moduleSize}" height="${moduleSize}"/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${outputSize}" height="${outputSize}" viewBox="0 0 ${outputSize} ${outputSize}"><rect width="100%" height="100%" fill="white"/><g fill="black">${rects.join("")}</g></svg>`;
  return sharp(Buffer.from(svg)).png().toFile(outPath);
}

function moduleGridBlackCount(moduleGrid) {
  const values = Buffer.from(moduleGrid.values, "base64");
  let count = 0;
  for (const value of values) {
    if (value === 1) count += 1;
  }
  return count;
}

function moduleGridLooksSquare(moduleGrid) {
  const grid = moduleGrid.grid || 25;
  const values = Buffer.from(moduleGrid.values, "base64");
  let minX = grid;
  let minY = grid;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < grid; y += 1) {
    for (let x = 0; x < grid; x += 1) {
      if (values[y * grid + x] !== 1) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return false;
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const ratio = width / Math.max(height, 1);
  return width >= grid * 0.68 && height >= grid * 0.68 && ratio >= 0.7 && ratio <= 1.45;
}

function directPreviewGridFromBits(bits, size = HIGH_FEATURE_SIZE, grid = 25) {
  const values = [];
  const mask = [];
  const step = size / grid;
  for (let gy = 0; gy < grid; gy += 1) {
    for (let gx = 0; gx < grid; gx += 1) {
      const x0 = Math.floor(gx * step);
      const x1 = Math.floor((gx + 1) * step);
      const y0 = Math.floor(gy * step);
      const y1 = Math.floor((gy + 1) * step);
      let total = 0;
      let count = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          total += bits[y * size + x];
          count += 1;
        }
      }
      values.push(total / Math.max(count, 1) >= 0.08 ? 1 : 0);
      mask.push(1);
    }
  }
  return {
    grid,
    values: Buffer.from(Uint8Array.from(values)).toString("base64"),
    mask: Buffer.from(Uint8Array.from(mask)).toString("base64")
  };
}

async function createTargetPreview(filePath, crop) {
  const previewId = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}_target.png`;
  const outPath = path.join(UPLOAD_DIR, previewId);
  let img = sharp(filePath, { failOn: "none" }).rotate();
  const meta = await img.metadata();
  if (crop && meta.width && meta.height) {
    const left = Math.max(0, Math.round(crop.x));
    const top = Math.max(0, Math.round(crop.y));
    const width = Math.max(8, Math.min(Math.round(crop.w), meta.width - left));
    const height = Math.max(8, Math.min(Math.round(crop.h), meta.height - top));
    img = img.extract({ left, top, width, height });
  }
  try {
    const currentMeta = await img.metadata();
    if (currentMeta.width && currentMeta.height && currentMeta.width !== currentMeta.height) {
      const side = Math.max(currentMeta.width, currentMeta.height);
      const left = Math.floor((side - currentMeta.width) / 2);
      const right = side - currentMeta.width - left;
      const top = Math.floor((side - currentMeta.height) / 2);
      const bottom = side - currentMeta.height - top;
      img = img.extend({ top, bottom, left, right, background: "white" });
    }
  } catch {
    // Keep the user crop if square padding cannot be applied.
  }
  try {
    const raw = await img
      .clone()
      .resize(HIGH_FEATURE_SIZE, HIGH_FEATURE_SIZE, { fit: "fill" })
      .grayscale()
      .normalize()
      .raw()
      .toBuffer();
    const bits = toFixedThresholdBitArray(raw, 145);
    const finderSamples = finderSamplesFromBits(bits, HIGH_FEATURE_SIZE, false);
    if (
      finderSamples.finderSample &&
      moduleGridBlackCount(finderSamples.finderSample) >= 45 &&
      moduleGridLooksSquare(finderSamples.finderSample)
    ) {
      await renderModuleGridPng(finderSamples.finderSample, outPath);
      return previewId;
    }
    const fallbackGrid = directPreviewGridFromBits(bits, HIGH_FEATURE_SIZE, 25);
    await renderModuleGridPng(fallbackGrid, outPath);
    return previewId;
  } catch {
    // Fall back to an enhanced crop preview when finder-based rectification fails.
  }
  await img
    .resize(260, 260, { fit: "fill" })
    .grayscale()
    .normalize()
    .linear(1.18, -10)
    .sharpen({ sigma: 0.8, m1: 0.7, m2: 1.2 })
    .png()
    .toFile(outPath);
  return previewId;
}

function pushTopResult(list, result, limit = FINE_KEEP) {
  list.push(result);
  list.sort((a, b) => b.score - a.score);
  if (list.length > limit) list.pop();
}

function publicSearchResult(row, targetFeature) {
  const result = {
    id: row.item.id,
    name: row.item.name,
    path: row.item.path,
    resultText: row.item.resultText || null,
    sourceType: row.item.sourceType || "image",
    sourcePdf: row.item.sourcePdf || null,
    sourcePage: row.item.sourcePage || null,
    coarseDistance: Math.round(row.distance * 100) / 100,
    score: fineScore(targetFeature, row.item.feature)
  };
  result.highConfidence = result.score >= HIGH_SCORE_THRESHOLD;
  return result;
}

function isSearchableGalleryItem(item) {
  if (item.sourceType === "pdf") return true;
  const width = item.feature?.width || 0;
  const height = item.feature?.height || 0;
  if (!width || !height) return false;
  const ratio = width / height;
  return ratio >= 0.9 && ratio <= 1.1;
}

function getSearchCandidates() {
  return indexItems.filter(isSearchableGalleryItem);
}

async function indexOne(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) return { skipped: true };
  const stat = await fsp.stat(filePath);
  const hash = await fileHash(filePath);
  const existing = indexItems.find(item => item.hash === hash);
  if (existing) return { skipped: true };
  const feature = await imageFeature(filePath);
  const id = crypto.createHash("sha1").update(`${filePath}|${hash}`).digest("hex").slice(0, 16);
  const item = {
    id,
    path: filePath,
    name: path.basename(filePath),
    size: stat.size,
    hash,
    resultText: null,
    sourceType: "image",
    importedAt: new Date().toISOString(),
    feature
  };
  await appendIndex(item);
  return { item };
}

async function indexImageQrBin(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) return { skipped: true };
  const hash = await fileHash(filePath);
  const existingSource = qrBinSourceByHash.get(hash);
  if (existingSource && existingSource.itemCount > 0) return { skipped: true };

  const source = {
    id: qrBinSources.length,
    path: filePath,
    name: path.basename(filePath),
    hash,
    startRecord: qrBinManifest.totalRecords,
    itemCount: 0,
    extractionMode: QR_EXTRACTION_MODE
  };
  qrBinSources[source.id] = source;

  const feature = await manualGridFeature(filePath, null, QR_GRID, {
    normalize: true,
    blackThreshold: 95,
    whiteThreshold: 185
  });
  if (!feature.modules || feature.modules.grid !== QR_GRID) throw new Error("二维码点阵提取失败");
  const code = await appendCodeText("");
  await appendQrBinRecord({
    packed: packModuleValues(Buffer.from(feature.modules.values, "base64")),
    codeOffset: code.offset,
    codeLength: code.length,
    sourceId: source.id,
    page: 0,
    itemIndex: 1
  });
  source.itemCount = 1;
  await appendQrBinSource(source);
  await saveQrBinManifest();
  return { item: { id: qrBinId(qrBinManifest.totalRecords - 1) } };
}

async function processPdfPageForQrBin(pdfjs, doc, filePath, pageNumber, pageCount) {
  importProgress.currentPage = pageNumber;
  importProgress.totalPages = pageCount;
  importProgress.currentPageDetected = 0;
  importProgress.message = `正在解析 PDF：${path.basename(filePath)} 第 ${pageNumber}/${pageCount} 页`;
  await saveBatchJob();

  const page = await doc.getPage(pageNumber);
  const pageItems = await renderPdfPageItems(pdfjs, page);
  const records = [];
  let failed = 0;
  let start = 0;
  while (start < pageItems.crops.length) {
    const { concurrency } = adjustQrImportConcurrency();
    const batch = pageItems.crops.slice(start, start + concurrency);
    const batchResults = await Promise.all(batch.map(async qr => {
      try {
        const feature = await manualGridFeatureFromSharp(
          sharp(pageItems.png).extract(qr.crop),
          QR_GRID,
          { normalize: true, blackThreshold: 95, whiteThreshold: 185 }
        );
        if (!feature.modules || feature.modules.grid !== QR_GRID) throw new Error("二维码点阵提取失败");
        return {
          ok: true,
          record: {
            packed: packModuleValues(Buffer.from(feature.modules.values, "base64")),
            text: qr.text || "",
            page: pageNumber,
            itemIndex: qr.index
          }
        };
      } catch {
        return { ok: false };
      }
    }));
    for (const result of batchResults) {
      if (result.ok) records.push(result.record);
      else failed += 1;
    }
    start += batch.length;
  }
  return {
    page: pageNumber,
    detected: pageItems.crops.length,
    records,
    failed
  };
}

async function indexPdf(filePath, options = {}) {
  const hash = await fileHash(filePath);
  const existingSource = qrBinSourceByHash.get(hash);
  const existingState = qrBinSourceState.get(hash);
  if ((existingState && existingState.status === "completed" && existingState.extractionMode === QR_EXTRACTION_MODE) || (existingSource && existingSource.itemCount > 0 && !existingState)) {
    return { indexed: 0, skipped: 1, failed: 0 };
  }
  let sourceState = existingState || null;
  let source;
  if (sourceState && sourceState.status === "importing" && sourceState.extractionMode === QR_EXTRACTION_MODE) {
    source = qrBinSources[sourceState.sourceId] || {
      id: sourceState.sourceId,
      path: filePath,
      name: path.basename(filePath),
      hash,
      startRecord: sourceState.startRecord,
      itemCount: sourceState.itemCount || 0,
      extractionMode: QR_EXTRACTION_MODE
    };
    qrBinSources[source.id] = source;
    await restoreQrBinCheckpoint(sourceState);
  } else {
    source = {
      id: qrBinSources.length,
      path: filePath,
      name: path.basename(filePath),
      hash,
      startRecord: qrBinManifest.totalRecords,
      itemCount: 0,
      extractionMode: QR_EXTRACTION_MODE
    };
    qrBinSources[source.id] = source;
    sourceState = {
      hash,
      sourceId: source.id,
      path: runtimePathToStored(filePath),
      name: source.name,
      status: "importing",
      extractionMode: QR_EXTRACTION_MODE,
      startRecord: source.startRecord,
      completedPage: 0,
      pageCount: 0,
      itemCount: 0,
      totalRecordsAfterCompleted: qrBinManifest.totalRecords,
      codesSizeAfterCompleted: await fileSizeOrZero(QR_CODES_FILE),
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    qrBinSourceState.set(hash, sourceState);
    await appendQrBinSource(source);
    await saveQrBinSourceState();
  }
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument(pdfLoadOptions(new Uint8Array(await fsp.readFile(filePath)))).promise;
  const pageCount = doc.numPages;

  let indexed = 0;
  let skipped = 0;
  let failed = 0;
  let detected = 0;
  let totalWrittenForSource = sourceState.itemCount || 0;
  const firstPage = Math.min((sourceState.completedPage || 0) + 1, pageCount + 1);
  sourceState.pageCount = pageCount;
  try {
    for (let startPage = firstPage; startPage <= pageCount; startPage += PDF_IMPORT_PAGE_CONCURRENCY) {
      const pageNumbers = [];
      for (let n = startPage; n <= pageCount && n < startPage + PDF_IMPORT_PAGE_CONCURRENCY; n += 1) {
        pageNumbers.push(n);
      }
      const pageResults = await Promise.all(pageNumbers.map(async pageNumber => {
        try {
          return await processPdfPageForQrBin(pdfjs, doc, filePath, pageNumber, pageCount);
        } catch {
          return { page: pageNumber, detected: 0, records: [], failed: 1 };
        }
      }));

      pageResults.sort((a, b) => a.page - b.page);
      for (const pageResult of pageResults) {
        detected += pageResult.detected;
        failed += pageResult.failed;
        importProgress.currentPage = pageResult.page;
        importProgress.totalPages = pageCount;
        importProgress.currentPageDetected = pageResult.detected;
        for (const record of pageResult.records) {
          const code = await appendCodeText(record.text);
          await appendQrBinRecord({
            packed: record.packed,
            codeOffset: code.offset,
            codeLength: code.length,
            sourceId: source.id,
            page: record.page,
            itemIndex: record.itemIndex
          });
          indexed += 1;
          totalWrittenForSource += 1;
        }
        sourceState.completedPage = pageResult.page;
        sourceState.itemCount = totalWrittenForSource;
        sourceState.totalRecordsAfterCompleted = qrBinManifest.totalRecords;
        sourceState.codesSizeAfterCompleted = await fileSizeOrZero(QR_CODES_FILE);
        sourceState.updatedAt = new Date().toISOString();
        qrBinSourceState.set(hash, sourceState);
        await saveQrBinManifest();
        await saveQrBinSourceState();
        if (options.onPage) await options.onPage({ page: pageResult.page, pageCount, indexed, skipped, failed, detected });
        await saveBatchJob({ pdfResult: { indexed, skipped, failed, detected } });
      }
    }
  } finally {
    await doc.destroy();
    if ((sourceState.completedPage || 0) >= pageCount) {
      sourceState.status = "completed";
      sourceState.completedAt = new Date().toISOString();
      sourceState.updatedAt = new Date().toISOString();
      source.itemCount = totalWrittenForSource;
      await appendQrBinSource(source);
      qrBinSourceByHash.set(hash, source);
    }
    qrBinSourceState.set(hash, sourceState);
    await saveQrBinSourceState();
    await saveQrBinManifest();
  }
  if (detected === 0) failed += 1;
  return { indexed, skipped, failed };
}

async function importPath(inputPath) {
  if (importRunning) throw new Error("已有导入任务正在运行");
  importRunning = true;
  importProgress = { running: true, scanned: 0, indexed: 0, skipped: 0, failed: 0, errors: [], message: "准备导入" };
  startImportMemoryMonitor();
  try {
    let source = inputPath.trim().replace(/^"|"$/g, "");
    const stat = await fsp.stat(source);
    if (stat.isFile() && path.extname(source).toLowerCase() === ".zip") {
      importProgress.message = "正在解压 ZIP";
      source = await extractZip(source);
    }
    const files = await collectImportFiles(source);
    importProgress.totalFiles = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return IMAGE_EXTS.has(ext) || PDF_EXTS.has(ext);
    }).length;
    await saveBatchJob({ source });

    for (const file of files) {
      importProgress.scanned += 1;
      importProgress.currentFile = path.basename(file);
      importProgress.currentFileIndex = importProgress.scanned;
      importProgress.currentPage = 0;
      importProgress.totalPages = 0;
      importProgress.currentPageDetected = 0;
      const ext = path.extname(file).toLowerCase();
      if (!IMAGE_EXTS.has(ext) && !PDF_EXTS.has(ext)) {
        importProgress.skipped += 1;
        continue;
      }
      try {
        if (PDF_EXTS.has(ext)) {
          importProgress.message = `正在解析 PDF：${path.basename(file)}（${importProgress.currentFileIndex}/${importProgress.totalFiles}）`;
          await saveBatchJob({ source });
          const before = {
            indexed: importProgress.indexed,
            skipped: importProgress.skipped,
            failed: importProgress.failed
          };
          const result = await indexPdf(file, {
            onPage: async ({ indexed, skipped, failed }) => {
              importProgress.indexed = before.indexed + indexed;
              importProgress.skipped = before.skipped + skipped;
              importProgress.failed = before.failed + failed;
              importProgress.message = `正在解析 PDF：${path.basename(file)} 第 ${importProgress.currentPage}/${importProgress.totalPages} 页`;
              await writeState({ lastImport: importProgress });
            }
          });
          importProgress.indexed = before.indexed + result.indexed;
          importProgress.skipped = before.skipped + result.skipped;
          importProgress.failed = before.failed + result.failed;
        } else {
          const result = await indexImageQrBin(file);
          if (result.skipped) importProgress.skipped += 1;
          else importProgress.indexed += 1;
        }
      } catch (err) {
        importProgress.failed += 1;
        importProgress.errors.push(`${path.basename(file)}：${err.message || String(err)}`);
      }
      importProgress.message = `已处理 ${importProgress.scanned}/${importProgress.totalFiles} 个文件，新增 ${importProgress.indexed}`;
      await writeState({ lastImport: importProgress });
      await saveBatchJob({ source });
    }
    importProgress.message = "导入完成";
    await writeState({ lastImport: importProgress });
  } finally {
    importProgress.running = false;
    importRunning = false;
    stopImportMemoryMonitor();
  }
}

async function saveUpload(parts) {
  const file = parts.find(part => part.name === "image" && part.filename);
  if (!file) throw new Error("没有收到图片文件");
  const ext = path.extname(file.filename).toLowerCase() || ".jpg";
  const name = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`;
  const target = path.join(UPLOAD_DIR, name);
  await fsp.writeFile(target, file.data);
  const cropText = parts.find(part => part.name === "crop")?.data.toString("utf8") || "";
  let crop = null;
  if (cropText.trim()) crop = JSON.parse(cropText);
  return { target, crop };
}

async function tryDecodeDamaged() {
  return null;
}

async function manualGridFeature(filePath, crop = null, grid = 21, options = {}) {
  let img = sharp(filePath, { failOn: "none" }).rotate();
  const meta = await img.metadata();
  if (!meta.width || !meta.height) throw new Error("无法读取图片尺寸");
  if (crop) {
    const left = Math.max(0, Math.round(crop.x));
    const top = Math.max(0, Math.round(crop.y));
    const width = Math.max(8, Math.min(Math.round(crop.w), meta.width - left));
    const height = Math.max(8, Math.min(Math.round(crop.h), meta.height - top));
    img = img.extract({ left, top, width, height });
  }
  return manualGridFeatureFromSharp(img, grid, options);
}

async function manualGridFeatureFromSharp(img, grid = 21, options = {}) {
  const blackThreshold = options.blackThreshold ?? 95;
  const whiteThreshold = options.whiteThreshold ?? 185;
  const grayUnknown = options.grayUnknown ?? false;
  const grayUnknownRatio = options.grayUnknownRatio ?? 0.08;
  const unknownExpand = Math.max(0, Math.floor(options.unknownExpand || 0));
  const sampleInset = options.sampleInset ?? 0.25;
  const sampleSize = Math.max(260, grid * 20);
  let prepared = img
    .resize(sampleSize, sampleSize, { fit: "fill" })
    .removeAlpha()
    .grayscale();
  if (options.normalize) prepared = prepared.normalize();
  const { data, info } = await prepared.raw().toBuffer({ resolveWithObject: true });

  const grayMap = new Float32Array(info.width * info.height);
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const idx = (y * info.width + x) * info.channels;
      const gray = data[idx];
      grayMap[y * info.width + x] = gray;
      if (gray <= blackThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const foundBlack = maxX >= minX && maxY >= minY;
  let centerX;
  let centerY;
  let side;
  if (options.gridFit === "full") {
    const baseSide = Math.min(info.width, info.height);
    const margin = options.marginPx ?? Math.max(0, baseSide * (options.marginRatio || 0));
    centerX = info.width / 2;
    centerY = info.height / 2;
    side = Math.max(grid, baseSide - margin * 2);
  } else {
    centerX = foundBlack ? (minX + maxX) / 2 : info.width / 2;
    centerY = foundBlack ? (minY + maxY) / 2 : info.height / 2;
    side = foundBlack ? Math.max(maxX - minX + 1, maxY - minY + 1) : Math.min(info.width, info.height);
  }
  centerX += options.offsetX || 0;
  centerY += options.offsetY || 0;
  side *= options.sideScale || 1;
  const left = centerX - side / 2;
  const top = centerY - side / 2;

  const values = [];
  const mask = [];
  const cell = side / grid;
  let known = 0;
  let black = 0;
  let white = 0;
  let unknown = 0;

  for (let gy = 0; gy < grid; gy += 1) {
    for (let gx = 0; gx < grid; gx += 1) {
      const x0 = Math.floor(left + gx * cell + cell * sampleInset);
      const x1 = Math.ceil(left + (gx + 1) * cell - cell * sampleInset);
      const y0 = Math.floor(top + gy * cell + cell * sampleInset);
      const y1 = Math.ceil(top + (gy + 1) * cell - cell * sampleInset);
      let total = 0;
      let count = 0;
      let grayPixels = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          if (x < 0 || y < 0 || x >= info.width || y >= info.height) continue;
          const pixelGray = grayMap[y * info.width + x];
          total += pixelGray;
          if (pixelGray > blackThreshold && pixelGray < whiteThreshold) grayPixels += 1;
          count += 1;
        }
      }
      const gray = total / Math.max(count, 1);
      if (grayUnknown && grayPixels / Math.max(count, 1) >= grayUnknownRatio) {
        values.push(0);
        mask.push(0);
        unknown += 1;
      } else if (gray <= blackThreshold) {
        values.push(1);
        mask.push(1);
        known += 1;
        black += 1;
      } else if (gray >= whiteThreshold) {
        values.push(0);
        mask.push(1);
        known += 1;
        white += 1;
      } else {
        values.push(0);
        mask.push(0);
        unknown += 1;
      }
    }
  }

  if (unknownExpand > 0 && unknown > 0) {
    const expandedMask = mask.slice();
    for (let y = 0; y < grid; y += 1) {
      for (let x = 0; x < grid; x += 1) {
        const idx = y * grid + x;
        if (mask[idx] !== 0) continue;
        for (let dy = -unknownExpand; dy <= unknownExpand; dy += 1) {
          for (let dx = -unknownExpand; dx <= unknownExpand; dx += 1) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= grid || ny >= grid) continue;
            expandedMask[ny * grid + nx] = 0;
          }
        }
      }
    }
    known = 0;
    black = 0;
    white = 0;
    unknown = 0;
    for (let i = 0; i < expandedMask.length; i += 1) {
      mask[i] = expandedMask[i];
      if (mask[i] === 0) {
        unknown += 1;
      } else {
        known += 1;
        if (values[i] === 1) black += 1;
        else white += 1;
      }
    }
  }

  return {
    grid,
    known,
    black,
    white,
    unknown,
    knownRatio: Math.round((known / (grid * grid)) * 10000) / 100,
    modules: {
      grid,
      values: Buffer.from(Uint8Array.from(values)).toString("base64"),
      mask: Buffer.from(Uint8Array.from(mask)).toString("base64")
    }
  };
}

function manualGridFeatureFromPageGray(pageItems, crop, grid = QR_GRID, options = {}) {
  const blackThreshold = options.blackThreshold ?? 95;
  const whiteThreshold = options.whiteThreshold ?? 185;
  const data = pageItems.gray.data;
  const info = pageItems.gray.info;
  const channels = info.channels || 1;
  const cropLeft = Math.max(0, Math.round(crop.left));
  const cropTop = Math.max(0, Math.round(crop.top));
  const cropWidth = Math.max(1, Math.min(Math.round(crop.width), info.width - cropLeft));
  const cropHeight = Math.max(1, Math.min(Math.round(crop.height), info.height - cropTop));

  let minX = cropWidth;
  let minY = cropHeight;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < cropHeight; y += 1) {
    const py = cropTop + y;
    for (let x = 0; x < cropWidth; x += 1) {
      const px = cropLeft + x;
      const gray = data[(py * info.width + px) * channels];
      if (gray <= blackThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const foundBlack = maxX >= minX && maxY >= minY;
  const centerX = foundBlack ? (minX + maxX) / 2 : cropWidth / 2;
  const centerY = foundBlack ? (minY + maxY) / 2 : cropHeight / 2;
  const side = foundBlack ? Math.max(maxX - minX + 1, maxY - minY + 1) : Math.min(cropWidth, cropHeight);
  const left = centerX - side / 2;
  const top = centerY - side / 2;
  const cell = side / grid;

  const values = [];
  const mask = [];
  let known = 0;
  let black = 0;
  let white = 0;
  let unknown = 0;

  for (let gy = 0; gy < grid; gy += 1) {
    for (let gx = 0; gx < grid; gx += 1) {
      const x0 = Math.floor(left + gx * cell + cell * 0.25);
      const x1 = Math.ceil(left + (gx + 1) * cell - cell * 0.25);
      const y0 = Math.floor(top + gy * cell + cell * 0.25);
      const y1 = Math.ceil(top + (gy + 1) * cell - cell * 0.25);
      let total = 0;
      let count = 0;
      for (let y = y0; y < y1; y += 1) {
        const py = cropTop + y;
        if (py < 0 || py >= info.height) continue;
        for (let x = x0; x < x1; x += 1) {
          const px = cropLeft + x;
          if (px < 0 || px >= info.width) continue;
          total += data[(py * info.width + px) * channels];
          count += 1;
        }
      }
      const gray = total / Math.max(count, 1);
      if (gray <= blackThreshold) {
        values.push(1);
        mask.push(1);
        known += 1;
        black += 1;
      } else if (gray >= whiteThreshold) {
        values.push(0);
        mask.push(1);
        known += 1;
        white += 1;
      } else {
        values.push(0);
        mask.push(0);
        unknown += 1;
      }
    }
  }

  return {
    grid,
    known,
    black,
    white,
    unknown,
    knownRatio: Math.round((known / (grid * grid)) * 10000) / 100,
    modules: {
      grid,
      values: Buffer.from(Uint8Array.from(values)).toString("base64"),
      mask: Buffer.from(Uint8Array.from(mask)).toString("base64")
    }
  };
}

function isManualGridUsable(feature) {
  return feature && feature.grid === 21 && feature.known >= 35 && feature.black >= 5 && feature.white >= 5;
}

async function createManualGridPreview(feature) {
  const previewId = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}_manual21.png`;
  const outPath = path.join(UPLOAD_DIR, previewId);
  const grid = feature.grid;
  const values = Buffer.from(feature.modules.values, "base64");
  const mask = Buffer.from(feature.modules.mask, "base64");
  const outputSize = 260;
  const quiet = 4;
  const moduleSize = Math.max(1, Math.floor(outputSize / (grid + quiet * 2)));
  const qrSize = moduleSize * grid;
  const offset = Math.floor((outputSize - qrSize) / 2);
  const rects = [];
  for (let y = 0; y < grid; y += 1) {
    for (let x = 0; x < grid; x += 1) {
      const idx = y * grid + x;
      const fill = mask[idx] === 0 ? "#b8b8b8" : (values[idx] === 1 ? "#000" : "#fff");
      rects.push(`<rect x="${offset + x * moduleSize}" y="${offset + y * moduleSize}" width="${moduleSize}" height="${moduleSize}" fill="${fill}"/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${outputSize}" height="${outputSize}" viewBox="0 0 ${outputSize} ${outputSize}"><rect width="100%" height="100%" fill="white"/><g>${rects.join("")}</g></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  return previewId;
}

async function createOriginalUploadPreview(filePath, crop = null) {
  const previewId = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}_original.png`;
  const outPath = path.join(UPLOAD_DIR, previewId);
  let img = sharp(filePath, { failOn: "none" }).rotate();
  const meta = await img.metadata();
  if (crop && meta.width && meta.height) {
    const left = Math.max(0, Math.round(crop.x));
    const top = Math.max(0, Math.round(crop.y));
    const width = Math.max(8, Math.min(Math.round(crop.w), meta.width - left));
    const height = Math.max(8, Math.min(Math.round(crop.h), meta.height - top));
    img = img.extract({ left, top, width, height });
  }
  await img
    .resize(260, 260, { fit: "contain", background: "white" })
    .png()
    .toFile(outPath);
  return previewId;
}

function manualGridScore(targetFeature, itemFeature) {
  const target = Buffer.from(targetFeature.modules.values, "base64");
  const targetMask = Buffer.from(targetFeature.modules.mask, "base64");
  const candidateModuleList = [];
  if (itemFeature.manual21 && itemFeature.manual21.grid === targetFeature.grid) {
    candidateModuleList.push(itemFeature.manual21);
  }
  if (itemFeature.modules && itemFeature.modules.grid === targetFeature.grid) {
    candidateModuleList.push(itemFeature.modules);
  } else if (itemFeature.bits) {
    const bits = Buffer.from(itemFeature.bits, "base64");
    const mask = itemFeature.mask ? Buffer.from(itemFeature.mask, "base64") : null;
    candidateModuleList.push(moduleGridFromBits(bits, mask, FEATURE_SIZE, targetFeature.grid));
  }
  if (itemFeature.finderSample && itemFeature.finderSample.grid === targetFeature.grid) {
    candidateModuleList.push(itemFeature.finderSample);
  }
  if (itemFeature.highSamples) {
    for (const sample of Object.values(itemFeature.highSamples)) {
      if (sample.grid === targetFeature.grid) candidateModuleList.push(sample);
    }
  }
  let best = 0;

  for (const candidateModules of candidateModuleList) {
    const candidate0 = Buffer.from(candidateModules.values, "base64");
    for (let r = 0; r < 4; r += 1) {
      const candidate = rotateGrid(candidate0, targetFeature.grid, r);
      let hit = 0;
      let total = 0;
      for (let i = 0; i < target.length; i += 1) {
        if (targetMask[i] === 0) continue;
        total += 1;
        if (target[i] === candidate[i]) hit += 1;
      }
      if (total > 0) best = Math.max(best, hit / total);
    }
  }

  return Math.round(best * 10000) / 100;
}

function publicManualSearchResult(row, targetFeature) {
  const result = {
    id: row.item.id,
    name: row.item.name,
    path: row.item.path,
    resultText: row.item.resultText || null,
    sourceType: row.item.sourceType || "image",
    sourcePdf: row.item.sourcePdf || null,
    sourcePage: row.item.sourcePage || null,
    coarseDistance: 0,
    score: row.score
  };
  result.highConfidence = result.score >= HIGH_SCORE_THRESHOLD;
  return result;
}

function manualGridScoreForItem(targetFeature, item) {
  const sidecarManual21 = manual21ById.get(item.id);
  if (sidecarManual21) {
    return manualGridScore(targetFeature, { manual21: sidecarManual21 });
  }
  if (item.feature?.manual21 || item.feature?.modules) {
    return manualGridScore(targetFeature, item.feature);
  }
  return 0;
}

async function search(filePath, crop) {
  const decoded = await tryDecodeDamaged(filePath, crop);
  if (decoded) return { mode: "decoded", decoded, results: [] };
  const candidates = getSearchCandidates();
  if (candidates.length === 0) throw new Error("图库索引为空，或当前索引里没有可匹配的二维码图库");
  const targetFeature = await imageFeature(filePath, crop, { maskUncertain: true, autoTrim: true });
  const coarse = candidates
    .map(item => ({ item, distance: coarseDistance(targetFeature, item.feature) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, Math.min(COARSE_KEEP, candidates.length));

  const highConfidence = [];
  const bestOverall = [];
  for (const row of coarse) {
    const result = publicSearchResult(row, targetFeature);
    pushTopResult(bestOverall, result);
    if (result.highConfidence) pushTopResult(highConfidence, result);
  }

  const results = bestOverall;
  return {
    mode: "matched",
    decoded: null,
    count: candidates.length,
    coarseCount: coarse.length,
    threshold: HIGH_SCORE_THRESHOLD,
    validRatio: targetFeature.validRatio,
    highConfidenceCount: results.filter(item => item.highConfidence).length,
    results
  };
}

function createSearchTask() {
  const id = crypto.randomBytes(8).toString("hex");
  const task = {
    id,
    status: "queued",
    message: "等待匹配",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    count: getTotalIndexCount(),
    coarseCount: 0,
    coarseProcessed: 0,
    fineProcessed: 0,
    threshold: HIGH_SCORE_THRESHOLD,
    validRatio: 0,
    highConfidenceCount: 0,
    results: [],
    error: null,
    decoded: null,
    previewId: null
  };
  searchTasks.set(id, task);
  return task;
}

function updateSearchTask(task, patch) {
  Object.assign(task, patch, { updatedAt: new Date().toISOString() });
}

function searchTaskPayload(task) {
  return {
    id: task.id,
    status: task.status,
    message: task.message,
    count: task.count,
    coarseCount: task.coarseCount,
    coarseProcessed: task.coarseProcessed,
    fineProcessed: task.fineProcessed,
    threshold: task.threshold,
    validRatio: task.validRatio,
    highConfidenceCount: task.highConfidenceCount,
    results: task.results,
    error: task.error,
    decoded: task.decoded,
    previewId: task.previewId
  };
}

function yieldToLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

function sameManualGridModules(a, b) {
  return a?.modules?.values === b?.modules?.values && a?.modules?.mask === b?.modules?.mask;
}

function uniqueManualGridFeatures(features) {
  const unique = [];
  for (const feature of features) {
    if (!isManualGridUsable(feature)) continue;
    if (unique.some(item => sameManualGridModules(item, feature))) continue;
    unique.push(feature);
  }
  return unique;
}

function manualTargetGridOptions() {
  const base = {
    blackThreshold: 80,
    whiteThreshold: 245,
    grayUnknown: true,
    grayUnknownRatio: 0.04,
    unknownExpand: 1
  };
  return [
    base,
    { ...base, gridFit: "full", marginRatio: 0.03, sampleInset: 0.2 },
    { ...base, gridFit: "full", marginRatio: 0.02, sampleInset: 0.25 },
    { ...base, sideScale: 0.995, offsetX: -2, sampleInset: 0.25 }
  ];
}

async function manualTargetGridFeatures(filePath, crop) {
  const features = [];
  for (const options of manualTargetGridOptions()) {
    try {
      features.push(await manualGridFeature(filePath, crop, 21, options));
    } catch {
      // Keep the other extraction variants available when one grid fit fails.
    }
  }
  const unique = uniqueManualGridFeatures(features);
  const bestKnown = Math.max(0, ...unique.map(feature => feature.known || 0));
  return unique.filter(feature => feature.known >= Math.max(35, bestKnown * 0.75));
}

async function searchQrBinaryManual(task, manualFeatures) {
  const total = qrBinManifest?.totalRecords || 0;
  if (total <= 0) return null;
  const activeTotalEstimate = getActiveQrBinRecordEstimate() || total;
  const packedTargets = manualFeatures.map(packedTargetFromManualFeature);
  const tolerantCandidates = [];
  const bestOverall = [];
  let scanned = 0;
  let processed = 0;
  const shardCount = Math.ceil(total / QR_SHARD_SIZE);

  for (let shardIndex = 0; shardIndex < shardCount; shardIndex += 1) {
    const recordsInShard = Math.min(QR_SHARD_SIZE, total - shardIndex * QR_SHARD_SIZE);
    if (recordsInShard <= 0) break;
    const data = await fsp.readFile(qrShardPath(shardIndex));
    const availableRecords = Math.min(recordsInShard, Math.floor(data.length / QR_RECORD_SIZE));
    for (let i = 0; i < availableRecords; i += 1) {
      const offset = i * QR_RECORD_SIZE;
      const sourceId = data.readUInt32LE(offset + 64);
      const source = qrBinSources[sourceId];
      scanned += 1;
      if (!isActiveQrBinSource(source)) {
        continue;
      }
      const packed = data.subarray(offset, offset + QR_PACKED_BYTES);
      let score = 0;
      for (const target of packedTargets) {
        const s = scorePackedQr(target, packed);
        if (s > score) score = s;
      }
      const recordNo = shardIndex * QR_SHARD_SIZE + i;
      if (tolerantCandidates.length < 200 || score > tolerantCandidates[tolerantCandidates.length - 1].score) {
        const meta = decodeQrBinRecord(recordNo, data.subarray(offset, offset + QR_RECORD_SIZE));
        tolerantCandidates.push({ meta, packed: Buffer.from(packed), score });
        tolerantCandidates.sort((a, b) => b.score - a.score);
        if (tolerantCandidates.length > 200) tolerantCandidates.pop();
      }
      if (bestOverall.length < FINE_KEEP || score > bestOverall[bestOverall.length - 1].score) {
        const meta = decodeQrBinRecord(recordNo, data.subarray(offset, offset + QR_RECORD_SIZE));
        pushTopResult(bestOverall, { meta, score, highConfidence: score >= HIGH_SCORE_THRESHOLD });
      }
      processed += 1;
      if (processed % 50000 === 0) {
        updateSearchTask(task, {
          coarseProcessed: processed,
          coarseCount: activeTotalEstimate,
          fineProcessed: processed,
          highConfidenceCount: bestOverall.filter(item => item.highConfidence).length,
          results: await Promise.all(bestOverall.map(publicQrBinSearchResult)),
          message: `正在扫描轻量索引：${processed}/${total}`
        });
        await yieldToLoop();
      }
    }
  }

  const reranked = [];
  for (const row of tolerantCandidates) {
    let score = row.score;
    for (const target of packedTargets) {
      const tolerantScore = tolerantPackedQrScore(target, row.packed);
      if (tolerantScore > score) score = tolerantScore;
    }
    pushTopResult(reranked, {
      meta: row.meta,
      score,
      highConfidence: score >= HIGH_SCORE_THRESHOLD
    }, FINE_KEEP);
  }
  const finalRows = reranked.length ? reranked : bestOverall;
  const results = await Promise.all(finalRows.map(publicQrBinSearchResult));
  return {
    count: processed,
    scanned,
    results,
    highConfidenceCount: results.filter(item => item.highConfidence).length
  };
}

async function runSearchTask(task, filePath, crop) {
  try {
    updateSearchTask(task, { status: "running", message: "正在尝试解码" });
    const decoded = await tryDecodeDamaged(filePath, crop);
    if (decoded) {
      updateSearchTask(task, {
        status: "done",
        message: "破损图已解码",
        decoded,
        results: []
      });
      return;
    }
    const candidates = getSearchCandidates();
    const qrBinCount = getActiveQrBinRecordEstimate();
    if (candidates.length === 0 && qrBinCount === 0) throw new Error("图库索引为空，或当前索引里没有可匹配的二维码图库");

    updateSearchTask(task, { message: "正在生成裁剪预览", count: qrBinCount || candidates.length });
    const manualFeatures = await manualTargetGridFeatures(filePath, crop);
    if (manualFeatures.length > 0) {
      const manualFeature = manualFeatures.sort((a, b) => b.known - a.known)[0];
      const previewId = await createOriginalUploadPreview(filePath, crop);
      updateSearchTask(task, {
        previewId,
        validRatio: manualFeature.knownRatio,
        message: `正在按${manualFeature.grid}×${manualFeature.grid}确定点匹配：确定 ${manualFeature.known} 格，未知 ${manualFeature.unknown} 格`
      });

      const qrBinResult = await searchQrBinaryManual(task, manualFeatures);
      if (qrBinResult && candidates.length === 0) {
        updateSearchTask(task, {
          status: "done",
          message: "轻量索引匹配完成",
          count: qrBinResult.count,
          coarseProcessed: qrBinResult.count,
          coarseCount: qrBinResult.count,
          fineProcessed: qrBinResult.count,
          highConfidenceCount: qrBinResult.highConfidenceCount,
          results: qrBinResult.results
        });
        return;
      }

      const bestOverall = qrBinResult ? [...qrBinResult.results] : [];
      const chunkSize = 2000;
      for (let i = 0; i < candidates.length; i += 1) {
        const score = Math.max(...manualFeatures.map(feature => manualGridScoreForItem(feature, candidates[i])));
        pushTopResult(bestOverall, publicManualSearchResult({ item: candidates[i], score }, manualFeature));
        if ((i + 1) % chunkSize === 0 || i === candidates.length - 1) {
          updateSearchTask(task, {
            coarseProcessed: i + 1,
            coarseCount: candidates.length + (qrBinResult?.count || 0),
            fineProcessed: i + 1,
            highConfidenceCount: bestOverall.filter(item => item.highConfidence).length,
            results: [...bestOverall],
            message: `正在按人工修复图确定点匹配：${i + 1}/${candidates.length}`
          });
          await yieldToLoop();
        }
      }

      updateSearchTask(task, {
        status: "done",
        message: "人工修复图确定点匹配完成",
        coarseProcessed: candidates.length + (qrBinResult?.count || 0),
        coarseCount: candidates.length + (qrBinResult?.count || 0),
        fineProcessed: candidates.length + (qrBinResult?.count || 0),
        highConfidenceCount: bestOverall.filter(item => item.highConfidence).length,
        results: bestOverall
      });
      return;
    }

    const previewId = await createTargetPreview(filePath, crop);
    updateSearchTask(task, { previewId });

    updateSearchTask(task, { message: "正在提取目标图特征", count: candidates.length });
    const targetFeature = await imageFeature(filePath, crop, { maskUncertain: true, autoTrim: true, finderVariants: true });
    updateSearchTask(task, { validRatio: targetFeature.validRatio });

    updateSearchTask(task, { message: "正在粗筛图库" });
    const coarseRows = [];
    const chunkSize = 2000;
    for (let i = 0; i < candidates.length; i += 1) {
      coarseRows.push({ item: candidates[i], distance: damagedQrCoarseDistance(targetFeature, candidates[i].feature) });
      if ((i + 1) % chunkSize === 0) {
        updateSearchTask(task, { coarseProcessed: i + 1 });
        await yieldToLoop();
      }
    }
    coarseRows.sort((a, b) => a.distance - b.distance);
    const coarse = coarseRows.slice(0, Math.min(COARSE_KEEP, coarseRows.length));
    updateSearchTask(task, {
      coarseProcessed: candidates.length,
      coarseCount: coarse.length,
      message: "正在精排候选"
    });

    const bestOverall = [];
    for (let i = 0; i < coarse.length; i += 1) {
      const result = publicSearchResult(coarse[i], targetFeature);
      pushTopResult(bestOverall, result);
      if ((i + 1) % 25 === 0 || i === coarse.length - 1) {
        updateSearchTask(task, {
          fineProcessed: i + 1,
          highConfidenceCount: bestOverall.filter(item => item.highConfidence).length,
          results: [...bestOverall],
          message: `正在精排候选 ${i + 1}/${coarse.length}`
        });
        await yieldToLoop();
      }
    }

    updateSearchTask(task, {
      status: "done",
      message: "匹配完成",
      fineProcessed: coarse.length,
      highConfidenceCount: bestOverall.filter(item => item.highConfidence).length,
      results: bestOverall
    });
  } catch (err) {
    updateSearchTask(task, {
      status: "error",
      message: "匹配失败",
      error: err.message || String(err)
    });
  }
}

async function serveStatic(req, res) {
  let reqPath = new URL(req.url, `http://localhost:${PORT}`).pathname;
  if (reqPath === "/") reqPath = "/index.html";
  const filePath = safeJoin(PUBLIC_DIR, reqPath);
  if (!filePath) return sendText(res, "Forbidden", 403);
  try {
    const data = await fsp.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml"
    };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    sendText(res, "Not found", 404);
  }
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === "GET" && url.pathname === "/api/status") {
    return sendJson(res, {
      count: getTotalIndexCount(),
      progress: importProgress
    });
  }
  if (req.method === "POST" && url.pathname === "/api/import") {
    const body = await readJson(req);
    if (!body.path) return sendJson(res, { error: "请提供图库文件夹或 ZIP 路径" }, 400);
    importPath(body.path).catch(err => {
      importProgress.running = false;
      importProgress.message = err.message;
      importRunning = false;
    });
    return sendJson(res, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/api/search") {
    const body = await readRequestBody(req);
    const parts = parseMultipart(body, req.headers["content-type"]);
    const { target, crop } = await saveUpload(parts);
    const task = createSearchTask();
    runSearchTask(task, target, crop);
    return sendJson(res, { ok: true, taskId: task.id });
  }
  if (req.method === "GET" && url.pathname === "/api/search-status") {
    const id = url.searchParams.get("id");
    const task = searchTasks.get(id);
    if (!task) return sendJson(res, { error: "匹配任务不存在或已过期" }, 404);
    return sendJson(res, searchTaskPayload(task));
  }
  if (req.method === "GET" && url.pathname === "/api/image") {
    const id = url.searchParams.get("id");
    const recordNo = parseQrBinId(id);
    if (recordNo !== null) {
      const meta = await readQrBinRecord(recordNo);
      if (!meta) return sendText(res, "Not found", 404);
      const png = await renderPackedQrPng(meta.packed);
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length });
      return res.end(png);
    }
    const item = indexById.get(id);
    if (!item) return sendText(res, "Not found", 404);
    try {
      await fsp.access(item.path);
    } catch {
      return sendText(res, "Image file not found", 404);
    }
    res.writeHead(200, { "Content-Type": "image/png" });
    const stream = fs.createReadStream(item.path);
    stream.on("error", () => {
      if (!res.headersSent) sendText(res, "Image file not found", 404);
      else res.destroy();
    });
    return stream.pipe(res);
  }
  if (req.method === "GET" && url.pathname === "/api/preview") {
    const id = url.searchParams.get("id");
    if (!/^[\w.-]+$/.test(id || "")) return sendText(res, "Bad request", 400);
    const filePath = path.join(UPLOAD_DIR, id);
    try {
      await fsp.access(filePath);
      res.writeHead(200, { "Content-Type": "image/png" });
      return fs.createReadStream(filePath).pipe(res);
    } catch {
      return sendText(res, "Not found", 404);
    }
  }
  return sendJson(res, { error: "接口不存在" }, 404);
}

async function main() {
  await ensureDirs();
  await loadQrBinaryIndex();
  if (LOAD_LEGACY_INDEX) {
    await loadIndex();
    await loadManual21Index();
  }
  await writeState();
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url.startsWith("/api/")) return await handleApi(req, res);
      return await serveStatic(req, res);
    } catch (err) {
      return sendJson(res, { error: err.message || String(err) }, 500);
    }
  });
  server.listen(PORT, () => {
    console.log(`本地二维码检索工具已启动：http://localhost:${PORT}`);
  });
}

async function importOnceCli(inputPath) {
  await ensureDirs();
  await loadQrBinaryIndex();
  if (LOAD_LEGACY_INDEX) await loadIndex();
  await importPath(inputPath);
  console.log(JSON.stringify(importProgress, null, 2));
}

async function upgradeIndexFeaturesCli() {
  await ensureDirs();
  await loadIndex();
  const tmpFile = `${INDEX_FILE}.tmp`;
  const writer = fs.createWriteStream(tmpFile, { encoding: "utf8" });
  let upgraded = 0;
  let kept = 0;
  let failed = 0;

  for (let i = 0; i < indexItems.length; i += 1) {
    const item = indexItems[i];
    try {
      if (!item.feature?.highSamples || !item.feature?.finderSample || !item.feature?.manual21) {
        const fresh = await imageFeature(item.path, null, { maskUncertain: false, autoTrim: true });
        item.feature.highSamples = fresh.highSamples;
        item.feature.finderSample = fresh.finderSample;
        item.feature.manual21 = fresh.manual21;
        delete item.feature.finderSamples;
        upgraded += 1;
      } else {
        kept += 1;
      }
    } catch (err) {
      failed += 1;
      item.featureUpgradeError = err.message || String(err);
    }
    writer.write(JSON.stringify(item) + "\n");
    if ((i + 1) % 500 === 0 || i + 1 === indexItems.length) {
      console.log(`upgraded=${upgraded} kept=${kept} failed=${failed} total=${i + 1}/${indexItems.length}`);
    }
  }

  await new Promise((resolve, reject) => {
    writer.end(resolve);
    writer.on("error", reject);
  });
  await fsp.rename(tmpFile, INDEX_FILE);
  console.log(JSON.stringify({ upgraded, kept, failed, total: indexItems.length }, null, 2));
}

async function buildManual21IndexCli() {
  await ensureDirs();
  await loadIndex();

  const done = new Set();
  try {
    const stream = fs.createReadStream(MANUAL21_FILE, { encoding: "utf8" });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const item = JSON.parse(line);
      if (item.id) done.add(item.id);
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const writer = fs.createWriteStream(MANUAL21_FILE, { flags: "a", encoding: "utf8" });
  let built = 0;
  let skipped = 0;
  let failed = 0;
  for (const item of indexItems) {
    if (done.has(item.id)) {
      skipped += 1;
      continue;
    }
    try {
      const feature = await manualGridFeature(item.path, null, 21, { normalize: true });
      writer.write(JSON.stringify({ id: item.id, modules: feature.modules }) + "\n");
      built += 1;
    } catch {
      failed += 1;
    }
    const processed = built + skipped + failed;
    if (processed % 1000 === 0 || processed === indexItems.length) {
      console.log(JSON.stringify({ processed, total: indexItems.length, built, skipped, failed }));
    }
  }
  await new Promise((resolve, reject) => {
    writer.end(resolve);
    writer.on("error", reject);
  });
  console.log(JSON.stringify({ total: indexItems.length, built, skipped, failed }, null, 2));
}

module.exports = {
  imageFeature,
  fineScore,
  moduleGridScoreBest,
  sampledModuleGridScoreForGrid,
  createTargetPreview,
  manualGridFeature,
  manualGridScore,
  isManualGridUsable,
  loadIndex,
  loadManual21Index,
  loadQrBinaryIndex,
  getIndexItems: () => indexItems,
  getTotalIndexCount,
  upgradeIndexFeaturesCli
  , buildManual21IndexCli
};

if (require.main === module && process.argv[2] === "--import-once") {
  importOnceCli(process.argv[3]).catch(err => {
    console.error(err);
    process.exit(1);
  });
} else if (require.main === module && process.argv[2] === "--upgrade-index-features") {
  upgradeIndexFeaturesCli().catch(err => {
    console.error(err);
    process.exit(1);
  });
} else if (require.main === module && process.argv[2] === "--build-manual21") {
  buildManual21IndexCli().catch(err => {
    console.error(err);
    process.exit(1);
  });
} else if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
