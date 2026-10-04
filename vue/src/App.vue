<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

const DEFAULT_ZHAOPIN_URL = "https://rd6.zhaopin.com/app/im?sessionId=af639ab8eb8b7f9d81352e30f5e025df";
const DEFAULT_ZHAOPIN_RECOMMEND_URL = "https://rd6.zhaopin.com/app/recommend?jobNumber=CC133033330J40860627809&tab=recommend#sortType=recommend";
const DEFAULT_ZHAOPIN_CANDIDATE_URL = "https://rd6.zhaopin.com/app/candidate?jobNumber=-1&jobTitle=%E4%B8%8D%E9%99%90";
const DEFAULT_APPLICANT_MESSAGE = "您好，感谢您投递我们公司的岗位，方便进一步沟通吗？";
const APPLICANT_JOBS = [
  {
    key: "culture-consultant",
    name: "企业文化咨询顾问",
    applicantUrl: "",
    message: DEFAULT_APPLICANT_MESSAGE
  },
  {
    key: "job-2",
    name: "岗位二（待配置）",
    applicantUrl: "",
    message: DEFAULT_APPLICANT_MESSAGE
  },
  {
    key: "job-3",
    name: "岗位三（待配置）",
    applicantUrl: "",
    message: DEFAULT_APPLICANT_MESSAGE
  }
];

const jobRequirements = ref(`一、主要职责：
1、协助和参与公司企业文化管理咨询、组织转型变革咨询等相关工作；
2、协助公司相关人员或团队收集、整理行研资料及项目建议书撰写所需的基础资料；
3、协助咨询团队做好项目问卷数据分析等基础工作，参与调研诊断报告的内容梳理及撰写，参与文化的研讨、方案文案的讨论及部分内容撰写等；
4、协助项目团队跟进项目进展，与客户沟通并建立良好的合作关系；
5、参与公司相关会议和讨论，提供自己的想法和建议。
6、此岗位只招聘211/985硕士应届生

二、职位要求：
1、对写作创作有浓厚的兴趣和热情，拥有较好的文字功底和写作能力；
2、对经营管理基本知识有较好的理解，了解和熟悉文化咨询、企业管理咨询、人力资源咨询、战略咨询等相关领域的基本情况；
3、具备良好的沟通能力，能够与包括企业中高层在内的不同层级人员进行有效沟通；
4、责任心强、善于协作，具备良好的职业素养和团队合作精神；
5、能够接受持续出差，根据项目需要随时前往客户现场提供服务。`);
const crawlUrl = ref(DEFAULT_ZHAOPIN_URL);
const crawlOut = ref(".\\zhaopin-attachment-resumes");
const crawlMax = ref("");
const crawlDateFrom = ref("");
const crawlDateTo = ref("");
const waitAfterAsk = ref(8000);
const skipAsk = ref(false);
const askOnly = ref(false);
const debug = ref(false);
const keepOriginal = ref(false);
const analyzeAfterDownload = ref(true);
const messageResumeUrl = ref(DEFAULT_ZHAOPIN_URL);
const messageResumeJobKey = ref(APPLICANT_JOBS[0]?.key || "");
const messageResumeUnreadOnly = ref(false);
const messageResumeMax = ref("");
const messageResumeOut = ref(".\\zhaopin-attachment-resumes");
const messageResumeAnalyze = ref(true);
const messageResumeSkipAsk = ref(false);
const messageResumeDebug = ref(false);
const greetingUrl = ref(DEFAULT_ZHAOPIN_RECOMMEND_URL);
const greetingMessage = ref("你好，请问您现在还在看机会吗？");
const greetingMax = ref("");
const greetingDelay = ref(1200);
const greetingDebug = ref(false);
const greetingDryRun = ref(false);
const applicantJobKey = ref(APPLICANT_JOBS[0]?.key || "");
const applicantJobName = ref(APPLICANT_JOBS[0]?.name || "");
const applicantUrl = ref(APPLICANT_JOBS[0]?.applicantUrl || "");
const applicantMessage = ref(APPLICANT_JOBS[0]?.message || DEFAULT_APPLICANT_MESSAGE);
const applicantEducationFilter = ref("master");
const applicantSchoolLocationFilter = ref("none");
const applicantExpectedCityFilter = ref("all");
const applicantMax = ref("");
const applicantDelay = ref(1200);
const applicantProfile = ref(".\\.zhaopin-browser-profile-boss");
const applicantStore = ref(".\\zhaopin-job-message-candidates.json");
const applicantUnviewedOnly = ref(true);
const applicantDebug = ref(false);
const applicantDryRun = ref(false);
const applicantJobs = ref([...APPLICANT_JOBS]);
const syncJobsUrl = ref("https://rd6.zhaopin.com/app/job");
const syncJobsLoading = ref(false);
const syncJobsStatus = ref("");

const crawlJob = ref(null);
const crawlError = ref("");
const crawlLoading = ref(false);
const messageResumeLoading = ref(false);
const greetingLoading = ref(false);
const applicantLoading = ref(false);
const analyzeExistingLoading = ref(false);
const clearAnalysisLoading = ref(false);
const existingResumes = ref([]);
const existingResumeError = ref("");
const existingResumeLoading = ref(false);
const expandedAnalysis = ref({});
const resumeEmailTo = ref("");
const batchEmailCount = ref("");
const sendingResumePath = ref("");
const batchEmailLoading = ref(false);
const resumeEmailStatus = ref("");
const lastResultCount = ref(0);
let pollTimer = null;

const canStartCrawl = computed(() => crawlUrl.value.trim() && !crawlLoading.value);
const canStartMessageResumeCrawl = computed(() => {
  return messageResumeUrl.value.trim()
    && messageResumeJobKey.value
    && (!messageResumeAnalyze.value || jobRequirements.value.trim())
    && !messageResumeLoading.value;
});
const canStartGreeting = computed(() => {
  return greetingUrl.value.trim() && greetingMessage.value.trim() && !greetingLoading.value;
});
const canStartApplicantMessages = computed(() => {
  return applicantJobKey.value && applicantUrl.value.trim() && applicantMessage.value.trim() && !applicantLoading.value;
});
const canSyncZhaopinJobs = computed(() => {
  return syncJobsUrl.value.trim() && !syncJobsLoading.value;
});
const canAnalyzeExisting = computed(() => {
  return crawlOut.value.trim() && jobRequirements.value.trim() && !analyzeExistingLoading.value;
});
const willAnalyzeAfterDownload = computed(() => analyzeAfterDownload.value && jobRequirements.value.trim());
const existingResumeCount = computed(() => existingResumes.value.length);
const analyzedResumeCount = computed(() => existingResumes.value.filter((resume) => resume.analysis?.data).length);
const sortedResumes = computed(() => {
  return [...existingResumes.value].sort((left, right) => {
    const scoreDiff = score(right) - score(left);
    if (scoreDiff !== 0) return scoreDiff;
    return left.candidateName.localeCompare(right.candidateName, "zh-Hans-CN");
  });
});
const crawlLogs = computed(() => crawlJob.value?.logs || []);
const workflowResultCount = computed(() => crawlJob.value?.results?.length || 0);
const analysisProgressText = computed(() => {
  const total = existingResumeCount.value;
  const runningAnalyzeJob = crawlJob.value?.status === "running" && crawlJob.value?.type === "analyze-downloaded-resumes";
  const current = runningAnalyzeJob ? Math.min(workflowResultCount.value, total) : analyzedResumeCount.value;

  return `分析进度：${current}/${total}`;
});
const crawlStatus = computed(() => {
  const status = crawlJob.value?.status;
  if (status === "running") return "运行中";
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  return "未启动";
});

async function startCrawl() {
  if (!canStartCrawl.value) return;

  crawlLoading.value = true;
  crawlError.value = "";
  crawlJob.value = null;
  lastResultCount.value = 0;

  try {
    const response = await fetch("/api/crawl-resumes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: crawlUrl.value,
        out: crawlOut.value,
        max: crawlMax.value ? Number(crawlMax.value) : undefined,
        profile: applicantProfile.value || undefined,
        date_from: crawlDateFrom.value || undefined,
        date_to: crawlDateTo.value || undefined,
        wait_after_ask: Number(waitAfterAsk.value) || 8000,
        skip_ask: skipAsk.value,
        ask_only: askOnly.value,
        debug: debug.value,
        keep_original: keepOriginal.value,
        analyze: Boolean(willAnalyzeAfterDownload.value),
        job_requirements: jobRequirements.value
      })
    });
    const data = await readJsonResponse(response);

    if (!response.ok) throw new Error(formatError(data));

    crawlJob.value = data;
    startPollingJob(data.id);
  } catch (requestError) {
    crawlError.value = requestError instanceof Error ? requestError.message : String(requestError);
  } finally {
    crawlLoading.value = false;
  }
}

async function startMessageResumeCrawl() {
  if (!canStartMessageResumeCrawl.value) return;

  const job = selectedMessageResumeJob();
  if (!job) return;

  messageResumeLoading.value = true;
  crawlError.value = "";
  crawlJob.value = null;
  lastResultCount.value = 0;
  crawlOut.value = messageResumeOut.value;

  try {
    const response = await fetch("/api/crawl-message-resumes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: messageResumeUrl.value,
        out: messageResumeOut.value,
        max: messageResumeMax.value ? Number(messageResumeMax.value) : undefined,
        job_name: job.name,
        job_number: job.jobNumber || undefined,
        profile: applicantProfile.value || undefined,
        unread_only: messageResumeUnreadOnly.value,
        wait_after_ask: Number(waitAfterAsk.value) || 8000,
        skip_ask: messageResumeSkipAsk.value,
        debug: messageResumeDebug.value,
        analyze: Boolean(messageResumeAnalyze.value),
        job_requirements: jobRequirements.value
      })
    });
    const data = await readJsonResponse(response);

    if (!response.ok) throw new Error(formatError(data));

    crawlJob.value = data;
    startPollingJob(data.id);
  } catch (requestError) {
    crawlError.value = requestError instanceof Error ? requestError.message : String(requestError);
  } finally {
    messageResumeLoading.value = false;
  }
}

async function analyzeExistingDownloads() {
  if (!canAnalyzeExisting.value) return;

  analyzeExistingLoading.value = true;
  crawlError.value = "";
  crawlJob.value = null;
  lastResultCount.value = 0;

  try {
    const response = await fetch("/api/analyze-downloaded-resumes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dir: crawlOut.value,
        job_requirements: jobRequirements.value
      })
    });
    const data = await readJsonResponse(response);

    if (!response.ok) throw new Error(formatError(data));

    crawlJob.value = data;
    startPollingJob(data.id);
  } catch (requestError) {
    crawlError.value = requestError instanceof Error ? requestError.message : String(requestError);
  } finally {
    analyzeExistingLoading.value = false;
  }
}

async function startGreeting() {
  if (!canStartGreeting.value) return;

  greetingLoading.value = true;
  crawlError.value = "";
  crawlJob.value = null;
  lastResultCount.value = 0;

  try {
    const response = await fetch("/api/zhaopin-greetings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: greetingUrl.value,
        profile: applicantProfile.value || undefined,
        message: greetingMessage.value,
        max: greetingMax.value ? Number(greetingMax.value) : undefined,
        delay: Number(greetingDelay.value) || 1200,
        debug: greetingDebug.value,
        dry_run: greetingDryRun.value
      })
    });
    const data = await readJsonResponse(response);

    if (!response.ok) throw new Error(formatError(data));

    crawlJob.value = data;
    startPollingJob(data.id);
  } catch (requestError) {
    crawlError.value = requestError instanceof Error ? requestError.message : String(requestError);
  } finally {
    greetingLoading.value = false;
  }
}

async function startApplicantMessages() {
  if (!canStartApplicantMessages.value) return;

  applicantLoading.value = true;
  crawlError.value = "";
  crawlJob.value = null;
  lastResultCount.value = 0;

  try {
    const response = await fetch("/api/zhaopin-applicant-messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: applicantUrl.value,
        job_name: applicantJobName.value || undefined,
        job_key: applicantJobKey.value || undefined,
        job_number: selectedApplicantJob()?.jobNumber || undefined,
        education_filter: applicantEducationFilter.value,
        school_location_filter: applicantSchoolLocationFilter.value,
        expected_city_filter: applicantExpectedCityFilter.value,
        message: applicantMessage.value,
        max: applicantMax.value ? Number(applicantMax.value) : undefined,
        delay: Number(applicantDelay.value) || 1200,
        profile: applicantProfile.value || undefined,
        store: applicantStore.value || undefined,
        unviewed_only: applicantUnviewedOnly.value,
        debug: applicantDebug.value,
        dry_run: applicantDryRun.value
      })
    });
    const data = await readJsonResponse(response);

    if (!response.ok) throw new Error(formatError(data));

    crawlJob.value = data;
    startPollingJob(data.id);
  } catch (requestError) {
    crawlError.value = requestError instanceof Error ? requestError.message : String(requestError);
  } finally {
    applicantLoading.value = false;
  }
}

async function fetchZhaopinJobs() {
  try {
    const response = await fetch("/api/zhaopin-jobs");
    const data = await readJsonResponse(response);

    if (!response.ok) throw new Error(formatError(data));

    const jobs = normalizeApplicantJobs(data.jobs || []);
    const syncError = data.error || (!jobs.length && data.syncedAt ? "No jobs were synced." : "");
    applicantJobs.value = jobs.length ? jobs : [...APPLICANT_JOBS];

    if (!applicantJobs.value.some((job) => job.key === applicantJobKey.value)) {
      applicantJobKey.value = applicantJobs.value[0]?.key || "";
      applyApplicantJob();
    }

    if (!applicantJobs.value.some((job) => job.key === messageResumeJobKey.value)) {
      messageResumeJobKey.value = applicantJobs.value[0]?.key || "";
    }

    if (syncError) {
      syncJobsStatus.value = syncError;
    } else if (data.syncedAt) {
      syncJobsStatus.value = `上次同步：${formatDate(data.syncedAt)}，共 ${data.count || 0} 个岗位`;
    }
  } catch (requestError) {
    syncJobsStatus.value = requestError instanceof Error ? requestError.message : String(requestError);
  }
}

async function syncZhaopinJobs() {
  if (!canSyncZhaopinJobs.value) return;

  syncJobsLoading.value = true;
  syncJobsStatus.value = "";
  crawlError.value = "";
  crawlJob.value = null;
  lastResultCount.value = 0;

  try {
    const response = await fetch("/api/zhaopin-sync-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: syncJobsUrl.value,
        profile: applicantProfile.value || undefined,
        debug: applicantDebug.value
      })
    });
    const data = await readJsonResponse(response);

    if (!response.ok) throw new Error(formatError(data));

    crawlJob.value = data;
    syncJobsStatus.value = "正在同步岗位，请查看下方任务日志。";
    startPollingJob(data.id);
  } catch (requestError) {
    syncJobsStatus.value = requestError instanceof Error ? requestError.message : String(requestError);
  } finally {
    syncJobsLoading.value = false;
  }
}

function applyApplicantJob() {
  const job = applicantJobs.value.find((item) => item.key === applicantJobKey.value);
  if (!job) return;

  applicantJobName.value = job.name;
  applicantUrl.value = buildAllCandidateUrl(job.applicantUrl || DEFAULT_ZHAOPIN_CANDIDATE_URL);
  applicantMessage.value = job.message || DEFAULT_APPLICANT_MESSAGE;
}

function selectedApplicantJob() {
  return applicantJobs.value.find((item) => item.key === applicantJobKey.value) || null;
}

function selectedMessageResumeJob() {
  return applicantJobs.value.find((item) => item.key === messageResumeJobKey.value) || null;
}

function normalizeApplicantJobs(items) {
  return items
    .map((item) => ({
      key: item.key || item.jobNumber || item.name,
      name: item.name || item.jobTitle || item.key || "未命名岗位",
      jobNumber: item.jobNumber || item.key || "",
      applicantUrl: buildAllCandidateUrl(item.applicantUrl || DEFAULT_ZHAOPIN_CANDIDATE_URL),
      recommendUrl: item.recommendUrl || "",
      message: item.message || DEFAULT_APPLICANT_MESSAGE
    }))
    .filter((item) => item.key && item.name && item.applicantUrl);
}

function buildAllCandidateUrl(inputUrl) {
  try {
    const url = new URL(inputUrl || DEFAULT_ZHAOPIN_CANDIDATE_URL);
    url.pathname = "/app/candidate";
    url.searchParams.set("jobNumber", "-1");
    url.searchParams.set("jobTitle", "不限");
    return url.href;
  } catch {
    return DEFAULT_ZHAOPIN_CANDIDATE_URL;
  }
}

function startPollingJob(jobId) {
  stopPollingJob();
  pollTimer = window.setInterval(async () => {
    try {
      const response = await fetch(`/api/jobs/${jobId}`);
      const data = await readJsonResponse(response);
      if (!response.ok) throw new Error(formatError(data));

      crawlJob.value = data;
      if ((data.results?.length || 0) !== lastResultCount.value) {
        lastResultCount.value = data.results?.length || 0;
        if (isResumeJob(data)) fetchExistingResumes();
        if (isSyncJobsJob(data)) fetchZhaopinJobs();
      }

      if (data.status !== "running") {
        stopPollingJob();
        if (isResumeJob(data)) fetchExistingResumes();
        if (isSyncJobsJob(data)) fetchZhaopinJobs();
      }
    } catch (requestError) {
      crawlError.value = requestError instanceof Error ? requestError.message : String(requestError);
      stopPollingJob();
    }
  }, 1500);
}

function stopPollingJob() {
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function isResumeJob(job) {
  return ["crawl-resumes", "crawl-message-resumes", "analyze-downloaded-resumes"].includes(job?.type);
}

function isSyncJobsJob(job) {
  return job?.type === "zhaopin-sync-jobs";
}

async function fetchExistingResumes() {
  existingResumeLoading.value = true;
  existingResumeError.value = "";

  try {
    const params = new URLSearchParams();
    if (crawlOut.value.trim()) {
      params.set("dir", crawlOut.value.trim());
    }

    const response = await fetch(`/api/resumes?${params.toString()}`);
    const data = await readJsonResponse(response);

    if (!response.ok) throw new Error(formatError(data));

    existingResumes.value = data.files || [];
  } catch (requestError) {
    existingResumeError.value = requestError instanceof Error ? requestError.message : String(requestError);
  } finally {
    existingResumeLoading.value = false;
  }
}

async function clearCurrentAnalysis() {
  if (clearAnalysisLoading.value) return;

  const confirmed = window.confirm("确定清空当前目录下所有简历的分析结果吗？");
  if (!confirmed) return;

  clearAnalysisLoading.value = true;
  existingResumeError.value = "";

  try {
    const response = await fetch("/api/resumes/clear-analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dir: crawlOut.value
      })
    });
    const data = await readJsonResponse(response);

    if (!response.ok) throw new Error(formatError(data));

    expandedAnalysis.value = {};
    await fetchExistingResumes();
  } catch (requestError) {
    existingResumeError.value = requestError instanceof Error ? requestError.message : String(requestError);
  } finally {
    clearAnalysisLoading.value = false;
  }
}

async function sendResumeEmail(resume) {
  if (!resumeEmailTo.value.trim() || sendingResumePath.value) return;

  sendingResumePath.value = resume.path;
  resumeEmailStatus.value = "";

  try {
    const response = await fetch("/api/send-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: resumeEmailTo.value.trim(),
        subject: `${resume.candidateName}的简历`,
        text: `候选人：${emailCandidateLabel(resume)}\n\n附件为该候选人的简历。`,
        attachments: [
          {
            filename: resume.name,
            path: resume.path
          }
        ]
      })
    });
    const data = await readJsonResponse(response);

    if (!response.ok) throw new Error(formatError(data));

    resumeEmailStatus.value = `${resume.candidateName} 的简历已发送`;
  } catch (requestError) {
    resumeEmailStatus.value = requestError instanceof Error ? requestError.message : String(requestError);
  } finally {
    sendingResumePath.value = "";
  }
}

async function sendTopResumeEmails() {
  if (!resumeEmailTo.value.trim() || batchEmailLoading.value) return;

  const count = Number(batchEmailCount.value);
  if (!Number.isFinite(count) || count <= 0) {
    resumeEmailStatus.value = "请输入有效的批量人数";
    return;
  }

  const selectedResumes = sortedResumes.value.slice(0, Math.min(count, sortedResumes.value.length));
  if (!selectedResumes.length) {
    resumeEmailStatus.value = "当前没有可发送的简历";
    return;
  }

  batchEmailLoading.value = true;
  resumeEmailStatus.value = "";

  try {
    const names = selectedResumes.map((resume, index) => `${index + 1}. ${emailCandidateLabel(resume)}`);
    const response = await fetch("/api/send-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: resumeEmailTo.value.trim(),
        subject: `排名前${selectedResumes.length}人的简历`,
        text: `本次发送排名前${selectedResumes.length}人的简历：\n${names.join("\n")}\n\n附件为对应候选人的简历。`,
        attachments: selectedResumes.map((resume) => ({
          filename: resume.name,
          path: resume.path
        }))
      })
    });
    const data = await readJsonResponse(response);

    if (!response.ok) throw new Error(formatError(data));

    resumeEmailStatus.value = `已发送排名前 ${selectedResumes.length} 人的简历`;
  } catch (requestError) {
    resumeEmailStatus.value = requestError instanceof Error ? requestError.message : String(requestError);
  } finally {
    batchEmailLoading.value = false;
  }
}

function toggleAnalysis(resume) {
  expandedAnalysis.value = {
    ...expandedAnalysis.value,
    [resume.path]: !expandedAnalysis.value[resume.path]
  };
}

function analysisData(resume) {
  return resume.analysis?.data || null;
}

function matchDetails(resume) {
  return analysisData(resume)?.match_details || {};
}

function resumeInfo(resume) {
  return analysisData(resume)?.resume_info || {};
}

function emailCandidateLabel(resume) {
  const phone = String(resumeInfo(resume).contact?.phone || "").trim();
  return `${resume.candidateName}（${phone || "手机号未提取"}）`;
}

function score(resume) {
  return Number(analysisData(resume)?.match_score ?? 0);
}

function scoreLevel(resume) {
  const value = score(resume);
  if (value >= 80) return "high";
  if (value >= 60) return "medium";
  return "low";
}

function contactText(resume) {
  const contact = resumeInfo(resume).contact || {};
  return [contact.phone, contact.email, contact.location].filter(Boolean).join(" / ") || "暂无联系方式";
}

async function readJsonResponse(response) {
  const text = await response.text();

  if (!text.trim()) {
    return { error: "后端没有返回内容，请确认 http://localhost:3001 已启动" };
  }

  try {
    return JSON.parse(text);
  } catch {
    return {
      error: "后端返回的不是 JSON",
      details: text.slice(0, 1000)
    };
  }
}

function formatFileSize(size) {
  if (!size) return "";
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatError(data) {
  if (!data) return "请求失败";
  const message = data.error || "请求失败";

  if (!data.details) return message;
  if (typeof data.details === "string") return `${message}\n${data.details}`;

  return `${message}\n${JSON.stringify(data.details, null, 2)}`;
}

function listOrEmpty(items) {
  return Array.isArray(items) && items.length ? items : ["暂无"];
}

onMounted(() => {
  fetchExistingResumes();
  fetchZhaopinJobs();
});
onBeforeUnmount(stopPollingJob);
</script>

<template>
  <main class="app-shell">
    <section class="workspace">
      <div class="panel form-panel">
        <div class="title-row">
          <div>
            <h1>岗位要求</h1>
          </div>
          <span class="status-dot" title="本地后端代理"></span>
        </div>

        <div class="form">
          <label class="label-without-title">
            <textarea
              v-model="jobRequirements"
              rows="10"
              placeholder="粘贴岗位描述、岗位职责、任职要求..."
            ></textarea>
          </label>
          <button type="button" :disabled="!canAnalyzeExisting" @click="analyzeExistingDownloads">
            {{ analyzeExistingLoading ? "提交中..." : "分析已下载简历" }}
          </button>
        </div>
      </div>

      <div class="panel form-panel">
        <div class="section-heading">
          <h2>智联附件简历爬取</h2>
        </div>

        <form class="form compact-form" @submit.prevent="startCrawl">
          <label>
              <span>智联消息链接</span>
            <input v-model="crawlUrl" type="url" />
          </label>

          <div class="field-row">
            <label>
              <span>保存目录</span>
              <input v-model="crawlOut" type="text" />
            </label>
            <label>
              <span>最多人数</span>
              <input v-model="crawlMax" min="1" type="number" placeholder="不限" />
            </label>
          </div>

          <div class="field-row">
            <label>
              <span>开始日期</span>
              <input v-model="crawlDateFrom" type="date" />
            </label>
            <label>
              <span>结束日期</span>
              <input v-model="crawlDateTo" type="date" />
            </label>
          </div>

          <div class="field-row">
            <label>
              <span>等待附件毫秒</span>
              <input v-model="waitAfterAsk" min="1000" step="1000" type="number" />
            </label>
            <label>
              <span>下载后分析</span>
              <select v-model="analyzeAfterDownload">
                <option :value="true">开启</option>
                <option :value="false">关闭</option>
              </select>
            </label>
          </div>

          <div class="toggle-grid">
            <label class="toggle-line">
              <input v-model="skipAsk" type="checkbox" />
              <span>只下载已有附件</span>
            </label>
            <label class="toggle-line">
              <input v-model="askOnly" type="checkbox" />
              <span>只索要附件</span>
            </label>
            <label class="toggle-line">
              <input v-model="debug" type="checkbox" />
              <span>保存调试文件</span>
            </label>
            <label class="toggle-line">
              <input v-model="keepOriginal" type="checkbox" />
              <span>保留原始下载</span>
            </label>
          </div>

          <div class="button-row single-button-row">
            <button type="submit" :disabled="!canStartCrawl">
              {{ crawlLoading ? "启动中..." : "开始爬取" }}
            </button>
          </div>
          <p class="form-note">
            {{ willAnalyzeAfterDownload ? "下载后会自动上传后端分析。" : "未填写岗位要求时，只下载简历文件，不自动分析。" }}
          </p>
        </form>
      </div>

      <div class="panel form-panel">
        <div class="section-heading">
          <h2>智联消息岗位简历爬取</h2>
        </div>

        <form class="form compact-form" @submit.prevent="startMessageResumeCrawl">
          <label>
            <span>智联消息链接</span>
            <input v-model="messageResumeUrl" type="url" placeholder="粘贴智联消息界面 URL" />
          </label>

          <div class="field-row applicant-sync-row">
            <label>
              <span>选择岗位</span>
              <select v-model="messageResumeJobKey">
                <option v-for="job in applicantJobs" :key="job.key" :value="job.key">
                  {{ job.name }}
                </option>
              </select>
            </label>
            <label>
              <span>同步岗位</span>
              <button type="button" :disabled="!canSyncZhaopinJobs" @click="syncZhaopinJobs">
                {{ syncJobsLoading ? "同步中..." : "同步智联岗位" }}
              </button>
            </label>
          </div>
          <p v-if="syncJobsStatus" class="form-note">{{ syncJobsStatus }}</p>

          <div class="field-row">
            <label>
              <span>保存目录</span>
              <input v-model="messageResumeOut" type="text" />
            </label>
            <label>
              <span>爬取数量</span>
              <input v-model="messageResumeMax" min="1" type="number" placeholder="不限" />
            </label>
          </div>

          <div class="field-row">
            <label>
              <span>下载后分析</span>
              <select v-model="messageResumeAnalyze">
                <option :value="true">开启</option>
                <option :value="false">关闭</option>
              </select>
            </label>
            <label class="toggle-line inline-toggle">
              <input v-model="messageResumeUnreadOnly" type="checkbox" />
              <span>未读</span>
            </label>
          </div>

          <div class="toggle-grid">
            <label class="toggle-line">
              <input v-model="messageResumeSkipAsk" type="checkbox" />
              <span>只下载已有附件</span>
            </label>
            <label class="toggle-line">
              <input v-model="messageResumeDebug" type="checkbox" />
              <span>保存调试文件</span>
            </label>
          </div>

          <div class="button-row single-button-row">
            <button type="submit" :disabled="!canStartMessageResumeCrawl">
              {{ messageResumeLoading ? "启动中..." : "开始岗位简历爬取" }}
            </button>
          </div>
          <p class="form-note">
            会先在智联消息界面按岗位和未读条件筛选，再按成功下载的 PDF 数量计算上限。
          </p>
        </form>
      </div>

      <div class="panel form-panel">
        <div class="section-heading">
          <h2>智联自动打招呼</h2>
        </div>

        <form class="form compact-form" @submit.prevent="startGreeting">
          <label>
            <span>推荐页链接</span>
            <input v-model="greetingUrl" type="url" />
          </label>

          <label>
            <span>打招呼内容</span>
            <textarea v-model="greetingMessage" rows="4" placeholder="你好，请问您现在还在看机会吗？"></textarea>
          </label>

          <div class="field-row">
            <label>
              <span>人数</span>
              <input v-model="greetingMax" min="1" type="number" placeholder="不限" />
            </label>
            <label>
              <span>间隔毫秒</span>
              <input v-model="greetingDelay" min="500" step="100" type="number" />
            </label>
          </div>

          <div class="toggle-grid">
            <label class="toggle-line">
              <input v-model="greetingDryRun" type="checkbox" />
              <span>只测试不发送</span>
            </label>
            <label class="toggle-line">
              <input v-model="greetingDebug" type="checkbox" />
              <span>保存调试文件</span>
            </label>
          </div>

          <div class="button-row single-button-row">
            <button type="submit" :disabled="!canStartGreeting">
              {{ greetingLoading ? "启动中..." : "开始打招呼" }}
            </button>
          </div>
          <p class="form-note">
            已发过的候选人会自动跳过，发送记录保存在后端。
          </p>
        </form>
      </div>

      <div class="panel form-panel">
        <div class="section-heading">
          <h2>岗位投递者群发</h2>
        </div>

        <form class="form compact-form" @submit.prevent="startApplicantMessages">
          <div class="field-row applicant-sync-row">
            <label>
              <span>在招职位页面链接</span>
              <input v-model="syncJobsUrl" type="url" placeholder="粘贴智联职位管理/在招职位页面 URL" />
            </label>
            <label>
              <span>同步岗位</span>
              <button type="button" :disabled="!canSyncZhaopinJobs" @click="syncZhaopinJobs">
                {{ syncJobsLoading ? "同步中..." : "同步智联岗位" }}
              </button>
            </label>
          </div>
          <p v-if="syncJobsStatus" class="form-note">{{ syncJobsStatus }}</p>

          <div class="field-row applicant-filter-row">
            <label>
              <span>选择岗位</span>
              <select v-model="applicantJobKey" @change="applyApplicantJob">
                <option v-for="job in applicantJobs" :key="job.key" :value="job.key">
                  {{ job.name }}
                </option>
              </select>
            </label>
            <label>
              <span>学历</span>
              <select v-model="applicantEducationFilter">
                <option value="none">无</option>
                <option value="bachelor">本科</option>
                <option value="master">硕士</option>
                <option value="doctor">博士</option>
              </select>
            </label>
            <label>
              <span>最高教育经历</span>
              <select v-model="applicantSchoolLocationFilter">
                <option value="none">无</option>
                <option value="beijing">北京高校</option>
                <option value="non_beijing">非北京高校</option>
              </select>
            </label>
            <label>
              <span>期望工作城市</span>
              <select v-model="applicantExpectedCityFilter">
                <option value="all">不限</option>
                <option value="job_location">职位所在地</option>
                <option value="non_job_location">非职位所在地</option>
              </select>
            </label>
            <label>
              <span>最多发送人数</span>
              <input v-model="applicantMax" min="1" type="number" placeholder="不限" />
            </label>
          </div>

          <label>
            <span>岗位投递者页面链接</span>
            <input v-model="applicantUrl" type="url" placeholder="粘贴该岗位的投递者/应聘者列表页面 URL" />
          </label>
          <p class="form-note">
            岗位下拉的名称和默认链接在前端配置中维护；如果某个岗位还没配置链接，可以先在这里临时粘贴。
          </p>

          <label>
            <span>发送内容</span>
            <textarea v-model="applicantMessage" rows="4" placeholder="您好，感谢您投递我们公司的岗位，方便进一步沟通吗？"></textarea>
          </label>

          <div class="field-row applicant-field-row">
            <label>
              <span>浏览器配置目录</span>
              <input v-model="applicantProfile" type="text" />
            </label>
            <label>
              <span>间隔毫秒</span>
              <input v-model="applicantDelay" min="500" step="100" type="number" />
            </label>
          </div>

          <label>
            <span>发送记录文件</span>
            <input v-model="applicantStore" type="text" />
          </label>

          <div class="toggle-grid">
            <label class="toggle-line">
              <input v-model="applicantUnviewedOnly" type="checkbox" />
              <span>未看过</span>
            </label>
            <label class="toggle-line">
              <input v-model="applicantDryRun" type="checkbox" />
              <span>只测试不发送</span>
            </label>
            <label class="toggle-line">
              <input v-model="applicantDebug" type="checkbox" />
              <span>保存调试文件</span>
            </label>
          </div>

          <div class="button-row single-button-row">
            <button type="submit" :disabled="!canStartApplicantMessages">
              {{ applicantLoading ? "启动中..." : "开始岗位群发" }}
            </button>
          </div>
          <p class="form-note">
            正式发送前可先勾选“只测试不发送”确认识别名单；人数上限按成功发送数量计算。
          </p>
        </form>
      </div>

      <div class="panel form-panel">
        <div class="section-heading split-heading">
          <div>
            <h2>已有简历 <span class="heading-meta">/ {{ analysisProgressText }}</span></h2>
          </div>
          <div class="resume-heading-actions">
            <label class="email-target-field">
              <span>发送邮箱</span>
              <input v-model="resumeEmailTo" type="email" placeholder="收件人邮箱" />
            </label>
            <label class="batch-count-field">
              <span>前 N 名</span>
              <input v-model="batchEmailCount" min="1" type="number" placeholder="人数" />
            </label>
            <button
              type="button"
              class="small-button"
              :disabled="!resumeEmailTo.trim() || batchEmailLoading"
              @click="sendTopResumeEmails"
            >
              {{ batchEmailLoading ? "发送中..." : "批量发送" }}
            </button>
            <button
              type="button"
              class="small-button secondary-small-button"
              :disabled="clearAnalysisLoading"
              @click="clearCurrentAnalysis"
            >
              {{ clearAnalysisLoading ? "清空中..." : "清空分析结果" }}
            </button>
            <button type="button" class="icon-button" title="刷新已有简历" @click="fetchExistingResumes">
              ↻
            </button>
          </div>
        </div>

        <div v-if="resumeEmailStatus" class="inline-state">{{ resumeEmailStatus }}</div>
        <div v-if="existingResumeLoading" class="inline-state">正在读取本地简历...</div>
        <div v-else-if="existingResumeError" class="inline-error">{{ existingResumeError }}</div>
        <div v-else-if="existingResumes.length" class="resume-list">
          <article v-for="resume in sortedResumes" :key="resume.path" class="resume-list-item">
            <div class="resume-main">
              <strong>{{ resume.candidateName }}</strong>
              <small>
                {{ formatFileSize(resume.size) }} / {{ formatDate(resume.modifiedAt) }}
                <span v-if="resume.analysis?.data"> / 已有分析结果</span>
              </small>
            </div>

            <div class="resume-actions">
              <span class="score-pill">{{ score(resume) }} 分</span>
              <button
                type="button"
                class="small-button"
                :disabled="!resumeEmailTo.trim() || Boolean(sendingResumePath)"
                @click="sendResumeEmail(resume)"
              >
                {{ sendingResumePath === resume.path ? "发送中..." : "发送" }}
              </button>
              <a class="small-button" :href="resume.url" target="_blank" rel="noreferrer">详情</a>
              <button
                type="button"
                class="small-button secondary-small-button"
                :disabled="!resume.analysis?.data"
                @click="toggleAnalysis(resume)"
              >
                {{ expandedAnalysis[resume.path] ? "收起分析结果" : "分析结果" }}
              </button>
            </div>

            <div v-if="expandedAnalysis[resume.path]" class="analysis-panel">
              <section class="summary-band compact-summary" :class="`score-${scoreLevel(resume)}`">
                <div>
                  <h3>{{ matchDetails(resume).recommendation || "暂无建议" }}</h3>
                </div>
                <div class="score-box">
                  <strong>{{ score(resume) }}</strong>
                  <span>匹配分</span>
                </div>
              </section>

              <section class="result-section">
                <h3>总体评价</h3>
                <p>{{ matchDetails(resume).overall_evaluation || "暂无总体评价" }}</p>
              </section>

              <section class="result-grid">
                <div class="result-section">
                  <h3>优势</h3>
                  <ul>
                    <li v-for="item in listOrEmpty(matchDetails(resume).strengths)" :key="item">{{ item }}</li>
                  </ul>
                </div>
                <div class="result-section">
                  <h3>待补足</h3>
                  <ul>
                    <li v-for="item in listOrEmpty(matchDetails(resume).weaknesses)" :key="item">{{ item }}</li>
                  </ul>
                </div>
              </section>

              <section class="result-grid three">
                <div class="metric-card">
                  <span>学历匹配</span>
                  <strong>{{ matchDetails(resume).education_match?.score ?? 0 }}</strong>
                  <p>{{ matchDetails(resume).education_match?.comment || "暂无说明" }}</p>
                </div>
                <div class="metric-card">
                  <span>经验匹配</span>
                  <strong>{{ matchDetails(resume).experience_match?.score ?? 0 }}</strong>
                  <p>{{ matchDetails(resume).experience_match?.comment || "暂无说明" }}</p>
                </div>
                <div class="metric-card">
                  <span>技能匹配</span>
                  <strong>{{ matchDetails(resume).skills_match?.score ?? 0 }}</strong>
                  <p>{{ matchDetails(resume).skills_match?.comment || "暂无说明" }}</p>
                </div>
              </section>

              <section class="result-section">
                <h3>简历解析</h3>
                <div class="resume-facts">
                  <span>姓名：{{ resumeInfo(resume).name || "暂无" }}</span>
                  <span>{{ contactText(resume) }}</span>
                  <span>技能：{{ listOrEmpty(resumeInfo(resume).skills).join("、") }}</span>
                  <span>证书：{{ listOrEmpty(resumeInfo(resume).certifications).join("、") }}</span>
                </div>
              </section>

            </div>
          </article>
        </div>
        <div v-else class="inline-state">当前目录还没有简历文件。</div>
      </div>

      <div class="panel crawl-panel">
        <div class="result-header">
          <h2>爬取任务</h2>
          <p class="upload-meta">状态：{{ crawlStatus }} / 已返回结果：{{ workflowResultCount }}</p>
        </div>

        <div v-if="crawlError" class="error-state">{{ crawlError }}</div>
        <div v-else class="log-area">
          <pre v-if="crawlLogs.length">{{ crawlLogs.join("\n") }}</pre>
          <div v-else class="empty-state small">启动爬取后，日志会显示在这里。</div>
        </div>
      </div>
    </section>
  </main>
</template>
