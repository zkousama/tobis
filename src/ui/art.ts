// Hand-drawn ink illustrations. Ink is currentColor; the orange fill sits a few
// pixels off the line work, like a print slightly out of register.

const WOBBLE = `<filter id="wobble" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="7"/><feDisplacementMap in="SourceGraphic" scale="2.2"/></filter>`;

function svg(viewBox: string, body: string, cls: string, label = "") {
  const el = document.createElement("div");
  el.className = `art ${cls}`;
  if (!label) el.setAttribute("aria-hidden", "true");
  el.innerHTML = `<svg viewBox="${viewBox}" ${label ? `role="img" aria-label="${label}"` : ""}><defs>${WOBBLE}</defs><g filter="url(#wobble)" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`;
  return el;
}

/** A city bus rolling along the coast road, sun over the sea. */
export function busArt() {
  return svg(
    "0 0 300 170",
    `
    <circle cx="246" cy="34" r="17" fill="var(--marker)" stroke="none"/>
    <path d="M232 36c5-9 19-10 26-2"/>
    <path d="M8 128c18-7 30 6 48 0s30-7 48 0 30 6 48 0 30-7 48 0 30 6 48 0 30-6 44 0" stroke-width="2"/>
    <path d="M20 146c16-5 26 5 42 0s28-6 44 0" stroke-width="1.6" opacity=".55"/>
    <path d="M182 150c14-5 24 4 38 0s24-5 38 0" stroke-width="1.6" opacity=".55"/>
    <path d="M64 63c4-12 30-17 86-17 60 0 90 2 98 11 9 10 11 42 7 56H70c-9 0-12-6-12-16z" fill="var(--marker)" stroke="none" transform="translate(7 5)"/>
    <path d="M58 64c3-13 28-18 90-18 60 0 92 1 100 10 9 11 11 43 7 57-1 4-6 6-13 6H72c-10 0-15-5-15-15z"/>
    <path d="M70 66h26v24H69zM104 65h26v25h-26zM138 65h26v25h-26zM172 65h24v25h-24z"/>
    <path d="M206 64h22c7 0 12 4 14 10l3 16h-39z"/>
    <path d="M206 64v52"/>
    <path d="M58 98h196" stroke-width="1.8"/>
    <rect x="150" y="51" width="34" height="9" rx="2" stroke-width="1.6"/>
    <circle cx="96" cy="120" r="12" fill="var(--paper)"/>
    <circle cx="96" cy="120" r="4"/>
    <circle cx="214" cy="120" r="12" fill="var(--paper)"/>
    <circle cx="214" cy="120" r="4"/>
    <path d="M30 76h16M22 88h20M34 100h10" stroke-width="1.8"/>
    <path d="M250 104l8 0" stroke-width="3"/>
    `,
    "art-bus",
  );
}

/** Someone waiting by a bus stop sign. */
export function waitingArt() {
  return svg(
    "0 0 200 190",
    `
    <path d="M118 174c-18 0-46-2-70 0" stroke-width="1.8" opacity=".6"/>
    <path d="M140 30v146"/>
    <rect x="124" y="18" width="32" height="26" rx="4" fill="var(--marker)" stroke="none" transform="translate(4 3)"/>
    <rect x="124" y="18" width="32" height="26" rx="4"/>
    <path d="M131 27h18M131 35h12" stroke-width="2"/>
    <circle cx="74" cy="52" r="13"/>
    <path d="M69 52h2M78 51h2M71 58c3 2 6 2 8 0" stroke-width="1.8"/>
    <path d="M62 46c3-12 22-14 26-1" stroke-width="2"/>
    <path d="M74 66c-12 3-16 18-16 40l2 22h28l2-22c0-22-4-37-16-40z" fill="var(--marker)" stroke="none" transform="translate(5 4)"/>
    <path d="M74 66c-12 3-16 18-16 40l2 22h28l2-22c0-22-4-37-16-40z"/>
    <path d="M62 128l-2 44M86 128l4 44"/>
    <path d="M56 172h10M86 172h12"/>
    <path d="M62 84c-10 8-12 18-6 26M86 84c8 4 14 8 18 4"/>
    <rect x="100" y="80" width="10" height="16" rx="2" transform="rotate(-18 105 88)"/>
    <path d="M168 66c6 4 8 12 4 18M176 58c10 8 12 22 4 32" stroke-width="1.8"/>
    `,
    "art-waiting",
  );
}

/** A small hand-drawn arrow for margin notes. */
export function noteArrow() {
  return svg("0 0 60 40", `<path d="M54 6C40 4 18 10 10 30" stroke-width="2"/><path d="M6 20l4 11 10-5" stroke-width="2"/>`, "art-arrow");
}
