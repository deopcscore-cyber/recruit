/* ============================================================
   Recruit Pro — Content script (Manifest V3)
   • ContactOut search results: bulk-import the whole page
   • LinkedIn /in/ profile: single-import with ContactOut email pickup
   ============================================================ */

(function () {
  'use strict';

  console.log('[Recruit Pro] content script loaded on:', location.hostname, location.pathname);

  const EMAIL_RE      = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const EMAIL_EXACT   = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
  const IGNORE_DOMAINS = /@(linkedin\.com|licdn\.com|contactout\.com|example\.com|sentry\.|w3\.org)/i;
  const PERSONAL_RE   = /@(gmail|yahoo|hotmail|outlook|icloud|me|live|aol|protonmail|pm)\./i;

  function isEmail(s) { return EMAIL_EXACT.test(s); }
  function sleep(ms)  { return new Promise(r => setTimeout(r, ms)); }

  // ── Auto-click "View Email" so we never have to reveal emails by hand ──────
  // Shadow-DOM aware: ContactOut's LinkedIn-injected widget renders inside a
  // shadow root, same as the email text itself (see readContactOutEmails below).
  function isRevealBtn(el) {
    const t = (el.textContent || '').trim().toLowerCase();
    return t === 'view email' || t === 'reveal email' || t === 'show email';
  }

  function collectRevealButtons(root, out) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('button, span, a, [role="button"]').forEach(el => {
      if (isRevealBtn(el)) out.push(el);
      if (el.shadowRoot) collectRevealButtons(el.shadowRoot, out);
    });
  }

  // Click every visible "View Email" button, waiting for each reveal to load
  // and for newly-rendered buttons (pagination, lazy sections) to appear.
  async function revealAllEmails() {
    let totalClicked = 0;
    for (let pass = 0; pass < 6; pass++) {
      const btns = [];
      collectRevealButtons(document, btns);
      const unique = [...new Set(btns)];
      if (unique.length === 0) break;
      for (const btn of unique) {
        try { btn.click(); } catch (_) {}
        await sleep(350); // reveal triggers an API call — give it time to resolve
      }
      totalClicked += unique.length;
      await sleep(1200); // let the DOM settle before checking for more buttons
    }
    return totalClicked;
  }

  /* ════════════════════════════════════════════════════════════
     CONTACTOUT — bulk import from search results page
  ════════════════════════════════════════════════════════════ */

  const CO_BTN_ID = 'recruit-pro-co-btn';

  function isContactOutPage() {
    return location.hostname.includes('contactout.com');
  }

  // UI strings that ContactOut injects — never a candidate name
  const NOT_A_NAME = new Set([
    'view phone', 'view email', 'ai write personalized message',
    'send email', 'save', 'export', 'search', 'clear all',
    '...more', '…more', 'show more', 'see more', 'more',
    'people', 'companies', 'advanced', 'select all'
  ]);

  // ── Find candidate cards by walking up from email text nodes ──────────────
  // Key insight: ContactOut splits each row into a LEFT panel (name/job)
  // and a RIGHT panel (email/phone/buttons). Walking up from an email node
  // lands in the right panel — we need to keep going until we reach the
  // full row ancestor that ALSO contains a job title ("X at Y").
  function findCandidateCards() {
    const seen  = new Set();
    const cards = [];

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const txt = node.textContent.trim();
      if (!isEmail(txt) || IGNORE_DOMAINS.test(txt)) continue;
      const email = txt.toLowerCase();
      if (seen.has(email)) continue;
      seen.add(email);

      // Walk UP until we find an ancestor that contains BOTH:
      //   • the email (obviously), AND
      //   • a job-title pattern (" at SomeCompany")
      // The contact-info column only has email/phone/buttons, so we keep
      // climbing until we hit the full person row which has the job history.
      let el = node.parentElement;
      let card = null;
      for (let i = 0; i < 16; i++) {
        if (!el || el === document.body) break;
        const text = el.innerText || '';
        // Must have a "Title at Company" pattern AND reasonable line count
        const hasJob  = / at [A-Z]/.test(text);
        const lines   = text.split('\n').filter(l => l.trim()).length;
        if (hasJob && lines >= 4 && lines <= 60) {
          card = el;
          break;
        }
        el = el.parentElement;
      }
      if (card) cards.push({ email, el: card });
    }

    // Dedup cards (same DOM element captured via multiple emails)
    const uniqueEls = new Map();
    for (const c of cards) {
      if (!uniqueEls.has(c.el)) uniqueEls.set(c.el, c);
    }
    return [...uniqueEls.values()];
  }

  // ── Extract one candidate from a card element ──────────────────────────────
  function extractCandidate({ email, el }) {
    const lines = (el.innerText || '')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);

    // LinkedIn URL
    let linkedin = '';
    const liAnchor = el.querySelector('a[href*="linkedin.com/in/"]');
    if (liAnchor) {
      linkedin = liAnchor.href.split('?')[0];
    } else {
      const dataEl = el.querySelector('[data-url*="linkedin.com/in/"],[data-href*="linkedin.com/in/"]');
      if (dataEl) linkedin = (dataEl.dataset.url || dataEl.dataset.href || '').split('?')[0];
    }

    // Phone — tel: link
    const telLink = el.querySelector('a[href^="tel:"]');
    const phone = telLink ? telLink.href.replace('tel:', '').trim() : '';

    // Name — first line that looks like a human name:
    //   • 2–5 words, letters/hyphens/apostrophes only
    //   • NOT a known ContactOut UI string
    //   • NOT a job title (no " at ")
    let name = '';
    for (const line of lines) {
      if (line.includes('@')) continue;
      if (line.includes(' at ') || line.includes(' - ')) continue;
      if (NOT_A_NAME.has(line.toLowerCase())) continue;
      const words = line.split(/\s+/);
      if (words.length >= 2 && words.length <= 5 && /^[A-Za-z\-'. ]+$/.test(line)) {
        name = line;
        break;
      }
    }

    // Title + Company — first "X at Y" line that isn't a school
    const SCHOOL_WORDS = /university|college|school|institute|bachelor|master|degree/i;
    let title = '', company = '';
    for (const line of lines) {
      if (line === name || line.includes('@')) continue;
      if (SCHOOL_WORDS.test(line)) continue;
      const atIdx = line.lastIndexOf(' at ');
      if (atIdx > 3 && atIdx < line.length - 4) {
        title   = line.slice(0, atIdx).trim();
        company = line.slice(atIdx + 4)
          .replace(/\s+in\s+\d{4}.*/i, '')
          .replace(/\s+\d{4}\s*[-–]\s*.*/,'')
          .trim();
        if (title && company) break;
      }
    }

    // Work history — "Title at Company" lines, skipping schools
    const career = [];
    for (const line of lines) {
      if (line === name || line.includes('@')) continue;
      if (SCHOOL_WORDS.test(line)) continue;
      const atIdx = line.lastIndexOf(' at ');
      if (atIdx > 3 && atIdx < line.length - 4) {
        const t = line.slice(0, atIdx).trim();
        const rest = line.slice(atIdx + 4);
        // Extract dates before stripping them
        const dateMatch = rest.match(/(\d{4}\s*[-–]\s*(?:\d{4}|Present|present|Current|current))/i)
                       || rest.match(/in\s+(\d{4}\s*[-–]\s*(?:\d{4}|Present|present|Current|current))/i);
        const dates = dateMatch ? dateMatch[1].replace(/\s+/g, ' ').trim() : '';
        const c = rest.replace(/\s+in\s+\d{4}.*/i, '').replace(/\s+\d{4}\s*[-–]\s*.*/,'').trim();
        if (t && c) career.push({ title: t, company: c, dates });
      }
    }

    // Education — school lines (degree at school, or school name alone)
    const education = [];
    for (const line of lines) {
      if (line === name || line.includes('@')) continue;
      if (!SCHOOL_WORDS.test(line)) continue;
      // Strip trailing year ranges like "in 2016 - 2019" or "1985"
      const clean = line.replace(/\s+in\s+\d{4}.*/i, '').replace(/\s+\d{4}\s*[-–]\s*.*/,'').trim();
      const atIdx = clean.lastIndexOf(' at ');
      if (atIdx > 3) {
        const degree = clean.slice(0, atIdx).trim();
        const school = clean.slice(atIdx + 4).trim();
        if (degree && school) { education.push({ degree, school }); continue; }
      }
      // Just a school name with no "at" separator
      if (clean.length > 4) education.push({ degree: '', school: clean });
    }

    // Location — comma-separated, letters only, not a job line
    let location = '';
    for (const line of lines) {
      if (line.includes('@') || line === name || line.includes(' at ')) continue;
      if (line.includes(',') && /^[A-Za-z\s,]+$/.test(line) && line.length < 80) {
        location = line;
        break;
      }
    }

    // Personal emails only — work emails are never imported (candidates who
    // only have a work address on ContactOut are skipped downstream)
    const allEmails = ((el.innerText || '').match(EMAIL_RE) || [])
      .map(e => e.toLowerCase()).filter(e => isEmail(e) && !IGNORE_DOMAINS.test(e));
    const personalEmail = allEmails.find(e => PERSONAL_RE.test(e)) || (PERSONAL_RE.test(email) ? email : '');

    return { name, email: personalEmail, linkedin, title, company, location, phone, career, education };
  }

  // ── Auto-expand all "...more" / "Show more" buttons ────────────────────────
  // Runs multiple passes because: (a) ContactOut needs time to render each
  // expansion, and (b) expanding one card can reveal new "...more" buttons.
  async function expandAllMore() {
    const isExpandBtn = el => {
      const t = (el.textContent || '').trim().toLowerCase();
      return t === '...more' || t === '…more' || t === 'show more' || t === 'see more'
          || t === '... more' || t === 'more';
    };
    let totalExpanded = 0;
    for (let pass = 0; pass < 5; pass++) {
      const btns = [...document.querySelectorAll('button, span, a, [role="button"]')]
        .filter(isExpandBtn);
      if (btns.length === 0) break;
      for (const btn of btns) {
        try { btn.click(); } catch (_) {}
        await sleep(120); // give each card time to render before the next click
      }
      totalExpanded += btns.length;
      await sleep(900); // wait for DOM updates before checking for new buttons
    }
    return totalExpanded;
  }

  // ── Floating button ────────────────────────────────────────────────────────
  function injectContactOutButton() {
    if (document.getElementById(CO_BTN_ID)) return;

    const wrap  = document.createElement('div');
    wrap.id     = CO_BTN_ID;
    const inner = document.createElement('div');
    inner.id    = CO_BTN_ID + '-inner';
    Object.assign(inner.style, {
      position: 'fixed', bottom: '28px', right: '28px', zIndex: '2147483647',
      background: '#3b5bdb', color: '#fff',
      padding: '12px 22px', borderRadius: '10px',
      fontSize: '14px', fontWeight: '600',
      fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      boxShadow: '0 4px 24px rgba(59,91,219,.45)',
      cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px',
      userSelect: 'none', transition: 'transform .15s,box-shadow .15s',
      whiteSpace: 'nowrap'
    });

    const count = findCandidateCards().length;
    inner.textContent = count > 0 ? `📥 Import ${count} contacts` : '📥 Import this page';

    wrap.appendChild(inner);
    document.body.appendChild(wrap);

    inner.addEventListener('mouseenter', () => {
      inner.style.transform = 'translateY(-2px)';
      inner.style.boxShadow = '0 8px 32px rgba(59,91,219,.6)';
    });
    inner.addEventListener('mouseleave', () => {
      inner.style.transform = '';
      inner.style.boxShadow = '0 4px 24px rgba(59,91,219,.45)';
    });
    inner.addEventListener('click', onContactOutImport);
  }

  async function onContactOutImport() {
    setCoBtnText('⏳ Revealing emails…', '#1c7ed6');
    await revealAllEmails();

    setCoBtnText('⏳ Expanding profiles…', '#1c7ed6');
    await expandAllMore();

    setCoBtnText('⏳ Reading contacts…', '#1c7ed6');
    const cards = findCandidateCards();
    const all   = cards.map(extractCandidate).filter(c => c.name);
    const candidates  = all.filter(c => c.email);
    const noPersonal  = all.length - candidates.length;

    if (candidates.length === 0) {
      const msg = cards.length === 0
        ? '❌ No contacts detected — try refreshing the page'
        : '❌ No personal emails found — only work emails were revealed';
      setCoBtnText(msg, '#e03131');
      setTimeout(resetCoBtn, 5000);
      return;
    }

    setCoBtnText(`⏳ Importing ${candidates.length}…`, '#1c7ed6');

    chrome.runtime.sendMessage({ type: 'IMPORT_CONTACTOUT_BULK', candidates }, (response) => {
      if (chrome.runtime.lastError) {
        setCoBtnText('❌ Extension error — reload page', '#e03131');
        setTimeout(resetCoBtn, 5000);
        return;
      }
      if (!response || response.error) {
        setCoBtnText('❌ ' + ((response && response.error) || 'Import failed'), '#e03131');
        setTimeout(resetCoBtn, 5000);
        return;
      }
      const { added = 0, skipped = 0 } = response;
      const parts = [`✓ ${added} added`];
      if (skipped > 0) parts.push(`${skipped} already in pipeline`);
      if (noPersonal > 0) parts.push(`${noPersonal} skipped (no personal email)`);
      setCoBtnText(parts.join(' · '), '#2f9e44');
      setTimeout(resetCoBtn, 6000);
    });
  }

  function setCoBtnText(text, bg) {
    const el = document.getElementById(CO_BTN_ID + '-inner');
    if (el) { el.textContent = text; el.style.background = bg; }
  }

  function resetCoBtn() {
    const el = document.getElementById(CO_BTN_ID + '-inner');
    if (!el) return;
    const count = findCandidateCards().length;
    el.textContent = count > 0 ? `📥 Import ${count} contacts` : '📥 Import this page';
    el.style.background = '#3b5bdb';
    el.style.transform  = '';
    el.style.boxShadow  = '0 4px 24px rgba(59,91,219,.45)';
  }

  /* ════════════════════════════════════════════════════════════
     LINKEDIN — single profile import (unchanged)
  ════════════════════════════════════════════════════════════ */

  const LI_BTN_ID = 'recruit-pro-import-btn';

  function injectLinkedInButton() {
    if (document.getElementById(LI_BTN_ID)) return;
    if (!location.pathname.startsWith('/in/')) return;

    const wrap = document.createElement('div');
    wrap.id = LI_BTN_ID;
    wrap.innerHTML = `
      <div id="${LI_BTN_ID}-inner" style="
        position:fixed; bottom:28px; right:28px; z-index:2147483647;
        background:#3b5bdb; color:#fff;
        padding:12px 22px; border-radius:10px;
        font-size:14px; font-weight:600;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
        box-shadow:0 4px 24px rgba(59,91,219,.45);
        cursor:pointer; display:flex; align-items:center; gap:8px;
        user-select:none; transition:transform .15s,box-shadow .15s;
        white-space:nowrap;
      ">
        🎯 Import to Recruit Pro
      </div>`;
    document.body.appendChild(wrap);

    const inner = wrap.querySelector(`#${LI_BTN_ID}-inner`);
    inner.addEventListener('mouseenter', () => {
      inner.style.transform = 'translateY(-2px)';
      inner.style.boxShadow = '0 8px 32px rgba(59,91,219,.6)';
    });
    inner.addEventListener('mouseleave', () => {
      inner.style.transform = '';
      inner.style.boxShadow = '0 4px 24px rgba(59,91,219,.45)';
    });
    inner.addEventListener('click', onLinkedInImport);
  }

  async function onLinkedInImport() {
    setLiBtn('⏳ Revealing email…', '#1c7ed6');
    await revealAllEmails();

    setLiBtn('⏳ Importing…', '#1c7ed6');
    const payload = {
      type:     'IMPORT_PROFILE',
      url:      location.href,
      text:     document.body.innerText,
      coEmails: readContactOutEmails()
    };
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        setLiBtn('❌ Extension error — reload page', '#e03131');
        setTimeout(resetLiBtn, 5000);
        return;
      }
      if (!response || response.error) {
        const msg = response && response.skipped
          ? '⏭️ Skipped — no personal email found'
          : '❌ ' + ((response && response.error) || 'Import failed');
        setLiBtn(msg, response && response.skipped ? '#f08c00' : '#e03131');
        setTimeout(resetLiBtn, 6000);
        return;
      }
      setLiBtn(`✓ ${response.name || 'Added'} · ${response.email}`, '#2f9e44');
      setTimeout(resetLiBtn, 4000);
    });
  }

  function setLiBtn(text, bg) {
    const inner = document.getElementById(`${LI_BTN_ID}-inner`);
    if (inner) { inner.textContent = text; inner.style.background = bg; }
  }

  function resetLiBtn() {
    const inner = document.getElementById(`${LI_BTN_ID}-inner`);
    if (inner) {
      inner.innerHTML = '🎯 Import to Recruit Pro';
      inner.style.background = '#3b5bdb';
      inner.style.transform = '';
      inner.style.boxShadow = '0 4px 24px rgba(59,91,219,.45)';
    }
  }

  // Walk shadow DOM to harvest ContactOut-revealed emails on LinkedIn pages
  function readContactOutEmails() {
    const seen   = new Set();
    const emails = [];

    function addEmail(e) {
      const clean = (e || '').toLowerCase().trim().replace(/[)>.,;]+$/, '');
      if (clean && isEmail(clean) && !IGNORE_DOMAINS.test(clean) && !seen.has(clean)) {
        seen.add(clean);
        emails.push(clean);
      }
    }

    function walk(root) {
      if (!root || !root.querySelectorAll) return;
      root.querySelectorAll('a[href^="mailto:"]').forEach(a => {
        addEmail((a.getAttribute('href') || '').replace(/^mailto:/i, '').split('?')[0]);
      });
      (((root.textContent) || '').match(EMAIL_RE) || []).forEach(addEmail);
      root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) walk(el.shadowRoot); });
    }

    walk(document);
    return emails;
  }

  /* ════════════════════════════════════════════════════════════
     ROUTER — decide which mode to activate
  ════════════════════════════════════════════════════════════ */

  if (isContactOutPage()) {
    // Inject after page renders (results load async)
    setTimeout(injectContactOutButton, 2000);

    // Re-inject on SPA navigation (ContactOut is a React SPA)
    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        const old = document.getElementById(CO_BTN_ID);
        if (old) old.remove();
        setTimeout(injectContactOutButton, 2000);
      }
    }, 800);

    // Also re-inject when results load dynamically (button got removed or wasn't there yet)
    const obs = new MutationObserver(() => {
      if (!document.getElementById(CO_BTN_ID)) injectContactOutButton();
    });
    obs.observe(document.body, { childList: true, subtree: true });

  } else {
    // LinkedIn: inject on /in/ profile pages
    let lastPath = location.pathname;

    function checkPath() {
      const path = location.pathname;
      if (path === lastPath) return;
      lastPath = path;
      const old = document.getElementById(LI_BTN_ID);
      if (old) old.remove();
      if (path.startsWith('/in/')) setTimeout(injectLinkedInButton, 1200);
    }

    ['pushState', 'replaceState'].forEach(method => {
      const original = history[method].bind(history);
      history[method] = function (...args) { original(...args); setTimeout(checkPath, 100); };
    });
    window.addEventListener('popstate', () => setTimeout(checkPath, 100));

    const obs = new MutationObserver(() => checkPath());
    obs.observe(document.body, { childList: true, subtree: false });

    injectLinkedInButton();
  }

})();
