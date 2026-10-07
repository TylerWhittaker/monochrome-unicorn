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
 * codeeditor.js -- the ZPL source editor.
 *
 * Ace is ~400 KB, which inlined would more than double the packed page,
 * so it is fetched from cdnjs the first time the source view opens.
 * That means it is unavailable whenever the browser has no internet --
 * common for a printer on an isolated network -- so there is a real
 * fallback: a textarea with a syntax-highlighted layer behind it.
 */

import { escapeHtml } from './ui.js';

const ACE_VERSION = '1.32.7';
const ACE_URL = `https://cdnjs.cloudflare.com/ajax/libs/ace/${ACE_VERSION}/ace.min.js`;
const ACE_TIMEOUT = 6000;

let acePromise = null;

/** Load Ace once. Resolves null (never rejects) when it cannot be reached. */
function loadAce() {
  if (acePromise) return acePromise;

  acePromise = new Promise((resolve) => {
    if (window.ace) {
      resolve(window.ace);
      return;
    }

    const script = document.createElement('script');
    script.src = ACE_URL;
    script.async = true;

    const timer = setTimeout(() => {
      script.remove();
      resolve(null);
    }, ACE_TIMEOUT);
    script.onload = () => {
      clearTimeout(timer);
      resolve(window.ace || null);
    };
    script.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    document.head.append(script);
  });
  return acePromise;
}

/* ------------------------------------------------------------------ *
 * ZPL syntax rules, shared by both editors
 * ------------------------------------------------------------------ */

/**
 * Tokenize a line of ZPL for highlighting. Kept separate from zpl.js's
 * parser: this one only has to be fast and never throw.
 */
function highlightTokens(line) {
  const tokens = [];
  const re =
    /(\^FX[^\^~]*)|(\^FD|\^FV)([^\^~]*)|(\^FN\d+)|([\^~][A-Za-z][A-Za-z0-9]?)|([-+]?\d+(?:\.\d+)?)|([^\^~\d]+)/g;
  let match;
  while ((match = re.exec(line)) !== null) {
    if (match[1]) tokens.push(['comment', match[1]]);
    else if (match[2]) {
      tokens.push(['command', match[2]]);
      if (match[3]) tokens.push(['data', match[3]]);
    } else if (match[4]) tokens.push(['field', match[4]]);
    else if (match[5]) tokens.push(['command', match[5]]);
    else if (match[6]) tokens.push(['number', match[6]]);
    else tokens.push(['text', match[7]]);
  }
  return tokens;
}

const TOKEN_CLASS = {
  comment: 'text-ink-400 italic',
  command: 'text-sky-700 font-semibold',
  data: 'text-emerald-700',
  field: 'text-violet-700 font-semibold',
  number: 'text-amber-700',
  text: 'text-ink-800',
};

function highlightToHtml(text) {
  return text
    .split('\n')
    .map((line) =>
      highlightTokens(line)
        .map(([kind, value]) => `<span class="${TOKEN_CLASS[kind]}">${escapeHtml(value)}</span>`)
        .join(''),
    )
    .join('\n');
}

/** Register a ZPL mode with a loaded Ace instance. Idempotent. */
function defineAceZplMode(ace) {
  if (ace.__zplModeDefined) return 'ace/mode/zpl';
  ace.__zplModeDefined = true;

  ace.define(
    'ace/mode/zpl_highlight_rules',
    ['require', 'exports', 'ace/lib/oop', 'ace/mode/text_highlight_rules'],
    (require, exports) => {
      const oop = require('ace/lib/oop');
      const TextHighlightRules = require('ace/mode/text_highlight_rules').TextHighlightRules;

      const ZplHighlightRules = function () {
        // One flat state. Field data is captured in the same rule as the
        // command that introduces it rather than through a second state:
        // the obvious "stop at the next command" rule is a zero-width
        // lookahead, and Ace's tokenizer does not handle those reliably.
        this.$rules = {
          start: [
            // ^FX is ZPL's comment: everything up to the next command.
            { token: 'comment', regex: '\\^FX[^\\^~]*' },
            { token: 'keyword.control', regex: '\\^X[AZ]\\b' },
            { token: 'variable.parameter', regex: '\\^FN\\d+' },
            { token: ['support.function', 'string'], regex: '(\\^F[DV])([^\\^~]*)' },
            { token: 'support.function', regex: '[\\^~][A-Za-z][A-Za-z0-9]?' },
            { token: 'constant.numeric', regex: '[-+]?\\d+(?:\\.\\d+)?' },
            { token: 'punctuation.operator', regex: ',' },
            { token: 'text', regex: '.' },
          ],
        };
      };
      oop.inherits(ZplHighlightRules, TextHighlightRules);
      exports.ZplHighlightRules = ZplHighlightRules;
    },
  );

  ace.define(
    'ace/mode/zpl',
    ['require', 'exports', 'ace/lib/oop', 'ace/mode/text', 'ace/mode/zpl_highlight_rules'],
    (require, exports) => {
      const oop = require('ace/lib/oop');
      const TextMode = require('ace/mode/text').Mode;
      const ZplHighlightRules = require('ace/mode/zpl_highlight_rules').ZplHighlightRules;

      const Mode = function () {
        this.HighlightRules = ZplHighlightRules;
        this.lineCommentStart = '^FX';
      };
      oop.inherits(Mode, TextMode);
      Mode.prototype.$id = 'ace/mode/zpl';
      exports.Mode = Mode;
    },
  );

  return 'ace/mode/zpl';
}

/* ------------------------------------------------------------------ *
 * Fallback editor
 * ------------------------------------------------------------------ */

/**
 * A textarea with a highlighted <pre> behind it. The two share font,
 * padding and line-height so the painted text lines up under the real
 * (transparent) glyphs; scroll is mirrored on input and scroll.
 */
function createFallbackEditor(container, { value, onChange, onCursor }) {
  const shared =
    'm-0 border-0 p-3 font-mono text-[12px] leading-[1.5] whitespace-pre-wrap break-words';

  const highlight = document.createElement('pre');
  highlight.className = `${shared} pointer-events-none absolute inset-0 overflow-hidden`;
  highlight.setAttribute('aria-hidden', 'true');

  const textarea = document.createElement('textarea');
  textarea.className = `${shared} absolute inset-0 h-full w-full resize-none bg-transparent text-transparent caret-ink-900 outline-none`;
  textarea.spellcheck = false;
  textarea.autocapitalize = 'off';
  textarea.autocomplete = 'off';
  textarea.value = value || '';

  const wrap = document.createElement('div');
  wrap.className = 'relative h-full w-full overflow-hidden bg-white';
  wrap.append(highlight, textarea);
  container.append(wrap);

  const paint = () => {
    // The trailing newline keeps the last line visible while typing.
    highlight.innerHTML = highlightToHtml(textarea.value) + '\n';
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
  };
  paint();

  textarea.addEventListener('input', () => {
    paint();
    onChange(textarea.value);
  });
  // Where the cursor is, as a character offset, whenever it may have moved.
  const reportCursor = () => onCursor(textarea.selectionStart);
  for (const type of ['keyup', 'mouseup', 'input', 'focus']) {
    textarea.addEventListener(type, reportCursor);
  }
  textarea.addEventListener('scroll', () => {
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
  });
  // Tab should indent, not leave the editor.
  textarea.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    event.preventDefault();
    const { selectionStart: s, selectionEnd: e, value: v } = textarea;
    textarea.value = `${v.slice(0, s)}  ${v.slice(e)}`;
    textarea.selectionStart = textarea.selectionEnd = s + 2;
    paint();
    onChange(textarea.value);
  });

  return {
    engine: 'textarea',
    getValue: () => textarea.value,
    setValue(next) {
      if (textarea.value === next) return;
      textarea.value = next;
      paint();
    },
    focus: () => textarea.focus(),
    resize() {},
    destroy() {
      wrap.remove();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Public factory
 * ------------------------------------------------------------------ */

/**
 * Build the best source editor available. Resolves as soon as it knows
 * which one it got; `engine` says which, so the UI can mention it.
 *
 * `onCursor(offset)` is told where the cursor is, as a character offset
 * into the text, each time it moves.
 */
export async function createCodeEditor(
  container,
  { value = '', onChange = () => {}, onCursor = () => {} } = {},
) {
  const ace = await loadAce();
  if (!ace) return createFallbackEditor(container, { value, onChange, onCursor });

  const host = document.createElement('div');
  host.className = 'h-full w-full';
  container.append(host);

  const editor = ace.edit(host);
  editor.setOptions({
    // A deliberately small configuration: this is a ZPL scratchpad, not an IDE.
    mode: defineAceZplMode(ace),
    theme: null,
    fontSize: 12,
    showPrintMargin: false,
    highlightActiveLine: true,
    wrap: true,
    useWorker: false,
    showFoldWidgets: false,
    tabSize: 2,
    useSoftTabs: true,
  });
  editor.renderer.setScrollMargin(8, 8);
  editor.session.setValue(value);
  editor.clearSelection();

  let suppress = false;
  editor.session.on('change', () => {
    if (suppress) return;
    onChange(editor.getValue());
  });
  editor.selection.on('changeCursor', () => {
    onCursor(editor.session.doc.positionToIndex(editor.getCursorPosition()));
  });

  return {
    engine: 'ace',
    getValue: () => editor.getValue(),
    setValue(next) {
      if (editor.getValue() === next) return;
      suppress = true;
      const pos = editor.getCursorPosition();
      editor.session.setValue(next);
      editor.moveCursorToPosition(pos);
      editor.clearSelection();
      suppress = false;
    },
    focus: () => editor.focus(),
    resize: () => editor.resize(),
    destroy() {
      editor.destroy();
      host.remove();
    },
  };
}
