// Circuit breaker / protective device sizing - AS/NZS 3000 coordination
// rule: Ib <= In <= Iz (design current <= device rating <= cable capacity).
// For standard MCBs, the conventional tripping current I2 = 1.45 x In by
// design, so the separate "I2 <= 1.45 x Iz" check reduces to In <= Iz and
// isn't calculated separately here. Uses electrical-tables.js.
(function () {
  var T = window.ElectricalTables;

  function calculate(input) {
    var designCurrent = input.designCurrent;
    var cableCapacity = input.cableCapacity;

    var candidates = T.BREAKER_SIZES.map(function (rating) {
      return {
        rating: rating,
        meetsDesignCurrent: rating >= designCurrent,
        withinCableCapacity: rating <= cableCapacity,
      };
    });

    var recommended = candidates.find(function (c) { return c.meetsDesignCurrent && c.withinCableCapacity; });

    return {
      candidates: candidates,
      recommended: recommended,
      cableExceeded: designCurrent > cableCapacity,
    };
  }

  window.BreakerSizing = { calculate: calculate };
})();
