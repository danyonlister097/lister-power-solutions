(function () {
  var panel = document.getElementById('chat-panel');
  if (panel) {
    var csrf = panel.getAttribute('data-csrf');
    var currentUserId = panel.getAttribute('data-current-user-id');
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

      var meta = document.createElement('div');
      meta.className = 'chat-message-meta';
      var time = new Date(m.createdAt).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
      meta.textContent = m.userName + ' · ' + time;
      div.appendChild(meta);

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
            renderMessage(data.message);
            scrollToBottom();
          })
          .catch(function () {
            alert('Could not send that message. Please try again.');
          });
      });
    }

    if (isLive) {
      (function poll() {
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
            setTimeout(poll, 4000);
          });
      })();
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
})();
