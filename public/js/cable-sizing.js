// AS/NZS 3008.1.1 cable sizing calculator - entirely client-side.
// Uses the shared reference tables in electrical-tables.js (load that
// script first). See that file for the data-accuracy disclaimer.
(function () {
  var T = window.ElectricalTables;

  function calculate(input) {
    var insulation = input.insulation; // 'pvc' | 'xlpe'
    var method = input.method; // 'enclosed' | 'clipped' | 'air' | 'buried'
    var conductor = input.conductor; // 'copper' | 'aluminium'
    var phase = input.phase; // 1 | 3
    var voltage = input.voltage;
    var current = input.current;
    var length = input.length;
    var maxVdropPct = input.maxVdropPct;
    var ambient = input.ambient;
    var groundTemp = input.groundTemp;
    var soilResistivity = input.soilResistivity;
    var circuitsGrouped = input.circuitsGrouped;

    var tempFactor =
      method === 'buried' ? T.GROUND_TEMP_FACTOR[insulation][groundTemp] : T.AMBIENT_FACTOR[insulation][ambient];
    var groupFactor = T.groupingFactorFor(circuitsGrouped);
    var soilFactor = method === 'buried' ? T.SOIL_RESISTIVITY_FACTOR[soilResistivity] : 1;
    var totalDerating = tempFactor * groupFactor * soilFactor;

    var vdropPhaseFactor = phase === 3 ? 0.866 : 1;
    var allowedDropVolts = (maxVdropPct / 100) * voltage;

    var rows = T.SIZES.map(function (size, i) {
      var baseAmpacity = T.AMPACITY[insulation][method][i];
      var ampacity = conductor === 'aluminium' ? baseAmpacity * T.ALUMINIUM_AMPACITY_FACTOR : baseAmpacity;
      var deratedAmpacity = ampacity * totalDerating;

      var mvam = T.VDROP_MVAM[i] * (conductor === 'aluminium' ? T.ALUMINIUM_VDROP_FACTOR : 1);
      var vdropVolts = (mvam * vdropPhaseFactor * current * length) / 1000;
      var vdropPct = (vdropVolts / voltage) * 100;

      return {
        size: size,
        deratedAmpacity: deratedAmpacity,
        ampacityOk: deratedAmpacity >= current,
        vdropVolts: vdropVolts,
        vdropPct: vdropPct,
        vdropOk: vdropVolts <= allowedDropVolts,
      };
    });

    var ampacitySize = rows.find(function (r) { return r.ampacityOk; });
    var vdropSize = rows.find(function (r) { return r.vdropOk; });

    var recommended = null;
    if (ampacitySize && vdropSize) {
      recommended = ampacitySize.size >= vdropSize.size ? ampacitySize : vdropSize;
    }

    return {
      rows: rows,
      totalDerating: totalDerating,
      tempFactor: tempFactor,
      groupFactor: groupFactor,
      soilFactor: soilFactor,
      allowedDropVolts: allowedDropVolts,
      ampacitySize: ampacitySize,
      vdropSize: vdropSize,
      recommended: recommended,
      governedBy: ampacitySize && vdropSize && ampacitySize.size >= vdropSize.size ? 'ampacity' : 'voltage drop',
    };
  }

  window.CableSizing = { calculate: calculate, SIZES: T.SIZES };
})();
