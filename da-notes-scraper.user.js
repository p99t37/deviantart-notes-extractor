// ==UserScript==
// @name         DeviantArt Notes Scraper v11
// @namespace    da-notes-scraper
// @version      11.0
// @description  Scrape DA notes — full conversation reconstruction, dedup, dual themes
// @match        *://www.deviantart.com/messages/notes*
// @include      https://www.deviantart.com/messages/notes*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @run-at       document-idle
// ==/UserScript==

(function() {
  'use strict';

  console.log('%c[DA SCRAPER v11] Loaded on: ' + window.location.href, 'color:#0f0;font-size:14px;font-weight:bold;');

  const DELAY = 2500;

  // ===================== STORAGE =====================
  function loadDB() {
    try { const r = GM_getValue('db9', null); if (r) return JSON.parse(r); } catch {}
    return { notes: [], seenIds: {}, pagesScraped: [], scraping: false, totalPages: 0 };
  }
  function saveDB() {
    try { GM_setValue('db9', JSON.stringify(db)); } catch (e) {
      console.warn('[SCRAPER] Storage full, trimming HTML...');
      for (const n of db.notes) {
        if (n.panelHtml && n.panelHtml.length > 5000)
          n.panelHtml = n.panelHtml.substring(0, 5000) + '<!-- TRIMMED -->';
      }
      try { GM_setValue('db9', JSON.stringify(db)); } catch {}
    }
  }
  const db = loadDB();

  // ===================== HELPERS =====================
  function sleep(ms) { return new Promise(r => setTimeout(r, ms + Math.floor(Math.random() * 400))); }
  function getCurrentPage() { return parseInt(new URL(window.location.href).searchParams.get('page') || '1'); }
  function buildPageUrl(pageNum) { return `https://www.deviantart.com/messages/notes?folder_id=1&page=${pageNum}`; }
  function escHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function sanitizeHtml(html) {
    return (html || '').replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<img[^>]*>/gi, '') // strip DA avatar/emoji images
      .replace(/\son\w+="[^"]*"/gi, '').replace(/\son\w+='[^']*'/gi, '')
      .replace(/javascript:/gi, '');
  }

  // Strip DA UI chrome from captured text
  const DA_JUNK_PATTERNS = [
    /Pick up this conversation where you left off\.?\s*/gi,
    /Continue in Messages\.?\s*/gi,
    /Select a note to get started\.?\s*/gi,
    /Send a new message\.?\s*/gi,
    /Type a message\.?\s*/gi,
    /said the following:\s*/gi,
  ];
  function cleanText(text) {
    let t = text || '';
    for (const pat of DA_JUNK_PATTERNS) t = t.replace(pat, '');
    return t.trim();
  }

  // Auto-linkify URLs in plain text (after escHtml)
  function autoLink(escapedText) {
    return escapedText.replace(
      /(https?:\/\/[^\s<&]+)/g,
      '<a href="$1" target="_blank" rel="noopener">$1</a>'
    ).replace(
      // Also catch www. URLs without protocol
      /(?<![\/\w])(www\.[^\s<&]+)/g,
      '<a href="https://$1" target="_blank" rel="noopener">$1</a>'
    );
  }

  // Format date as "5th August 2012" style
  function formatDateIntl(dateStr) {
    if (!dateStr) return '';
    // Try to parse the date
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) {
      // Try common DA formats like "Sep 3, 2025"
      const m = dateStr.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/);
      if (m) {
        const d2 = new Date(`${m[1]} ${m[2]}, ${m[3]}`);
        if (!isNaN(d2.getTime())) return formatDateObj(d2);
      }
      return dateStr; // can't parse, return as-is
    }
    return formatDateObj(d);
  }
  function formatDateObj(d) {
    const day = d.getDate();
    const suffix = (day === 1 || day === 21 || day === 31) ? 'st'
      : (day === 2 || day === 22) ? 'nd'
      : (day === 3 || day === 23) ? 'rd' : 'th';
    const months = ['January','February','March','April','May','June',
      'July','August','September','October','November','December'];
    return `${day}${suffix} ${months[d.getMonth()]} ${d.getFullYear()}`;
  }

  // ===================== EXTRACT NOTE =====================
  function extractNoteContent() {
    const data = { subject: '', from: '', to: '', panelHtml: '', panelText: '', messages: [] };
    const rp = document.querySelector('div.YIZOLw');
    if (!rp) return data;

    const se = rp.querySelector('h1, h2, h3');
    if (se) data.subject = se.innerText.trim();

    const unames = [];
    rp.querySelectorAll('a[href*="deviantart.com/"]').forEach(a => {
      const m = (a.getAttribute('href') || '').match(/deviantart\.com\/([A-Za-z0-9_-]+)$/);
      if (m && !['messages','notifications','www','about','search','tag','settings','join','users'].includes(m[1]))
        if (!unames.includes(m[1])) unames.push(m[1]);
    });
    const at = rp.innerText;
    const fm = at.match(/From:\s*(\S+)/i), tm = at.match(/To:\s*(\S+)/i);
    data.from = fm ? fm[1] : (unames[0] || '');
    data.to = tm ? tm[1] : (unames[1] || '');
    data.panelHtml = rp.innerHTML;
    data.panelText = rp.innerText.trim();

    // Best-effort message splitting from DOM
    const scrollContainer = rp.querySelector('[class*="scroll"], [style*="overflow"]') || rp;
    const topChildren = scrollContainer.children;
    if (topChildren.length >= 2) {
      for (const child of topChildren) {
        const childText = (child.innerText || '').trim();
        if (childText.length < 5) continue;
        const userLink = child.querySelector('a[href*="deviantart.com/"]');
        let sender = '';
        if (userLink) {
          const m = (userLink.getAttribute('href') || '').match(/deviantart\.com\/([A-Za-z0-9_-]+)$/);
          if (m && !['messages','notifications','www','about','search','tag','settings','join','users'].includes(m[1])) sender = m[1];
        }
        if (sender && childText.length > 30) {
          const dateEl = child.querySelector('time, [datetime]');
          let date = dateEl ? (dateEl.getAttribute('datetime') || dateEl.getAttribute('title') || dateEl.innerText.trim()) : '';
          data.messages.push({ sender, date, text: childText, html: child.innerHTML });
        }
      }
    }
    return data;
  }

  // ===================== DOWNLOAD HELPER =====================
  function dlFile(name, content, mime = 'text/plain') {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], { type: mime }));
    a.download = name; a.style.display = 'none'; document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 1000);
  }

  // ===================== THREAD RECONSTRUCTION =====================
  // The key insight: DA notes are like email. Each "Re:" includes the ENTIRE
  // previous conversation quoted below the new reply. So:
  //   Note A (oldest): just message 1
  //   Note B (reply):  message 2 + quoted message 1
  //   Note C (reply):  message 3 + quoted message 2 + quoted message 1
  //
  // The LONGEST note (by text length) contains ALL messages.
  // To reconstruct, we sort by text length descending, and the longest
  // note's panelText IS the full conversation (newest on top, oldest on bottom).
  //
  // Strategy:
  //   1. Take the longest note's full text — this has the complete thread
  //   2. Split it into individual messages using sender name patterns
  //   3. Reverse to get oldest-first
  //   4. Deduplicate any remaining duplicates by text fingerprint

  function normalizeText(t) {
    return (t || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function reconstructThread(threadNotes, myName) {
    if (threadNotes.length === 0) return [];

    // Collect all unique usernames involved in this thread
    const allUsers = new Set();
    threadNotes.forEach(n => {
      if (n.from) allUsers.add(n.from);
      if (n.to) allUsers.add(n.to);
      if (n.sender) allUsers.add(n.sender);
    });
    allUsers.delete(''); allUsers.delete('unknown');

    // Sort notes by panelText length descending — longest first (most complete)
    const sorted = [...threadNotes].sort((a, b) =>
      (b.panelText || '').length - (a.panelText || '').length
    );

    // The longest note has the most complete conversation
    const fullest = sorted[0];
    const fullText = fullest.panelText || '';

    if (fullText.length < 10) {
      // Fallback: just return each note as-is
      return threadNotes.map(n => ({
        sender: n.from || n.sender || 'Unknown',
        to: n.to || '',
        date: n.listDate || '',
        text: n.panelText || '',
        html: n.panelHtml || '',
        hasHtml: true,
      }));
    }

    // Try to split the full text into individual messages.
    // DA notes typically show each message with the sender's username prominently.
    // We look for patterns like "Username\nDate\n" or "From: Username" as separators.

    const userArray = [...allUsers];
    const messages = [];

    // Build a regex that matches any known username at the start of a line,
    // optionally followed by date-like text. This marks message boundaries.
    // Also look for common DA patterns: "username wrote:", "From: username"
    const usernamePattern = userArray.map(u => escapeRegex(u)).join('|');

    if (usernamePattern) {
      // Split by username appearing as a line/block boundary
      // DA formats include:
      //   "Username\n" on its own line
      //   "From: Username"
      //   "Username wrote:"
      //   "Username said the following:"
      //   "----------" separator lines
      const splitRegex = new RegExp(
        `(?=^(?:${usernamePattern})\\s*$)` + // username on its own line
        `|(?=^From:\\s*(?:${usernamePattern}))` + // "From: username"
        `|(?=^(?:${usernamePattern})\\s+(?:wrote|said the following):)` + // "username wrote/said:"
        `|(?=^-{5,}\\s*$)`, // dashed separator lines
        'gmi'
      );

      const parts = fullText.split(splitRegex).filter(p => p.trim().length > 0);

      for (const part of parts) {
        let trimmed = cleanText(part.trim());
        // Skip pure separator lines
        if (/^-+$/.test(trimmed) || trimmed.length < 3) continue;

        // Identify the sender from the first line
        let sender = '';
        for (const u of userArray) {
          if (trimmed.startsWith(u) || trimmed.match(new RegExp(`^From:\\s*${escapeRegex(u)}`, 'i'))) {
            sender = u;
            break;
          }
        }

        // Try to extract a date from the first few lines
        const lines = trimmed.split('\n').map(l => l.trim());
        let date = '';
        let bodyStartLine = 0;

        for (let i = 0; i < Math.min(lines.length, 6); i++) {
          // Check if this line looks like a date — be VERY broad
          const line = lines[i];
          const isDate = (
            // "Sep 3, 2025" or "September 3, 2025" or "Sep 3 2025"
            line.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\.?\s+\d{1,2},?\s+\d{4}\b/i) ||
            // "3 Sep 2025" or "3 September 2025"
            line.match(/\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\.?\s+\d{4}\b/i) ||
            // Numeric formats: 2025-09-03, 09/03/2025, 03-09-2025
            line.match(/\d{1,4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,4}/) ||
            // Relative: "3 days ago", "1 week ago"
            line.match(/\b\d{1,2}\s+(day|week|month|year|hour|minute)s?\s+ago\b/i) ||
            // Just a year with month: "September 2025"
            line.match(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\.?\s+\d{4}$/i) ||
            // DA sometimes shows just "Today" or "Yesterday"
            line.match(/^(today|yesterday)$/i) ||
            // Timestamps like "Sep 3, 2025, 2:14 PM" or "2025-09-03T14:14:00"
            line.match(/\d{1,2}:\d{2}\s*(am|pm)?/i)
          );
          if (isDate && line.length < 80) { // date lines shouldn't be super long
            date = line;
            if (bodyStartLine <= i) bodyStartLine = i + 1;
          }
          // Skip the sender line, "wrote:", "said the following:", "From:", "To:" lines
          if (lines[i] === sender || lines[i].match(/wrote:/i) || lines[i].match(/^From:/i) ||
              lines[i].match(/said the following/i) || lines[i].match(/^To:/i) ||
              /^-{5,}$/.test(lines[i])) {
            bodyStartLine = i + 1;
          }
        }

        const body = lines.slice(bodyStartLine).join('\n').trim();

        if (body.length > 0 || sender) {
          messages.push({
            sender: sender || 'Unknown',
            date,
            text: body || trimmed,
            // We don't have per-message HTML from the split, so mark it
            hasHtml: false,
          });
        }
      }
    }

    // If regex splitting failed or produced only 1 chunk, fall back to
    // using notes themselves as messages, deduplicating by text content
    if (messages.length <= 1) {
      return fallbackDedup(sorted, myName);
    }

    // Reverse: DA puts newest on top, we want oldest first
    messages.reverse();

    // Try to fill in missing dates from the original notes' listDates
    // Build a pool of known dates from notes, sorted oldest-first
    const noteDates = [...threadNotes]
      .filter(n => n.listDate)
      .sort((a, b) => {
        if ((a.page || 0) !== (b.page || 0)) return (b.page || 0) - (a.page || 0);
        return (b.noteIndex || 0) - (a.noteIndex || 0);
      })
      .map(n => n.listDate);

    // Assign dates: if a message has no date, try to use the corresponding
    // note date (by position). This is imperfect but better than nothing.
    for (let i = 0; i < messages.length; i++) {
      if (!messages[i].date && noteDates[i]) {
        messages[i].date = noteDates[i];
      }
    }

    // Deduplicate by normalized text fingerprint
    const seen = new Set();
    const deduped = [];
    for (const msg of messages) {
      const fp = normalizeText(msg.text).substring(0, 200);
      if (fp.length < 5) continue;
      if (seen.has(fp)) continue;
      seen.add(fp);
      deduped.push(msg);
    }

    return deduped;
  }

  // Fallback: diff-based dedup when we can't split by username
  function fallbackDedup(sortedNotes, myName) {
    // sortedNotes is already sorted by panelText length descending
    const messages = [];
    const seenFingerprints = new Set();

    // Process from shortest to longest (oldest to newest, since older = fewer quotes)
    const reversed = [...sortedNotes].reverse();

    for (const note of reversed) {
      const noteText = cleanText(note.panelText || '');
      const noteNorm = normalizeText(noteText);
      if (noteNorm.length < 10) continue;

      // Split into paragraphs
      const paras = noteText.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 5);
      const newParas = [];

      for (const para of paras) {
        const cleaned = cleanText(para);
        if (cleaned.length < 5) continue;
        // Skip lines that are just separators or DA headers
        if (/^-{3,}$/.test(cleaned)) continue;
        if (/^(From|To):\s/i.test(cleaned) && cleaned.length < 60) continue;

        const fp = normalizeText(cleaned).substring(0, 200);
        if (fp.length < 5 || seenFingerprints.has(fp)) continue;

        // Also check if this para is a substring of any seen fingerprint
        let isDupe = false;
        for (const seen of seenFingerprints) {
          if (seen.includes(fp) || fp.includes(seen)) { isDupe = true; break; }
        }
        if (!isDupe) {
          newParas.push(cleaned);
          seenFingerprints.add(fp);
        }
      }

      if (newParas.length > 0) {
        messages.push({
          sender: note.from || note.sender || 'Unknown',
          to: note.to || '',
          date: note.listDate || '',
          text: newParas.join('\n\n'),
          html: note.panelHtml || '',
          hasHtml: true,
        });
      }
    }

    return messages; // already oldest-first
  }

  function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }


  // ===================== THEMES =====================
  const THEME_NOSTALGIA = `
/* ===== NOSTALGIA LIGHT — Classic DeviantArt 2008-2012 ===== */
* { box-sizing: border-box; }
body { font-family: Verdana, Geneva, 'DejaVu Sans', sans-serif; font-size: 12px; margin:0; padding:0; background:#e8e4db; color:#3b4a3a; }
.da-header { background:linear-gradient(to bottom,#b5c792,#8fa564); border-bottom:2px solid #6b7d4a; padding:12px 20px; display:flex; align-items:center; gap:12px; }
.da-header h1 { font-family:'Trebuchet MS',Verdana,sans-serif; font-size:20px; color:#fff; margin:0; text-shadow:1px 1px 2px rgba(0,0,0,0.3); }
.da-logo { font-weight:bold; color:#2e4016; font-size:16px; font-family:'Trebuchet MS',sans-serif; }
.da-logo span { color:#c2d48b; }
.da-subheader { background:#475a30; color:#c2d48b; padding:6px 20px; font-size:11px; border-bottom:1px solid #3a4a26; display:flex; justify-content:space-between; align-items:center; }
.da-content { max-width:960px; margin:0 auto; padding:20px; }
.thread-box { background:#f5f2eb; border:1px solid #c8c3b4; border-radius:6px; margin-bottom:20px; overflow:hidden; }
.thread-subject-bar { background:linear-gradient(to bottom,#d9d4c5,#cec8b6); border-bottom:1px solid #b8b3a4; padding:10px 18px; font-weight:bold; color:#4a5a32; font-size:13px; font-family:'Trebuchet MS',Verdana,sans-serif; }
.message { padding:14px 18px; border-bottom:1px solid #ddd8cb; }
.message:last-child { border-bottom:none; }
.message:nth-child(even) { background:#f0ede4; }
.msg-header { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px; padding-bottom:6px; border-bottom:1px dotted #ccc7b8; }
.msg-sender-name { font-weight:bold; color:#4a6b2a; font-size:13px; font-family:'Trebuchet MS',Verdana,sans-serif; }
.msg-sender-name.is-me { color:#8b6914; }
.msg-date { font-size:10px; color:#9a9580; font-style:italic; }
.msg-direction { font-size:10px; color:#9a9580; margin-bottom:4px; }
.msg-body { line-height:1.65; color:#3b4a3a; font-size:12px; word-wrap:break-word; white-space:pre-wrap; }
.msg-body b,.msg-body strong { color:#2a3a1a; }
.msg-body a { color:#4a7a2a; text-decoration:underline; }
.msg-body blockquote { border-left:3px solid #c8c3b4; padding-left:12px; margin:8px 0; color:#7a7a6a; font-style:italic; }
.footer { background:#475a30; color:#a0b878; padding:12px 20px; text-align:center; font-size:10px; margin-top:30px; }
.footer a { color:#c2d48b; }
.no-content { color:#b0a890; font-style:italic; padding:12px 18px; }
.theme-btn { background:#6b7d4a; color:#e8e4db; border:1px solid #8fa564; padding:5px 14px; border-radius:4px; cursor:pointer; font-family:'Trebuchet MS',Verdana,sans-serif; font-size:11px; font-weight:bold; }
.theme-btn:hover { background:#8fa564; }
.raw-toggle { margin:4px 18px 8px; } .raw-toggle summary { cursor:pointer; color:#8a8570; font-size:10px; font-style:italic; }
.raw-content { background:#e8e4db; padding:10px; border-radius:4px; margin-top:4px; font-size:10px; color:#6b6b5a; max-height:200px; overflow-y:auto; border:1px solid #c8c3b4; }
`;

  const THEME_DARK = `
/* ===== MODERN DARK ===== */
* { box-sizing: border-box; }
body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; font-size:13px; margin:0; padding:0; background:#0f0f1a; color:#d0d0e0; }
.da-header { background:linear-gradient(to right,#1a1a2e,#16213e); border-bottom:2px solid #0f3; padding:12px 20px; display:flex; align-items:center; gap:12px; }
.da-header h1 { font-size:20px; color:#0f3; margin:0; font-weight:700; }
.da-logo { font-weight:bold; color:#0f3; font-size:16px; }
.da-logo span { color:#4af; }
.da-subheader { background:#12122a; color:#888; padding:6px 20px; font-size:11px; border-bottom:1px solid #222; display:flex; justify-content:space-between; align-items:center; }
.da-content { max-width:960px; margin:0 auto; padding:20px; }
.thread-box { background:#1a1a2e; border:1px solid #333; border-radius:8px; margin-bottom:20px; overflow:hidden; }
.thread-subject-bar { background:#222244; border-bottom:1px solid #333; padding:10px 18px; font-weight:bold; color:#fa0; font-size:14px; }
.message { padding:14px 18px; border-bottom:1px solid #252540; }
.message:last-child { border-bottom:none; }
.message:nth-child(even) { background:#16162a; }
.msg-header { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px; padding-bottom:6px; border-bottom:1px dotted #333; }
.msg-sender-name { font-weight:bold; color:#0f0; font-size:14px; }
.msg-sender-name.is-me { color:#4af; }
.msg-date { font-size:10px; color:#666; font-style:italic; }
.msg-direction { font-size:10px; color:#555; margin-bottom:4px; }
.msg-body { line-height:1.65; color:#d0d0e0; font-size:13px; word-wrap:break-word; white-space:pre-wrap; }
.msg-body b,.msg-body strong { color:#fff; }
.msg-body a { color:#4af; text-decoration:underline; }
.msg-body blockquote { border-left:3px solid #444; padding-left:12px; margin:8px 0; color:#888; font-style:italic; }
.footer { background:#12122a; color:#555; padding:12px 20px; text-align:center; font-size:10px; margin-top:30px; }
.footer a { color:#4af; }
.no-content { color:#555; font-style:italic; padding:12px 18px; }
.theme-btn { background:#222244; color:#0f3; border:1px solid #0f3; padding:5px 14px; border-radius:4px; cursor:pointer; font-size:11px; font-weight:bold; font-family:monospace; }
.theme-btn:hover { background:#0f3; color:#000; }
.raw-toggle { margin:4px 18px 8px; } .raw-toggle summary { cursor:pointer; color:#555; font-size:10px; font-style:italic; }
.raw-content { background:#0f0f1a; padding:10px; border-radius:4px; margin-top:4px; font-size:10px; color:#666; max-height:200px; overflow-y:auto; border:1px solid #333; }
`;

  // ===================== GENERATE DOWNLOADS =====================
  function generateDownloads() {
    if (db.notes.length === 0) { addLog('No notes yet!', '#f44'); return; }
    addLog(`Generating output for ${db.notes.length} notes...`, '#fa0');

    // Identify "me"
    const nameCounts = {};
    db.notes.forEach(n => {
      if (n.from) nameCounts[n.from] = (nameCounts[n.from] || 0) + 1;
      if (n.to) nameCounts[n.to] = (nameCounts[n.to] || 0) + 1;
    });
    const myName = Object.entries(nameCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    addLog(`You are: ${myName}`, '#4af');

    // Group by other person
    const byContact = {};
    db.notes.forEach(n => {
      let contact = n.sender || 'unknown';
      if (contact === myName && n.to && n.to !== myName) contact = n.to;
      if (n.from === myName && n.to && n.to !== myName) contact = n.to;
      if (!byContact[contact]) byContact[contact] = [];
      byContact[contact].push(n);
    });

    const contactList = Object.entries(byContact).sort((a, b) => b[1].length - a[1].length);
    let fileCount = 0, downloadDelay = 0;
    let totalMsgs = 0;

    for (const [contact, notes] of contactList) {
      // Group into threads
      const threads = {};
      notes.forEach(n => {
        let subj = (n.subject || '(no subject)').replace(/^(Re:\s*)+/i, '').trim() || '(no subject)';
        if (!threads[subj]) threads[subj] = [];
        threads[subj].push(n);
      });

      // Sort threads so oldest conversations come first
      const threadEntries = Object.entries(threads).sort((a, b) => {
        const oldestA = Math.max(...a[1].map(n => n.page || 0));
        const oldestB = Math.max(...b[1].map(n => n.page || 0));
        return oldestB - oldestA;
      });

      let contactMsgCount = 0;

      // Build thread HTML
      let threadsHtml = '';
      for (const [subject, threadNotes] of threadEntries) {
        const convo = reconstructThread(threadNotes, myName);
        contactMsgCount += convo.length;
        totalMsgs += convo.length;

        threadsHtml += `<div class="thread-box">
<div class="thread-subject-bar">📝 ${escHtml(subject)} <span style="font-weight:normal;opacity:0.6;font-size:11px;">(${convo.length} message${convo.length !== 1 ? 's' : ''})</span></div>`;

        if (convo.length === 0) {
          threadsHtml += `<div class="no-content">Could not extract messages for this thread.</div>`;
        }

        // Build a map of truncated display text → real full URL from panelHtml
        // DA shows "www.deviantart.com/user/..." in text but has real href in HTML
        const urlMap = {};
        for (const n of threadNotes) {
          if (!n.panelHtml) continue;
          const linkRegex = /<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
          let lm;
          while ((lm = linkRegex.exec(n.panelHtml)) !== null) {
            const href = lm[1];
            let display = lm[2].replace(/<[^>]*>/g, '').trim();
            if (href && display && href.startsWith('http')) {
              urlMap[display] = href;
              // Also without trailing ellipsis
              const noEllipsis = display.replace(/\.{3}$|…$/, '');
              if (noEllipsis !== display) urlMap[noEllipsis] = href;
            }
          }
        }
        // Sort keys longest-first so specific matches win over partial
        const urlKeys = Object.keys(urlMap).sort((a, b) => b.length - a.length);

        for (const msg of convo) {
          const isMe = (msg.sender === myName);
          let cleanBody = cleanText(msg.text);
          const fmtDate = formatDateIntl(msg.date);

          // Replace truncated URLs with real full URLs
          // Use a regex with word boundary to avoid splicing into the middle of other URLs
          for (const display of urlKeys) {
            if (!cleanBody.includes(display)) continue;
            const realUrl = urlMap[display];
            // Escape for regex, match only when followed by whitespace, newline, end, or punctuation (not more URL chars)
            const escaped = display.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(escaped + '(?=[\\s\\n,;:!?)\\]}>]|$)', 'g');
            cleanBody = cleanBody.replace(re, realUrl);
          }

          threadsHtml += `<div class="message">
<div class="msg-header">
  <span class="msg-sender-name ${isMe ? 'is-me' : ''}">${escHtml(msg.sender)}</span>
  <span class="msg-date">${escHtml(fmtDate)}</span>
</div>`;
          if (msg.to) threadsHtml += `<div class="msg-direction">→ ${escHtml(msg.to)}</div>`;
          // Render body: escape text, then replace truncated URLs with real ones
          // extracted from the note's HTML
          threadsHtml += `<div class="msg-body">${autoLink(escHtml(cleanBody)).replace(/\n/g, '<br>')}</div>`;
          threadsHtml += `</div>`;
        }

        // Raw data toggle for the thread (collapsed)
        threadsHtml += `<details class="raw-toggle"><summary>View raw scraped data (${threadNotes.length} notes)</summary>`;
        for (const n of threadNotes) {
          threadsHtml += `<div class="raw-content"><b>${escHtml(n.from)} → ${escHtml(n.to)}</b> (${escHtml(n.listDate)})<br><br>${escHtml((n.panelText || '').substring(0, 2000))}${(n.panelText || '').length > 2000 ? '...' : ''}</div>`;
        }
        threadsHtml += `</details>`;

        threadsHtml += `</div>`; // thread-box
      }

      const safeName = contact.replace(/[^a-zA-Z0-9_-]/g, '_');
      const myNameSafe = escHtml(myName);
      const contactSafe = escHtml(contact);
      const statsLine = `${contactMsgCount} unique messages, ${notes.length} original notes, ${Object.keys(threads).length} threads`;

      const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Notes: ${contactSafe} — DeviantArt Archive</title>
<style id="theme-css">${THEME_DARK}</style>
</head><body>
<div class="da-header">
  <div class="da-logo">deviant<span>ART</span></div>
  <h1>Notes Archive</h1>
</div>
<div class="da-subheader">
  <span>Correspondence between <b>${myNameSafe}</b> and <b>${contactSafe}</b> — ${statsLine}</span>
  <button class="theme-btn" onclick="toggleTheme()">☀️ Nostalgia Light</button>
</div>
<div class="da-content">
${threadsHtml}
</div>
<div class="footer">
  Exported from <a href="https://www.deviantart.com/messages/notes">DeviantArt Notes</a> — ${statsLine} — deviantART Archive
</div>
<script>
const NOSTALGIA = ${JSON.stringify(THEME_NOSTALGIA)};
const DARK = ${JSON.stringify(THEME_DARK)};
let currentTheme = 'dark';
function toggleTheme() {
  const css = document.getElementById('theme-css');
  if (currentTheme === 'dark') {
    css.textContent = NOSTALGIA;
    currentTheme = 'nostalgia';
    setTimeout(() => {
      const b = document.querySelector('.theme-btn');
      if (b) b.textContent = '🌙 Modern Dark';
    }, 10);
  } else {
    css.textContent = DARK;
    currentTheme = 'dark';
    setTimeout(() => {
      const b = document.querySelector('.theme-btn');
      if (b) b.textContent = '☀️ Nostalgia Light';
    }, 10);
  }
}
</script>
</body></html>`;

      setTimeout(() => dlFile(`da-notes_${safeName}.html`, html, 'text/html'), downloadDelay);
      downloadDelay += 400;
      fileCount++;
      addLog(`  ${contact}: ${contactMsgCount} msgs from ${notes.length} notes`, '#8f8');
    }

    addLog(`Total: ${totalMsgs} unique messages from ${db.notes.length} notes`, '#4af');

    setTimeout(() => {
      const csv = ['contact,threads,raw_notes,unique_messages,pages'];
      for (const [contact, notes] of contactList) {
        const threads = {};
        notes.forEach(n => { let s = (n.subject||'').replace(/^(Re:\s*)+/i,'').trim()||'(no subject)'; if(!threads[s])threads[s]=[]; threads[s].push(n); });
        let mc = 0;
        for (const tn of Object.values(threads)) mc += reconstructThread(tn, myName).length;
        const pages = [...new Set(notes.map(n => n.page))].sort((a,b)=>a-b).join(';');
        const esc = s => '"' + String(s || '').replace(/"/g, '""') + '"';
        csv.push([esc(contact), Object.keys(threads).length, notes.length, mc, esc(pages)].join(','));
      }
      dlFile('da-notes-summary.csv', csv.join('\n'), 'text/csv');
      addLog(`💾 Summary CSV`, '#0f0');
    }, downloadDelay + 200);

    setTimeout(() => {
      dlFile('da-notes-backup.json', JSON.stringify(db.notes, null, 2), 'application/json');
      addLog(`✅ Done! ${fileCount} HTML files + CSV + JSON`, '#0f0');
    }, downloadDelay + 600);
  }


  // ===================== UI =====================
  let logLines = [];
  function addLog(msg, color = '#8f8') {
    logLines.push({ msg, color, ts: new Date().toISOString().substring(11, 19) });
    if (logLines.length > 200) logLines = logLines.slice(-100);
    const logEl = document.getElementById('dsc-log');
    if (logEl) { const d = document.createElement('div'); d.style.color = color; d.textContent = `[${logLines[logLines.length - 1].ts}] ${msg}`; logEl.appendChild(d); logEl.scrollTop = logEl.scrollHeight; }
    console.log(`%c[SCRAPER] ${msg}`, `color:${color};font-weight:bold`);
  }

  function updUI() {
    const p = document.getElementById('dsc-page'), t = document.getElementById('dsc-tot'), pd = document.getElementById('dsc-pgcount'), pr = document.getElementById('dsc-progress');
    if (p) p.textContent = getCurrentPage();
    if (t) t.textContent = db.notes.length;
    if (pd) pd.textContent = db.pagesScraped.length;
    if (pr && db.totalPages > 0) { const pct = Math.round((db.pagesScraped.length / db.totalPages) * 100); pr.style.width = pct + '%'; pr.textContent = pct + '%'; }
  }

  function buildPanel() {
    const old = document.getElementById('da-scraper-panel'); if (old) old.remove();
    const pct = db.totalPages > 0 ? Math.round((db.pagesScraped.length / db.totalPages) * 100) : 0;
    const panel = document.createElement('div');
    panel.id = 'da-scraper-panel';
    panel.innerHTML = `
      <div style="font-family:monospace;background:#1a1a2e;color:#0f0;border:2px solid #0f0;border-radius:10px;padding:12px;width:340px;font-size:13px;box-shadow:0 4px 20px rgba(0,255,0,0.3);z-index:2147483647;position:fixed;top:10px;right:10px;max-height:90vh;overflow-y:auto;">
        <div style="font-size:15px;font-weight:bold;margin-bottom:8px;color:#0f0;border-bottom:1px solid #0f0;padding-bottom:6px;">🗒️ DA Notes v11</div>
        <div id="dsc-status" style="margin-bottom:6px;color:#ff0;">Loading...</div>
        <div style="margin-bottom:4px;font-size:12px;">Page <b id="dsc-page">${getCurrentPage()}</b> | Notes: <b id="dsc-tot">${db.notes.length}</b> | Pages: <b id="dsc-pgcount">${db.pagesScraped.length}</b></div>
        <div style="background:#333;border-radius:4px;height:18px;margin-bottom:6px;overflow:hidden;"><div id="dsc-progress" style="background:#0a0;height:100%;width:${pct}%;text-align:center;font-size:11px;line-height:18px;color:#fff;transition:width 0.3s;">${pct}%</div></div>
        <div id="dsc-log" style="max-height:160px;overflow-y:auto;font-size:11px;background:#0a0a1a;padding:6px;border-radius:5px;margin-bottom:8px;color:#8f8;line-height:1.3;"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;">
          <button id="dsc-go" style="padding:8px;background:#003300;color:#0f0;border:1px solid #0f0;border-radius:5px;cursor:pointer;font-family:monospace;font-weight:bold;font-size:13px;">▶ Start</button>
          <button id="dsc-stop" style="padding:8px;background:#330000;color:#f44;border:1px solid #f44;border-radius:5px;cursor:pointer;font-family:monospace;font-size:13px;display:none;">⏹ Stop</button>
          <button id="dsc-dl" style="padding:8px;background:#332200;color:#fa0;border:1px solid #fa0;border-radius:5px;cursor:pointer;font-family:monospace;font-weight:bold;font-size:13px;">💾 Download</button>
          <button id="dsc-clear" style="padding:6px;background:#1a1a2e;color:#888;border:1px solid #444;border-radius:5px;cursor:pointer;font-family:monospace;font-size:11px;">Clear data</button>
        </div>
      </div>`;
    document.body.appendChild(panel);
    const logEl = document.getElementById('dsc-log');
    for (const l of logLines.slice(-30)) { const d = document.createElement('div'); d.style.color = l.color; d.textContent = `[${l.ts}] ${l.msg}`; logEl.appendChild(d); }
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
    wireButtons();
  }

  function wireButtons() {
    const g = document.getElementById('dsc-go'), s = document.getElementById('dsc-stop'), d = document.getElementById('dsc-dl'), c = document.getElementById('dsc-clear');
    if (g) g.onclick = scrapeAll;
    if (s) s.onclick = () => { shouldStop = true; db.scraping = false; saveDB(); addLog('Stopping...', '#fa0'); };
    if (d) d.onclick = generateDownloads;
    if (c) c.onclick = () => { if (confirm('Delete ALL saved notes? Cannot undo!')) { try { GM_deleteValue('db9'); } catch {} db.notes = []; db.seenIds = {}; db.pagesScraped = []; db.scraping = false; db.totalPages = 0; updUI(); addLog('🗑️ Cleared', '#f44'); } };
    if (running) { if (g) g.style.display = 'none'; if (s) s.style.display = 'block'; }
  }

  function detectTotalPages() {
    const pagLinks = document.querySelectorAll('div.n2_oA3 a.vQ2brP, div.n2_oA3 div.vQ2brP');
    let maxPage = 1;
    for (const link of pagLinks) { const num = parseInt(link.innerText.trim()); if (!isNaN(num) && num > maxPage) maxPage = num; }
    if (maxPage > 1) { db.totalPages = maxPage; saveDB(); }
    return maxPage;
  }

  // ===================== NAVIGATE =====================
  async function goNextPage() {
    const pg = getCurrentPage();
    db.scraping = true; saveDB();
    addLog(`⏭️ → Page ${pg + 1}`, '#4af');
    window.location.href = buildPageUrl(pg + 1);
    return true;
  }

  // ===================== SCRAPE ONE PAGE =====================
  async function scrapePage() {
    const pg = getCurrentPage();
    if (new URL(window.location.href).searchParams.has('note_id')) {
      addLog('note_id in URL — redirecting to list view...', '#fa0');
      window.location.href = buildPageUrl(pg);
      return false;
    }
    if (db.pagesScraped.includes(pg)) { addLog(`Page ${pg} already done, skipping`, '#666'); return true; }

    const st = document.getElementById('dsc-status');
    if (st) { st.textContent = `🔍 Page ${pg}...`; st.style.color = '#ff0'; }
    await sleep(1000);

    let items = document.querySelectorAll('li.HWjiVP');
    if (items.length === 0) items = document.querySelectorAll('div.AwD9ij li');
    if (items.length === 0) { await sleep(3000); items = document.querySelectorAll('li.HWjiVP'); if (items.length === 0) items = document.querySelectorAll('div.AwD9ij li'); }

    addLog(`Page ${pg}: ${items.length} notes`);
    if (items.length === 0) { if (st) { st.textContent = '❌ No notes'; st.style.color = '#f44'; } return false; }

    let saved = 0;
    for (let i = 0; i < items.length && !shouldStop; i++) {
      let ni = document.querySelectorAll('li.HWjiVP');
      if (ni.length === 0) ni = document.querySelectorAll('div.AwD9ij li');
      if (!ni[i]) continue;

      const lines = ni[i].innerText.trim().split('\n').map(l => l.trim()).filter(Boolean);
      const ls = lines[0] || 'unknown', ld = lines[1] || '', lsub = lines[2] || '(no subject)';
      const nid = `p${pg}_n${i}`;
      if (db.seenIds[nid]) continue;

      if (st) st.textContent = `📖 p${pg} ${i + 1}/${items.length}: ${ls}`;
      addLog(`  ${i + 1}/${items.length}: ${ls} — ${lsub}`);

      try {
        ni[i].click();
        await sleep(DELAY);
        for (let a = 0; a < 10; a++) {
          const p = document.querySelector('div.YIZOLw'), ph = document.querySelector('section.Ig30RZ');
          if (p && p.innerText.length > 50 && !(ph && ph.innerText.includes('Select a note'))) break;
          await sleep(600);
        }
        await sleep(500);

        const nd = extractNoteContent();
        const contentLen = (nd.panelText || '').length;

        db.notes.push({
          id: nid, page: pg, noteIndex: i,
          sender: nd.from || ls, subject: nd.subject || lsub,
          from: nd.from, to: nd.to, listDate: ld,
          panelHtml: nd.panelHtml, panelText: nd.panelText,
          messages: nd.messages,
        });
        db.seenIds[nid] = true; saved++;
        saveDB(); updUI();
        addLog(`    ✅ ${contentLen} chars, ${nd.messages.length} msgs`, '#0f0');
      } catch (err) { addLog(`    ❌ ${err.message}`, '#f44'); }
      await sleep(DELAY + Math.random() * 500);
    }

    if (!db.pagesScraped.includes(pg)) db.pagesScraped.push(pg);
    saveDB(); updUI();
    if (st) { st.textContent = `✅ Page ${pg}: +${saved} (${db.notes.length} total)`; st.style.color = '#0f0'; }
    addLog(`Page ${pg} done. +${saved}. Total: ${db.notes.length}`, '#0f0');
    return !shouldStop;
  }

  // ===================== MAIN LOOP =====================
  let running = false, shouldStop = false;

  async function scrapeAll() {
    if (running) return;
    running = true; shouldStop = false;
    db.scraping = true; saveDB();
    const g = document.getElementById('dsc-go'), s = document.getElementById('dsc-stop');
    if (g) g.style.display = 'none'; if (s) s.style.display = 'block';
    detectTotalPages();

    let fails = 0;
    while (!shouldStop) {
      const ok = await scrapePage();
      if (!ok) { fails++; if (fails >= 3) break; } else fails = 0;
      if (shouldStop) break;
      const hasNext = Array.from(document.querySelectorAll('div.n2_oA3 a.vQ2brP') || []).some(a => a.innerText.trim().toLowerCase() === 'next');
      if (!hasNext) {
        addLog('🏁 ALL PAGES DONE!', '#0f0');
        const st = document.getElementById('dsc-status');
        if (st) { st.textContent = `🏁 DONE! ${db.notes.length} notes`; st.style.color = '#0f0'; }
        db.scraping = false; saveDB(); break;
      }
      await goNextPage();
      return;
    }
    running = false;
    if (shouldStop) { db.scraping = false; saveDB(); }
    const g2 = document.getElementById('dsc-go'), s2 = document.getElementById('dsc-stop');
    if (g2) g2.style.display = 'block'; if (s2) s2.style.display = 'none';
  }

  // ===================== INIT =====================
  setTimeout(() => {
    buildPanel(); detectTotalPages(); updUI();
    addLog(`Page ${getCurrentPage()}. ${db.notes.length} notes, ${db.pagesScraped.length} pages done.`);
    if (db.scraping) {
      addLog('🔄 AUTO-RESUMING in 3s...', '#4af');
      const st = document.getElementById('dsc-status');
      if (st) { st.textContent = '🔄 Auto-resuming in 3s...'; st.style.color = '#4af'; }
      setTimeout(() => scrapeAll(), 3000);
    } else {
      const st = document.getElementById('dsc-status');
      if (st) { st.textContent = 'Ready. Click ▶ Start.'; st.style.color = '#0f0'; }
    }
  }, 2500);
})();
