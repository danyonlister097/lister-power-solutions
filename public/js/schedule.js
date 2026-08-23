(function () {
  var grid = document.getElementById('sched-grid');
  if (!grid) return;
  var csrf = grid.getAttribute('data-csrf');
  var isAdmin = grid.getAttribute('data-is-admin') === '1';

  // Set right after a day-view time-slide drag so the native "click" that
  // fires on mouseup (same element pressed and released) doesn't also pop
  // the job detail modal open immediately after the drag.
  var suppressNextClick = false;

  // The schedule pages (day/week/month) are all served from /jobs/schedule with
  // different query params, so the current path+search is exactly the URL we want
  // the edit page to send us back to after Save/Cancel.
  function currentScheduleUrl() {
    return window.location.pathname + window.location.search;
  }

  // A rejected reschedule (e.g. the tech is on approved leave that day) has a
  // specific reason in the JSON body - show that instead of a generic
  // "please try again", which would be actively misleading here since
  // retrying the same move will just fail again.
  function reportRescheduleFailure(res) {
    res
      .json()
      .then(function (data) { alert(data && data.error ? data.error : 'Could not move that job. Please try again.'); })
      .catch(function () { alert('Could not move that job. Please try again.'); });
  }

  // --- Job detail modal ---

  function setupModal() {
    var modal = document.getElementById('job-modal');
    if (!modal) return;
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

      document.getElementById('job-modal-open').setAttribute('href', '/jobs/' + d.jobId + '?returnTo=' + encodeURIComponent(currentScheduleUrl()));
      document.getElementById('job-modal-edit').setAttribute('href', '/jobs/' + d.jobId + '/edit?returnTo=' + encodeURIComponent(currentScheduleUrl()));

      modal.hidden = false;
    }

    function closeModal() {
      modal.hidden = true;
    }

    grid.addEventListener('click', function (e) {
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      if (isAdmin) {
        var menuBtn = e.target.closest('.shift-menu-btn');
        if (menuBtn) {
          e.stopPropagation();
          openContextMenu(menuBtn);
          return;
        }
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
  }

  setupModal();

  // Non-admins: modal and month-cell navigation only — no drag, no context menu.
  if (!isAdmin) return;

  // --- Drag: week/day view — move job chip to a different day cell ---

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
        if (!res.ok) { reportRescheduleFailure(res); return; }
        window.location.reload();
      })
      .catch(function () {
        alert('Could not move that job. Please try again.');
      });
  });

  // --- Drag: month view — move job chip to a different day cell ---

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
        if (!res.ok) { reportRescheduleFailure(res); return; }
        window.location.reload();
      })
      .catch(function () {
        alert('Could not move that job. Please try again.');
      });
  });

  // --- Drag: day view — slide a shift left/right to change its time,
  // snapping to 15-minute steps (a quarter of each hourly column) ---

  (function () {
    var timeline = document.querySelector('.day-sched-timeline');
    if (!timeline) return; // week/month views don't have a time axis

    var axisStartMin = (Number.parseInt(grid.getAttribute('data-axis-start-hour'), 10) || 6) * 60;
    var axisEndMin = (Number.parseInt(grid.getAttribute('data-axis-end-hour'), 10) || 21) * 60;
    var axisTotalMin = axisEndMin - axisStartMin;
    var drag = null;

    function minutesToTimeStr(mins) {
      var h = Math.floor(mins / 60);
      var m = mins % 60;
      return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
    }

    function minutesFromMidnight(iso) {
      var d = new Date(iso);
      return d.getHours() * 60 + d.getMinutes();
    }

    timeline.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      if (e.target.closest('.shift-menu-btn')) return;
      var block = e.target.closest('.day-shift-block');
      if (!block) return;
      if (block.getAttribute('data-all-day') === '1') return; // no time-of-day to slide
      var track = block.closest('.day-track');
      var startIso = block.getAttribute('data-start');
      if (!track || !startIso) return;

      var origStartMin = minutesFromMidnight(startIso);
      var endIso = block.getAttribute('data-end');
      var durationMin = endIso ? minutesFromMidnight(endIso) - origStartMin : 60;
      if (durationMin <= 0) durationMin = 60;

      drag = {
        block: block,
        jobId: block.getAttribute('data-job-id'),
        dateIso: startIso.slice(0, 10),
        startClientX: e.clientX,
        origStartMin: origStartMin,
        trackWidth: track.getBoundingClientRect().width,
        moved: false,
        finalStartMin: origStartMin,
      };
      e.preventDefault();
    });

    document.addEventListener('mousemove', function (e) {
      if (!drag) return;
      var deltaX = e.clientX - drag.startClientX;
      if (!drag.moved && Math.abs(deltaX) < 4) return;
      drag.moved = true;
      drag.block.classList.add('day-shift-block-dragging');

      var deltaMin = (deltaX / drag.trackWidth) * axisTotalMin;
      var snappedDelta = Math.round(deltaMin / 15) * 15;
      var newOffsetMin = Math.max(0, Math.min((drag.origStartMin - axisStartMin) + snappedDelta, axisTotalMin));

      drag.finalStartMin = axisStartMin + newOffsetMin;
      drag.block.style.left = (newOffsetMin / axisTotalMin * 100) + '%';
    });

    document.addEventListener('mouseup', function () {
      if (!drag) return;
      var d = drag;
      drag = null;
      d.block.classList.remove('day-shift-block-dragging');
      if (!d.moved || d.finalStartMin === d.origStartMin) return;

      suppressNextClick = true;
      // Undo the optimistic slide if the server rejects the move (e.g. the
      // tech went on leave) - no page reload needed either way, since
      // nothing else on the page depends on this block's position.
      var origLeftPct = ((d.origStartMin - axisStartMin) / axisTotalMin * 100) + '%';

      fetch('/jobs/' + d.jobId + '/reschedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'date=' + encodeURIComponent(d.dateIso) + '&time=' + encodeURIComponent(minutesToTimeStr(d.finalStartMin)) + '&_csrf=' + encodeURIComponent(csrf),
      })
        .then(function (res) {
          if (!res.ok) {
            d.block.style.left = origLeftPct;
            reportRescheduleFailure(res);
            return;
          }
          window.location.reload();
        })
        .catch(function () {
          d.block.style.left = origLeftPct;
          alert('Could not move that job. Please try again.');
        });
    });
  })();

  // --- Drag: staff row reorder ---

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
      form.innerHTML = '<input type="hidden" name="_csrf" value="' + csrf + '">' +
        '<input type="hidden" name="returnTo" value="' + currentScheduleUrl() + '">';
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
        delForm.innerHTML = '<input type="hidden" name="_csrf" value="' + csrf + '">' +
          '<input type="hidden" name="returnTo" value="' + currentScheduleUrl() + '">';
        document.body.appendChild(delForm);
        delForm.submit();
      });
    }
  });

})();
