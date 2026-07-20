(function () {
  var grid = document.getElementById('sched-grid');
  if (!grid) return;
  var csrf = grid.getAttribute('data-csrf');

  // The schedule pages (day/week/month) are all served from /jobs/schedule with
  // different query params, so the current path+search is exactly the URL we want
  // the edit page to send us back to after Save/Cancel.
  function currentScheduleUrl() {
    return window.location.pathname + window.location.search;
  }

  grid.addEventListener('dragstart', function (e) {
    var block = e.target.closest('.shift-block');
    if (!block) return;
    e.dataTransfer.setData('text/plain', block.getAttribute('data-job-id'));
    e.dataTransfer.effectAllowed = 'move';
  });

  grid.addEventListener('dragover', function (e) {
    var cell = e.target.closest('.sched-day-cell');
    if (!cell) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    cell.classList.add('sched-day-cell-dragover');
  });

  grid.addEventListener('dragleave', function (e) {
    var cell = e.target.closest('.sched-day-cell');
    if (cell) cell.classList.remove('sched-day-cell-dragover');
  });

  grid.addEventListener('drop', function (e) {
    var cell = e.target.closest('.sched-day-cell');
    if (!cell) return;
    e.preventDefault();
    cell.classList.remove('sched-day-cell-dragover');

    var jobId = e.dataTransfer.getData('text/plain');
    var day = cell.getAttribute('data-day');
    var techId = cell.getAttribute('data-tech-id') || '';
    if (!jobId || !day) return;

    fetch('/jobs/' + jobId + '/reschedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:
        'date=' + encodeURIComponent(day) +
        '&assignedTo=' + encodeURIComponent(techId) +
        '&_csrf=' + encodeURIComponent(csrf),
    })
      .then(function (res) {
        if (!res.ok) throw new Error('Reschedule failed');
        window.location.reload();
      })
      .catch(function () {
        alert('Could not move that job. Please try again.');
      });
  });

  // --- Month view: drag a job chip onto a different day cell ---

  grid.addEventListener('dragover', function (e) {
    var cell = e.target.closest('.month-day-cell');
    if (!cell) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    cell.classList.add('month-day-cell-dragover');
  });

  grid.addEventListener('dragleave', function (e) {
    var cell = e.target.closest('.month-day-cell');
    if (cell) cell.classList.remove('month-day-cell-dragover');
  });

  grid.addEventListener('drop', function (e) {
    var cell = e.target.closest('.month-day-cell');
    if (!cell) return;
    e.preventDefault();
    cell.classList.remove('month-day-cell-dragover');

    var jobId = e.dataTransfer.getData('text/plain');
    var day = cell.getAttribute('data-day');
    if (!jobId || !day) return;

    fetch('/jobs/' + jobId + '/reschedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'date=' + encodeURIComponent(day) + '&_csrf=' + encodeURIComponent(csrf),
    })
      .then(function (res) {
        if (!res.ok) throw new Error('Reschedule failed');
        window.location.reload();
      })
      .catch(function () {
        alert('Could not move that job. Please try again.');
      });
  });

  // --- Staff row reorder (drag one tech's row header onto another) ---

  grid.addEventListener('dragstart', function (e) {
    var header = e.target.closest('.sched-row-header[draggable="true"]');
    if (!header) return;
    e.dataTransfer.setData('application/x-user-id', header.getAttribute('data-user-id'));
    e.dataTransfer.effectAllowed = 'move';
  });

  grid.addEventListener('dragover', function (e) {
    if (!e.dataTransfer.types.includes('application/x-user-id')) return;
    var header = e.target.closest('.sched-row-header[draggable="true"]');
    if (!header) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    header.classList.add('sched-row-header-dragover');
  });

  grid.addEventListener('dragleave', function (e) {
    var header = e.target.closest('.sched-row-header[draggable="true"]');
    if (header) header.classList.remove('sched-row-header-dragover');
  });

  grid.addEventListener('drop', function (e) {
    if (!e.dataTransfer.types.includes('application/x-user-id')) return;
    var header = e.target.closest('.sched-row-header[draggable="true"]');
    if (!header) return;
    e.preventDefault();
    header.classList.remove('sched-row-header-dragover');

    var draggedId = e.dataTransfer.getData('application/x-user-id');
    var targetId = header.getAttribute('data-user-id');
    if (!draggedId || !targetId || draggedId === targetId) return;

    fetch('/jobs/schedule/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'a=' + encodeURIComponent(draggedId) + '&b=' + encodeURIComponent(targetId) + '&_csrf=' + encodeURIComponent(csrf),
    })
      .then(function (res) {
        if (!res.ok) throw new Error('Reorder failed');
        window.location.reload();
      })
      .catch(function () {
        alert('Could not reorder staff. Please try again.');
      });
  });

  // --- Job detail modal ---

  var modal = document.getElementById('job-modal');
  var modalClose = document.getElementById('job-modal-close');

  function formatTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
  }

  function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  function setOptionalField(labelId, valueId, value) {
    var label = document.getElementById(labelId);
    var el = document.getElementById(valueId);
    if (value) {
      label.style.display = '';
      el.style.display = '';
      el.textContent = value;
    } else {
      label.style.display = 'none';
      el.style.display = 'none';
    }
  }

  function openModal(block) {
    var d = block.dataset;
    document.getElementById('job-modal-title').textContent = d.title;
    var statusEl = document.getElementById('job-modal-status');
    statusEl.textContent = d.status.replace('_', ' ');
    statusEl.className = 'badge badge-' + d.status;
    document.getElementById('job-modal-customer').textContent = d.customer;
    document.getElementById('job-modal-assignee').textContent = d.assignee;

    var timeText = formatDate(d.start);
    if (d.allDay) {
      timeText += ', All day';
    } else {
      timeText += ', ' + formatTime(d.start);
      if (d.end) timeText += ' - ' + formatTime(d.end);
    }
    document.getElementById('job-modal-time').textContent = timeText;

    var addressEl = document.getElementById('job-modal-address');
    addressEl.innerHTML = '';
    if (d.address) {
      var mapLink = document.createElement('a');
      mapLink.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(d.address);
      mapLink.target = '_blank';
      mapLink.rel = 'noopener';
      mapLink.textContent = d.address;
      addressEl.appendChild(mapLink);
    } else {
      addressEl.textContent = 'No address on file';
    }

    setOptionalField('job-modal-description-label', 'job-modal-description', d.description);
    setOptionalField('job-modal-notes-label', 'job-modal-notes', d.notes);

    document.getElementById('job-modal-open').setAttribute('href', '/jobs/' + d.jobId);
    document.getElementById('job-modal-edit').setAttribute('href', '/jobs/' + d.jobId + '/edit?returnTo=' + encodeURIComponent(currentScheduleUrl()));

    modal.hidden = false;
  }

  function closeModal() {
    modal.hidden = true;
  }

  grid.addEventListener('click', function (e) {
    var menuBtn = e.target.closest('.shift-menu-btn');
    if (menuBtn) {
      e.stopPropagation();
      openContextMenu(menuBtn);
      return;
    }
    var block = e.target.closest('.shift-block');
    if (block) {
      openModal(block);
      return;
    }
    var monthCell = e.target.closest('.month-day-cell');
    if (monthCell && monthCell.getAttribute('data-href')) {
      window.location.href = monthCell.getAttribute('data-href');
    }
  });

  grid.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var block = e.target.closest('.shift-block');
    if (!block) return;
    e.preventDefault();
    openModal(block);
  });

  modalClose.addEventListener('click', closeModal);
  modal.addEventListener('click', function (e) {
    if (e.target === modal) closeModal();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });

  // --- Job options menu (3-dot menu on each shift block) ---

  var contextMenu = document.getElementById('shift-context-menu');
  var activeJobId = null;

  function openContextMenu(btn) {
    activeJobId = btn.getAttribute('data-job-id');
    var rect = btn.getBoundingClientRect();
    contextMenu.style.top = window.scrollY + rect.bottom + 4 + 'px';
    contextMenu.style.left = window.scrollX + rect.left + 'px';
    contextMenu.hidden = false;
  }

  function closeContextMenu() {
    contextMenu.hidden = true;
    activeJobId = null;
  }

  document.addEventListener('click', function (e) {
    if (contextMenu.hidden) return;
    if (e.target.closest('#shift-context-menu') || e.target.closest('.shift-menu-btn')) return;
    closeContextMenu();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !contextMenu.hidden) closeContextMenu();
  });

  contextMenu.addEventListener('click', function (e) {
    var item = e.target.closest('.context-menu-item');
    if (!item) return;
    e.preventDefault();
    var action = item.getAttribute('data-action');
    var jobId = activeJobId;
    closeContextMenu();
    if (!jobId) return;

    if (action === 'edit') {
      window.location.href = '/jobs/' + jobId + '/edit?returnTo=' + encodeURIComponent(currentScheduleUrl());
      return;
    }

    if (action === 'duplicate') {
      var form = document.createElement('form');
      form.method = 'post';
      form.action = '/jobs/' + jobId + '/duplicate';
      form.innerHTML = '<input type="hidden" name="_csrf" value="' + csrf + '">';
      document.body.appendChild(form);
      form.submit();
      return;
    }

    if (action === 'unassign') {
      fetch('/jobs/' + jobId + '/unassign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '_csrf=' + encodeURIComponent(csrf),
      })
        .then(function (res) {
          if (!res.ok) throw new Error('Unassign failed');
          window.location.reload();
        })
        .catch(function () {
          alert('Could not unassign that job. Please try again.');
        });
      return;
    }

    if (action === 'delete') {
      showConfirm('Delete this job?', 'This cannot be undone.', function () {
        var delForm = document.createElement('form');
        delForm.method = 'post';
        delForm.action = '/jobs/' + jobId + '/delete';
        delForm.innerHTML = '<input type="hidden" name="_csrf" value="' + csrf + '">';
        document.body.appendChild(delForm);
        delForm.submit();
      });
    }
  });

  // Delete confirmation uses the site-wide window.showConfirm (see app.js),
  // which owns the single shared #confirm-modal included in every page's
  // footer - no page-local modal or listeners needed here any more.
})();
