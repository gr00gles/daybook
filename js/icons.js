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
  'chevron-left': '<path d="M14.5 6l-6 6 6 6"/>',
  'chevron-right': '<path d="M9.5 6l6 6-6 6"/>',
  locate: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.2"/><path d="M12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5"/>',
};

export const icon = (name, cls = 'ui-icon') => `<svg class="${cls}" ${ATTR}>${UI[name]}</svg>`;
