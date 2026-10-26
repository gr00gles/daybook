const ATTR =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const CLOUD = 'M7.2 19h9.6a3.9 3.9 0 0 0 .5-7.77A5.6 5.6 0 0 0 6.4 12.4 3.3 3.3 0 0 0 7.2 19z';

function rays(cx, cy, r1, r2, degrees) {
  return degrees
    .map((deg) => {
      const a = (deg * Math.PI) / 180;
      const p = (r) => `${(cx + Math.cos(a) * r).toFixed(2)} ${(cy + Math.sin(a) * r).toFixed(2)}`;
      return `M${p(r1)}L${p(r2)}`;
    })
    .join('');
}

const ALL = [0, 45, 90, 135, 180, 225, 270, 315];
const LEFT_TOP = [135, 180, 225, 270, 315];
const smallCloud = `<path d="${CLOUD}" transform="translate(3 2) scale(.88)"/>`;
const highCloud = `<path d="${CLOUD}" transform="translate(0 -3.5)"/>`;

const GLYPHS = {
  clear: `<circle class="i-sun" cx="12" cy="12" r="4"/><path class="i-sun" d="${rays(12, 12, 6.8, 9.2, ALL)}"/>`,
  moon: `<path class="i-moon" d="M19.6 14.4A7.8 7.8 0 1 1 9.6 4.4a6.2 6.2 0 0 0 10 10z"/>`,
  partly: `<circle class="i-sun" cx="7" cy="7" r="2.8"/><path class="i-sun" d="${rays(7, 7, 4.4, 6.1, LEFT_TOP)}"/>${smallCloud}`,
  'moon-partly': `<path class="i-moon" d="M9.9 9.2A4 4 0 1 1 4.8 4.1a3.1 3.1 0 0 0 5.1 5.1z"/>${smallCloud}`,
  cloud: `<path d="${CLOUD}"/>`,
  fog: `${highCloud}<path d="M5 18.5h14M7.5 21.5h9"/>`,
  drizzle: `${highCloud}<path d="M8.5 19v.01M12 20.5v.01M15.5 19v.01M10 22v.01M14 22v.01" stroke-width="2.2"/>`,
  rain: `${highCloud}<path class="i-rain" d="M8.8 18l-1.2 3.2M12.4 18l-1.2 3.2M16 18l-1.2 3.2"/>`,
  snow: `${highCloud}<path d="M8 19.6v.01M12 18.4v.01M16 19.6v.01M10 22v.01M14 22v.01" stroke-width="2.4"/>`,
  storm: `${highCloud}<path class="i-bolt" d="M12.6 16.4l-2.2 3.4h3.2l-2.2 3.4"/>`,
};

export const weatherIcon = (glyph) => `<svg class="wx-icon" ${ATTR}>${GLYPHS[glyph] || GLYPHS.cloud}</svg>`;

const UI = {
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.4-4.4"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.2h-4.2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.4 7.4 0 0 0 7 6.5l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.4 7.4 0 0 0 2.6-1.5l2.4 1 2-3.4z"/>',
  external: '<path d="M14 5h5v5M19 5l-8 8M17 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4"/>',
  drop: '<path d="M12 3.5s5.5 6 5.5 10a5.5 5.5 0 0 1-11 0c0-4 5.5-10 5.5-10z"/>',
  video: '<rect x="3" y="6.5" width="12" height="11" rx="2"/><path d="M15 10.5l6-3.5v10l-6-3.5"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  grip: '<circle cx="9" cy="6" r="1.2" fill="currentColor"/><circle cx="15" cy="6" r="1.2" fill="currentColor"/><circle cx="9" cy="12" r="1.2" fill="currentColor"/><circle cx="15" cy="12" r="1.2" fill="currentColor"/><circle cx="9" cy="18" r="1.2" fill="currentColor"/><circle cx="15" cy="18" r="1.2" fill="currentColor"/>',
  'chevron-down': '<path d="M6 9.5l6 6 6-6"/>',
  'chevron-up': '<path d="M6 14.5l6-6 6 6"/>',
  'chevron-left': '<path d="M14.5 6l-6 6 6 6"/>',
  'chevron-right': '<path d="M9.5 6l6 6-6 6"/>',
  'mail-open': '<path d="M3.5 10.2L12 4.5l8.5 5.7V19a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z"/><path d="M3.5 10.2l8.5 5.6 8.5-5.6"/>',
  trash: '<path d="M4.5 7h15M10 11v6M14 11v6M6.2 7l.9 12.1A1.5 1.5 0 0 0 8.6 20.5h6.8a1.5 1.5 0 0 0 1.5-1.4L17.8 7M9.2 7V4.5h5.6V7"/>',
  junk: '<path d="M8.3 3.5h7.4l5.3 5.3v7.4l-5.3 5.3H8.3L3 16.2V8.8z"/><path d="M12 8v4.6M12 15.9v.01"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
  person: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 19.5a7 7 0 0 1 14 0"/>',
  alert: '<path d="M12 4.5l8.5 15h-17z"/><path d="M12 10v4.2M12 16.9v.01"/>',
  car: '<path d="M5 16.5V12l1.8-4.6A1.5 1.5 0 0 1 8.2 6.5h7.6a1.5 1.5 0 0 1 1.4.9L19 12v4.5"/><path d="M4 12h16v4.5H4z"/><path d="M7 16.5V18.5M17 16.5V18.5M7.5 14.2h.01M16.5 14.2h.01"/>',
  box: '<path d="M4 7.5L12 3.5l8 4v9l-8 4-8-4z"/><path d="M4 7.5l8 4 8-4M12 11.5v9"/>',
  eye: '<path d="M2.5 12s3.4-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.4 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  locate: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.2"/><path d="M12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5"/>',
  edit: '<path d="M14.5 5.5l4 4M4.5 19.5l1-4.5L15.8 4.7a1.4 1.4 0 0 1 2 0l1.5 1.5a1.4 1.4 0 0 1 0 2L9 18.5z"/>',
  phone: '<path d="M6.6 3.5h2.6l1.5 4-2 1.4a10.5 10.5 0 0 0 6.4 6.4l1.4-2 4 1.5v2.6a1.6 1.6 0 0 1-1.7 1.6A15.6 15.6 0 0 1 5 5.2a1.6 1.6 0 0 1 1.6-1.7z"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/><path d="M4 6.5l8 6 8-6"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.6 3.5 5.4 3.5 8.5s-1.1 5.9-3.5 8.5c-2.4-2.6-3.5-5.4-3.5-8.5s1.1-5.9 3.5-8.5z"/>',
  link: '<path d="M10.5 13.5a3.8 3.8 0 0 0 5.4 0l3-3a3.8 3.8 0 0 0-5.4-5.4l-1 1"/><path d="M13.5 10.5a3.8 3.8 0 0 0-5.4 0l-3 3a3.8 3.8 0 0 0 5.4 5.4l1-1"/>',
  // Icons a group of saved sites can wear.
  hammer: '<path d="M13.2 9.8L4.6 18.4a1.4 1.4 0 0 0 2 2l8.6-8.6"/><path d="M10.4 7l3.4-3.4c2-.6 4.2 0 5.6 1.4l-1.6 1 2.2 2.2 1-1 1.4 1.4-3.6 3.6-1.4-1.4 1-1-2.2-2.2-2.4 2.4z"/>',
  building: '<path d="M4.5 20.5V5a1.5 1.5 0 0 1 1.5-1.5h7A1.5 1.5 0 0 1 14.5 5v15.5M14.5 9.5H18a1.5 1.5 0 0 1 1.5 1.5v9.5M3 20.5h18"/><path d="M8 7.5h3M8 11h3M8 14.5h3M17 13.5v.01M17 17v.01"/>',
  cart: '<path d="M3 4h2.2l2.3 10.6a1.5 1.5 0 0 0 1.5 1.2h8.4a1.5 1.5 0 0 0 1.4-1.1L21 8H6.2"/><circle cx="9.5" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/>',
  home: '<path d="M4 10.5L12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-4v-6h-5v6h-4A1.5 1.5 0 0 1 4 19z"/>',
  plane: '<path d="M10.2 13.8L4 12.4l-1-1.6 1.2-.6 6 1.4 4.6-4.8c1.2-1.2 3-1.8 4.2-1.4.4 1.2-.2 3-1.4 4.2l-4.8 4.6 1.4 6-.6 1.2-1.6-1-1.4-6.2-3.2 3.2.4 2.4-1.2.8-1.4-2.6-2.6-1.4.8-1.2 2.4.4z"/>',
  food: '<path d="M7 3.5v17M4.5 3.5v4.5A2.5 2.5 0 0 0 7 10.5 2.5 2.5 0 0 0 9.5 8V3.5"/><path d="M17 20.5v-17c-2.2 1-3.5 3.6-3.5 7 0 1.4.8 2.5 2 2.5H17"/>',
  film: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M7.5 4.5v15M16.5 4.5v15M3.5 9h4M3.5 15h4M16.5 9h4M16.5 15h4"/>',
  money: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v.01M18 14.5v.01"/>',
  heart: '<path d="M12 19.5s-7.5-4.4-7.5-10A4.2 4.2 0 0 1 12 7a4.2 4.2 0 0 1 7.5 2.5c0 5.6-7.5 10-7.5 10z"/>',
  ticker: '<rect x="2.5" y="7.5" width="19" height="9" rx="4.5"/><path d="M7 12h4.5M14.5 12h2.5"/>',
  star: '<path d="M12 3.8l2.5 5.2 5.6.7-4.1 3.9 1 5.6-5-2.7-5 2.7 1-5.6-4.1-3.9 5.6-.7z"/>',
  game: '<path d="M7.5 7.5h9a4.5 4.5 0 0 1 4.4 5.5l-.8 3.6a2 2 0 0 1-3.4.9L14.5 15h-5l-2.2 2.5a2 2 0 0 1-3.4-.9L3.1 13a4.5 4.5 0 0 1 4.4-5.5z"/><path d="M8 10v3M6.5 11.5h3M15.5 11v.01M17.5 12.5v.01"/>',
  folder: '<path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2.2h8a1.5 1.5 0 0 1 1.5 1.5V17a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 17z"/>',
  wrench: '<path d="M14.6 6.2a4 4 0 0 0 5 5l-1.8-.2-8.6 8.6a2 2 0 0 1-2.8-2.8l8.6-8.6z"/><path d="M14.6 6.2a4.2 4.2 0 0 1 5.4-1.7l-2.8 2.8.4 2.1 2.1.4 2.8-2.8a4.2 4.2 0 0 1-1.7 5.4"/>',
  // Ticker extras (Settings → Ticker).
  music: '<path d="M9 18V5.5l11-2v12.5"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  rocket: '<path d="M12 15.5c-1.5-1-2.8-2.3-3.5-3.5C10 6.5 14 3.5 20.5 3.5 20.5 10 17.5 14 12 15.5z"/><path d="M8.5 12l-3.5-.5L7.5 8h4M12 15.5l.5 3.5 3.5-2.5v-4"/><circle cx="15" cy="9" r="1.4"/><path d="M6 16.5c-1.5.5-2.5 2-2.5 4 2 0 3.5-1 4-2.5"/>',
  book: '<path d="M4.5 5.5A1.5 1.5 0 0 1 6 4h13.5v13H6a1.5 1.5 0 0 0-1.5 1.5z"/><path d="M4.5 18.5A1.5 1.5 0 0 0 6 20h13.5v-3"/><path d="M8.5 8h7"/>',
  chip: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/><rect x="9.5" y="9.5" width="5" height="5" rx=".5"/><path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3"/>',
  tv: '<rect x="3" y="6.5" width="18" height="12" rx="2"/><path d="M8.5 3l3.5 3.5L15.5 3M8 21.5h8"/>',
  coin: '<circle cx="12" cy="12" r="8.5"/><path d="M14.6 9.2c-.5-.9-1.5-1.4-2.6-1.4-1.5 0-2.6.8-2.6 2s1 1.7 2.6 2.1c1.6.4 2.6.9 2.6 2.2s-1.1 2.1-2.6 2.1c-1.2 0-2.2-.5-2.7-1.5M12 6.3v1.5M12 16.2v1.5"/>',
  trophy: '<path d="M8 4.5h8v5a4 4 0 0 1-8 0z"/><path d="M8 6.5H5v1.5a3 3 0 0 0 3 3M16 6.5h3v1.5a3 3 0 0 1-3 3M12 13.5v3.5M8.5 20.5h7M9.5 17h5v3.5h-5z"/>',
  wave: '<path d="M2.5 12h3l2-5 3 10 3-14 3 13 2-4h3"/>',
  hourglass: '<path d="M6.5 3.5h11M6.5 20.5h11M7.5 3.5c0 4 4.5 5.5 4.5 8.5s-4.5 4.5-4.5 8.5M16.5 3.5c0 4-4.5 5.5-4.5 8.5s4.5 4.5 4.5 8.5"/>',
  chart: '<path d="M3.5 19.5h17"/><path d="M5 15.5l4.5-5 3.5 3 6-7"/><path d="M15 6.5h4v4"/>',
};

// The icons offered for a group of saved sites, in the order the editor shows them.
export const GROUP_ICONS = ['hammer', 'cart', 'home', 'wrench', 'car', 'plane', 'food', 'film', 'money', 'heart', 'star', 'game', 'folder', 'building'];
export const hasIcon = (name) => Object.hasOwn(UI, name);

export const icon = (name, cls = 'ui-icon') => `<svg class="${cls}" ${ATTR}>${UI[name]}</svg>`;

// The assistants' marks, drawn small for the circle in the search box: Claude's spark,
// ChatGPT's knot and Gemini's four-pointed star.
const SPARK = Array.from({ length: 12 }, (_, i) => i * 30 + (i % 2 ? 4 : -3));
const AI_MARKS = {
  claude: `<path d="${rays(12, 12, 2.2, 10, SPARK.filter((_, i) => i % 2 === 0))}" stroke="#d97757" stroke-width="2.4"/><path d="${rays(12, 12, 2.2, 7.6, SPARK.filter((_, i) => i % 2))}" stroke="#d97757" stroke-width="2.1"/>`,
  chatgpt: `<g stroke="currentColor" stroke-width="1.5">${[0, 60, 120, 180, 240, 300].map((a) => `<rect x="8.6" y="2.6" width="6.8" height="11.6" rx="3.4" transform="rotate(${a} 12 12)"/>`).join('')}</g>`,
  gemini: `<defs><linearGradient id="gem-g" x1="3" y1="21" x2="21" y2="3" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#4285f4"/><stop offset=".55" stop-color="#9b72cb"/><stop offset="1" stop-color="#d96570"/></linearGradient></defs><path d="M12 2c.6 5.4 4.6 9.4 10 10-5.4.6-9.4 4.6-10 10-.6-5.4-4.6-9.4-10-10 5.4-.6 9.4-4.6 10-10z" fill="url(#gem-g)" stroke="none"/>`,
};
export const aiMark = (name) => `<svg class="ai-mark" ${ATTR}>${AI_MARKS[name]}</svg>`;

// Gmail's and Outlook's marks, for the links to each inbox.
const MAIL_MARKS = {
  gmail:
    '<g stroke="none"><path d="M2 6.5v11A1.5 1.5 0 0 0 3.5 19h3V9.8z" fill="#4285f4"/><path d="M17.5 19h3a1.5 1.5 0 0 0 1.5-1.5v-11l-4.5 3.3z" fill="#34a853"/><path d="M17.5 5.5v4.3L22 6.5V5.2c0-1.6-1.8-2.5-3.1-1.6z" fill="#fbbc04"/><path d="M6.5 9.8V5.5L12 9.6l5.5-4.1v4.3L12 13.9z" fill="#ea4335"/><path d="M2 5.2v1.3l4.5 3.3V5.5L5.1 4.4C3.8 3.4 2 4.3 2 5.2z" fill="#c5221f"/></g>',
  outlook:
    '<rect x="8" y="5" width="14" height="14" rx="2" fill="#28a8ea" stroke="none"/><path d="M13 9l4.5 3L22 9" stroke="#fff" stroke-width="1.4"/><rect x="2" y="6.5" width="11" height="11" rx="1.5" fill="#0f6cbd" stroke="none"/><ellipse cx="7.5" cy="12" rx="2.3" ry="2.9" stroke="#fff" stroke-width="1.6"/>',
};
export const mailMark = (name) => `<svg class="mail-mark" ${ATTR}>${MAIL_MARKS[name]}</svg>`;
