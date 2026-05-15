# ima.copilot Sync — Obsidian 插件

将 IMA 个人知识库笔记同步到 Obsidian vault 的插件。

> **注意**：本文件在 `.gitignore` 中，不要删除该忽略规则。此文件仅用于本地 AI 辅助开发，不应提交到仓库。

## IMA skills

'/Users/admin/Documents/Tech/project/ima skills/ima-skill'

## Obsidian规范和api，文档

### 示例插件

/Users/admin/Documents/Tech/project/obsidian-sample-plugin

### Obsidian API

/Users/admin/Documents/Tech/project/obsidian-api

### Obsidian开发者文档

/Users/admin/Documents/Tech/project/obsidian-developer-docs

### 自动化调试Obsidian，Obsidian CLI

https://obsidian.md/zh/help/cli

## 如果需要认证信息来调试

Client_id:'/Users/admin/Documents/Tech/project/ima skills/client_id.txt'
api_key: '/Users/admin/Documents/Tech/project/ima skills/api_key.txt'

## 构建与部署

```bash
# 开发模式（watch）/ Dev mode with file watching
npm run dev

# 生产构建（含 tsc 类型检查）/ Production build with type check
npm run build

# ESLint 检查（使用 Obsidian 官方规则）/ Lint with Obsidian official rules
npx eslint src/

# 部署到正式笔记库 / Deploy to main vault
cp main.js "/Users/admin/Obsidian/.obsidian/plugins/ima-copilot-sync/main.js"
cp styles.css "/Users/admin/Obsidian/.obsidian/plugins/ima-copilot-sync/styles.css"
obsidian vault="Obsidian" plugin:reload id=ima-copilot-sync
obsidian vault="Obsidian" dev:errors
```

## 源码结构

| 文件                       | 职责                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/main.ts`            | 插件入口，生命周期、Ribbon、定时器                                                                     |
| `src/settings.ts`        | 设置数据结构 + 设置界面 UI                                                                             |
| `src/ima-client.ts`      | IMA API HTTP 封装（认证、分页、错误处理、get_media_info）                                              |
| `src/sync-manager.ts`    | 同步编排：列表→get_media_info→按类型分发→写文件→修复残留图片                                       |
| `src/image-handler.ts`   | 图片下载、附件路径解析、链接格式化                                                                     |
| `src/html-to-md.ts`      | HTML → Markdown 转换器（基于 defuddle **私有版本**，含 `authorURL` 支持和微信文章正文提取）            |
| `src/file-downloader.ts` | 通用文件下载器（含反盗链 requestUrl + Node.js https.get 兜底）                                         |
| `src/path-utils.ts`      | 共享工具函数：文件名清理、路径计算、CHROME_UA 常量、`buildStableFilename`、`escapePathForMarkdown` |
| `src/file-downloader.ts` | 文件/图片下载器（反盗链、双格式链接、空格安全路径）                                                    |

### defuddle 私有版本 / Private fork

`html-to-md.ts` 依赖的 defuddle 是**我们自己的私有 fork**，非 npm 社区公共版本。私有版本在社区版基础上增加了 `authorURL` 支持，用于自定义作者链接。

- 社区版 npm 包：`defuddle`
- 私有版本：本地引用，API 兼容但多了 `authorURL` 等扩展字段
- 不能直接 `npm install defuddle` 替换

## IMA API 的坑

- **双响应格式**：Notes API 用 `code`/`msg`，Knowledge Base API 用 `retcode`/`errmsg`——`ima-client.ts` 的 `post()` 兼容两者
- **图片 URL 有时效**：Tencent COS 临时签名链接约 8 小时过期；`get_doc_content` 的 `format=2`（Slate JSON）返回的是**静态签名**（笔记图片上传时生成，不刷新），而 `format=1`（Markdown）返回的是**动态签名**（每次 API 调用重新生成）。因此整个笔记同步主路径统一使用 `format=1`（`getNoteContentMarkdown()`），彻底避免图片过期问题，同时也修复了 `json-to-md.ts` 不处理 `h1`/`h2`/`h3` 导致标题层级丢失的问题
- **个人笔记文件附件是 `<file>` XML 标签**：`get_doc_content`（format=1 Markdown）中文件附件以 `<file mediaId="..." filePath="..." />` XML 标签嵌入，**不是** Markdown `[text](url)` 链接。需 `processInlineFileTags()` 解析后通过 `get_media_info` 获取下载 URL
- **知识库条目 media_id 格式**：`note_<userId>_<docId>`，用 `extractDocIdFromMediaId()` 提取 docId

## 凭证存储

`clientId` 和 `apiKey` 通过 Obsidian SecretStorage API 存储于系统钥匙串（macOS Keychain / Windows Credential Manager / Linux libsecret），**不以明文保存在 `data.json` 中**。

- 密钥 ID：`ima-client-id` / `ima-api-key`（定义在 `src/settings.ts` 的 `SECRET_ID_CLIENT` / `SECRET_ID_API_KEY`）
- 运行时通过 `ImaPlugin.resolveCredentials()` 从 SecretStorage 读取
- 设置界面保留文本输入框体验，onChange 时写入 SecretStorage
- 最低 Obsidian 版本要求：1.11.4（SecretStorage API）

## 附件路径模式

`subfolder`（默认）/ `obsidian`（跟随 Obsidian 全局设置）/ `samename`（与笔记同名文件夹），详见 `src/settings.ts`

## 知识库内容获取（ima skills 1.1.7+）

ima skills 1.1.7 新增 `get_media_info` 接口，可根据 `media_id` 获取知识库条目的原始内容：

- **笔记 (media_type=11)**：返回 `notebook_ext_info.notebook_id`，调用 `get_doc_content`（`format=1` Markdown）获取内容
- **网页/微信文章 (media_type=2/6)**：返回 `url_info.url`，通过 defuddle 提取正文转 Markdown
- **文件 (media_type=1/3/4/5/7/9/13/14)**：返回 `url_info.url`，下载到 vault 附件目录
- **不可访问条目**：`url_info` 为空，fallback 到占位符

反盗链：主路径用 `requestUrl` + 自定义 headers（跨平台），兜底用 Node.js `https.get()`（仅桌面端）

**知识库类型与同步路径**：

| 类型       | 说明                                   | 同步路径                                                              | base_type                |
| ---------- | -------------------------------------- | --------------------------------------------------------------------- | ------------------------ |
| 个人知识库 | 用户自己创建的私有知识库               | openapi 认证接口（`get_knowledge_list` + `get_media_info`）       | `"个人知识库"`         |
| 共享知识库 | 用户自己创建、可供他人订阅的公共知识库 | openapi 认证接口（同上，`role_type="创建者"`）                      | `"共享知识库"`         |
| 订阅知识库 | 他人创建、用户已订阅的知识库           | cgi-bin 无认证接口（需 `current_path[0].folder_id` 作为数字 KB ID） | `"我加入的订阅知识库"` |
| 公共知识库 | 通过分享链接/shareId 手动添加          | cgi-bin 无认证接口（直接用 shareId）                                  | —                       |

**各类型内容获取能力**：

| 知识库类型      | 笔记（type 11）                            | 网页（type 2）      | 微信文章（type 6）                                                                          | 文件（其他类型）                        |
| --------------- | ------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------- |
| 个人/共享知识库 | ✅ 完整（format=1 Markdown，动态签名图片） | ✅ 完整（defuddle） | ✅ 完整（defuddle）                                                                         | ✅ 完整（下载）                         |
| 订阅/公共知识库 | ⚠️ 仅 ~300 字预览                        | ✅ 完整（defuddle） | ✅ 短链完整正文（defuddle）；⚠️ 长链（含 `__biz`）→ `introduction`+`abstract` 摘要 | ⚠️ 仅 AI 摘要（COS 相对路径不可下载） |

## 知识库 ID 体系

IMA 知识库涉及三种不同的 ID，来源和用途各不相同：

| ID 类型              | 示例                              | 来源                                                                  | 用途                                                |
| -------------------- | --------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------- |
| **加密 kb_id** | `BhCFmfWzNR...`（约 20 字符）   | `search_knowledge_base` 返回的 `kb_id` 字段                       | openapi 认证接口的 `knowledge_base_id` 参数       |
| **数字 KB ID** | `7419792097...`（约 13 位数字） | `cgi-bin/get_knowledge_list` 响应的 `knowledge_base_info.id` 字段 | cgi-bin 无认证接口的 `knowledge_base_id` 参数     |
| **shareId**    | 64 位十六进制字符串               | 用户分享知识库时生成的链接参数 `shareId=xxx`                        | `cgi-bin/get_share_info` 接口的 `share_id` 参数 |

**分享链接格式**：`https://ima.qq.com/wiki/?shareId=<64位hex>`

**典型转换路径**：

- **个人/共享知识库**：通过 openapi `search_knowledge_base` 获得加密 kb_id → 可直接调用 openapi `get_knowledge_list` 列出条目（响应中无 `knowledge_base_info.id`，openapi 层面不提供数字 KB ID）
- **订阅知识库 → 数字 KB ID**：调用 openapi `get_knowledge_list`（传加密 kb_id，条目列表为空但响应中包含 `current_path`）→ 取 `current_path[0].folder_id`（十六进制字符串）→ 作为 cgi-bin 的 `knowledge_base_id` 参数使用
- **shareId 路径**：有了 shareId 即可直接调用 `get_share_info` 无认证接口，响应的 `knowledge_base_info.id` 才是数字 KB ID
- **注意**：`openapi/wiki/v1/get_knowledge_base` 接口返回的 `id` 字段与加密 kb_id 相同，**不是**数字 KB ID，不可用于 cgi-bin 接口

## IMA API 接口详览

### 认证型接口（openapi，需要 clientId + apiKey 请求头）

#### `openapi/note/v1/list_note_by_folder_id`

列出个人笔记，支持分页。

| 字段                   | 说明                          |
| ---------------------- | ----------------------------- |
| `folder_id`          | 文件夹 ID，空字符串表示根目录 |
| `cursor` / `limit` | 分页参数                      |

**响应**：`note_book_list[]` → `basic_info.basic_info`（`DocBasic`：`docid`, `title`, `summary`, `create_time`, `modify_time`（均为 Unix **毫秒**时间戳）, `status`, `folder_id`, `folder_name`）

---

#### `openapi/note/v1/get_doc_content`

获取单篇笔记的原始内容。

| 参数                      | 说明                                                      |
| ------------------------- | --------------------------------------------------------- |
| `doc_id`                | 笔记 docId                                                |
| `target_content_format` | 1 = Markdown 格式；2 = JSON（Slate 格式，含图片等富文本） |

**响应**：`content`（字符串）

**⚠️ 关键区别 — 图片 URL 签名行为**：

- `format=2`（Slate JSON）：返回图片上传时生成的**静态签名 URL**，不随调用时间刷新，签名约 8 小时有效。若笔记图片上传超过 8 小时，URL 必然已过期（403）。
- `format=1`（Markdown）：返回**动态重新签名的 URL**，每次调用均生成以当前时间为起点的新鲜签名（约 8 小时有效）。可正常下载。
- **结论**：笔记同步主路径统一使用 `format=1`（`getNoteContentMarkdown()`）——既保证图片 URL 始终有效，又解决了 `json-to-md.ts` 不处理 `h1`/`h2`/`h3` 导致标题层级丢失的问题。`format=2` 不再用于生产路径。

---

#### `openapi/wiki/v1/search_knowledge_base`

搜索/列出用户的所有知识库。`query=""` 时返回全量。

**响应**：`info_list[]`（`SearchedKnowledgeBase`）：

| 字段              | 说明                                                           |
| ----------------- | -------------------------------------------------------------- |
| `kb_id`         | 加密 kb_id                                                     |
| `kb_name`       | 知识库名称                                                     |
| `cover_url`     | 封面图 URL                                                     |
| `member_count`  | 订阅人数（字符串）                                             |
| `content_count` | 内容数量（字符串）                                             |
| `description`   | 描述                                                           |
| `creator`       | 创建者                                                         |
| `role_type`     | 角色类型                                                       |
| `base_type`     | `"个人知识库"`、`"共享知识库"` 或 `"我加入的订阅知识库"` |

---

#### `openapi/wiki/v1/get_knowledge_list`

列出知识库下的所有条目（含文件和文件夹，支持分页）。对个人/共享知识库可用，**订阅知识库不可通过此接口获取内容**。

| 参数                   | 说明       |
| ---------------------- | ---------- |
| `knowledge_base_id`  | 加密 kb_id |
| `cursor` / `limit` | 分页参数   |

**响应**：`knowledge_list[]`（`KnowledgeInfo`：`media_id`, `title`, `parent_folder_id`, `media_type`），`current_path[]`（`{ folder_id, name }`，当前文件夹路径；对订阅知识库，`current_path[0].folder_id` 可作为 cgi-bin 的 `knowledge_base_id` 使用）

**注意**：此接口响应中**没有** `knowledge_base_info` 字段，无法通过此接口获取数字 KB ID。

---

#### `openapi/wiki/v1/get_media_info`

获取知识库条目的访问信息（URL 或笔记 ID）。**订阅知识库返回 220030 权限错误**，仅对个人/共享知识库可用。

| 参数         | 说明            |
| ------------ | --------------- |
| `media_id` | 条目的 media_id |

**响应**：

| 字段                              | 说明                            |
| --------------------------------- | ------------------------------- |
| `media_type`                    | 媒体类型（见下表）              |
| `url_info.url`                  | 内容访问 URL（网页/文件）       |
| `url_info.headers`              | 访问 URL 所需的请求头（反盗链） |
| `notebook_ext_info.notebook_id` | 笔记 ID（media_type=11 时有值） |

---

#### `openapi/wiki/v1/get_addable_knowledge_base_list`

获取用户可以向其添加内容的知识库列表（个人/共享，不含订阅）。

**响应**：`addable_knowledge_base_list[]`（`id`, `name`）

---

#### `openapi/wiki/v1/get_knowledge_base`

通过加密 kb_id 批量查询知识库信息。

| 参数    | 说明            |
| ------- | --------------- |
| `ids` | 加密 kb_id 数组 |

**响应**：`infos: map<string, { id: string; name: string }>`，key 为加密 kb_id。

**⚠️ 注意**：响应中的 `id` 字段与传入的加密 kb_id 相同，**不是**数字 KB ID，无法用于 cgi-bin 接口。

---

### 无认证接口（cgi-bin，无需 clientId/apiKey）

#### `cgi-bin/knowledge_tab_reader_nl/get_knowledge_list`

通过数字 KB ID 列出知识库条目，**无需认证**，返回信息最丰富。

| 参数                   | 说明                          |
| ---------------------- | ----------------------------- |
| `knowledge_base_id`  | 数字 KB ID                    |
| `folder_id`          | 文件夹 ID，空字符串表示根目录 |
| `cursor` / `limit` | 分页参数                      |
| `need_default_cover` | 是否需要默认封面（建议 true） |
| `sort_type`          | 排序类型（9 = 默认）          |

**响应**（`PublicKBListResponse`）：

| 字段                                                    | 说明                                      |
| ------------------------------------------------------- | ----------------------------------------- |
| `knowledge_base_info.id`                              | 数字 KB ID                                |
| `knowledge_base_info.basic_info.name`                 | 知识库名称                                |
| `knowledge_base_info.basic_info.update_timestamp_sec` | 知识库最后更新时间（Unix 秒）             |
| `knowledge_base_info.member_info.member_count`        | 订阅人数（字符串）                        |
| `knowledge_list[]`                                    | 条目列表（`PublicKBItem`）              |
| `current_path[]`                                      | 当前文件夹路径（`folder_id`, `name`） |
| `is_end` / `next_cursor`                            | 分页                                      |

**`PublicKBItem` 字段**：

| 字段                 | 说明                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `media_id`         | 条目唯一 ID                                                                                        |
| `title`            | 标题                                                                                               |
| `media_type`       | 媒体类型（见下表）                                                                                 |
| `introduction`     | 预览文本（约 300 字，笔记/文章摘录）                                                               |
| `abstract`         | AI 生成的摘要                                                                                      |
| `raw_file_url`     | 微信文章：公众号 `mp.weixin.qq.com` URL（见下方长/短链说明）；文件：COS 相对路径，无法直接访问   |
| `source_path`      | 网页的原始 URL                                                                                     |
| `cover_urls`       | 封面图 URL 数组                                                                                    |
| `file_size`        | 文件大小                                                                                           |
| `create_time`      | 创建时间（Unix 毫秒，字符串）                                                                      |
| `update_time`      | 最后更新时间（Unix 毫秒，字符串）                                                                  |
| `last_modify_time` | 最后修改时间（Unix 毫秒，字符串）                                                                  |
| `folder_info`      | 文件夹信息（media_type=99 时有值）：`folder_id`, `name`, `file_number`, `parent_folder_id` |

---

#### `cgi-bin/knowledge_share_get/get_share_info`

通过 shareId 获取共享知识库信息及条目列表，**无需认证**。

| 参数                   | 说明                           |
| ---------------------- | ------------------------------ |
| `share_id`           | 64 位十六进制 shareId          |
| `folder_id`          | 文件夹 ID（空字符串 = 根目录） |
| `cursor` / `limit` | 分页参数                       |

**响应**：与 `knowledge_tab_reader_nl/get_knowledge_list` 格式相同（`PublicKBListResponse`）

---

### 媒体类型（media_type）对照表

| media_type | 类型       | 内容获取方式                                                                                                                      |
| ---------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1          | 图片       | `url_info.url`（openapi）/ `raw_file_url`（cgi-bin，COS 相对路径不可直接下载）                                                |
| 2          | 网页       | `source_path` 原始 URL，通过 defuddle 提取正文                                                                                  |
| 3          | 音频       | `url_info.url`                                                                                                                  |
| 4          | 视频       | `url_info.url`                                                                                                                  |
| 5          | Word 文档  | `url_info.url`                                                                                                                  |
| 6          | 微信文章   | `raw_file_url`（公众号 URL）；短链（无 `__biz`）→ defuddle 抓全文；长链（含 `__biz`）→ `introduction`+`abstract` 摘要 |
| 7          | PDF        | `url_info.url`（openapi）/ `raw_file_url`（cgi-bin，COS 相对路径，403）                                                       |
| 9          | Excel 表格 | `url_info.url`                                                                                                                  |
| 11         | 笔记       | `notebook_ext_info.notebook_id`（openapi）/ `introduction` 预览（cgi-bin，无法获取完整内容）                                  |
| 13         | PPT        | `url_info.url`                                                                                                                  |
| 14         | 其他文件   | `url_info.url`                                                                                                                  |
| 99         | 文件夹     | —                                                                                                                                |

---

### 注意事项

- 改版本号时同步更新 manifest.json 和 package.json
- **订阅知识库**：`get_media_info` 返回错误 220030（"没有权限通过skill获取订阅知识库的文件"），需通过 cgi-bin 无认证接口访问
- **共享知识库**：`search_knowledge_base` 返回 `base_type="共享知识库"`，`role_type="创建者"`；应走 openapi 认证接口（与个人知识库相同），**不可走 cgi-bin**（会返回"您已不在该知识库"错误）
- **笔记类型（type 11）在 cgi-bin**：只能获取 `introduction`（约 300 字预览），无法获取完整 Slate JSON 内容；`jump_url` 指向 `https://ima.qq.com/note/visitor?docid=...`，需登录才能访问完整内容，defuddle 无法绕过
- **文件类型 cgi-bin 的 raw_file_url**：返回的是 COS 相对路径（非完整 URL），无法直接下载，只能使用 `abstract` 或 `introduction` 作为摘要
- **微信文章（type 6）URL 长链问题**：
  - cgi-bin 返回的 `raw_file_url` 分两种格式：
    - **短链**：`https://mp.weixin.qq.com/s/XXXXX`（路径形式，无 `__biz` 参数）—— defuddle 可正常抓取完整正文
    - **长链**：`https://mp.weixin.qq.com/s?__biz=...&mid=...`（含 `__biz` 查询参数）—— 微信在路由层拦截，无 session cookie 时直接 302 到验证码页，与 UA/headers/IP 完全无关，**无法绕过**
  - **已穷举的绕过方案（均无效）**：修改 UA/headers、Node.js 伪造请求头、微信 MicroMessenger UA、Google AMP 缓存、`get_media_info`（订阅库返回 220030）、IMA 内容读取 API（404 不存在）——根本原因是微信服务端在路由层做拦截，不看客户端任何参数
  - **当前处理方案**（`sync-manager.ts` `syncPublicKBItem()`）：
    - 短链（不含 `__biz`）：调用 `stripWeChatTrackingParams()` 清理追踪参数后走 `syncWebContent()` 抓全文
    - 长链（含 `__biz`）：走 `buildWeChatIntroContent()`，用 `introduction`（约 300 字原文摘录，含发布时间/地点/作者元数据）+ `abstract`（AI 摘要）构建文件内容，底部附原文链接
  - **潜在完整内容方案**：TikHub API（`https://docs.tikhub.io/268383335e0`）提供长链→短链转换服务，但需付费账号，尚未集成

## v3.9 关键设计决策

### 个人笔记图片/文件强制本地化

COS 签名 URL 约 8 小时过期（`q-sign-time`），个人笔记的图片/文件链接若不下载到本地，每次同步都必须重写笔记刷新 URL，mtime 必然变化。因此 `doSync()` 个人笔记路径强制 `opts.downloadImages = opts.downloadFiles = true`，知识库保留用户开关控制。

设置项已拆分："下载知识库图片"/"下载知识库文件"，描述中说明个人笔记默认下载。

### 增量同步：`modify_time` 单位

API 实测 `modify_time` 为 **13 位毫秒**（如 `1778490458822` → 2026-05-11）。`sync-manager.ts:158` 增量检查不再 `* 1000`。

### 文件名稳定性

`path-utils.ts` `buildStableFilename(url, options)` — 从 COS URL path 提取稳定文件名（忽略 query string 签名），替代 `Date.now()` 时间戳。同一 URL → 同一文件名 → `exists()` 命中 → 跳过重复下载，同时使 `writeNote()` 的 `oldContent === content` 比较可以有效跳过无变化写入。

**注意**：URL path 最后一段可能无扩展名（如 `823d35eccf9141c4a06bb026019742df`），此时必须追加计算出的 `ext`（从 URL 其他部分或 `fallbackExt` 推断）。`baseFilename` 逻辑：

```
filename 有扩展名 → 直接用
filename 无扩展名 → filename + ext
filename 为空     → fallbackName + ext
```

### 个人笔记 `<file>` 标签

IMA `format=1` Markdown 中文件附件是 `<file>` XML 标签（非 Markdown 链接语法）：

```xml
<file mediaId="pdf_xxx" filePath="/Users/.../报告.pdf" fileExtension="pdf" ... />
```

`sync-manager.ts` `processInlineFileTags()` 解析 → `get_media_info(mediaId)` 获取下载 URL → `FileDownloader` 下载 → 替换为本地链接。文件名从 `filePath` 属性提取，保持原名。

### 知识库文件命名

- **非图片文件**（PDF/docx 等）：`sanitizeFilename(title)`，标题即原始文件名
- **图片**（media_type=9）：`buildStableFilename(url, ...)`，从 COS URL 提取扩展名（KB 图片标题可能无扩展名）

### 链接格式

- `escapePathForMarkdown(relPath)` — 路径含空格时用 `<>` 包裹（CommonMark 标准），不含空格不包裹
- `formatFileLink` 支持 wikilink 格式，跟随用户"图片引用格式"设置

## 强制阅读模式实现

`src/main.ts` 中 `enforceWithRestore`、`enforceImaPreviewOnly`、`captureCurrentEditorState` 三方法协同工作：

**设计思路**：

- **`active-leaf-change`**（`enforceWithRestore`）处理用户切换标签页：进入 IMA → 强设阅读模式；离开 IMA → 恢复到进入前状态
- **`layout-change`**（`enforceImaPreviewOnly` + `captureCurrentEditorState`）补两个缺口：分屏/启动时强制 IMA 文件 + 捕获用户在文件内 Ctrl+E 切换模式（不触发 `active-leaf-change`）
- **`onLayoutReady`**（`enforceWithRestore(activeLeaf)`）覆盖冷启动场景——IMA → 强设阅读；非 IMA → 保存状态
- **`captureCurrentEditorState`**（`layout-change` 中调用）补捕获用户在文件内 Ctrl+E 切换模式（不触发 `active-leaf-change`）
- **`saveEditorState(view)`** 公共方法，`captureCurrentEditorState` 和 `enforceWithRestore` 自由浏览路径共用

**状态机**：

```
自由浏览非IMA ──保存 mode/source──→ preImaEditorState ──恢复──→ 离开IMA回到非IMA
      ↑                              ↑                              |
      |                              |                              ↓
   isInImaFolder=false          isInImaFolder=true            isInImaFolder:=false
                                                                   return (不保存)
```

`preImaEditorState` 只在 `isInImaFolder=false`（自由浏览）时更新，切出恢复路径显式 `return` 不保存，避免把刚恢复的状态写回。

**关键 API 选择**：全部使用 `view.setState()` + `view.getMode()`，而非 `leaf.setViewState()` + `leaf.getViewState().state?.mode`：

- Obsidian 切换标签页时 `active-leaf-change` 触发两次（内部行为，与插件无关）
- `leaf.setViewState()` 异步——第二次事件到达时可能尚未生效，`getViewState()` 返回脏数据，若此时走"自由浏览"路径会错误覆盖 `preImaEditorState`
- `view.setState()` 同步生效，第二次事件到达时 `getMode()` 已是正确值，天然幂等

**ESLint 合规要点**：

- `Workspace.activeLeaf` 已弃用 → 使用 `this.app.workspace.getActiveViewOfType(MarkdownView)` 替代，通过 `.leaf` 获取 leaf 引用，或直接用返回的 `MarkdownView`
- `view.setState()` 返回 `Promise<void>` → 必须加 `void` 前缀（`no-floating-promises`）
- `view.getState()` 返回 `unknown` → 用结构化类型断言 `as { mode: string; source?: boolean }`，禁止 `as any`（`no-explicit-any`）
- `instanceof MarkdownView` 守卫后 TS 自动收窄类型 → 去掉冗余的 `as MarkdownView`（`no-unnecessary-type-assertion`）

**Obsidian MarkdownView 模式语义**：

| mode       | source  | 效果             |
| ---------- | ------- | ---------------- |
| `'source'` | `true`  | 纯源码模式       |
| `'source'` | `false` | Live Preview     |
| `'preview'`| —       | 阅读模式（只读） |

## 测试环境

正式笔记库路径：`/Users/admin/Obsidian`
插件 data.json：`/Users/admin/Obsidian/.obsidian/plugins/ima-copilot-sync/data.json`
