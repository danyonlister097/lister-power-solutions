// Maximum demand calculator - load-schedule style (connected load x
// quantity x demand/diversity factor, summed, then converted to a design
// current). This mirrors the general method AS/NZS 3000 Appendix C is built
// on, but the demand factors are user-editable rather than baked in, since
// they vary by installation type and the exact current published table
// should be checked against the standard for a specific job.
(function () {
  // items: [{ loadW, quantity, demandFactorPct }]
  function calculate(items, supply) {
    var totalConnectedW = 0;
    var totalDemandW = 0;

    items.forEach(function (item) {
      var connected = item.loadW * item.quantity;
      var demand = connected * (item.demandFactorPct / 100);
      totalConnectedW += connected;
      totalDemandW += demand;
    });

    var totalDemandKw = totalDemandW / 1000;
    var divisor = supply.phase === 3 ? Math.sqrt(3) * supply.voltage * supply.powerFactor : supply.voltage * supply.powerFactor;
    var designCurrent = divisor > 0 ? (totalDemandW / divisor) : 0;

    return {
      totalConnectedW: totalConnectedW,
      totalDemandW: totalDemandW,
      totalDemandKw: totalDemandKw,
      designCurrent: designCurrent,
      diversityRatio: totalConnectedW > 0 ? totalDemandW / totalConnectedW : 0,
    };
  }

  window.MaxDemand = { calculate: calculate };
})();
