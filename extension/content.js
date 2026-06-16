/* ============================================================
   Recruit Pro — Content script (Manifest V3)
   • ContactOut search results: bulk-import the whole page
   • LinkedIn /in/ profile: single-import with ContactOut email pickup
   ============================================================ */

(function () {
  'use strict';

  const EMAIL_RE      = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const EMAIL_EXACT   = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
  const IGNORE_DOMAINS = /@(linkedin\.com|licdn\.com|contactout\.com|example\.com|sentry\.|w3\.org)/i;
  const PERSONAL_RE   = /@(gmail|yahoo|hotmail|outlook|icloud|me|live|aol|protonmail|pm)\./i;

  function isEmail(s) { return EMAIL_EXACT.test(s); }
  function sleep(ms)  { return new Promise(r => setTimeout(r, ms)); }

  /* ════════════════════════════════════════════════════════════
     CONTACTOUT — bulk import from search results page
  ════════════════════════════════════════════════════════════ */

  const CO_BTN_ID = 'recruit-pro-co-btn';

  function isContactOutPage() {
    return location.hostname.includes('contactout.com');
  }

  // ── Find candidate card elements by walking up from visible email text nodes ──
  // This approach doesn't rely on any ContactOut class names or HTML structure —
  // it finds email addresses in the DOM text, then climbs up to the card boundary.
  function findCandidateCards() {
    const seen   = new Set(); // dedup by email
    const cards  = [];        // { email, el } pairs

    // Walk every text node in the page
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const txt = node.textContent.trim();
      if (!isEmail(txt) || IGNORE_DOMAINS.test(txt)) continue;
      const email = txt.toLowerCase();
      if (seen.has(email)) continue;
      seen.add(email);

      // Walk UP from this text node's parent to find the card boundary.
      // The card is the first ancestor that:
      //   (a) has at least 3 newlines worth of content (name + title + company)
      //   (b) is not the whole page
      let el = node.parentElement;
      let card = null;
      for (let i = 0; i < 12; i++) {
        if (!el || el === document.body) break;
        const text = el.innerText || '';
        const lines = text.split('\n').filter(l => l.trim()).length;
        // A candidate card has 4+ non-empty lines and is not the entire results list
        if (lines >= 4 && lines <= 40) {
          card = el;
          break;
        }
        el = el.parentElement;
      }
      if (card) cards.push({ email, el: card });
    }
    return cards;
  }

  // ── Extract one candidate from a card element ──────────────────────────────
  function extractCandidate({ email, el }) {
    const lines = (el.innerText || '')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);

    // LinkedIn URL — try href first, then data attributes, then text containing linkedin.com/in/
    let linkedin = '';
    const liAnchor = el.querySelector('a[href*="linkedin.com/in/"]');
    if (liAnchor) {
      linkedin = liAnchor.href.split('?')[0];
    } else {
      // Some SPAs store it in data attributes
      const dataEl = el.querySelector('[data-url*="linkedin.com/in/"], [data-href*="linkedin.com/in/"]');
      if (dataEl) linkedin = (dataEl.dataset.url || dataEl.dataset.href || '').split('?')[0];
    }

    // Phone — tel: link
    const telLink = el.querySelector('a[href^="tel:"]');
    const phone = telLink ? telLink.href.replace('tel:', '').trim() : '';

    // Name — first line that looks like a human name (2–5 words, letters only, no @)
    let name = '';
    for (const line of lines) {
      if (line.includes('@')) continue;
      if (line.includes(' at ') || line.includes(' in ')) continue;
      const words = line.split(/\s+/);
      if (words.length >= 2 && words.length <= 5 && /^[A-Za-z\-'. ]+$/.test(line)) {
        name = line;
        break;
      }
    }

    // Title + Company — first line matching "Title at Company" (skip name and email lines)
    let title = '', company = '';
    for (const line of lines) {
      if (line === name || line.includes('@')) continue;
      const atIdx = line.lastIndexOf(' at ');
      if (atIdx > 3 && atIdx < line.length - 4) {
        title   = line.slice(0, atIdx).trim()
          .replace(/^(Vice President|VP|Director|Manager|Senior|Head|Chief|Lead),?\s+/i, m => m); // keep full title
        company = line.slice(atIdx + 4)
          .replace(/\s+in\s+\d{4}.*/i, '')   // strip "in 2020 - Present"
          .replace(/\s+\d{4}\s*[-–]\s*.*/,'') // strip trailing years
          .trim();
        break;
      }
    }

    // Work history — all "Title at Company" lines
    const career = [];
    for (const line of lines) {
      if (line === name || line.includes('@')) continue;
      const atIdx = line.lastIndexOf(' at ');
      if (atIdx > 3 && atIdx < line.length - 4) {
        const t = line.slice(0, atIdx).trim();
        const c = line.slice(atIdx + 4).replace(/\s+in\s+\d{4}.*/i, '').replace(/\s+\d{4}\s*[-–]\s*.*/,'').trim();
        if (t && c) career.push({ title: t, company: c });
      }
    }

    // Location — line that has commas and looks like "City, State, Country"
    let location = '';
    for (const line of lines) {
      if (line.includes('@') || line === name) continue;
      if (line.includes(',') && !line.includes(' at ') && /^[A-Za-z\s,]+$/.test(line)) {
        location = line;
        break;
      }
    }

    // Prefer personal email
    const allEmails = ((el.innerText || '').match(EMAIL_RE) || [])
      .map(e => e.toLowerCase())
      .filter(e => isEmail(e) && !IGNORE_DOMAINS.test(e));
    const personalEmail = allEmails.find(e => PERSONAL_RE.test(e));
    const bestEmail = personalEmail || email;

    return { name, email: bestEmail, linkedin, title, company, location, phone, career };
  }

  // ── Auto-expand all "...more" / "Show more" buttons ────────────────────────
  async function expandAllMore() {
    const btns = [...document.querySelectorAll('button, span, a, [role="button"]')]
      .filter(el => {
        const t = (el.textContent || '').trim().toLowerCase();
        return t === '...more' || t === '…more' || t === 'show more' || t === 'see more'
          || t === '... more' || t === 'more';
      });
    for (const btn of btns) { try { btn.click(); } catch (_) {} await sleep(20); }
    if (btns.length > 0) await sleep(600);
  }

  // ── Floating button ────────────────────────────────────────────────────────
  function injectContactOutButton() {
    if (document.getElementById(CO_BTN_ID)) return;
    // Only inject on pages that look like search results (have at least one email visible)
    if (!document.body.innerText.match(EMAIL_RE)) return;

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
    setCoBtnText('⏳ Expanding profiles…', '#1c7ed6');
    await expandAllMore();

    setCoBtnText('⏳ Reading contacts…', '#1c7ed6');
    const cards = findCandidateCards();
    const all   = cards.map(extractCandidate).filter(c => c.name);
    const candidates = all.filter(c => c.email);
    const noEmail    = all.length - candidates.length;

    if (candidates.length === 0) {
      const msg = cards.length === 0
        ? '❌ No contacts detected — try refreshing the page'
        : '❌ No revealed emails — reveal emails in ContactOut first';
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
      if (noEmail  > 0) parts.push(`${noEmail} skipped (no email)`);
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

  function onLinkedInImport() {
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
        setLiBtn('❌ ' + ((response && response.error) || 'Import failed'), '#e03131');
        setTimeout(resetLiBtn, 5000);
        return;
      }
      if (response.email) {
        setLiBtn(`✓ ${response.name || 'Added'} · ${response.email}`, '#2f9e44');
        setTimeout(resetLiBtn, 4000);
      } else {
        setLiBtn('✓ Added — no email found. Reveal it in ContactOut first.', '#f08c00');
        setTimeout(resetLiBtn, 7000);
      }
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
