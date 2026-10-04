# AI-Powered Recruitment Automation

基于大语言模型与浏览器自动化的智能招聘工作流系统。

面向企业招聘场景，实现岗位同步、候选人信息采集、简历解析、AI 智能筛选与匹配打分、自动沟通等招聘流程自动化。

> 本项目定位为招聘效率工具，需自行提供智联账号登录态与 OpenAI 兼容的大模型 API Key。

---

## 目录

- [项目背景](#项目背景)
- [项目开发者](#项目开发者)
- [项目功能](#项目功能)
- [技术栈](#技术栈)
- [系统架构](#系统架构)
- [前后端如何通信](#前后端如何通信)
- [核心实现](#核心实现)
- [目录结构](#目录结构)
- [系统运行方式](#系统运行方式)
- [环境变量](#环境变量)
- [命令行脚本](#命令行脚本)
- [后端 API](#后端-api)
- [数据存储](#数据存储)
- [使用须知与免责声明](#使用须知与免责声明)
- [License](#license)

---

## 项目背景

传统招聘流程中，HR 通常需要：手动发布和管理岗位、浏览大量候选人信息、下载并阅读每一份简历、对照岗位要求逐份人工筛选、重复进行候选人沟通。

当招聘规模扩大时，人工筛选效率低、招聘周期长，且容易受主观因素影响。

因此，本项目基于 LLM 与浏览器自动化实现招聘流程自动化：用 Playwright 采集候选人与简历，再由大模型理解岗位需求（JD）与候选人经历，输出结构化解析与匹配评分，打通「采集 → 解析 → 筛选 → 沟通」。

---

## 项目开发者

本项目由本人及团队成员共同开发。

## 功能特性

| 模块 | 说明 |
| --- | --- |
| 岗位要求（JD）录入 | 前端文本框粘贴 JD，作为 AI 匹配的基准；参与哈希缓存与去重 |
| 智联附件简历爬取 | 打开消息会话，对候选人「索要附件简历」并下载 PDF；支持日期范围、人数上限、只索要 / 只下载已有附件 |
| 智联消息岗位简历爬取 | 先在消息页按「岗位 + 未读」筛选，再按**成功下载数**计算上限 |
| 在线简历导出 | 打开会话 → 进入简历详情 → 渲染为打印页导出完整简历 PDF（避免点到简历模板附件） |
| 已有简历批量分析 | 对本地已下载的 PDF 目录批量跑模型分析，结果落盘为 JSON |
| 简历列表与结果展示 | 按匹配分排序，可展开查看总体评价、优势、待补足、学历/经验/技能分项评分与解析信息 |
| 邮件发送 | 单个发送或「批量发送前 N 名」，走 163 SMTP |
| 智联自动打招呼 | 在推荐页批量发送自定义招呼语，含去重记录、发送间隔、dry-run |
| 岗位投递者群发 | 按岗位 + 学历 + 最高教育经历所在地 + 期望工作城市 + 未查看等条件筛选后群发 |
| 在招职位同步 | 抓取在招职位列表存入本地 JSON，供前端下拉选择 |
| 任务日志面板 | 长任务以子进程运行，前端轮询实时展示日志与结构化结果 |

---

## 技术栈

**前端**

- Vue 3（Composition API + `<script setup>`，单文件组件，无路由 / 无状态管理库）
- Vite 6（开发服务器 + `/api` 反向代理）

**后端**

- Node.js（ESM）+ Express 4
- Multer（PDF 上传，内存存储，单文件上限 20MB）
- pdf-parse（PDF 文本抽取）
- nodemailer（163 SMTP 发信）

**自动化**

- Playwright（`chromium.launchPersistentContext` 持久化 profile 复用登录态）

**存储**

- SQLite（`sqlite` + `sqlite3`，WAL 模式）缓存分析结果
- 文件系统存放简历 PDF 与脚本去重记录 JSON

**AI**

- 任意 OpenAI 兼容的 Chat Completions 接口：阿里云百炼 Qwen / DeepSeek / OpenAI

> ⚠️ 目录名说明：后端目录叫 `Python/`，但**其中不含任何 Python 代码**，全部是 Node.js。这是历史遗留命名，阅读时请以实际代码为准。

---

## 系统架构

```text
┌────────────────────────┐
│  Vue 3 SPA  (:5173)    │  单页应用，App.vue 承载全部 UI 与轮询逻辑
└───────────┬────────────┘
            │  REST /api/*   （开发期由 Vite dev proxy 转发，规避 CORS）
            ▼
┌──────────────────────────────────────────────┐
│  Express 后端  (:3001)  server.js            │
│  · 路由与参数校验                             │
│  · 子进程调度（spawn Node 脚本）              │
│  · SQLite 分析缓存读写                        │
│  · 静态托管 /resumes 下的 PDF                 │
│  · 邮件发送                                   │
└───────┬───────────────────────┬──────────────┘
        │ spawn 子进程           │ fetch
        ▼                        ▼
┌────────────────────┐   ┌──────────────────────┐
│ Playwright 脚本     │   │ LLM Chat Completions │
│ scripts/zhaopin-*.js│──▶│ （OpenAI 兼容接口）   │
│ scripts/analyze-*   │   └──────────────────────┘
└────────────────────┘
        │  调用 POST /api/analyze-resume 回传分析
        └──────────────▶ Express 后端
```

设计要点：

- **爬虫与分析解耦**：Playwright 脚本既可独立用 CLI 运行，也可由后端 `spawn` 拉起，脚本通过 `POST /api/analyze-resume` 回调后端做分析。
- **同步接口 + 异步任务双通道**：轻量查询走同步 JSON；耗时浏览器任务走「立刻返回 jobId + 轮询」。
- **一切以文件系统为准**：简历 PDF 是事实来源，SQLite 只是可重建的缓存。

---

## 前后端如何通信

1. **反向代理**：前端只请求相对路径 `/api/...`，Vite 在 `vue/vite.config.js` 中把 `/api` 代理到 `http://localhost:3001`，因此开发期不需要处理跨域。
2. **同步接口**：如 `GET /api/resumes`（列出简历 + 已有分析）、`POST /api/analyze-resume`（multipart 上传单个 PDF 并返回分析结果）。
3. **异步长任务**：`POST /api/crawl-*` / `POST /api/zhaopin-*` 立即返回 `202` 与 `jobId`；后端用 `child_process.spawn` 启动脚本并收集 stdout/stderr，前端轮询 `GET /api/jobs/:id` 获取 `status`、`logs`、`results`。
4. **结构化回传**：脚本以 `__WORKFLOW_RESULT__ <json>` 前缀打印日志行，后端识别后剥离为 `results` 数组，前端据此展示进度（例如已下载人数）。
5. **静态资源**：PDF 通过 `GET /api/resumes/file?path=...` 或 `/resumes/*` 直接由后端静态托管。
6. **任务记录**：job 保存在内存 `Map` 中，进程重启即丢失（无持久化队列）。

---

## 核心实现

### 1. PDF 文本抽取与归一化

`extractResumeText()`：PDF 走 pdf-parse，`.txt/.md/.rtf` 直接按 UTF-8 读取；统一去除 `\u0000`、压缩多余空格与连续空行。
**文本长度 < 80 字符直接返回 422**，认为是扫描件 / 图片版 / 加密 PDF，提示需要 OCR，而不是把垃圾文本喂给模型。

### 2. 手机号抽取（本地正则 + 模型结果融合）

`extractMobilePhone()` / `normalizeMobilePhone()` / `mergeExtractedPhone()`：

- 正则容忍空格、连字符、制表符等分隔符，也支持脱敏写法 `138****1234`
- 命中后回看上下文字符，若出现「手机 / 联系电话 / 联系方式 / mobile / tel」等标签则**加权**
- 排序策略：`是否带标签` 优先，其次按出现位置，取最优的一条
- 最终与模型输出的手机号按 **本地抽取 > 模型抽取 > 原值** 的优先级合并

### 3. LLM 简历解析与岗位匹配打分

`analyzeResumeWithModel()` → `buildModelRequest()` → `getAnalysisJsonSchema()`：

- 拼接 System + User 消息，System 明确要求「只输出合法 JSON，不得编造，缺失信息填空」
- 在 prompt 中内联完整 **JSON Schema**，产物包含：`resume_info`（姓名/性别/年龄/联系方式/教育/工作经历/技能/证书/摘要）、`match_score`、`match_details`（总体评价、优势、待补足、性别/年龄/学历/经验/技能分项评分与评语、推荐结论）
- 默认开启 `response_format: { type: "json_object" }`，可通过 `MODEL_JSON_RESPONSE=false` 关闭
- 超长简历按 `MODEL_RESUME_TEXT_MAX_CHARS`（默认 50000）截断并标注

### 4. 容错解析与结果归一化

- `parseModelJson()`：兼容被 ` ```json ` 代码块包裹、或前后夹带说明文字的输出，先剥离代码块，再退化为「截取首个 `{` 到最后一个 `}`」
- `normalizeModelAnalysis()`：按 schema 逐字段兜底，类型不符则回退为空数组 / 空字符串，避免前端渲染崩溃
- `clampScore()`：分数统一取整并夹到 `0–100`

### 5. 基于内容哈希的缓存

- `resume_hash` = 简历文件内容的 SHA 摘要；`job_hash` = JD 文本 + 分析引擎标识（模型 Base URL + 模型名）的哈希
- `UNIQUE(resume_hash, job_hash)`：同一份简历对同一个 JD **只调用一次模型**
- `cleanupMissingPdfAnalysis()`：分析前清理「数据库中已无对应 PDF 文件」的陈旧记录
- 同时兼容读取历史遗留的 `_analysis/*.json` 文件结果

### 6. Playwright 自动化策略

- **持久化浏览器上下文**：`chromium.launchPersistentContext(profileDir)`，登录一次后复用会话，避免反复扫码/登录
- **中文 UI 文案定位**：以「查看附件简历 / 索要附件简历 / 下载 PDF」等文案正则匹配按钮，而非脆弱的 CSS 选择器
- **按业务主键定位**：优先用 `sessionId` / `jobNumber` 精确打开目标会话或岗位
- **去重与限流**：已下载 / 已发送的候选人记录在本地 JSON（如 `zhaopin-greeted-candidates.json`、`zhaopin-job-message-candidates.json`），配合发送间隔降低风控风险
- **列表加载兜底**：有分页器就翻页，无分页器则回退无限滚动加载
- **安全开关**：`--dry-run` 只匹配不发送；`--debug` 保存截图 / HTML / 可点击元素快照便于排查

---

## 目录结构

```text
resume-recruitment/
├── Python/                              # 后端目录（实际是 Node.js，历史命名）
│   ├── server.js                        # Express 服务：路由 / 子进程调度 / 缓存 / 邮件
│   ├── package.json
│   ├── README.md                        # 各脚本的详细 CLI 用法
│   └── scripts/
│       ├── zhaopin-attachment-resumes.js    # 附件简历索要 + 下载
│       ├── zhaopin-resume-pdf.js            # 在线简历详情导出 PDF
│       ├── zhaopin-auto-greeting.js         # 推荐页自动打招呼
│       ├── zhaopin-applicant-messages.js    # 投递者按条件群发
│       ├── zhaopin-sync-jobs.js             # 同步在招职位
│       ├── analyze-downloaded-resumes.js    # 批量分析已下载 PDF
│       ├── resume-analyzer-client.js        # 调用后端分析接口的客户端
│       ├── send-email.js                    # 命令行发信
│       ├── mail-client.js                   # nodemailer 封装
│       └── beijing-universities.js          # 北京高校名单（用于教育经历筛选）
└── vue/                                 # 前端
    ├── index.html
    ├── vite.config.js                   # /api → localhost:3001 代理
    └── src/
        ├── main.js
        ├── App.vue                      # 全部界面与交互逻辑
        └── style.css
```

运行期生成（已被 `.gitignore` 忽略）：`Python/.zhaopin-browser-profile*/`、`Python/zhaopin-*-resumes/`、`Python/resume-analysis.sqlite`、`Python/uploads/`。

---

## 系统运行方式

### 环境要求

- Node.js 18+（建议 20+，需支持全局 `fetch` / `FormData` / `Blob`）
- Windows / macOS / Linux 均可；Playwright 首次需下载 Chromium
- 一个智联招聘账号（自动化操作使用**你自己的**浏览器登录态）
- 一个 OpenAI 兼容的大模型 API Key
- 可选：163 邮箱账号与授权码（用于发信）

### 1. 启动后端

```powershell
cd Python
npm install
npx playwright install chromium
npm run dev        # node --watch server.js，监听 http://localhost:3001
```

在 `Python/` 下创建 `.env`（见[环境变量](#环境变量)），至少配置模型 API Key。

### 2. 启动前端

```powershell
cd vue
npm install
npm run dev        # Vite 监听 http://localhost:5173
```

打开 http://localhost:5173 即可使用。

### 3. 首次使用浏览器自动化

脚本会**弹出真实浏览器窗口**（默认非 headless）。第一次运行时手动完成智联登录，登录态保存在 `Python/.zhaopin-browser-profile`（或 `.zhaopin-browser-profile-boss`），后续无需重复登录。

> 通过前端触发的任务默认带 `--auto`（自动开始，不等待回车）；直接用 CLI 运行时需要按终端提示在浏览器里准备好页面后回车继续。

---

## 环境变量

```dotenv
# ── 服务 ──────────────────────────────
PORT=3001
CORS_ORIGIN=http://localhost:5173

# ── 大模型（任选一家，按前缀自动推导 Base URL 与模型名）──
MODEL_API_KEY=sk-xxxx
# 指定 Provider 时可显式覆盖：
# DASHSCOPE_API_KEY=sk-xxxx        # → qwen-plus, https://dashscope.aliyuncs.com/compatible-mode/v1
# DEEPSEEK_API_KEY=sk-xxxx         # → deepseek-chat, https://api.deepseek.com
# OPENAI_API_KEY=sk-xxxx           # → gpt-4.1-mini, https://api.openai.com/v1
MODEL_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MODEL_NAME=qwen-plus
MODEL_TEMPERATURE=0.2
MODEL_JSON_RESPONSE=true
MODEL_RESUME_TEXT_MAX_CHARS=50000

# ── 存储 ──────────────────────────────
SQLITE_DB_PATH=resume-analysis.sqlite
# PUBLIC_BASE_URL=http://your-host:3001   # 可选：对外可访问的地址

# ── 邮件（163）────────────────────────
MAIL_USER=you@163.com
MAIL_AUTH_CODE=你的SMTP授权码
MAIL_FROM_NAME=招聘助手
SMTP_HOST=smtp.163.com
SMTP_PORT=465
SMTP_SECURE=true
```

兼容项（早期 Coze 方案遗留，未配置不影响使用）：`COZE_WORKFLOW_URL`、`COZE_FILE_UPLOAD_URL`、`COZE_API_TOKEN`、`COZE_FILE_UPLOAD_TOKEN`、`COZE_FILE_MODE`。

---

## 命令行脚本

所有脚本也可脱离前端直接用 CLI 运行，完整参数见 [Python/README.md](Python/README.md)。

```powershell
cd Python

npm run crawl:zhaopin              # 在线简历详情导出 PDF → zhaopin-online-resumes
npm run crawl:zhaopin-attachments  # 索要 + 下载附件简历 PDF（可自动分析）
npm run zhaopin:greet              # 推荐页自动打招呼（先加 -- --dry-run 试跑）
npm run zhaopin:applicants         # 投递者按条件群发（先加 -- --dry-run 试跑）
npm run zhaopin:sync-jobs          # 同步在招职位 → zhaopin-jobs.json
npm run analyze:downloaded         # 批量分析已下载的 PDF
npm run send:email -- --to "a@b.com" --subject "测试" --text "你好"
```

---

## 后端 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api` | 接口索引 |
| GET | `/api/health` | 健康检查 |
| GET | `/api/resumes` | 列出目录下 PDF 及其已有分析结果（支持 `?dir=`） |
| GET | `/api/resumes/file` | 下载 / 预览指定简历文件（`?path=`） |
| POST | `/api/analyze-resume` | **上传单个 PDF + JD，返回解析与匹配评分**（multipart：`resume_file`、`job_requirements`、`file_type`） |
| POST | `/api/crawl-resumes` | 启动附件简历爬取任务 → `202 + jobId` |
| POST | `/api/crawl-message-resumes` | 启动消息岗位简历爬取任务 |
| POST | `/api/analyze-downloaded-resumes` | 批量分析已下载简历目录 |
| POST | `/api/resumes/clear-analysis` | 清空指定目录的分析结果 |
| POST | `/api/zhaopin-greetings` | 启动自动打招呼任务 |
| POST | `/api/zhaopin-applicant-messages` | 启动投递者群发任务 |
| GET | `/api/zhaopin-jobs` | 读取已同步的在招职位 |
| POST | `/api/zhaopin-sync-jobs` | 同步在招职位 |
| POST | `/api/send-email` | 发送邮件（支持附件） |
| GET | `/api/jobs/:id` | 查询异步任务状态、日志与结果（前端轮询） |

---

## 数据存储

**SQLite：`resume-analysis.sqlite`**

```sql
CREATE TABLE resume_analysis (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  resume_hash   TEXT NOT NULL,          -- 简历文件内容哈希
  job_hash      TEXT NOT NULL,          -- JD + 分析引擎标识 哈希
  candidate_name TEXT,
  file_name     TEXT,
  file_size     INTEGER,
  file_type     TEXT,
  job_requirements TEXT,
  response_json TEXT NOT NULL,          -- 模型返回的分析结果
  file_json     TEXT,
  source        TEXT NOT NULL DEFAULT 'workflow',
  analyzed_at   TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(resume_hash, job_hash)         -- 同一简历 + 同一 JD 只分析一次
);
```

**文件系统**

- `zhaopin-attachment-resumes/`、`zhaopin-online-resumes/`：简历 PDF
- `zhaopin-attachment-resumes/_analysis/`：分析结果 JSON
- `zhaopin-jobs.json`：已同步的在招职位
- `zhaopin-greeted-candidates.json`、`zhaopin-job-message-candidates.json`：发送去重记录
- `.zhaopin-browser-profile*/`：Playwright 登录态

---

## 使用须知与免责声明

- 本项目通过 Playwright 操作**你自己登录的**智联招聘账号，仅用于提升个人/团队招聘效率。
- 请自行确认使用方式符合目标网站的用户协议与相关法律法规；**请勿**用于高频骚扰、大规模抓取或任何侵犯他人隐私与权益的行为。
- 消息发送类功能默认提供 `--dry-run`（前端为「只测试不发送」），**强烈建议先试跑确认名单**，并设置合理的发送间隔与人数上限。
- 简历属于个人敏感信息，请妥善保管本项目生成的 PDF、分析结果与数据库文件，不要将其提交到公开仓库。
- 使用本工具产生的一切后果由使用者自行承担。

---

## License

[MIT](LICENSE)