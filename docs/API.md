# Catch HTTP API

基地址 `http://127.0.0.1:5173`。请求和响应均为 JSON，除非另有说明。出错时返回 `{ "error": "..." }` 和对应状态码。

## 鉴权规则

- `GET` / `HEAD` 不需要鉴权。
- 非 GET：无 Origin 的请求（curl、脚本）和同源浏览器请求可直接使用；跨源请求必须是浏览器扩展 Origin，或带 `Authorization: Bearer <capture_token>`，否则 403。
- `capture_token` 从 `GET /api/settings` 读取，`POST /api/settings/reset-token` 重置。

## 抓取

### POST /api/capture

JSON 或 `multipart/form-data`（图片作为文件字段，其余字段或 `payload` JSON 字段）。

| 字段 | 说明 |
| --- | --- |
| `text` | 文本。若整段只是一个 URL，会当作链接抓取。默认整段作为一条 |
| `split` | `true` 时按单独一行的 `=====` 把 `text` 拆成多条 |
| `url` | 要抓取的链接 |
| `title` `source` `selection` `html` | 可选的元信息；`html` 为页面 HTML，`selection` 为选中文字 |
| `images` | 图片数组：`data:image/...;base64,...` 或 http(s) 链接。仅 png / jpeg / webp / gif |
| `kind` | 类型提示：如 `prompt`、`skill` |
| `source_type` | 来源类型，如 `import` |

至少提供 `text`、`url`、`images`、`title` 之一，否则 400。

响应：`{ ok, items: [...], duplicate, count }`。`duplicate` 在发现重复时给出匹配信息；完全相同的内容会停止后续批量项。链接指向内网地址返回 400。

### POST /api/capture/confirm

`{ "action": "merge", "targetId": 1, "sourceId": 2 }`：把重复条目并入已有条目。其余 action 返回 400。

## 条目

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/items` | 参数 `q` `status`（默认 `active`，另有 `all` `trash` `inbox` `curated`）`kind` `favorite=1` `limit`（最大 200）`offset`。返回 `{ rows, total }`，每行带 `tags`；有 `kind` 或 `favorite` 参数时不使用 `q` |
| `GET /api/items/:id` | 详情：含 `files` `related` `backlinks` `collections` `links_out`，以及被清洗掉的片段 |
| `PATCH /api/items/:id` | 可改 `title` `content` `summary` `kind` `lang` `status`（inbox/curated/archived/trash）`favorite` `props` `raw` `tags`（整体替换）。修改前自动存版本 |
| `POST /api/items/:id/restore-raw` | 把正文还原为原始 `raw`，并保留版本 |
| `POST /api/items/:id/copy` | 复制计数 +1，返回 `use_count` |
| `POST /api/items/:id/restore` | 从回收站恢复到 inbox |
| `POST /api/items/batch` | `{ ids, action, tag?, status? }`，action 为 `tag` `untag` `status` `favorite`（切换）。返回 `{ ok, undo }`，`undo` 记录各条原状态 |
| `POST /api/trash/empty` | 永久删除回收站。必须传 `{ "confirm": "YES" }`，否则 400 |
| `GET /api/items/:id/versions` | 最近 50 个版本 |
| `GET /api/versions/:vid` | 版本详情与行级 diff |
| `POST /api/versions/:vid/restore` | 回滚到该版本（回滚前再存一份） |

注意：`GET /api/items/:id` 和 `PATCH` 对不存在的条目返回 200 + `{ "error": "not found" }`，不是 404。

## 分类方案

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/classify/plans` | `{ "scope": "inbox" }`，或 `{ "scope": "ids", "ids": [1,2] }`。最多 50 条。**不写任何数据** |
| `GET /api/classify/plans/:id` | 查看方案 |
| `PATCH /api/classify/plans/:id` | 仅草稿可改：`{ items: [{ item_id, add_tags?, collection?, exclude? }], merges?: [{ from, to }] }` |
| `POST /api/classify/plans/:id/apply` | 事务应用；失败整体回滚。非草稿返回 409 |
| `POST /api/classify/plans/:id/undo` | 撤销已应用方案，返回 `merge_reverted` |
| `POST /api/classify/plans/:id/discard` | 丢弃草稿 |

方案结构：

```json
{
  "id": 1, "state": "draft", "scope": "inbox",
  "plan": {
    "items": [{ "item_id": 3, "title": "...", "kind": "prompt",
                "add_tags": ["写作/润色"], "new_tags": ["写作/润色"],
                "collection": "写作", "exclude": false }],
    "merges": [{ "from": "润色", "to": "写作/润色" }],
    "truncated": true
  }
}
```

`state` 取值：`draft` `applied` `undone` `discarded`。单条生成失败时该条带 `error` 字段，不影响其他条目。

另有异步重分类（只为条目生成建议标签，不落库标签）：`POST /api/items/:id/reclassify`，`POST /api/reclassify`（`{ "inbox": false }` 表示非 inbox 条目）。

## 搜索语法（`q` 参数）

| 写法 | 含义 |
| --- | --- |
| `关键词` | 中文子串匹配，3 字以上走 FTS trigram，1–2 字退化为 LIKE |
| `"一段话"` | 短语 |
| `tag:写作` | 标签，自动包含子标签；多个 `tag:` 为 AND |
| `kind:prompt` `source:xiaohongshu` `status:inbox` | 类型、来源（平台或 URL 子串）、状态 |
| `is:favorite` `has:image` | 收藏、含图片 |
| `-词` `-tag:草稿` `-kind:skill` `-has:image` | 排除 |

## 标签与集合

- `GET /api/tags` → `{ tags, pending }`
- `POST /api/tags` `{ name, color?, description? }`；名称支持 `a/b` 层级
- `PATCH /api/tags/:id` 改名、颜色、描述；重名返回 200 + `error`
- `POST /api/tags/merge` `{ from, to }`（名称或 id）；`from` 会被删除
- `POST /api/tags/:id/approve`、`/reject`：处理待审标签
- `GET/POST /api/collections`，`PATCH/DELETE /api/collections/:id`
- `POST /api/collections/:id/items` `{ item_id, add: true|false }`
- `GET /api/collections/:id/items`

## 导入与导出

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/import/chat` | `{ format: "auto"\|"chatgpt"\|"claude"\|"transcript", data }`，返回 `{ sessions, candidates }`，不入库 |
| `POST /api/import/chat/commit` | `{ candidates, saveContext? }`，入库你勾选的候选 |
| `POST /api/import/obsidian` | `{ dir }`，导入本机 vault 目录 |
| `GET /api/export/json` / `POST /api/import/json` | 完整备份与恢复 |
| `GET /api/export/obsidian` | 参数 `curated=1` `zip=1`。设置了 `obsidian_vault` 且未要求 zip 时直接写入该目录，否则返回 zip |
| `GET /api/export/prompts.md` | 所有 prompt 的 Markdown |
| `GET /api/items/:id/export-skill` | skill 的 zip |

## Skill

- `POST /api/skill/validate` `{ content }`：校验 `SKILL.md` 的 frontmatter 与结构。
- `PUT /api/items/:id/files` `{ files: [{ path, content }] }`：整体替换附带文件，含 `..` 的路径会被忽略。

## 设置与诊断

- `GET /api/settings`：密钥只返回掩码，并附带 `xxx_set: "0"|"1"`。
- `PUT /api/settings`：只接受已知键；掩码值不会覆盖真实密钥。
- `POST /api/settings/test-llm`、`POST /api/settings/test-ocr`：连通性测试。
- `POST /api/dryrun` `{ item_id | text, instruction? }`：预览 AI 提取结果，不落库。需要已配置 LLM。
- `GET /api/jobs`：队列状态与最近 30 个任务；`POST /api/jobs/retry-failed`：重试失败任务。

## 其他

- `GET /api/events`：SSE，事件 `item` `items`。
- `GET /api/assets/:id/file`、`GET /assets/:file`：图片文件。
- `GET /capture`：最简保存表单（回退用）。
