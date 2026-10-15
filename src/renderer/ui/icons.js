// Icônes internes (SVG 20×20, trait 1.75, couleur héritée via currentColor).
const icon = (body, { fill = false } = {}) =>
  `<svg class="icon" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" ${
    fill
      ? 'fill="currentColor"'
      : 'fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"'
  }>${body}</svg>`;

export const icons = {
  play: icon('<path d="M6.5 4.2v11.6c0 .6.7 1 1.2.7l9-5.8a.8.8 0 0 0 0-1.4l-9-5.8a.8.8 0 0 0-1.2.7z"/>', {
    fill: true,
  }),
  pause: icon(
    '<rect x="5" y="4" width="3.6" height="12" rx="1"/><rect x="11.4" y="4" width="3.6" height="12" rx="1"/>',
    {
      fill: true,
    },
  ),
  stop: icon('<rect x="5" y="5" width="10" height="10" rx="1.5"/>', { fill: true }),
  toStart: icon(
    '<path d="M5 4.5v11"/><path d="M15 5.2v9.6a.6.6 0 0 1-.95.5L8 10.5a.6.6 0 0 1 0-1l6.05-4.8a.6.6 0 0 1 .95.5z" fill="currentColor"/>',
  ),
  export: icon(
    '<path d="M10 13V3.5M6.5 7L10 3.5 13.5 7"/><path d="M4 12.5V15a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 16 15v-2.5"/>',
  ),
  file: icon(
    '<path d="M5.5 3h6l3.5 3.5V16a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M11.5 3v3.5H15"/>',
  ),
  folder: icon(
    '<path d="M3 6a1.5 1.5 0 0 1 1.5-1.5H8l1.5 2h6A1.5 1.5 0 0 1 17 8v6.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z"/>',
  ),
  plus: icon('<path d="M10 4.5v11M4.5 10h11"/>'),
  minus: icon('<path d="M4.5 10h11"/>'),
  close: icon('<path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/>'),
  trash: icon('<path d="M4.5 6h11M8 6V4.5h4V6M6 6l.7 9.3a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L14 6"/>'),
  import: icon(
    '<path d="M10 3.5v9M6.5 9l3.5 3.5L13.5 9"/><path d="M4 13.5v1.5a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 16 15v-1.5"/>',
  ),
  sliders: icon('<path d="M4 6h7M15 6h1M4 14h1M9 14h7"/><circle cx="13" cy="6" r="2"/><circle cx="7" cy="14" r="2"/>'),
  wave: icon('<path d="M2.5 10h1.5M6 6.5v7M9 4v12M12 7v6M15 5.5v9M17.5 10h0"/>'),
  chevronUp: icon('<path d="M6 12l4-4 4 4"/>'),
  chevronDown: icon('<path d="M6 8l4 4 4-4"/>'),
  save: icon(
    '<path d="M5 3.5h8.5L16.5 6.5V15a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 15V5A1.5 1.5 0 0 1 5 3.5z"/><path d="M7 3.5V7h5V3.5M6.5 16.5v-5h7v5"/>',
  ),
  reset: icon('<path d="M4 10a6 6 0 1 0 1.8-4.3"/><path d="M4 4.5v3h3"/>'),
  grip: icon(
    '<circle cx="7.5" cy="5" r="1.3"/><circle cx="12.5" cy="5" r="1.3"/><circle cx="7.5" cy="10" r="1.3"/><circle cx="12.5" cy="10" r="1.3"/><circle cx="7.5" cy="15" r="1.3"/><circle cx="12.5" cy="15" r="1.3"/>',
    { fill: true },
  ),
  undo: icon('<path d="M7.5 5.5L4 9l3.5 3.5"/><path d="M4 9h7.5a4.5 4.5 0 0 1 0 9H9"/>'),
  redo: icon('<path d="M12.5 5.5L16 9l-3.5 3.5"/><path d="M16 9H8.5a4.5 4.5 0 0 0 0 9H11"/>'),
  scissors: icon(
    '<circle cx="5.5" cy="5.5" r="2.25"/><circle cx="5.5" cy="14.5" r="2.25"/><path d="M7.4 6.8L16 14M7.4 13.2L16 6"/>',
  ),
  more: icon(
    '<circle cx="4.75" cy="10" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="15.25" cy="10" r="1.5"/>',
    {
      fill: true,
    },
  ),
  pencil: icon('<path d="M12.8 4.2l3 3L7.5 15.5 4 16l.5-3.5z"/><path d="M11 6l3 3"/>'),
  copy: icon(
    '<rect x="7" y="7" width="9.5" height="9.5" rx="1.6"/><path d="M13 7V5a1.5 1.5 0 0 0-1.5-1.5h-6A1.5 1.5 0 0 0 4 5v6.5A1.5 1.5 0 0 0 5.5 13H7"/>',
  ),
  arrowUp: icon('<path d="M10 16V4.5M5.5 9L10 4.5 14.5 9"/>'),
  arrowDown: icon('<path d="M10 4v11.5M5.5 11l4.5 4.5 4.5-4.5"/>'),
  power: icon('<path d="M10 3.5V10"/><path d="M6.2 5.8a6 6 0 1 0 7.6 0"/>'),
};

/** Logo Bandloop : une boucle ouverte dont l'extrémité devient un triangle de lecture. */
export const logo = `<svg class="logo-mark" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
  <defs>
    <linearGradient id="bl-grad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#d7ff4f"/><stop offset="1" stop-color="#2fd4b5"/>
    </linearGradient>
  </defs>
  <path d="M22.5 8.2A10 10 0 1 0 26 16" fill="none" stroke="url(#bl-grad)" stroke-width="3.4" stroke-linecap="round"/>
  <path d="M20.3 4.4l6.6 3.1-5.6 4.7z" fill="#d7ff4f"/>
  <circle cx="16" cy="16" r="3.2" fill="url(#bl-grad)"/>
</svg>`;
