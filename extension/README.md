# Catch 浏览器扩展（Chrome / Edge MV3）

右键菜单、快捷键、弹窗一键保存网页/选区/图片/链接到本地 Catch。

## 安装（开发者模式）

1. 确保 Catch 服务在跑（默认 `http://127.0.0.1:5173`）
2. 打开 `chrome://extensions`（Edge 用 `edge://extensions`）
3. 打开右上角 **开发者模式**
4. 点 **加载已解压的扩展程序** → 选 `extension/` 这个文件夹
5. 装好后点扩展图标 → 底部「设置服务地址 / token」：
   - 服务地址：`http://127.0.0.1:5173`
   - Token：在 Catch 网页 → 设置页 复制 `capture_token`
   - 点「测试连接」确认通过

## 用法

| 方式 | 操作 |
|---|---|
| 右键菜单 | 页面空白处右键 →「保存页面到 Catch」；选中文字右键 →「保存选区」；图片右键 →「保存图片」；链接右键 →「保存链接」 |
| 快捷键 | `Alt+Shift+S` 存当前页；`Alt+Shift+A` 存选区（可在 `chrome://extensions/shortcuts` 改） |
| 弹窗 | 点工具栏图标 → 存页面 / 存文本（粘贴）/ 存选区 |

## 文件

- `manifest.json` — MV3 配置（权限、快捷键、右键菜单）
- `background.js` — service worker：右键菜单、快捷键、调 `/api/capture`
- `popup.html/js` — 点图标的快速保存弹窗
- `options.html/js` — 服务地址 + token 配置
- `icons/` — 图标

## 注意

- 只监听 `127.0.0.1` / `localhost`，token 存浏览器 `chrome.storage.sync`
- 扩展 Origin `chrome-extension://` 已在服务端 CORS 白名单内，配合 Bearer token 即可 POST
