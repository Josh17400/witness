// --safe-overlay: the phone's hardware drawn over a screenshot after capture (never into the page), so a HUD under the
// Dynamic Island, the home indicator or a rounded corner shows: black outside the rounded screen corners and over the
// island, a light home-indicator bar, and the env(safe-area-inset-*) zones tinted magenta (25%).
// Geometry in CSS px (= pt) of the viewport, from Apple's published sizes, approximate (for seeing clipping; measure
// with `measure ui --safe <preset>`): iPhone 14 Pro / 15 / 15 Pro Max screens: corner radius 55, Dynamic Island 126×37
// (radius 18.5) 11 from the top edge, centred (landscape: 11 from the left edge, centred vertically), home indicator
// 134×5, 8 above the bottom edge, centred. iPad 10th gen: corner radius 18, home indicator 134×5. iPhone SE: square
// corners, no island, no indicator. A Safari tab's page is inside the toolbars: nothing drawn but its (zero) insets.

/** Shapes for a safe-area preset ({preset, orientation, top, right, bottom, left} from devices.safeInsetsFor) on a
 *  viewport of vw×vh CSS px: { corner, island: {x, y, w, h, r} | null, home: {x, y, w, h} | null, insets }. */
export function overlayShapes(safe, vw, vh) {
  const p = safe.preset;
  const tab = /safari/.test(p) || p === "custom", se = p === "iphone-se", ipad = p === "ipad";   // custom insets: only the zones are tinted
  const land = safe.orientation === "landscape";
  const corner = tab || se ? 0 : ipad ? 18 : 55;
  let island = null;
  if (!tab && !se && !ipad) island = land ? { x: 11, y: (vh - 126) / 2, w: 37, h: 126, r: 18.5 } : { x: (vw - 126) / 2, y: 11, w: 126, h: 37, r: 18.5 };
  const home = tab || se ? null : { x: (vw - 134) / 2, y: vh - 8 - 5, w: 134, h: 5 };
  return { corner, island, home, insets: { top: safe.top, right: safe.right, bottom: safe.bottom, left: safe.left } };
}

const inRound = (x, y, b) => {
  // inside a rounded rect {x, y, w, h, r}
  if (x < b.x || y < b.y || x >= b.x + b.w || y >= b.y + b.h) return false;
  const r = b.r || 0, cx = Math.min(Math.max(x, b.x + r), b.x + b.w - r), cy = Math.min(Math.max(y, b.y + r), b.y + b.h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

/**
 * Draws the overlay into img ({width, height, data} RGBA, changed in place). map: how image pixels sit on the
 * viewport: css x = ox + (px + 0.5) / kx (and y), e.g. a viewport capture at DPR 3: {ox: 0, oy: 0, kx: 3, ky: 3}; an
 * element capture: ox/oy = the element's CSS position; the game's own canvas pixels: kx = canvas width / CSS width.
 * Returns { island, home, corners, insetPx } pixel counts drawn.
 */
export function drawSafeOverlay(img, safe, vw, vh, map) {
  const s = overlayShapes(safe, vw, vh), d = img.data, n = { island: 0, home: 0, corners: 0, insetPx: 0 };
  const scr = { x: 0, y: 0, w: vw, h: vh, r: s.corner };
  const home = s.home ? { ...s.home, r: 2.5 } : null;
  for (let py = 0; py < img.height; py++) {
    const y = map.oy + (py + 0.5) / map.ky;
    for (let px = 0; px < img.width; px++) {
      const x = map.ox + (px + 0.5) / map.kx, o = (py * img.width + px) * 4;
      if (s.corner && !inRound(x, y, scr) && x >= 0 && y >= 0 && x < vw && y < vh) { d[o] = d[o + 1] = d[o + 2] = 0; d[o + 3] = 255; n.corners++; continue; }
      if (s.island && inRound(x, y, s.island)) { d[o] = d[o + 1] = d[o + 2] = 0; d[o + 3] = 255; n.island++; continue; }
      if (home && inRound(x, y, home)) { d[o] = d[o + 1] = d[o + 2] = 235; d[o + 3] = 255; n.home++; continue; }
      const I = s.insets;
      if (y < I.top || y >= vh - I.bottom || x < I.left || x >= vw - I.right) {
        d[o] = Math.round(d[o] * 0.75 + 255 * 0.25); d[o + 1] = Math.round(d[o + 1] * 0.75); d[o + 2] = Math.round(d[o + 2] * 0.75 + 255 * 0.25); d[o + 3] = 255;
        n.insetPx++;
      }
    }
  }
  return n;
}
