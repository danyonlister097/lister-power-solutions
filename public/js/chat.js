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

      var body = document.createElement('div');
      body.className = 'chat-message-body';
      body.textContent = m.body;

      div.appendChild(meta);
      div.appendChild(body);
      messagesEl.appendChild(div);
      lastId = Math.max(lastId, m.id);
    }

    scrollToBottom();

    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var body = input.value.trim();
        if (!body) return;

        fetch('/chat/c/' + channelId, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: 'body=' + encodeURIComponent(body) + '&_csrf=' + encodeURIComponent(csrf),
        })
          .then(function (res) {
            if (!res.ok) throw new Error('Send failed');
            return res.json();
          })
          .then(function (data) {
            input.value = '';
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
})();
