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
| 本地存储 | IndexedDB（Dexie 4）+ localStorage（素描线段/设备标识/提交锁），含结构版本号与升级迁移 |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # vue-tsc 类型检查 + vite 构建
npm test         # vitest 离线合并/级别失效单测
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
        ├── types/{face,joint,grade,water}.ts
        ├── stores/{face,joint,grade}Store.ts
        ├── components/common/{SketchCanvas,JointPolarPlot,GradeTag,FaceCard}.vue
        ├── hooks/{useFaceFilter,useGradeCalc}.ts
        ├── pages/{FaceList,FaceDetail,JointEntry,WaterView,GradeJudge,SyncCenter}.vue
        └── utils/{db,geoMath,id,device}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/faces` | 掌子面台账：里程区间/岩性/围岩级别/开挖方式筛选 + 级别分布条 | TunnelFace、RockMassGrade |
| `/faces/:id` | 掌子面详情：基本信息 + 岩性素描图 + 节理组列表 + 与上循环级别比对 + 两版差异 | TunnelFace、JointSet、RockMassGrade |
| `/faces/:id/joints` | 节理产状录入：极点图/玫瑰图、同组产状合并、异常倾角提示 | JointSet |
| `/faces/:id/water` | 涌水记录与沿里程趋势折线，标记突变点与建议措施 | WaterInflow |
| `/grade/:faceId` | 围岩级别判定：逐项输入 RQD/Jv/Kv/出水状态，实时算级别与支护建议，可人工修正并保存 | RockMassGrade、TunnelFace |
| `/sync` | 离线批次合并中心：导出/导入批次 JSON、冲突处理、合入历史 | SyncBatch、ChangeEntry、MergeConflict |

`/` 重定向到 `/faces`，未匹配路由同样兜底到 `/faces`。

## 数据存储说明

- 数据库名 `gbtunnelface`，当前结构版本 **v3**（`localStorage['gbtunnelface:db-version']` 记录）。
- 七张表：
  - 业务表 `faces`（掌子面）、`joints`（节理组）、`grades`（围岩级别判定）、`waters`（涌水记录）；
  - 离线合并表 `changes`（本机变更日志/outbox）、`committedBatches`（已合入批次登记）、`conflicts`（合并冲突留档）。
- v2 → v3 迁移：业务表补 `updatedAt/updatedBy`，级别记录补 `invalid/basisJointSig/basisWaterSig` 等字段，并新建上述三张同步表。
- v1 → v2 迁移：为老掌子面补 `attitude`、`mileageRange`，为级别记录补 `correctedBq`、`manualAdjusted`，为涌水补 `chainage`，并新增索引。
- 岩性素描的结构面线段单独存 `localStorage['gbtunnelface:sketch:<faceId>']`，刷新后仍在（不纳入批次，两台平板各自保留素描）。
- 容器无状态、不挂载命名卷；清空站点数据即回到初始示范数据。
- 首次打开灌入 2 个示范掌子面、4 组节理、1 条级别判定与 3 条涌水记录。

## 离线批次合并（两台平板协同）

两台平板各自离线编录，回到项目部通过「离线批次」页面导出/导入 JSON 文件合并，避免"先导入者整体盖掉后导入者"。

- **变更日志（outbox）**：所有新增/修改/删除都与业务表在同一事务写入 `changes`，同一条记录只保留最新一版；导出批次后标记批次号，但修改继续保留。
- **合并规则**：
  - 只有一方改过 → 按 `updatedAt` 直接采用较新版本；
  - **同一掌子面两边都改过** → 不覆盖任何一版，登记 `face-diverge` 冲突：本机版本保留为主版本，对端版本归档到 `remoteSnapshot` 并在详情页/台账标出字段级差异；也可选择只留一版或把对端版另存为新掌子面；
  - 节理组/涌水/级别记录两边都改过同样登记冲突（保留本机 / 采用对端 / 对端删除）。
- **级别失效与重判**：级别保存时记录节理依据签名与涌水依据签名。节理组或涌水状态变化后，最新有效级别自动失效；非人工修正的级别按新节理（重估 Jv→Kv、重算 BQ）和新涌水状态（重取 K1）自动重判并标注「依据变化后自动重判」，人工修正级别只置失效、不自动覆盖，提示地质员重新判定。
- **并发提交**：`localStorage` 提交锁 + IndexedDB 单事务保证两台平板（或两个标签页）同时提交时只有一份写入；未写入的一方返回 `locked`，本机未提交修改原样保留，用同一批次文件稍后原样重试即可。
- **幂等重试**：批次以 `batchId` 登记在 `committedBatches`，重复导入（合入失败后原样重试、旧批次再次导入）直接回显上次结果，不会重复计入。
- 纯函数（合并规划、依据签名/重判）与 IndexedDB 集成逻辑均有 Vitest 覆盖：`npm test`。

## 功能要点

- **围岩级别实时判定**：`BQ = 90 + 3σc + 250Kv`，`[BQ] = BQ − 100(K1 + K2 + K3)`（K1 由出水状态、K2 由洞跨取值），再按 >550/451~550/351~450/251~350/151~250/≤150 映射到 Ⅰ~Ⅵ 级，并给出对应支护建议；支持人工修正级别。
- **级别比对**：详情页与判定页自动与上一循环级别比对，输出「变好/变差 N 级」结论。
- **素描交互**：`<SketchCanvas>` 在图上单击即按当前岩层产状布置结构面线段，带岩性填充纹样、比例尺、图例与撤销/清空，线段本地持久化。
- **节理统计**：`<JointPolarPlot>` 等面积投影极点图 + 走向玫瑰图，按组着色；按倾向 30° 聚类支持同组产状合并。
- **异常提示**：倾角超出 0~90° 直接拦截；涌水量较上一点翻倍或趋势突增标记为突变点并给出措施。
