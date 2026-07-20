// Standalone voltage drop calculator for a single chosen cable size.
// Uses the shared reference tables in electrical-tables.js (load that
// script first). See that file for the data-accuracy disclaimer.
(function () {
  var T = window.ElectricalTables;

  function calculate(input) {
    var idx = T.SIZES.indexOf(input.size);
    var mvam = T.VDROP_MVAM[idx] * (input.conductor === 'aluminium' ? T.ALUMINIUM_VDROP_FACTOR : 1);
    var phaseFactor = input.phase === 3 ? 0.866 : 1;
    var vdropVolts = (mvam * phaseFactor * input.current * input.length) / 1000;
    var vdropPct = (vdropVolts / input.voltage) * 100;
    var allowedVolts = (input.maxVdropPct / 100) * input.voltage;

    return {
      vdropVolts: vdropVolts,
      vdropPct: vdropPct,
      allowedVolts: allowedVolts,
      ok: vdropVolts <= allowedVolts,
      mvam: mvam,
    };
  }

  window.VoltageDrop = { calculate: calculate, SIZES: T.SIZES };
})();
