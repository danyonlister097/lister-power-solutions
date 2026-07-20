// Shared reference data for the Tools calculators (cable sizing, voltage
// drop, conduit sizing, circuit breaker sizing). Loaded before any
// calculator-specific script.
//
// IMPORTANT: these are indicative reference values in the style commonly
// published for AS/NZS 3008.1.1 / AS/NZS 3000 (copper/aluminium conductors,
// PVC/XLPE insulation). They are an estimation aid only. Always verify the
// final design against the current official AS/NZS 3008.1.1 / AS/NZS 3000
// standards, or a current manufacturer selection guide, before specifying or
// installing. Standards are amended periodically and this tool cannot
// guarantee it reflects the latest published tables.
(function () {
  var SIZES = [1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120, 150, 185, 240];

  // Base current ratings (A) at 40°C ambient (above-ground) / 25°C ground
  // (buried), single circuit, copper conductor, no grouping/derating applied.
  var AMPACITY = {
    pvc: {
      enclosed: [16.5, 23, 31, 39, 55, 73, 95, 117, 141, 179, 216, 249, 285, 324, 380],
      clipped: [22, 30, 40, 51, 70, 94, 122, 150, 184, 233, 281, 324, 371, 424, 500],
      air: [24, 33, 45, 58, 79, 105, 137, 169, 207, 262, 316, 364, 418, 477, 561],
      buried: [26, 35, 45, 58, 77, 100, 127, 153, 183, 224, 262, 297, 335, 375, 434],
    },
    xlpe: {
      enclosed: [22, 30, 40, 51, 70, 92, 121, 148, 178, 223, 269, 309, 353, 400, 470],
      clipped: [27, 37, 49, 63, 86, 115, 149, 184, 226, 285, 344, 396, 452, 516, 605],
      air: [30, 41, 55, 71, 97, 129, 168, 207, 254, 320, 386, 444, 509, 580, 683],
      buried: [31, 42, 54, 69, 92, 119, 151, 182, 217, 265, 310, 351, 396, 443, 512],
    },
  };

  // mV/A/m, single-phase (loop) AC, copper. Three-phase uses x0.866 of this.
  var VDROP_MVAM = [29, 18, 11, 7.3, 4.3, 2.7, 1.7, 1.25, 0.93, 0.63, 0.47, 0.37, 0.31, 0.25, 0.2];

  // Aluminium conductors: commonly-cited approximate factor relative to
  // copper of the same size. Indicative only.
  var ALUMINIUM_AMPACITY_FACTOR = 0.78;
  var ALUMINIUM_VDROP_FACTOR = 1.6;

  var AMBIENT_FACTOR = {
    pvc: { 25: 1.12, 30: 1.07, 35: 1.04, 40: 1.0, 45: 0.96, 50: 0.86, 55: 0.76 },
    xlpe: { 25: 1.09, 30: 1.05, 35: 1.02, 40: 1.0, 45: 0.96, 50: 0.93, 55: 0.89 },
  };

  var GROUND_TEMP_FACTOR = {
    pvc: { 15: 1.11, 20: 1.05, 25: 1.0, 30: 0.94, 35: 0.88, 40: 0.82 },
    xlpe: { 15: 1.07, 20: 1.04, 25: 1.0, 30: 0.96, 35: 0.92, 40: 0.88 },
  };

  var GROUPING_FACTOR = { 1: 1.0, 2: 0.8, 3: 0.7, 4: 0.65, 5: 0.6, 6: 0.57, 7: 0.54, 8: 0.54, 9: 0.54, 10: 0.5 };

  var SOIL_RESISTIVITY_FACTOR = { 0.8: 1.14, 1.0: 1.05, 1.2: 1.0, 1.5: 0.93, 2.0: 0.85, 2.5: 0.8, 3.0: 0.75 };

  function groupingFactorFor(n) {
    if (n <= 1) return 1.0;
    if (n >= 10) return GROUPING_FACTOR[10];
    return GROUPING_FACTOR[n];
  }

  // Approximate overall diameter (mm) of a single-core 0.6/1kV cable at each
  // conductor size - used for conduit fill estimates. Varies by
  // manufacturer/insulation; indicative only.
  var CABLE_DIAMETER_MM = [3.5, 4.0, 4.6, 5.2, 6.5, 7.6, 9.4, 10.6, 12.6, 14.6, 16.8, 18.6, 20.4, 22.6, 25.6];

  // Standard heavy-duty PVC conduit sizes (mm, nominal) with an approximate
  // internal cross-sectional area (mm²) based on typical wall thickness.
  var CONDUIT_SIZES = [
    { size: 16, areaMm2: 125 },
    { size: 20, areaMm2: 201 },
    { size: 25, areaMm2: 333 },
    { size: 32, areaMm2: 547 },
    { size: 40, areaMm2: 866 },
    { size: 50, areaMm2: 1426 },
    { size: 63, areaMm2: 2325 },
  ];

  // Max conduit "space factor" (fraction of conduit area cables may occupy),
  // per common AU trade practice - varies by source; indicative only.
  var CONDUIT_SPACE_FACTOR = { 1: 0.5, 2: 0.31, many: 0.4 };

  // Standard AS/NZS 3000-aligned circuit breaker / fuse ratings (A).
  var BREAKER_SIZES = [6, 10, 16, 20, 25, 32, 40, 50, 63, 80, 100, 125, 160, 200, 250];

  window.ElectricalTables = {
    SIZES: SIZES,
    AMPACITY: AMPACITY,
    VDROP_MVAM: VDROP_MVAM,
    ALUMINIUM_AMPACITY_FACTOR: ALUMINIUM_AMPACITY_FACTOR,
    ALUMINIUM_VDROP_FACTOR: ALUMINIUM_VDROP_FACTOR,
    AMBIENT_FACTOR: AMBIENT_FACTOR,
    GROUND_TEMP_FACTOR: GROUND_TEMP_FACTOR,
    GROUPING_FACTOR: GROUPING_FACTOR,
    SOIL_RESISTIVITY_FACTOR: SOIL_RESISTIVITY_FACTOR,
    groupingFactorFor: groupingFactorFor,
    CABLE_DIAMETER_MM: CABLE_DIAMETER_MM,
    CONDUIT_SIZES: CONDUIT_SIZES,
    CONDUIT_SPACE_FACTOR: CONDUIT_SPACE_FACTOR,
    BREAKER_SIZES: BREAKER_SIZES,
  };
})();
