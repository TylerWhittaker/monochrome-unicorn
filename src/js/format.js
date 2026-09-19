/* format.js -- Mode 3: fill in a stored format's ^FN fields. Filled in next. */
import { el } from './ui.js';

export function mountFormat(panel) {
  panel.append(el('p', { class: 'text-ink-500' }, ['Format Printer — coming up.']));
}

export function onFormatShown() {}
