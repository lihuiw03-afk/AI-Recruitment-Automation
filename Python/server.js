import cors from "cors";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import dotenv from "dotenv";
import express from "express";
import fs from "node:fs/promises";
import multer from "multer";
import path from "node:path";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { fileURLToPath } from "node:url";
import { sendMail } from "./scripts/mail-client.js";

dotenv.config();

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3001);
const workflowUrl = process.env.COZE_WORKFLOW_URL || "https://7k3zq274hb.coze.site/run";
const fileUploadUrl = process.env.COZE_FILE_UPLOAD_URL || "https://api.coze.cn/v1/files/upload";
const apiToken = process.env.COZE_API_TOKEN;
const fileUploadToken = process.env.COZE_FILE_UPLOAD_TOKEN;
const fileMode = process.env.COZE_FILE_MODE || (fileUploadToken ? "coze_upload" : "public_url");
const modelProvider = process.env.MODEL_PROVIDER || "";
const modelApiKey = process.env.MODEL_API_KEY || process.env.DASHSCOPE_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
const modelBaseUrl = process.env.MODEL_BASE_URL
  || (process.env.DASHSCOPE_API_KEY ? "https://dashscope.aliyuncs.com/compatible-mode/v1" : "")
  || (process.env.DEEPSEEK_API_KEY ? "https://api.deepseek.com" : "")
  || (process.env.OPENAI_API_KEY ? "https://api.openai.com/v1" : "");
const modelName = process.env.MODEL_NAME
  || (process.env.DASHSCOPE_API_KEY ? "qwen-plus" : "")
  || (process.env.DEEPSEEK_API_KEY ? "deepseek-chat" : "")
  || (process.env.OPENAI_API_KEY ? "gpt-4.1-mini" : "");
const modelTemperature = Number(process.env.MODEL_TEMPERATURE || "0.2");
const publicBaseUrl = process.env.PUBLIC_BASE_URL;
const uploadsDir = path.join(__dirname, "uploads");
const publicDir = path.join(__dirname, "public");
const databasePath = path.join(__dirname, process.env.SQLITE_DB_PATH || "resume-analysis.sqlite");
const greetingMessageDir = path.join(__dirname, ".zhaopin-greeting-messages");
const zhaopinJobsPath = path.join(__dirname, "zhaopin-jobs.json");
const jobs = new Map();
const db = await initDatabase();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024
  }
});

app.use(cors({ origin: process.env.CORS_ORIGIN || "http://localhost:5173" }));
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));
app.use("/uploads", express.static(uploadsDir));
app.use("/resumes", express.static(path.join(__dirname, "zhaopin-attachment-resumes")));
app.use(express.static(publicDir));

app.get("/api", (_req, res) => {
  res.json({
    ok: true,
    endpoints: ["GET /api/health", "POST /api/analyze-resume"]
  });
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/resumes", async (req, res) => {
  const dir = resolveProjectPath(req.query.dir || "zhaopin-attachment-resumes");

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
      .map(async (entry) => {
        const filePath = path.join(dir, entry.name);
        const stat = await fs.stat(filePath);
        const candidateName = path.basename(entry.name, path.extname(entry.name));
        const resumeHash = await hashFile(filePath);
        const analysis = await loadResumeAnalysis(dir, candidateName, resumeHash);

        return {
          name: entry.name,
          candidateName,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          hash: resumeHash,
          path: filePath,
          url: `/api/resumes/file?path=${encodeURIComponent(filePath)}`,
          analysis
        };
      }));

    files.sort((left, right) => left.candidateName.localeCompare(right.candidateName, "zh-Hans-CN"));

    return res.json({
      dir,
      count: files.length,
      files
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      return res.json({ dir, count: 0, files: [] });
    }

    return res.status(500).json({
      error: "Unable to list resumes",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

async function loadResumeAnalysis(resumeDir, candidateName, resumeHash) {
  const cached = await getLatestAnalysis(resumeHash);
  if (cached) return cached;

  const analysisPath = path.join(resumeDir, "_analysis", `${candidateName}.json`);
  const text = await fs.readFile(analysisPath, "utf8").catch(() => "");

  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    const analysis = {
      ok: parsed.ok,
      status: parsed.status,
      analyzedAt: parsed.analyzedAt,
      path: analysisPath,
      data: parsed.response?.data ?? parsed.data ?? parsed.response,
      file: parsed.response?.file ?? parsed.file ?? null,
      raw: parsed
    };
    await saveAnalysisRecord({
      resumeHash,
      jobHash: "legacy",
      candidateName,
      fileName: `${candidateName}.pdf`,
      fileSize: null,
      fileType: "document",
      jobRequirements: "",
      responseData: analysis.data,
      fileData: analysis.file,
      source: "legacy-json",
      analyzedAt: analysis.analyzedAt
    }).catch(() => {});
    return analysis;
  } catch (error) {
    return {
      ok: false,
      path: analysisPath,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function cleanupMissingPdfAnalysis(resumeDir) {
  const entries = await fs.readdir(resumeDir, { withFileTypes: true });
  const hashes = new Set();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".pdf")) {
      continue;
    }

    const filePath = path.join(resumeDir, entry.name);
    const hash = await hashFile(filePath).catch(() => "");
    if (hash) {
      hashes.add(hash);
    }
  }

  if (hashes.size === 0) {
    await db.run("DELETE FROM resume_analysis");
    return;
  }

  const placeholders = [...hashes].map(() => "?").join(", ");
  const result = await db.run(
    `DELETE FROM resume_analysis WHERE resume_hash NOT IN (${placeholders})`,
    ...hashes
  );

  if (result.changes > 0) {
    console.log(`Removed ${result.changes} stale analysis records without matching PDF files.`);
  }
}

async function clearResumeAnalysisForDir(resumeDir) {
  const entries = await fs.readdir(resumeDir, { withFileTypes: true });
  const hashes = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".pdf")) {
      continue;
    }

    const filePath = path.join(resumeDir, entry.name);
    const hash = await hashFile(filePath).catch(() => "");
    if (hash) hashes.push(hash);
  }

  let deletedDatabaseRows = 0;
  if (hashes.length > 0) {
    const placeholders = hashes.map(() => "?").join(", ");
    const result = await db.run(
      `DELETE FROM resume_analysis WHERE resume_hash IN (${placeholders})`,
      ...hashes
    );
    deletedDatabaseRows = result.changes || 0;
  }

  const analysisDir = path.join(resumeDir, "_analysis");
  let deletedAnalysisFiles = 0;
  const legacyFiles = await fs.readdir(analysisDir, { withFileTypes: true }).catch(() => []);
  for (const entry of legacyFiles) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) {
      continue;
    }

    await fs.rm(path.join(analysisDir, entry.name), { force: true }).catch(() => {});
    deletedAnalysisFiles += 1;
  }

  return {
    dir: resumeDir,
    pdfCount: hashes.length,
    deletedDatabaseRows,
    deletedAnalysisFiles
  };
}

app.get("/api/resumes/file", (req, res) => {
  const filePath = resolveProjectPath(req.query.path || "");

  if (path.extname(filePath).toLowerCase() !== ".pdf") {
    return res.status(400).json({ error: "Only PDF files can be opened" });
  }

  return res.sendFile(filePath, (error) => {
    if (error && !res.headersSent) {
      res.status(error.statusCode || 404).json({
        error: "Unable to open resume",
        details: error.message
      });
    }
  });
});

app.post("/api/crawl-resumes", async (req, res) => {
  const {
    url,
    out,
    max,
    date_from,
    date_to,
    profile,
    wait_after_ask,
    skip_ask,
    ask_only,
    debug,
    keep_original,
    analyze = true,
    job_requirements
  } = req.body || {};

  if (analyze && !job_requirements?.trim()) {
    return res.status(400).json({ error: "job_requirements is required when analyze is enabled" });
  }

  if (!url?.trim()) {
    return res.status(400).json({ error: "url is required" });
  }

  await cleanupMissingPdfAnalysis(resolveProjectPath(out || "zhaopin-attachment-resumes")).catch((error) => {
    console.warn(`Unable to sync analysis database before crawling: ${error.message}`);
  });

  const scriptArgs = [path.join(__dirname, "scripts", "zhaopin-attachment-resumes.js"), "--auto"];

  appendArg(scriptArgs, "--url", url);
  appendArg(scriptArgs, "--out", out);
  appendArg(scriptArgs, "--max", max);
  appendArg(scriptArgs, "--profile", profile || ".\\.zhaopin-browser-profile-boss");
  appendArg(scriptArgs, "--date-from", date_from);
  appendArg(scriptArgs, "--date-to", date_to);
  appendArg(scriptArgs, "--wait-after-ask", wait_after_ask);
  appendFlag(scriptArgs, "--skip-ask", skip_ask);
  appendFlag(scriptArgs, "--ask-only", ask_only);
  appendFlag(scriptArgs, "--debug", debug);
  appendFlag(scriptArgs, "--keep-original", keep_original);

  if (analyze) {
    appendArg(scriptArgs, "--job-requirements", job_requirements);
  } else {
    scriptArgs.push("--no-analyze");
  }

  const job = startScriptJob("crawl-resumes", scriptArgs);
  return res.status(202).json(summarizeJob(job));
});

app.post("/api/crawl-message-resumes", async (req, res) => {
  const {
    url,
    out,
    max,
    job_name,
    job_number,
    profile,
    unread_only,
    wait_after_ask,
    skip_ask,
    debug,
    keep_original,
    analyze = true,
    job_requirements
  } = req.body || {};

  if (!url?.trim()) {
    return res.status(400).json({ error: "url is required" });
  }

  if (!job_name?.trim() && !job_number?.trim()) {
    return res.status(400).json({ error: "job_name or job_number is required" });
  }

  if (analyze && !job_requirements?.trim()) {
    return res.status(400).json({ error: "job_requirements is required when analyze is enabled" });
  }

  await cleanupMissingPdfAnalysis(resolveProjectPath(out || "zhaopin-attachment-resumes")).catch((error) => {
    console.warn(`Unable to sync analysis database before crawling message resumes: ${error.message}`);
  });

  const scriptArgs = [path.join(__dirname, "scripts", "zhaopin-attachment-resumes.js"), "--auto", "--max-downloads"];

  appendArg(scriptArgs, "--url", url);
  appendArg(scriptArgs, "--out", out);
  appendArg(scriptArgs, "--max", max);
  appendArg(scriptArgs, "--job-name", job_name);
  appendArg(scriptArgs, "--job-number", job_number);
  appendArg(scriptArgs, "--profile", profile || ".\\.zhaopin-browser-profile-boss");
  appendArg(scriptArgs, "--wait-after-ask", wait_after_ask);
  appendFlag(scriptArgs, "--unread-only", unread_only);
  appendFlag(scriptArgs, "--skip-ask", skip_ask);
  appendFlag(scriptArgs, "--debug", debug);
  appendFlag(scriptArgs, "--keep-original", keep_original);

  if (analyze) {
    appendArg(scriptArgs, "--job-requirements", job_requirements);
  } else {
    scriptArgs.push("--no-analyze");
  }

  const job = startScriptJob("crawl-message-resumes", scriptArgs);
  return res.status(202).json(summarizeJob(job));
});

app.post("/api/analyze-downloaded-resumes", async (req, res) => {
  const { dir, job_requirements } = req.body || {};

  if (!job_requirements?.trim()) {
    return res.status(400).json({ error: "job_requirements is required" });
  }

  await cleanupMissingPdfAnalysis(resolveProjectPath(dir || "zhaopin-attachment-resumes")).catch((error) => {
    console.warn(`Unable to sync analysis database before analyzing downloads: ${error.message}`);
  });

  const scriptArgs = [path.join(__dirname, "scripts", "analyze-downloaded-resumes.js")];
  appendArg(scriptArgs, "--dir", dir);
  appendArg(scriptArgs, "--job-requirements", job_requirements);

  const job = startScriptJob("analyze-downloaded-resumes", scriptArgs);
  return res.status(202).json(summarizeJob(job));
});

app.post("/api/resumes/clear-analysis", async (req, res) => {
  const { dir } = req.body || {};
  const resumeDir = resolveProjectPath(dir || "zhaopin-attachment-resumes");

  try {
    const result = await clearResumeAnalysisForDir(resumeDir);
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({
      error: "Unable to clear resume analysis",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/zhaopin-greetings", async (req, res) => {
  const {
    url,
    profile,
    message,
    max,
    delay,
    debug,
    dry_run
  } = req.body || {};

  if (!url?.trim()) {
    return res.status(400).json({ error: "url is required" });
  }

  const scriptArgs = [path.join(__dirname, "scripts", "zhaopin-auto-greeting.js"), "--auto"];
  const messageFile = await writeGreetingMessageFile(message || "你好，请问您现在还在看机会吗？");

  appendArg(scriptArgs, "--url", url);
  appendArg(scriptArgs, "--profile", profile || ".\\.zhaopin-browser-profile-boss");
  appendArg(scriptArgs, "--message-file", messageFile);
  appendArg(scriptArgs, "--max", max);
  appendArg(scriptArgs, "--delay", delay);
  appendFlag(scriptArgs, "--debug", debug);
  appendFlag(scriptArgs, "--dry-run", dry_run);

  const job = startScriptJob("zhaopin-greetings", scriptArgs);
  return res.status(202).json(summarizeJob(job));
});

app.get("/api/zhaopin-jobs", async (_req, res) => {
  const text = await fs.readFile(zhaopinJobsPath, "utf8").catch(() => "");

  if (!text) {
    return res.json({
      ok: true,
      source: "empty",
      count: 0,
      jobs: []
    });
  }

  try {
    const payload = JSON.parse(text);
    const items = Array.isArray(payload.jobs) ? payload.jobs : [];

    return res.json({
      ok: true,
      source: "zhaopin-jobs.json",
      syncedAt: payload.syncedAt || null,
      sourceUrl: payload.sourceUrl || "",
      count: items.length,
      jobs: items
    });
  } catch (error) {
    return res.status(500).json({
      error: "Unable to read synced Zhaopin jobs",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/zhaopin-sync-jobs", async (req, res) => {
  const {
    url,
    profile,
    debug
  } = req.body || {};

  if (!url?.trim()) {
    return res.status(400).json({ error: "url is required" });
  }

  const scriptArgs = [path.join(__dirname, "scripts", "zhaopin-sync-jobs.js"), "--auto"];

  appendArg(scriptArgs, "--url", url);
  appendArg(scriptArgs, "--profile", profile);
  appendArg(scriptArgs, "--out", zhaopinJobsPath);
  appendFlag(scriptArgs, "--debug", debug);

  const job = startScriptJob("zhaopin-sync-jobs", scriptArgs);
  return res.status(202).json(summarizeJob(job));
});

app.post("/api/zhaopin-applicant-messages", async (req, res) => {
  const {
    url,
    job_name,
    job_key,
    job_number,
    education_filter,
    school_location_filter,
    expected_city_filter,
    message,
    max,
    delay,
    profile,
    store,
    unviewed_only,
    debug,
    dry_run
  } = req.body || {};

  if (!url?.trim()) {
    return res.status(400).json({ error: "url is required" });
  }

  if (!message?.trim()) {
    return res.status(400).json({ error: "message is required" });
  }

  const allowedExpectedCityFilters = new Set(["all", "job_location", "non_job_location"]);
  if (expected_city_filter && !allowedExpectedCityFilters.has(expected_city_filter)) {
    return res.status(400).json({ error: "expected_city_filter is invalid" });
  }

  const allowedEducationFilters = new Set(["none", "bachelor", "master", "doctor"]);
  if (education_filter && !allowedEducationFilters.has(education_filter)) {
    return res.status(400).json({ error: "education_filter is invalid" });
  }

  const allowedSchoolLocationFilters = new Set(["none", "beijing", "non_beijing"]);
  if (school_location_filter && !allowedSchoolLocationFilters.has(school_location_filter)) {
    return res.status(400).json({ error: "school_location_filter is invalid" });
  }

  const scriptArgs = [path.join(__dirname, "scripts", "zhaopin-applicant-messages.js"), "--auto"];
  const messageFile = await writeGreetingMessageFile(message);

  appendArg(scriptArgs, "--url", url);
  appendArg(scriptArgs, "--job-name", job_name);
  appendArg(scriptArgs, "--job-key", job_key);
  appendArg(scriptArgs, "--job-number", job_number);
  appendArg(scriptArgs, "--education-filter", education_filter || "none");
  appendArg(scriptArgs, "--school-location-filter", school_location_filter || "none");
  appendArg(scriptArgs, "--expected-city-filter", expected_city_filter || "all");
  appendArg(scriptArgs, "--message-file", messageFile);
  appendArg(scriptArgs, "--max", max);
  appendArg(scriptArgs, "--delay", delay);
  appendArg(scriptArgs, "--profile", profile);
  appendArg(scriptArgs, "--store", store);
  appendFlag(scriptArgs, "--unviewed-only", unviewed_only);
  appendFlag(scriptArgs, "--debug", debug);
  appendFlag(scriptArgs, "--dry-run", dry_run);

  const job = startScriptJob("zhaopin-applicant-messages", scriptArgs);
  return res.status(202).json(summarizeJob(job));
});

app.post("/api/send-email", async (req, res) => {
  const { to, subject, text, html, attachments } = req.body || {};

  try {
    const result = await sendMail({
      to,
      subject,
      text,
      html,
      attachments: normalizeMailAttachments(attachments)
    });

    return res.json({
      ok: true,
      messageId: result.messageId,
      accepted: result.accepted,
      rejected: result.rejected
    });
  } catch (error) {
    return res.status(400).json({
      error: "Unable to send email",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  return res.json(summarizeJob(job));
});

app.post("/api/analyze-resume", upload.single("resume_file"), async (req, res) => {
  if (!modelApiKey) {
    return res.status(500).json({ error: "Backend missing MODEL_API_KEY, DASHSCOPE_API_KEY, DEEPSEEK_API_KEY, or OPENAI_API_KEY in .env" });
  }

  if (!modelBaseUrl || !modelName) {
    return res.status(500).json({ error: "Backend missing MODEL_BASE_URL or MODEL_NAME in .env" });
  }

  if (!req.file) {
    return res.status(400).json({ error: "resume_file is required" });
  }

  const jobRequirements = req.body?.job_requirements;
  const fileType = getFileType(req.file.originalname, req.body?.file_type);

  if (!jobRequirements?.trim()) {
    return res.status(400).json({ error: "job_requirements is required" });
  }

  try {
    const trimmedJobRequirements = jobRequirements.trim();
    const resumeHash = hashBuffer(req.file.buffer);
    const jobHash = hashText(`${trimmedJobRequirements}\n\nanalysis_engine=${getAnalysisEngineId()}`);
    const cached = await getCachedAnalysis(resumeHash, jobHash);

    if (cached) {
      return res.json({
        status: 200,
        data: cached.data,
        file: cached.file,
        cached: true
      });
    }

    const resumeText = await extractResumeText(req.file, fileType);
    if (resumeText.length < 80) {
      return res.status(422).json({
        error: "Unable to extract readable resume text",
        details: "The resume may be scanned/image-only, encrypted, or not a text PDF. Use a text-based PDF or add OCR before model analysis.",
        extractedLength: resumeText.length
      });
    }

    const locallyExtractedPhone = extractMobilePhone(resumeText);
    const file = {
      name: req.file.originalname,
      type: fileType,
      textLength: resumeText.length,
      model: modelName
    };
    const modelAnalysis = await analyzeResumeWithModel({
      resumeText,
      jobRequirements: trimmedJobRequirements,
      candidateName: path.basename(req.file.originalname, path.extname(req.file.originalname))
    });
    const data = mergeExtractedPhone(modelAnalysis, locallyExtractedPhone);

    await saveAnalysisRecord({
      resumeHash,
      jobHash,
      candidateName: path.basename(req.file.originalname, path.extname(req.file.originalname)),
      fileName: req.file.originalname,
      fileSize: req.file.size,
      fileType,
      jobRequirements: trimmedJobRequirements,
      responseData: data,
      fileData: file,
      source: "model",
      analyzedAt: new Date().toISOString()
    });

    return res.json({
      status: 200,
      data,
      file,
      cached: false
    });
  } catch (error) {
    return res.status(502).json({
      error: "Unable to analyze resume with model API",
      status: 502,
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/uploads/")) return next();

  res.sendFile(path.join(publicDir, "index.html"), (error) => {
    if (error) next(error);
  });
});

function appendArg(args, flag, value) {
  if (value === undefined || value === null || value === "") return;
  args.push(flag, String(value));
}

function normalizeMailAttachments(attachments) {
  if (!attachments) return undefined;
  const items = Array.isArray(attachments) ? attachments : [attachments];

  return items
    .map((item) => {
      if (typeof item === "string") {
        const filePath = resolveProjectPath(item);
        return {
          filename: path.basename(filePath),
          path: filePath
        };
      }

      if (item?.path) {
        const filePath = resolveProjectPath(item.path);
        return {
          filename: item.filename || path.basename(filePath),
          path: filePath
        };
      }

      return null;
    })
    .filter(Boolean);
}

async function writeGreetingMessageFile(message) {
  await fs.mkdir(greetingMessageDir, { recursive: true });
  const filePath = path.join(greetingMessageDir, `${crypto.randomUUID()}.txt`);
  await fs.writeFile(filePath, String(message), "utf8");
  return filePath;
}

function resolveProjectPath(input) {
  const rawPath = String(input || "").trim();
  if (!rawPath) return path.join(__dirname, "zhaopin-attachment-resumes");

  return path.isAbsolute(rawPath) ? rawPath : path.resolve(__dirname, rawPath);
}

function appendFlag(args, flag, enabled) {
  if (enabled) args.push(flag);
}

function startScriptJob(type, scriptArgs) {
  const id = crypto.randomUUID();
  const job = {
    id,
    type,
    status: "running",
    exitCode: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    logs: [],
    results: []
  };

  jobs.set(id, job);
  pushJobLog(job, `Started ${type}`);

  const child = spawn(process.execPath, scriptArgs, {
    cwd: __dirname,
    env: process.env,
    windowsHide: true
  });

  child.stdout.on("data", (chunk) => pushJobLog(job, chunk.toString()));
  child.stderr.on("data", (chunk) => pushJobLog(job, chunk.toString()));
  child.on("error", (error) => {
    job.status = "failed";
    job.finishedAt = new Date().toISOString();
    pushJobLog(job, error.message);
  });
  child.on("close", (code) => {
    job.exitCode = code;
    job.status = code === 0 ? "completed" : "failed";
    job.finishedAt = new Date().toISOString();
    pushJobLog(job, `${type} exited with code ${code}`);
  });

  return job;
}

function pushJobLog(job, text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);

  for (const line of lines) {
    if (line.startsWith("__WORKFLOW_RESULT__ ")) {
      try {
        job.results.push(JSON.parse(line.slice("__WORKFLOW_RESULT__ ".length)));
      } catch {
        job.logs.push(line);
      }
      continue;
    }

    job.logs.push(line);
  }

  if (job.logs.length > 600) {
    job.logs.splice(0, job.logs.length - 600);
  }
  if (job.results.length > 200) {
    job.results.splice(0, job.results.length - 200);
  }
}

function summarizeJob(job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    exitCode: job.exitCode,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    logs: job.logs,
    results: job.results,
    latestResult: job.results.at(-1) || null
  };
}

async function initDatabase() {
  const database = await open({
    filename: databasePath,
    driver: sqlite3.Database
  });

  await database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS resume_analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resume_hash TEXT NOT NULL,
      job_hash TEXT NOT NULL,
      candidate_name TEXT,
      file_name TEXT,
      file_size INTEGER,
      file_type TEXT,
      job_requirements TEXT,
      response_json TEXT NOT NULL,
      file_json TEXT,
      source TEXT NOT NULL DEFAULT 'workflow',
      analyzed_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(resume_hash, job_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_resume_analysis_resume_hash ON resume_analysis(resume_hash);
    CREATE INDEX IF NOT EXISTS idx_resume_analysis_updated_at ON resume_analysis(updated_at);
  `);

  return database;
}

async function getCachedAnalysis(resumeHash, jobHash) {
  const row = await db.get(
    "SELECT * FROM resume_analysis WHERE resume_hash = ? AND job_hash = ?",
    resumeHash,
    jobHash
  );

  return row ? formatAnalysisRow(row) : null;
}

async function getLatestAnalysis(resumeHash) {
  const row = await db.get(
    "SELECT * FROM resume_analysis WHERE resume_hash = ? ORDER BY updated_at DESC, id DESC LIMIT 1",
    resumeHash
  );

  return row ? formatAnalysisRow(row) : null;
}

async function saveAnalysisRecord({
  resumeHash,
  jobHash,
  candidateName,
  fileName,
  fileSize,
  fileType,
  jobRequirements,
  responseData,
  fileData,
  source,
  analyzedAt
}) {
  await db.run(
    `
      INSERT INTO resume_analysis (
        resume_hash,
        job_hash,
        candidate_name,
        file_name,
        file_size,
        file_type,
        job_requirements,
        response_json,
        file_json,
        source,
        analyzed_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(resume_hash, job_hash) DO UPDATE SET
        candidate_name = excluded.candidate_name,
        file_name = excluded.file_name,
        file_size = excluded.file_size,
        file_type = excluded.file_type,
        job_requirements = excluded.job_requirements,
        response_json = excluded.response_json,
        file_json = excluded.file_json,
        source = excluded.source,
        analyzed_at = excluded.analyzed_at,
        updated_at = CURRENT_TIMESTAMP
    `,
    resumeHash,
    jobHash,
    candidateName,
    fileName,
    fileSize ?? null,
    fileType,
    jobRequirements,
    JSON.stringify(responseData),
    fileData ? JSON.stringify(fileData) : null,
    source || "workflow",
    analyzedAt || new Date().toISOString()
  );
}

function formatAnalysisRow(row) {
  return {
    ok: true,
    status: 200,
    analyzedAt: row.analyzed_at,
    source: row.source,
    cached: true,
    data: parseJsonValue(row.response_json),
    file: row.file_json ? parseJsonValue(row.file_json) : null,
    db: {
      id: row.id,
      resumeHash: row.resume_hash,
      jobHash: row.job_hash
    }
  };
}

function parseJsonValue(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function hashFile(filePath) {
  return hashBuffer(await fs.readFile(filePath));
}

function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function hashText(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

async function buildWorkflowFileInput(req, file, fileType) {
  if (fileMode === "coze_upload") {
    if (!fileUploadToken) {
      throw new Error("COZE_FILE_UPLOAD_TOKEN is required when COZE_FILE_MODE=coze_upload");
    }

    const uploadedFile = await uploadFileToCoze(file);
    const fileId = uploadedFile?.data?.id || uploadedFile?.data?.file_id || uploadedFile?.id || uploadedFile?.file_id;

    if (!fileId) {
      throw new Error(`Coze file upload did not return a file_id: ${JSON.stringify(uploadedFile)}`);
    }

    return {
      file_id: fileId,
      file_type: fileType
    };
  }

  const baseUrl = publicBaseUrl || getRequestBaseUrl(req);

  return {
    url: await saveFileAndCreateUrl(file, baseUrl),
    file_type: fileType
  };
}

async function uploadFileToCoze(file) {
  const formData = new FormData();
  const blob = new Blob([file.buffer], { type: file.mimetype || "application/octet-stream" });

  formData.append("file", blob, file.originalname);

  const response = await fetch(fileUploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${fileUploadToken}`
    },
    body: formData
  });

  const text = await response.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new CozeRequestError("Coze file upload failed", response.status, data);
  }

  return data;
}

async function saveFileAndCreateUrl(file, baseUrl) {
  await fs.mkdir(uploadsDir, { recursive: true });

  const extension = path.extname(file.originalname).toLowerCase();
  const fileName = `${Date.now()}-${crypto.randomUUID()}${extension}`;
  const filePath = path.join(uploadsDir, fileName);

  await fs.writeFile(filePath, file.buffer);

  return `${baseUrl.replace(/\/$/, "")}/uploads/${fileName}`;
}

function getRequestBaseUrl(req) {
  const forwardedProto = req.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = req.get("x-forwarded-host")?.split(",")[0]?.trim();
  const protocol = forwardedProto || req.protocol;
  const host = forwardedHost || req.get("host");

  if (!host) {
    throw new Error("Unable to infer public file URL from request host");
  }

  return `${protocol}://${host}`;
}

class CozeRequestError extends Error {
  constructor(message, status, details) {
    super(`${message} (${status}): ${JSON.stringify(details)}`);
    this.name = "CozeRequestError";
    this.status = status;
    this.details = details;
  }
}

function getFileType(fileName, fallback) {
  const rawType = fallback?.trim().replace(/^\./, "").toLowerCase() || fileName.split(".").pop()?.toLowerCase();

  if (["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(rawType)) return "image";
  if (["mp4", "mov", "avi", "mkv", "webm"].includes(rawType)) return "video";
  if (["mp3", "wav", "m4a", "aac", "flac"].includes(rawType)) return "audio";
  if (["pdf", "doc", "docx", "txt", "md", "rtf"].includes(rawType)) return "document";

  return "default";
}

function getAnalysisEngineId() {
  return [
    "model-api",
    "local-phone-v1",
    modelBaseUrl.replace(/\/+$/, ""),
    modelName
  ].filter(Boolean).join("|");
}

async function extractResumeText(file, fileType) {
  const type = fileType || getFileType(file.originalname);
  if (["txt", "md", "rtf"].includes(path.extname(file.originalname).replace(/^\./, "").toLowerCase())) {
    return normalizeExtractedText(file.buffer.toString("utf8"));
  }

  if (type !== "document" || path.extname(file.originalname).toLowerCase() !== ".pdf") {
    throw new Error(`Unsupported resume file type for model analysis: ${file.originalname}`);
  }

  let pdfParse;
  try {
    const imported = await import("pdf-parse");
    pdfParse = imported.default || imported;
  } catch {
    throw new Error("Missing dependency pdf-parse. Run npm install in the Python directory before analyzing PDFs.");
  }

  const parsed = await pdfParse(file.buffer);
  return normalizeExtractedText(parsed?.text || "");
}

function normalizeExtractedText(text) {
  return String(text || "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function extractMobilePhone(text) {
  const source = String(text || "").replace(/\u00a0/g, " ");
  const separator = "[\\t ‐‑‒–—-]?";
  const patterns = [
    new RegExp(`(?<!\\d)(?:\\+?86${separator})?(1[3-9](?:${separator}\\d){9})(?!\\d)`, "g"),
    new RegExp(`(?<!\\d)(?:\\+?86${separator})?(1[3-9]\\d${separator}[*＊xX×·•]{4}${separator}\\d{4})(?!\\d)`, "g")
  ];
  const candidates = [];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const phone = normalizeMobilePhone(match[1]);
      if (!phone || candidates.some((candidate) => candidate.phone === phone)) continue;

      const start = Math.max(0, match.index - 24);
      const end = Math.min(source.length, match.index + match[0].length + 24);
      const context = source.slice(start, end);
      candidates.push({
        phone,
        index: match.index,
        labelled: /手机|手机号|联系电话|联系方式|电话|phone|mobile|tel/i.test(context)
      });
    }
  }

  candidates.sort((left, right) => Number(right.labelled) - Number(left.labelled) || left.index - right.index);
  return candidates[0]?.phone || "";
}

function normalizeMobilePhone(value) {
  const compact = String(value || "")
    .replace(/[\t ‐‑‒–—-]/g, "")
    .replace(/[＊xX×·•]/g, "*");

  return /^1[3-9](?:\d{9}|\d\*{4}\d{4})$/.test(compact) ? compact : "";
}

function mergeExtractedPhone(analysis, locallyExtractedPhone) {
  const modelPhone = normalizeMobilePhone(analysis?.resume_info?.contact?.phone);
  const phone = locallyExtractedPhone || modelPhone || String(analysis?.resume_info?.contact?.phone || "").trim();

  return {
    ...analysis,
    resume_info: {
      ...analysis.resume_info,
      contact: {
        ...analysis.resume_info.contact,
        phone
      }
    }
  };
}

async function analyzeResumeWithModel({ resumeText, jobRequirements, candidateName }) {
  const response = await fetch(buildChatCompletionsUrl(modelBaseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${modelApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(buildModelRequest({ resumeText, jobRequirements, candidateName }))
  });

  const text = await response.text();
  const payload = parseJsonValue(text);

  if (!response.ok) {
    throw new Error(`Model API request failed (${response.status}): ${typeof payload === "string" ? payload : JSON.stringify(payload)}`);
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`Model API response did not contain choices[0].message.content: ${JSON.stringify(payload)}`);
  }

  return normalizeModelAnalysis(parseModelJson(content));
}

function buildChatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl || "").replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(trimmed)) {
    return trimmed;
  }

  return `${trimmed}/chat/completions`;
}

function buildModelRequest({ resumeText, jobRequirements, candidateName }) {
  const request = {
    model: modelName,
    temperature: Number.isFinite(modelTemperature) ? modelTemperature : 0.2,
    messages: [
      {
        role: "system",
        content: [
          "你是严谨的招聘简历分析助手。",
          "你必须只输出一个合法 JSON 对象，不要输出 Markdown、解释文字或代码块。",
          "如果简历中没有明确出现的信息，填空字符串、空数组或说明未知，不要编造。",
          "match_score 使用 0-100 整数，越匹配分数越高。"
        ].join("\n")
      },
      {
        role: "user",
        content: [
          "请根据岗位要求分析候选人简历，并严格返回下面 JSON 结构：",
          JSON.stringify(getAnalysisJsonSchema(), null, 2),
          "",
          `候选人文件名：${candidateName || ""}`,
          "",
          "【岗位要求】",
          jobRequirements,
          "",
          "【简历文本】",
          truncateForModel(resumeText)
        ].join("\n")
      }
    ]
  };

  if (process.env.MODEL_JSON_RESPONSE !== "false") {
    request.response_format = { type: "json_object" };
  }

  return request;
}

function getAnalysisJsonSchema() {
  return {
    resume_info: {
      name: "",
      gender: "",
      age: "",
      contact: {
        phone: "",
        email: "",
        location: ""
      },
      education: [
        {
          school: "",
          degree: "",
          major: "",
          time: ""
        }
      ],
      work_experience: [
        {
          company: "",
          position: "",
          time: "",
          responsibilities: ""
        }
      ],
      skills: [],
      certifications: [],
      summary: ""
    },
    match_score: 0,
    match_details: {
      overall_evaluation: "",
      strengths: [],
      weaknesses: [],
      gender_match: {
        score: 0,
        comment: ""
      },
      age_match: {
        score: 0,
        comment: ""
      },
      education_match: {
        score: 0,
        comment: ""
      },
      experience_match: {
        score: 0,
        comment: ""
      },
      skills_match: {
        score: 0,
        matched_skills: [],
        missing_skills: [],
        comment: ""
      },
      recommendation: ""
    }
  };
}

function truncateForModel(text) {
  const maxLength = Number.parseInt(process.env.MODEL_RESUME_TEXT_MAX_CHARS || "50000", 10);
  if (!Number.isFinite(maxLength) || maxLength <= 0 || text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n\n[简历文本过长，已截断至 ${maxLength} 字符]`;
}

function parseModelJson(content) {
  const raw = String(content || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = fenced ? fenced[1].trim() : raw;

  try {
    return JSON.parse(jsonText);
  } catch {
    const start = jsonText.indexOf("{");
    const end = jsonText.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(jsonText.slice(start, end + 1));
    }
    throw new Error(`Model did not return valid JSON: ${raw.slice(0, 800)}`);
  }
}

function normalizeModelAnalysis(value) {
  const data = value?.data && typeof value.data === "object" ? value.data : value;
  const schema = getAnalysisJsonSchema();
  const resumeInfo = data?.resume_info && typeof data.resume_info === "object" ? data.resume_info : {};
  const details = data?.match_details && typeof data.match_details === "object" ? data.match_details : {};

  return {
    resume_info: {
      ...schema.resume_info,
      ...resumeInfo,
      contact: {
        ...schema.resume_info.contact,
        ...(resumeInfo.contact && typeof resumeInfo.contact === "object" ? resumeInfo.contact : {})
      },
      education: Array.isArray(resumeInfo.education) ? resumeInfo.education : [],
      work_experience: Array.isArray(resumeInfo.work_experience) ? resumeInfo.work_experience : [],
      skills: Array.isArray(resumeInfo.skills) ? resumeInfo.skills : [],
      certifications: Array.isArray(resumeInfo.certifications) ? resumeInfo.certifications : []
    },
    match_score: clampScore(data?.match_score ?? details?.match_score),
    match_details: {
      ...schema.match_details,
      ...details,
      strengths: Array.isArray(details.strengths) ? details.strengths : [],
      weaknesses: Array.isArray(details.weaknesses) ? details.weaknesses : [],
      gender_match: normalizeScoreComment(details.gender_match),
      age_match: normalizeScoreComment(details.age_match),
      education_match: normalizeScoreComment(details.education_match),
      experience_match: normalizeScoreComment(details.experience_match),
      skills_match: {
        ...schema.match_details.skills_match,
        ...(details.skills_match && typeof details.skills_match === "object" ? details.skills_match : {}),
        score: clampScore(details.skills_match?.score),
        matched_skills: Array.isArray(details.skills_match?.matched_skills) ? details.skills_match.matched_skills : [],
        missing_skills: Array.isArray(details.skills_match?.missing_skills) ? details.skills_match.missing_skills : []
      }
    }
  };
}

function normalizeScoreComment(value) {
  if (!value || typeof value !== "object") {
    return { score: 0, comment: "" };
  }

  return {
    score: clampScore(value.score),
    comment: String(value.comment || "")
  };
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});
