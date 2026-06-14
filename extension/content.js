/* ============================================================
   Recruit Pro — LinkedIn content script (Manifest V3)
   Injects a floating import button on linkedin.com/in/* pages.
   Also reads any emails already injected by ContactOut.
   ============================================================ */

(function () {
  'use strict';

  const BTN_ID = 'recruit-pro-import-btn';

  // ── Button injection ──────────────────────────────────────────────────────
  function injectButton () {
    if (document.getElementById(BTN_ID)) return;
    if (!location.pathname.startsWith('/in/')) return;

    const wrap = document.createElement('div');
    wrap.id = BTN_ID;
    wrap.innerHTML = `
      <div id="${BTN_ID}-inner" style="
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

    const inner = wrap.querySelector(`#${BTN_ID}-inner`);
    inner.addEventListener('mouseenter', () => {
      inner.style.transform = 'translateY(-2px)';
      inner.style.boxShadow = '0 8px 32px rgba(59,91,219,.6)';
    });
    inner.addEventListener('mouseleave', () => {
      inner.style.transform = '';
      inner.style.boxShadow = '0 4px 24px rgba(59,91,219,.45)';
    });

    inner.addEventListener('click', onImportClick);
  }

  // ── Import click handler ──────────────────────────────────────────────────
  function onImportClick () {
    const inner = document.getElementById(`${BTN_ID}-inner`);
    if (!inner) return;

    setBtn('⏳ Importing…', '#1c7ed6');

    const payload = {
      type:     'IMPORT_PROFILE',
      url:      location.href,
      text:     document.body.innerText,
      coEmails: readContactOutEmails()
    };

    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        setBtn('❌ Extension error — reload page', '#e03131');
        setTimeout(resetBtn, 5000);
        return;
      }
      if (!response || response.error) {
        const msg = (response && response.error) || 'Import failed';
        setBtn('❌ ' + msg, '#e03131');
        setTimeout(resetBtn, 5000);
        return;
      }
      if (response.email) {
        setBtn(`✓ ${response.name || 'Added'} · ${response.email}`, '#2f9e44');
        setTimeout(resetBtn, 4000);
      } else {
        // Imported, but ContactOut hadn't revealed an email on the page.
        setBtn('✓ Added — no email found. Reveal it in ContactOut, then add it in the app.', '#f08c00');
        setTimeout(resetBtn, 7000);
      }
    });
  }

  function setBtn (text, bg) {
    const inner = document.getElementById(`${BTN_ID}-inner`);
    if (inner) { inner.textContent = text; inner.style.background = bg; }
  }

  function resetBtn () {
    const inner = document.getElementById(`${BTN_ID}-inner`);
    if (inner) {
      inner.innerHTML = '🎯 Import to Recruit Pro';
      inner.style.background = '#3b5bdb';
      inner.style.transform = '';
      inner.style.boxShadow = '0 4px 24px rgba(59,91,219,.45)';
    }
  }

  // ── Read ContactOut revealed emails from the page ─────────────────────────
  // ContactOut renders revealed emails inside (often nested) shadow DOM, which
  // ordinary querySelectorAll can't see through. We walk every open shadow root
  // recursively and harvest real email addresses + mailto: links. No guessing —
  // this only returns emails ContactOut has actually displayed on the page.
  const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  // Infra domains we never want to capture as a candidate's email.
  const IGNORE_DOMAINS = /@(linkedin\.com|licdn\.com|contactout\.com|example\.com|sentry\.|w3\.org)/i;

  function readContactOutEmails () {
    const seen = new Set();
    const emails = [];

    function addEmail (e) {
      const clean = (e || '').toLowerCase().trim().replace(/[)>.,;]+$/, '');
      if (clean && isEmail(clean) && !IGNORE_DOMAINS.test(clean) && !seen.has(clean)) {
        seen.add(clean);
        emails.push(clean);
      }
    }

    // Recursively walk the DOM, descending into every open shadow root.
    function walk (root) {
      if (!root || !root.querySelectorAll) return;

      // mailto: links inside this root
      root.querySelectorAll('a[href^="mailto:"]').forEach(a => {
        addEmail((a.getAttribute('href') || '').replace(/^mailto:/i, '').split('?')[0]);
      });

      // Plain-text emails in this root's own text (dedup handles repeats)
      (((root.textContent) || '').match(EMAIL_RE) || []).forEach(addEmail);

      // Descend into the shadow root of every element
      root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) walk(el.shadowRoot); });
    }

    walk(document);
    return emails;
  }

  function isEmail (s) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
  }

  // ── SPA navigation — LinkedIn is a React SPA ─────────────────────────────
  // Re-inject the button when the URL changes to an /in/ profile.
  let lastPath = location.pathname;

  function checkPath () {
    const path = location.pathname;
    if (path === lastPath) return;
    lastPath = path;

    // Remove old button if we navigated away
    const old = document.getElementById(BTN_ID);
    if (old) old.remove();

    // Inject fresh button after LinkedIn finishes rendering (~1.2 s)
    if (path.startsWith('/in/')) {
      setTimeout(injectButton, 1200);
    }
  }

  // Intercept pushState / replaceState (LinkedIn's router)
  ['pushState', 'replaceState'].forEach(method => {
    const original = history[method].bind(history);
    history[method] = function (...args) {
      original(...args);
      setTimeout(checkPath, 100);
    };
  });
  window.addEventListener('popstate', () => setTimeout(checkPath, 100));

  // MutationObserver fallback for URL changes we missed
  const obs = new MutationObserver(() => checkPath());
  obs.observe(document.body, { childList: true, subtree: false });

  // Initial inject (page already loaded on /in/)
  injectButton();

})();
