// Site-wide behaviour: clicking anywhere in a date/time input opens its
// native picker, not just the small calendar/clock icon. Applies to every
// date/time field on every page, now and for anything added later.
(function () {
  document.addEventListener('click', function (e) {
    var input = e.target.closest('input[type="date"], input[type="time"], input[type="datetime-local"]');
    if (!input || typeof input.showPicker !== 'function') return;
    try {
      input.showPicker();
    } catch (err) {
      // showPicker() can throw if the input isn't visible/focusable; ignore.
    }
  });
})();

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
