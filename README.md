# Catch

本地优先的 Prompt / Skill 收集整理工具。把散落在各平台的 prompt、skill、聊天记录和截图收进一个本机数据库，自动清洗冗余、提取图片文字，并由 AI **给出分类方案，你确认后一键应用**。

自带三栏式网页界面（导航 / 列表 / 详情，支持浅深色切换和手机布局）。接口见 [docs/API.md](docs/API.md)，需求见 [PRD.md](PRD.md)。

## 能做什么

- **多种抓取方式**：粘贴文本、粘贴链接（自动抓取正文）、上传图片、多条文本批量入库（传 `split: true`，用单独一行 `=====` 分隔；默认整段算一条，因为 prompt 和 SKILL.md 本身常含空行和 `---`）。
- **聊天记录导入**：ChatGPT 导出、Claude 导出、纯文本对话，自动挑出像 prompt 的用户消息，由你勾选后入库。
- **图片 OCR**：按链路依次尝试 PaddleOCR 托管 API → 自建 PaddleOCR 服务 → 多模态大模型。
- **清洗冗余**：规则去掉界面残留（点赞、收藏、转发等），代码块受保护不被误删；配置了 LLM 后再识别 prompt 主体。
- **原文永不丢**：`raw` 始终保留，清洗后的正文可一键还原，每次修改都有版本历史。
- **AI 分类（先方案后落库）**：生成方案时不写任何数据；你可以逐条改标签、改集合、排除条目，确认后一次应用，并支持整体撤销。
- **搜索**：中文子串搜索，支持 `tag:` `kind:` `source:` `status:` `is:favorite` `has:image`、`"短语"`、`-排除`。
- **Skill 支持**：校验 `SKILL.md`，附带文件，导出为 zip。
- **导出**：JSON、Obsidian 笔记（zip 或写入指定 vault 目录）、`prompts.md`。

## 快速开始

需要 Node.js 22.5 及以上（使用内置 `node:sqlite`，开发和测试环境为 Node 24）。

```bash
npm install
npm start
```

打开 `http://127.0.0.1:5173`。默认只监听本机，数据保存在 `./data`（数据库 `catch.db` 和图片 `assets/`）。

界面用法：在底部抓取栏粘贴文本、链接，或直接 `Ctrl+V` 贴截图；`/` 聚焦搜索，`j`/`k` 切换条目，`c` 复制，`s` 收藏；右上角可切换深浅主题。分类方案在左侧导航「分类方案」里生成、修改、一键应用，应用后可撤销。

```bash
npm test      # 运行全部测试
npm run dev   # 文件变更后自动重启
```

先试一下抓取：

```bash
curl -X POST http://127.0.0.1:5173/api/capture \
  -H "Content-Type: application/json" \
  -d '{"text":"你是一名资深代码审查员。请逐条指出下面代码的问题并给出修改建议：\n{{code}}"}'

curl "http://127.0.0.1:5173/api/items?q=代码审查"
```

## 配置

配置分两处：环境变量，和 `PUT /api/settings` 保存到数据库的设置项。环境变量优先于数据库里的值。

| 环境变量 | 作用 | 默认 |
| --- | --- | --- |
| `HOST` | 监听地址 | `127.0.0.1` |
| `PORT` | 监听端口 | `5173` |
| `CATCH_DATA_DIR` | 数据目录 | `./data` |
| `CATCH_LLM_API_KEY` | LLM 的 API Key | 空 |
| `CATCH_PADDLE_TOKEN` | PaddleOCR 托管 API 的 token | 空 |

服务**不会自动读取 `.env` 文件**。复制 `.env.example` 为 `.env` 后这样启动：

```bash
node --env-file=.env --disable-warning=ExperimentalWarning src/server.js
```

### 配置 LLM（可选）

不配置也能用：清洗走规则，分类走启发式。配置后可识别 prompt 主体、生成更好的标签和集合建议。接口为 OpenAI 兼容格式：

```bash
curl -X PUT http://127.0.0.1:5173/api/settings -H "Content-Type: application/json" \
  -d '{"llm_base_url":"https://api.openai.com/v1","llm_model":"gpt-4o-mini"}'
```

API Key 建议用环境变量 `CATCH_LLM_API_KEY`。配置后用 `POST /api/settings/test-llm` 测试连通性。

### 配置 OCR

链路由设置项 `ocr_chain` 决定，默认 `paddle-hosted,paddle-selfhost,vision-llm`，前一项失败自动用下一项。

1. **paddle-hosted**：百度 AI Studio 的 PaddleOCR 托管服务，有每日免费额度。在 AI Studio 获取 access token，设置 `CATCH_PADDLE_TOKEN`。注意图片会上传到百度服务器。
2. **paddle-selfhost**：自己用 `paddlex --serve` 起服务，默认地址 `http://localhost:8080`（设置项 `paddle_selfhost_url`），图片不出本机。
3. **vision-llm**：使用上面配置的多模态 LLM。

用 `POST /api/settings/test-ocr` 检查各环节是否可用。

> 托管 API 的协议目前只用 mock 测试过，没有用真实 token 验证。第一次使用请上传一张真实图片确认效果，遇到问题请反馈。

## 分类流程

```
POST /api/classify/plans            生成草稿方案（不写任何数据）
PATCH /api/classify/plans/:id       修改：每条的标签、集合、是否排除，以及标签合并
POST /api/classify/plans/:id/apply  确认后一次应用（事务，失败整体回滚）
POST /api/classify/plans/:id/undo   整体撤销
```

方案里的新标签只有在 apply 时才会创建。撤销会还原条目的标签和集合，并删除这次新建的标签和集合；被合并掉的标签不会恢复，响应里 `merge_reverted` 会如实告知。

## 安全说明

- 默认只监听本机。若改成 `0.0.0.0`，等于向局域网公开你的全部数据，且读接口没有鉴权，请不要这样做。
- 写接口：同源或无 Origin 的请求（如 curl）可用；跨源请求只允许浏览器扩展 Origin 或带 `Authorization: Bearer <capture_token>`。token 在 `GET /api/settings` 中可见，可用 `POST /api/settings/reset-token` 重置。
- 抓取链接和远程图片有 SSRF 防护：拒绝内网、环回、链路本地地址，包括 IPv6 映射形式，并限制重定向次数和响应大小。命中时返回 400。
- 设置接口返回的密钥是掩码；把掩码值原样存回不会覆盖真实密钥。

## 目录

```
src/server.js      路由、鉴权、SSE
src/capture.js     抓取入库
src/clean.js       规则清洗
src/plans.js       分类方案
src/tags.js        标签（支持 a/b 层级、别名、合并）
src/search.js      搜索语法与查询
src/ocr/           OCR 链路
src/importers/     聊天与 Obsidian 导入
src/security.js    SSRF、Origin 校验
public/            前端（原生 HTML/CSS/JS，零构建）
public/vendor/     前端依赖：Web Awesome、marked、DOMPurify（见 public/vendor/README.md）
test/              测试
```

前端按《UI 设计规范手册》设计：主色 `#90e203`，灰阶 H82 S20，间距 4px 基数。设计 token 在 `public/css/tokens.css`。

## 已知限制

- 浏览器扩展、书签小工具、PWA 分享入口未实现（`/capture` 只是一个最简回退表单）。
- Obsidian vault 导入接口已有，但未做界面和专项验证。
- 单次分类方案最多处理 50 条，超出会标记 `truncated`。
- 使用了 Node 的实验性 SQLite 模块，启动脚本已屏蔽相应警告。

## 许可证

MIT
