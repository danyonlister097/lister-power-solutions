// A repeated checkbox filter (<input type="checkbox" name="status" value="...">)
// arrives via Express as a string when exactly one box was checked, an array
// when several were, or undefined/'' when none were - this normalizes all
// three into a plain array so route handlers never special-case the count.
function toArrayParam(value) {
  if (value === undefined || value === null || value === '') return [];
  return (Array.isArray(value) ? value : [value]).filter((v) => v !== '' && v !== undefined && v !== null);
}

module.exports = { toArrayParam };
