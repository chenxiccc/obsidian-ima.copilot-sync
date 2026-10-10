## 6.6.1

### 问题

同步重复落盘——同名-<同步标识后缀>副本

**重现问题**：metadataCache 未就绪时，已同步条目会被重新下载并另存为"原名-media_id末12位.md"，图片也会级联复制一份，一次全量同步可产生数百份 md 与数千张图片副本；这些副本不会被 syncDeleteMode 清理（云端条目仍在），只能人工排查。

### 修复：同步幂等化

- **判重不再依赖 metadataCache**：`scanExistingKbFiles` / `scanExistingNoteFiles` 在缓存未命中时回退读盘解析 frontmatter，`metadataCache` 未就绪时同样能认出已同步条目；识别结果按「同步标识 → 本地路径列表」收集，规范路径优先
- **撞名时比对同步标识**：`resolveFilePath` 改为 id 感知——同名文件的 frontmatter 标识等于当前条目时原地覆盖，只有标识不同（真的是另一篇同名文章）才追加短标识；后缀路径同样幂等复用
- **新增空索引保护**：本地已有若干笔记却读不到任何同步标识时，跳过创建并提示，避免整库重复落盘
- **删除同步回收全部副本**：同一 docid/media_id 的多份本地文件在远端删除时一并移入回收站

### 新增：清理历史重复副本

- 命令「清理重复副本（同名-同步标识后缀）」：扫描「原名-<同步标识末12位>」且与主档标识相同、去 frontmatter/链接目标/空白后正文一致的副本，确认后移入回收站并回收其专属附件；有正文差异或无主档的副本只报告不删除

### 内部

- **通过 Obsidian 官方审核扫描**：`html-to-md.ts` 5 处原生 `document.createElement` 改用 Obsidian DOM 助手（`createEl` / `createSpan`）；设置页实现声明式设置定义 `getSettingDefinitions()`（设置搜索可检索全部设置项），`display()` 保留为 Obsidian < 1.13 的回退渲染，`minAppVersion` 维持 1.11.4
