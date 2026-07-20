(function () {
  var form = document.getElementById('clock-toggle-form');
  if (!form) return;

  var latInput = document.getElementById('clock-lat');
  var lngInput = document.getElementById('clock-lng');
  var accuracyInput = document.getElementById('clock-accuracy');
  var locatingNote = document.getElementById('clock-locating');
  var errorNote = document.getElementById('clock-location-error');
  var submitBtn = form.querySelector('button[type="submit"]');

  function showError(message) {
    if (locatingNote) locatingNote.hidden = true;
    if (submitBtn) submitBtn.disabled = false;
    if (errorNote) {
      errorNote.textContent = message;
      errorNote.hidden = false;
    }
  }

  form.addEventListener('submit', function (e) {
    // Second pass, once real coordinates are already set on the hidden fields - let it go through.
    if (form.dataset.located === '1') return;
    e.preventDefault();

    if (errorNote) errorNote.hidden = true;

    if (!navigator.geolocation) {
      showError('Your browser does not support location services. Location is required to clock in/out.');
      return;
    }

    var done = false;
    function finish() {
      if (done) return;
      done = true;
      if (locatingNote) locatingNote.hidden = true;
      if (submitBtn) submitBtn.disabled = false;
      form.dataset.located = '1';
      form.submit();
    }

    if (locatingNote) locatingNote.hidden = false;
    if (submitBtn) submitBtn.disabled = true;

    var timer = setTimeout(function () {
      showError('Could not get your location in time. Check that location services are turned on and try again.');
    }, 8000);

    navigator.geolocation.getCurrentPosition(
      function (pos) {
        clearTimeout(timer);
        latInput.value = pos.coords.latitude;
        lngInput.value = pos.coords.longitude;
        accuracyInput.value = pos.coords.accuracy;
        finish();
      },
      function (err) {
        clearTimeout(timer);
        var message = 'Location access is required to clock in/out. Please enable location services and try again.';
        if (err && err.code === err.PERMISSION_DENIED) {
          message = 'Location access was denied. Please allow location access for this site and try again.';
        }
        showError(message);
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
  });
})();
