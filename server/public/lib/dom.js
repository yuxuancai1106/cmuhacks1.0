/**
 * Minimal DOM builders.
 *
 * Everything user- or server-supplied reaches the document through
 * `document.createTextNode` / `setAttribute`, never `innerHTML`. That is the
 * whole reason this module exists: there is no code path in the app that can
 * interpolate an API string into markup.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/**
 * `h('div', { class: 'x' }, 'text', otherNode)`.
 *
 * Props: `class`, `text`, `html` is deliberately absent, `dataset` object,
 * `style` object, `on` object of listeners, anything else becomes an attribute
 * (skipped when `null`/`undefined`/`false`).
 */
export function h(tag, props = null, ...children) {
  const el = document.createElement(tag);
  applyProps(el, props);
  append(el, children);
  return el;
}

/** Same, in the SVG namespace. */
export function s(tag, props = null, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  applyProps(el, props, true);
  append(el, children);
  return el;
}

/** `<svg><use href="#i-check"></use></svg>` for the sprite in index.html. */
export function icon(id, cls) {
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${id}`);
  use.setAttributeNS(XLINK_NS, 'xlink:href', `#${id}`);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (cls) svg.setAttribute('class', cls);
  svg.appendChild(use);
  return svg;
}

function applyProps(el, props, isSvg = false) {
  if (!props) return;
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'text') { el.appendChild(document.createTextNode(String(value))); continue; }
    if (key === 'on') {
      for (const [event, fn] of Object.entries(value)) el.addEventListener(event, fn);
      continue;
    }
    if (key === 'dataset') {
      for (const [k, v] of Object.entries(value)) {
        if (v !== null && v !== undefined) el.dataset[k] = String(v);
      }
      continue;
    }
    if (key === 'style') {
      for (const [k, v] of Object.entries(value)) el.style.setProperty(k, String(v));
      continue;
    }
    if (key === 'class') { el.setAttribute('class', String(value)); continue; }
    if (!isSvg && key in el && key !== 'list' && typeof el[key] !== 'object') {
      try { el[key] = value === true ? true : value; continue; } catch { /* fall through */ }
    }
    el.setAttribute(key, value === true ? '' : String(value));
  }
}

function append(el, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Remove every child of `node`. */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Replace the contents of `node` with `children`. */
export function fill(node, ...children) {
  clear(node);
  append(node, children);
  return node;
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

export const $ = (sel, root = document) => root.querySelector(sel);
