(function () {
  var panel = document.getElementById('chat-panel');
  if (panel) {
    var csrf = panel.getAttribute('data-csrf');
    var currentUserId = panel.getAttribute('data-current-user-id');
    var isAdmin = panel.getAttribute('data-is-admin') === '1';
    var channelId = panel.getAttribute('data-channel-id');
    var isLive = panel.getAttribute('data-live') === '1';
    var lastId = Number.parseInt(panel.getAttribute('data-last-id'), 10) || 0;
    var messagesEl = document.getElementById('chat-messages');
    var form = document.getElementById('chat-form');
    var input = document.getElementById('chat-input');

    function scrollToBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function renderMessage(m) {
      var empty = messagesEl.querySelector('.chat-empty');
      if (empty) empty.remove();

      var div = document.createElement('div');
      div.className = 'chat-message' + (String(m.userId) === String(currentUserId) ? ' chat-message-own' : '');
      div.id = 'msg-' + m.id;
      div.setAttribute('data-message-id', m.id);

      var meta = document.createElement('div');
      meta.className = 'chat-message-meta';
      var time = new Date(m.createdAt).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
      var nameSpan = document.createElement('span');
      nameSpan.textContent = m.userName + ' · ' + time;
      meta.appendChild(nameSpan);
      {
        var actions = document.createElement('span');
        actions.className = 'chat-message-actions';

        var replyBtn = document.createElement('button');
        replyBtn.type = 'button';
        replyBtn.className = 'chat-message-reply';
        replyBtn.setAttribute('data-message-id', m.id);
        replyBtn.setAttribute('data-user-name', m.userName);
        replyBtn.setAttribute('data-preview', (m.body || (m.attachmentName ? '📎 ' + m.attachmentName : '')).slice(0, 80));
        replyBtn.title = 'Reply';
        replyBtn.setAttribute('aria-label', 'Reply to this message');
        replyBtn.textContent = '↩';
        actions.appendChild(replyBtn);
      }
      if (isAdmin) {
        var pinBtn = document.createElement('button');
        pinBtn.type = 'button';
        pinBtn.className = 'chat-message-pin' + (m.pinned ? ' chat-message-pin-active' : '');
        pinBtn.setAttribute('data-message-id', m.id);
        pinBtn.setAttribute('data-pinned', m.pinned ? '1' : '0');
        pinBtn.title = m.pinned ? 'Unpin message' : 'Pin message';
        pinBtn.setAttribute('aria-label', pinBtn.title);
        pinBtn.textContent = '📌';
        actions.appendChild(pinBtn);

        var delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'chat-message-delete';
        delBtn.setAttribute('data-message-id', m.id);
        delBtn.title = 'Delete message';
        delBtn.setAttribute('aria-label', 'Delete message');
        delBtn.textContent = '×';
        actions.appendChild(delBtn);
      }
      meta.appendChild(actions);
      div.appendChild(meta);

      if (m.replyTo) {
        var quote = document.createElement('button');
        quote.type = 'button';
        quote.className = 'chat-message-quote';
        quote.setAttribute('data-message-id', m.replyTo.id);
        var quoteName = document.createElement('strong');
        quoteName.textContent = m.replyTo.userName || 'Deleted message';
        quote.appendChild(quoteName);
        if (m.replyTo.userName) {
          var quotePreview = (m.replyTo.body || (m.replyTo.attachmentName ? '📎 ' + m.replyTo.attachmentName : '')).slice(0, 80);
          quote.appendChild(document.createTextNode(': ' + quotePreview));
        }
        div.appendChild(quote);
      }

      if (m.body) {
        var body = document.createElement('div');
        body.className = 'chat-message-body';
        body.textContent = m.body;
        div.appendChild(body);
      }

      if (m.attachmentUrl) {
        var att = document.createElement('div');
        att.className = 'chat-message-attachment';
        var isImg = /\.(jpe?g|png|webp|heic|heif)$/i.test(m.attachmentName || '');
        if (isImg) {
          var a = document.createElement('a');
          a.href = m.attachmentUrl;
          a.target = '_blank';
          a.rel = 'noopener';
          var img = document.createElement('img');
          img.src = m.attachmentUrl;
          img.alt = m.attachmentName || 'attachment';
          img.style.cssText = 'max-width:300px;max-height:220px;border-radius:6px;display:block;margin-top:0.25rem;';
          a.appendChild(img);
          att.appendChild(a);
        } else {
          var fileLink = document.createElement('a');
          fileLink.href = m.attachmentUrl;
          fileLink.target = '_blank';
          fileLink.rel = 'noopener';
          fileLink.className = 'chat-attachment-link';
          fileLink.textContent = '📄 ' + (m.attachmentName || 'File');
          att.appendChild(fileLink);
        }
        div.appendChild(att);
      }

      messagesEl.appendChild(div);
      lastId = Math.max(lastId, m.id);
    }

    scrollToBottom();

    // --- Pinned messages bar ---

    function ensurePinnedBar() {
      var bar = document.getElementById('chat-pinned-bar');
      if (bar) return bar;
      bar = document.createElement('div');
      bar.className = 'chat-pinned-bar';
      bar.id = 'chat-pinned-bar';
      bar.innerHTML = '<div class="chat-pinned-bar-header">📌 Pinned messages</div><div class="chat-pinned-list" id="chat-pinned-list"></div>';
      panel.insertBefore(bar, messagesEl);
      return bar;
    }

    function addPinnedItem(m) {
      var existing = document.querySelector('.chat-pinned-item[data-message-id="' + m.id + '"]');
      if (existing) return;
      ensurePinnedBar();
      var list = document.getElementById('chat-pinned-list');
      var item = document.createElement('div');
      item.className = 'chat-pinned-item';
      item.setAttribute('data-message-id', m.id);

      var link = document.createElement('button');
      link.type = 'button';
      link.className = 'chat-pinned-item-link';
      link.setAttribute('data-message-id', m.id);
      var strong = document.createElement('strong');
      strong.textContent = m.userName + ':';
      link.appendChild(strong);
      var snippet = m.body || (m.attachmentName ? '📎 ' + m.attachmentName : '');
      link.appendChild(document.createTextNode(' ' + snippet.slice(0, 80)));
      item.appendChild(link);

      if (isAdmin) {
        var unpinBtn = document.createElement('button');
        unpinBtn.type = 'button';
        unpinBtn.className = 'chat-pinned-unpin';
        unpinBtn.setAttribute('data-message-id', m.id);
        unpinBtn.title = 'Unpin';
        unpinBtn.textContent = '×';
        item.appendChild(unpinBtn);
      }

      list.insertBefore(item, list.firstChild);
    }

    function removePinnedItem(messageId) {
      var item = document.querySelector('.chat-pinned-item[data-message-id="' + messageId + '"]');
      if (item) item.remove();
      var list = document.getElementById('chat-pinned-list');
      var bar = document.getElementById('chat-pinned-bar');
      if (list && bar && !list.children.length) bar.remove();
    }

    function applyPinState(messageId, pinned, message) {
      document.querySelectorAll('.chat-message-pin[data-message-id="' + messageId + '"]').forEach(function (btn) {
        btn.classList.toggle('chat-message-pin-active', pinned);
        btn.setAttribute('data-pinned', pinned ? '1' : '0');
        btn.title = pinned ? 'Unpin message' : 'Pin message';
        btn.setAttribute('aria-label', btn.title);
      });
      if (pinned && message) addPinnedItem(message);
      else if (!pinned) removePinnedItem(messageId);
    }

    function togglePin(messageId) {
      fetch('/chat/messages/' + messageId + '/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '_csrf=' + encodeURIComponent(csrf),
      })
        .then(function (res) {
          if (!res.ok) throw new Error('Pin failed');
          return res.json();
        })
        .then(function (data) { applyPinState(messageId, data.pinned, data.message); })
        .catch(function () { alert('Could not update that pin. Please try again.'); });
    }

    function jumpToMessage(messageId) {
      var target = document.getElementById('msg-' + messageId);
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.remove('chat-message-highlight');
      void target.offsetWidth; // restart the animation if it's already flashed once
      target.classList.add('chat-message-highlight');
    }

    // --- Reply-to banner above the message box ---

    var replyBanner = document.getElementById('chat-reply-banner');
    var replyToInput = document.getElementById('chat-reply-to');
    var replyBannerName = document.getElementById('chat-reply-banner-name');
    var replyBannerPreview = document.getElementById('chat-reply-banner-preview');

    function showReplyBanner(messageId, userName, preview) {
      if (!replyBanner) return;
      replyToInput.value = messageId;
      replyBannerName.textContent = userName;
      replyBannerPreview.textContent = preview;
      replyBanner.hidden = false;
      if (input) input.focus();
    }

    function clearReplyBanner() {
      if (!replyBanner) return;
      replyToInput.value = '';
      replyBanner.hidden = true;
    }

    var replyCancelBtn = document.getElementById('chat-reply-cancel');
    if (replyCancelBtn) replyCancelBtn.addEventListener('click', clearReplyBanner);

    document.addEventListener('click', function (e) {
      var link = e.target.closest('.chat-pinned-item-link');
      if (link) { jumpToMessage(link.getAttribute('data-message-id')); return; }
      var unpinBtn = e.target.closest('.chat-pinned-unpin');
      if (unpinBtn) { togglePin(unpinBtn.getAttribute('data-message-id')); return; }
      var quote = e.target.closest('.chat-message-quote');
      if (quote) { jumpToMessage(quote.getAttribute('data-message-id')); return; }
      var replyBtn = e.target.closest('.chat-message-reply');
      if (replyBtn) {
        showReplyBanner(replyBtn.getAttribute('data-message-id'), replyBtn.getAttribute('data-user-name'), replyBtn.getAttribute('data-preview'));
      }
    });

    if (isAdmin) {
      messagesEl.addEventListener('click', function (e) {
        var pinBtn = e.target.closest('.chat-message-pin');
        if (pinBtn) {
          togglePin(pinBtn.getAttribute('data-message-id'));
          return;
        }

        var btn = e.target.closest('.chat-message-delete');
        if (!btn) return;
        var messageId = btn.getAttribute('data-message-id');
        var messageEl = btn.closest('.chat-message');

        window.showConfirm('Delete message?', 'Delete this message? This cannot be undone.', function () {
          fetch('/chat/messages/' + messageId + '/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: '_csrf=' + encodeURIComponent(csrf),
          })
            .then(function (res) {
              if (!res.ok) throw new Error('Delete failed');
              if (messageEl) messageEl.remove();
              removePinnedItem(messageId);
            })
            .catch(function () {
              alert('Could not delete that message. Please try again.');
            });
        });
      });
    }

    var fileInput = document.getElementById('chat-file-input');
    var filePreview = document.getElementById('chat-file-preview');
    var attachBtn = document.getElementById('chat-attach-btn');

    if (attachBtn && fileInput) {
      attachBtn.addEventListener('click', function () { fileInput.click(); });
      fileInput.addEventListener('change', function () {
        if (fileInput.files.length) {
          filePreview.textContent = '📎 ' + fileInput.files[0].name;
          filePreview.style.display = 'block';
        } else {
          filePreview.style.display = 'none';
        }
      });
    }

    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var body = input.value.trim();
        var hasFile = fileInput && fileInput.files.length > 0;
        if (!body && !hasFile) return;

        var fd = new FormData();
        fd.append('_csrf', csrf);
        if (body) fd.append('body', body);
        if (hasFile) fd.append('attachment', fileInput.files[0]);
        if (replyToInput && replyToInput.value) fd.append('reply_to', replyToInput.value);

        fetch('/chat/c/' + channelId, {
          method: 'POST',
          headers: { Accept: 'application/json' },
          body: fd,
        })
          .then(function (res) {
            if (!res.ok) throw new Error('Send failed');
            return res.json();
          })
          .then(function (data) {
            input.value = '';
            if (fileInput) {
              fileInput.value = '';
              if (filePreview) filePreview.style.display = 'none';
            }
            clearReplyBanner();
            renderMessage(data.message);
            scrollToBottom();
          })
          .catch(function () {
            alert('Could not send that message. Please try again.');
          });
      });
    }

    if (isLive) {
      // Polling this endpoint marks new messages as read server-side, so a
      // background/unfocused tab must not keep calling it - otherwise a
      // channel you're not actually looking at silently gets marked read
      // and never shows as unread. Pause while hidden, catch up the moment
      // the tab is visible again.
      var pollPending = false;

      function poll() {
        if (document.hidden) return;
        pollPending = false;
        fetch('/chat/c/' + channelId + '/messages?after=' + lastId)
          .then(function (res) {
            if (!res.ok) throw new Error('Poll failed');
            return res.json();
          })
          .then(function (data) {
            if (data.messages && data.messages.length) {
              data.messages.forEach(renderMessage);
              scrollToBottom();
            }
          })
          .catch(function () {})
          .finally(function () {
            if (document.hidden) return;
            pollPending = true;
            setTimeout(poll, 4000);
          });
      }

      document.addEventListener('visibilitychange', function () {
        if (!document.hidden && !pollPending) poll();
      });

      poll();
    }
  }

  var newChannelToggle = document.getElementById('chat-new-channel-toggle');
  var newChannelForm = document.getElementById('chat-new-channel-form');
  if (newChannelToggle && newChannelForm) {
    newChannelToggle.addEventListener('click', function () {
      newChannelForm.hidden = !newChannelForm.hidden;
      if (!newChannelForm.hidden) newChannelForm.querySelector('input[name="name"]').focus();
    });
  }

  // --- Channel sidebar: pin toggle + drag-to-reorder ---

  var sidebarCsrfInput = document.querySelector('#chat-new-channel-form input[name="_csrf"]');
  var sidebarCsrf = sidebarCsrfInput ? sidebarCsrfInput.value : null;

  document.querySelectorAll('.chat-channel-pin').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var id = btn.getAttribute('data-channel-id');

      fetch('/chat/channels/' + id + '/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '_csrf=' + encodeURIComponent(sidebarCsrf),
      })
        .then(function (res) {
          if (!res.ok) throw new Error('Pin failed');
          window.location.reload();
        })
        .catch(function () {
          alert('Could not update that channel. Please try again.');
        });
    });
  });

  document.querySelectorAll('.chat-channel-list').forEach(function (list) {
    list.addEventListener('dragstart', function (e) {
      var link = e.target.closest('.chat-channel-link');
      if (!link) return;
      e.dataTransfer.setData('application/x-channel-id', link.getAttribute('data-channel-id'));
      e.dataTransfer.effectAllowed = 'move';
    });

    list.addEventListener('dragover', function (e) {
      if (!e.dataTransfer.types.includes('application/x-channel-id')) return;
      var link = e.target.closest('.chat-channel-link');
      if (!link) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      link.classList.add('chat-channel-link-dragover');
    });

    list.addEventListener('dragleave', function (e) {
      var link = e.target.closest('.chat-channel-link');
      if (link) link.classList.remove('chat-channel-link-dragover');
    });

    list.addEventListener('drop', function (e) {
      if (!e.dataTransfer.types.includes('application/x-channel-id')) return;
      var link = e.target.closest('.chat-channel-link');
      if (!link) return;
      e.preventDefault();
      link.classList.remove('chat-channel-link-dragover');

      var draggedId = e.dataTransfer.getData('application/x-channel-id');
      var targetId = link.getAttribute('data-channel-id');
      if (!draggedId || !targetId || draggedId === targetId) return;

      fetch('/chat/channels/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'a=' + encodeURIComponent(draggedId) + '&b=' + encodeURIComponent(targetId) + '&_csrf=' + encodeURIComponent(sidebarCsrf),
      })
        .then(function (res) {
          if (!res.ok) throw new Error('Reorder failed');
          window.location.reload();
        })
        .catch(function () {
          alert('Could not reorder channels. Please try again.');
        });
    });
  });

  // --- Channel sidebar: admin rename/delete menu ---

  var channelMenu = document.getElementById('chat-channel-menu');
  if (channelMenu) {
    var channelMenuActiveBtn = null;
    var renameModal = document.getElementById('chat-rename-modal');
    var renameForm = document.getElementById('chat-rename-form');
    var renameInput = document.getElementById('chat-rename-input');
    var renameClose = document.getElementById('chat-rename-close');

    function closeChannelMenu() {
      channelMenu.hidden = true;
      if (channelMenuActiveBtn) channelMenuActiveBtn.classList.remove('row-menu-btn-active');
      channelMenuActiveBtn = null;
    }

    document.querySelectorAll('.chat-channel-menu-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (channelMenuActiveBtn === btn) {
          closeChannelMenu();
          return;
        }
        channelMenuActiveBtn = btn;
        btn.classList.add('row-menu-btn-active');
        var rect = btn.getBoundingClientRect();
        channelMenu.style.position = 'fixed';
        channelMenu.style.top = (rect.bottom + 4) + 'px';
        channelMenu.style.left = 'auto';
        channelMenu.style.right = (window.innerWidth - rect.right) + 'px';
        channelMenu.hidden = false;
      });
    });

    document.addEventListener('click', function (e) {
      if (channelMenu.hidden) return;
      if (e.target.closest('#chat-channel-menu') || e.target.closest('.chat-channel-menu-btn')) return;
      closeChannelMenu();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !channelMenu.hidden) closeChannelMenu();
    });

    channelMenu.addEventListener('click', function (e) {
      var item = e.target.closest('.context-menu-item');
      if (!item) return;
      e.preventDefault();
      var action = item.getAttribute('data-action');
      var btn = channelMenuActiveBtn;
      closeChannelMenu();
      if (!btn) return;
      var channelId = btn.getAttribute('data-channel-id');
      var channelName = btn.getAttribute('data-channel-name');

      if (action === 'rename') {
        renameForm.setAttribute('data-channel-id', channelId);
        renameInput.value = channelName;
        renameModal.hidden = false;
        renameInput.focus();
        renameInput.select();
        return;
      }

      if (action === 'delete') {
        window.showConfirm(
          'Delete channel?',
          'Delete "#' + channelName + '"? All its messages will be permanently deleted. This cannot be undone.',
          function () {
            fetch('/chat/channels/' + channelId + '/delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: '_csrf=' + encodeURIComponent(sidebarCsrf),
            })
              .then(function (res) {
                if (!res.ok) throw new Error('Delete failed');
                window.location.href = '/chat';
              })
              .catch(function () {
                alert('Could not delete that channel. Please try again.');
              });
          }
        );
      }
    });

    renameClose.addEventListener('click', function () { renameModal.hidden = true; });
    renameModal.addEventListener('click', function (e) {
      if (e.target === renameModal) renameModal.hidden = true;
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !renameModal.hidden) renameModal.hidden = true;
    });

    renameForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var channelId = renameForm.getAttribute('data-channel-id');
      var name = renameInput.value.trim();
      if (!name) return;

      fetch('/chat/channels/' + channelId + '/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'name=' + encodeURIComponent(name) + '&_csrf=' + encodeURIComponent(sidebarCsrf),
      })
        .then(function (res) {
          if (!res.ok) throw new Error('Rename failed');
          window.location.reload();
        })
        .catch(function () {
          alert('Could not rename that channel. Please try again.');
        });
    });
  }

  // --- Sidebar: live unread badges while inside the chat tool ---
  // Server-rendered badges only reflect unread state as of page load - if a
  // message lands in a channel you're not viewing while you're sitting on
  // this page, nothing updates it without this. Polls faster than the
  // sitewide nav-badge poll in app.js since you're actively in the tool.

  var chatSidebar = document.querySelector('.chat-sidebar');
  if (chatSidebar) {
    var navChatIcon = document.querySelector('.sidebar-link[href="/chat"] .sidebar-icon');

    var applyUnread = function (data) {
      data.channels.forEach(function (c) {
        var link = chatSidebar.querySelector('.chat-channel-link[data-channel-id="' + c.id + '"]');
        if (!link) return;
        var badge = link.querySelector('.chat-unread-badge');
        if (c.unread > 0) {
          if (!badge) {
            badge = document.createElement('span');
            badge.className = 'chat-unread-badge';
            link.appendChild(badge);
          }
          badge.textContent = c.unread;
        } else if (badge) {
          badge.remove();
        }
      });

      if (navChatIcon) {
        var navBadge = navChatIcon.querySelector('.sidebar-badge');
        if (data.total > 0) {
          if (!navBadge) {
            navBadge = document.createElement('span');
            navBadge.className = 'sidebar-badge';
            navChatIcon.appendChild(navBadge);
          }
          navBadge.textContent = data.total > 99 ? '99+' : data.total;
        } else if (navBadge) {
          navBadge.remove();
        }
      }
    };

    var unreadPollPending = false;

    function pollUnread() {
      if (document.hidden) return;
      unreadPollPending = false;
      fetch('/chat/channels/unread-counts')
        .then(function (res) { if (!res.ok) throw new Error('poll failed'); return res.json(); })
        .then(applyUnread)
        .catch(function () {})
        .finally(function () {
          if (document.hidden) return;
          unreadPollPending = true;
          setTimeout(pollUnread, 5000);
        });
    }

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && !unreadPollPending) pollUnread();
    });

    pollUnread();
  }
})();
