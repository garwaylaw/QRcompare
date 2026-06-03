# Agent Handoff Notes

This file is written for another agent or developer who may receive the project on a different computer. Do not assume access to the original machine or its absolute paths.

## What This Project Does

This is a local web tool for matching uploaded manually repaired QR-code images against a local QR-code gallery.

The current matching mode is:

- Uploaded target images are fixed `21 x 21` QR grids.
- Black cells are known black and participate in matching.
- White cells are known white and participate in matching.
- Gray cells are unknown and must be ignored.
- Gray cells must never be treated as white or black.
- The preview should preserve the uploaded image or selected crop. Do not recolor the target preview.

The previous direction of automatically repairing damaged package photos was cancelled by the user. Do not restart that approach unless the user explicitly asks.

## Portable Project Bundle

The recipient should receive the whole project folder, not only the source code.

Required files and folders:

```text
QRcompare/
  server.js
  start.bat
  package.json
  README.md
  AGENT_HANDOFF.md
  public/
  data/
    qr_index/
    index.jsonl
    manual21.jsonl
    pdf_items/
```

Important:

- `data/qr_index/` is the current recommended lightweight binary index for large PDF imports.
- `data/index.jsonl` is the legacy main gallery index.
- `data/manual21.jsonl` is the legacy 21x21 matching sidecar index.
- `data/pdf_items/` contains legacy cropped QR images shown in results.
- If `data/pdf_items/` is missing, matching may still produce metadata, but result images will not display.

For 5M-scale imports, prefer `data/qr_index/`. It stores only packed `21 x 21` QR module bits plus compact source/code metadata, and result images are rendered dynamically from the binary record.

Large-import defaults:

- `start.bat` sets `LOAD_LEGACY_INDEX=0`, so startup/import loads only the lightweight binary index.
- Set `LOAD_LEGACY_INDEX=1` only when legacy `index.jsonl` / `manual21.jsonl` compatibility is needed.
- `PDF_IMPORT_PAGE_CONCURRENCY` controls PDF page parallelism; default is `1`.
- Current accuracy-first default keeps `PDF_IMPORT_PAGE_CONCURRENCY=1`.
- `QR_IMPORT_ITEM_CONCURRENCY` is the max same-page QR crop extraction parallelism; default is `16`.
- `QR_IMPORT_ITEM_CONCURRENCY_MIN` is the lower bound when memory is tight; default is `2`.
- `IMPORT_MEMORY_CHECK_MS` controls memory monitor interval; default is `1500`.
- Import memory is monitored in the background. The current adaptive value is stored in `importProgress.importConcurrency`; it increases when free memory is high and decreases when free memory is low. Already-running crop jobs are not cancelled; changes apply to the next batch.
- PDF import uses the accurate per-QR `sharp.extract()` path, but runs multiple QR crops on the same page concurrently.
- Image-folder import also writes to `data/qr_index/`, not the legacy PNG/JSON index.
- `data/qr_index/sources.state.json` stores resumable PDF-import checkpoints. On resume, `restoreQrBinCheckpoint()` truncates binary shards and `codes.txt` back to the last fully completed page before continuing, preventing duplicate records after an interrupted page.

## Running On Another Computer

The recipient needs Node.js installed. Use Node.js 24 or a recent compatible version.

Start:

```text
double-click start.bat
```

Then open:

```text
http://localhost:8787
```

`start.bat` changes the working directory to the folder containing the batch file. The app is intended to resolve project data relative to the current project folder.

## Path Portability

The original development machine used absolute Windows paths. Those paths should not be relied on.

`server.js` contains path helpers:

- `storedPathToRuntime(value)`
- `runtimePathToStored(value)`
- `indexItemForStorage(item)`

Expected behavior:

- Old absolute paths containing `\data\...` are relocated to the current project folder.
- Relative paths like `data\pdf_items\xxx.png` are resolved relative to the current project folder.
- Newly appended index records should store project-local paths as relative paths.

If this project is copied to:

```text
C:\Somewhere\QRcompare
```

then `data\pdf_items\xxx.png` should resolve to:

```text
C:\Somewhere\QRcompare\data\pdf_items\xxx.png
```

## Key Backend Functions

In `server.js`:

- `loadQrBinaryIndex()`: loads only the lightweight manifest/source metadata from `data/qr_index/`.
- `searchQrBinaryManual(task, manualFeatures)`: scans binary shard files in batches and keeps only Top 5 in memory.
- `/api/image?id=qrbin:<n>`: renders a result image from packed QR bits instead of reading `data/pdf_items`.
- `loadIndex()`: stream-loads `data/index.jsonl`. Do not replace this with `readFile`; the file can be over 1 GB.
- `loadManual21Index()`: loads `data/manual21.jsonl`.
- `manualGridFeature(filePath, crop, grid, options)`: extracts a 21x21 known/unknown grid from the uploaded target.
- `manualGridScore(targetFeature, itemFeature)`: scores known black/white cells only.
- `manualGridScoreForItem(targetFeature, item)`: prefers `manual21ById` sidecar data.
- `createOriginalUploadPreview(filePath, crop)`: preserves target preview without recoloring.
- `buildManual21IndexCli()`: builds/resumes the sidecar index.

Target extraction currently uses:

```js
manualGridFeature(filePath, crop, 21, {
  blackThreshold: 80,
  whiteThreshold: 245
})
```

This is intentional. A lower white threshold previously classified gray unknown cells as white.

Gallery sidecar extraction uses:

```js
manualGridFeature(item.path, null, 21, { normalize: true })
```

because gallery QR images are clean black/white crops.

## Known Validation Case

If the test image is available in the transferred project, use it to verify behavior:

```text
ScreenShot_2026-05-21_101724_637.png
```

It is a 21x21 target made by graying out parts of a known gallery QR.

Correct gallery result:

```text
id: e520d2bba0919cc9
name: 包装二维码1.pdf 第1页 #31
relative image path: data\pdf_items\包装二维码1_p001_031_item031.png
expected score: about 99.22
expected rank: Top 1
```

If this fails:

1. Confirm `data/manual21.jsonl` exists.
2. Confirm `data/pdf_items/包装二维码1_p001_031_item031.png` exists.
3. Confirm `loadManual21Index()` runs during startup.
4. Confirm gray target cells are ignored, not counted as white.

## Rebuilding The 21x21 Sidecar Index

If `data/manual21.jsonl` is missing or incomplete:

```powershell
node server.js --build-manual21
```

The build is resumable:

- It appends missing ids.
- It skips ids already present.
- It does not rewrite `data/index.jsonl`.

This build can take a long time for large galleries. Avoid interrupting unless necessary.

## Important Pitfalls

1. Do not hard-code absolute paths from the original computer.
2. Do not rewrite the whole `data/index.jsonl` unless absolutely necessary.
3. Do not read `data/index.jsonl` with `fs.readFile`; stream it line by line.
4. Do not recolor the uploaded target preview.
5. Do not infer or fill gray cells.
6. Do not classify gray cells as white. The white threshold for uploaded target images is intentionally high.
7. `/api/image` should return 404 if a result image is missing, not crash the server.

## Data Size Notes

The data folder may be large. Typical important files:

```text
data/index.jsonl      large main index
data/manual21.jsonl   compact 21x21 sidecar index
data/pdf_items/       many cropped QR images
```

When sending the project to another machine, compress the whole `QRcompare` folder.

## Suggested First Checks For The Next Agent

Run:

```powershell
node --check server.js
```

Then verify index loading with a small script or by starting the app.

Check that the first PDF item path resolves under the current project folder, not the original developer machine.

Check that `/api/image?id=<some-result-id>` does not crash if the file is missing.
