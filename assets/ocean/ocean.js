/* ==========================================================================
   OCEAN — rise from the sea floor to the surface
   One shader canvas behind the page, blended between depth keyframes as you
   scroll. Content moves DOWN as you scroll down (visual only; DOM order and
   native scrolling are untouched).

   Modes (set on <html data-ocean="…">):
     rise (default, homepage)  content moves down as you scroll; sections read bottom-up
     descend (inner pages)     normal scrolling, from the bright surface down into the depths;
                               give each .ocean-band a data-depth (5 = surface … 0 = floor)

   Debug query params:
     ?motion=reduce        force the reduced-motion page
     ?gpu=off              force the CSS-gradient fallback
     ?intro=skip           start with the nav already shown
     ?depth=2.5            freeze the background at a depth (0 = floor … 5 = surface)
     ?caustics=fine|grain|off   try the surface shimmer styles
     ?glints=off           turn off the twinkling glints on the light rays
   ========================================================================== */

/* ---------- TUNABLES ------------------------------------------------------ */

// Library (WebGPU only). Pinned exact version.
const SHADERS_CDN = 'https://cdn.jsdelivr.net/npm/shaders@4.0.7/js/+esm';
// 'neutral' keeps the shallow blues blue; 'aces' (used in the editor's "hello world") greys them out
const TONE_MAPPING = 'neutral';

// Name (the opening state)
const NAME_REST_Y = 0.83;         // name centre, fraction of screen height (from "hello world")
const NAME_MAX_SIZE = 0.2248;     // font size as a fraction of screen height (from "hello world")
const NAME_MAX_WIDTH = 0.9;       // never wider than this fraction of the screen
const NAME_EM_WIDTH = 6.9;        // "sammie spector" width in em (Geist 500, -0.045em tracking)
const NAME_HALF_HEIGHT_EM = 0.42; // name glyphs reach this far above their centre, in em
const NAME_GAP_PX = 28;           // space kept between the intro text and the top of the name
const NAME_MIN_SINK = 0.02;       // the name always moves at least this much (fraction of screen)…
const NAME_MAX_SINK = 0.3;        // …and never more than this before the intro text is in place
const NAV_REVEAL_PX = 24;         // nav fades in once you've scrolled this far

// "You can touch this" ripple through the name on load
const NAME_RIPPLE_DELAY_MS = 700;   // after the shader appears
const NAME_RIPPLE_MS = 1600;        // sweep duration, left → right through the name
const NAME_RIPPLE_WAVE = 0.18;      // vertical wobble of the sweep, in name heights
const TAP_RIPPLE_MS = 1200;         // touch devices: how long a tap ripple lasts

// Background easing: seconds for the colours to cover ~63% of the gap to the target
const EASE_TAU = 0.45;
// Share of the distance between two section centres where the colours HOLD
// (0 = always blending, 0.9 = mostly held, quick change between sections)
const BAND_HOLD = 0.55;

// Light rays: movement on top of the depth values
const RAYS_SHIMMER = 0.35;        // how much ray brightness flickers (0 = steady, 0.5 = lively)
const RAYS_SWAY = 0.06;           // how far the light source drifts side to side (fraction of width)
const RAYS_SWAY_SECONDS = 14;     // one full sway
// twinkling glints on the bright parts of the rays (Sparkle): spacing px, brightness, how bright a ray must be
const GLINTS = { size: 70, intensity: 8, threshold: 0.2, rayLength: 4, colorize: 0.35, speed: 1.6 };

// Surface shimmer: 'fine' (small light net), 'grain' (animated grain), or 'off'
const CAUSTICS_STYLE = 'grain';
const CAUSTICS_ON_ABOVE = 0.01;   // the shimmer layer joins the composition above this amount…
const CAUSTICS_OFF_BELOW = 0.004; // …and leaves below this one (it's the most expensive layer)

// Rendering
const DESKTOP_MAX_DPR = 1;        // the water is soft; 1× keeps the surface shimmer smooth on laptops
const MOBILE_MAX_DPR = 1;         // lower render resolution on phones
const MIN_DPR = 0.5;              // floor for the automatic quality step-down
const SLOW_FRAME_MS = 24;         // if the median frame is slower than this for ~2s, render smaller
const MOBILE_BREAKPOINT = 700;    // px
const TOUCH_RIPPLES = 'tap';      // touch devices: 'tap' (ripple where you tap), 'off', or 'drag'

// Descend pages: the whole page switches ink as the water passes this depth (± hysteresis)
const INK_SWITCH_DEPTH = 3.5;
const INK_SWITCH_HYSTERESIS = 0.15;

// Text colours (WCAG AA verified against the rendered water)
const INK_LIGHT = '#F4F2ED';      // on dark water
const INK_LIGHT_SOFT = '#CDD3E6';
const INK_DARK = '#14161C';       // on light water
const INK_DARK_SOFT = '#1F2430';
const ACCENT_ON_DARK = '#DFCCFB'; // brand lavender, lifted to pass 4.5:1 on the mid-depth blues
const ACCENT_ON_DARK_STRONG = '#B386EF';
const ACCENT_ON_LIGHT = '#4E2391';

// Depth keyframes, deepest → surface. One per section, in page order.
//   water     4 MeshGradient colours (dark → light) at WATER_POSITIONS
//   speed     MeshGradient animation speed
//   rays      Godrays from above: intensity, opacity, colour
//   caustics  surface shimmer amount (0 = off)
//   exposure  overall light (1 = unchanged)
//   ripples   cursor ripple strength
//   glints    how strongly the light rays twinkle (× GLINTS.intensity)
//   ink       'light' or 'dark' text for this section
const WATER_POSITIONS = [0.15, 0.45, 0.74, 1];
const DEPTHS = [
  { label: 'Name',
    water: ['#0f121f', '#04083f', '#00008f', '#8800ff'], speed: 10,
    rays: { intensity: 0.0, opacity: 0.0, color: '#3a4fd0' },
    caustics: 0, exposure: 1.0, ripples: 10, glints: 0, ink: 'light' },
  { label: 'Intro',
    water: ['#0b1030', '#0a1670', '#13239a', '#4b2fd0'], speed: 8,
    rays: { intensity: 0.3, opacity: 0.25, color: '#3f5fd8' },
    caustics: 0, exposure: 1.0, ripples: 6, glints: 0.6, ink: 'light' },
  { label: 'Experience',
    water: ['#0d1450', '#0f187a', '#1e3488', '#36569e'], speed: 6,
    rays: { intensity: 0.45, opacity: 0.35, color: '#4f7ee0' },
    caustics: 0, exposure: 1.02, ripples: 5, glints: 0.7, ink: 'light' },
  { label: 'Case studies',
    water: ['#0b1a55', '#132f7a', '#1d438c', '#3d5fae'], speed: 5,
    rays: { intensity: 0.5, opacity: 0.26, color: '#6f9be6' },
    caustics: 0, exposure: 1.05, ripples: 4, glints: 0.5, ink: 'light' },
  { label: 'Community',
    water: ['#4a9fdc', '#6cb6e6', '#93cdef', '#c4e6f8'], speed: 4,
    rays: { intensity: 0.65, opacity: 0.35, color: '#bfe6ff' },
    caustics: 0.06, exposure: 1.04, ripples: 4, glints: 0.25, ink: 'dark' },
  { label: 'Surface',
    water: ['#4fb0e6', '#74c6f0', '#a6dcf6', '#dcf3fd'], speed: 3,
    rays: { intensity: 0.7, opacity: 0.38, color: '#e6f8ff' },
    caustics: 0.3, exposure: 1.04, ripples: 4, glints: 0.15, ink: 'dark' },
];

// Fixed (non-animated) layer settings
const WATER_BASE = { count: 6, drift: 1, seed: 36, smoothness: 4.83, swirl: 0.31, variation: 0.42 };
const RAYS_BASE = { density: 0.3, spotty: 0.7, speed: 0.8 };
const RAYS_CENTER = { x: 0.32, y: -0.08 };
const CAUSTICS_FINE = { mode: 'f2MinusF1', scale: 20, octaves: 1, contrast: 2.6, balance: 0.72, speed: 0.9, colorA: '#f2fcff', colorB: '#000000' };
const CAUSTICS_GRAIN = { bias: 0, animated: true };
const GRAIN_PER_CAUSTIC = 1.8;    // grain strength = caustics amount × this
const NAME_BASE = { text: 'sammie spector', fontFamily: 'Geist', fontWeight: 500, letterSpacing: -0.045, color: '#ffffff' };
const RIPPLES_BASE = { decay: 10, radius: 0.5, chromaticSplit: 1 };

/* ---------- SETUP ---------------------------------------------------------- */

const root = document.documentElement;
const params = new URLSearchParams(location.search);
const reduceQuery = matchMedia('(prefers-reduced-motion: reduce)');
const REDUCED = params.get('motion') === 'reduce' || reduceQuery.matches;
const FROZEN_DEPTH = params.has('depth') ? clamp(parseFloat(params.get('depth')) || 0, 0, DEPTHS.length - 1) : null;
const IS_TOUCH = matchMedia('(hover: none) and (pointer: coarse)').matches;
const LAST = DEPTHS.length - 1;
const STYLE = ['fine', 'grain', 'off'].includes(params.get('caustics')) ? params.get('caustics') : CAUSTICS_STYLE;
const USE_GLINTS = params.get('glints') !== 'off';

const track = document.querySelector('.ocean-track');
const bands = [...document.querySelectorAll('.ocean-band')];
const spacer = document.querySelector('.ocean-spacer');
const canvas = document.querySelector('.ocean-canvas');
const fallbackBg = document.querySelector('.ocean-fallback');
const domName = document.querySelector('.ocean-name');
const nav = document.querySelector('.ocean-nav');

const DESCEND = root.dataset.ocean === 'descend';
// Each section's depth: its data-depth, or (homepage) its position, 0 = floor … 5 = surface
const bandDepth = bands.map((b, i) => clamp(b.dataset.depth !== undefined ? parseFloat(b.dataset.depth) : i, 0, LAST));
const inkFor = d => DEPTHS[Math.round(clamp(d, 0, LAST))].ink;

// Colour tokens → CSS (single source of truth is this file)
const tokens = {
  '--ink-on-dark': INK_LIGHT, '--ink-soft-on-dark': INK_LIGHT_SOFT,
  '--ink-on-light': INK_DARK, '--ink-soft-on-light': INK_DARK_SOFT,
  '--accent-on-dark': ACCENT_ON_DARK, '--accent-strong-on-dark': ACCENT_ON_DARK_STRONG,
  '--accent-on-light': ACCENT_ON_LIGHT,
};
for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
bands.forEach((band, i) => { band.dataset.ink = inkFor(bandDepth[i]); });

// Re-evaluate the whole page if the motion preference changes
reduceQuery.addEventListener?.('change', () => location.reload());

if (REDUCED) initStatic();
else initMotion();

/* ---------- REDUCED MOTION: normal page, static gradients ----------------- */

function initStatic() {
  root.classList.add('ocean-static');
  bands.forEach((band, i) => {
    // each section stays within its own depth's colours (so its text colour always passes)
    const w = DEPTHS[Math.round(bandDepth[i])].water;
    if (DESCEND) {
      // inner pages: one solid colour per section, extended full-width by the page CSS (--band-bg)
      const c = mixHex(w[1], w[2], 0.5);
      band.style.background = c;
      band.style.setProperty('--band-bg', c);
    } else {
      band.style.background = `linear-gradient(180deg, ${mixHex(w[0], w[1], 0.5)} 0%, ${mixHex(w[1], w[2], 0.5)} 100%)`;
    }
  });
}

/* ---------- MOTION ---------------------------------------------------------- */

function initMotion() {
  root.classList.add('ocean-motion');
  if (DESCEND) {
    root.classList.add('ocean-descend');
    // several sections share the screen at once here, so the ink follows the water page-wide
    bands.forEach(b => delete b.dataset.ink);
  } else {
    history.scrollRestoration = 'manual';
  }

  const depthsLab = DEPTHS.map(d => ({
    water: d.water.map(hexToOklab), speed: d.speed,
    raysI: d.rays.intensity, raysO: d.rays.opacity, raysC: hexToOklab(d.rays.color),
    caustics: d.caustics, exposure: d.exposure, ripples: d.ripples, glints: d.glints,
  }));

  let vh = innerHeight, trackH = 0, maxScroll = 0, navH = 0;
  let centres = [];          // section centres, measured from the bottom of the track
  let introTarget = 0;       // scroll position where the intro text sits just above the name
  let nameSink = NAME_MIN_SINK; // how far the name moves by then (fraction of screen height)
  let current = null;        // eased background state
  let lastSent = {};         // last props pushed per layer
  let lastScroll = -1;
  let raf = 0, lastT = 0;
  let shader = null, gpuState = 'loading'; // loading | ready | fallback
  let navInk = '';
  let causticsOn = false;
  let rippleBoost = 0;       // touch: 1 right after a tap, decays to 0
  let curDepth = null;       // eased depth, drives the page-wide ink on descend pages
  let pageInk = '';
  let navShown = DESCEND || params.get('intro') === 'skip' || FROZEN_DEPTH !== null || !!location.hash;
  if (navShown) root.classList.add('intro-done');

  /* -- layout ------------------------------------------------------------- */
  function nameSize() {
    return Math.min(NAME_MAX_SIZE, (NAME_MAX_WIDTH * innerWidth) / (NAME_EM_WIDTH * vh));
  }

  function layout() {
    vh = innerHeight;
    if (DESCEND) {
      navH = nav ? nav.offsetHeight : 0;
      const docH = document.documentElement.scrollHeight;
      maxScroll = Math.max(0, docH - vh);
      let prev = -Infinity;
      centres = bands.map(b => {
        const r = b.getBoundingClientRect();
        let c = clamp(r.top + window.scrollY + r.height / 2, vh / 2, docH - vh / 2);
        c = Math.max(c, prev + 1); prev = c;
        return c;
      });
      sizeCanvas();
      return;
    }
    trackH = track.offsetHeight;
    spacer.style.height = trackH + 'px';
    maxScroll = Math.max(0, trackH - vh);
    navH = nav ? nav.offsetHeight : 0;
    let prev = -Infinity;
    centres = bands.map(b => {
      const fromBottom = trackH - (b.offsetTop + b.offsetHeight);
      let c = clamp(fromBottom + b.offsetHeight / 2, vh / 2, trackH - vh / 2);
      c = Math.max(c, prev + 1); prev = c;
      return c;
    });
    // Where the intro text is "in place": centred, but never with its first line under the nav.
    // (bands aren't positioned, so offsetTop of the inner element is already relative to the track)
    const introInner = bands[1].firstElementChild || bands[1];
    const topAligned = (trackH - introInner.offsetTop) - vh + navH + 32;
    introTarget = clamp(Math.min(centres[1] - vh / 2, topAligned), 0, maxScroll);
    // How far the name has to sink so the intro text clears it at that point
    const introBottomY = vh - ((trackH - (introInner.offsetTop + introInner.offsetHeight)) - introTarget);
    const needY = (introBottomY + NAME_GAP_PX) / vh + nameSize() * NAME_HALF_HEIGHT_EM;
    nameSink = clamp(needY - NAME_REST_Y, NAME_MIN_SINK, NAME_MAX_SINK);
    lastScroll = -1;
    sizeCanvas();
    // arriving on a #link: fonts and images settle after the first jump, so keep aiming until the visitor scrolls
    if (pendingHash) goToHash(pendingHash);
  }

  // Depth (0 … LAST) at a scroll position: viewport centre vs. section centres, with holds
  function depthAt(s) {
    if (FROZEN_DEPTH !== null) return FROZEN_DEPTH;
    const c = s + vh / 2;
    if (c <= centres[0]) return bandDepth[0];
    for (let i = 0; i < centres.length - 1; i++) {
      if (c < centres[i + 1]) {
        const u = (c - centres[i]) / (centres[i + 1] - centres[i]);
        const h = BAND_HOLD / 2;
        return lerp(bandDepth[i], bandDepth[i + 1], smoothstep(h, 1 - h, u));
      }
    }
    return bandDepth[bandDepth.length - 1];
  }

  function sampleDepth(d) {
    const i = Math.min(Math.floor(d), LAST - 1), f = d - i;
    const A = depthsLab[i], B = depthsLab[Math.min(i + 1, LAST)];
    return {
      water: A.water.map((c, k) => lerpArr(c, B.water[k], f)),
      speed: lerp(A.speed, B.speed, f),
      raysI: lerp(A.raysI, B.raysI, f), raysO: lerp(A.raysO, B.raysO, f),
      raysC: lerpArr(A.raysC, B.raysC, f),
      caustics: lerp(A.caustics, B.caustics, f),
      exposure: lerp(A.exposure, B.exposure, f),
      ripples: lerp(A.ripples, B.ripples, f),
      glints: lerp(A.glints, B.glints, f),
    };
  }

  function easeState(cur, tgt, k) {
    for (const key in tgt) {
      const t = tgt[key];
      if (typeof t === 'number') cur[key] += (t - cur[key]) * k;
      else if (typeof t[0] === 'number') for (let j = 0; j < 3; j++) cur[key][j] += (t[j] - cur[key][j]) * k;
      else t.forEach((c, n) => { for (let j = 0; j < 3; j++) cur[key][n][j] += (c[j] - cur[key][n][j]) * k; });
    }
  }

  /* -- name: stays put, sinks just enough to reveal the intro, then leaves with the page -- */
  function nameAt(s) {
    const y = s <= introTarget
      ? NAME_REST_Y + nameSink * (introTarget > 0 ? s / introTarget : 1)
      : NAME_REST_Y + nameSink + (s - introTarget) / vh;   // past the intro it rides with the content
    return { y, size: r3(nameSize()) };
  }

  /* -- push state to shader / CSS fallback --------------------------------- */
  function send(id, props) {
    const key = JSON.stringify(props);
    if (lastSent[id] === key) return;
    lastSent[id] = key;
    shader.update(id, props);
  }

  function rippleIntensity() {
    if (!IS_TOUCH || TOUCH_RIPPLES === 'drag') return current.ripples;
    if (TOUCH_RIPPLES === 'tap') return current.ripples * rippleBoost;
    return 0;
  }

  function render(s, t) {
    const w = current.water.map(oklabToHex);
    const name = nameAt(s);
    if (gpuState === 'ready') {
      const sec = t / 1000;
      // glimmer: layered slow sines so the light breathes without looking like a loop
      const flicker = 1 + RAYS_SHIMMER * (0.55 * Math.sin(sec * 1.7) + 0.3 * Math.sin(sec * 3.1 + 1.3) + 0.15 * Math.sin(sec * 7.3 + 0.4));
      const sway = RAYS_SWAY * Math.sin((sec / RAYS_SWAY_SECONDS) * Math.PI * 2);
      send('water', { stops: w.map((color, i) => ({ color, position: WATER_POSITIONS[i] })), speed: r2(current.speed) });
      send('rays', {
        intensity: r3(clamp(current.raysI * flicker, 0, 1)), opacity: r3(current.raysO), rayColor: oklabToHex(current.raysC),
        center: { x: r3(RAYS_CENTER.x + sway), y: RAYS_CENTER.y },
      });
      if (STYLE !== 'off') {
        // the shimmer layer is the most expensive one: only keep it in the composition near the surface
        // (toggling `visible` recompiles, so use hysteresis to avoid flapping)
        const cOn = causticsOn ? current.caustics > CAUSTICS_OFF_BELOW : current.caustics > CAUSTICS_ON_ABOVE;
        if (cOn !== causticsOn) { causticsOn = cOn; shader.update('caustics', { visible: cOn }); }
        if (cOn) send('caustics', STYLE === 'grain' ? { strength: r3(current.caustics * GRAIN_PER_CAUSTIC) } : { opacity: r3(current.caustics) });
      }
      if (USE_GLINTS) send('glints', { intensity: r2(GLINTS.intensity * current.glints) });
      send('light', { exposure: r3(current.exposure) });
      if (!DESCEND) send('name', { center: { x: 0.5, y: r3(name.y) }, fontSize: name.size });
      send('ripples', { intensity: r2(rippleIntensity()) });
    }
    if (gpuState !== 'ready') {
      const glow = `rgba(255,255,255,${r3(current.raysO * 0.35)})`;
      const bg = `radial-gradient(120% 70% at 30% -10%, ${glow} 0%, transparent 60%),` +
        `radial-gradient(90% 60% at 20% 15%, ${w[3]} 0%, transparent 65%),` +
        `linear-gradient(180deg, ${w[2]} 0%, ${w[1]} 50%, ${w[0]} 100%)`;
      if (lastSent.fallback !== bg) { fallbackBg.style.background = bg; lastSent.fallback = bg; }
      if (domName) {
        domName.style.transform = `translate3d(-50%, ${r2((name.y - NAME_REST_Y) * vh)}px, 0)`;
        domName.style.fontSize = r2(name.size * vh) + 'px';
      }
    }
    if (DESCEND) {
      // page-wide ink follows the eased water, with hysteresis so it doesn't flicker at the switch
      const dark = pageInk === 'dark' ? curDepth > INK_SWITCH_DEPTH - INK_SWITCH_HYSTERESIS
        : pageInk === 'light' ? curDepth > INK_SWITCH_DEPTH + INK_SWITCH_HYSTERESIS
        : curDepth >= INK_SWITCH_DEPTH;
      const ink = dark ? 'dark' : 'light';
      if (ink !== pageInk) { pageInk = ink; root.dataset.ink = ink; if (nav) nav.dataset.ink = ink; }
    } else {
      // nav text follows the section under the viewport centre
      const ink = DEPTHS[Math.round(depthAt(s))].ink;
      if (nav && ink !== navInk) { nav.dataset.ink = ink; navInk = ink; }
    }
  }

  /* -- main loop ------------------------------------------------------------ */
  function frame(t) {
    const rawMs = lastT ? t - lastT : 16.7;
    const dt = Math.min(0.1, rawMs / 1000);
    lastT = t;
    watchQuality(rawMs);

    const s = window.scrollY;
    if (!navShown && s > NAV_REVEAL_PX) showNav();
    if (!DESCEND && s !== lastScroll) {
      track.style.transform = `translate3d(0, ${s}px, 0)`;
      lastScroll = s;
    }
    if (rippleBoost > 0) rippleBoost = Math.max(0, rippleBoost - rawMs / TAP_RIPPLE_MS);

    const k = 1 - Math.exp(-dt / EASE_TAU);
    const d = depthAt(s);
    const target = sampleDepth(d);
    if (!current) { current = structuredClone(target); curDepth = d; }
    else { easeState(current, target, k); curDepth += (d - curDepth) * k; }
    render(s, t);

    raf = requestAnimationFrame(frame);
  }

  function showNav() {
    navShown = true;
    root.classList.add('intro-done');
  }

  /* -- ripples you can see: a sweep through the name on load, and taps on touch screens -- */
  // The library listens for pointer moves on window, so synthetic moves drive the same ripple.
  function movePointer(x, y) {
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
  }
  let realPointer = false;
  addEventListener('mousemove', e => { if (e.isTrusted) realPointer = true; }, { passive: true });

  function sweepName() {
    if (window.scrollY > NAV_REVEAL_PX || realPointer || gpuState !== 'ready') return;
    const size = nameSize() * vh;
    const half = (size * NAME_EM_WIDTH) / 2;
    const cx = innerWidth / 2, cy = nameAt(window.scrollY).y * vh;
    const start = performance.now();
    if (IS_TOUCH) rippleBoost = 1;
    (function step(now) {
      const k = clamp((now - start) / NAME_RIPPLE_MS, 0, 1);
      if (realPointer || window.scrollY > NAV_REVEAL_PX) return; // the visitor took over
      const e = easeInOutCubic(k);
      movePointer(cx - half + e * half * 2, cy + Math.sin(k * Math.PI * 3) * size * NAME_RIPPLE_WAVE);
      if (IS_TOUCH) rippleBoost = Math.max(rippleBoost, 0.8);
      if (k < 1) requestAnimationFrame(step);
    })(start);
  }

  if (IS_TOUCH && TOUCH_RIPPLES === 'tap') {
    addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch' || gpuState !== 'ready') return;
      rippleBoost = 1;
      const x0 = e.clientX, y0 = e.clientY, start = performance.now();
      (function swirl(now) {
        const k = clamp((now - start) / 300, 0, 1);
        const r = 6 + 22 * k;
        movePointer(x0 + Math.cos(k * 9) * r, y0 + Math.sin(k * 9) * r);
        if (k < 1) requestAnimationFrame(swirl);
      })(start);
    }, { passive: true });
  }

  /* -- keyboard focus + anchors: bring things into view ---------------------- */
  const trackPoint = clientY => trackH - (clientY - track.getBoundingClientRect().top);
  function scrollToTrackPoint(fromBottom, viewportY) {
    const s = clamp(Math.round(fromBottom - (vh - viewportY)), 0, maxScroll);
    window.scrollTo({ top: s, behavior: 'instant' });
  }
  if (!DESCEND) addEventListener('keydown', () => { if (!navShown) showNav(); });
  if (!DESCEND) document.addEventListener('focusin', e => {
    if (!track.contains(e.target)) return;
    if (!navShown) showNav();
    const r = e.target.getBoundingClientRect();
    if (r.top >= navH && r.bottom <= vh) return;
    scrollToTrackPoint(trackPoint(r.top + r.height / 2), vh / 2);
  });
  function goToHash(hash) {
    const el = hash && hash.length > 1 && document.getElementById(decodeURIComponent(hash.slice(1)));
    if (!el || !track.contains(el)) return false;
    if (!navShown) showNav();
    if (el === bands[0]) { window.scrollTo({ top: 0, behavior: 'instant' }); return true; }
    // Sections read bottom-up (their label sits lowest and arrives first), so land on the content,
    // not the padding: centre it if it fits, otherwise put its start (the bottom) near the bottom of the screen.
    const target = (bands.includes(el) && el.firstElementChild) || el;
    const r = target.getBoundingClientRect();
    if (r.height <= vh - navH - 48) scrollToTrackPoint(trackPoint(r.top + r.height / 2), navH + (vh - navH) / 2);
    else scrollToTrackPoint(trackPoint(r.bottom), vh - 32);
    return true;
  }
  if (!DESCEND) document.addEventListener('click', e => {
    const a = e.target.closest('a[href^="#"]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (goToHash(a.getAttribute('href'))) {
      e.preventDefault();
      history.pushState(null, '', a.getAttribute('href'));
    }
  });
  if (!DESCEND) addEventListener('popstate', () => { pendingHash = ''; goToHash(location.hash); });

  /* -- pause when hidden ------------------------------------------------------ */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(raf); raf = 0;
      shader?.pause();
    } else {
      shader?.resume();
      lastT = 0;
      if (!raf) raf = requestAnimationFrame(frame);
    }
  });

  /* -- resize ------------------------------------------------------------------ */
  let resizeQueued = false;
  addEventListener('resize', () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => { resizeQueued = false; layout(); });
  });
  new ResizeObserver(() => layout()).observe(track || document.body);

  /* -- shader ------------------------------------------------------------------ */
  // The library sizes the canvas itself at devicePixelRatio (capped at 1.5 on phones, 2 elsewhere).
  // To render at a lower resolution we make the canvas element smaller and scale it back up in CSS;
  // the library maps the pointer through getBoundingClientRect, so ripples still line up.
  let qualityCap = Infinity; // lowered by the step-down below
  function sizeCanvas() {
    const mobile = innerWidth < MOBILE_BREAKPOINT || IS_TOUCH;
    const dpr = devicePixelRatio || 1;
    const libDpr = Math.min(dpr, mobile ? 1.5 : 2);
    const want = Math.min(dpr, mobile ? MOBILE_MAX_DPR : DESKTOP_MAX_DPR, qualityCap);
    canvas.style.setProperty('--render-scale', Math.min(1, want / libDpr).toFixed(3));
  }

  // Automatic quality step-down: watch frame times while the shader runs; if they're slow, render smaller.
  const frameTimes = [];
  function watchQuality(dtMs) {
    if (gpuState !== 'ready' || document.hidden) return;
    frameTimes.push(dtMs);
    if (frameTimes.length < 120) return;
    const median = frameTimes.sort((a, b) => a - b)[60];
    frameTimes.length = 0;
    const mobile = innerWidth < MOBILE_BREAKPOINT || IS_TOUCH;
    const now = Math.min(devicePixelRatio || 1, mobile ? MOBILE_MAX_DPR : DESKTOP_MAX_DPR, qualityCap);
    if (median > SLOW_FRAME_MS && now > MIN_DPR) {
      qualityCap = Math.max(MIN_DPR, now * 0.8);
      sizeCanvas();
    }
  }

  function useFallback(reason) {
    if (gpuState === 'fallback') return;
    gpuState = 'fallback';
    lastSent = {};
    root.classList.remove('gpu-ready');
    root.classList.add('gpu-fallback');
    if (reason) console.info('[ocean] using CSS fallback:', reason);
    try { shader?.destroy(); } catch {}
    shader = null;
  }

  function buildComponents(d0, name) {
    const raysLayer = {
      type: 'Godrays', id: 'rays',
      props: { ...RAYS_BASE, center: RAYS_CENTER, intensity: d0.raysI, opacity: d0.raysO, rayColor: oklabToHex(d0.raysC), blendMode: 'screen' },
    };
    const rays = USE_GLINTS
      // glints twinkle over the bright parts of the rays only; the wrapper carries the screen blend
      ? { type: 'Sparkle', id: 'glints', props: { ...GLINTS, intensity: GLINTS.intensity * d0.glints, blendMode: 'screen' }, children: [{ ...raysLayer, props: { ...raysLayer.props, blendMode: 'normal' } }] }
      : raysLayer;
    causticsOn = d0.caustics > CAUSTICS_ON_ABOVE;
    const fine = { type: 'WorleyNoise', id: 'caustics', props: { ...CAUSTICS_FINE, opacity: d0.caustics, blendMode: 'screen', visible: causticsOn } };
    const grain = { type: 'FilmGrain', id: 'caustics', props: { ...CAUSTICS_GRAIN, strength: d0.caustics * GRAIN_PER_CAUSTIC, visible: causticsOn } };
    return [
      { type: 'MeshGradient', id: 'water', props: { ...WATER_BASE, speed: d0.speed, stops: d0.water.map((c, i) => ({ color: oklabToHex(c), position: WATER_POSITIONS[i] })) } },
      rays,
      ...(STYLE === 'fine' ? [fine] : []),
      { type: 'Exposure', id: 'light', props: { exposure: d0.exposure } },
      ...(STYLE === 'grain' ? [grain] : []),   // grain after the light, before the name, so the name stays clean
      ...(DESCEND ? [] : [{ type: 'Text', id: 'name', props: { ...NAME_BASE, fontSize: name.size, center: { x: 0.5, y: name.y } } }]),
      { type: 'CursorRipples', id: 'ripples', props: { ...RIPPLES_BASE, intensity: IS_TOUCH && TOUCH_RIPPLES !== 'drag' ? 0 : d0.ripples } },
    ];
  }

  async function initShader() {
    if (params.get('gpu') === 'off' || !('gpu' in navigator)) return useFallback(!('gpu' in navigator) ? 'no WebGPU' : 'gpu=off');
    let lib;
    try { lib = await import(SHADERS_CDN); }
    catch (err) { return useFallback('library failed to load'); }
    if (!lib.isWebGPUSupported()) return useFallback('WebGPU unsupported');

    const d0 = sampleDepth(depthAt(window.scrollY));
    const name = nameAt(window.scrollY);
    const TERMINAL = new Set(['unsupported', 'no-adapter', 'no-device', 'init-failed', 'device-lost', 'out-of-memory', 'gpu-error', 'render-failed', 'limit-exceeded', 'unrecoverable', 'rebuild_failed']);

    try {
      shader = await lib.createShader(canvas, { components: buildComponents(d0, name) }, {
        toneMapping: params.get('tone') || TONE_MAPPING,
        disableTelemetry: true,
        onReady: () => {
          if (gpuState === 'fallback') return;
          gpuState = 'ready';
          lastSent = {};
          root.classList.add('gpu-ready');
          if (!DESCEND) setTimeout(sweepName, NAME_RIPPLE_DELAY_MS);
        },
        onError: reason => {
          if (TERMINAL.has(reason) || shader?.getFailureReason()) useFallback(reason);
        },
      });
      if (document.hidden) shader.pause();
    } catch (err) {
      useFallback('createShader failed: ' + (err?.message || err));
    }
  }

  /* -- go --------------------------------------------------------------------- */
  let pendingHash = !DESCEND && location.hash && location.hash.length > 1 ? location.hash : '';
  const dropPending = () => { pendingHash = ''; };
  ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach(t => addEventListener(t, dropPending, { passive: true, once: true }));
  layout();
  document.fonts?.ready.then(layout);
  raf = requestAnimationFrame(frame);
  // let the first frame (CSS deep water + name) paint before pulling in the library
  requestAnimationFrame(() => setTimeout(initShader, 0));

  // debug handle
  window.__ocean = {
    depthAt: () => depthAt(window.scrollY), sweepName,
    state: () => ({ navShown, gpuState, current, qualityCap, introTarget, nameSink }),
    shader: () => shader, lastSent: () => lastSent, DEPTHS,
  };
}

/* ---------- MATH / COLOUR -------------------------------------------------- */

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function lerpArr(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
function smoothstep(a, b, x) { const t = clamp((x - a) / (b - a || 1e-6), 0, 1); return t * t * (3 - 2 * t); }
function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
function r2(v) { return Math.round(v * 100) / 100; }
function r3(v) { return Math.round(v * 1000) / 1000; }

function toLin(c) { return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
function toSrgb(c) { return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055; }

function hexToOklab(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = toLin(((n >> 16) & 255) / 255), g = toLin(((n >> 8) & 255) / 255), b = toLin((n & 255) / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

function oklabToHex([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
  return '#' + rgb.map(c => Math.round(clamp(toSrgb(clamp(c, 0, 1)), 0, 1) * 255).toString(16).padStart(2, '0')).join('');
}

function mixHex(a, b, t) { return oklabToHex(lerpArr(hexToOklab(a), hexToOklab(b), t)); }
