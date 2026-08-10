// Site-wide behaviour: any button with data-target="someId" toggles the
// hidden attribute on the element with that id. Used for inline reveal
// forms (e.g. "Upload completed" on a job's forms list).
(function () {
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-target]');
    if (!btn) return;
    var target = document.getElementById(btn.getAttribute('data-target'));
    if (target) target.hidden = !target.hidden;
  });
})();

// Site-wide centered confirmation modal, replacing native confirm() so every
// delete/remove action across the app looks and behaves the same way.
//
// Declarative use: add data-confirm="Delete this X?" to any <form> - its
// submit is intercepted, the modal shows that message, and the form only
// actually submits once the user clicks the modal's confirm button.
//
// Imperative use (for JS-driven actions, e.g. a context menu that builds and
// submits a form dynamically): window.showConfirm(title, message, onConfirm).
(function () {
  var modal = document.getElementById('confirm-modal');
  if (!modal) return;

  var titleEl = document.getElementById('confirm-modal-title');
  var messageEl = document.getElementById('confirm-modal-message');
  var okBtn = document.getElementById('confirm-modal-ok');
  var cancelBtn = document.getElementById('confirm-modal-cancel');
  var pendingAction = null;

  function showConfirm(title, message, onConfirm, options) {
    titleEl.textContent = title;
    messageEl.textContent = message;
    okBtn.textContent = (options && options.okLabel) || 'Delete';
    okBtn.className = 'btn btn-' + ((options && options.variant) || 'danger');
    pendingAction = onConfirm;
    modal.hidden = false;
  }

  function hideConfirm() {
    modal.hidden = true;
    pendingAction = null;
    okBtn.textContent = 'Delete';
    okBtn.className = 'btn btn-danger';
  }

  cancelBtn.addEventListener('click', hideConfirm);
  modal.addEventListener('click', function (e) {
    if (e.target === modal) hideConfirm();
  });
  okBtn.addEventListener('click', function () {
    var action = pendingAction;
    hideConfirm();
    if (action) action();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modal.hidden) hideConfirm();
  });

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    var message = form.getAttribute('data-confirm');
    if (!message || form.dataset.confirmed === 'true') return;
    e.preventDefault();
    okBtn.textContent = form.getAttribute('data-confirm-ok-label') || 'Delete';
    okBtn.className = 'btn btn-' + (form.getAttribute('data-confirm-variant') || 'danger');
    showConfirm(form.getAttribute('data-confirm-title') || 'Are you sure?', message, function () {
      form.dataset.confirmed = 'true';
      if (form.requestSubmit) form.requestSubmit();
      else form.submit();
    });
  });

  window.showConfirm = showConfirm;
})();

// Site-wide behaviour: disables every submit button in a form the instant it
// actually starts submitting, so a slow connection (a click that feels like
// nothing happened) can't be turned into a second click and a second POST -
// this is what was creating duplicate leave requests / assets. Skips a
// data-confirm form's first, intercepted submit; only the confirmed
// resubmission is the real one.
(function () {
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (e.defaultPrevented) return; // validation blocked this submit — leave buttons active
    if (form.hasAttribute('data-confirm') && form.dataset.confirmed !== 'true') return;

    var buttons = form.querySelectorAll('button[type="submit"], input[type="submit"]');
    buttons.forEach(function (btn) {
      if (btn.disabled) return;
      btn.disabled = true;
      if (btn.tagName === 'BUTTON') btn.textContent = 'Saving...';
    });
  });
})();

// Site-wide behaviour: any <form data-preserve-scroll> remembers the page's
// scroll position right before it actually submits, and the resulting page
// reload restores it - so actions like "Save quote" on a long job page don't
// jerk the user back to the top. Skips the save on a submit that's about to
// be cancelled anyway (e.g. the data-confirm modal hasn't been accepted yet).
(function () {
  var KEY_PREFIX = 'scrollPos:';
  var key = KEY_PREFIX + window.location.pathname;

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!(form instanceof HTMLFormElement) || !form.hasAttribute('data-preserve-scroll')) return;
    if (form.hasAttribute('data-confirm') && form.dataset.confirmed !== 'true') return;
    sessionStorage.setItem(key, String(window.scrollY));
  });

  var saved = sessionStorage.getItem(key);
  if (saved !== null) {
    sessionStorage.removeItem(key);
    window.addEventListener('load', function () {
      window.scrollTo(0, Number.parseInt(saved, 10));
    });
  }
})();

// Site-wide context menu (row-menu-btn + context-menu).
// Usage: add class="row-menu-btn" to a trigger button, class="context-menu"
// to the sibling dropdown, both inside a class="row-menu-cell" container.
// Uses position:fixed so it works inside overflow:auto scroll containers.
(function () {
  function closeAll(exceptMenu) {
    document.querySelectorAll('.context-menu:not([hidden])').forEach(function (m) {
      if (m === exceptMenu) return;
      m.hidden = true;
      m.style.cssText = '';
      var btn = m.closest('.row-menu-cell') && m.closest('.row-menu-cell').querySelector('.row-menu-btn');
      if (btn) { btn.classList.remove('row-menu-btn-active'); btn.setAttribute('aria-expanded', 'false'); }
    });
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.row-menu-btn');
    if (!btn) { closeAll(null); return; }
    var cell = btn.closest('.row-menu-cell');
    var menu = cell && cell.querySelector('.context-menu');
    if (!menu) return;
    var opening = menu.hidden;
    closeAll(opening ? null : menu);
    if (opening) {
      var r = btn.getBoundingClientRect();
      menu.style.position = 'fixed';
      menu.style.top = (r.bottom + 4) + 'px';
      menu.style.right = (window.innerWidth - r.right) + 'px';
      menu.style.left = 'auto';
      menu.hidden = false;
      btn.classList.add('row-menu-btn-active');
      btn.setAttribute('aria-expanded', 'true');
    }
    e.stopPropagation();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeAll(null);
  });

  window.addEventListener('scroll', function () { closeAll(null); }, true);
  window.addEventListener('resize', function () { closeAll(null); });
})();

// Convert inline flash messages to floating toasts so they're visible
// regardless of scroll position (e.g. stock error while scrolled to bottom).
(function () {
  var flash = document.querySelector('.flash');
  if (!flash) return;

  var isError = flash.classList.contains('flash-error');

  // Clone into a fixed-position toast
  var toast = document.createElement('div');
  toast.className = flash.className + ' flash-toast';
  toast.textContent = flash.textContent;
  toast.style.cssText = [
    'position:fixed',
    'bottom:1.25rem',
    'right:1.25rem',
    'z-index:9999',
    'max-width:380px',
    'box-shadow:0 4px 16px rgba(0,0,0,0.18)',
    'cursor:pointer',
    'padding:0.75rem 1rem',
  ].join(';');

  document.body.appendChild(toast);

  function dismiss() {
    toast.style.transition = 'opacity 0.3s';
    toast.style.opacity = '0';
    setTimeout(function () { toast.remove(); }, 320);
  }

  toast.addEventListener('click', dismiss);
  setTimeout(dismiss, isError ? 8000 : 5000);
})();
