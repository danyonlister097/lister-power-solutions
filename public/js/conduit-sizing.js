// Conduit fill / sizing calculator - entirely client-side.
// Uses the shared reference tables in electrical-tables.js (load that
// script first). See that file for the data-accuracy disclaimer.
(function () {
  var T = window.ElectricalTables;

  function spaceFactorFor(totalCables) {
    if (totalCables <= 1) return T.CONDUIT_SPACE_FACTOR[1];
    if (totalCables === 2) return T.CONDUIT_SPACE_FACTOR[2];
    return T.CONDUIT_SPACE_FACTOR.many;
  }

  // cables: [{ size: mm2, quantity: n }]
  function calculate(cables) {
    var totalCables = cables.reduce(function (sum, c) { return sum + c.quantity; }, 0);
    var totalAreaMm2 = cables.reduce(function (sum, c) {
      var idx = T.SIZES.indexOf(c.size);
      var diameter = T.CABLE_DIAMETER_MM[idx];
      var cableArea = Math.PI * Math.pow(diameter / 2, 2);
      return sum + cableArea * c.quantity;
    }, 0);

    var factor = spaceFactorFor(totalCables);
    var requiredConduitArea = totalAreaMm2 / factor;

    var recommended = T.CONDUIT_SIZES.find(function (c) { return c.areaMm2 >= requiredConduitArea; });

    var rows = T.CONDUIT_SIZES.map(function (c) {
      var fillPct = (totalAreaMm2 / c.areaMm2) * 100;
      return {
        size: c.size,
        areaMm2: c.areaMm2,
        fillPct: fillPct,
        ok: fillPct <= factor * 100,
      };
    });

    return {
      totalCables: totalCables,
      totalAreaMm2: totalAreaMm2,
      spaceFactor: factor,
      requiredConduitArea: requiredConduitArea,
      recommended: recommended,
      rows: rows,
    };
  }

  window.ConduitSizing = { calculate: calculate };
})();
