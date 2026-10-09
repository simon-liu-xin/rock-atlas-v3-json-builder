# Rock Atlas V3 JSON 构建工具

从后端 SQL/受审投影生成网站所需静态数据。包括全量 SQL→JSONL、12 个 V3
namespace、按需加载分片、gzip 内容寻址对象、Ed25519 签名、原子指针发布和
前端交付。不会下载 MusicBrainz/Discogs 全库或替代多源交叉验证。

```bash
npm ci
npm run check
```

## 当前受审限定目录

先在后端仓库执行 SQL 导出，再指定其绝对路径：

```bash
npm run data:catalog:v3 -- --backend-root /path/to/rock-atlas-v3-backend
npm run data:frontend:sync -- --frontend-root /path/to/rock-atlas-v3-frontend
```

默认输出为本仓库 `public/data/rock-catalog-v3/`。默认 Ed25519 私钥在用户目录
`.local/share/rock-atlas/current-catalog-v3.pem`，不进入仓库。换机器时使用自己
的外部私钥与新的 `--key-id`；已绑定 key_id 不允许更换成不同密钥。

同步命令校验全部活动对象，先复制 immutable 对象与 manifest，再合并匹配的
可信公钥，最后切换前端指针。完成后在前端仓库构建和部署。

## 全量 SQL

```bash
npm run data:full:export -- --canonical-manifest /absolute/canonical-project-manifest.json --output-dir /absolute/new-projection-directory --legacy-catalog /path/to/rock-atlas-v3-backend/data/published/rock-catalog-v2/canonical-catalog.json
```

完整参数和签名发布见 [全量静态流水线](docs/data/full-static-catalog-pipeline.md)。
该文档的下载、stage、canonical 和编排步骤属于后端仓库；本仓库负责 export、
keygen、publish。全量签名发布成功后会登记本仓库可信公钥，前端同步命令再将该
活动公钥交付给前端。切换全量 current 仍需对应 generation 的 Gate A 和显式授权。

当前限定迁移不是全量下载器。构建输出、私钥、SQL dump 和生产数据不进入 Git。
所有生成数据有来源与许可分区，用户实际上传时仍需保持其对应声明。
