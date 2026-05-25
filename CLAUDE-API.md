# IMA API 参考 — ima.copilot Sync

> 本文件是 [CLAUDE.md](CLAUDE.md) 的子引用文件。修改 `ima-client.ts`、`sync-manager.ts` 或对接 IMA 接口时参考。

## IMA API 的坑

- **双响应格式**：Notes API 用 `code`/`msg`，Knowledge Base API 用 `retcode`/`errmsg`——`ima-client.ts` 的 `post()` 兼容两者
- **图片 URL 有时效**：Tencent COS 临时签名链接约 8 小时过期；`get_doc_content` 的 `format=2`（Slate JSON）返回的是**静态签名**（笔记图片上传时生成，不刷新），而 `format=1`（Markdown）返回的是**动态签名**（每次 API 调用重新生成）。因此整个笔记同步主路径统一使用 `format=1`（`getNoteContentMarkdown()`），彻底避免图片过期问题，同时也修复了 `json-to-md.ts` 不处理 `h1`/`h2`/`h3` 导致标题层级丢失的问题
- **个人笔记文件附件是 `<file>` XML 标签**：`get_doc_content`（format=1 Markdown）中文件附件以 `<file mediaId="..." filePath="..." />` XML 标签嵌入，**不是** Markdown `[text](url)` 链接。需 `processInlineFileTags()` 解析后通过 `get_media_info` 获取下载 URL
- **知识库条目 media_id 格式**：`note_<userId>_<docId>`，用 `extractDocIdFromMediaId()` 提取 docId

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
| `parse_progress`   | 解析进度 0~100，100=完成。同步前检查此字段，<100 时等待重试（最多 5 次×10s），仍不完成则跳过     |
| `summary_state`    | 摘要状态，2=已完成                                                                                 |
| `media_state`      | 媒体状态，2=正常                                                                                   |
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

- **订阅知识库**：`get_media_info` 返回错误 220030（"没有权限通过skill获取订阅知识库的文件"），需通过 cgi-bin 无认证接口访问
- **共享知识库**：`search_knowledge_base` 返回 `base_type="共享知识库"`，`role_type="创建者"`；应走 openapi 认证接口（与个人知识库相同），**不可走 cgi-bin**（会返回"您已不在该知识库"错误）
- **笔记类型（type 11）在 cgi-bin**：只能获取 `introduction`（约 300 字预览），无法获取完整 Slate JSON 内容；`jump_url` 指向 `https://ima.qq.com/note/visitor?docid=...`，需登录才能访问完整内容，defuddle 无法绕过
- **文件类型 cgi-bin 的 raw_file_url**：返回的是 COS 相对路径（非完整 URL），无法直接下载，只能使用 `abstract` 或 `introduction` 作为摘要
- **微信文章（type 6）提取策略（v4.8.0 更新）**：
  - 微信文章有 7 种页面模板，识别方式为 JS 变量 `itemShowType`：标准图文(0)、图片分享页/小绿书(8)、视频消息(5)、音频消息(7)、纯文字(10) 等
  - **四层回退**（`html-to-md.ts` `convertWeChatHtmlToMarkdown`）：
    - **Tier 1**：`detectWeChatContentSelector()` 检测已知内容容器 → defuddle + `contentSelector` 提取
    - **Tier 2**：`og:description` meta 提取文本
    - **Tier 3**：裸 defuddle（无 selector）
    - **图片补充**：所有层级统一调用 `extractWeChatImages()`，通过 `from=appmsg` 过滤 + `cdn_url` 正则 + URL 标准化去重
  - **Tier 4 headless BrowserWindow**（`sync-manager.ts` `syncWebContent`）：当静态提取质量不足（`fromMeta`、图片丢失、大 HTML 但短内容）且 `downloadEnhanced` 开启时，使用 Electron 隐藏 BrowserWindow 渲染页面后提取完整 DOM（仅桌面端）
  - **_已删除_**：`buildWeChatIntroContent()` 和 `parseWeChatIntroTime()` 已于 v4.8.0 移除——Tier 4 覆盖了之前需要这些方法的场景
  - cgi-bin 返回的 `raw_file_url` 分两种格式：
    - **短链**：`https://mp.weixin.qq.com/s/XXXXX`（路径形式）—— defuddle 可正常抓取
    - **长链**：`https://mp.weixin.qq.com/s?__biz=...`（含 `__biz` 参数）—— 微信路由层拦截，无 session cookie 时 302 到验证码页，**无法绕过**；headless BrowserWindow 渲染后可能通过验证，但静态 HTTP 请求 100% 失败

- **小红书文章（type 2，v4.8.0 新增）**：
  - 小红书被 IMA 归类为 `media_type=2`（普通网页），URL 域名为 `xiaohongshu.com` / `xhslink.com`
  - **SSR 页面**：静态 HTML 中包含完整内容，**不需要 headless BrowserWindow**
  - 文本提取：defuddle + `#detail-desc` 选择器
  - 图片提取：解析 `<script>window.__INITIAL_STATE__={...}</script>` JSON → `note.noteDetailMap[*].note.imageList[].urlDefault`
  - 反爬：`xhslink.com` 短链会 302 到长链，长链包含 `xsec_token` 参数（`requestUrl` 自动跟随重定向，保持参数）
  - 代码：`html-to-md.ts` `convertXiaohongshuHtmlToMarkdown` → `extractXiaohongshuImages`
  - 路由：`syncByMediaType` 通过 `isXiaohongshuUrl()` 域名检测


