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
    showConfirm(
      form.getAttribute('data-confirm-title') || 'Are you sure?',
      message,
      function () {
        form.dataset.confirmed = 'true';
        if (form.requestSubmit) form.requestSubmit();
        else form.submit();
      },
      { okLabel: form.getAttribute('data-confirm-ok-label'), variant: form.getAttribute('data-confirm-variant') }
    );
  });

  window.showConfirm = showConfirm;
})();

// Site-wide behaviour: any <form data-geotag> has the browser's current GPS
// position attached as hidden lat/lng fields right before it actually
// submits - used by the job's actual start/finish time forms so admins can
// see where the tech was when they logged it, in the job's History card.
// Mirrors the data-confirm pattern above: intercept, do the async work, mark
// the form so the resubmission isn't re-intercepted, then resubmit for real.
// Never blocks the save on a flaky/denied GPS fix - falls back to no
// location after a short timeout either way.
(function () {
  function setHidden(form, name, value) {
    var input = form.querySelector('input[name="' + name + '"]');
    if (!input) {
      input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      form.appendChild(input);
    }
    input.value = value;
  }

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!(form instanceof HTMLFormElement) || !form.hasAttribute('data-geotag')) return;
    if (form.dataset.geotagged === 'true') return;
    if (form.hasAttribute('data-confirm') && form.dataset.confirmed !== 'true') return;
    e.preventDefault();

    function finish(coords) {
      form.dataset.geotagged = 'true';
      if (coords) {
        setHidden(form, 'lat', coords.latitude);
        setHidden(form, 'lng', coords.longitude);
      }
      if (form.requestSubmit) form.requestSubmit();
      else form.submit();
    }

    if (!navigator.geolocation) return finish(null);

    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      finish(null);
    }, 5000);

    navigator.geolocation.getCurrentPosition(
      function (pos) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        finish(pos.coords);
      },
      function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        finish(null);
      },
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 60000 }
    );
  });
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
    var targetY = Number.parseInt(saved, 10);

    // A single restore-on-load can get silently undone by content that
    // settles slightly after `load` fires - a slow attachment photo on a
    // job card, a web font swap reflowing text below it. This is most
    // noticeable on a slow mobile connection, where it can look like the
    // restore never happened at all. Re-assert the position for a short
    // window instead of trusting one shot, but stop the moment the user
    // actually touches/scrolls themselves so it never fights real intent.
    function restore() { window.scrollTo(0, targetY); }

    if (document.readyState === 'complete') restore();
    else window.addEventListener('load', restore);

    var attempts = 0;
    var retry = setInterval(function () {
      attempts++;
      restore();
      if (attempts >= 10) clearInterval(retry);
    }, 100);

    var stopRetrying = function () { clearInterval(retry); };
    document.addEventListener('touchstart', stopRetrying, { once: true, passive: true });
    document.addEventListener('wheel', stopRetrying, { once: true, passive: true });
    document.addEventListener('keydown', stopRetrying, { once: true });
  }
})();

// Site-wide multi-select checkbox filter dropdown. Markup:
//   <div class="ms-filter" data-placeholder="Any">
//     <span class="ms-filter-label">Status</span>
//     <button type="button" class="ms-filter-toggle"><span class="ms-filter-toggle-text"></span>...</button>
//     <div class="ms-filter-panel" hidden>
//       <label class="ms-filter-option"><input type="checkbox" name="status" value="scheduled"> Scheduled</label>
//       ...
//       <button type="button" class="ms-filter-clear">Clear</button>
//     </div>
//   </div>
// Clicking the toggle opens/closes its panel (closing any other open one);
// clicking outside, or Escape, closes whatever's open. The toggle's label
// text reflects how many boxes are checked. Filtering itself happens on the
// form's normal submit (a "Filter" button, or - where the markup includes
// one - an "Apply" button inside the panel) - there's no auto-submit here,
// since submitting after every single checkbox click would be unusable.
(function () {
  var filters = document.querySelectorAll('.ms-filter');
  if (!filters.length) return;

  function summarize(filter) {
    var textEl = filter.querySelector('.ms-filter-toggle-text');
    if (!textEl) return;
    var boxes = filter.querySelectorAll('.ms-filter-panel input[type="checkbox"]');
    var checked = Array.prototype.filter.call(boxes, function (b) { return b.checked; });
    var placeholder = filter.getAttribute('data-placeholder') || 'Any';
    if (!checked.length) textEl.textContent = placeholder;
    else if (checked.length === 1) textEl.textContent = checked[0].closest('.ms-filter-option').textContent.trim();
    else textEl.textContent = checked.length + ' selected';
  }

  function closeAll(except) {
    document.querySelectorAll('.ms-filter-panel').forEach(function (p) {
      if (p === except || p.hidden) return;
      p.hidden = true;
      var toggle = p.closest('.ms-filter').querySelector('.ms-filter-toggle');
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
    });
  }

  filters.forEach(function (filter) {
    var toggle = filter.querySelector('.ms-filter-toggle');
    var panel = filter.querySelector('.ms-filter-panel');
    var clearBtn = filter.querySelector('.ms-filter-clear');
    if (!toggle || !panel) return;

    summarize(filter);

    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      var opening = panel.hidden;
      closeAll(opening ? panel : null);
      panel.hidden = !opening;
      toggle.setAttribute('aria-expanded', String(opening));
    });

    panel.addEventListener('click', function (e) { e.stopPropagation(); });

    panel.querySelectorAll('input[type="checkbox"]').forEach(function (box) {
      box.addEventListener('change', function () { summarize(filter); });
    });

    if (clearBtn) {
      clearBtn.addEventListener('click', function (e) {
        e.preventDefault();
        panel.querySelectorAll('input[type="checkbox"]').forEach(function (box) { box.checked = false; });
        summarize(filter);
      });
    }
  });

  document.addEventListener('click', function () { closeAll(null); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeAll(null);
  });
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

// Sitewide: keep the Chat icon's unread badge live on every page, not just
// inside the chat tool - otherwise a message that arrives while you're on
// (say) the Dashboard shows as "read" until you happen to reload.
(function () {
  var chatLink = document.querySelector('.sidebar-link[href="/chat"]');
  var chatIcon = chatLink && chatLink.querySelector('.sidebar-icon');
  if (!chatIcon) return;

  function apply(total) {
    var badge = chatIcon.querySelector('.sidebar-badge');
    if (total > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'sidebar-badge';
        chatIcon.appendChild(badge);
      }
      badge.textContent = total > 99 ? '99+' : total;
    } else if (badge) {
      badge.remove();
    }
  }

  var pollPending = false;

  function poll() {
    if (document.hidden) return;
    pollPending = false;
    fetch('/chat/channels/unread-counts')
      .then(function (res) { if (!res.ok) throw new Error('poll failed'); return res.json(); })
      .then(function (data) { apply(data.total); })
      .catch(function () {})
      .finally(function () {
        if (document.hidden) return;
        pollPending = true;
        setTimeout(poll, 20000);
      });
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && !pollPending) poll();
  });

  poll();
})();

// Push notification opt-in toggle (the bell icon next to the "?" help
// link). Hidden by default in the markup - only revealed once we've
// confirmed the browser actually supports the APIs involved, so it never
// shows up as a dead button (notably: iOS Safari only supports this once
// the site has been "Added to Home Screen", not in a normal browser tab).
(function () {
  var btn = document.getElementById('push-toggle-btn');
  if (!btn) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;

  var vapidKey = btn.getAttribute('data-vapid-key');
  var csrf = btn.getAttribute('data-csrf');

  // A VAPID public key arrives as URL-safe base64; pushManager.subscribe
  // needs it as a raw byte array.
  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var rawData = window.atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  function setState(subscribed) {
    btn.classList.toggle('topbar-help-active', subscribed);
    btn.title = subscribed ? 'Notifications on (tap to turn off)' : 'Enable notifications';
    btn.setAttribute('aria-label', btn.title);
  }

  function refreshState() {
    navigator.serviceWorker.ready
      .then(function (reg) { return reg.pushManager.getSubscription(); })
      .then(function (sub) {
        setState(!!sub);
        btn.hidden = false;
      })
      .catch(function () {});
  }

  btn.addEventListener('click', function () {
    navigator.serviceWorker.ready.then(function (reg) {
      reg.pushManager.getSubscription().then(function (existing) {
        if (existing) {
          existing.unsubscribe().then(function () {
            fetch('/push/unsubscribe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: 'endpoint=' + encodeURIComponent(existing.endpoint) + '&_csrf=' + encodeURIComponent(csrf),
            }).finally(function () { setState(false); });
          });
          return;
        }

        if (Notification.permission === 'denied') {
          alert('Notifications are blocked for this site in your browser/phone settings. Enable them there, then try again.');
          return;
        }

        Notification.requestPermission().then(function (permission) {
          if (permission !== 'granted') return;
          reg.pushManager
            .subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidKey) })
            .then(function (sub) {
              return fetch('/push/subscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ subscription: sub, _csrf: csrf }),
              }).then(function (res) {
                if (!res.ok) throw new Error('Subscribe failed');
                setState(true);
              });
            })
            .catch(function () { alert('Could not enable notifications. Please try again.'); });
        });
      });
    });
  });

  refreshState();
})();
