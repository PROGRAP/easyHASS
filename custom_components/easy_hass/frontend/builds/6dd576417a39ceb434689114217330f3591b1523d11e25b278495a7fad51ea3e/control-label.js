/** Shared visible and accessible labels for light and cover control values. */
export function controlValueLabel(kind, value) {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return kind === 'cover' ? 'Zu' : 'Aus';
  if (value === 100) return kind === 'cover' ? 'Auf' : 'An';
  return `${value} %`;
}
