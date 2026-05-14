/* ============================================================
   Welltower Recruiter — Modal & Toast Utilities
   ============================================================ */

// ---- Toast notifications ----
const Toast = {
  container: null,

  init() {
    if (!this.container) {
      this.container = document.createElement('div');
      this.container.className = 'toast-container';
      document.body.appendChild(this.container);
    }
  },

  show(message, type = 'default', duration = 3500) {
    this.init();
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    this.container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(24px)';
      toast.style.transition = 'opacity 0.25s, transform 0.25s';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  },

  success(msg) { this.show(msg, 'success'); },
  error(msg) { this.show(msg, 'error', 5000); },
  warning(msg) { this.show(msg, 'warning'); }
};

// ---- Modal management ----
class Modal {
  constructor(id) {
    this.overlay = document.getElementById(id);
    if (!this.overlay) return;
    this.modal = this.overlay.querySelector('.modal');

    // Close on overlay click
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });

    // Close button
    const closeBtn = this.overlay.querySelector('.modal-close');
    if (closeBtn) closeBtn.addEventListener('click', () => this.close());

    // Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen()) this.close();
    });
  }

  open() {
    if (!this.overlay) return;
    this.overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    // Focus first input
    setTimeout(() => {
      const input = this.overlay.querySelector('input:not([type=hidden]), textarea, select');
      if (input) input.focus();
    }, 150);
  }

  close() {
    if (!this.overlay) return;
    this.overlay.classList.remove('open');
    document.body.style.overflow = '';
  }

  isOpen() {
    return this.overlay && this.overlay.classList.contains('open');
  }
}

// ---- Confirm dialog ----
function showConfirm(message, title = 'Confirm') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.innerHTML = `
      <div class="modal" style="max-width:380px">
        <div class="modal-header">
          <h3>${title}</h3>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          <p style="margin:0;font-size:0.9rem;color:#374151">${message}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary cancel-btn">Cancel</button>
          <button class="btn btn-danger confirm-btn">Confirm</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    const cleanup = (result) => {
      overlay.remove();
      document.body.style.overflow = '';
      resolve(result);
    };

    overlay.querySelector('.confirm-btn').addEventListener('click', () => cleanup(true));
    overlay.querySelector('.cancel-btn').addEventListener('click', () => cleanup(false));
    overlay.querySelector('.modal-close').addEventListener('click', () => cleanup(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
  });
}

// ---- AI Draft modal ----
function showAIDraft({ title, draft, onSend, onEdit, onInsertToCompose, editable = true }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay open';
  overlay.innerHTML = `
    <div class="modal" style="max-width:600px">
      <div class="modal-header">
        <h3>${title}</h3>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body">
        ${editable
          ? `<textarea class="ai-edit-area" style="width:100%;min-height:220px;font-size:0.875rem;line-height:1.6;border:1.5px solid #e2e8f0;border-radius:8px;padding:12px;outline:none;resize:vertical">${escapeHtml(draft)}</textarea>`
          : `<div class="ai-draft" style="max-height:340px;overflow-y:auto">${escapeHtml(draft)}</div>`
        }
      </div>
      <div class="modal-footer" style="gap:8px;flex-wrap:wrap">
        ${onInsertToCompose ? '<button class="btn btn-secondary insert-btn">Insert to Compose</button>' : ''}
        ${onEdit ? '<button class="btn btn-secondary edit-btn">Edit</button>' : ''}
        ${onSend ? '<button class="btn btn-primary send-btn">Send Email</button>' : ''}
        <button class="btn btn-ghost close-btn">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';

  const cleanup = () => {
    overlay.remove();
    document.body.style.overflow = '';
  };

  overlay.querySelector('.modal-close').addEventListener('click', cleanup);
  overlay.querySelector('.close-btn').addEventListener('click', cleanup);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });

  const getContent = () => {
    const ta = overlay.querySelector('.ai-edit-area');
    return ta ? ta.value : draft;
  };

  if (onSend) {
    overlay.querySelector('.send-btn').addEventListener('click', () => {
      onSend(getContent());
      cleanup();
    });
  }
  if (onInsertToCompose) {
    overlay.querySelector('.insert-btn').addEventListener('click', () => {
      onInsertToCompose(getContent());
      cleanup();
    });
  }
  if (onEdit) {
    overlay.querySelector('.edit-btn').addEventListener('click', () => {
      onEdit(getContent());
      cleanup();
    });
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#10;');
}
