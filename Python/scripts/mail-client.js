import nodemailer from 'nodemailer';

export function createMailTransport() {
  const user = process.env.MAIL_USER;
  const pass = process.env.MAIL_AUTH_CODE || process.env.MAIL_PASS;
  const host = process.env.SMTP_HOST || 'smtp.163.com';
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = String(process.env.SMTP_SECURE ?? 'true').toLowerCase() !== 'false';

  if (!user || !pass) {
    throw new Error('Missing MAIL_USER or MAIL_AUTH_CODE in environment.');
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
}

export async function sendMail({ to, subject, text, html, attachments }) {
  if (!to) throw new Error('Missing recipient: to');
  if (!subject) throw new Error('Missing mail subject');
  if (!text && !html) throw new Error('Missing mail content: text or html');

  const user = process.env.MAIL_USER;
  const fromName = process.env.MAIL_FROM_NAME || '';
  const from = fromName ? `"${fromName}" <${user}>` : user;
  const transporter = createMailTransport();

  return transporter.sendMail({
    from,
    to,
    subject,
    text,
    html,
    attachments,
  });
}
