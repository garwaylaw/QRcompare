# 二维码图库比对工具

这是一个本地网页工具，用于把人工修复后的 `21x21` 二维码图与本地二维码图库进行相似度匹配，并返回匹配度最高的 Top 5。

## AGENT_HANDOFF.md 的作用

`AGENT_HANDOFF.md` 是给后续接手项目的开发者或其他 agent 阅读的交接说明。它记录了当前项目的核心需求、已经放弃的旧方案、索引结构、导入/匹配策略、重要文件含义、迁移到其他电脑时需要注意的事项，以及后续维护时应避免踩到的问题。

这个文件不参与程序运行，也不是配置文件；删除它不会影响启动和匹配功能。但如果计划把项目交给别人继续开发，建议保留并同步更新它。

## 运行环境和依赖

运行前需要准备：

- Node.js：要求 Node.js 20 或更高版本，建议使用 Node.js 24 或较新的稳定版本。
- npm：随 Node.js 一起安装，用于执行 `npm install`。
- Windows PowerShell：仅在导入 ZIP 文件时使用，程序会调用系统自带的 `Expand-Archive` 解压。只导入 PDF 或图片文件夹时不需要额外操作。

项目的 npm 第三方依赖已经写在 `package.json` 中，首次运行前执行 `npm install` 会自动安装：

- `sharp` `0.34.5`：读取、裁剪、灰度化和渲染图片。
- `pdfjs-dist` `5.6.205`：读取和解析 PDF。
- `@napi-rs/canvas` `0.1.100`：给 `pdfjs-dist` 提供 PDF 页面渲染用的 Canvas 环境。

不需要额外安装 Python、ImageMagick、Poppler、7-Zip 或其他命令行工具。

常见启动/导入问题：

- 提示 `项目依赖尚未安装或不完整`：在项目目录执行 `npm install`。
- 提示 `Cannot find module 'pdfjs-dist...'`、`Cannot find module 'sharp'` 或 `Cannot find module '@napi-rs/canvas'`：依赖没有安装完整，重新执行 `npm install`。
- 提示端口 `8787` 被占用：关闭已经启动的 QRcompare 窗口，或在 `start.bat` 中增加一行 `set "PORT=8788"` 后重试。
- ZIP 导入失败：确认是在 Windows 环境运行，并且系统 PowerShell 可用；也可以先手动解压 ZIP，再导入解压后的文件夹。

## 启动方式

首次从 GitHub 下载项目后，需要先安装依赖：

```bat
npm install
```

如果直接双击 `start.bat` 时提示“项目依赖尚未安装或不完整”，也执行上面的命令。安装依赖只需要做一次，除非后来删除了 `node_modules` 或更新了依赖。

双击项目目录中的 `start.bat`。

启动成功后，在浏览器打开：

```text
http://localhost:8787
```

## 当前推荐索引格式

新版本导入 PDF 时默认使用轻量二进制索引：

```text
data/qr_index/
  manifest.json
  sources.jsonl
  codes.txt
  shards/
    shard_000000.bin
    shard_000001.bin
```

这种格式不会为每个二维码保存 PNG 图片，也不会把大块图像特征写入 `index.jsonl`。每条二维码主要保存 `21x21` 黑白点阵，匹配结果图片由程序按点阵即时生成。

容量估算：

- 每条二维码点阵记录约 `80` 字节。
- 500 万条点阵主体约 `400MB`。
- 加上来源 PDF 和码值文本，通常预计在 `1GB` 级别，远小于旧的 PNG + JSON 索引方式。

## 旧索引兼容

旧版本索引仍可读取：

```text
data/index.jsonl
data/manual21.jsonl
data/pdf_items/
```

但后续大批量导入建议使用新格式。旧索引文件不会被程序自动删除。

默认启动时不会加载旧索引，这样更适合大批量导入。需要兼容旧索引时，打开 `start.bat`，把下面这一行改成 `1`：

```bat
set "LOAD_LEGACY_INDEX=0"
```

## 高速导入设置

PDF 导入已经做了两项加速：

- 每页只渲染和检测一次。
- 同一页内多个二维码会并行裁剪/提取，但每个二维码仍使用准确的裁剪取点阵算法。

并行页数可以在 `start.bat` 调整：

```bat
set "PDF_IMPORT_PAGE_CONCURRENCY=1"
set "QR_IMPORT_ITEM_CONCURRENCY_MIN=2"
set "QR_IMPORT_ITEM_CONCURRENCY=16"
set "IMPORT_MEMORY_CHECK_MS=1500"
```

建议：

- 准确度优先：`1`
- `PDF_IMPORT_PAGE_CONCURRENCY` 建议先保持 `1`
- `QR_IMPORT_ITEM_CONCURRENCY` 是同页二维码并行提取的最大值
- `QR_IMPORT_ITEM_CONCURRENCY_MIN` 是内存紧张时允许降到的最小值
- `IMPORT_MEMORY_CHECK_MS` 是内存检测间隔，默认 `1500` 毫秒
- 如果导入时内存占用过高或电脑卡顿，调小这个值。

程序会在导入期间实时检测内存。内存空闲较多时自动提高同页并行度，内存紧张时自动降低并行度；已经启动的一小批任务不会被强行中断，调整会从下一批二维码开始生效。

二维码图片文件夹也会写入同一个轻量索引，不再生成旧 PNG/JSON 索引。

## 断点续导

大 PDF 导入时会记录每页进度：

```text
data/qr_index/sources.state.json
```

如果导入过程中程序关闭、电脑重启或进程中断，下次导入同一个 PDF 时会从最后一个完整完成页的下一页继续。程序会自动回到上一个完整页后的索引位置，避免半页数据重复录入。

同一个 PDF 完整导入完成后，再次导入会直接跳过。

## 使用流程

1. 启动 `start.bat`。
2. 打开 `http://localhost:8787`。
3. 在“导入清晰二维码图库”中填入 PDF 文件或 PDF 文件夹路径。
4. 点击“开始导入 / 更新索引”。
5. 上传 `21x21` 人工修复二维码图。
6. 点击“开始匹配”，查看 Top 5 候选。

## 公司内网服务器部署

如果部署到公司本地服务器，供多台电脑通过浏览器上传残缺二维码进行查询，推荐使用服务器模式：

1. 在服务器上安装 Node.js 20 或更高版本。
2. 从 GitHub 下载项目后，在项目目录执行：

```bat
npm install
```

3. 先由管理员在服务器本机用 `start.bat` 启动，导入或更新二维码索引。
4. 索引导入完成后，关闭 `start.bat` 窗口。
5. 双击 `start_server.bat` 启动服务器模式。
6. 其他同事在浏览器访问：

```text
http://服务器IP:8787
```

服务器模式的默认设置：

- `HOST=0.0.0.0`：允许局域网其他电脑访问。
- `ENABLE_IMPORT=0`：关闭网页导入入口，普通用户只能上传待查二维码并匹配。
- `SEARCH_CONCURRENCY=1`：同一时间只跑 1 个全索引匹配任务，其余任务排队，避免服务器磁盘和 CPU 被多人同时扫描打满。
- `UPLOAD_RETENTION_HOURS=168`：自动清理 7 天前的上传图片和预览图片，避免 `data/uploads/` 长期膨胀。
- `PORT=8787`：默认端口。若端口被占用，可在 `start_server.bat` 中改成其他端口，例如 `8788`。

如果需要临时允许管理员通过网页导入索引，把 `start_server.bat` 中的：

```bat
set "ENABLE_IMPORT=0"
```

改成：

```bat
set "ENABLE_IMPORT=1"
```

导入完成后建议再改回 `0`。

## 人工修复图规则

上传图固定按 `21x21` 二维码网格处理：

- 黑色点位：确定为黑，参与匹配。
- 白色点位：确定为白，参与匹配。
- 灰色点位：未知，不参与匹配，也不扣分。

程序不会补全灰色区域，也不会修改上传图里的灰色点位。页面中的“裁剪后的目标二维码”只展示原图或框选区域。

## 迁移给其他人

复制整个 `QRcompare` 文件夹即可。路径按项目目录相对解析，不依赖原电脑上的绝对路径。

需要保留：

```text
server.js
start.bat
public/
data/qr_index/
```

如果还要兼容旧索引，也需要一起复制：

```text
data/index.jsonl
data/manual21.jsonl
data/pdf_items/
```

## 注意事项

- 500 万级别导入建议按文件夹批量导入 PDF，不建议再导入成单张二维码 PNG。
- 新格式匹配时会分片扫描 `data/qr_index/shards/`，不会一次性把全部二维码读入内存。
- 删除旧索引或清理旧 PNG 前请先备份，并确认新索引已经能满足匹配需求。
