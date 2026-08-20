const LEAVE_TYPES = [
  { value: 'annual', label: 'Annual Leave' },
  { value: 'sick', label: 'Sick Leave' },
  { value: 'rdo', label: 'RDO' },
  { value: 'training', label: 'Training' },
  { value: 'unpaid', label: 'Unpaid Leave' },
  { value: 'other', label: 'Other' },
];

const LEAVE_TYPE_LABELS = Object.fromEntries(LEAVE_TYPES.map((t) => [t.value, t.label]));

function parseLeaveType(raw) {
  return LEAVE_TYPE_LABELS[raw] ? raw : 'annual';
}

module.exports = { LEAVE_TYPES, LEAVE_TYPE_LABELS, parseLeaveType };
