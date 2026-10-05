# sologsb-1122 隧道掌子面地质编录台（gbtunnelface）

面向隧道施工地质人员的掌子面编录工作台：逐循环编录围岩级别、岩性、节理产状与涌水情况，绘制岩性素描并用数字表示结构面，实时按 BQ 指标判定围岩级别并给出支护建议。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：**http://localhost:21822**

停止服务：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3 + TypeScript（`<script setup>`） |
| UI | Element Plus 2 |
| 构建 | Vite 5 |
| 状态管理 | Pinia |
| 路由 | Vue Router 4（history 模式） |
| 本地存储 | IndexedDB（Dexie 4）+ localStorage（素描线段），含结构版本号与升级迁移 |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # vue-tsc 类型检查 + vite 构建
```

> 生产环境由 nginx 托管 `dist`，`nginx.conf` 已启用 `try_files $uri $uri/ /index.html;` 与 gzip。

## 目录结构

```
sologsb-1122/
├── docker-compose.yml
├── .env.example
├── .env
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── main.ts
        ├── App.vue
        ├── router/index.ts
        ├── types/{face,joint,grade,water,sync}.ts
        ├── stores/{face,joint,grade,sync}Store.ts
        ├── components/common/{SketchCanvas,JointPolarPlot,GradeTag,FaceCard}.vue
        ├── components/sync/FaceDiffReport.vue
        ├── hooks/{useFaceFilter,useGradeCalc}.ts
        ├── pages/{FaceList,FaceDetail,JointEntry,WaterView,GradeJudge,SyncCenter,BatchDetail}.vue
        └── utils/{db,geoMath,id,sync}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/faces` | 掌子面台账：里程区间/岩性/围岩级别/开挖方式筛选 + 级别分布条 | TunnelFace、RockMassGrade |
| `/faces/:id` | 掌子面详情：基本信息 + 岩性素描图 + 节理组列表 + 与上循环级别比对 | TunnelFace、JointSet、RockMassGrade |
| `/faces/:id/joints` | 节理产状录入：极点图/玫瑰图、同组产状合并、异常倾角提示 | JointSet |
| `/faces/:id/water` | 涌水记录与沿里程趋势折线，标记突变点与建议措施 | WaterInflow |
| `/grade/:faceId` | 围岩级别判定：逐项输入 RQD/Jv/Kv/出水状态，实时算级别与支护建议，可人工修正并保存 | RockMassGrade、TunnelFace |

`/` 重定向到 `/faces`，未匹配路由同样兜底到 `/faces`。

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/sync` | 离线批次中心：新建/导入/导出/提交批次，查看合入报告与差异 | CatalogBatch |
| `/sync/:id` | 单批次离线编录工作台：在不改动主库的前提下暂存掌子面/节理/涌水/级别修改 | CatalogBatch |

## 离线批次合并（双平板协同）

解决「两台平板分开记录、回到项目部先导入者盖掉后者」与「旧级别沿用旧节理/涌水」两个问题：

- **批次（Batch）为提交与幂等单位**：每台平板离线期间把改动暂存进批次，携带创建时的共同祖先快照与按掌子面的基线修订号（`baseRev`）。
- **并发只一份写入（CAS）**：提交在单个 IndexedDB 事务内比较各掌子面修订号，对端已先提交则整批不写入，批次转为「冲突」，其全部修改原样保留并提示冲突批次。
- **原样重试**：冲突后可不改内容重新提交；对端仍在则再次冲突。也可「保留两版合入」。
- **保留两版 + 差异标注**：保留两版合入对掌子面做字段级三方合并（仅本批次改的字段写入、两边都改保留库中版本），并在合入报告中按 共同基线 / 库中（对端）/ 本批次 三列标出字段、节理组、涌水的新增/删除/两边都改。
- **依据失效与重新判定**：每条级别记录保存节理组与涌水的依据签名（`basisSignature`）。合入后签名变化（节理组或涌水状态改变）时，旧级别置 `basisValid=false` 并记 `invalidReasons`，同时按当前节理自动估 Jv、按当前涌水重推出水状态，重算 BQ/[BQ] 生成一条新级别（`prevGradeId` 链接旧级别；人工修正级别保留人工级别，仅刷新指标）。
- **幂等、旧批次不重复计入**：批次 id 即幂等键，重复提交、重复导入同一批次直接返回既有合入报告，不重复写任何表；外部「已合入」批次导入默认仅存档，不覆盖本机主数据。

> 纯前端单机内可用「模拟平板A / 平板B」切换设备 + 导出/导入批次文件复现整条流程；`scripts/verify-sync.ts` 用 fake-indexeddb 覆盖并发冲突、原样重试、保留两版、失效重判与幂等。

## 数据存储说明

- 数据库名 `gbtunnelface`，当前结构版本 **v3**（`localStorage['gbtunnelface:db-version']` 记录）。
- 五张表：`faces`（掌子面）、`joints`（节理组）、`grades`（围岩级别判定）、`waters`（涌水记录）、`batches`（离线编录批次）。
- v1 → v2 迁移：为老掌子面补 `attitude`、`mileageRange`，为级别记录补 `correctedBq`、`manualAdjusted`，为涌水补 `chainage`，并新增索引。
- v2 → v3 迁移：新增 `batches` 表；为级别记录补判定依据签名 `basisSignature`、`basisValid`、`invalidReasons`、`basedOnBatches`（按迁移当时的节理组/涌水回填签名）。
- 岩性素描的结构面线段单独存 `localStorage['gbtunnelface:sketch:<faceId>']`，刷新后仍在。
- 容器无状态、不挂载命名卷；清空站点数据即回到初始示范数据。
- 首次打开灌入 2 个示范掌子面、4 组节理、1 条级别判定与 3 条涌水记录。

## 功能要点

- **围岩级别实时判定**：`BQ = 90 + 3σc + 250Kv`，`[BQ] = BQ − 100(K1 + K2 + K3)`（K1 由出水状态、K2 由洞跨取值），再按 >550/451~550/351~450/251~350/151~250/≤150 映射到 Ⅰ~Ⅵ 级，并给出对应支护建议；支持人工修正级别。
- **级别比对**：详情页与判定页自动与上一循环级别比对，输出「变好/变差 N 级」结论。
- **素描交互**：`<SketchCanvas>` 在图上单击即按当前岩层产状布置结构面线段，带岩性填充纹样、比例尺、图例与撤销/清空，线段本地持久化。
- **节理统计**：`<JointPolarPlot>` 等面积投影极点图 + 走向玫瑰图，按组着色；按倾向 30° 聚类支持同组产状合并。
- **异常提示**：倾角超出 0~90° 直接拦截；涌水量较上一点翻倍或趋势突增标记为突变点并给出措施。
- **离线批次合并**：双平板并发提交按掌子面修订号做 CAS（只一份写入、另一份保留修改并提示冲突、可原样重试）；同一掌子面两边都改可保留两版并三方标差异；节理组/涌水依据变化后关联级别自动失效并重判；批次幂等，旧批次不重复计入。
