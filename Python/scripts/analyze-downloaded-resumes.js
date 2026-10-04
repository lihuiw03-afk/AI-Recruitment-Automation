import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  DEFAULT_BACKEND_ANALYZE_URL,
  analyzeResumePdf,
  loadJobRequirements,
} from './resume-analyzer-client.js';

const args = parseArgs(process.argv.slice(2));
const inputDir = path.resolve(args.dir || args.in || 'zhaopin-attachment-resumes');
const resultDir = path.resolve(args['result-dir'] || path.join(inputDir, '_analysis'));
const backendUrl = args['backend-url'] || DEFAULT_BACKEND_ANALYZE_URL;
const jobRequirements = (await loadJobRequirements(args)).trim();

if (!jobRequirements) {
  console.error('Missing job requirements. Use --job-requirements-file ".\\jd.txt" or --job-requirements "...".');
  process.exit(1);
}

const pdfFiles = (await fs.readdir(inputDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.pdf'))
  .map((entry) => path.join(inputDir, entry.name))
  .sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));

console.log(`Found ${pdfFiles.length} PDF resumes in ${inputDir}.`);
console.log(`Uploading to ${backendUrl}.`);

let analyzed = 0;
let failed = 0;

for (let index = 0; index < pdfFiles.length; index += 1) {
  const pdfPath = pdfFiles[index];
  const candidateName = path.basename(pdfPath, path.extname(pdfPath));
  console.log(`\n[${index + 1}/${pdfFiles.length}] ${candidateName}`);

  try {
    const result = await analyzeResumePdf({
      pdfPath,
      candidateName,
      jobRequirements,
      backendUrl,
      resultDir,
    });

    if (result.ok) {
      analyzed += 1;
      console.log(`Analyzed: ${result.summary}`);
      console.log(formatWorkflowResult(result));
    } else {
      failed += 1;
      console.warn(`Backend returned ${result.status}. Result saved: ${result.outputPath}`);
    }
  } catch (error) {
    failed += 1;
    console.warn(`Analyze failed: ${error.message}`);
  }
}

console.log(`\nDone. Analyzed: ${analyzed}. Failed: ${failed}.`);
console.log(`Analysis directory: ${resultDir}`);

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
