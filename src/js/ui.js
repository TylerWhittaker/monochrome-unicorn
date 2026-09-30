/*
 * Zebra Printer Console -- a web console served from a Zebra printer.
 * Copyright (C) 2026 Tyler Whittaker
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/*
 * ui.js -- DOM helpers, toasts and modals shared by all three modes.
 */

/** document.querySelector with a shorter name. */
export function qs(selector, root = document) {
  return root.querySelector(selector);
}

export function qsa(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

/**
 * Build an element. Attributes starting with "on" are wired as listeners,
 * `class` and `html` get special handling, everything else is setAttribute.
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children).flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

/**
 * Replace an element's children in one shot. Nested arrays are flattened
 * all the way down, so a helper that returns a group of nodes can be
 * dropped straight into a child list.
 */
export function replaceChildren(node, ...children) {
  node.replaceChildren(...children.flat(Infinity).filter(Boolean));
}

export function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

/* ------------------------------------------------------------------ *
 * Toasts
 * ------------------------------------------------------------------ */

const TOAST_STYLES = {
  info: 'border-ink-300 bg-white text-ink-800',
  success: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  error: 'border-red-300 bg-red-50 text-red-900',
  busy: 'border-ink-300 bg-white text-ink-600',
};

/**
 * Show a toast. Returns a handle so long-running work can update the same
 * toast in place instead of stacking several.
 */
export function toast(message, kind = 'info', { timeout = 4000 } = {}) {
  const host = qs('#toasts');
  if (!host) return { update() {}, close() {} };

  const node = el(
    'div',
    {
      class: `pointer-events-auto rounded-md border px-3 py-2 shadow-md transition-opacity ${TOAST_STYLES[kind] || TOAST_STYLES.info}`,
      role: kind === 'error' ? 'alert' : 'status',
    },
    [message],
  );
  host.append(node);

  let timer = null;
  const close = () => {
    if (timer) clearTimeout(timer);
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 200);
  };
  const arm = (ms) => {
    if (timer) clearTimeout(timer);
    timer = ms ? setTimeout(close, ms) : null;
  };
  arm(timeout);

  return {
    node,
    close,
    update(text, nextKind = kind, opts = {}) {
      node.textContent = text;
      node.className = `pointer-events-auto rounded-md border px-3 py-2 shadow-md transition-opacity ${TOAST_STYLES[nextKind] || TOAST_STYLES.info}`;
      arm(opts.timeout === undefined ? 4000 : opts.timeout);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Modal
 * ------------------------------------------------------------------ */

/**
 * Show a modal dialog. `render(close)` returns the body; `close(value)`
 * resolves the promise. Escape and backdrop clicks resolve with null.
 */
export function modal(title, render) {
  return new Promise((resolvePromise) => {
    const root = qs('#modal-root');
    let settled = false;

    const close = (value = null) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolvePromise(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close(null);
    };

    const panel = el(
      'div',
      {
        class: 'card w-[min(30rem,calc(100vw-2rem))] max-h-[85vh] overflow-auto',
        onclick: (event) => event.stopPropagation(),
      },
      [
        el('div', { class: 'border-b border-ink-200 px-4 py-2.5 text-[13px] font-semibold' }, [
          title,
        ]),
        el('div', { class: 'px-4 py-3' }, [render(close)]),
      ],
    );

    const backdrop = el(
      'div',
      {
        class: 'fixed inset-0 z-40 flex items-center justify-center bg-ink-900/40 p-4',
        onclick: () => close(null),
      },
      [panel],
    );

    root.append(backdrop);
    document.addEventListener('keydown', onKey);
    const focusTarget = panel.querySelector('input, select, textarea, button');
    if (focusTarget) focusTarget.focus();
  });
}

/** Ask for confirmation. Resolves true only if the user confirms. */
export async function confirmDialog(title, message, confirmLabel = 'Confirm') {
  const result = await modal(title, (close) =>
    el('div', { class: 'space-y-3' }, [
      el('p', { class: 'text-ink-700' }, [message]),
      el('div', { class: 'flex justify-end gap-2' }, [
        el('button', { class: 'btn-secondary', onclick: () => close(false) }, ['Cancel']),
        el('button', { class: 'btn-danger', onclick: () => close(true) }, [confirmLabel]),
      ]),
    ]),
  );
  return result === true;
}

/*
 * Printing asks first only for a large run -- a mistyped count is the
 * expensive mistake -- and the dialog offers to stop asking at all. That
 * choice is remembered in this browser.
 */
export const CONFIRM_PRINT_OVER = 25;
const NO_PRINT_CONFIRM_KEY = 'zebra.noPrintConfirm';

function printConfirmOff() {
  try {
    return localStorage.getItem(NO_PRINT_CONFIRM_KEY) === '1';
  } catch (err) {
    return false;
  }
}

/**
 * Whether to go ahead and print `count` labels: at once for up to
 * CONFIRM_PRINT_OVER, otherwise once the user says so.
 */
export async function confirmPrint(count, what) {
  if (count <= CONFIRM_PRINT_OVER || printConfirmOff()) return true;

  const never = el('input', { type: 'checkbox', class: 'h-3.5 w-3.5 accent-ink-900' });
  const result = await modal(`Print ${count} labels?`, (close) =>
    el('div', { class: 'space-y-3' }, [
      el('p', { class: 'text-ink-700' }, [`${what} will be printed ${count} times.`]),
      el('label', { class: 'flex items-center gap-2 text-[12px] text-ink-600' }, [
        never,
        "Don't ask before printing again",
      ]),
      el('div', { class: 'flex justify-end gap-2' }, [
        el('button', { class: 'btn-secondary', onclick: () => close(false) }, ['Cancel']),
        el('button', { class: 'btn-primary', onclick: () => close(true) }, [`Print ${count}`]),
      ]),
    ]),
  );
  if (result !== true) return false;
  if (never.checked) {
    try {
      localStorage.setItem(NO_PRINT_CONFIRM_KEY, '1');
    } catch (err) {
      // Private mode or blocked storage: it will simply ask again.
    }
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Printer password
 *
 * Saving and deleting go through the printer's own web forms, which want
 * the 4-digit panel password (factory default 1234). Held in sessionStorage
 * so it survives tab switches but not the browser session.
 * ------------------------------------------------------------------ */

const PW_KEY = 'zebra.pw';

/**
 * The factory password, tried before anyone is asked to type one.
 *
 * Most printers still have it, and the ones that do not say so plainly
 * ("ERROR: Invalid password"), which is a better prompt than a dialog
 * that appears before anything has gone wrong.
 */
const DEFAULT_PASSWORD = '1234';

export function getPassword() {
  try {
    return sessionStorage.getItem(PW_KEY) || '';
  } catch (err) {
    return '';
  }
}

export function setPassword(value) {
  try {
    sessionStorage.setItem(PW_KEY, value);
  } catch (err) {
    /* private mode; the password just will not persist */
  }
}

/** Return a password, prompting only when we do not already have one. */
export async function requirePassword({ force = false, hint = null } = {}) {
  const existing = getPassword();
  if (existing && !force) return existing;

  const value = await modal('Printer password', (close) => {
    const input = el('input', {
      class: 'field field-mono',
      type: 'password',
      maxlength: '4',
      inputmode: 'numeric',
      placeholder: '1234',
      value: existing,
      onkeydown: (event) => {
        if (event.key === 'Enter') close(input.value);
      },
    });
    return el('div', { class: 'space-y-3' }, [
      hint
        ? el(
            'p',
            {
              class:
                'rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[12px] text-amber-900',
            },
            [hint],
          )
        : null,
      el('p', { class: 'text-ink-600' }, [
        'Writing to the printer’s filesystem needs its 4-digit password (factory default 1234).',
      ]),
      input,
      el('div', { class: 'flex justify-end gap-2' }, [
        el('button', { class: 'btn-secondary', onclick: () => close(null) }, ['Cancel']),
        el('button', { class: 'btn-primary', onclick: () => close(input.value) }, ['Use password']),
      ]),
    ]);
  });

  if (value === null) return null;
  setPassword(value);
  return value;
}

/**
 * Do something that needs the printer's password, asking for one only
 * if the printer objects.
 *
 * `attempt(password)` is expected to throw an error mentioning the
 * password when the printer rejects it, which is what its own error
 * page says. A password that works is remembered for the session, so
 * the question is asked at most once -- and on a printer still set to
 * the factory default, never.
 *
 * Cancelling throws an error carrying `cancelled`, so a caller can tell
 * "you changed your mind" from "the printer refused".
 */
export async function withPrinterPassword(attempt, { attempts = 3 } = {}) {
  let password = getPassword() || DEFAULT_PASSWORD;
  let asked = false;

  for (let i = 0; i < attempts; i++) {
    try {
      const result = await attempt(password);
      setPassword(password);
      return result;
    } catch (err) {
      if (!/password/i.test(err.message || '')) throw err;

      const next = await requirePassword({
        force: true,
        hint: asked
          ? 'That password was not accepted either.'
          : `The printer did not accept ${password === DEFAULT_PASSWORD ? 'the factory default (1234)' : 'the saved password'}.`,
      });
      asked = true;
      if (next === null) {
        const cancelled = new Error('No password given');
        cancelled.cancelled = true;
        throw cancelled;
      }
      password = next;
    }
  }
  throw new Error('The printer rejected that password');
}

/* ------------------------------------------------------------------ *
 * Misc
 * ------------------------------------------------------------------ */

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
