import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  DEFAULT_BACKEND_ANALYZE_URL,
  analyzeResumePdf,
  loadJobRequirements,
} from './resume-analyzer-client.js';

const DEFAULT_URL = 'https://rd6.zhaopin.com/app/im?sessionId=af639ab8eb8b7f9d81352e30f5e025df';

const args = parseArgs(process.argv.slice(2));
const startUrl = args.url || DEFAULT_URL;
const outputDir = path.resolve(args.out || 'zhaopin-attachment-resumes');
const userDataDir = path.resolve(args.profile || '.zhaopin-browser-profile');
const maxPeople = Number.parseInt(args.max || '0', 10);
const maxDownloadsMode = Boolean(args['max-downloads']);
const selectedJobName = String(args['job-name'] || args.job || '').trim();
const selectedJobNumber = String(args['job-number'] || extractJobKey(startUrl) || '').trim();
const waitAfterAskMs = Number.parseInt(args['wait-after-ask'] || '8000', 10);
const minNavigationDelayMs = Number.parseInt(args['min-navigation-delay'] || '3000', 10);
let lastNavigationAt = 0;
const dateFromMs = parseDateArg(args['date-from'], false);
const dateToMs = parseDateArg(args['date-to'], true);
const headless = Boolean(args.headless);
const autoStart = Boolean(args.auto);
const debug = Boolean(args.debug);
const unreadOnly = Boolean(args['unread-only']);
const askOnly = Boolean(args['ask-only']);
const skipAsk = Boolean(args['skip-ask']);
const keepOriginal = Boolean(args['keep-original']);
const noAnalyze = Boolean(args['no-analyze']);
const backendUrl = args['backend-url'] || DEFAULT_BACKEND_ANALYZE_URL;
const analysisDir = path.resolve(args['analysis-dir'] || path.join(outputDir, '_analysis'));
const jobRequirements = noAnalyze ? '' : (await loadJobRequirements(args)).trim();

const zh = {
  viewAttachmentResume: '\u67e5\u770b\u9644\u4ef6\u7b80\u5386',
  attachmentResume: '\u9644\u4ef6\u7b80\u5386',
  askAttachmentResume: '\u7d22\u8981\u9644\u4ef6\u7b80\u5386',
  askAttachmentResumeAlt: '\u8981\u9644\u4ef6\u7b80\u5386',
  requestAttachmentResume: '\u8bf7\u6c42\u9644\u4ef6\u7b80\u5386',
  getAttachmentResume: '\u83b7\u53d6\u9644\u4ef6\u7b80\u5386',
  askedAttachmentResume: '\u5df2\u5411\u5bf9\u65b9\u8981\u9644\u4ef6\u7b80\u5386',
  autoAttachmentResume: '\u53ef\u76f4\u63a5\u67e5\u770b\u9644\u4ef6\u7b80\u5386',
  download: '\u4e0b\u8f7d',
  downloadPdf: '\u4e0b\u8f7dPDF',
  exportPdf: '\u5bfc\u51faPDF',
  save: '\u4fdd\u5b58',
  resume: '\u7b80\u5386',
  unread: '\u672a\u8bfb',
  allJobs: '\u5168\u90e8\u804c\u4f4d',
};

const viewAttachmentPattern = new RegExp(`${zh.viewAttachmentResume}|${zh.attachmentResume}`);
const askAttachmentPattern = new RegExp(
  `${zh.askAttachmentResume}|${zh.askAttachmentResumeAlt}|${zh.requestAttachmentResume}|${zh.getAttachmentResume}`,
);
const downloadPattern = new RegExp(`${zh.downloadPdf}|${zh.exportPdf}|PDF|pdf`, 'i');

if (!noAnalyze && !jobRequirements) {
  console.error('Missing job requirements. Use --job-requirements-file ".\\jd.txt", --job-requirements "...", or --no-analyze.');
  process.exit(1);
}

await fs.mkdir(outputDir, { recursive: true });

const context = await chromium.launchPersistentContext(userDataDir, {
  headless,
  acceptDownloads: true,
  viewport: { width: 1440, height: 1000 },
  locale: 'zh-CN',
});

context.setDefaultTimeout(10_000);

const page = context.pages()[0] || await context.newPage();
await gotoIfNeeded(page, startUrl);

console.log('\nZhaopin IM page opened.');
console.log('Log in if needed and make sure the candidate conversation list is visible.');
if (!autoStart) {
  console.log('Press Enter here to ask for and download attachment resumes.\n');
  await waitForEnter();
}

await settle(page);
await ensureLoggedIn(page);
await applyMessagePageFilters(page);
await waitForSessionList(page);

const seenFileNames = new Map();
let downloaded = 0;
let requested = 0;
let skipped = 0;
let skippedExisting = 0;
let analyzed = 0;
let analysisFailed = 0;

if (!noAnalyze) {
  console.log(`Analysis enabled. Backend: ${backendUrl}`);
}
if (selectedJobName || selectedJobNumber) {
  console.log(`Job filter: ${selectedJobName || selectedJobNumber}`);
}
if (unreadOnly) {
  console.log('Unread filter is enabled.');
}

await processSessionTargets(page);

console.log(`\nDone. Downloaded: ${downloaded}. Requested/pending: ${requested}. Skipped: ${skipped}. Existing skipped: ${skippedExisting}.`);
if (!noAnalyze) {
  console.log(`Analyzed: ${analyzed}. Analysis failed: ${analysisFailed}.`);
  console.log(`Analysis directory: ${analysisDir}`);
}
console.log(`Output directory: ${outputDir}`);
await context.close();

async function processSessionTargets(targetPage) {
  console.log('Loading and processing candidate conversations from the session list...');

  const processedKeys = new Set();
  const collected = [];
  let lastCount = 0;
  let stableRounds = 0;
  let processed = 0;
  const maxScrollRounds = 120;
  const dateCheckInterval = 3;

  for (let round = 0; round < maxScrollRounds && stableRounds < 6; round += 1) {
    if (shouldStopByLimit(processed)) {
      break;
    }

    const visibleTargets = await collectVisibleSessionTargets(targetPage);
    collected.push(...visibleTargets);

    const deduped = dedupeTargets(collected);
    if (deduped.length > lastCount) {
      lastCount = deduped.length;
      stableRounds = 0;
      console.log(`Loaded candidate conversations: ${lastCount}`);
    } else {
      stableRounds += 1;
    }

    const eligibleTargets = filterTargetsByJob(filterTargetsByDateRange(deduped));
    for (const target of eligibleTargets) {
      if (shouldStopByLimit(processed)) {
        break;
      }

      const key = getTargetKey(target);
      if (processedKeys.has(key)) {
        continue;
      }

      processedKeys.add(key);
      processed += 1;
      await processSessionTarget(targetPage, target, processed);
    }

    if (shouldStopByLimit(processed)) {
      break;
    }

    if (shouldStopScrollingByDate(visibleTargets, round, dateCheckInterval)) {
      console.log('Reached conversations older than the selected start date; stop loading more sessions.');
      break;
    }

    const moved = await scrollSessionList(targetPage);
    await targetPage.waitForTimeout(700);

    if (!moved && stableRounds >= 2) {
      break;
    }
  }

  console.log(`Processed candidate conversations: ${processed}. Loaded: ${lastCount}.`);
}

function shouldStopByLimit(processed) {
  if (maxPeople <= 0) {
    return false;
  }

  if (maxDownloadsMode) {
    return downloaded >= maxPeople;
  }

  return processed >= maxPeople;
}

function getTargetKey(target) {
  return target.sessionId
    || target.resumeNumber
    || `${target.jobNumber || ''}|${target.name || ''}|${target.timestampMs || ''}|${target.index ?? ''}`;
}

async function processSessionTarget(targetPage, target, index) {
  const candidateName = target.name || `candidate-${index}`;
  const totalLabel = maxPeople > 0
    ? (maxDownloadsMode ? `${downloaded}/${maxPeople} downloaded` : `${index}/${maxPeople}`)
    : String(index);
  console.log(`\n[${totalLabel}] ${candidateName}`);

  try {
    const existingPdf = await findExistingPdfForCandidate(candidateName);
      if (existingPdf) {
        skippedExisting += 1;
        console.log(`Already exists, skipped crawling: ${existingPdf}`);
        return;
    }

    await openSessionTarget(targetPage, target);
    await waitForConversationReady(targetPage);

    if (!askOnly) {
      const existingDownload = await downloadAttachmentResume(targetPage, candidateName, seenFileNames);
      if (existingDownload) {
        downloaded += 1;
        console.log(`Downloaded: ${existingDownload}`);
        if (await analyzeDownloadedResume(existingDownload, candidateName)) {
          analyzed += 1;
        } else if (!noAnalyze) {
          analysisFailed += 1;
        }
        return;
      }
    }

    if (skipAsk) {
      skipped += 1;
      console.warn('No existing attachment PDF found; skipped asking because --skip-ask is set.');
      if (debug) {
        await saveDebugArtifacts(targetPage, index, `${candidateName}-no-existing-attachment`);
      }
      return;
    }

    const askResult = await askForAttachmentResume(targetPage);
    if (askResult.clicked) {
      requested += 1;
      console.log('Requested attachment resume.');
      await targetPage.waitForTimeout(waitAfterAskMs);

      if (!askOnly) {
        const afterAskDownload = await downloadAttachmentResume(targetPage, candidateName, seenFileNames);
        if (afterAskDownload) {
          downloaded += 1;
          console.log(`Downloaded after request: ${afterAskDownload}`);
          if (await analyzeDownloadedResume(afterAskDownload, candidateName)) {
            analyzed += 1;
          } else if (!noAnalyze) {
            analysisFailed += 1;
          }
          return;
        }
      }

      if (debug) {
        await saveDebugArtifacts(targetPage, index, `${candidateName}-requested`);
      }
      return;
    }

    if (askResult.alreadyRequested) {
      requested += 1;
      console.log('Attachment resume was already requested; no download available yet.');
      if (debug) {
        await saveDebugArtifacts(targetPage, index, `${candidateName}-already-requested`);
      }
      return;
    }

    skipped += 1;
    console.warn('No attachment download or request button found.');
    if (debug) {
      await saveDebugArtifacts(targetPage, index, `${candidateName}-no-attachment-action`);
    }
  } catch (error) {
    skipped += 1;
    console.warn(`Failed: ${error.message}`);
    if (debug) {
      await saveDebugArtifacts(targetPage, index, `failed-${candidateName}`).catch(() => {});
    }
  }
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith('--')) {
      continue;
    }

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

function parseDateArg(value, endOfDay) {
  if (!value) {
    return 0;
  }

  const text = String(value).trim();
  if (!text) {
    return 0;
  }

  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const date = new Date(dateOnly && endOfDay ? `${text}T23:59:59.999` : text);
  const time = date.getTime();
  return Number.isFinite(time) ? time : 0;
}

function filterTargetsByDateRange(targets) {
  if (!dateFromMs && !dateToMs) {
    return targets;
  }

  let skippedWithoutTime = 0;
  const filtered = targets.filter((target) => {
    const time = Number(target.timestampMs || 0);
    if (!time) {
      skippedWithoutTime += 1;
      return true;
    }

    if (dateFromMs && time < dateFromMs) {
      return false;
    }
    if (dateToMs && time > dateToMs) {
      return false;
    }

    return true;
  });

  if (skippedWithoutTime > 0) {
    console.warn(`Kept ${skippedWithoutTime} conversations without readable time while date filtering is enabled.`);
  }

  return filtered;
}

function filterTargetsByJob(targets) {
  if (!selectedJobNumber && !selectedJobName) {
    return targets;
  }

  const normalizedName = normalizeText(selectedJobName);
  const filtered = targets.filter((target) => {
    if (selectedJobNumber && String(target.jobNumber || '') === selectedJobNumber) return true;
    const text = normalizeText(`${target.jobName || ''} ${target.lastSentence || ''}`);
    return Boolean(normalizedName && text.includes(normalizedName));
  });

  if (filtered.length || !selectedJobNumber) {
    return filtered;
  }

  console.warn('No conversations exposed matching jobNumber in page state; relying on UI-applied job filter.');
  return targets;
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

async function analyzeDownloadedResume(pdfPath, candidateName) {
  if (noAnalyze) {
    return false;
  }

  try {
    const result = await analyzeResumePdf({
      pdfPath,
      candidateName,
      jobRequirements,
      backendUrl,
      resultDir: analysisDir,
    });

    if (result.ok) {
      console.log(`Analysis: ${result.summary}`);
      console.log(formatWorkflowResult(result));
      return true;
    }

    console.warn(`Analysis backend returned ${result.status}. Result saved: ${result.outputPath}`);
    return false;
  } catch (error) {
    console.warn(`Analysis failed: ${error.message}`);
    return false;
  }
}

function formatWorkflowResult(result) {
  return `__WORKFLOW_RESULT__ ${JSON.stringify({
    data: result.response?.data ?? result.response,
    file: result.response?.file ?? {
      name: path.basename(result.resumePath),
      type: 'pdf',
      url: result.resumePath,
    },
    resume: {
      candidateName: result.candidateName,
      path: result.resumePath,
      analysisPath: result.outputPath,
    },
  })}`;
}

async function findExistingPdfForCandidate(candidateName) {
  const safeName = sanitizeFileName(candidateName);
  const pdfPath = path.join(outputDir, `${safeName}.pdf`);

  const stat = await fs.stat(pdfPath).catch(() => null);
  if (stat?.isFile() && stat.size > 0) {
    return pdfPath;
  }

  return '';
}

async function settle(targetPage) {
  await targetPage.waitForLoadState('domcontentloaded').catch(() => {});
  await targetPage.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  await targetPage.waitForTimeout(1000);
}

async function waitForConversationReady(targetPage) {
  await settle(targetPage);
  await targetPage.waitForSelector('.im-session-detail, .im-timeline, .im-resume-detail', {
    state: 'visible',
    timeout: 12_000,
  }).catch(() => {});
}

async function ensureLoggedIn(targetPage) {
  const isLoginPage = await targetPage.evaluate(() => {
    return /passport\.zhaopin\.com|\/login/i.test(location.href)
      || /登录|扫码|密码/.test(document.body?.innerText || '');
  }).catch(() => false);

  if (!isLoginPage) {
    return;
  }

  console.log('\nZhaopin redirected to the login page.');
  console.log('Please finish login in the opened browser, then press Enter here to continue.\n');
  await waitForEnter();
  await gotoIfNeeded(targetPage, startUrl).catch(() => {});
  await settle(targetPage);
}

async function applyMessagePageFilters(targetPage) {
  if (selectedJobName || selectedJobNumber) {
    await selectMessageJobFilter(targetPage);
  }

  if (unreadOnly) {
    await selectUnreadFilter(targetPage);
  }

  if (selectedJobName || selectedJobNumber || unreadOnly) {
    await settle(targetPage);
  }
}

async function selectMessageJobFilter(targetPage) {
  console.log(`Selecting IM job filter: ${selectedJobName || selectedJobNumber}`);

  const opened = await openMessageJobSelector(targetPage);
  if (!opened) {
    await saveDebugArtifacts(targetPage, 0, 'im-job-filter-open-failed').catch(() => {});
    throw new Error('Could not open Zhaopin IM job filter.');
  }

  await targetPage.waitForTimeout(600);
  const selected = await clickMessageJobOption(targetPage, selectedJobName, selectedJobNumber);
  if (!selected) {
    const visibleOptions = await getVisibleMessageJobOptions(targetPage).catch(() => []);
    if (visibleOptions.length) {
      console.warn(`Visible IM job options: ${visibleOptions.slice(0, 12).join(' | ')}`);
    }
    await saveDebugArtifacts(targetPage, 0, 'im-job-filter-option-not-found').catch(() => {});
    throw new Error(`Could not select Zhaopin IM job filter: ${selectedJobName || selectedJobNumber}`);
  }

  await targetPage.waitForTimeout(1200);
}

async function openMessageJobSelector(targetPage) {
  const locators = [
    targetPage.locator('[placeholder="\u5168\u90e8\u804c\u4f4d"]').first(),
    targetPage.locator('[title="\u5168\u90e8\u804c\u4f4d"]').first(),
    targetPage.locator('.job-selector').first(),
    targetPage.locator('.im-filter .km-select, [class*="im"] .km-select, [class*="filter"] .km-select').first(),
  ];

  for (const locator of locators) {
    if (!(await locator.count().catch(() => 0))) continue;
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    const clicked = await locator.click({ timeout: 3000 }).then(() => true).catch(() => false);
    if (!clicked) continue;
    await targetPage.waitForTimeout(500);
    if (await hasVisibleJobOptions(targetPage)) return true;
  }

  return targetPage.evaluate((labels) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const nodes = [...document.querySelectorAll('button, a, [role="button"], [role="combobox"], [class*="select"], [class*="dropdown"], div, span')]
      .filter(isVisible)
      .filter((node) => {
        const text = normalize(node.textContent || node.getAttribute('title') || node.getAttribute('aria-label') || '');
        if (!text || text.length > 100) return false;
        return text.includes(labels.allJobs) || (labels.jobName && text.includes(labels.jobName));
      });

    const target = nodes.find((node) => /select|dropdown|job|filter|职位/i.test(String(node.className || '') + node.getAttribute('role'))) || nodes[0];
    if (!target) return false;
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    target.click();
    return true;
  }, {
    allJobs: zh.allJobs,
    jobName: selectedJobName,
  }).catch(() => false);
}

async function hasVisibleJobOptions(targetPage) {
  return targetPage.evaluate(() => {
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    return [...document.querySelectorAll('.km-popper, .km-popover, [role="listbox"], [class*="dropdown"], [class*="Dropdown"]')]
      .some((node) => isVisible(node) && /职位|不限|AI|顾问|咨询|设计|管理/.test(node.textContent || ''));
  }).catch(() => false);
}

async function clickMessageJobOption(targetPage, jobName, jobNumber) {
  const marker = `codex-im-job-${Date.now()}`;
  const match = await targetPage.evaluate((labels) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
    const normalizeLoose = (value) => normalize(value).replace(/[()（）【】\[\]<>《》,，、:：;；+\-_—|/\\]/g, '');
    const name = normalize(labels.jobName);
    const looseName = normalizeLoose(labels.jobName);
    const number = normalize(labels.jobNumber);
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const area = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width * rect.height;
    };
    const optionText = (node) => normalize(`${node.textContent || ''} ${node.getAttribute('title') || ''} ${node.getAttribute('data-job-number') || ''} ${node.getAttribute('data-jobid') || ''} ${node.getAttribute('data-value') || ''} ${node.getAttribute('value') || ''}`);
    const scoreNode = (node) => {
      const text = optionText(node);
      const looseText = normalizeLoose(text);
      let score = 0;
      if (number && text === number) score += 1000;
      if (number && text.includes(number)) score += 700;
      if (name && text === name) score += 600;
      if (name && text.includes(name)) score += 450;
      if (looseName && looseText.includes(looseName)) score += 350;
      if (name && name.includes(text) && text.length >= 4) score += 120;
      return score;
    };

    const popupRoots = [...document.querySelectorAll('.km-popper, .km-popover, [role="listbox"], [class*="dropdown"], [class*="Dropdown"]')]
      .filter(isVisible);
    const roots = popupRoots.length ? popupRoots : [document.body];
    const selector = [
      'li',
      'button',
      'a',
      '[role="option"]',
      '[role="menuitem"]',
      '[class*="option"]',
      '[class*="Option"]',
      '[class*="menu"]',
      '[class*="Menu"]',
      '[class*="item"]',
      '[class*="Item"]',
      '[title]',
      '[data-job-number]',
      '[data-jobid]',
      '[data-value]',
    ].join(',');
    const options = roots.flatMap((root) => [...root.querySelectorAll(selector)])
      .filter(isVisible)
      .map((node) => {
        const text = optionText(node);
        return { node, text, score: scoreNode(node), area: area(node), children: node.children.length };
      })
      .filter((item) => item.text && item.text.length <= 260 && item.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        if (left.children !== right.children) return left.children - right.children;
        return left.area - right.area;
      });

    const best = options[0];
    if (!best) return { ok: false, options: [] };

    const clickable = best.node.closest('[role="option"], [role="menuitem"], li, button, a, [class*="option"], [class*="Option"], [class*="item"], [class*="Item"]') || best.node;
    clickable.setAttribute('data-codex-im-job-option', labels.marker);
    return {
      ok: true,
      text: best.text,
      score: best.score,
      options: options.slice(0, 8).map((item) => item.text),
    };
  }, {
    jobName: jobName || '',
    jobNumber: jobNumber || '',
    marker,
  }).catch(() => ({ ok: false, options: [] }));

  if (!match?.ok) {
    if (match?.options?.length) {
      console.warn(`Visible IM job options: ${match.options.join(' | ')}`);
    }
    return false;
  }

  console.log(`Matched IM job option: ${match.text}`);
  const locator = targetPage.locator(`[data-codex-im-job-option="${marker}"]`).first();
  const clicked = await locator.scrollIntoViewIfNeeded()
    .then(() => locator.click({ timeout: 3000 }))
    .then(() => true)
    .catch(() => false);

  if (clicked) return true;

  return targetPage.evaluate((markerValue) => {
    const target = document.querySelector(`[data-codex-im-job-option="${markerValue}"]`);
    if (!(target instanceof HTMLElement)) return false;
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    target.click();
    return true;
  }, marker).catch(() => false);
}

async function getVisibleMessageJobOptions(targetPage) {
  return targetPage.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const roots = [...document.querySelectorAll('.km-popper, .km-popover, [role="listbox"], [class*="dropdown"], [class*="Dropdown"]')]
      .filter(isVisible);
    return roots
      .flatMap((root) => [...root.querySelectorAll('li, button, a, [role="option"], [role="menuitem"], [class*="option"], [class*="Option"], [class*="item"], [class*="Item"], [title]')])
      .filter(isVisible)
      .map((node) => normalize(`${node.textContent || ''} ${node.getAttribute('title') || ''} ${node.getAttribute('data-job-number') || ''} ${node.getAttribute('data-jobid') || ''} ${node.getAttribute('data-value') || ''}`))
      .filter((text, index, list) => text && text.length <= 260 && list.indexOf(text) === index)
      .slice(0, 30);
  });
}

async function selectUnreadFilter(targetPage) {
  console.log('Selecting IM unread filter.');
  const clicked = await targetPage.evaluate((label) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const nodes = [...document.querySelectorAll('label, button, a, span, div, [role="button"], [role="checkbox"], .km-checkbox')]
      .filter(isVisible)
      .filter((node) => normalize(node.textContent || node.getAttribute('title') || node.getAttribute('aria-label') || '') === normalize(label));

    const textNode = nodes.sort((left, right) => left.children.length - right.children.length)[0];
    if (!textNode) return false;

    const clickable = textNode.closest('label, button, a, [role="button"], [role="checkbox"], .km-checkbox, [class*="checkbox"], [class*="Checkbox"]') || textNode;
    const input = clickable.querySelector?.('input[type="checkbox"]');
    const className = String(clickable.className || '');
    const checked = input?.checked
      || clickable.getAttribute?.('aria-checked') === 'true'
      || /checked|selected|active/i.test(className);
    if (!checked) {
      clickable.scrollIntoView({ block: 'center', inline: 'nearest' });
      clickable.click();
    }
    return true;
  }, zh.unread).catch(() => false);

  if (!clicked) {
    await saveDebugArtifacts(targetPage, 0, 'im-unread-filter-not-found').catch(() => {});
    throw new Error('Could not select Zhaopin IM unread filter.');
  }

  await targetPage.waitForTimeout(800);
}

async function waitForSessionList(targetPage) {
  await targetPage.waitForFunction(() => {
    const stateSessions = window.__INITIAL_STATE__?.im?.sessions;
    return (Array.isArray(stateSessions) && stateSessions.length > 0)
      || document.querySelectorAll('.im-session-item').length > 0
      || document.querySelectorAll('.im-session-item__name-title').length > 0;
  }, { timeout: 20_000 }).catch(() => {});
  await settle(targetPage);
}

async function collectSessionTargets(targetPage) {
  console.log('Loading all candidate conversations from the session list...');

  const collected = [];
  let lastCount = 0;
  let stableRounds = 0;
  const maxScrollRounds = 120;
  const dateCheckInterval = 3;

  for (let round = 0; round < maxScrollRounds && stableRounds < 6; round += 1) {
    const visibleTargets = await collectVisibleSessionTargets(targetPage);
    collected.push(...visibleTargets);

    const deduped = dedupeTargets(collected);
    if (deduped.length > lastCount) {
      lastCount = deduped.length;
      stableRounds = 0;
      console.log(`Loaded candidate conversations: ${lastCount}`);
    } else {
      stableRounds += 1;
    }

    if (shouldStopScrollingByDate(visibleTargets, round, dateCheckInterval)) {
      console.log('Reached conversations older than the selected start date; stop loading more sessions.');
      break;
    }

    const moved = await scrollSessionList(targetPage);
    await targetPage.waitForTimeout(700);

    if (!moved && stableRounds >= 2) {
      break;
    }
  }

  return dedupeTargets(collected);
}

function shouldStopScrollingByDate(visibleTargets, round, interval) {
  if (!dateFromMs || round < interval - 1 || (round + 1) % interval !== 0) {
    return false;
  }

  const visibleTimes = visibleTargets
    .map((target) => Number(target.timestampMs || 0))
    .filter(Boolean);

  if (visibleTimes.length === 0) {
    return false;
  }

  const oldestVisibleTime = Math.min(...visibleTimes);
  const newestVisibleTime = Math.max(...visibleTimes);

  console.log(
    `Date range check: visible ${formatLogDate(oldestVisibleTime)} - ${formatLogDate(newestVisibleTime)}, start ${formatLogDate(dateFromMs)}`,
  );

  return oldestVisibleTime < dateFromMs;
}

function formatLogDate(time) {
  if (!time) {
    return 'unknown';
  }

  return new Date(time).toISOString().slice(0, 10);
}

async function collectVisibleSessionTargets(targetPage) {
  const stateSessions = await targetPage.evaluate(() => {
    const normalizeTimestamp = (value) => {
      if (value === undefined || value === null || value === '') return 0;
      if (typeof value === 'number') {
        return value < 1e12 ? value * 1000 : value;
      }

      const text = String(value).trim();
      if (/^\d+$/.test(text)) {
        const number = Number(text);
        return number < 1e12 ? number * 1000 : number;
      }

      const parsed = Date.parse(text.replace(/\./g, '-').replace(/\//g, '-'));
      return Number.isFinite(parsed) ? parsed : 0;
    };

    const sessionTimestamp = (session) => {
      const keys = [
        'timestamp',
        'time',
        'lastTime',
        'lastMessageTime',
        'lastSentenceTime',
        'updateTime',
        'updatedAt',
        'createTime',
        'createdAt',
        'date',
      ];

      for (const key of keys) {
        const time = normalizeTimestamp(session?.[key]);
        if (time) return time;
      }

      return 0;
    };

    let state = window.__INITIAL_STATE__;

    if (!state) {
      const script = [...document.scripts]
        .map((node) => node.textContent || '')
        .find((content) => content.includes('__INITIAL_STATE__='));

      const jsonText = script?.match(/__INITIAL_STATE__=({[\s\S]*?})\s*<\/?$/)?.[1]
        || script?.slice(script.indexOf('__INITIAL_STATE__=') + '__INITIAL_STATE__='.length);

      if (jsonText) {
        try {
          state = JSON.parse(jsonText);
        } catch {
          state = null;
        }
      }
    }

    const sessions = state?.im?.sessions;
    if (!Array.isArray(sessions)) {
      return [];
    }

    return sessions
      .filter((session) => session?.sessionId && session?.name)
      .map((session) => ({
        type: 'state',
        sessionId: String(session.sessionId),
        name: String(session.name || ''),
        jobNumber: String(session.jobNumber || ''),
        jobName: String(session.jobName || session.jobTitle || session.positionName || session.positionTitle || ''),
        resumeNumber: String(session.resumeNumber || ''),
        lastSentence: String(session.lastSentence || ''),
        timestampMs: sessionTimestamp(session),
      }));
  }).catch(() => []);

  const domSessions = await targetPage.evaluate(() => {
    const parseDomTime = (text) => {
      const value = String(text || '').trim();
      const now = new Date();
      const currentYear = now.getFullYear();
      const timeMatch = value.match(/(\d{1,2}):(\d{2})/);

      if (/今天/.test(value) && timeMatch) {
        return new Date(currentYear, now.getMonth(), now.getDate(), Number(timeMatch[1]), Number(timeMatch[2])).getTime();
      }
      if (/昨天/.test(value) && timeMatch) {
        return new Date(currentYear, now.getMonth(), now.getDate() - 1, Number(timeMatch[1]), Number(timeMatch[2])).getTime();
      }

      const fullDate = value.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
      if (fullDate) {
        return new Date(Number(fullDate[1]), Number(fullDate[2]) - 1, Number(fullDate[3])).getTime();
      }

      const monthDate = value.match(/(^|\D)(\d{1,2})[-/.月](\d{1,2})(日)?(\D|$)/);
      if (monthDate) {
        return new Date(currentYear, Number(monthDate[2]) - 1, Number(monthDate[3])).getTime();
      }

      return 0;
    };

    const parseDomTimeSafe = (text) => {
      const value = String(text || '').trim();
      const now = new Date();
      const currentYear = now.getFullYear();
      const timeMatch = value.match(/(\d{1,2}):(\d{2})/);

      if (/\u4eca\u5929/.test(value) && timeMatch) {
        return new Date(currentYear, now.getMonth(), now.getDate(), Number(timeMatch[1]), Number(timeMatch[2])).getTime();
      }
      if (/\u6628\u5929/.test(value) && timeMatch) {
        return new Date(currentYear, now.getMonth(), now.getDate() - 1, Number(timeMatch[1]), Number(timeMatch[2])).getTime();
      }
      if (timeMatch && value.length <= 8) {
        return new Date(currentYear, now.getMonth(), now.getDate(), Number(timeMatch[1]), Number(timeMatch[2])).getTime();
      }

      const fullDate = value.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/u);
      if (fullDate) {
        return new Date(Number(fullDate[1]), Number(fullDate[2]) - 1, Number(fullDate[3])).getTime();
      }

      const monthDate = value.match(/(^|\D)(\d{1,2})[-/.月](\d{1,2})(日)?(\D|$)/u);
      if (monthDate) {
        return new Date(currentYear, Number(monthDate[2]) - 1, Number(monthDate[3])).getTime();
      }

      return 0;
    };

    const getSessionId = (node) => {
      const href = node.closest('a[href]')?.getAttribute('href')
        || node.querySelector('a[href]')?.getAttribute('href')
        || '';
      const fromHref = href.match(/[?&]sessionId=([^&#]+)/i)?.[1];
      if (fromHref) return decodeURIComponent(fromHref);

      const datasetValues = [
        node.getAttribute('data-session-id'),
        node.getAttribute('data-sessionid'),
        node.dataset?.sessionId,
        node.dataset?.sessionid,
      ].filter(Boolean);

      return datasetValues[0] || '';
    };

    return [...document.querySelectorAll('.im-session-item, .im-session-item__box, [role="listitem"]')]
      .map((node, index) => {
        const nameNode = node.querySelector('.im-session-item__name-title')
          || node.querySelector('[class*="name-title"]')
          || node.querySelector('[title]');
        const name = (nameNode?.getAttribute('title') || nameNode?.textContent || node.textContent || '')
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 80);
        const sessionId = getSessionId(node);
        const timeNode = node.querySelector('[class*="time"], [class*="date"], [class*="Time"], [class*="Date"]');
        const timestampMs = parseDomTimeSafe(timeNode?.textContent || node.textContent || '') || parseDomTime(node.textContent || '');

        return {
          type: sessionId ? 'state' : 'dom-name',
          sessionId,
          name,
          index,
          timestampMs,
          jobName: '',
          jobNumber: '',
          lastSentence: node.textContent || '',
        };
      })
      .filter((item) => item.name);
  }).catch(() => []);

  return [...stateSessions, ...domSessions];
}

async function scrollSessionList(targetPage) {
  return targetPage.evaluate(() => {
    const candidates = [
      ...document.querySelectorAll('.im-session-list, .im-session-list__content, .im-session, [class*="session-list"], [class*="SessionList"]'),
      ...document.querySelectorAll('aside, [role="list"], [class*="scroll"], [class*="Scroll"]'),
    ];

    const list = candidates
      .filter((node) => node instanceof HTMLElement)
      .find((node) => {
        const style = getComputedStyle(node);
        return node.scrollHeight > node.clientHeight + 40
          && /(auto|scroll)/.test(`${style.overflowY} ${style.overflow}`);
      })
      || [...document.querySelectorAll('*')]
        .filter((node) => node instanceof HTMLElement)
        .find((node) => {
          return node.scrollHeight > node.clientHeight + 200
            && node.querySelector('.im-session-item, .im-session-item__name-title');
        });

    if (!list) {
      window.scrollBy(0, Math.floor(window.innerHeight * 0.8));
      return true;
    }

    const before = list.scrollTop;
    list.scrollTop = Math.min(list.scrollTop + Math.max(list.clientHeight * 0.85, 500), list.scrollHeight);
    list.dispatchEvent(new Event('scroll', { bubbles: true }));
    return list.scrollTop !== before;
  }).catch(() => false);
}

function dedupeTargets(targets) {
  const seen = new Map();
  const deduped = [];

  for (const target of targets) {
    const key = target.sessionId || target.resumeNumber || target.jobNumber || target.name || `${target.type}-${target.index}`;
    if (seen.has(key)) {
      const existing = seen.get(key);
      if (!existing.timestampMs && target.timestampMs) {
        existing.timestampMs = target.timestampMs;
      }
      if (!existing.lastSentence && target.lastSentence) {
        existing.lastSentence = target.lastSentence;
      }
      continue;
    }

    seen.set(key, target);
    deduped.push(target);
  }

  return deduped.sort((left, right) => scoreAttachmentTarget(right) - scoreAttachmentTarget(left));
}

function scoreAttachmentTarget(target) {
  const textValue = `${target.lastSentence || ''} ${target.name || ''}`;
  let score = 0;
  if (textValue.includes(zh.viewAttachmentResume) || textValue.includes(zh.attachmentResume)) {
    score += 10;
  }
  if (textValue.includes('\u8fd9\u662f\u6211\u7684\u9644\u4ef6\u7b80\u5386')) {
    score += 20;
  }
  return score;
}

async function openSessionTarget(targetPage, target) {
  if (target.sessionId) {
    const url = new URL(targetPage.url());
    url.pathname = '/app/im';
    url.search = '';
    url.searchParams.set('sessionId', target.sessionId);

    const navigated = await gotoIfNeeded(targetPage, url.toString());
    if (navigated) {
      await settle(targetPage);
    }
    return;
  }

  if (target.type === 'dom-name' && target.name) {
    const clicked = await clickSessionByName(targetPage, target.name);
    if (clicked) {
      return;
    }
  }

  const session = targetPage.locator('.im-session-item').nth(target.index);
  if (target.name) {
    const byName = targetPage.locator('.im-session-item').filter({ hasText: target.name }).first();
    if (await byName.count().catch(() => 0)) {
      await byName.scrollIntoViewIfNeeded();
      await byName.click({ trial: true });
      await byName.click();
      return;
    }
  }

  await session.scrollIntoViewIfNeeded();
  await session.click({ trial: true });
  await session.click();
}

async function gotoIfNeeded(targetPage, targetUrl) {
  const href = String(targetUrl);
  if (isSamePageUrl(targetPage.url(), href)) {
    return false;
  }

  await waitForNavigationSlot(targetPage);
  lastNavigationAt = Date.now();
  await targetPage.goto(href, { waitUntil: 'domcontentloaded' });
  return true;
}

async function waitForNavigationSlot(targetPage) {
  if (!Number.isFinite(minNavigationDelayMs) || minNavigationDelayMs <= 0 || lastNavigationAt <= 0) {
    return;
  }

  const remainingMs = minNavigationDelayMs - (Date.now() - lastNavigationAt);
  if (remainingMs > 0) {
    await targetPage.waitForTimeout(remainingMs);
  }
}

function isSamePageUrl(currentUrl, targetUrl) {
  try {
    const current = new URL(currentUrl);
    const target = new URL(targetUrl, current.href);
    return current.origin === target.origin
      && current.pathname === target.pathname
      && current.search === target.search;
  } catch {
    return currentUrl === targetUrl;
  }
}

function extractJobKey(inputUrl) {
  if (!inputUrl) return '';

  try {
    const url = new URL(inputUrl);
    return url.searchParams.get('jobNumber')
      || url.searchParams.get('jobId')
      || url.searchParams.get('positionId')
      || url.searchParams.get('jobid')
      || '';
  } catch {
    return '';
  }
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}

async function clickSessionByName(targetPage, name) {
  await scrollSessionListToTop(targetPage);

  for (let round = 0; round < 120; round += 1) {
    const byName = targetPage.locator('.im-session-item, .im-session-item__box, [role="listitem"]').filter({ hasText: name }).first();
    if (await byName.count().catch(() => 0)) {
      await byName.scrollIntoViewIfNeeded().catch(() => {});
      await byName.click({ trial: true });
      await byName.click();
      return true;
    }

    const moved = await scrollSessionList(targetPage);
    if (!moved) {
      return false;
    }
    await targetPage.waitForTimeout(250);
  }

  return false;
}

async function scrollSessionListToTop(targetPage) {
  await targetPage.evaluate(() => {
    const lists = [...document.querySelectorAll('.im-session-list, .im-session-list__content, .im-session, [class*="session-list"], [role="list"]')]
      .filter((node) => node instanceof HTMLElement && node.scrollHeight > node.clientHeight + 40);

    for (const list of lists) {
      list.scrollTop = 0;
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
  }).catch(() => {});
  await targetPage.waitForTimeout(400);
}

async function readSessionListName(sessionLocator, fallbackIndex) {
  const name = await sessionLocator.locator('.im-session-item__name-title').first()
    .evaluate((node) => node.getAttribute('title') || node.textContent || '')
    .catch(() => '');

  return sanitizeFileName(name) || `candidate-${fallbackIndex}`;
}

async function downloadAttachmentResume(sourcePage, candidateName, seenFileNames) {
  const locators = [
    sourcePage.getByText(zh.viewAttachmentResume, { exact: false }).last(),
    sourcePage.getByRole('button', { name: viewAttachmentPattern }).last(),
    sourcePage.getByRole('link', { name: viewAttachmentPattern }).last(),
    sourcePage.locator('.im-attachment-card').last(),
    sourcePage.locator('[class*="attachment"]').filter({ hasText: viewAttachmentPattern }).last(),
  ];

  for (const locator of locators) {
    if (!(await locator.count().catch(() => 0))) {
      continue;
    }

    const downloadPath = await clickAttachmentAndDownload(sourcePage, locator, candidateName, seenFileNames);
    if (downloadPath) {
      return downloadPath;
    }

    return '';
  }

  return '';
}

async function clickAttachmentAndDownload(sourcePage, locator, candidateName, seenFileNames) {
  const context = sourcePage.context();
  const newPagePromise = context.waitForEvent('page', { timeout: 6000 }).catch(() => null);

  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.click({ timeout: 5000 }).catch(() => {});

  const firstResult = await Promise.race([
    newPagePromise.then((pageItem) => ({ type: 'page', page: pageItem })),
    sourcePage.waitForTimeout(2500).then(() => ({ type: 'same-page' })),
  ]);

  if (firstResult.type === 'page' && firstResult.page) {
    const fromNewPage = await downloadFromPreviewPage(firstResult.page, candidateName, seenFileNames);
    await firstResult.page.close().catch(() => {});
    if (fromNewPage) {
      return fromNewPage;
    }
  }

  return downloadFromPreviewPage(sourcePage, candidateName, seenFileNames, false);
}

async function downloadFromPreviewPage(targetPage, candidateName, seenFileNames, closeWhenDone = true) {
  await settle(targetPage);

  const pdfFromViewer = await savePdfFromViewer(targetPage, candidateName, seenFileNames);
  if (pdfFromViewer) {
    return pdfFromViewer;
  }

  const downloadLocators = [
    targetPage.getByText(zh.downloadPdf, { exact: false }).last(),
    targetPage.getByText(zh.exportPdf, { exact: false }).last(),
    targetPage.getByRole('button', { name: downloadPattern }).last(),
    targetPage.getByRole('link', { name: downloadPattern }).last(),
    targetPage.locator('a[href$=".pdf"], a[href*=".pdf?"], a[href*="format=pdf"], a[href*="type=pdf"]').last(),
    targetPage.locator('[class*="download"], [class*="Download"], [zp-stat-id*="download"]').filter({ hasText: /PDF|pdf/ }).last(),
  ];

  for (const locator of downloadLocators) {
    if (!(await locator.count().catch(() => 0))) {
      continue;
    }

    const downloadPromise = targetPage.waitForEvent('download', { timeout: 8000 }).catch(() => null);
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.click({ timeout: 3000 }).catch(() => {});
    const download = await downloadPromise;
    if (download) {
      const pdfPath = await savePdfDownload(download, candidateName, seenFileNames);
      if (pdfPath) {
        return pdfPath;
      }
    }

    break;
  }

  if (!closeWhenDone) {
    await targetPage.keyboard.press('Escape').catch(() => {});
  }

  return '';
}

async function savePdfFromViewer(targetPage, candidateName, seenFileNames) {
  const pdfUrl = await targetPage.evaluate(() => {
    const looksLikeZhaopinPdfEndpoint = (url) => {
      try {
        const parsed = new URL(url, location.href);
        return /attachment\.zhaopin\.com/i.test(parsed.hostname)
          && /resumeapi|downloadFileTemporary|download/i.test(parsed.pathname);
      } catch {
        return false;
      }
    };

    const candidates = [
      location.href,
      ...[...document.querySelectorAll('embed, iframe, object')]
        .map((node) => node.getAttribute('src') || node.getAttribute('data') || ''),
      ...[...document.querySelectorAll('a[href]')]
        .map((node) => node.getAttribute('href') || ''),
    ];

    for (const rawUrl of candidates) {
      if (!rawUrl) {
        continue;
      }

      const absoluteUrl = new URL(rawUrl, location.href).href;
      if (
        /\.pdf(?:[?#]|$)|format=pdf|type=pdf|mime=pdf|contentType=pdf/i.test(absoluteUrl)
        || looksLikeZhaopinPdfEndpoint(absoluteUrl)
      ) {
        return absoluteUrl;
      }
    }

    return '';
  }).catch(() => '');

  if (!pdfUrl || pdfUrl.startsWith('blob:')) {
    return saveBlobPdfFromViewer(targetPage, candidateName, seenFileNames);
  }

  const response = await targetPage.context().request.get(pdfUrl, {
    headers: {
      referer: targetPage.url(),
      accept: 'application/pdf,*/*',
    },
    timeout: 30_000,
  }).catch(() => null);

  if (!response || !response.ok()) {
    return '';
  }

  const contentType = response.headers()['content-type'] || '';
  const body = await response.body();
  if (!looksLikePdf(body, contentType)) {
    return '';
  }

  return savePdfBuffer(body, candidateName, seenFileNames);
}

async function saveBlobPdfFromViewer(targetPage, candidateName, seenFileNames) {
  const bytes = await targetPage.evaluate(async () => {
    const candidates = [
      location.href,
      ...[...document.querySelectorAll('embed, iframe, object')]
        .map((node) => node.getAttribute('src') || node.getAttribute('data') || ''),
    ];
    const blobUrl = candidates.find((url) => url?.startsWith('blob:'));
    if (!blobUrl) {
      return null;
    }

    const response = await fetch(blobUrl);
    const buffer = await response.arrayBuffer();
    return Array.from(new Uint8Array(buffer));
  }).catch(() => null);

  if (!bytes?.length) {
    return '';
  }

  const buffer = Buffer.from(bytes);
  if (!looksLikePdf(buffer, 'application/pdf')) {
    return '';
  }

  return savePdfBuffer(buffer, candidateName, seenFileNames);
}

async function askForAttachmentResume(targetPage) {
  const bodyText = await targetPage.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  const alreadyRequested = bodyText.includes(zh.askedAttachmentResume);

  const locators = [
    targetPage.getByText(zh.askAttachmentResume, { exact: false }).last(),
    targetPage.getByText(zh.askAttachmentResumeAlt, { exact: false }).last(),
    targetPage.getByText(zh.requestAttachmentResume, { exact: false }).last(),
    targetPage.getByText(zh.getAttachmentResume, { exact: false }).last(),
    targetPage.getByRole('button', { name: askAttachmentPattern }).last(),
    targetPage.getByRole('link', { name: askAttachmentPattern }).last(),
  ];

  for (const locator of locators) {
    if (!(await locator.count().catch(() => 0))) {
      continue;
    }

    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.click({ timeout: 5000 }).catch(() => {});
    await settle(targetPage);
    return { clicked: true, alreadyRequested };
  }

  return { clicked: false, alreadyRequested };
}

async function savePdfDownload(download, candidateName, seenFileNames) {
  const suggestedName = sanitizeFileName(download.suggestedFilename() || '');
  const extension = normalizeExtension(path.extname(suggestedName) || '.pdf');

  if (extension !== '.pdf') {
    const tempDir = path.join(outputDir, '_discarded');
    await fs.mkdir(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, `${Date.now()}-${suggestedName || `download${extension}`}`);
    await download.saveAs(tempPath).catch(() => {});
    console.warn(`Ignored non-PDF attachment download: ${suggestedName || extension}`);
    return '';
  }

  const baseName = uniqueName(sanitizeFileName(candidateName), seenFileNames);
  const originalDir = path.join(outputDir, '_original');
  await fs.mkdir(originalDir, { recursive: true });

  const originalPath = path.join(originalDir, `${baseName}${extension}`);
  const pdfPath = path.join(outputDir, `${baseName}.pdf`);

  await download.saveAs(originalPath);
  await fs.copyFile(originalPath, pdfPath);

  if (!keepOriginal && originalPath !== pdfPath) {
    await fs.rm(originalPath, { force: true }).catch(() => {});
  }

  return pdfPath;
}

async function savePdfBuffer(buffer, candidateName, seenFileNames) {
  const baseName = uniqueName(sanitizeFileName(candidateName), seenFileNames);
  const pdfPath = path.join(outputDir, `${baseName}.pdf`);
  await fs.writeFile(pdfPath, buffer);
  return pdfPath;
}

function looksLikePdf(buffer, contentType) {
  const header = Buffer.from(buffer).subarray(0, 5).toString('ascii');
  return header === '%PDF-' || /application\/pdf/i.test(contentType || '');
}

function normalizeExtension(extension) {
  const value = String(extension || '').toLowerCase();
  return value.startsWith('.') ? value : `.${value}`;
}


async function saveDebugArtifacts(targetPage, index, name) {
  const debugDir = path.join(outputDir, '_debug');
  await fs.mkdir(debugDir, { recursive: true });
  const prefix = `${String(index).padStart(3, '0')}-${sanitizeFileName(name)}`;
  await targetPage.screenshot({ path: path.join(debugDir, `${prefix}.png`), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(debugDir, `${prefix}.html`), await targetPage.content()).catch(() => {});
  const clickables = await targetPage.evaluate(() => {
    return [...document.querySelectorAll('a, button, [role="button"], [tabindex]')]
      .map((node) => ({
        text: (node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
        className: String(node.className || ''),
        title: node.getAttribute('title') || '',
        aria: node.getAttribute('aria-label') || '',
        href: node.getAttribute('href') || '',
      }))
      .filter((item) => /\u9644\u4ef6|\u7b80\u5386|\u4e0b\u8f7d|attachment|resume|download/i.test(`${item.text} ${item.title} ${item.aria} ${item.href} ${item.className}`))
      .slice(0, 200);
  }).catch(() => []);
  await fs.writeFile(
    path.join(debugDir, `${prefix}.clickables.json`),
    JSON.stringify(clickables, null, 2),
  ).catch(() => {});
}

function sanitizeFileName(input) {
  const cleaned = String(input || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

  return cleaned || 'candidate';
}

function uniqueName(name, seen) {
  const safeName = name || 'candidate';
  const count = seen.get(safeName) || 0;
  seen.set(safeName, count + 1);
  return count === 0 ? safeName : `${safeName}-${count + 1}`;
}
