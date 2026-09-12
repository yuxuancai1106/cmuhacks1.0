/**
 * Motion helpers. Every one of them is a no-op under
 * `prefers-reduced-motion: reduce` — the value still lands, instantly.
 */

const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
export const prefersReducedMotion = () => reduceQuery.matches;

const easeOut = (t) => 1 - Math.pow(1 - t, 3);

/**
 * Tween the text of `el` from its current numeric value to `to`.
 * `render(value)` turns the in-flight number into the string shown.
 */
export function tweenNumber(el, to, render = (v) => String(Math.round(v)), duration = 480) {
  const from = Number(el.dataset.value);
  const target = Number(to);
  const start = Number.isFinite(from) ? from : target;

  if (!Number.isFinite(target)) {
    el.dataset.value = '';
    el.textContent = render(NaN);
    return;
  }
  el.dataset.value = String(target);
  if (prefersReducedMotion() || start === target) {
    el.textContent = render(target);
    return;
  }

  const t0 = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - t0) / duration);
    const value = start + (target - start) * easeOut(p);
    el.textContent = render(p === 1 ? target : value);
    // A newer tween may have taken over; its target wins.
    if (p < 1 && el.dataset.value === String(target)) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Staggered entrance for a freshly built list of elements. */
export function stagger(elements, step = 34, base = 0) {
  if (prefersReducedMotion()) return;
  elements.forEach((el, i) => {
    el.classList.add('enter');
    el.style.animationDelay = `${base + i * step}ms`;
  });
}

/** Restart a one-shot CSS animation class. */
export function pulse(el, cls) {
  if (prefersReducedMotion() || !el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}
