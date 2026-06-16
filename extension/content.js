/* ============================================================
   Recruit Pro — Content script (Manifest V3)
   • ContactOut search results: bulk-import the whole page
   • LinkedIn /in/ profile: single-import with ContactOut email pickup
   ============================================================ */

(function () {
  'use strict';

  const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const IGNORE_DOMAINS = /@(linkedin\.com|licdn\.com|contactout\.com|example\.com|sentry\.|w3\.org)/i;

  function isEmail(s) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /* ════════════════════════════════════════════════════════════
     CONTACTOUT — bulk import from search results page
  ════════════════════════════════════════════════════════════ */

  const CO_BTN_ID = 'recruit-pro-co-btn';

  function isContactOutPage() {
    return location.hostname.includes('contactout.com');
  }

  // ── Find all candidate rows on the page ────────────────────────────────────
  // ContactOut renders results as a list of repeated card elements.
  // We anchor on LinkedIn links — every row that has one is a candidate card.
  function findCandidateRows() {
    const liLinks = [...document.querySelectorAll('a[href*="linkedin.com/in/"]')];
    if (liLinks.length === 0) return [];

    // Walk up from each LinkedIn link to find the common card ancestor.
    // We look for an ancestor that contains an email address — that's the card boundary.
    const rows = new Set();
    for (const link of liLinks) {
      let el = link;
      for (let i = 0; i < 10; i++) {
        el = el.parentElement;
        if (!el) break;
        const txt = el.innerText || '';
        if (EMAIL_RE.test(txt) || txt.includes('@')) {
          rows.add(el);
          break;
        }
        // Also stop at very wide containers to avoid capturing the whole page
        if (el === document.body) break;
      }
    }
    return [...rows];
  }

  // ── Extract one candidate from a card element ──────────────────────────────
  function extractCandidate(row) {
    const rowText = row.innerText || row.textContent || '';

    // LinkedIn URL
    const liLink = row.querySelector('a[href*="linkedin.com/in/"]');
    const linkedin = liLink ? liLink.href.split('?')[0] : '';

    // Email — scrape visible text (ContactOut shows them plainly)
    const emailMatches = (rowText.match(EMAIL_RE) || []).filter(
      e => isEmail(e) && !IGNORE_DOMAINS.test(e)
    );
    const email = emailMatches[0] || '';

    // Phone — look for tel: links or phone-pattern text
    const telLink = row.querySelector('a[href^="tel:"]');
    const phone = telLink ? telLink.href.replace('tel:', '').trim() : '';

    // Name — ContactOut puts the name in a prominent element near the top of the card.
    // Try common class name patterns, then fall back to the first sizeable bold text.
    let name = '';
    const nameSelectors = [
      '[class*="name"]', '[class*="Name"]',
      '[class*="person"]', 'h2', 'h3', 'h4',
      'strong', 'b'
    ];
    for (const sel of nameSelectors) {
      const el = row.querySelector(sel);
      if (el) {
        const t = el.textContent.trim();
        // Must look like a human name: 2–5 words, no @ sign
        if (t && !t.includes('@') && t.split(/\s+/).length >= 2 && t.split(/\s+/).length <= 6) {
          name = t;
          break;
        }
      }
    }

    // Title + Company — look for "X at Y" patterns in the card text
    let title = '', company = '';
    const lines = rowText.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.includes('@') || line === name) continue;
      const atIdx = line.lastIndexOf(' at ');
      if (atIdx > 5 && atIdx < line.length - 4) {
        title   = line.slice(0, atIdx).trim();
        company = line.slice(atIdx + 4).replace(/\s+in\s+\d{4}.*/i, '').trim();
        break;
      }
    }

    // Location — typically after the name/icons line, doesn't contain "at "
    let location = '';
    const locEl = row.querySelector('[class*="location"], [class*="Location"]');
    if (locEl) {
      location = locEl.textContent.trim();
    } else {
      // Heuristic: a line that looks like "City, State, Country"
      for (const line of lines) {
        if (line.includes(',') && !line.includes('@') && !line.includes(' at ') && line !== name) {
          if (/[A-Z][a-z]+,\s*[A-Z]/.test(line)) { location = line; break; }
        }
      }
    }

    // Work history — all lines matching "Title at Company" after expanding "...more"
    const career = [];
    for (const line of lines) {
      const atIdx = line.lastIndexOf(' at ');
      if (atIdx > 5 && atIdx < line.length - 4 && !line.includes('@')) {
        const t = line.slice(0, atIdx).trim();
        const c = line.slice(atIdx + 4).replace(/\s+in\s+\d{4}.*/i, '').trim();
        if (t && c) career.push({ title: t, company: c });
      }
    }

    return { name, email, linkedin, title, company, location, phone, career };
  }

  // ── Auto-expand all "...more" / "Show more" buttons ────────────────────────
  async function expandAllMore() {
    const candidates = [...document.querySelectorAll('button, span[role="button"], a')].filter(el => {
      const t = (el.textContent || '').trim().toLowerCase();
      return t === '...more' || t === '…more' || t === 'show more' || t === 'see more';
    });
    for (const btn of candidates) {
      try { btn.click(); } catch (_) {}
      await sleep(30);
    }
    if (candidates.length > 0) await sleep(600);
  }

  // ── Inject floating button for ContactOut ──────────────────────────────────
  function injectContactOutButton() {
    if (document.getElementById(CO_BTN_ID)) return;

    const count = findCandidateRows().length;
    if (count === 0) return;

    const wrap = document.createElement('div');
    wrap.id = CO_BTN_ID;
    const inner = document.createElement('div');
    inner.id = CO_BTN_ID + '-inner';
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
    inner.textContent = `📥 Import ${count} contacts`;
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
    const rows    = findCandidateRows();
    const candidates = rows.map(extractCandidate).filter(c => c.name);

    if (candidates.length === 0) {
      setCoBtnText('❌ No contacts found on page', '#e03131');
      setTimeout(resetCoBtn, 4000);
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
      const msg = skipped > 0
        ? `✓ ${added} added · ${skipped} already in pipeline`
        : `✓ ${added} contacts added`;
      setCoBtnText(msg, '#2f9e44');
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
    const count = findCandidateRows().length;
    el.textContent = `📥 Import ${count} contacts`;
    el.style.background = '#3b5bdb';
    el.style.transform = '';
    el.style.boxShadow = '0 4px 24px rgba(59,91,219,.45)';
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
    // ContactOut: inject button once results render, re-check on navigation
    setTimeout(injectContactOutButton, 1500);

    // Re-inject when ContactOut navigates (SPA)
    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        const old = document.getElementById(CO_BTN_ID);
        if (old) old.remove();
        setTimeout(injectContactOutButton, 1500);
      }
    }, 800);

    // Also watch for results dynamically loading in
    const obs = new MutationObserver(() => {
      if (!document.getElementById(CO_BTN_ID)) injectContactOutButton();
    });
    obs.observe(document.body, { childList: true, subtree: true });

  } else {
    // LinkedIn: inject button on /in/ pages
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
      history[method] = function (...args) {
        original(...args);
        setTimeout(checkPath, 100);
      };
    });
    window.addEventListener('popstate', () => setTimeout(checkPath, 100));

    const obs = new MutationObserver(() => checkPath());
    obs.observe(document.body, { childList: true, subtree: false });

    injectLinkedInButton();
  }

})();
