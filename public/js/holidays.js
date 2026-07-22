// Queensland public holidays calculator.
// Returns an object keyed by 'YYYY-MM-DD' with the holiday name as value.
window.getQldHolidays = function (year) {
  var h = {};

  function ymd(y, m, d) {
    return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  function dayOfWeek(m, d) { return new Date(year, m - 1, d).getDay(); } // 0=Sun

  function addSub(m, d, name) {
    var day = d, w = dayOfWeek(m, d);
    if (w === 0) day++;        // Sunday → Monday
    else if (w === 6) day += 2; // Saturday → Monday
    h[ymd(year, m, day)] = name;
  }

  // New Year's Day
  addSub(1, 1, "New Year's Day");

  // Australia Day
  addSub(1, 26, 'Australia Day');

  // Easter — Anonymous Gregorian algorithm
  var a = year % 19, b = Math.floor(year / 100), c = year % 100;
  var d2 = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  var g = Math.floor((b - f + 1) / 3), hh = (19 * a + b - d2 - g + 15) % 30;
  var i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - hh - k) % 7;
  var mm = Math.floor((a + 11 * hh + 22 * l) / 451);
  var em = Math.floor((hh + l - 7 * mm + 114) / 31);
  var ed = (hh + l - 7 * mm + 114) % 31 + 1;
  var easter = new Date(year, em - 1, ed);
  var gf = new Date(easter); gf.setDate(easter.getDate() - 2);
  var es = new Date(easter); es.setDate(easter.getDate() - 1);
  var em2 = new Date(easter); em2.setDate(easter.getDate() + 1);
  h[ymd(year, gf.getMonth() + 1, gf.getDate())] = 'Good Friday';
  h[ymd(year, es.getMonth() + 1, es.getDate())] = 'Easter Saturday';
  h[ymd(year, easter.getMonth() + 1, easter.getDate())] = 'Easter Sunday';
  h[ymd(year, em2.getMonth() + 1, em2.getDate())] = 'Easter Monday';

  // Anzac Day — no substitute in QLD
  h[ymd(year, 4, 25)] = 'Anzac Day';

  // King's Birthday — last Monday in October (QLD)
  var kb = new Date(year, 9, 31);
  while (kb.getDay() !== 1) kb.setDate(kb.getDate() - 1);
  h[ymd(year, 10, kb.getDate())] = "King's Birthday";

  // Christmas Day & Boxing Day
  var xw = dayOfWeek(12, 25);
  if (xw === 5) {
    // Friday Christmas → Boxing Day (Saturday) observed Monday 28
    h[ymd(year, 12, 25)] = 'Christmas Day';
    h[ymd(year, 12, 28)] = 'Boxing Day';
  } else if (xw === 6) {
    // Saturday Christmas → both shift: Mon 27 Xmas, Tue 28 Boxing
    h[ymd(year, 12, 27)] = 'Christmas Day';
    h[ymd(year, 12, 28)] = 'Boxing Day';
  } else if (xw === 0) {
    // Sunday Christmas → Mon 27 Xmas (sub); Boxing Day on Mon 26 → as-is
    h[ymd(year, 12, 27)] = 'Christmas Day';
    h[ymd(year, 12, 26)] = 'Boxing Day';
  } else {
    h[ymd(year, 12, 25)] = 'Christmas Day';
    addSub(12, 26, 'Boxing Day');
  }

  return h;
};
