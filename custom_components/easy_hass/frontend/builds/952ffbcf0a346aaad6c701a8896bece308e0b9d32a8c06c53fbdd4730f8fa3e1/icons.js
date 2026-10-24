// Heroicons outline; see assets/icons/SOURCE.md. Climate, vacuum and cover glyphs match the FigCraft design.
const paths = {
  "back": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M15.75 19.5 8.25 12l7.5-7.5\"/>",
  "forward": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"m8.25 4.5 7.5 7.5-7.5 7.5\"/>",
  "power": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M5.636 5.636a9 9 0 1 0 12.728 0M12 3v9\"/>",
  "devices": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z\"/>",
  "home": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25\"/>",
  "light": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M12 18v-5.25m0 0a6.01 6.01 0 0 0 1.5-.189m-1.5.189a6.01 6.01 0 0 1-1.5-.189m3.75 7.478a12.06 12.06 0 0 1-4.5 0m3.75 2.383a14.406 14.406 0 0 1-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 1 0-7.517 0c.85.493 1.509 1.333 1.509 2.316V18\"/>",
  "weather": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M2.25 15a4.5 4.5 0 0 0 4.5 4.5H18a3.75 3.75 0 0 0 1.332-7.257 3 3 0 0 0-3.758-3.848 5.25 5.25 0 0 0-10.233 2.33A4.502 4.502 0 0 0 2.25 15Z\"/>",
  "map": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M9 6.75V15m6-6v8.25m.503 3.498 4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 0 0-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0Z\"/>",
  "energy": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z\"/>",
  "more": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M6.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM12.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM18.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z\"/>",
  "robot": "<circle cx=\"11\" cy=\"11\" r=\"8.25\"/>\n  <circle cx=\"11\" cy=\"8.25\" r=\"1.75\"/>\n  <path d=\"M4.1 15.5h13.8M17 17l3.75 3.75M19.25 19.25l2.25-.75M19.25 19.25l-.75 2.25\"/>",
  "temperature": "<path d=\"M9 14V5a3 3 0 0 1 6 0v9a4.5 4.5 0 1 1-6 0Z\"/><path d=\"M12 8v9.5\"/><circle cx=\"12\" cy=\"17.5\" r=\"1.25\" fill=\"currentColor\" stroke=\"none\"/>",
  "humidity": "<path d=\"M12 2.75C10.5 5 5.25 10.2 5.25 14.25a6.75 6.75 0 0 0 13.5 0C18.75 10.2 13.5 5 12 2.75Z\"/><path d=\"M8.5 14.5a3.5 3.5 0 0 0 3.5 3.5\"/>",
  "close": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M6 18 18 6M6 6l12 12\"/>",
  "play": "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z\"/>\n  <path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M15.91 11.672a.375.375 0 0 1 0 .656l-5.603 3.113a.375.375 0 0 1-.557-.328V8.887c0-.286.307-.466.557-.327l5.603 3.112Z\"/>"
};
export function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.home}</svg>`;
}
export function coverIcon(position = null) {
  const y = 6.5 + (100 - Math.max(0, Math.min(100, position ?? 100))) * 0.14;
  const rows = [8.5, 11.5, 14.5, 17.5].filter(row => row < y);
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="3" rx="1"/><path d="M5 6v15h14V6"/><path d="M5 6.5h14v${Math.max(0, y - 6.5)}H5Z" fill="currentColor" opacity=".14" stroke="none"/>${rows.map(row => `<path d="M5 ${row}h14"/>`).join('')}<path d="M5 ${y}h14"/></svg>`;
}
