import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { isBeijingUniversity } from './beijing-universities.js';

const DEFAULT_MESSAGE = '\u60a8\u597d\uff0c\u611f\u8c22\u60a8\u6295\u9012\u6211\u4eec\u7684\u5c97\u4f4d\uff0c\u65b9\u4fbf\u8fdb\u4e00\u6b65\u6c9f\u901a\u5417\uff1f';

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  printHelp();
  process.exit(0);
}

const startUrl = args.url || args['job-url'];
const jobName = String(args['job-name'] || args.job || '').trim();
const jobNumber = String(args['job-number'] || extractJobKey(startUrl) || '').trim();
const jobKey = sanitizeStoreKey(args['job-key'] || extractJobKey(startUrl) || jobName || 'default-job');
const educationFilter = normalizeEducationFilter(args['education-filter'] || 'none');
const schoolLocationFilter = normalizeSchoolLocationFilter(args['school-location-filter'] || 'none');
const expectedCityFilter = normalizeExpectedCityFilter(args['expected-city-filter'] || 'all');
const userDataDir = path.resolve(args.profile || '.zhaopin-browser-profile-boss');
const maxPeople = Number.parseInt(args.max || '0', 10);
const delayMs = Number.parseInt(args.delay || '3000', 10);
const minNavigationDelayMs = Number.parseInt(args['min-navigation-delay'] || '3000', 10);
const sentStorePath = path.resolve(args.store || 'zhaopin-job-message-candidates.json');
const headless = Boolean(args.headless);
const autoStart = Boolean(args.auto);
const dryRun = Boolean(args['dry-run']);
const unviewedOnly = Boolean(args['unviewed-only']);
const debug = Boolean(args.debug);
const message = (await loadMessage(args)).trim();
const sentStore = await loadSentStore(sentStorePath);
let lastNavigationAt = 0;

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
  notSuitable: '\u4e0d\u5408\u9002',
  call: '\u6253\u7535\u8bdd',
  contact: '\u8054\u7cfb',
  inviteInterview: '\u9080\u7ea6\u9762\u8bd5',
  continueChat: '\u7ee7\u7eed\u6c9f\u901a',
  sayHello: '\u6253\u4e2a\u62db\u547c',
  canChat: '\u53ef\u4ee5\u804a\u804a',
  education: '\u5b66\u5386',
  moreFilters: '\u66f4\u591a\u7b5b\u9009',
  expectedCity: '\u671f\u671b\u5de5\u4f5c\u57ce\u5e02',
  unviewed: '\u672a\u770b\u8fc7',
};

const expectedCityFilterLabels = {
  all: '\u4e0d\u9650',
  job_location: '\u804c\u4f4d\u6240\u5728\u5730',
  non_job_location: '\u975e\u804c\u4f4d\u6240\u5728\u5730',
};

const educationFilterLabels = {
  none: '\u65e0',
  bachelor: '\u672c\u79d1',
  master: '\u7855\u58eb',
  doctor: '\u535a\u58eb',
};

const schoolLocationFilterLabels = {
  none: '\u65e0',
  beijing: '\u5317\u4eac\u9ad8\u6821',
  non_beijing: '\u975e\u5317\u4eac\u9ad8\u6821',
};

const contactPattern = new RegExp(
  `${zh.greeting}|${zh.sayHello}|${zh.communicateNow}|${zh.communicate}|${zh.chat}|${zh.canChat}|${zh.interested}|${zh.contact}|${zh.inviteInterview}|hello|chat|message`,
  'i',
);
const riskyDirectActionPattern = new RegExp(`${zh.call}|${zh.notSuitable}`, 'i');
const sendPattern = new RegExp(`${zh.send}|send`, 'i');

if (!startUrl) {
  console.error('Missing applicant page URL. Use --url "https://rd6.zhaopin.com/..."');
  process.exit(1);
}

if (!message) {
  console.error('Missing message. Use --message "..." or --message-file ".\\message.txt".');
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

console.log('\nZhaopin applicant messaging page opened.');
console.log(`Current URL: ${page.url()}`);
console.log(`Job: ${jobName || jobKey}`);
if (jobNumber) console.log(`Job number: ${jobNumber}`);
console.log(`Job key: ${jobKey}`);
console.log(`Education: ${educationFilterLabels[educationFilter]}`);
console.log(`Highest education school: ${schoolLocationFilterLabels[schoolLocationFilter]}`);
console.log(`Expected work city: ${expectedCityFilterLabels[expectedCityFilter]}`);
console.log(`Unviewed only: ${unviewedOnly ? 'yes' : 'no'}`);
console.log(`Message: ${message}`);
if (dryRun) {
  console.log('Dry run is enabled. Candidates will be detected but messages will not be sent.');
}
console.log('Log in if needed and make sure the job applicant list is visible.');
if (!autoStart) {
  console.log('Press Enter here to start applicant messaging.\n');
  await waitForEnter();
}

await settle(page);
await ensureLoggedIn(page);
await selectApplicantJob(page);
await applyEducationFilter(page);
await applyUnviewedOnlyFilter(page);
await applyExpectedCityFilter(page);
await waitForApplicantList(page);

let sent = 0;
let skipped = 0;
let failed = 0;
let processed = 0;
const seenThisRun = new Set();
const schoolFilterSeen = new Set();
const maxTraversalRounds = 2000;

for (let round = 0; round < maxTraversalRounds; round += 1) {
  if (hasReachedPeopleLimit()) break;

  const targets = await collectApplicantTargets(page);
  const eligibleTargets = targets.filter((target) => {
    if (matchesSchoolLocationFilter(target)) return true;

    const filterKey = candidateKeys(target)[0] || target.cardId || target.name;
    if (filterKey && !schoolFilterSeen.has(filterKey)) {
      schoolFilterSeen.add(filterKey);
      skipped += 1;
      console.log(`School filter skipped: ${target.name || target.key} / ${target.highestEducationSchool || 'unknown school'}`);
    }
    return false;
  });
  const pending = eligibleTargets.filter((target) => !hasProcessedCandidate(target));

  if (pending.length === 0) {
    console.log('No eligible candidates remain on the current page. Loading more candidates.');
    const loadedMore = await loadMoreApplicants(page);
    if (!loadedMore) {
      console.log('No more applicant pages or list items are available.');
      break;
    }

    continue;
  }

  const target = pending[0];
  markSeenThisRun(target);
  processed += 1;
  const progress = dryRun
    ? `preview ${processed}${maxPeople > 0 ? `/${maxPeople}` : ''}`
    : `attempt ${processed}, sent ${sent}${maxPeople > 0 ? `/${maxPeople}` : ''}`;
  console.log(`\n[${progress}] ${target.name || target.key}`);

  if (dryRun) {
    skipped += 1;
    console.log(`Dry run matched button: ${target.buttonText}`);
    console.log(`Highest education school: ${target.highestEducationSchool || 'unknown'}`);
    console.log(formatWorkflowResult('dry-run', target));
  } else if (riskyDirectActionPattern.test(target.buttonText || '')) {
    skipped += 1;
    console.warn(`Skipped risky direct-action button in non-dry-run mode: ${target.buttonText}`);
  } else {
    try {
      const delivered = await messageApplicant(page, target, message);
      if (delivered) {
        sent += 1;
        markSent(sentStore, target, message);
        await saveSentStore(sentStorePath, sentStore);
        console.log('Message sent and recorded.');
        console.log(formatWorkflowResult('sent', target));
      } else {
        skipped += 1;
        console.warn('Contact entry or send button was not found; skipped.');
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

  if (hasReachedPeopleLimit()) break;

  await scrollApplicantList(page);
  await page.waitForTimeout(800);
}

console.log(`\nDone. Sent: ${sent}. Attempted: ${processed}. Skipped: ${skipped}. Failed: ${failed}.`);
await context.close();

function hasReachedPeopleLimit() {
  if (maxPeople <= 0) return false;
  return dryRun ? processed >= maxPeople : sent >= maxPeople;
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
  npm run zhaopin:applicants -- --dry-run --url "https://rd6.zhaopin.com/..." --max 5
  npm run zhaopin:applicants -- --url "https://rd6.zhaopin.com/..." --job-name "Consultant" --message "Hello" --max 10

Options:
  --url <url>             Zhaopin job applicant page URL.
  --job-name <text>       Human-readable job name for logs.
  --job-number <text>     Zhaopin jobNumber to select in the applicant page.
  --job-key <text>        Stable job key for per-job dedupe. Defaults to jobNumber from URL.
  --education-filter      Education: none, bachelor, master, or doctor.
  --school-location-filter Highest education school: none, beijing, or non_beijing.
  --expected-city-filter  Expected work city: all, job_location, or non_job_location.
  --unviewed-only         Select the Zhaopin unviewed-candidates filter.
  --message <text>        Message text.
  --message-file <path>   Read message from a text file.
  --max <number>          Maximum successful sends. In dry-run mode, maximum matches to preview.
  --delay <ms>            Delay between candidates. Default: 3000.
  --store <path>          JSON file recording sent candidates.
  --dry-run               Detect candidates without sending messages.
  --debug                 Save screenshots and HTML on failures.
  --auto                  Start immediately without waiting for Enter.
  --headless              Run browser headless.
  --profile <path>        Browser profile directory. Default: .zhaopin-browser-profile-boss.
`);
}

async function loadMessage(parsedArgs) {
  if (parsedArgs['message-file']) {
    return fs.readFile(path.resolve(parsedArgs['message-file']), 'utf8');
  }

  return parsedArgs.message || process.env.ZHAOPIN_APPLICANT_MESSAGE || DEFAULT_MESSAGE;
}

async function loadSentStore(storePath) {
  const text = await fs.readFile(storePath, 'utf8').catch(() => '');
  if (!text) {
    return { jobs: {} };
  }

  try {
    const parsed = JSON.parse(text);
    return { jobs: parsed.jobs || {} };
  } catch {
    return { jobs: {} };
  }
}

async function saveSentStore(storePath, store) {
  await fs.writeFile(storePath, JSON.stringify(store, null, 2));
}

function markSent(store, target, sentMessage) {
  const jobRecord = ensureJobRecord(store);
  const record = {
    name: target.name || '',
    cardId: target.cardId || '',
    highestEducationSchool: target.highestEducationSchool || '',
    buttonText: target.buttonText || '',
    message: sentMessage,
    sentAt: new Date().toISOString(),
  };

  for (const key of candidateKeys(target)) {
    jobRecord.candidates[key] = record;
  }
}

function ensureJobRecord(store) {
  if (!store.jobs[jobKey]) {
    store.jobs[jobKey] = {
      jobName,
      jobUrl: startUrl,
      candidates: {},
    };
  }

  return store.jobs[jobKey];
}

function hasProcessedCandidate(target) {
  const jobRecord = ensureJobRecord(sentStore);
  const keys = candidateKeys(target);
  return keys.some((key) => seenThisRun.has(key) || jobRecord.candidates[key]);
}

function markSeenThisRun(target) {
  for (const key of candidateKeys(target)) {
    seenThisRun.add(key);
  }
}

function candidateKeys(target) {
  return [target.key, target.cardId, target.name ? `name:${target.name}` : ''].filter(Boolean);
}

function matchesSchoolLocationFilter(target) {
  if (schoolLocationFilter === 'none') return true;

  const school = String(target.highestEducationSchool || '').trim();
  if (!school || /^[-\u2014]+$/.test(school)) return false;

  const inBeijing = isBeijingUniversity(school);
  return schoolLocationFilter === 'beijing' ? inBeijing : !inBeijing;
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

async function selectApplicantJob(targetPage) {
  if (!jobNumber && !jobName) return;

  const currentJobNumber = extractJobKey(targetPage.url());
  if (jobNumber && currentJobNumber === jobNumber) {
    console.log('Applicant page is already filtered to the selected job.');
    return;
  }

  console.log(`Selecting applicant job filter: ${jobName || jobNumber}`);
  const selected = await selectJobInPage(targetPage, jobNumber, jobName);
  if (selected) {
    await settle(targetPage);
    console.log('Selected job in applicant page filter.');
    return;
  }

  if (jobNumber) {
    const fallbackUrl = buildApplicantUrl(targetPage.url(), jobNumber, jobName);
    console.log('Could not select job from the page filter; opening the job-specific applicant URL instead.');
    await saveDebugArtifacts(targetPage, 'job-filter-select-failed').catch(() => {});
    await gotoIfNeeded(targetPage, fallbackUrl);
    await settle(targetPage);
  }
}

async function applyEducationFilter(targetPage) {
  const targetLabel = educationFilterLabels[educationFilter];
  if (educationFilter === 'none') {
    console.log('Education filter: disabled.');
    return;
  }

  console.log(`Applying education filter: ${targetLabel}`);
  const selector = targetPage.locator('.edu-selector').first();
  const fallbackSelector = targetPage.locator('[placeholder="\u5b66\u5386"]').first();
  const trigger = await selector.count().catch(() => 0) ? selector : fallbackSelector;

  if (!(await trigger.count().catch(() => 0))) {
    await saveDebugArtifacts(targetPage, 'education-filter-not-found').catch(() => {});
    throw new Error('Could not find the Zhaopin education filter. Messaging was stopped.');
  }

  await trigger.scrollIntoViewIfNeeded().catch(() => {});
  await trigger.click({ timeout: 5000 });
  await targetPage.waitForTimeout(600);

  const selected = await targetPage.evaluate((label) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const popupRoots = [...document.querySelectorAll('.km-popper, .km-popover, [role="listbox"], [class*="dropdown"], [class*="Dropdown"]')]
      .filter(isVisible);
    const roots = popupRoots.length ? popupRoots : [document.body];

    for (const root of roots) {
      const matches = [...root.querySelectorAll('label, li, button, span, div, [role="option"], [role="checkbox"]')]
        .filter(isVisible)
        .filter((node) => normalize(node.textContent) === normalize(label));
      const textNode = matches.sort((left, right) => left.children.length - right.children.length)[0];
      if (!textNode) continue;

      const clickable = textNode.closest('label, li, button, [role="option"], [role="checkbox"], .km-checkbox, [class*="option"]') || textNode;
      clickable.scrollIntoView({ block: 'center', inline: 'nearest' });
      clickable.click();
      return true;
    }

    return false;
  }, targetLabel).catch(() => false);

  if (!selected) {
    await saveDebugArtifacts(targetPage, `education-${educationFilter}-not-found`).catch(() => {});
    throw new Error(`Could not select education filter: ${targetLabel}. Messaging was stopped.`);
  }

  await targetPage.waitForTimeout(600);
  const optionConfirmed = await targetPage.evaluate((label) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const popupRoots = [...document.querySelectorAll('.km-popper, .km-popover, [role="listbox"], [class*="dropdown"], [class*="Dropdown"]')]
      .filter(isVisible);
    const selector = document.querySelector('.edu-selector');

    if (!popupRoots.length && selector) {
      const selectorClass = String(selector.className || '');
      const selectorText = normalize(selector.textContent);
      if (/has-selected|is-selected|--selected/i.test(selectorClass) || selectorText.includes(normalize(label))) {
        return true;
      }
    }

    const nodes = popupRoots
      .flatMap((root) => [...root.querySelectorAll('label, li, span, div, [role="option"], [role="checkbox"]')])
      .filter(isVisible)
      .filter((node) => normalize(node.textContent) === normalize(label));

    return nodes.some((node) => {
      let current = node;
      for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
        const input = current.querySelector?.('input[type="checkbox"], input[type="radio"]');
        const className = String(current.className || '');
        if (input?.checked
          || current.getAttribute?.('aria-selected') === 'true'
          || current.getAttribute?.('aria-checked') === 'true'
          || /is-checked|--checked|selected|active/i.test(className)) {
          return true;
        }
      }
      return false;
    });
  }, targetLabel).catch(() => false);

  if (!optionConfirmed) {
    await saveDebugArtifacts(targetPage, `education-${educationFilter}-not-selected`).catch(() => {});
    throw new Error(`The education option could not be selected: ${targetLabel}. Messaging was stopped.`);
  }

  const submitted = await targetPage.evaluate((labels) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const popupRoots = [...document.querySelectorAll('.km-popper, .km-popover, [role="listbox"], [role="dialog"], [class*="dropdown"], [class*="Dropdown"]')]
      .filter(isVisible)
      .filter((root) => normalize(root.textContent).includes(normalize(labels.option)));

    for (const root of popupRoots) {
      const matches = [...root.querySelectorAll('button, a, span, div, [role="button"]')]
        .filter(isVisible)
        .filter((node) => normalize(node.textContent) === normalize(labels.confirm));
      const textNode = matches.sort((left, right) => left.children.length - right.children.length)[0];
      if (!textNode) continue;

      const button = textNode.closest('button, a, [role="button"], .km-button') || textNode;
      button.scrollIntoView({ block: 'center', inline: 'nearest' });
      button.click();
      return true;
    }

    return false;
  }, {
    option: targetLabel,
    confirm: '\u786e\u5b9a',
  }).catch(() => false);

  if (!submitted) {
    await saveDebugArtifacts(targetPage, `education-${educationFilter}-confirm-not-found`).catch(() => {});
    throw new Error(`Could not confirm education filter: ${targetLabel}. Messaging was stopped.`);
  }

  await targetPage.waitForTimeout(1200);
  const applied = await trigger.evaluate((node, label) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
    const className = String(node.className || '');
    const text = normalize(node.textContent);
    const selectedCount = node.querySelector('.has-text-primary')?.textContent || '';
    return /has-selected|is-selected|--selected/i.test(className)
      || text.includes(normalize(label))
      || /[1-9]/.test(selectedCount);
  }, targetLabel).catch(() => false);

  if (!applied) {
    await saveDebugArtifacts(targetPage, `education-${educationFilter}-not-applied`).catch(() => {});
    throw new Error(`The education filter was not applied after confirmation: ${targetLabel}. Messaging was stopped.`);
  }

  console.log(`Education filter applied: ${targetLabel}`);
}

async function applyExpectedCityFilter(targetPage) {
  const targetLabel = expectedCityFilterLabels[expectedCityFilter];
  if (expectedCityFilter === 'all') {
    console.log('Expected work city filter: no restriction.');
    return;
  }

  console.log(`Applying expected work city filter: ${targetLabel}`);

  const moreButton = targetPage.locator('.filters-more__btn').first();
  const fallbackButton = targetPage.getByText(zh.moreFilters, { exact: true }).first();
  const trigger = await moreButton.count().catch(() => 0) ? moreButton : fallbackButton;

  if (!(await trigger.count().catch(() => 0))) {
    await saveDebugArtifacts(targetPage, 'expected-city-more-filter-not-found').catch(() => {});
    throw new Error('Could not find the Zhaopin more filters button. Expected city filter was not applied.');
  }

  await trigger.scrollIntoViewIfNeeded().catch(() => {});
  await trigger.click({ timeout: 5000 });
  await targetPage.waitForTimeout(700);

  let selected = await clickExpectedCityOption(targetPage, targetLabel);
  if (!selected) {
    const openedSelector = await openExpectedCitySelector(targetPage);
    if (openedSelector) {
      await targetPage.waitForTimeout(500);
      selected = await clickExpectedCityOption(targetPage, targetLabel);
    }
  }

  if (!selected) {
    await saveDebugArtifacts(targetPage, `expected-city-${expectedCityFilter}-not-found`).catch(() => {});
    throw new Error(`Could not select expected work city filter: ${targetLabel}. Messaging was stopped.`);
  }

  await targetPage.waitForTimeout(400);
  await confirmMoreFilters(targetPage);
  await targetPage.waitForTimeout(1200);
  console.log(`Expected work city filter applied: ${targetLabel}`);
}

async function applyUnviewedOnlyFilter(targetPage) {
  if (!unviewedOnly) {
    console.log('Unviewed-only filter: disabled.');
    return;
  }

  console.log('Applying unviewed-only filter.');
  const primary = targetPage.locator('.filter-checkbox').filter({ hasText: zh.unviewed }).first();
  const fallbackLabel = targetPage.getByText(zh.unviewed, { exact: true }).first();
  const container = await primary.count().catch(() => 0)
    ? primary
    : fallbackLabel.locator('xpath=ancestor::*[self::label or contains(@class, "checkbox")][1]');

  if (!(await container.count().catch(() => 0))) {
    await saveDebugArtifacts(targetPage, 'unviewed-filter-not-found').catch(() => {});
    throw new Error('Could not find the Zhaopin unviewed filter. Messaging was stopped.');
  }

  const isChecked = async () => {
    const input = container.locator('input[type="checkbox"]').first();
    if (await input.count().catch(() => 0)) {
      return input.isChecked().catch(() => false);
    }

    return container.evaluate((node) => {
      const className = String(node.className || '');
      return /is-checked|--checked|selected|active/i.test(className)
        || node.getAttribute('aria-checked') === 'true';
    }).catch(() => false);
  };

  if (!(await isChecked())) {
    await container.scrollIntoViewIfNeeded().catch(() => {});
    await container.click({ timeout: 5000 });
    await targetPage.waitForTimeout(1000);
  }

  if (!(await isChecked())) {
    await saveDebugArtifacts(targetPage, 'unviewed-filter-not-selected').catch(() => {});
    throw new Error('The Zhaopin unviewed filter could not be confirmed. Messaging was stopped.');
  }

  console.log('Unviewed-only filter applied.');
}

async function openExpectedCitySelector(targetPage) {
  return targetPage.evaluate((labels) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const nodes = [...document.querySelectorAll('label, div, span')]
      .filter(isVisible)
      .filter((node) => normalize(node.textContent) === normalize(labels.section));

    for (const label of nodes) {
      let container = label.parentElement;
      for (let depth = 0; container && depth < 5; depth += 1, container = container.parentElement) {
        const control = [...container.querySelectorAll('[role="combobox"], [data-popover="true"], .km-select, button, [role="button"]')]
          .find((node) => isVisible(node) && !node.contains(label));
        if (!control) continue;
        control.scrollIntoView({ block: 'center', inline: 'nearest' });
        control.click();
        return true;
      }
    }

    return false;
  }, { section: zh.expectedCity }).catch(() => false);
}

async function clickExpectedCityOption(targetPage, targetLabel) {
  return targetPage.evaluate((labels) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const sectionLabels = [...document.querySelectorAll('label, div, span')]
      .filter(isVisible)
      .filter((node) => normalize(node.textContent) === normalize(labels.section));
    const scopes = [];

    for (const sectionLabel of sectionLabels) {
      let container = sectionLabel.parentElement;
      for (let depth = 0; container && depth < 6; depth += 1, container = container.parentElement) {
        const text = normalize(container.textContent);
        if (text.includes(normalize(labels.target)) && text.length < 600) {
          scopes.push(container);
          break;
        }
      }
    }

    const popupScopes = [...document.querySelectorAll('.km-popper, .km-popover, [role="listbox"], [role="dialog"], [class*="dropdown"], [class*="Dropdown"]')]
      .filter(isVisible);
    const roots = [...scopes, ...popupScopes];

    for (const root of roots) {
      const matches = [...root.querySelectorAll('label, li, button, a, span, div, [role="option"], [role="radio"], [role="menuitem"]')]
        .filter(isVisible)
        .filter((node) => normalize(node.textContent) === normalize(labels.target));
      const textNode = matches.sort((left, right) => left.children.length - right.children.length)[0];
      if (!textNode) continue;

      const clickable = textNode.closest('label, li, button, a, [role="option"], [role="radio"], [role="menuitem"], .km-radio, .km-checkbox') || textNode;
      clickable.scrollIntoView({ block: 'center', inline: 'nearest' });
      clickable.click();
      return true;
    }

    return false;
  }, {
    section: zh.expectedCity,
    target: targetLabel,
  }).catch(() => false);
}

async function confirmMoreFilters(targetPage) {
  const confirmPattern = /^(\u786e\u5b9a|\u5e94\u7528|\u7b5b\u9009)$/;
  const buttons = targetPage.locator('button:visible, [role="button"]:visible');
  const count = await buttons.count().catch(() => 0);

  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    const text = (await button.innerText().catch(() => '')).replace(/\s+/g, '').trim();
    if (!confirmPattern.test(text)) continue;
    await button.click({ timeout: 3000 }).catch(() => {});
    return true;
  }

  return false;
}

function normalizeExpectedCityFilter(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['all', 'job_location', 'non_job_location'].includes(normalized)) return normalized;
  throw new Error(`Invalid --expected-city-filter value: ${value}`);
}

function normalizeEducationFilter(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['none', 'bachelor', 'master', 'doctor'].includes(normalized)) return normalized;
  throw new Error(`Invalid --education-filter value: ${value}`);
}

function normalizeSchoolLocationFilter(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['none', 'beijing', 'non_beijing'].includes(normalized)) return normalized;
  throw new Error(`Invalid --school-location-filter value: ${value}`);
}

async function selectJobInPage(targetPage, selectedJobNumber, selectedJobName) {
  const clickedSelector = await clickJobSelector(targetPage);
  if (!clickedSelector) return false;

  await targetPage.waitForTimeout(800);

  const clickedByName = await clickJobOption(targetPage, selectedJobName, selectedJobNumber);
  if (clickedByName) {
    await targetPage.waitForTimeout(1500);
    const verified = await verifySelectedJob(targetPage, selectedJobName, selectedJobNumber);
    if (verified) return true;
  }

  return false;
}

async function clickJobSelector(targetPage) {
  const selectorLocators = [
    targetPage.locator('.job-selector').first(),
    targetPage.locator('[placeholder="\u5168\u90e8\u804c\u4f4d"]').first(),
    targetPage.locator('[title="\u5168\u90e8\u804c\u4f4d"]').first(),
    targetPage.locator('.candidate-filters-panel .km-select').first(),
  ];

  for (const locator of selectorLocators) {
    if (!(await locator.count().catch(() => 0))) continue;
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.click({ timeout: 3000 }).catch(() => {});
    const opened = await hasVisibleJobOptions(targetPage);
    if (opened) return true;
  }

  const opened = await targetPage.evaluate((labels) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const nodes = [...document.querySelectorAll('button, a, [role="button"], [role="combobox"], [class*="select"], [class*="Select"], [class*="dropdown"], [class*="Dropdown"], [class*="job"], [class*="Job"], div, span')]
      .filter(isVisible)
      .filter((node) => {
        const text = normalize(node.textContent || node.getAttribute('title') || node.getAttribute('aria-label') || '');
        if (!text || text.length > 80) return false;
        return text.includes(labels.all) || text.includes(labels.jobName);
      });

    const preferred = nodes.find((node) => {
      const className = String(node.className || '');
      const role = node.getAttribute('role') || '';
      return /select|dropdown|job|filter|active/i.test(`${className} ${role}`)
        || ['BUTTON', 'A'].includes(node.tagName);
    }) || nodes[0];

    if (!preferred) return false;
    preferred.scrollIntoView({ block: 'center', inline: 'nearest' });
    preferred.click();
    return true;
  }, {
    all: '\u4e0d\u9650',
    jobName: jobName || '',
  }).catch(() => false);

  if (!opened) return false;
  await targetPage.waitForTimeout(500);
  return hasVisibleJobOptions(targetPage);
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

async function clickJobOption(targetPage, selectedJobName, selectedJobNumber) {
  const clickedOption = await targetPage.evaluate((labels) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
    const name = normalize(labels.jobName);
    const number = normalize(labels.jobNumber);
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const popupRoots = [...document.querySelectorAll('.km-popper, .km-popover, [role="listbox"], [class*="dropdown"], [class*="Dropdown"]')]
      .filter(isVisible);
    const roots = popupRoots.length ? popupRoots : [document.body];

    const options = roots.flatMap((root) => [...root.querySelectorAll('li, button, a, [role="option"], [role="menuitem"], [class*="option"], [class*="Option"], [class*="item"], [class*="Item"], [title]')])
      .filter(isVisible)
      .filter((node) => {
        const text = normalize(`${node.textContent || ''} ${node.getAttribute('title') || ''} ${node.getAttribute('data-job-number') || ''} ${node.getAttribute('data-jobid') || ''}`);
        if (!text || text.length > 160) return false;
        return (number && text.includes(number)) || (name && text.includes(name));
      });

    const target = options.find((node) => {
      const text = normalize(`${node.textContent || ''} ${node.getAttribute('title') || ''}`);
      return name && text.includes(name);
    }) || options[0];

    if (!target) return false;
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    target.click();
    return true;
  }, {
    jobNumber: selectedJobNumber || '',
    jobName: selectedJobName || '',
  }).catch(() => false);

  return clickedOption;
}

async function verifySelectedJob(targetPage, selectedJobName, selectedJobNumber) {
  return targetPage.evaluate((labels) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
    const name = normalize(labels.jobName);
    const number = normalize(labels.jobNumber);
    const url = new URL(location.href);
    if (number && url.searchParams.get('jobNumber') === number) return true;

    const selectorText = normalize(document.querySelector('.job-selector')?.textContent || '');
    if (name && selectorText.includes(name)) return true;

    const visibleJobTitles = [...document.querySelectorAll('.resume-item__extra-job-title, [class*="extra-job-title"], [title]')]
      .map((node) => normalize(node.getAttribute('title') || node.textContent || ''))
      .filter(Boolean);
    return Boolean(name && visibleJobTitles.slice(0, 5).some((text) => text.includes(name)));
  }, {
    jobName: selectedJobName || '',
    jobNumber: selectedJobNumber || '',
  }).catch(() => false);
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

async function waitForApplicantList(targetPage) {
  const ready = await targetPage.waitForFunction((patternText) => {
    const pattern = new RegExp(patternText, 'i');
    const buttons = [...document.querySelectorAll('button, a, [role="button"], [class*="btn"], [class*="Button"]')];
    return buttons.some((node) => pattern.test(`${node.textContent || ''} ${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''}`));
  }, contactPattern.source, { timeout: 15_000 }).then(() => true).catch(() => false);

  const buttonSamples = await targetPage.evaluate((patternText) => {
    const pattern = new RegExp(patternText, 'i');
    return [...document.querySelectorAll('button, a, [role="button"], [class*="btn"], [class*="Button"]')]
      .filter((node) => pattern.test(`${node.textContent || ''} ${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''}`))
      .map((node) => (node.textContent || node.getAttribute('aria-label') || node.getAttribute('title') || '').trim().replace(/\s+/g, ' '))
      .slice(0, 20);
  }, contactPattern.source).catch(() => []);

  console.log(`Contact buttons detected: ${buttonSamples.length}`);
  if (buttonSamples.length > 0) {
    console.log(`Button samples: ${buttonSamples.join(' | ')}`);
  }

  if (!ready) {
    const pageSamples = await collectVisibleButtonSamples(targetPage);
    if (pageSamples.length > 0) {
      console.log(`Visible button text samples: ${pageSamples.join(' | ')}`);
    }
    await saveDebugArtifacts(targetPage, 'no-contact-buttons');
  }
}

async function collectVisibleButtonSamples(targetPage) {
  return targetPage.evaluate(() => {
    const seen = new Set();
    return [...document.querySelectorAll('button, a, [role="button"], [class*="btn"], [class*="Button"], [class*="button"], [class*="Button"]')]
      .filter((node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map((node) => (node.textContent || node.getAttribute('aria-label') || node.getAttribute('title') || '').trim().replace(/\s+/g, ' '))
      .filter((text) => {
        if (!text || text.length > 40 || seen.has(text)) return false;
        seen.add(text);
        return true;
      })
      .slice(0, 30);
  }).catch(() => []);
}

async function collectApplicantTargets(targetPage) {
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
      const preferred = node.closest([
        '.resume-table-item',
        '.applicant-item',
        '.delivery-item',
        '.deliver-item',
        '.resume-item',
        '.candidate-item',
        '.recommend-item',
        '.recommend-resume-item',
      ].join(','));
      if (preferred) return preferred;

      const broad = node.closest([
        '[class*="applicant"]',
        '[class*="Applicant"]',
        '[class*="delivery"]',
        '[class*="Delivery"]',
        '[class*="deliver"]',
        '[class*="Deliver"]',
        '[class*="resume"]',
        '[class*="Resume"]',
        '[class*="candidate"]',
        '[class*="Candidate"]',
      ].join(','));
      if (broad) return broad;

      let current = node.parentElement;
      while (current && current !== document.body) {
        const text = (current.textContent || '').trim().replace(/\s+/g, ' ');
        const rect = current.getBoundingClientRect();
        const className = String(current.className || '');
        if (
          /item|card|resume|candidate|applicant|delivery|deliver|list/i.test(className)
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
      const tableCells = card?.matches('tr')
        ? [...card.children].filter((child) => child.tagName === 'TD')
        : [];
      const educationCell = tableCells[4] || null;
      const schoolNode = educationCell?.querySelector('.resume-table-item__title, [title]')
        || card?.querySelector('[class*="education"] [title], [class*="Education"] [title], [class*="school"] [title], [class*="School"] [title]');
      const highestEducationSchool = (
        schoolNode?.getAttribute('title')
        || schoolNode?.textContent
        || educationCell?.textContent
        || ''
      ).trim().replace(/\s+/g, ' ').slice(0, 120);
      const nameMatch = cardText.match(/[\u4e00-\u9fa5]{1,4}(?:\u5148\u751f|\u5973\u58eb)/);
      const name = (nameMatch?.[0] || rawName).trim().replace(/\s+/g, ' ').slice(0, 60);
      const stableCardText = cardText
        .replace(pattern, '')
        .replace(/\d+\s*\u5206\u949f\u524d(?:\u6709\u56de\u590d|\u6d4f\u89c8\u8fc7\u804c\u4f4d|\u6709\u6295\u9012|\u6295\u9012)?/g, '')
        .replace(/\d+\s*\u5c0f\u65f6\u524d(?:\u6709\u56de\u590d|\u6d4f\u89c8\u8fc7\u804c\u4f4d|\u6709\u6295\u9012|\u6295\u9012)?/g, '')
        .replace(/\d+\s*\u5929\u524d(?:\u6709\u56de\u590d|\u6d4f\u89c8\u8fc7\u804c\u4f4d|\u6709\u6295\u9012|\u6295\u9012)?/g, '')
        .replace(/\u534a\u5c0f\u65f6\u524d(?:\u6709\u56de\u590d|\u6d4f\u89c8\u8fc7\u804c\u4f4d|\u6709\u6295\u9012|\u6295\u9012)?/g, '')
        .replace(/\u6709\u56de\u590d|\u6d4f\u89c8\u8fc7\u804c\u4f4d|\u6709\u6295\u9012|\u6295\u9012|\u540c\u4e8b\u804a\u8fc7|\u6253\u7535\u8bdd/g, '')
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

      node.setAttribute('data-codex-applicant-target', String(index));
      return { index, name, buttonText, key, cardId, highestEducationSchool };
    }).filter(Boolean);
  }, contactPattern.source).catch(() => []);
}

async function messageApplicant(targetPage, target, applicantMessage) {
  const locator = targetPage.locator(`[data-codex-applicant-target="${target.index}"]`).first();
  if (!(await locator.count().catch(() => 0))) return false;

  const popupPromise = targetPage.context().waitForEvent('page', { timeout: 3000 }).catch(() => null);
  const clicked = await clickApplicantTarget(targetPage, target.index);
  if (!clicked) return false;

  const popup = await popupPromise;
  const activePage = popup || targetPage;
  await settle(activePage);

  const isCanChatFlow = new RegExp(zh.canChat).test(target.buttonText || '');
  const filledGreetingModal = await fillCanChatCustomMessage(activePage, applicantMessage);
  if (filledGreetingModal) {
    const clickedModalSend = await clickSend(activePage);
    if (popup) await popup.close().catch(() => {});
    return clickedModalSend;
  }

  if (isCanChatFlow) {
    console.warn('Custom message field in the can-chat modal was not filled; skipped to avoid sending a default template.');
    await saveDebugArtifacts(activePage, `can-chat-custom-not-filled-${target.name || target.key}`).catch(() => {});
    if (popup) await popup.close().catch(() => {});
    return false;
  }

  const filled = await fillMessage(activePage, applicantMessage);
  if (!filled) {
    const alreadySent = await hasMessageSuccess(activePage);
    if (alreadySent) {
      if (popup) await popup.close().catch(() => {});
      return true;
    }

    if (popup) await popup.close().catch(() => {});
    return false;
  }

  const clickedSend = await clickSend(activePage);
  if (popup) await popup.close().catch(() => {});
  return clickedSend;
}

async function fillCanChatCustomMessage(targetPage, applicantMessage) {
  const modalVisible = await targetPage.waitForFunction(() => {
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const roots = [...document.querySelectorAll('[role="dialog"], .km-modal, .km-dialog, .km-popover, [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"]')];
    return roots.some((node) => isVisible(node) && /自定义|发送|打招呼|聊聊|沟通|消息/.test(node.textContent || ''));
  }, null, { timeout: 5000 }).then(() => true).catch(() => false);

  if (!modalVisible) return false;

  await targetPage.getByText('\u81ea\u5b9a\u4e49', { exact: false }).last().click({ timeout: 3000 }).catch(() => {});
  await targetPage.waitForTimeout(300);

  const fieldLocator = await findCanChatCustomField(targetPage);
  if (fieldLocator) {
    await fieldLocator.scrollIntoViewIfNeeded().catch(() => {});
    await fieldLocator.click({ timeout: 3000 }).catch(() => {});
    await fieldLocator.fill(applicantMessage, { timeout: 3000 }).catch(async () => {
      await targetPage.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
      await targetPage.keyboard.type(applicantMessage, { delay: 10 }).catch(() => {});
    });

    const typed = await fieldLocator.evaluate((node) => node.value || node.textContent || '').catch(() => '');
    if (typed.includes(applicantMessage.slice(0, Math.min(applicantMessage.length, 12)))) {
      console.log('Custom can-chat message field filled.');
      return true;
    }
  }

  const filled = await targetPage.evaluate((text) => {
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const roots = [...document.querySelectorAll('[role="dialog"], .km-modal, .km-dialog, .km-popover, [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"]')]
      .filter((node) => isVisible(node) && /自定义|发送|打招呼|聊聊|沟通|消息/.test(node.textContent || ''));
    const root = roots.at(-1) || document.body;

    const customNode = [...root.querySelectorAll('label, li, div, span, [role="radio"], [role="option"]')]
      .filter(isVisible)
      .find((node) => /自定义/.test(normalize(node.textContent || node.getAttribute('title') || '')));
    customNode?.click();

    const radioNodes = [...root.querySelectorAll('input[type="radio"], [role="radio"], .km-radio, [class*="radio"], [class*="Radio"]')]
      .filter(isVisible);
    if (!customNode && radioNodes.length >= 4) {
      radioNodes[3].click();
    }

    const fields = [...root.querySelectorAll('textarea, input[type="text"], input:not([type]), [contenteditable="true"], [role="textbox"]')]
      .filter(isVisible);
    const field = fields.find((node) => {
      const placeholder = normalize(node.getAttribute('placeholder') || '');
      const value = normalize(node.value || node.textContent || '');
      return /自定义|请输入|输入|内容|消息|招呼/.test(placeholder) || value.length === 0;
    }) || fields.at(-1);

    if (!field) return false;

    field.focus();
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      field.value = text;
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return field.value.includes(text.slice(0, Math.min(text.length, 12)));
    }

    field.textContent = text;
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return (field.textContent || '').includes(text.slice(0, Math.min(text.length, 12)));
  }, applicantMessage).catch(() => false);

  if (!filled && debug) {
    await saveDebugArtifacts(targetPage, 'can-chat-custom-fill-failed').catch(() => {});
  }

  return filled;
}

async function findCanChatCustomField(targetPage) {
  const locators = [
    targetPage.locator('[role="dialog"] textarea, [role="dialog"] input[type="text"], [role="dialog"] input:not([type]), [role="dialog"] [contenteditable="true"], [role="dialog"] [role="textbox"]').last(),
    targetPage.locator('.km-modal textarea, .km-modal input[type="text"], .km-modal input:not([type]), .km-modal [contenteditable="true"], .km-modal [role="textbox"]').last(),
    targetPage.locator('.km-dialog textarea, .km-dialog input[type="text"], .km-dialog input:not([type]), .km-dialog [contenteditable="true"], .km-dialog [role="textbox"]').last(),
    targetPage.locator('.km-popover textarea, .km-popover input[type="text"], .km-popover input:not([type]), .km-popover [contenteditable="true"], .km-popover [role="textbox"]').last(),
    targetPage.locator('textarea, input[type="text"], input:not([type]), [contenteditable="true"], [role="textbox"]').last(),
  ];

  for (const locator of locators) {
    if (!(await locator.count().catch(() => 0))) continue;
    const visible = await locator.evaluate((node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }).catch(() => false);
    if (visible) return locator;
  }

  return null;
}

async function clickApplicantTarget(targetPage, targetIndex) {
  await targetPage.evaluate((index) => {
    const node = document.querySelector(`[data-codex-applicant-target="${index}"]`);
    const card = node?.closest('[class*="item"], [class*="card"], [class*="resume"], [class*="candidate"], [class*="applicant"]');
    (card || node)?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, targetIndex).catch(() => {});

  await targetPage.waitForTimeout(300);
  await suppressBlockingOverlays(targetPage);

  const locator = targetPage.locator(`[data-codex-applicant-target="${targetIndex}"]`).first();
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
    const node = document.querySelector(`[data-codex-applicant-target="${index}"]`);
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

async function hasMessageSuccess(targetPage) {
  const text = await targetPage.locator('body').innerText({ timeout: 2000 }).catch(() => '');
  return /\u5df2\u6253\u62db\u547c|\u5df2\u53d1\u9001|\u53d1\u9001\u6210\u529f|\u5df2\u6c9f\u901a|\u7ee7\u7eed\u6c9f\u901a/.test(text);
}

async function fillMessage(targetPage, applicantMessage) {
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
    await locator.fill(applicantMessage, { timeout: 3000 }).catch(async () => {
      await targetPage.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
      await targetPage.keyboard.type(applicantMessage, { delay: 10 }).catch(() => {});
    });

    const currentText = await locator.evaluate((node) => node.value || node.textContent || '').catch(() => '');
    if (currentText.includes(applicantMessage.slice(0, Math.min(applicantMessage.length, 12)))) {
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
    const clicked = await locator.click({ timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (!clicked) continue;

    await targetPage.waitForTimeout(800);
    return true;
  }

  return false;
}

async function loadMoreApplicants(targetPage) {
  const changedPage = await goToNextApplicantPage(targetPage);
  if (changedPage) {
    console.log('Loaded the next applicant page.');
    return true;
  }

  const moved = await scrollApplicantList(targetPage);
  if (!moved) return false;

  const beforeCount = await targetPage.locator('.resume-table-item, .resume-item, .candidate-item, .applicant-item').count().catch(() => 0);
  await targetPage.waitForTimeout(1200);
  const afterCount = await targetPage.locator('.resume-table-item, .resume-item, .candidate-item, .applicant-item').count().catch(() => 0);
  console.log(`Scrolled applicant list${afterCount > beforeCount ? `; loaded ${afterCount - beforeCount} more rows` : ''}.`);
  return true;
}

async function goToNextApplicantPage(targetPage) {
  const pagination = targetPage.locator('.resume-list__pagination, .km-pagination').last();
  if (!(await pagination.count().catch(() => 0))) return false;

  const arrows = pagination.locator('.km-pagination__pager--arrow');
  const arrowCount = await arrows.count().catch(() => 0);
  if (!arrowCount) return false;

  const next = arrows.nth(arrowCount - 1);
  const disabled = await next.evaluate((node) => {
    const className = String(node.className || '');
    return node.hasAttribute('disabled')
      || node.getAttribute('aria-disabled') === 'true'
      || /disabled|is-disabled|--disabled/i.test(className);
  }).catch(() => true);
  if (disabled) return false;

  const before = await getApplicantPageState(targetPage);
  const clicked = await next.click({ timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!clicked) return false;

  const changed = await targetPage.waitForFunction((previous) => {
    const currentPage = document.querySelector('.resume-list__pagination .km-pagination__pager--current, .km-pagination .km-pagination__pager--current')?.textContent?.trim() || '';
    const firstRow = document.querySelector('.resume-table-item, .resume-item, .candidate-item, .applicant-item')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 240) || '';
    return currentPage !== previous.currentPage || firstRow !== previous.firstRow;
  }, before, { timeout: 10_000 }).then(() => true).catch(() => false);

  if (!changed) return false;
  await settle(targetPage);
  return true;
}

async function getApplicantPageState(targetPage) {
  return targetPage.evaluate(() => ({
    currentPage: document.querySelector('.resume-list__pagination .km-pagination__pager--current, .km-pagination .km-pagination__pager--current')?.textContent?.trim() || '',
    firstRow: document.querySelector('.resume-table-item, .resume-item, .candidate-item, .applicant-item')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 240) || '',
  })).catch(() => ({ currentPage: '', firstRow: '' }));
}

async function scrollApplicantList(targetPage) {
  return targetPage.evaluate(() => {
    const candidates = [
      ...document.querySelectorAll('[class*="applicant"], [class*="Applicant"], [class*="delivery"], [class*="Delivery"], [class*="resume"], [class*="Resume"], [class*="list"], [class*="List"], [class*="scroll"], [class*="Scroll"], main, section'),
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
  const debugDir = path.resolve('zhaopin-applicant-message-debug');
  await fs.mkdir(debugDir, { recursive: true });
  const prefix = `${Date.now()}-${sanitizeFileName(name)}`;
  await targetPage.screenshot({ path: path.join(debugDir, `${prefix}.png`), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(debugDir, `${prefix}.html`), await targetPage.content()).catch(() => {});
}

function formatWorkflowResult(status, target) {
  return `__WORKFLOW_RESULT__ ${JSON.stringify({
    type: 'zhaopin-applicant-message',
    status,
    jobKey,
    jobName,
    candidate: {
      name: target.name || '',
      key: target.key || '',
      cardId: target.cardId || '',
      highestEducationSchool: target.highestEducationSchool || '',
      schoolLocationFilter,
      buttonText: target.buttonText || '',
    },
  })}`;
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

function buildApplicantUrl(baseUrl, selectedJobNumber, selectedJobName) {
  const url = new URL('/app/candidate', baseUrl);
  url.searchParams.set('jobNumber', selectedJobNumber);
  if (selectedJobName) url.searchParams.set('jobTitle', selectedJobName);
  return url.href;
}

function sanitizeStoreKey(input) {
  return String(input || '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'default-job';
}

function sanitizeFileName(input) {
  const cleaned = String(input || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

  return cleaned || 'candidate';
}
