// AS/NZS 3008.1.1 cable sizing calculator - entirely client-side.
// Uses the shared reference tables in electrical-tables.js (load that
// script first). See that file for the data-accuracy disclaimer.
(function () {
  var T = window.ElectricalTables;

  function conductorImpedance(sizeIdx, isAluminium) {
    var r = T.CONDUCTOR_R75[sizeIdx] * (isAluminium ? T.ALUMINIUM_R_FACTOR : 1);
    var x = T.CONDUCTOR_X[sizeIdx];
    return { r: r, x: x, z: Math.sqrt(r * r + x * x) };
  }

  function calculate(input) {
    var insulation  = input.insulation;   // 'pvc' | 'xlpe'
    var method      = input.method;       // 'enclosed' | 'clipped' | 'air' | 'buried'
    var conductor   = input.conductor;    // 'copper' | 'aluminium'
    var phase       = input.phase;        // 1 | 3
    var voltage     = input.voltage;
    var current     = input.current;
    var length      = input.length;
    var maxVdropPct = input.maxVdropPct;
    var ambient     = input.ambient;
    var groundTemp  = input.groundTemp;
    var soilRes     = input.soilResistivity;
    var grouped     = input.circuitsGrouped;
    // forcedSizeIdx: index into SIZES to lock the active size; -1 = auto
    var forcedIdx   = (typeof input.forcedSizeIdx === 'number' && input.forcedSizeIdx >= 0) ? input.forcedSizeIdx : -1;

    var isBuried  = method === 'buried';
    var isAlum    = conductor === 'aluminium';
    var maxTemp   = insulation === 'xlpe' ? 90 : 75;
    var baseRef   = isBuried ? 25 : 40;   // reference ambient used in ampacity tables
    var actualAmb = isBuried ? groundTemp : ambient;

    var tempFactor  = isBuried
      ? T.GROUND_TEMP_FACTOR[insulation][groundTemp]
      : T.AMBIENT_FACTOR[insulation][ambient];
    var groupFactor   = T.groupingFactorFor(grouped);
    var soilFactor    = isBuried ? T.SOIL_RESISTIVITY_FACTOR[soilRes] : 1;
    var installFactor = (typeof input.installThermalFactor === 'number' && input.installThermalFactor > 0)
      ? input.installThermalFactor : 1.0;
    var totalDerating = tempFactor * groupFactor * soilFactor * installFactor;

    var phaseFactor      = phase === 3 ? 0.866 : 1;
    var allowedDropVolts = (maxVdropPct / 100) * voltage;

    var rows = T.SIZES.map(function (size, i) {
      var baseAmp  = T.AMPACITY[insulation][method][i];
      var ampacity = isAlum ? baseAmp * T.ALUMINIUM_AMPACITY_FACTOR : baseAmp;
      var derated  = ampacity * totalDerating;

      var mvam      = T.VDROP_MVAM[i] * (isAlum ? T.ALUMINIUM_VDROP_FACTOR : 1);
      var dropVolts = (mvam * phaseFactor * current * length) / 1000;
      var dropPct   = voltage > 0 ? (dropVolts / voltage) * 100 : 0;

      return {
        size:            size,
        idx:             i,
        earthSize:       T.EARTH_SIZES[i],
        baseAmpacity:    baseAmp,
        deratedAmpacity: derated,
        ampacityOk:      derated >= current,
        vdropVolts:      dropVolts,
        vdropPct:        dropPct,
        vdropOk:         dropVolts <= allowedDropVolts,
      };
    });

    var ampRow  = rows.find(function (r) { return r.ampacityOk; });
    var dropRow = rows.find(function (r) { return r.vdropOk; });

    var autoRec = null;
    if (ampRow && dropRow) {
      autoRec = ampRow.size >= dropRow.size ? ampRow : dropRow;
    }

    var recommended = (forcedIdx >= 0 && forcedIdx < rows.length) ? rows[forcedIdx] : autoRec;

    var forcedEarthIdx = (typeof input.forcedEarthSizeIdx === 'number' && input.forcedEarthSizeIdx >= 0)
      ? input.forcedEarthSizeIdx : -1;

    var extra = {};
    if (recommended) {
      var ri       = recommended.idx;
      var earthIdx = forcedEarthIdx >= 0 ? forcedEarthIdx : T.SIZES.indexOf(recommended.earthSize);
      if (earthIdx < 0) earthIdx = ri;

      // Approx operating temperature: T_ambient + (I/I_base)^2 * (T_max - T_base_ref)
      var operatingTemp = actualAmb + Math.pow(current / recommended.baseAmpacity, 2) * (maxTemp - baseRef);
      operatingTemp = Math.min(Math.max(operatingTemp, actualAmb), maxTemp);

      var mvamRec      = T.VDROP_MVAM[ri] * (isAlum ? T.ALUMINIUM_VDROP_FACTOR : 1);
      var denom        = mvamRec * phaseFactor * current;
      var maxDistanceM = denom > 0 ? (allowedDropVolts * 1000) / denom : 0;

      extra.earthIdx        = earthIdx;
      extra.operatingTemp   = operatingTemp;
      extra.maxTemp         = maxTemp;
      extra.voltageAtLoad   = voltage - recommended.vdropVolts;
      extra.maxDistanceM    = maxDistanceM;
      // Active/neutral impedance uses the conductor material; earth CPC is always copper.
      extra.activeImpedance = conductorImpedance(ri, isAlum);
      extra.earthImpedance  = conductorImpedance(earthIdx, false);
    }

    var governed = forcedIdx >= 0
      ? 'fixed size'
      : (ampRow && dropRow && ampRow.size >= dropRow.size ? 'ampacity' : 'voltage drop');

    return Object.assign({
      rows:             rows,
      totalDerating:    totalDerating,
      tempFactor:       tempFactor,
      groupFactor:      groupFactor,
      soilFactor:       soilFactor,
      installFactor:    installFactor,
      allowedDropVolts: allowedDropVolts,
      ampRow:           ampRow,
      dropRow:          dropRow,
      recommended:      recommended,
      isFixed:          forcedIdx >= 0,
      governedBy:       governed,
    }, extra);
  }

  window.CableSizing = { calculate: calculate, SIZES: T.SIZES };
})();
