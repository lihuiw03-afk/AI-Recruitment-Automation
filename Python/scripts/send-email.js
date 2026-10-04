import dotenv from 'dotenv';
import path from 'node:path';
import process from 'node:process';
import { sendMail } from './mail-client.js';

dotenv.config();

const args = parseArgs(process.argv.slice(2));

if (args.help || args.h) {
  printHelp();
  process.exit(0);
}

try {
  const attachments = collectAttachments(args);
  const result = await sendMail({
    to: args.to,
    subject: args.subject,
    text: args.text,
    html: args.html,
    attachments,
  });

  console.log(`Email sent: ${result.messageId}`);
} catch (error) {
  console.error(`Email failed: ${error.message}`);
  process.exit(1);
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

function collectAttachments(parsedArgs) {
  const raw = parsedArgs.attach || parsedArgs.attachment;
  if (!raw) return undefined;

  return String(raw)
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((filePath) => ({
      filename: path.basename(filePath),
      path: path.resolve(filePath),
    }));
}

function printHelp() {
  console.log(`
Usage:
  npm run send:email -- --to "someone@example.com" --subject "测试邮件" --text "你好"

Options:
  --to <email>          Recipient email address. Use comma to send to multiple recipients.
  --subject <text>      Mail subject.
  --text <text>         Plain text body.
  --html <html>         HTML body.
  --attach <paths>      Attachment paths separated by semicolons.
`);
}
