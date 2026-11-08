export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDate(ms: number): string {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${sameYear ? '' : ` ${d.getFullYear()}`}`;
}

/** "photo.jpg" → "jpg"; falls back to the mime subtype. */
export function kindOf(name: string, mime: string): string {
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1).toLowerCase();
  const slash = mime.indexOf('/');
  return slash > 0 ? mime.slice(slash + 1) : 'file';
}
