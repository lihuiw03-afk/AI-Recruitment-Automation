import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  printHelp();
  process.exit(0);
}

const startUrl = args.url || args['jobs-url'];
const userDataDir = path.resolve(args.profile || '.zhaopin-browser-profile-boss');
const outputPath = path.resolve(args.out || 'zhaopin-jobs.json');
const headless = Boolean(args.headless);
const autoStart = Boolean(args.auto);
const debug = Boolean(args.debug);

const labels = {
  online: '\u5728\u7ebf\u4e2d',
  login: '\u767b\u5f55',
  scanCode: '\u626b\u7801',
  password: '\u5bc6\u7801',
};

if (!startUrl) {
  console.error('Missing jobs page URL. Use --url "https://rd6.zhaopin.com/app/job"');
  process.exit(1);
}

let context;

try {
  context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    acceptDownloads: false,
    viewport: { width: 1440, height: 1000 },
    locale: 'zh-CN',
  });

  context.setDefaultTimeout(10_000);

  const page = context.pages()[0] || await context.newPage();
  const responseJobs = [];
  page.on('response', async (response) => {
    const jobs = await extractJobsFromResponse(response).catch(() => []);
    if (jobs.length > 0) responseJobs.push(...jobs);
  });

  await page.goto(String(startUrl), { waitUntil: 'domcontentloaded' });

  console.log('\nZhaopin jobs page opened.');
  console.log(`Current URL: ${page.url()}`);
  console.log('This script only reads online job information. It does not publish, edit, refresh, close, message, call, or modify candidates.');
  console.log('Log in if needed and make sure the job page is visible.');
  if (!autoStart) {
    console.log('Press Enter here to start reading online jobs.\n');
    await waitForEnter();
  }

  await settle(page);
  await ensureLoggedIn(page, startUrl);

  const clickedOnline = await clickOnlineTab(page);
  if (clickedOnline) {
    console.log('Switched to online jobs tab.');
    await settle(page);
  } else {
    console.log('Online jobs tab was not found; reading the current visible list.');
    await page.waitForTimeout(1000);
  }

  await page.waitForTimeout(2000);

  const origin = new URL(page.url()).origin;
  const jobs = mergeJobs([
    ...normalizeCapturedJobs(responseJobs, origin),
    ...await collectOnlineJobs(page),
  ]);
  const validJobs = jobs.filter((job) => job.jobNumber && job.name);
  const payload = {
    ok: true,
    sourceUrl: page.url(),
    tab: labels.online,
    syncedAt: new Date().toISOString(),
    detectedCount: jobs.length,
    count: validJobs.length,
    jobs: validJobs,
  };

  await fs.writeFile(outputPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`Detected ${jobs.length} possible online jobs.`);
  console.log(`Found ${validJobs.length} online jobs with jobNumber.`);
  console.log(`Saved to ${outputPath}`);
  console.log(`__WORKFLOW_RESULT__ ${JSON.stringify({ type: 'zhaopin-sync-jobs', ...payload })}`);

  if (validJobs.length === 0) {
    const debugInfo = await saveDebugArtifacts(page, 'no-online-jobs-detected');
    console.log(`No jobs with jobNumber were found. Debug files saved to ${debugInfo.dir}`);
  } else if (debug) {
    const debugInfo = await saveDebugArtifacts(page, 'online-jobs-detected');
    console.log(`Debug files saved to ${debugInfo.dir}`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const friendlyMessage = formatLaunchError(message);
  const page = context?.pages?.()[0];
  let debugInfo = null;
  if (page) {
    debugInfo = await saveDebugArtifacts(page, 'sync-jobs-error').catch(() => null);
  }

  const payload = {
    ok: false,
    sourceUrl: page?.url?.() || startUrl,
    tab: labels.online,
    syncedAt: new Date().toISOString(),
    count: 0,
    jobs: [],
    error: friendlyMessage,
    rawError: message,
    debugDir: debugInfo?.dir || '',
  };

  await fs.writeFile(outputPath, JSON.stringify(payload, null, 2), 'utf8').catch(() => {});
  console.error(`Unable to sync online jobs: ${friendlyMessage}`);
  if (debugInfo?.dir) console.error(`Debug files saved to ${debugInfo.dir}`);
  console.log(`__WORKFLOW_RESULT__ ${JSON.stringify({ type: 'zhaopin-sync-jobs', ...payload })}`);
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;

    const [rawKey, inlineValue] = arg.slice(2).split('=');
    const key = rawKey.trim();

    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }

  return parsed;
}

function printHelp() {
  console.log(`
Usage:
  npm run zhaopin:sync-jobs -- --url "https://rd6.zhaopin.com/app/job" --profile ".\\.zhaopin-browser-profile-boss"

Options:
  --url <url>       Zhaopin job page URL, usually https://rd6.zhaopin.com/app/job.
  --profile <path>  Browser profile directory. Default: .\\.zhaopin-browser-profile-boss.
  --out <path>      Output JSON path. Default: zhaopin-jobs.json.
  --debug           Save screenshot and HTML when no online jobs are detected.
  --auto            Start immediately without waiting for Enter.
  --headless        Run browser headless.
`);
}

async function waitForEnter() {
  process.stdin.resume();
  return new Promise((resolve) => {
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
  });
}

async function settle(targetPage) {
  await targetPage.waitForLoadState('domcontentloaded').catch(() => {});
  await targetPage.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  await targetPage.waitForTimeout(1000);
}

async function ensureLoggedIn(targetPage, targetUrl) {
  const isLoginPage = await targetPage.evaluate((text) => {
    return /passport\.zhaopin\.com|\/login/i.test(location.href)
      || new RegExp(`${text.login}|${text.scanCode}|${text.password}`).test(document.body?.innerText || '');
  }, labels).catch(() => false);

  if (!isLoginPage) return;

  console.log('\nZhaopin redirected to the login page.');
  console.log('Please finish login in the opened browser, then press Enter here to continue.\n');
  await waitForEnter();
  await targetPage.goto(String(targetUrl), { waitUntil: 'domcontentloaded' }).catch(() => {});
  await settle(targetPage);
}

async function clickOnlineTab(targetPage) {
  return targetPage.evaluate((onlineText) => {
    const nodes = [...document.querySelectorAll('button, a, [role="tab"], [role="button"], [class*="tab"], [class*="Tab"], li, span, div')]
      .filter((node) => {
        if (!(node instanceof HTMLElement)) return false;
        const text = (node.textContent || '').trim().replace(/\s+/g, '');
        const rect = node.getBoundingClientRect();
        return rect.width > 0
          && rect.height > 0
          && text.includes(onlineText)
          && text.length <= 32;
      });

    const target = nodes.find((node) => {
      const role = node.getAttribute('role') || '';
      const className = String(node.className || '');
      return /tab|button/i.test(role)
        || /tab|active|filter|menu/i.test(className)
        || ['BUTTON', 'A', 'LI'].includes(node.tagName);
    }) || nodes[0];

    if (!target) return false;
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    target.click();
    return true;
  }, labels.online).catch(() => false);
}

async function collectOnlineJobs(targetPage) {
  return targetPage.evaluate(() => {
    const origin = location.origin;
    const jobCards = findVisibleJobCards();
    const jobs = [];

    for (const card of jobCards) {
      const text = normalize(card.textContent || '');
      const urls = [...card.querySelectorAll('a[href]')]
        .map((anchor) => toUrl(anchor.getAttribute('href') || ''))
        .filter(Boolean);
      const jobNumber = extractJobNumber(text, urls);
      const name = cleanJobName(extractJobTitle(card, text, urls));

      if (!name || isNoise(name)) continue;

      jobs.push({
        key: jobNumber || stableKey(name, text),
        name,
        jobNumber,
        applicantUrl: buildAppUrl(origin, '/app/candidate', jobNumber, name),
        recommendUrl: buildAppUrl(origin, '/app/recommend', jobNumber, name),
        sourceUrl: urls[0]?.href || '',
        rawText: text.slice(0, 240),
      });
    }

    if (jobs.length === 0) {
      for (const anchor of document.querySelectorAll('a[href]')) {
        const url = toUrl(anchor.getAttribute('href') || '');
        if (!url) continue;

        const jobNumber = extractJobNumber('', [url]);
        if (!jobNumber) continue;

        const card = findCard(anchor);
        const text = normalize(card?.textContent || anchor.textContent || '');
        const name = cleanJobName(url.searchParams.get('jobTitle') || extractJobTitle(card || anchor, text, [url]));
        if (!name || isNoise(name)) continue;

        jobs.push({
          key: jobNumber,
          name,
          jobNumber,
          applicantUrl: buildAppUrl(origin, '/app/candidate', jobNumber, name),
          recommendUrl: buildAppUrl(origin, '/app/recommend', jobNumber, name),
          sourceUrl: url.href,
          rawText: text.slice(0, 240),
        });
      }
    }

    const seen = new Set();
    return jobs
      .filter((job) => {
        const key = job.jobNumber || job.name;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 100);

    function findVisibleJobCards() {
      return [...document.querySelectorAll('[class*="job"], [class*="Job"], [class*="position"], [class*="Position"], [class*="item"], [class*="card"], li, tr')]
        .filter((node) => {
          if (!(node instanceof HTMLElement)) return false;
          const rect = node.getBoundingClientRect();
          const text = normalize(node.textContent || '');
          if (rect.width <= 0 || rect.height <= 0) return false;
          if (text.length < 10 || text.length > 900) return false;
          if (/营业执照|认证|发布职位|发布岗位|创建职位/.test(text) && !/在线中|在招|招聘中|发布中/.test(text)) return false;
          return /职位|岗位|招聘|候选|投递|推荐|全职|兼职|薪|K|k|\d/.test(text);
        });
    }

    function extractJobNumber(text, urls) {
      for (const url of urls) {
        const value = url.searchParams.get('jobNumber')
          || url.searchParams.get('jobId')
          || url.searchParams.get('positionId')
          || '';
        if (value && value !== '-1') return value;
      }

      const match = String(text || '').match(/\bCC[0-9A-Z]{8,}\b/i);
      return match?.[0] || '';
    }

    function extractJobTitle(card, text, urls) {
      for (const url of urls) {
        const title = url.searchParams.get('jobTitle');
        if (title && !isNoise(title)) return title;
      }

      const titleNode = card?.querySelector?.('[title], [class*="title"], [class*="Title"], [class*="name"], [class*="Name"], h1, h2, h3, h4, strong');
      const title = titleNode?.getAttribute?.('title') || titleNode?.textContent || '';
      if (title && !isNoise(cleanJobName(title))) return title;

      return guessJobName(text);
    }

    function guessJobName(text) {
      const cleaned = normalize(text);
      const pieces = cleaned
        .split(/[\n\r|｜·•]/)
        .map((item) => item.trim())
        .filter(Boolean);

      return pieces.find((item) => item.length >= 2 && item.length <= 60 && !isNoise(item))
        || cleaned.slice(0, 60);
    }

    function findCard(node) {
      let current = node;
      while (current && current !== document.body) {
        const rect = current.getBoundingClientRect?.();
        const text = normalize(current.textContent || '');
        const className = String(current.className || '');
        if (
          /job|position|recruit|publish|item|card|list/i.test(className)
          || (rect && rect.width > 300 && rect.height > 40 && text.length >= 20)
        ) {
          return current;
        }
        current = current.parentElement;
      }
      return node.parentElement;
    }

    function toUrl(value) {
      try {
        return new URL(value, location.href);
      } catch {
        return null;
      }
    }

    function normalize(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function cleanJobName(value) {
      return normalize(value).replace(/^\d+\s*/, '').replace(/^(职位|岗位)[:：]/, '').trim();
    }

    function isNoise(value) {
      const text = normalize(value);
      return /^(查看|编辑|刷新|搜索|筛选|更多|管理|推荐|候选人|投递|沟通|职位管理|发布职位|发布岗位|创建职位|在线中)$/.test(text)
        || text.length > 80;
    }

    function stableKey(...parts) {
      let hash = 0;
      const text = parts.filter(Boolean).join('|');
      for (let index = 0; index < text.length; index += 1) {
        hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
      }
      return `job-${Math.abs(hash)}`;
    }

    function buildAppUrl(baseOrigin, pathname, jobNumber, jobTitle) {
      if (!jobNumber) return '';
      const url = new URL(pathname, baseOrigin);
      url.searchParams.set('jobNumber', jobNumber);
      if (jobTitle) url.searchParams.set('jobTitle', jobTitle);
      return url.href;
    }
  });
}

async function extractJobsFromResponse(response) {
  const responseUrl = response.url();
  if (!/job|position|recruit|rd6|rdapi|bapi/i.test(responseUrl)) return [];

  const headers = response.headers();
  const contentType = headers['content-type'] || '';
  if (!/json|javascript|text/i.test(contentType)) return [];

  const text = await response.text().catch(() => '');
  if (!text || !/(jobNumber|jobTitle|jobName|positionName|职位|岗位)/i.test(text)) return [];

  const parsed = JSON.parse(text);
  return extractJobObjects(parsed);
}

function extractJobObjects(value) {
  const jobs = [];
  const visited = new Set();

  walk(value);
  return jobs;

  function walk(node) {
    if (!node || typeof node !== 'object' || visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const jobNumber = pickString(node, [
      'jobNumber',
      'jobNo',
      'number',
      'jobId',
      'positionId',
      'positionNumber',
      'recruitJobNumber',
    ]);
    const name = pickString(node, [
      'jobTitle',
      'jobName',
      'name',
      'title',
      'positionName',
      'positionTitle',
    ]);

    if (looksLikeJobNumber(jobNumber) && looksLikeJobName(name)) {
      jobs.push({
        name,
        jobNumber,
        raw: node,
      });
    }

    for (const item of Object.values(node)) walk(item);
  }
}

function normalizeCapturedJobs(items, origin) {
  return items
    .map((item) => {
      const name = cleanPlainText(item.name);
      const jobNumber = cleanPlainText(item.jobNumber);
      return {
        key: jobNumber || name,
        name,
        jobNumber,
        applicantUrl: buildJobUrl(origin, '/app/candidate', jobNumber, name),
        recommendUrl: buildJobUrl(origin, '/app/recommend', jobNumber, name),
        sourceUrl: '',
        rawText: '',
      };
    })
    .filter((job) => job.name && job.jobNumber);
}

function mergeJobs(items) {
  const seen = new Set();
  return items.filter((job) => {
    const key = job.jobNumber || job.name;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pickString(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (typeof value === 'string' || typeof value === 'number') {
      const text = cleanPlainText(value);
      if (text) return text;
    }
  }
  return '';
}

function looksLikeJobNumber(value) {
  const text = cleanPlainText(value);
  return Boolean(text && text !== '-1' && (/^CC[0-9A-Z]{8,}$/i.test(text) || /^[0-9A-Z_-]{6,}$/.test(text)));
}

function looksLikeJobName(value) {
  const text = cleanPlainText(value);
  return Boolean(text && text.length >= 2 && text.length <= 80 && !/不限|全部|职位管理|发布职位|候选人|推荐|搜索/.test(text));
}

function cleanPlainText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function buildJobUrl(origin, pathname, jobNumber, jobTitle) {
  if (!jobNumber) return '';
  const url = new URL(pathname, origin);
  url.searchParams.set('jobNumber', jobNumber);
  if (jobTitle) url.searchParams.set('jobTitle', jobTitle);
  return url.href;
}

async function saveDebugArtifacts(targetPage, name) {
  const debugDir = path.resolve('zhaopin-sync-jobs-debug');
  await fs.mkdir(debugDir, { recursive: true });
  const prefix = `${Date.now()}-${sanitizeFileName(name)}`;
  const screenshotPath = path.join(debugDir, `${prefix}.png`);
  const htmlPath = path.join(debugDir, `${prefix}.html`);
  await targetPage.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  await fs.writeFile(htmlPath, await targetPage.content()).catch(() => {});
  return {
    dir: debugDir,
    screenshotPath,
    htmlPath,
  };
}

function sanitizeFileName(input) {
  const cleaned = String(input || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

  return cleaned || 'debug';
}

function formatLaunchError(message) {
  if (/user data dir|user-data-dir|another browser|另一个|another/i.test(message)) {
    return `浏览器配置目录被占用，无法打开 ${userDataDir}。请先关闭之前弹出的空白 Chromium/Playwright 窗口，或结束占用该目录的 chrome.exe 进程后再同步。`;
  }

  return message;
}
