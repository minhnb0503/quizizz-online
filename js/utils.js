/**
 * @module utils
 * @description Pure utility functions for Wayground.
 * No side effects, no state dependencies — safe to import anywhere.
 */

// ─── HTML Escaping ─────────────────────────────────────────────────────────

/**
 * Mapping of dangerous characters to their HTML entity equivalents.
 * Covers the OWASP-recommended set for HTML body context.
 * @type {Object<string, string>}
 */
const HTML_ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

/** @type {RegExp} Matches any character that needs HTML escaping */
const HTML_ESCAPE_RE = /[&<>"']/g;

/**
 * Escape a string for safe insertion into HTML.
 * Converts `&`, `<`, `>`, `"`, `'` to their entity equivalents.
 *
 * @param {string} str — Raw string (may contain user input).
 * @returns {string} Escaped string safe for innerHTML of structural markup.
 *
 * @example
 * escapeHtml('<script>alert("xss")</script>')
 * // '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
 */
export function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPE_MAP[ch]);
}


// ─── Array Utilities ───────────────────────────────────────────────────────

/**
 * Fisher–Yates (Durstenfeld) in-place shuffle.
 * Mutates and returns the original array for chaining convenience.
 *
 * @template T
 * @param {T[]} arr — The array to shuffle.
 * @returns {T[]} The same array, now shuffled.
 *
 * @example
 * shuffleArray([1, 2, 3, 4, 5]); // e.g. [3, 1, 5, 2, 4]
 */
export function shuffleArray(arr) {
  if (!Array.isArray(arr)) return arr;
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}


// ─── Deep Clone ────────────────────────────────────────────────────────────

/**
 * Deep-clone an object. Uses `structuredClone` when available (modern browsers),
 * falls back to JSON round-trip (loses functions, Dates become strings, etc.).
 *
 * @template T
 * @param {T} obj — The value to clone.
 * @returns {T} A deep copy with no shared references.
 */
export function deepClone(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  try {
    if (typeof structuredClone === 'function') {
      return structuredClone(obj);
    }
  } catch (_) {
    // structuredClone can throw on non-cloneable values; fall through
  }
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch (_) {
    // Last resort — return the original (caller should handle)
    return obj;
  }
}


// ─── Date / Time ───────────────────────────────────────────────────────────

/**
 * Format a Date object as `HH:MM - DD/MM`.
 * Uses zero-padded 24-hour time and day/month (no year — keeps it compact).
 *
 * @param {Date} [date=new Date()] — The date to format.
 * @returns {string} Formatted string, e.g. `"09:05 - 30/06"`.
 */
export function formatTime(date) {
  const d = date instanceof Date ? date : new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  return `${hh}:${mm} - ${dd}/${mo}`;
}


// ─── Room Code ─────────────────────────────────────────────────────────────

/**
 * Generate a random 6-digit numeric room code.
 * Always exactly 6 characters, zero-padded from the left.
 *
 * @returns {string} e.g. `"048371"`
 */
export function generateRoomCode() {
  // crypto.getRandomValues is available in all modern browsers & Node 19+
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return String(buf[0] % 1000000).padStart(6, '0');
  }
  // Fallback for very old environments
  return String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
}


// ─── Hashing ───────────────────────────────────────────────────────────────

/**
 * Produce a simple numeric hash of a question object for spaced-repetition keying.
 * Uses a fast djb2-variant over the question text + options joined string.
 * Collisions are acceptable — this is not cryptographic.
 *
 * @param {{question: string, options?: string[]}} q — Question object.
 * @returns {string} Hex string hash, e.g. `"a3f7c201"`.
 */
export function hashQuestion(q) {
  if (!q || typeof q.question !== 'string') return '00000000';
  const raw = q.question + (Array.isArray(q.options) ? q.options.join('|') : '');
  let hash = 5381;
  for (let i = 0; i < raw.length; i++) {
    // hash * 33 + charCode  (bitwise for speed)
    hash = ((hash << 5) + hash + raw.charCodeAt(i)) | 0;
  }
  // Convert to unsigned 32-bit then to hex
  return (hash >>> 0).toString(16).padStart(8, '0');
}


// ─── Debounce ──────────────────────────────────────────────────────────────

/**
 * Create a debounced version of a function.
 * The returned function delays invoking `fn` until after `delay` ms
 * have elapsed since the last invocation.
 *
 * @param {Function} fn — The function to debounce.
 * @param {number} delay — Delay in milliseconds.
 * @returns {Function} Debounced function (also exposes `.cancel()` to clear pending call).
 *
 * @example
 * const search = debounce((q) => fetchResults(q), 300);
 * inputEl.addEventListener('input', (e) => search(e.target.value));
 */
export function debounce(fn, delay) {
  let timerId = null;

  /** @type {Function & { cancel: () => void }} */
  const debounced = function (...args) {
    if (timerId !== null) clearTimeout(timerId);
    timerId = setTimeout(() => {
      timerId = null;
      fn.apply(this, args);
    }, delay);
  };

  /** Cancel any pending invocation. */
  debounced.cancel = () => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  };

  return debounced;
}


// ─── DOM Helpers ───────────────────────────────────────────────────────────

/**
 * Create a DOM element with an optional class name and **safe** inner content.
 *
 * If `innerHTML` is provided it is set directly — the caller MUST ensure the
 * string is already escaped or contains only trusted structural markup.
 * For user-generated content, set `textContent` on the returned element instead.
 *
 * @param {string} tag — HTML tag name (e.g. `'div'`, `'span'`).
 * @param {string} [className=''] — Space-separated CSS class names.
 * @param {string} [innerHTML=''] — Trusted HTML string (structural only).
 * @returns {HTMLElement} The created element.
 *
 * @example
 * const card = createElement('div', 'card card--active');
 * card.textContent = userInput; // safe
 */
export function createElement(tag, className, innerHTML) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (innerHTML) el.innerHTML = innerHTML;
  return el;
}

/**
 * Safely set the text content of an element, identified by reference or ID string.
 * Uses `textContent` — never `innerHTML` — so user data cannot inject markup.
 *
 * @param {HTMLElement|string} elementOrId — A DOM element or its `id` attribute.
 * @param {string} text — Plain text to display.
 * @returns {HTMLElement|null} The element (for chaining), or `null` if not found.
 *
 * @example
 * setTextContent('score-display', `Score: ${score}`);
 */
export function setTextContent(elementOrId, text) {
  const el = typeof elementOrId === 'string'
    ? document.getElementById(elementOrId)
    : elementOrId;
  if (!el) return null;
  el.textContent = text;
  return el;
}
