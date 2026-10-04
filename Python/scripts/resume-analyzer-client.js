import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_BACKEND_ANALYZE_URL = 'http://localhost:3001/api/analyze-resume';

export async function loadJobRequirements(args) {
  if (args['job-requirements-file']) {
    return fs.readFile(path.resolve(args['job-requirements-file']), 'utf8');
  }

  if (args['job-requirements']) {
    return String(args['job-requirements']);
  }

  if (process.env.JOB_REQUIREMENTS) {
    return process.env.JOB_REQUIREMENTS;
  }

  return '';
}

export async function analyzeResumePdf({
  pdfPath,
  candidateName,
  jobRequirements,
  backendUrl = DEFAULT_BACKEND_ANALYZE_URL,
  resultDir,
}) {
  const resolvedPdfPath = path.resolve(pdfPath);
  const resolvedResultDir = path.resolve(resultDir || path.join(path.dirname(resolvedPdfPath), '_analysis'));
  const buffer = await fs.readFile(resolvedPdfPath);
  const formData = new FormData();
  const blob = new Blob([buffer], { type: 'application/pdf' });

  formData.append('resume_file', blob, path.basename(resolvedPdfPath));
  formData.append('file_type', 'pdf');
  formData.append('job_requirements', jobRequirements.trim());

  const response = await fetch(backendUrl, {
    method: 'POST',
    body: formData,
  });

  const text = await response.text();
  const payload = parseResponseText(text);
  const result = {
    ok: response.ok,
    status: response.status,
    candidateName,
    resumePath: resolvedPdfPath,
    backendUrl,
    analyzedAt: new Date().toISOString(),
    response: payload,
  };

  await fs.mkdir(resolvedResultDir, { recursive: true });
  const outputPath = path.join(
    resolvedResultDir,
    `${sanitizeFileName(path.basename(resolvedPdfPath, path.extname(resolvedPdfPath)) || candidateName)}.json`,
  );
  await fs.writeFile(outputPath, JSON.stringify(result, null, 2));

  return {
    ...result,
    outputPath,
    summary: summarizeAnalysisPayload(payload),
  };
}

export function summarizeAnalysisPayload(payload) {
  const data = payload?.data ?? payload;
  const matchDetails = data?.match_details ?? {};
  const score = data?.match_score ?? matchDetails?.match_score;
  const recommendation = matchDetails?.recommendation ?? data?.recommendation;

  return [
    score !== undefined && score !== null ? `score=${score}` : '',
    recommendation ? `recommendation=${recommendation}` : '',
  ].filter(Boolean).join(', ') || 'result saved';
}

function parseResponseText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sanitizeFileName(input) {
  const cleaned = String(input || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

  return cleaned || 'candidate';
}
