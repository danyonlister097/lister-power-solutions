(function () {
  var el = document.getElementById('team-map');
  var dataEl = document.getElementById('team-map-data');
  if (!el || !dataEl || typeof L === 'undefined') return;

  var markers = JSON.parse(dataEl.textContent || '[]');
  if (!markers.length) return;

  var map = L.map(el);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  var bounds = [];
  markers.forEach(function (m) {
    var marker = L.marker([m.lat, m.lng]).addTo(map);
    marker.bindPopup('<strong>' + m.name + '</strong><br>' + (m.type === 'in' ? 'Clocked in' : 'Clocked out') + ' at ' + m.time);
    bounds.push([m.lat, m.lng]);
  });

  if (bounds.length === 1) {
    map.setView(bounds[0], 15);
  } else {
    map.fitBounds(bounds, { padding: [30, 30] });
  }
})();
