import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_URL = 'https://rd6.zhaopin.com/app/recommend?jobNumber=CC133033330J40860627809&tab=recommend#sortType=recommend';
const DEFAULT_MESSAGE = '\u4f60\u597d\uff0c\u8bf7\u95ee\u60a8\u73b0\u5728\u8fd8\u5728\u770b\u673a\u4f1a\u5417\uff1f';

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  printHelp();
  process.exit(0);
}
const startUrl = args.url || DEFAULT_URL;
const userDataDir = path.resolve(args.profile || '.zhaopin-browser-profile');
const maxPeople = Number.parseInt(args.max || '0', 10);
const delayMs = Number.parseInt(args.delay || '3000', 10);
const minNavigationDelayMs = Number.parseInt(args['min-navigation-delay'] || '3000', 10);
let lastNavigationAt = 0;
const greetedStorePath = path.resolve(args.store || 'zhaopin-greeted-candidates.json');
const headless = Boolean(args.headless);
const autoStart = Boolean(args.auto);
const dryRun = Boolean(args['dry-run']);
const debug = Boolean(args.debug);
const message = (await loadMessage(args)).trim();
const greetedStore = await loadGreetedStore(greetedStorePath);

const zh = {
  login: '\u767b\u5f55',
  scanCode: '\u626b\u7801',
  password: '\u5bc6\u7801',
  send: '\u53d1\u9001',
  greeting: '\u6253\u62db\u547c',
  communicateNow: '\u7acb\u5373\u6c9f\u901a',
  communicate: '\u6c9f\u901a',
  chat: '\u804a\u4e00\u804a',
  interested: '\u611f\u5174\u8da3',
  contact: '\u8054\u7cfb',
  inviteInterview: '\u9080\u7ea6\u9762\u8bd5',
  continueChat: '\u7ee7\u7eed\u6c9f\u901a',
  sayHello: '\u6253\u4e2a\u62db\u547c',
};

const greetingPattern = new RegExp(
  `${zh.greeting}|${zh.sayHello}|${zh.communicateNow}|${zh.communicate}|${zh.chat}|${zh.interested}|${zh.contact}|${zh.inviteInterview}|hello|chat|message`,
  'i',
);
const sendPattern = new RegExp(`${zh.send}|send`, 'i');

if (!message) {
  console.error('Missing greeting message. Use --message "..." or --message-file ".\\message.txt".');
  process.exit(1);
}

const context = await chromium.launchPersistentContext(userDataDir, {
  headless,
  acceptDownloads: true,
  viewport: { width: 1440, height: 1000 },
  locale: 'zh-CN',
});

context.setDefaultTimeout(10_000);

const page = context.pages()[0] || await context.newPage();
await gotoIfNeeded(page, startUrl);

console.log('\nZhaopin recommend page opened.');
console.log(`Current URL: ${page.url()}`);
console.log(`Greeting message: ${message}`);
if (dryRun) {
  console.log('Dry run is enabled. The script will find buttons but will not send messages.');
}
console.log('Log in if needed and make sure the candidate recommendation list is visible.');
if (!autoStart) {
  console.log('Press Enter here to start auto greeting.\n');
  await waitForEnter();
}

await settle(page);
await ensureLoggedIn(page);
await waitForRecommendList(page);

let greeted = 0;
let skipped = 0;
let failed = 0;
let processed = 0;
let stableRounds = 0;
const seenThisRun = new Set();
const maxScrollRounds = 120;

for (let round = 0; round < maxScrollRounds; round += 1) {
  const targets = await collectGreetingTargets(page);
  const pending = targets.filter((target) => !hasProcessedCandidate(target));

  if (pending.length === 0) {
    stableRounds += 1;
    const moved = await scrollRecommendList(page);
    await page.waitForTimeout(800);

    if (!moved || stableRounds >= 5) {
      break;
    }

    continue;
  }

  stableRounds = 0;

  const target = pending[0];
  if (maxPeople > 0 && processed >= maxPeople) {
    break;
  }

  markSeenThisRun(target);
  processed += 1;
  console.log(`\n[${processed}${maxPeople > 0 ? `/${maxPeople}` : ''}] ${target.name || target.key}`);

  if (dryRun) {
    skipped += 1;
    console.log(`Dry run matched button: ${target.buttonText}`);
  } else {
    try {
      const sent = await greetCandidate(page, target, message);
      if (sent) {
        greeted += 1;
        markGreeted(greetedStore, target, message);
        await saveGreetedStore(greetedStorePath, greetedStore);
        console.log('Greeting sent and recorded.');
      } else {
        skipped += 1;
        console.warn('Greeting entry or send button was not found; skipped.');
        if (debug) {
          await saveDebugArtifacts(page, `skipped-${target.name || target.key}`);
        }
      }
    } catch (error) {
      failed += 1;
      console.warn(`Failed: ${error.message}`);
      if (debug) {
        await saveDebugArtifacts(page, `failed-${target.name || target.key}`).catch(() => {});
      }
    }
  }

  await page.waitForTimeout(delayMs);

  if (maxPeople > 0 && processed >= maxPeople) {
    break;
  }

  await scrollRecommendList(page);
  await page.waitForTimeout(800);
}

console.log(`\nDone. Greeted: ${greeted}. Skipped: ${skipped}. Failed: ${failed}.`);
await context.close();

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
  npm run zhaopin:greet -- --dry-run --max 5
  npm run zhaopin:greet -- --message "您好，方便沟通一下岗位机会吗？" --max 10

Options:
  --url <url>             Zhaopin recommend page URL.
  --message <text>        Greeting message.
  --message-file <path>   Read greeting message from a text file.
  --max <number>          Maximum candidates to greet. 0 or omitted means no limit.
  --delay <ms>            Delay between candidates. Default: 3000.
  --store <path>          JSON file recording greeted candidates.
  --dry-run               Find greeting buttons without sending messages.
  --debug                 Save screenshots and HTML on failures.
  --auto                  Start immediately without waiting for Enter.
  --headless              Run browser headless.
  --profile <path>        Browser profile directory. Default: .zhaopin-browser-profile.
`);
}

async function loadMessage(parsedArgs) {
  if (parsedArgs['message-file']) {
    return fs.readFile(path.resolve(parsedArgs['message-file']), 'utf8');
  }

  return parsedArgs.message || process.env.ZHAOPIN_GREETING_MESSAGE || DEFAULT_MESSAGE;
}

async function loadGreetedStore(storePath) {
  const text = await fs.readFile(storePath, 'utf8').catch(() => '');
  if (!text) {
    return { greeted: {} };
  }

  try {
    const parsed = JSON.parse(text);
    return { greeted: parsed.greeted || {} };
  } catch {
    return { greeted: {} };
  }
}

async function saveGreetedStore(storePath, store) {
  await fs.writeFile(storePath, JSON.stringify(store, null, 2));
}

function markGreeted(store, target, greetingMessage) {
  store.greeted[target.key] = {
    name: target.name || '',
    cardId: target.cardId || '',
    buttonText: target.buttonText || '',
    message: greetingMessage,
    greetedAt: new Date().toISOString(),
  };

  if (target.cardId && target.cardId !== target.key) {
    store.greeted[target.cardId] = store.greeted[target.key];
  }
}

function hasProcessedCandidate(target) {
  const keys = candidateKeys(target);
  return keys.some((key) => seenThisRun.has(key) || greetedStore.greeted[key]);
}

function markSeenThisRun(target) {
  for (const key of candidateKeys(target)) {
    seenThisRun.add(key);
  }
}

function candidateKeys(target) {
  return [target.key, target.cardId, target.name ? `name:${target.name}` : ''].filter(Boolean);
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
  const isLoginPage = await targetPage.evaluate((labels) => {
    return /passport\.zhaopin\.com|\/login/i.test(location.href)
      || new RegExp(`${labels.login}|${labels.scanCode}|${labels.password}`).test(document.body?.innerText || '');
  }, zh).catch(() => false);

  if (!isLoginPage) return;

  console.log('\nZhaopin redirected to the login page.');
  console.log('Please finish login in the opened browser, then press Enter here to continue.\n');
  await waitForEnter();
  await gotoIfNeeded(targetPage, startUrl).catch(() => {});
  await settle(targetPage);
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

async function waitForRecommendList(targetPage) {
  const ready = await targetPage.waitForFunction((patternText) => {
    const pattern = new RegExp(patternText, 'i');
    const buttons = [...document.querySelectorAll('button, a, [role="button"], [class*="btn"], [class*="Button"]')];
    return buttons.some((node) => pattern.test(`${node.textContent || ''} ${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''}`));
  }, greetingPattern.source, { timeout: 15_000 }).then(() => true).catch(() => false);

  const buttonCount = await targetPage.evaluate((patternText) => {
    const pattern = new RegExp(patternText, 'i');
    return [...document.querySelectorAll('button, a, [role="button"], [class*="btn"], [class*="Button"]')]
      .filter((node) => pattern.test(`${node.textContent || ''} ${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''}`))
      .map((node) => (node.textContent || node.getAttribute('aria-label') || node.getAttribute('title') || '').trim().replace(/\s+/g, ' '))
      .slice(0, 20);
  }, greetingPattern.source).catch(() => []);

  console.log(`Greeting buttons detected: ${buttonCount.length}`);
  if (buttonCount.length > 0) {
    console.log(`Button samples: ${buttonCount.join(' | ')}`);
  }

  if (!ready && debug) {
    await saveDebugArtifacts(targetPage, 'no-greeting-buttons');
  }
}

async function collectGreetingTargets(targetPage) {
  return targetPage.evaluate((patternText) => {
    const pattern = new RegExp(patternText, 'i');
    const buttonNodes = [...document.querySelectorAll('button, a, [role="button"], [class*="btn"], [class*="Button"]')]
      .filter((node) => {
        const clickable = node.closest('button, a, [role="button"]') || node;
        if (clickable !== node) return false;

        const text = `${node.textContent || ''} ${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''}`.trim();
        const disabled = node.disabled || node.getAttribute('aria-disabled') === 'true';
        const rect = node.getBoundingClientRect();
        return !disabled && rect.width > 0 && rect.height > 0 && pattern.test(text);
      });

    const findCard = (node) => {
      const preferred = node.closest('.recommend-item, .recommend-resume-item');
      if (preferred) return preferred;

      const broad = node.closest('[class*="recommend-resume-item"], [class*="RecommendResumeItem"]');
      if (broad) return broad;

      let current = node.parentElement;
      while (current && current !== document.body) {
        const text = (current.textContent || '').trim().replace(/\s+/g, ' ');
        const rect = current.getBoundingClientRect();
        const className = String(current.className || '');
        if (
          /\brecommend-item\b|\brecommend-resume-item\b/.test(className)
          || (text.length > 80 && rect.width > 300 && rect.height > 80 && !/action|button/i.test(className))
        ) {
          return current;
        }
        current = current.parentElement;
      }

      return node.parentElement;
    };

    const seen = new Set();
    return buttonNodes.map((node, index) => {
      const card = findCard(node);
      const nameNode = card?.querySelector('[class*="name"], [class*="Name"], [title]')
        || card?.querySelector('strong, h3, h4');
      const rawName = nameNode?.getAttribute('title') || nameNode?.textContent || '';
      const buttonText = (node.textContent || node.getAttribute('aria-label') || node.getAttribute('title') || '')
        .trim()
        .replace(/\s+/g, ' ');
      const href = card?.querySelector('a[href]')?.getAttribute('href')
        || node.closest('a[href]')?.getAttribute('href')
        || '';
      const cardText = card?.textContent?.trim().replace(/\s+/g, ' ') || '';
      const nameMatch = cardText.match(/[\u4e00-\u9fa5]{1,4}(?:\u5148\u751f|\u5973\u58eb)/);
      const name = (nameMatch?.[0] || rawName).trim().replace(/\s+/g, ' ').slice(0, 60);
      const stableCardText = cardText
        .replace(pattern, '')
        .replace(/\d+\s*\u5206\u949f\u524d(?:\u6709\u56de\u590d|\u6d4f\u89c8\u8fc7\u804c\u4f4d|\u6709\u6295\u9012)?/g, '')
        .replace(/\d+\s*\u5c0f\u65f6\u524d(?:\u6709\u56de\u590d|\u6d4f\u89c8\u8fc7\u804c\u4f4d|\u6709\u6295\u9012)?/g, '')
        .replace(/\d+\s*\u5929\u524d(?:\u6709\u56de\u590d|\u6d4f\u89c8\u8fc7\u804c\u4f4d|\u6709\u6295\u9012)?/g, '')
        .replace(/\u534a\u5c0f\u65f6\u524d(?:\u6709\u56de\u590d|\u6d4f\u89c8\u8fc7\u804c\u4f4d|\u6709\u6295\u9012)?/g, '')
        .replace(/\u6709\u56de\u590d|\u6d4f\u89c8\u8fc7\u804c\u4f4d|\u6709\u6295\u9012|\u540c\u4e8b\u804a\u8fc7|\u6253\u7535\u8bdd/g, '')
        .replace(/\u4e0a\u73ed<\d+km/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240);
      const key = href || [name, stableCardText].filter(Boolean).join('|');
      const cardIndex = card?.getAttribute('data-index') || '';
      const cardId = [
        name,
        cardIndex ? `idx:${cardIndex}` : '',
        stableCardText.slice(0, 160),
      ].filter(Boolean).join('|');

      if (seen.has(key) || seen.has(cardId)) {
        return null;
      }
      seen.add(key);
      seen.add(cardId);

      node.setAttribute('data-codex-greeting-target', String(index));
      return { index, name, buttonText, key, cardId };
    }).filter(Boolean);
  }, greetingPattern.source).catch(() => []);
}

async function greetCandidate(targetPage, target, greetingMessage) {
  const locator = targetPage.locator(`[data-codex-greeting-target="${target.index}"]`).first();
  if (!(await locator.count().catch(() => 0))) return false;

  const popupPromise = targetPage.context().waitForEvent('page', { timeout: 3000 }).catch(() => null);
  const clicked = await clickGreetingTarget(targetPage, target.index);
  if (!clicked) return false;

  const popup = await popupPromise;
  const activePage = popup || targetPage;
  await settle(activePage);

  const filled = await fillGreetingMessage(activePage, greetingMessage);
  if (!filled) {
    const alreadySent = await hasGreetingSuccessSafe(activePage);
    if (alreadySent) {
      if (popup) await popup.close().catch(() => {});
      return true;
    }

    if (popup) await popup.close().catch(() => {});
    return false;
  }

  const sent = await clickSend(activePage);
  if (popup) await popup.close().catch(() => {});
  return sent;
}

async function clickGreetingTarget(targetPage, targetIndex) {
  await targetPage.evaluate((index) => {
    const node = document.querySelector(`[data-codex-greeting-target="${index}"]`);
    const card = node?.closest('.recommend-item, .recommend-resume-item');
    (card || node)?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, targetIndex).catch(() => {});

  await targetPage.waitForTimeout(300);
  await suppressBlockingOverlays(targetPage);

  const locator = targetPage.locator(`[data-codex-greeting-target="${targetIndex}"]`).first();
  await locator.scrollIntoViewIfNeeded().catch(() => {});

  try {
    await locator.click({ timeout: 5000 });
    await restoreBlockingOverlays(targetPage);
    return true;
  } catch (error) {
    if (debug) {
      console.warn(`Normal click was blocked, trying DOM click: ${error.message.split('\n')[0]}`);
    }
  }

  const clicked = await targetPage.evaluate((index) => {
    const node = document.querySelector(`[data-codex-greeting-target="${index}"]`);
    if (!node) return false;

    node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
    node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    node.click();
    return true;
  }, targetIndex).catch(() => false);

  await restoreBlockingOverlays(targetPage);
  return clicked;
}

async function suppressBlockingOverlays(targetPage) {
  await targetPage.keyboard.press('Escape').catch(() => {});
  await targetPage.evaluate(() => {
    const selectors = [
      '.im-widget',
      '.sticky-pane',
      '.talent-job',
      '[page-type="recommend"].sticky-pane',
      '[class*="popover"]',
      '[class*="Popover"]',
      '[class*="tooltip"]',
      '[class*="Tooltip"]',
    ];

    for (const node of document.querySelectorAll(selectors.join(','))) {
      if (!(node instanceof HTMLElement)) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      node.setAttribute('data-codex-old-pointer-events', node.style.pointerEvents || '');
      node.style.pointerEvents = 'none';
    }
  }).catch(() => {});
}

async function restoreBlockingOverlays(targetPage) {
  await targetPage.evaluate(() => {
    for (const node of document.querySelectorAll('[data-codex-old-pointer-events]')) {
      if (!(node instanceof HTMLElement)) continue;
      node.style.pointerEvents = node.getAttribute('data-codex-old-pointer-events') || '';
      node.removeAttribute('data-codex-old-pointer-events');
    }
  }).catch(() => {});
}

async function hasGreetingSuccess(targetPage) {
  const text = await targetPage.locator('body').innerText({ timeout: 2000 }).catch(() => '');
  return /已打招呼|已发送|发送成功|已沟通|继续沟通/.test(text);
}

async function hasGreetingSuccessSafe(targetPage) {
  const text = await targetPage.locator('body').innerText({ timeout: 2000 }).catch(() => '');
  return /\u5df2\u6253\u62db\u547c|\u5df2\u53d1\u9001|\u53d1\u9001\u6210\u529f|\u5df2\u6c9f\u901a|\u7ee7\u7eed\u6c9f\u901a/.test(text);
}

async function fillGreetingMessage(targetPage, greetingMessage) {
  const locators = [
    targetPage.locator('textarea').last(),
    targetPage.locator('div[contenteditable="true"]').last(),
    targetPage.locator('[role="textbox"]').last(),
    targetPage.locator('input[type="text"]').last(),
  ];

  for (const locator of locators) {
    if (!(await locator.count().catch(() => 0))) continue;

    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.click({ timeout: 3000 }).catch(() => {});
    await locator.fill(greetingMessage, { timeout: 3000 }).catch(async () => {
      await targetPage.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
      await targetPage.keyboard.type(greetingMessage, { delay: 10 }).catch(() => {});
    });

    const currentText = await locator.evaluate((node) => node.value || node.textContent || '').catch(() => '');
    if (currentText.includes(greetingMessage.slice(0, Math.min(greetingMessage.length, 12)))) {
      return true;
    }
  }

  return false;
}

async function clickSend(targetPage) {
  const sendLocators = [
    targetPage.getByRole('button', { name: sendPattern }).last(),
    targetPage.getByText(zh.send, { exact: false }).last(),
    targetPage.locator('button, [role="button"]').filter({ hasText: sendPattern }).last(),
  ];

  for (const locator of sendLocators) {
    if (!(await locator.count().catch(() => 0))) continue;

    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.click({ timeout: 5000 }).catch(() => {});
    await targetPage.waitForTimeout(800);
    return true;
  }

  return false;
}

async function scrollRecommendList(targetPage) {
  return targetPage.evaluate(() => {
    const candidates = [
      ...document.querySelectorAll('[class*="recommend"], [class*="Recommend"], [class*="list"], [class*="List"], [class*="scroll"], [class*="Scroll"], main, section'),
    ];

    const list = candidates
      .filter((node) => node instanceof HTMLElement)
      .find((node) => node.scrollHeight > node.clientHeight + 200);

    if (!list) {
      const before = window.scrollY;
      window.scrollBy(0, Math.floor(window.innerHeight * 0.8));
      return window.scrollY !== before;
    }

    const before = list.scrollTop;
    list.scrollTop = Math.min(list.scrollTop + Math.max(list.clientHeight * 0.85, 500), list.scrollHeight);
    list.dispatchEvent(new Event('scroll', { bubbles: true }));
    return list.scrollTop !== before;
  }).catch(() => false);
}

async function saveDebugArtifacts(targetPage, name) {
  const debugDir = path.resolve('zhaopin-greeting-debug');
  await fs.mkdir(debugDir, { recursive: true });
  const prefix = `${Date.now()}-${sanitizeFileName(name)}`;
  await targetPage.screenshot({ path: path.join(debugDir, `${prefix}.png`), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(debugDir, `${prefix}.html`), await targetPage.content()).catch(() => {});
}

function sanitizeFileName(input) {
  const cleaned = String(input || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

  return cleaned || 'candidate';
}
