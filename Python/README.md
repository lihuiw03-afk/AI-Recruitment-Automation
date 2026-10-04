# Resume Workflow Backend

For `COZE_FILE_MODE=public_url`, `PUBLIC_BASE_URL` is optional. If it is not set, the backend uses the host from the incoming request to create uploaded file URLs.

## 163 Mail Send

The backend can send email through the configured 163 SMTP account. The local `.env` uses `MAIL_USER`, `MAIL_AUTH_CODE`, `SMTP_HOST`, and `IMAP_HOST`. For 163 mail, SMTP sending uses `smtp.163.com`; `imap.163.com` is kept for receiving mail.

Send a test email from the command line:

```powershell
npm run send:email -- --to "target@example.com" --subject "测试邮件" --text "你好"
```

Send through the backend API:

```powershell
curl -X POST http://localhost:3001/api/send-email `
  -H "Content-Type: application/json" `
  -d "{\"to\":\"target@example.com\",\"subject\":\"测试邮件\",\"text\":\"你好\"}"
```

## Zhaopin full resume PDF export

This uses your own browser session, opens each Zhaopin IM conversation, clicks the resume detail entry, and exports the full resume detail. It does not click the attachment download button, because that can return resume templates instead of the candidate's resume.

```powershell
npm run crawl:zhaopin
```

When the browser opens, log in if needed, make sure the candidate conversation list and right-side resume panel are visible, then press Enter in the terminal. PDFs are saved to `zhaopin-online-resumes`, named with the candidate's resume name.

Useful options: 

```powershell
npm run crawl:zhaopin -- --url "https://rd6.zhaopin.com/app/im?sessionId=..." --out ".\zhaopin-online-resumes" --max 10
```

The browser login state is stored in `.zhaopin-browser-profile`, so the second run should not require logging in again.

For testing, use a fresh output folder so old summary PDFs are not mixed with new full-detail PDFs:

```powershell
npm run crawl:zhaopin -- --max 3 --debug --out ".\zhaopin-full-resumes-test"
```

Add `--debug` to save screenshots, HTML, and a `*.clickables.json` file for candidates where the detail entry cannot be found:

```powershell
npm run crawl:zhaopin -- --max 3 --debug
```

The script opens each conversation by `sessionId` where possible, reads the real candidate name, clicks the resume detail/full-resume entry or the resume card, then renders the detected detail container in a clean print page.

## Zhaopin attachment resume request/download

This asks for attachment resumes when needed, opens the available attachment resume link once, and saves the PDF loaded in the browser PDF preview. HTML and PNG downloads are ignored. If Zhaopin redirects to login, finish login in the opened browser and press Enter in the terminal.

```powershell
npm run crawl:zhaopin-attachments -- --max 3 --debug --out ".\zhaopin-attachment-resumes"
```

By default, each downloaded PDF is uploaded to the local backend for matching analysis. Pass the JD text with one of these options:

```powershell
npm run crawl:zhaopin-attachments -- --job-requirements-file ".\jd.txt"
npm run crawl:zhaopin-attachments -- --job-requirements "粘贴 JD、岗位职责、任职要求..."
```

Useful options:

```powershell
npm run crawl:zhaopin-attachments -- --ask-only
npm run crawl:zhaopin-attachments -- --skip-ask
npm run crawl:zhaopin-attachments -- --wait-after-ask 15000
npm run crawl:zhaopin-attachments -- --keep-original
npm run crawl:zhaopin-attachments -- --no-analyze
npm run crawl:zhaopin-attachments -- --url "https://rd6.zhaopin.com/app/im" --job-number "JOB_NUMBER" --job-name "岗位名称" --unread-only --max-downloads --max 5
```

The attachment script keeps PDF bytes from the attachment preview, including Zhaopin `attachment.zhaopin.com/...downloadFileTemporary` PDF URLs. It does not repeatedly reopen the attachment link, and it does not save HTML or PNG files.
If `姓名.pdf` already exists in the output directory, that candidate is skipped before opening the conversation again.
When `--max` is not provided, the script scrolls the Zhaopin IM session list to load and process all available candidate conversations.
For message-page job crawling, pass `--job-number`/`--job-name` and optionally `--unread-only`. With `--max-downloads`, `--max` limits successfully downloaded PDFs instead of scanned conversations.

To analyze PDFs that have already been downloaded without opening Zhaopin again:

```powershell
npm run analyze:downloaded -- --dir ".\zhaopin-attachment-resumes" --job-requirements-file ".\jd.txt"
```

Analysis JSON files are saved to `zhaopin-attachment-resumes\_analysis` by default.

## Zhaopin recommend auto greeting

This opens a Zhaopin recommend page with your saved browser session and sends a custom greeting message to candidates.

Start with a dry run:

```powershell
npm run zhaopin:greet -- --dry-run --max 5
```

Send greetings:

```powershell
npm run zhaopin:greet -- --url "https://rd6.zhaopin.com/app/recommend?jobNumber=...&tab=recommend#sortType=recommend" --message "您好，我看了您的简历，觉得和我们岗位比较匹配，方便进一步沟通吗？" --max 10
npm run zhaopin:greet -- --auto
```

Useful options:

```powershell
npm run zhaopin:greet -- --message-file ".\greeting.txt"
npm run zhaopin:greet -- --delay 2000
npm run zhaopin:greet -- --store ".\zhaopin-greeted-candidates.json"
npm run zhaopin:greet -- --debug
```

The default greeting message is `你好`. The script records greeted candidates in `zhaopin-greeted-candidates.json`; candidates already in that file are skipped on later runs.
The script reuses `.zhaopin-browser-profile`. If Zhaopin redirects to login, finish login in the opened browser and press Enter in the terminal.

## Zhaopin active job sync

This opens the Zhaopin active jobs / job management page and reads the current recruiting jobs into `zhaopin-jobs.json`. It only reads page content. It does not message, call, invite, reject, or modify candidates.

```powershell
npm run zhaopin:sync-jobs -- --profile ".\.zhaopin-browser-profile-boss" --url "PASTE_ACTIVE_JOBS_PAGE_URL" --debug
```

In the frontend, paste the active jobs page URL into `在招职位页面链接`, click `同步智联岗位`, then the applicant-message job dropdown will load the synced jobs from the backend.

## Zhaopin job applicant batch message

This opens the applicant/delivery list page, selects the configured job in the page filter, and sends one message only to candidates in that job. Keep `--dry-run` enabled until the matched candidates are confirmed.

Start with a dry run:

```powershell
npm run zhaopin:applicants -- --profile ".\.zhaopin-browser-profile-boss" --dry-run --url "https://rd6.zhaopin.com/app/candidate?jobNumber=-1&jobTitle=%E4%B8%8D%E9%99%90" --job-number "JOB_NUMBER" --job-name "岗位名称" --max 5
```

Send messages after the dry run finds the right candidates:

```powershell
npm run zhaopin:applicants -- --profile ".\.zhaopin-browser-profile-boss" --url "https://rd6.zhaopin.com/app/candidate?jobNumber=-1&jobTitle=%E4%B8%8D%E9%99%90" --job-number "JOB_NUMBER" --job-name "岗位名称" --message "您好，感谢您投递我们公司的岗位，方便进一步沟通吗？" --max 10
```

Useful options:

```powershell
npm run zhaopin:applicants -- --job-key "job-1"
npm run zhaopin:applicants -- --job-number "CC133033330J40860627809"
npm run zhaopin:applicants -- --store ".\zhaopin-job-message-candidates.json"
npm run zhaopin:applicants -- --delay 2000
npm run zhaopin:applicants -- --debug
npm run zhaopin:applicants -- --education-filter "master"
npm run zhaopin:applicants -- --school-location-filter "beijing"
npm run zhaopin:applicants -- --expected-city-filter "job_location"
npm run zhaopin:applicants -- --unviewed-only
```

`--expected-city-filter` supports `all`, `job_location`, and `non_job_location`. The latter two open `更多筛选` and select `期望工作城市` before candidates are processed.
`--education-filter` supports `none`, `bachelor`, `master`, and `doctor`.
`--school-location-filter` supports `none`, `beijing`, and `non_beijing`. It checks the candidate table's `最高教育经历` school immediately before dry-run matching or sending.
`--max` limits successful send actions in normal mode; skipped or failed candidates do not consume the limit. In dry-run mode, it limits preview matches.
When the current candidate page has no eligible unsent candidates, the script advances through Zhaopin pagination and falls back to infinite-scroll loading when no paginator is present. It stops only when the requested send limit is reached or no more candidates can be loaded.

The script records sent candidates by job in `zhaopin-job-message-candidates.json`. The frontend passes the selected synced job's `jobNumber`; the script first tries to select that job inside `jobNumber=-1&jobTitle=不限`, then falls back to the job-specific applicant URL if the page filter cannot be clicked.
