import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_URL = 'https://rd6.zhaopin.com/app/im?sessionId=5c5f89cc0b8177f454f5cee77b820591';

const args = parseArgs(process.argv.slice(2));
const startUrl = args.url || DEFAULT_URL;
const outputDir = path.resolve(args.out || 'zhaopin-online-resumes');
const userDataDir = path.resolve(args.profile || '.zhaopin-browser-profile');
const maxPeople = Number.parseInt(args.max || '0', 10);
const minNavigationDelayMs = Number.parseInt(args['min-navigation-delay'] || '3000', 10);
let lastNavigationAt = 0;
const headless = Boolean(args.headless);
const autoStart = Boolean(args.auto);
const debug = Boolean(args.debug);

const zh = {
  viewDetail: '\u67e5\u770b\u8be6\u60c5',
  detail: '\u8be6\u60c5',
  fullResume: '\u5b8c\u6574\u7b80\u5386',
  work: '\u5de5\u4f5c\u7ecf\u5386',
  project: '\u9879\u76ee\u7ecf\u5386',
  education: '\u6559\u80b2\u7ecf\u5386',
  intent: '\u6c42\u804c\u671f\u671b',
  intentAlt: '\u6c42\u804c\u610f\u5411',
  selfIntro: '\u81ea\u6211\u8bc4\u4ef7',
  advantage: '\u4e2a\u4eba\u4f18\u52bf',
  skill: '\u4e13\u4e1a\u6280\u80fd',
};

const resumeSectionPattern = new RegExp(
  [
    zh.work,
    zh.project,
    zh.education,
    zh.intent,
    zh.intentAlt,
    zh.selfIntro,
    zh.advantage,
    zh.skill,
  ].join('|'),
);

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
  console.log('Press Enter here to click resume details and export the full resume.\n');
  await waitForEnter();
}

await settle(page);
await ensureLoggedIn(page);

const sessionTargets = await collectSessionTargets(page);
const total = maxPeople > 0 ? Math.min(maxPeople, sessionTargets.length) : sessionTargets.length;
const seenFileNames = new Map();
let exported = 0;

console.log(`Found ${sessionTargets.length} candidate conversations.`);

for (let index = 0; index < total; index += 1) {
  console.log(`\n[${index + 1}/${total}] Opening candidate conversation...`);

  try {
    const target = sessionTargets[index];
    const listName = target.name || `candidate-${index + 1}`;

    await openSessionTarget(page, target);
    await waitForResumePanel(page, listName);

    const check = await inspectRightResumePanel(page);
    if (!check.isResume) {
      console.warn(`No real resume panel for ${listName}: ${check.reason}`);
      if (debug) {
        await saveDebugArtifacts(page, index + 1, listName);
      }
      continue;
    }

    const panelName = await readRightPanelResumeName(page, listName);
    const detailTarget = await openFullResumeDetail(page);

    if (!detailTarget) {
      console.warn(`Could not open full resume detail for ${panelName}; skipped.`);
      if (debug) {
        await saveDebugArtifacts(page, index + 1, `${panelName}-no-detail`);
      }
      continue;
    }

    const detailCheck = await inspectMarkedResumeDetail(detailTarget.page);
    if (!detailCheck.isResume) {
      console.warn(`Full resume detail not detected for ${panelName}: ${detailCheck.reason}`);
      if (debug) {
        await saveDebugArtifacts(detailTarget.page, index + 1, `${panelName}-detail-not-found`);
      }
      await closeDetailTarget(detailTarget);
      continue;
    }

    const resumeName = await readMarkedResumeName(detailTarget.page, panelName);
    const fileName = uniqueName(sanitizeFileName(resumeName), seenFileNames);
    const pdfPath = path.join(outputDir, `${fileName}.pdf`);

    await printMarkedResumeDetail(detailTarget.page, pdfPath);
    await closeDetailTarget(detailTarget);

    exported += 1;
    console.log(`Exported: ${pdfPath}`);
  } catch (error) {
    console.warn(`Failed on candidate ${index + 1}: ${error.message}`);
    if (debug) {
      await saveDebugArtifacts(page, index + 1, `failed-${index + 1}`).catch(() => {});
    }
  }
}

console.log(`\nDone: exported ${exported}/${total} full resume PDFs.`);
console.log(`Output directory: ${outputDir}`);
await context.close();

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

async function collectSessionTargets(targetPage) {
  const stateSessions = await targetPage.evaluate(() => {
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
        resumeNumber: String(session.resumeNumber || ''),
      }));
  }).catch(() => []);

  if (stateSessions.length > 0) {
    return dedupeTargets(stateSessions);
  }

  const sessions = targetPage.locator('.im-session-item');
  const count = await sessions.count();
  const targets = [];

  for (let index = 0; index < count; index += 1) {
    targets.push({
      type: 'dom',
      index,
      name: await readSessionListName(sessions.nth(index), index + 1),
    });
  }

  return targets;
}

function dedupeTargets(targets) {
  const seen = new Set();
  const deduped = [];

  for (const target of targets) {
    const key = target.sessionId || `${target.name}-${target.index}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(target);
  }

  return deduped;
}

async function openSessionTarget(targetPage, target) {
  if (target.type === 'state' && target.sessionId) {
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

  const session = targetPage.locator('.im-session-item').nth(target.index);
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

async function readSessionListName(sessionLocator, fallbackIndex) {
  const name = await sessionLocator.locator('.im-session-item__name-title').first()
    .evaluate((node) => node.getAttribute('title') || node.textContent || '')
    .catch(() => '');

  return sanitizeFileName(name) || `candidate-${fallbackIndex}`;
}

async function waitForResumePanel(targetPage, expectedName = '') {
  await settle(targetPage);
  await targetPage.waitForSelector('.im-resume-detail .new-resume-basic__name, .im-resume-detail', {
    state: 'visible',
    timeout: 12_000,
  }).catch(() => {});

  await targetPage.waitForFunction(({ sectionSource, expected }) => {
    const panel = document.querySelector('.im-resume-detail');
    if (!panel) {
      return false;
    }

    const section = new RegExp(sectionSource);
    const text = panel.innerText || '';
    const panelName = (panel.querySelector('.new-resume-basic__name')?.textContent || '').trim();
    const nameMatches = expected && panelName === expected;
    return (nameMatches || !expected) && section.test(text);
  }, { sectionSource: resumeSectionPattern.source, expected: expectedName }, { timeout: 12_000 }).catch(() => {});
}

async function inspectRightResumePanel(targetPage) {
  return targetPage.evaluate((sectionSource) => {
    const panel = document.querySelector('.im-resume-detail');
    if (!panel) {
      return { isResume: false, reason: 'right resume panel not found' };
    }

    const text = panel.innerText || '';
    const section = new RegExp(sectionSource);
    const hasName = Boolean(panel.querySelector('.new-resume-basic__name'));
    const hasSection = section.test(text);
    const visible = panel.getBoundingClientRect().width > 0 && panel.getBoundingClientRect().height > 0;

    if (!visible) {
      return { isResume: false, reason: 'right resume panel is hidden' };
    }

    if (!hasName) {
      return { isResume: false, reason: 'resume name not found in panel' };
    }

    if (!hasSection) {
      return { isResume: false, reason: 'resume sections not found in panel' };
    }

    return { isResume: true, reason: 'right resume panel detected' };
  }, resumeSectionPattern.source).catch((error) => ({
    isResume: false,
    reason: error.message,
  }));
}

async function readRightPanelResumeName(targetPage, fallbackName) {
  const name = await targetPage.evaluate(() => {
    const candidates = [
      '.im-resume-detail .new-resume-basic__name',
      '.im-resume-detail [class*="basic"] [class*="name"]',
      '.im-resume-detail [class*="resume"] [class*="name"]',
      '.im-resume-detail [class*="name"]',
    ];

    for (const selector of candidates) {
      for (const node of document.querySelectorAll(selector)) {
        const value = (node.getAttribute('title') || node.textContent || '').trim().replace(/\s+/g, '');
        if (/^[\u4e00-\u9fa5]{2,6}$/.test(value)) {
          return value;
        }
      }
    }

    return '';
  }).catch(() => '');

  return name || fallbackName;
}

async function openFullResumeDetail(sourcePage) {
  await markExistingPages(sourcePage.context());

  const detailLocators = [
    sourcePage.getByText(zh.viewDetail, { exact: false }).last(),
    sourcePage.getByText(zh.fullResume, { exact: false }).last(),
    sourcePage.getByRole('button', { name: new RegExp(`${zh.viewDetail}|${zh.fullResume}|${zh.detail}`) }).last(),
    sourcePage.getByRole('link', { name: new RegExp(`${zh.viewDetail}|${zh.fullResume}|${zh.detail}`) }).last(),
    sourcePage.locator('.im-resume-detail .new-resume-basic').first(),
    sourcePage.locator('.im-resume-detail .hover-resume-content').first(),
    sourcePage.locator('.im-resume-detail').first(),
  ];

  for (const locator of detailLocators) {
    if (!(await locator.count().catch(() => 0))) {
      continue;
    }

    const target = await clickAndFindDetail(sourcePage, locator);
    if (target) {
      return target;
    }
  }

  return null;
}

async function markExistingPages(context) {
  for (const pageItem of context.pages()) {
    await pageItem.evaluate(() => {
      document.documentElement.dataset.codexExistingPage = 'true';
    }).catch(() => {});
  }
}

async function clickAndFindDetail(sourcePage, locator) {
  const context = sourcePage.context();
  const beforeUrl = sourcePage.url();
  const pagePromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);

  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.click({ timeout: 5000 }).catch(() => {});

  const newPage = await pagePromise;
  if (newPage) {
    await settle(newPage);
    const marked = await markFullResumeDetail(newPage);
    if (marked) {
      return { page: newPage, closeWhenDone: true };
    }

    await newPage.close().catch(() => {});
  }

  await settle(sourcePage);
  const markedSamePage = await markFullResumeDetail(sourcePage);
  if (markedSamePage) {
    return { page: sourcePage, closeWhenDone: false, samePageUrlBefore: beforeUrl };
  }

  return null;
}

async function markFullResumeDetail(targetPage) {
  await expandPossibleResumeSections(targetPage);

  return targetPage.evaluate((sectionSource) => {
    const section = new RegExp(sectionSource);
    const candidates = [
      '.km-modal__wrapper:not([style*="display: none"]) .km-modal',
      '.km-modal:not([style*="display: none"])',
      '.resume-detail',
      '[class*="resume-detail"]',
      '[class*="ResumeDetail"]',
      '[class*="resumeDetail"]',
      '.im-resume-detail',
      '.im-session-detail__three-aside',
      'main',
    ];

    let best = null;
    let bestScore = 0;

    for (const selector of candidates) {
      for (const node of document.querySelectorAll(selector)) {
        const rect = node.getBoundingClientRect();
        const text = node.innerText || '';
        if (rect.width < 240 || rect.height < 240 || !section.test(text)) {
          continue;
        }

        const score = text.length + rect.width * 2 + rect.height;
        if (score > bestScore) {
          best = node;
          bestScore = score;
        }
      }
    }

    if (!best) {
      return false;
    }

    document.querySelectorAll('[data-codex-full-resume]').forEach((node) => {
      node.removeAttribute('data-codex-full-resume');
    });
    best.setAttribute('data-codex-full-resume', 'true');
    return true;
  }, resumeSectionPattern.source).catch(() => false);
}

async function expandPossibleResumeSections(targetPage) {
  const expandTexts = [
    '\u5c55\u5f00',
    '\u67e5\u770b\u66f4\u591a',
    '\u66f4\u591a',
    '\u5168\u90e8',
  ];

  for (let round = 0; round < 3; round += 1) {
    let clicked = false;

    for (const textValue of expandTexts) {
      const locator = targetPage.getByText(textValue, { exact: false }).last();
      if (await locator.count().catch(() => 0)) {
        await locator.click({ timeout: 1000 }).then(() => {
          clicked = true;
        }).catch(() => {});
      }
    }

    if (!clicked) {
      break;
    }

    await targetPage.waitForTimeout(500);
  }
}

async function inspectMarkedResumeDetail(targetPage) {
  return targetPage.evaluate((sectionSource) => {
    const node = document.querySelector('[data-codex-full-resume="true"]');
    if (!node) {
      return { isResume: false, reason: 'marked full resume container not found' };
    }

    const section = new RegExp(sectionSource);
    const text = node.innerText || '';
    const rect = node.getBoundingClientRect();

    if (rect.width < 240 || rect.height < 240) {
      return { isResume: false, reason: 'full resume container is too small' };
    }

    if (!section.test(text)) {
      return { isResume: false, reason: 'resume sections not found in full detail' };
    }

    return { isResume: true, reason: 'full resume detail detected' };
  }, resumeSectionPattern.source).catch((error) => ({
    isResume: false,
    reason: error.message,
  }));
}

async function readMarkedResumeName(targetPage, fallbackName) {
  const name = await targetPage.evaluate(() => {
    const root = document.querySelector('[data-codex-full-resume="true"]') || document;
    const selectors = [
      '.new-resume-basic__name',
      '[class*="basic"] [class*="name"]',
      '[class*="resume"] [class*="name"]',
      '[class*="name"]',
      'h1',
      'h2',
      'h3',
    ];

    for (const selector of selectors) {
      for (const node of root.querySelectorAll(selector)) {
        const value = (node.getAttribute('title') || node.textContent || '').trim().replace(/\s+/g, '');
        if (/^[\u4e00-\u9fa5]{2,6}$/.test(value)) {
          return value;
        }
      }
    }

    return '';
  }).catch(() => '');

  return name || fallbackName;
}

async function printMarkedResumeDetail(targetPage, pdfPath) {
  const html = await buildPrintableResumeHtml(targetPage);
  const printPage = await targetPage.context().newPage();
  await printPage.setViewportSize({ width: 900, height: 1200 }).catch(() => {});
  await printPage.setContent(html, { waitUntil: 'domcontentloaded' });
  await printPage.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  const printCheck = await printPage.evaluate(() => ({
    textLength: (document.body.innerText || '').trim().length,
    height: document.body.scrollHeight,
    width: document.body.scrollWidth,
  }));

  if (printCheck.textLength < 80 || printCheck.height < 200) {
    await printPage.close().catch(() => {});
    throw new Error(`Printable resume content is too small: ${JSON.stringify(printCheck)}`);
  }

  await printPage.pdf({
    path: pdfPath,
    format: 'A4',
    printBackground: true,
    margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
  });
  await printPage.close().catch(() => {});
}

async function buildPrintableResumeHtml(targetPage) {
  const payload = await targetPage.evaluate(() => {
    const root = document.querySelector('[data-codex-full-resume="true"]');
    if (!root) {
      throw new Error('Printable resume root not found');
    }

    const clone = root.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, [class*="popover"], [class*="modal__close"], [class*="skeleton"], .resume-button, button').forEach((node) => {
      node.remove();
    });

    clone.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src');
      if (src?.startsWith('//')) {
        img.setAttribute('src', `${location.protocol}${src}`);
      } else if (src?.startsWith('/')) {
        img.setAttribute('src', new URL(src, location.origin).href);
      }
    });

    clone.querySelectorAll('[style]').forEach((node) => {
      const style = node.getAttribute('style') || '';
      const cleaned = style
        .replace(/height\s*:\s*calc\([^)]+\)\s*;?/gi, '')
        .replace(/height\s*:\s*\d+px\s*;?/gi, '')
        .replace(/max-height\s*:\s*[^;]+;?/gi, '')
        .replace(/overflow\s*:\s*(scroll|auto|hidden)\s*;?/gi, '')
        .replace(/margin-(right|bottom)\s*:\s*-\d+px\s*;?/gi, '');
      node.setAttribute('style', cleaned);
    });

    return {
      body: clone.outerHTML,
      css: [...document.styleSheets].map((sheet) => {
        try {
          return [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
        } catch {
          return '';
        }
      }).filter(Boolean).join('\n'),
      title: document.title,
    };
  });

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(payload.title || 'resume')}</title>
  <style>
    ${payload.css}
    @page {
      size: A4;
      margin: 10mm;
    }

    * {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    html,
    body {
      margin: 0;
      padding: 0;
      background: #fff;
      color: #1f2329;
      font-family: Arial, "Microsoft YaHei", "PingFang SC", sans-serif;
      font-size: 13px;
      line-height: 1.55;
    }

    .print-root {
      width: 760px;
      max-width: 100%;
      margin: 0 auto;
      background: #fff;
    }

    .km-scrollbar,
    .km-scrollbar__wrap,
    .km-scrollbar__view,
    [class*="scrollbar"] {
      height: auto !important;
      max-height: none !important;
      overflow: visible !important;
      margin: 0 !important;
    }

    [class*="popover"],
    [class*="modal__close"],
    [class*="skeleton"],
    .resume-button,
    button {
      display: none !important;
    }

    img {
      max-width: 100%;
    }
  </style>
</head>
<body>
  <main class="print-root">${payload.body}</main>
</body>
</html>`;
}

async function closeDetailTarget(target) {
  if (target.closeWhenDone) {
    await target.page.close().catch(() => {});
    return;
  }

  await target.page.keyboard.press('Escape').catch(() => {});

  if (target.samePageUrlBefore && target.page.url() !== target.samePageUrlBefore) {
    await target.page.goBack({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
    await settle(target.page);
  }
}

async function printRightResumePanel(targetPage, pdfPath) {
  await scrollResumePanelToTop(targetPage);
  await targetPage.addStyleTag({
    content: `
      @media print {
        @page {
          size: A4;
          margin: 10mm;
        }

        html,
        body,
        #app {
          width: auto !important;
          height: auto !important;
          min-height: 0 !important;
          margin: 0 !important;
          overflow: visible !important;
          background: #fff !important;
        }

        body * {
          visibility: hidden !important;
        }

        .im-session-detail__three-aside,
        .im-session-detail__three-aside * {
          visibility: visible !important;
        }

        .im-session-detail__three-aside {
          position: absolute !important;
          inset: 0 auto auto 0 !important;
          display: block !important;
          width: 760px !important;
          max-width: 100% !important;
          height: auto !important;
          max-height: none !important;
          overflow: visible !important;
          background: #fff !important;
        }

        .im-resume-detail,
        .im-resume-detail__main,
        .im-resume-detail .km-scrollbar,
        .im-resume-detail .km-scrollbar__wrap,
        .im-resume-detail .km-scrollbar__view {
          width: 100% !important;
          height: auto !important;
          max-height: none !important;
          margin: 0 !important;
          overflow: visible !important;
          background: #fff !important;
        }

        .im-resume-detail__top,
        .resume-button,
        [class*="popover"],
        [class*="modal"],
        [class*="skeleton"],
        img[src*="im-more"],
        img[src*="im-share"],
        img[src*="collection"] {
          display: none !important;
        }

        * {
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
          box-shadow: none !important;
        }
      }
    `,
  }).catch(() => {});

  await targetPage.pdf({
    path: pdfPath,
    format: 'A4',
    printBackground: true,
    margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
  });
}

async function scrollResumePanelToTop(targetPage) {
  await targetPage.evaluate(() => {
    for (const selector of [
      '.im-resume-detail__main .km-scrollbar__wrap',
      '.im-resume-detail .km-scrollbar__wrap',
      '.im-resume-detail__main',
      '.im-resume-detail',
    ]) {
      const node = document.querySelector(selector);
      if (node) {
        node.scrollTop = 0;
      }
    }
  }).catch(() => {});
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
      .filter((item) => /详情|完整|简历|detail|resume/i.test(`${item.text} ${item.title} ${item.aria} ${item.href} ${item.className}`))
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

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
