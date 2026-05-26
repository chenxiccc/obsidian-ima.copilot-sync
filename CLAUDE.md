# ima.copilot Sync — Obsidian 插件

将 IMA 个人知识库笔记同步到 Obsidian vault 的插件。

> **注意**：本文件在 `.gitignore` 中，不要删除该忽略规则。此文件仅用于本地 AI 辅助开发，不应提交到仓库。

## IMA skills & Api

'~/Documents/Tech/project/ima skills/ima-skills'

IMA skills中未记录的API，有需要时读取，文件很大:

'~/Documents/Tech/project/ima skills/ima-skills/references/undocumented-apis.md'

## Obsidian规范和api，文档

### 示例插件

~/Documents/Tech/project/obsidian/obsidian-sample-plugin

### Obsidian API

~/Documents/Tech/project/obsidian/obsidian-api

### Obsidian开发者文档

~/Documents/Tech/project/obsidian/obsidian-developer-docs

### 自动化调试Obsidian，Obsidian CLI

https://obsidian.md/zh/help/cli

## 如果需要认证信息来调试

Client_id:' ~/Documents/Tech/project/ima skills/client_id.txt'
api_key: ' ~/Documents/Tech/project/ima skills/api_key.txt'

## 构建与部署

```bash
# 开发模式（watch）/ Dev mode with file watching
npm run dev

# 生产构建（含 tsc 类型检查）/ Production build with type check
npm run build

# ESLint 检查（使用 Obsidian 官方规则）/ Lint with Obsidian official rules
npx eslint src/
重要：不要自主进行这个检查，不要随意禁用Eslint的检测！如果问题不值得修复，那么就报告并保留报错。

# 部署到正式笔记库 / Deploy to main vault
cp main.js "/Users/admin/Obsidian/.obsidian/plugins/ima-copilot-sync/main.js"
cp styles.css "/Users/admin/Obsidian/.obsidian/plugins/ima-copilot-sync/styles.css"
obsidian vault="Obsidian" plugin:reload id=ima-copilot-sync
obsidian vault="Obsidian" dev:errors
```

## 源码结构

| 文件                       | 职责                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/main.ts`            | 插件入口，生命周期、Ribbon、定时器                                                                      |
| `src/settings.ts`        | 设置数据结构 + 设置界面 UI                                                                              |
| `src/ima-client.ts`      | IMA API HTTP 封装（认证、分页、错误处理、get_media_info）                                               |
| `src/sync-manager.ts`    | 同步编排：列表→get_media_info→按类型分发→写文件→修复残留图片                                        |
| `src/image-handler.ts`   | 图片下载、附件路径解析、链接格式化                                                                      |
| `src/html-to-md.ts`      | HTML → Markdown 转换器（基于 defuddle**私有版本**，含 `authorURL` 支持、微信文章四层回退提取、多格式内容检测、图片提取补充、小红书文章提取） |
| `src/headless-extractor.ts` | 无头浏览器提取器（Electron BrowserWindow，仅桌面端）——微信文章 JS 渲染页面通过隐藏窗口加载后提取完整 DOM |
| `src/file-downloader.ts` | 通用文件下载器（含反盗链 requestUrl + Node.js https.get 兜底）                                          |
| `src/path-utils.ts`      | 共享工具函数：文件名清理、路径计算、CHROME_UA 常量、`buildStableFilename`、`shortHash`、共享类型定义（`AttachmentOptions`、`LinkFormat` 等） |

### defuddle 私有版本 / Private fork

`html-to-md.ts` 依赖的 defuddle 是**我们自己的私有 fork**，非 npm 社区公共版本。私有版本在社区版基础上增加了 `authorURL` 支持，用于自定义作者链接。

- 社区版 npm 包：`defuddle`
- 私有版本：'~/Documents/Tech/project/defuddle'本地引用，API 兼容但多了 `authorURL` 等扩展字段
- 不能直接 `npm install defuddle` 替换

## 版本发布 / Version bump

发布前先让用户提供发布说明，写入 `RELEASE_NOTES.md`，然后：

```bash
npm version patch   # 4.7.0 → 4.7.1
npm version minor   # 4.7.0 → 4.8.0
npm version major   # 4.7.0 → 5.0.0
git push --tags     # push 后 CI workflow 自动读取 RELEASE_NOTES.md 创建 Release
```

`npm version` 会自动：改 `package.json` + `package-lock.json` → `scripts/sync-version.cjs` 同步 `manifest.json` + `versions.json` → `git commit` + `git tag`。

**重要**：运行前确保工作区 clean，因为 `npm version` 会 commit。发布说明需在版本号变更前写入 `RELEASE_NOTES.md`。

## 凭证存储

`clientId` 和 `apiKey` 通过 Obsidian SecretStorage API 存储于系统钥匙串（macOS Keychain / Windows Credential Manager / Linux libsecret），**不以明文保存在 `data.json` 中**。

- 密钥 ID：`ima-client-id` / `ima-api-key`（定义在 `src/settings.ts` 的 `SECRET_ID_CLIENT` / `SECRET_ID_API_KEY`）
- 运行时通过 `ImaPlugin.resolveCredentials()` 从 SecretStorage 读取
- 设置界面保留文本输入框体验，onChange 时写入 SecretStorage
- 最低 Obsidian 版本要求：1.11.4（SecretStorage API）

## 附件路径模式

`subfolder`（默认）/ `obsidian`（跟随 Obsidian 全局设置）/ `samename`（与笔记同名文件夹），详见 `src/settings.ts`

## 测试环境

正式笔记库路径：`/Users/admin/Obsidian`
插件 data.json：`/Users/admin/Obsidian/.obsidian/plugins/ima-copilot-sync/data.json`

## 子文件索引 / Sub-file index

以下内容按主题拆分，触及对应代码时按需读取：

- [CLAUDE-API.md](CLAUDE-API.md) — IMA API 陷阱、知识库 ID 体系、内容获取方式、API 接口参考。修改 `ima-client.ts` 或对接 IMA 接口时参考。
- [CLAUDE-DESIGN.md](CLAUDE-DESIGN.md) — 关键设计决策：parse_progress 重试、图片/文件本地化、增量同步、文件名稳定性、`<file>` 标签处理、链接格式。修改 `sync-manager.ts`、`path-utils.ts` 或涉及同步策略时参考。
- [CLAUDE-READING-MODE.md](CLAUDE-READING-MODE.md) — 强制阅读模式实现细节。修改 `main.ts` 中 `enforceWithRestore` 等相关方法时参考。
