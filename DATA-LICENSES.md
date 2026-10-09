# 数据许可

代码许可证与数据许可证彼此独立。`LICENSE` 只覆盖应用、CLI、schema 和数据流水线代码，不自动覆盖下载的数据 artifact。

## 当前 fixture

`data/fixtures/nirvana-v1/` 是工程 smoke fixture，不是生产数据快照。

| Partition | License | 内容 | 分发状态 |
|---|---|---|---|
| `rock-core-cc0` | CC0-1.0 | 最小实体事实、Wikidata QID 映射与一条 P279 evidence | 可分发 |

Wikidata evidence 指向 `Q11365` 的公开实体记录；Wikidata structured data 以 CC0 发布。manifest 中的 `redistributable=true` 只表示通过本项目当前分发策略，不构成一般法律结论。

## 实验样本

`data/sources/experiment-v1/` 是 2026-08-01 冻结的可重放来源子集，`data/fixtures/experiment-v1/` 是由它生成的产品实验 payload。两者只覆盖 20 Style、100 Artist、200 ReleaseGroup、9 Recording 与相邻证据，不是全量数据库 dump。

| 路径 | Partition | License | 内容 | 分发状态 |
|---|---|---|---|---|
| `data/sources/experiment-v1/` | `rock-core-cc0` | CC0-1.0 | MusicBrainz core identity/metadata 与 Wikidata identity/P279 来源快照 | 可分发 |
| `data/fixtures/experiment-v1/` | `rock-core-cc0` | CC0-1.0 | 确定性样本、编辑问题路径与 CC0/仓库方法 evidence | 可分发 |

MusicBrainz derived tags、Discogs 复制字段和不可再分发媒体没有进入这些目录。仓库内编辑问题和说明按代码/文档许可证发布，但它们不会把上游数据的许可改写为 Apache-2.0。当前判断只适用于 manifest 声明的字段与快照，不构成一般法律结论。

## 828 风格限定目录

`data/sources/global-style-mock-v1/` 与 `data/sources/rock-catalog-v2/` 保存限定查询所需的 Wikidata、MusicBrainz core 与 Discogs 结构化字段；`data/published/rock-catalog-v2/` 是经 PostgreSQL 校验后导出的产品投影。它不包含封面、音频、Discogs 用户内容或 MusicBrainz derived tags。

| Partition | License | 内容 | 分发状态 |
|---|---|---|---|
| `wikidata-cc0` | CC0-1.0 | 风格闭包、QID、P136/P175/P279 与 revision | 可分发 |
| `musicbrainz-core-cc0` | CC0-1.0 | 艺人、release group 身份和 artist credit | 可分发 |
| `discogs-cc0` | CC0-1.0 | Artist/Master 数字 ID 与 master artist credit 的限定 API 快照 | 可分发 |

跨源验证不会改变任一上游字段的许可。`manifest.json` 和 PostgreSQL `source_snapshot.license_partition` 必须保持分区；任何新增字段都要重新核对来源许可和 API 条款。

## 计划中的 package

| Package | 预期来源与边界 | 状态 |
|---|---|---|
| `rock-core-cc0` | MusicBrainz core + Wikidata CC0 字段 | 实验子集已构建；全量 V1 未构建 |
| `rock-discogs-cc0` | Discogs monthly dump 中经 `Genre=Rock` 入口筛选的 Artist、Master、Release 与 Style assertion | 未构建 |
| `rock-derived-nc` | MusicBrainz derived genre / tag 数据 | 未构建，必须独立发布 |
| `rock-acoustic-cc0` | 仅由 CC0 ArtistStyle 映射聚合的 AcousticBrainz 字段 | 未构建 |
| `rock-acoustic-derived-nc` | 依赖 NC ArtistStyle 映射的派生声音数据 | 未构建，必须独立发布 |

未知许可证、缺少 lineage 或 `redistributable=false` 的 required partition 会阻断 pack 校验。兼容决定记录在 `config/license-compatibility-v1.json`，不得使用 CLI flag 绕过。
