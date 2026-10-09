# 全量 Rock 静态目录生成流水线

## 1. 目标

该流水线把 MusicBrainz、Discogs 与 Wikidata 的开放数据加工为 Rock Atlas 可直接读取的
Catalog V3 静态文件。数据库只在离线构建期间使用，网站运行时不需要 PostgreSQL 或 API。

```text
source archives
  -> checksum / signature verification
  -> MusicBrainz PostgreSQL stage
  -> Discogs two-pass Rock stage
  -> reviewed Rock style catalog + tracked Wikidata stage
  -> canonical PostgreSQL generation
  -> sorted JSONL frontend namespaces
  -> content-addressed gzip buckets
  -> signed manifests
  -> atomic current.json switch
```

脚本不会把全量归档、数据库、密钥或中间 JSONL 写入 Git 仓库；这些生产目录必须使用仓库外绝对路径。最终 `--static-root` 也建议使用独立发布目录；若为了本地静态站点挂载而放入 `public/data/`，必须保持 Git 忽略且不能提交生成物。

## 2. 新增入口

| 命令 | 用途 |
|---|---|
| `npm run data:full:keygen` | 生成 Ed25519 私钥与前端可信 public JWK |
| `npm run data:full:pipeline` | 默认 dry-run，列出完整阶段，不访问网络或写文件 |
| `npm run data:full:export` | 从已完成的 canonical PostgreSQL schema 导出 12 个排序 JSONL namespace |
| `npm run data:full:publish` | 生成 V3 gzip 分片和签名 candidate；显式确认后切换 current pointer |

既有命令继续负责上游阶段：

- `data:bootstrap:acquire-verify`
- `data:stage:musicbrainz`
- `data:stage:discogs`
- `data:stage:wikidata`
- `data:project:canonical`

## 3. 前提

- Node.js 22、Python 3、GnuPG、PostgreSQL 18 `psql`；
- Docker 可选，但 PostgreSQL 必须能被 `psql` 访问；
- 仓库外独立数据盘，首次导入至少 512 GB，推荐 1 TB；
- 真实联系人标识，用于 Wikidata User-Agent；
- 受审 Wikidata Rock style catalog；默认使用仓库内当前 828 风格真实数据快照，可用 `--rock-style-catalog` 替换；
- 通过许可审计和全量下载授权；
- Gate A 报告通过后，才允许切换网站 `current.json`。

本仓库不内置生产私钥。密钥必须备份到安全位置，并且文件权限为 `0600`。

## 4. 生成签名密钥

```bash
npm run data:full:keygen -- \
  --private-key /secure/musicwiki/catalog-production-2026.pem \
  --public-jwk /secure/musicwiki/catalog-production-2026.public.json \
  --key-id catalog-production-2026
```

把 public JWK 加入前端可信 key 配置。不得提交或上传 private PEM。

## 5. Dry-run

```bash
npm run data:full:pipeline -- \
  --plan /absolute/path/authorized-plan.json \
  --contact ops@example.com \
  --static-root /absolute/path/site/public/data/rock-catalog-v3 \
  --signing-key /secure/musicwiki/catalog-production-2026.pem \
  --key-id catalog-production-2026 \
  --generated-at 2026-09-02T00:00:00Z
```

默认结果固定包含：

```text
execution_mode = dry-run
network_requests_executed = 0
files_written = 0
```

它只打印阶段、命令参数和 Gate 状态。确认串会被脱敏。

`--tracked-qids` 是可选的额外 Wikidata 实体集合，用于补充 Artist/ReleaseGroup 外部身份；
受审 Rock 风格 QID 会由 `--rock-style-catalog` 自动并入，不需要手工复制成第二份列表。
`--legacy-catalog` 默认读取当前 V2 canonical catalog，用其中的显式 QID/MBID 生成旧深链
到 V3 canonical ID 的 `current/redirected/removed` 解析记录；可用绝对路径替换，但不能用名称匹配。

## 6. 正式执行

只有计划同时满足 `execution_ready=true`、容量 Gate `pass` 和下载 `authorized`，才能执行：

```bash
npm run data:full:pipeline -- \
  --plan /absolute/path/authorized-plan.json \
  --contact ops@example.com \
  --static-root /absolute/path/site/public/data/rock-catalog-v3 \
  --signing-key /secure/musicwiki/catalog-production-2026.pem \
  --key-id catalog-production-2026 \
  --generated-at 2026-09-02T00:00:00Z \
  --download-authorization I_CONFIRM_FULL_ARCHIVE_DOWNLOAD \
  --execute
```

需要补充非风格实体时，再加入：

```bash
  --tracked-qids /absolute/path/additional-tracked-qids.json \
  --rock-style-catalog /absolute/path/reviewed-rock-style-catalog.json
```

上述命令完成所有数据处理并发布一个签名 candidate pointer，但**不切换**网站 current。适合首轮审查。

Gate A 通过后，增加：

```bash
  --gate-a-report /absolute/path/catalog-v3-gate-a-report.json \
  --gate-a-report-url /data/rock-catalog-v3/generations/GENERATION_SLUG/gate-a-report.json \
  --publish-authorization I_CONFIRM_ATOMIC_POINTER_SWITCH
```

publisher 会校验本地 Gate A 报告，并要求 `--gate-a-report-url` 精确位于本 generation 的 `gate-a-report.json`；随后写入并回读验证报告、全部不可变对象、递归 namespace manifest、root manifest 和 candidate pointer，最后在文件锁内原子替换 `current.json`。

## 7. 输出

```text
rock-catalog-v3/
  current.json
  generations/{generation}/
    candidate-current.json
    root-manifest.json
    overview.json
    # Gate A 报告位于 --gate-a-report-url 对应路径
    manifests/{namespace}/root.json
    manifests/{namespace}/shards/*.json
    publication-report.json
  objects/sha256/{prefix}/{hash}.json.gz
```

前端 namespace：

- `style-summary`
- `style-artists`
- `style-relations`
- `artist-summary`
- `artist-release-groups`
- `release-group-summary`
- `relation`
- `evidence`
- `identity-resolution`
- `search-style`
- `search-artist`
- `search-release-group`

`style-artists` 与 `style-relations` 固定每页 60，`artist-release-groups` 每页 24。没有艺人或关系的实体仍生成空 page 0，用于区分“确实为空”和“分片缺失”。搜索 posting 每个 key 最多保存 100 个稳定排序结果，并记录 `total_count/truncated`。

`identity-resolution` 覆盖当前 V2 的全部 Style、Artist 和 ReleaseGroup ID：ID 未变化的记录为
`current`，在新 canonical `external_identity` 中一对一命中且 ID 改变的记录为 `redirected`；没有稳定外部 ID、未进入 Rock 闭包
或存在歧义的记录为带原因的 `removed`，不会猜测同名目标。

## 8. 确定性和内存边界

- SQL 行必须按 ID 严格排序；
- canonical Style 是“受审 Wikidata Rock style 集合”与“未能一对一映射的 Discogs Style”的并集；
- 真实 Wikidata entity-valued claims 按 `{value.id}` 解析，`P279/P737` 不按字符串 fixture 处理；
- Discogs `co_tagged_with` 作为无向统计关联进入 V2 assertion/evidence，不显示成历史演化事实；
- JSONL 逐行输出，不使用全库 `jsonb_agg`；
- exporter 按 ID SHA-256 前缀流式分桶；
- leaf 以实际 gzip 字节递归拆分，默认硬上限 512 KiB；
- namespace manifest 过大时递归拆为哈希路由 manifest；
- overview 只含全部 Style、确定性布局和最多 1,500 条优先关系；完整关系保留在 relation namespace；
- candidate 生成前逐对象回读，同时校验压缩对象与解压内容的 bytes 和 SHA-256；
- 同一 generation 的不可变对象发生字节冲突时立即失败；
- `current.json` 只在所有验证通过后原子替换。

## 9. 恢复与重新运行

stage、canonical 和 frontend JSONL 目录包含完整 manifest 时，总编排会复用；缺少 manifest 的半成品目录会按各阶段的 fail-closed 规则拒绝覆盖。下载阶段继续使用 `.part` 断点续传和 generation state。

静态回滚只需验证并恢复上一代签名 pointer，然后清除 CDN 对 `current.json` 的缓存。不可变对象不应覆盖或就地修改。

## 10. 本次实现边界

本次只实现并使用 fixture、临时目录和 PostgreSQL 集成测试验证脚本，没有下载或生成实际全量数据，也没有切换现有 V2/V3 生产 pointer。
