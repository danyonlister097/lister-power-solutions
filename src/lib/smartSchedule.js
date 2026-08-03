// Home base: 125 Fairway Drive, Kensington Grove QLD 4341
const HOME_BASE = { lat: -27.6714, lng: 152.5753 };
const CLUSTER_RADIUS_KM = 30;

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function centroid(jobs) {
  return {
    lat: jobs.reduce((s, j) => s + j.lat, 0) / jobs.length,
    lng: jobs.reduce((s, j) => s + j.lng, 0) / jobs.length,
  };
}

function nearestNeighborOrder(jobs) {
  let current = HOME_BASE;
  const remaining = [...jobs];
  const ordered = [];
  while (remaining.length) {
    let nearestIdx = 0;
    let nearestDist = Infinity;
    remaining.forEach((j, i) => {
      const d = haversineKm(current, j);
      if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
    });
    const next = remaining.splice(nearestIdx, 1)[0];
    ordered.push(next);
    current = next;
  }
  return ordered;
}

function routeKm(jobs) {
  let total = 0;
  let prev = HOME_BASE;
  for (const j of jobs) { total += haversineKm(prev, j); prev = j; }
  total += haversineKm(prev, HOME_BASE);
  return Math.round(total);
}

function radiusClusters(jobs) {
  const pool = [...jobs];
  const clusters = [];
  while (pool.length) {
    const seed = pool.shift();
    const cluster = [seed];
    let changed = true;
    while (changed) {
      changed = false;
      const c = centroid(cluster);
      for (let i = pool.length - 1; i >= 0; i--) {
        if (haversineKm(c, pool[i]) <= CLUSTER_RADIUS_KM) {
          cluster.push(...pool.splice(i, 1));
          changed = true;
        }
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

// Next Monday from today (or this Monday if today is Monday)
function nextMondayIso() {
  const d = new Date();
  const day = d.getDay(); // 0=Sun
  const offset = day === 1 ? 7 : ((8 - day) % 7 || 7);
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

function addDaysToIso(iso, n) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function dayLabel(iso) {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'short',
  });
}

function generateSchedule(jobs, weekStartIso) {
  const located   = jobs.filter((j) => j.lat != null && j.lng != null);
  const unlocated = jobs.filter((j) => j.lat == null || j.lng == null);

  // Sort clusters nearest-home-first so local jobs get the first days of the week
  const clusters = radiusClusters(located).sort(
    (a, b) => haversineKm(HOME_BASE, centroid(a)) - haversineKm(HOME_BASE, centroid(b))
  );

  // Map up to 5 clusters → Mon-Fri; overflow stays unscheduled
  const days = Array.from({ length: 5 }, (_, i) => addDaysToIso(weekStartIso, i));
  const schedule = clusters.slice(0, 5).map((cluster, i) => {
    const ordered = nearestNeighborOrder(cluster);
    return {
      date: days[i],
      dayLabel: dayLabel(days[i]),
      jobs: ordered,
      totalKm: routeKm(ordered),
    };
  });

  const overflow = clusters.slice(5).flat();
  return { schedule, unlocated, overflow };
}

module.exports = { generateSchedule, nextMondayIso, addDaysToIso, HOME_BASE, haversineKm };
