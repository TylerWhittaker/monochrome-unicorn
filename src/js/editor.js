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
 * editor.js -- Mode 2: create, edit, preview and print stored ZPL labels.
 *
 * Two views over one label: a ZPL source editor and a drag-and-drop
 * canvas. The document model is the canvas's truth and the text is the
 * source view's truth, so switching direction re-derives the other side.
 * Going source -> visual can lose ground (ZPL has far more commands than
 * the canvas models), so anything unrecognised is reported and carried
 * through untouched rather than discarded.
 */

import {
  el,
  qs,
  toast,
  modal,
  confirmDialog,
  confirmPrint,
  withPrinterPassword,
  debounce,
  formatBytes,
} from './ui.js';
import { printer, loadUnitPreference, toDots, fromDots, unitStep } from './state.js';
import { listFiles, readScript, saveScript, deleteFile, parseObjectName } from './printer.js';
import { uploadImageDialog } from './imagedialog.js';
import {
  newLabel,
  newElement,
  toZpl,
  parseZpl,
  elementId,
  nextFieldNumber,
  formatZpl,
} from './zpl.js';
import { createCanvas } from './wysiwyg.js';
import { renderLabelPanel, renderElementPanel, panelHeading } from './inspector.js';
import { createCodeEditor } from './codeeditor.js';
import { createPreview } from './preview.js';
import { parseCopies } from './formats.js';

const editorState = {
  doc: null,
  /** Authoritative ZPL while the source view is showing. */
  source: '',
  view: 'visual',
  file: null,
  dirty: false,
  scripts: [],
  images: [],
};

let canvas = null;
let codeEditor = null;
let editorPreview = null;
let editorHost = null;
let inspectorHost = null;
let labelPanelHost = null;
let fileSelect = null;
let addBar = null;
let viewBar = null;
let editorCountInput = null;
let gridSizeInput = null;

/*
 * The canvas grid: on or off, and its pitch in dots; and whether the
 * rulers are drawn. Preferences of the person, like the units, so they
 * are remembered in this browser.
 */
const GRID_KEY = 'zebra.grid';
const editorGrid = { on: false, dots: 0, rulers: false };

function loadGridPreference() {
  editorGrid.dots = Math.round(printer.dpi / 4);
  try {
    const saved = JSON.parse(localStorage.getItem(GRID_KEY) || 'null');
    if (saved && saved.dots > 0) {
      Object.assign(editorGrid, { on: !!saved.on, dots: saved.dots, rulers: !!saved.rulers });
    }
  } catch (err) {
    /* nothing saved, or storage blocked */
  }
}

function saveGridPreference() {
  try {
    localStorage.setItem(GRID_KEY, JSON.stringify(editorGrid));
  } catch (err) {
    /* private mode; it just will not persist */
  }
}

/** The grid size box shows the pitch in whatever the units are now. */
function syncGridInput() {
  if (!gridSizeInput) return;
  const unit = editorState.doc.unit;
  gridSizeInput.value = String(fromDots(editorGrid.dots, unit));
  gridSizeInput.step = String(unitStep(unit));
  gridSizeInput.nextSibling.textContent = unit;
  gridSizeInput.disabled = !editorGrid.on;
}
/** A label another mode asked for, waiting for this one to exist. */
let pendingOpen = null;

const EDITOR_HOST_CLASS = {
  visual: 'flex min-h-0 flex-col overflow-hidden',
  source: 'flex h-[60vh] min-h-[20rem] flex-col overflow-hidden',
};

/* ------------------------------------------------------------------ *
 * Document plumbing
 * ------------------------------------------------------------------ */

function editorZpl() {
  return editorState.view === 'source' && codeEditor
    ? codeEditor.getValue()
    : toZpl(editorState.doc);
}

/** Ask the printer to render, unless there is demonstrably nothing to draw. */
function refreshEditorPreview() {
  if (!editorPreview) return;
  if (
    editorState.view === 'visual' &&
    editorState.doc.elements.length === 0 &&
    !(editorState.doc.passthrough || []).length
  ) {
    editorPreview.idle('Add an element to see the printed result.');
    return;
  }
  editorPreview.update(editorZpl());
}

const scheduleEditorPreview = debounce(refreshEditorPreview, 700);

function markDirty() {
  editorState.dirty = true;
  scheduleEditorPreview();
}

/** Called after any change made through the canvas or the inspector. */
function onDocChanged() {
  syncGridInput();
  if (canvas) canvas.render();
  renderEditorInspector();
  renderLabelPanel(labelPanelHost, { doc: editorState.doc, onChange: onDocChanged });
  markDirty();
}

/**
 * Units are a preference, not a property of the label: the Units radio
 * buttons set it, it is remembered, and every label that takes the
 * editor's place -- opened, new, or re-read from the source view --
 * comes in with it. A parsed label on its own would say inches.
 */
function adoptDocument(doc) {
  doc.unit = loadUnitPreference();
  editorState.doc = doc;
}

function loadDocument(zpl, file) {
  const { doc, unsupported } = parseZpl(zpl, printer.dpi);
  adoptDocument(doc);
  editorState.source = zpl;
  editorState.file = file || null;
  editorState.dirty = false;

  if (unsupported.length) {
    toast(
      `Opened with ${unsupported.length} command type(s) the visual editor does not model ` +
        `(${unsupported.slice(0, 5).join(' ')}). They are preserved but only editable in the source view.`,
      'info',
      { timeout: 9000 },
    );
  }
  renderLabelPanel(labelPanelHost, { doc: editorState.doc, onChange: onDocChanged });
  rebuildEditorView();
  refreshEditorPreview();
}

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

async function setView(next) {
  if (editorState.view === next) return;

  if (next === 'visual') {
    // Re-parse whatever the user typed; warn before dropping anything.
    const text = codeEditor ? codeEditor.getValue() : editorState.source;
    const { doc, unsupported } = parseZpl(text, printer.dpi);
    if (unsupported.length) {
      const go = await confirmDialog(
        'Switch to the visual editor?',
        `This label uses ${unsupported.join(', ')}, which the visual editor cannot place on the canvas. ` +
          'They will be kept and re-emitted at the end of the label, but you will not see them until you switch back.',
        'Switch anyway',
      );
      if (!go) return;
    }
    adoptDocument(doc);
    editorState.source = text;
  } else {
    editorState.source = toZpl(editorState.doc);
  }

  editorState.view = next;
  rebuildEditorView();
}

/**
 * The Count box is the label's own ^PQ, so it follows whichever label is
 * open. In the source view the text is what prints, ^PQ and all, so it
 * is edited there instead.
 */
function syncCount() {
  if (!editorCountInput) return;
  const source = editorState.view === 'source';
  editorCountInput.value = source ? '' : String(editorState.doc.copies || 1);
  editorCountInput.disabled = source;
  editorCountInput.title = source
    ? 'In the source view, set the count with ^PQ in the ZPL'
    : 'How many to print; saved with the label as ^PQ';
}

/** How many labels Print will produce: ^PQ in the source view, else Count. */
function printCount() {
  if (editorState.view !== 'source') return editorState.doc.copies || 1;
  const pq = /\^PQ\s*(\d+)/i.exec(editorZpl());
  return pq ? parseInt(pq[1], 10) || 1 : 1;
}

function rebuildEditorView() {
  syncCount();
  syncGridInput();
  if (canvas) {
    canvas.destroy();
    canvas = null;
  }
  if (codeEditor) {
    codeEditor.destroy();
    codeEditor = null;
  }
  editorHost.replaceChildren();

  addBar.hidden = editorState.view !== 'visual';
  // The Visual/Source toggle sits by the file picker, so it stays put
  // in both views -- it is how you get back.
  viewBar.hidden = editorState.view !== 'visual';
  // The canvas takes its height from the label it is showing; the source
  // editor has no natural height of its own and has to be given one.
  editorHost.className = EDITOR_HOST_CLASS[editorState.view] || EDITOR_HOST_CLASS.visual;
  for (const btn of qs('#view-toggle').querySelectorAll('button')) {
    btn.setAttribute('aria-selected', String(btn.dataset.view === editorState.view));
    btn.className =
      btn.dataset.view === editorState.view
        ? 'btn-primary btn-sm rounded-none'
        : 'btn-secondary btn-sm rounded-none border-transparent bg-transparent';
  }

  if (editorState.view === 'visual') {
    canvas = createCanvas(editorHost, {
      getDoc: () => editorState.doc,
      onChange: () => {
        renderEditorInspector();
        markDirty();
      },
      onSelect: () => renderEditorInspector(),
      getGrid: () => (editorGrid.on ? editorGrid.dots : 0),
      getRulers: () => editorGrid.rulers,
    });
    renderEditorInspector();
    return;
  }

  const placeholder = el('div', { class: 'p-3 text-[12px] text-ink-400' }, [
    'Loading the source editor…',
  ]);
  editorHost.append(placeholder);
  createCodeEditor(editorHost, {
    value: editorState.source,
    onChange: (text) => {
      editorState.source = text;
      markDirty();
    },
  }).then((editor) => {
    placeholder.remove();
    codeEditor = editor;
    if (editor.engine === 'textarea') {
      toast('Ace could not be loaded from the CDN; using the built-in editor.', 'info');
    }
    editor.resize();
  });
  renderEditorInspector();
}

function renderEditorInspector() {
  const selectedId = canvas ? canvas.getSelected() : null;
  const item = selectedId ? editorState.doc.elements.find((e) => e.id === selectedId) : null;

  if (editorState.view === 'source') {
    inspectorHost.replaceChildren(
      el('p', { class: 'px-3 py-4 text-[12px] text-ink-400' }, [
        'Element properties are available in the visual editor.',
      ]),
    );
    return;
  }

  renderElementPanel(inspectorHost, {
    doc: editorState.doc,
    item,
    images: editorState.images,
    onChange: onDocChanged,
    onUploadImage: (target) => uploadImageForElement(target),
    onDelete: () => {
      editorState.doc.elements = editorState.doc.elements.filter((e) => e.id !== selectedId);
      canvas.setSelected(null);
      onDocChanged();
    },
    onDuplicate: () => {
      const copy = { ...item, id: elementId(), x: item.x + 20, y: item.y + 20 };
      // Two fields sharing a ^FN number are one field as far as the
      // printer is concerned, so a copied field gets the next one.
      if (copy.type === 'field') copy.number = nextFieldNumber(editorState.doc);
      editorState.doc.elements.push(copy);
      canvas.setSelected(copy.id);
      onDocChanged();
    },
  });
}

/* ------------------------------------------------------------------ *
 * File operations
 * ------------------------------------------------------------------ */

async function refreshFileList() {
  try {
    const files = await listFiles({ dev: 'E', otype: '*  ' });
    editorState.scripts = files.filter((f) => f.otype === 'ZPL');
    editorState.images = files.filter((f) => ['PNG', 'GRF', 'BMP', 'PCX'].includes(f.otype));
  } catch (err) {
    toast(`Could not list the printer's files: ${err.message}`, 'error');
    return;
  }

  fileSelect.replaceChildren(el('option', { value: '' }, ['— stored labels —']));
  for (const file of editorState.scripts) {
    fileSelect.append(
      el(
        'option',
        {
          value: `${file.dev}:${file.oname}`,
          selected:
            editorState.file &&
            editorState.file.oname === file.oname &&
            editorState.file.dev === file.dev,
        },
        [`${file.name}  (${formatBytes(file.bytes)})`],
      ),
    );
  }
}

async function openFile(value) {
  if (!value) return;
  const [dev, oname] = value.split(':');

  if (
    editorState.dirty &&
    !(await confirmDialog('Discard changes?', 'The current label has unsaved changes.', 'Discard'))
  ) {
    fileSelect.value = editorState.file ? `${editorState.file.dev}:${editorState.file.oname}` : '';
    return;
  }

  const busy = toast(`Opening ${dev}:${oname}.ZPL…`, 'busy', { timeout: 0 });
  try {
    // /zpl returns most of a label as one long line; lay it out the way
    // a download does, so the source view is readable from the off.
    const zpl = formatZpl(await readScript({ dev, oname, otype: 'ZPL' }));
    loadDocument(zpl, { dev, oname });
    busy.close();
  } catch (err) {
    busy.update(`Could not open ${oname}: ${err.message}`, 'error');
  }
}

async function saveFile({ saveAs }) {
  let target = editorState.file;

  if (saveAs || !target) {
    const typed = await modal(saveAs ? 'Save label as' : 'Save label', (close) => {
      const input = el('input', {
        class: 'field field-mono',
        type: 'text',
        maxlength: '25',
        placeholder: 'LABELNAME.ZPL',
        value: target ? `${target.oname}.${target.otype || 'ZPL'}` : '',
        onkeydown: (e) => {
          if (e.key === 'Enter') close(input.value);
        },
      });
      return el('div', { class: 'space-y-3' }, [
        el('p', { class: 'text-ink-600' }, [
          'Object names are upper case, up to 16 characters. Give an extension and it is ' +
            'used as it stands; leave it off and the label is saved as .ZPL.',
        ]),
        input,
        el('div', { class: 'flex justify-end gap-2' }, [
          el('button', { class: 'btn-secondary', onclick: () => close(null) }, ['Cancel']),
          el('button', { class: 'btn-primary', onclick: () => close(input.value) }, ['Save']),
        ]),
      ]);
    });
    if (!typed) return;

    const { oname, otype } = parseObjectName(typed, 'ZPL');
    if (!oname) {
      toast('That name has no usable characters.', 'error');
      return;
    }
    target = { dev: 'E', oname, otype };
  }

  const otype = target.otype || 'ZPL';
  const full = `${target.dev}:${target.oname}.${otype}`;
  const busy = toast(`Saving ${full}…`, 'busy', { timeout: 0 });

  try {
    await withPrinterPassword((password) =>
      saveScript({
        dev: target.dev,
        oname: target.oname,
        otype,
        data: editorZpl(),
        password,
      }),
    );
  } catch (err) {
    busy.close();
    if (!err.cancelled) toast(`Save failed: ${err.message}`, 'error');
    return;
  }

  editorState.file = target;
  editorState.dirty = false;
  await refreshFileList();
  fileSelect.value = `${target.dev}:${target.oname}`;

  // The label form stores what it likes: asked for an extension it does
  // not write, it saves a .ZPL and says nothing. Say what actually
  // landed rather than repeating what was asked for.
  const stored =
    editorState.scripts.find((f) => f.oname === target.oname && f.otype === otype) ||
    editorState.scripts.find((f) => f.oname === target.oname);
  if (stored && stored.otype !== otype) {
    busy.update(
      `Saved as ${stored.name} — the printer's label form only writes .ZPL, whatever it is asked for.`,
      'info',
      { timeout: 8000 },
    );
    editorState.file = { dev: stored.dev, oname: stored.oname, otype: stored.otype };
  } else {
    busy.update(`Saved ${full}`, 'success');
  }
}

async function deleteCurrent() {
  if (!editorState.file) {
    toast('This label has not been saved yet.', 'info');
    return;
  }
  const { dev, oname } = editorState.file;

  const otype = editorState.file.otype || 'ZPL';
  if (
    !(await confirmDialog(
      'Delete label?',
      `${dev}:${oname}.${otype} will be removed from the printer.`,
      'Delete',
    ))
  )
    return;

  try {
    await withPrinterPassword((password) => deleteFile({ dev, oname, otype, password }));
    toast(`Deleted ${dev}:${oname}.${otype}`, 'success');
    editorState.file = null;
    await refreshFileList();
  } catch (err) {
    if (!err.cancelled) toast(`Delete failed: ${err.message}`, 'error');
  }
}

async function newLabelDoc() {
  if (
    editorState.dirty &&
    !(await confirmDialog('Discard changes?', 'The current label has unsaved changes.', 'Discard'))
  )
    return;
  adoptDocument(newLabel(printer.dpi, printer.labelSize));
  editorState.source = toZpl(editorState.doc);
  editorState.file = null;
  editorState.dirty = false;
  fileSelect.value = '';
  rebuildEditorView();
  renderLabelPanel(labelPanelHost, { doc: editorState.doc, onChange: onDocChanged });
  refreshEditorPreview();
}

function addElement(type) {
  const item = newElement(type, editorState.doc, printer.dpi);
  // Cascade, so a run of Add clicks does not bury everything in one spot.
  const step = Math.round(printer.dpi * 0.15);
  const offset = (editorState.doc.elements.length % 8) * step;
  item.x += offset;
  item.y += offset;
  if (type === 'image' && editorState.images.length) item.source = editorState.images[0].name;
  editorState.doc.elements.push(item);
  if (canvas) canvas.setSelected(item.id);
  onDocChanged();

  // Nothing stored to point at yet, so go straight to uploading one.
  if (type === 'image' && !editorState.images.length) uploadImageForElement(item);
}

/**
 * Upload a picture and point an image element at it. The printer can
 * only store one-bit graphics, so the dialog does the conversion and
 * shows the result before anything is sent.
 */
async function uploadImageForElement(item) {
  const stored = await uploadImageDialog({ doc: editorState.doc });
  if (!stored) return;

  await refreshFileList();
  if (item) {
    item.source = stored;
    item.scaleX = 1;
    item.scaleY = 1;
    delete item.naturalWidth;
    delete item.naturalHeight;
  }
  onDocChanged();
}

async function printEditorLabel() {
  const name = editorState.file ? `${editorState.file.oname}.ZPL` : 'This label';
  if (!(await confirmPrint(printCount(), name))) return;
  editorPreview.print(editorZpl());
}

/* ------------------------------------------------------------------ *
 * Mount
 * ------------------------------------------------------------------ */

export function mountEditor(panel) {
  adoptDocument(newLabel(printer.dpi, printer.labelSize));
  editorState.source = toZpl(editorState.doc);

  fileSelect = el('select', { class: 'field w-full min-w-0 sm:w-64' });
  fileSelect.addEventListener('change', () => openFile(fileSelect.value));

  const viewToggle = el(
    'div',
    {
      id: 'view-toggle',
      class: 'flex overflow-hidden rounded border border-ink-300',
      role: 'tablist',
    },
    [
      el(
        'button',
        { class: 'btn-sm', dataset: { view: 'visual' }, onclick: () => setView('visual') },
        ['Visual'],
      ),
      el(
        'button',
        { class: 'btn-sm', dataset: { view: 'source' }, onclick: () => setView('source') },
        ['Source'],
      ),
    ],
  );

  const zoomSelect = el('select', { class: 'field w-24 py-1 text-[12px]' });
  for (const [value, text] of [
    ['fit', 'Fit'],
    ['0.25', '25%'],
    ['0.5', '50%'],
    ['0.75', '75%'],
    ['1', '100%'],
  ]) {
    zoomSelect.append(el('option', { value }, [text]));
  }
  zoomSelect.addEventListener('change', () => {
    if (canvas) canvas.setZoom(zoomSelect.value);
  });

  addBar = el('div', { class: 'toolbar' }, [
    el('span', { class: 'text-[11px] uppercase tracking-wide text-ink-500' }, ['Add']),
    ...['text', 'barcode', 'image', 'box', 'line', 'field', 'date'].map((type) =>
      el(
        'button',
        {
          class: 'btn-secondary btn-sm capitalize',
          onclick: () => addElement(type),
        },
        [type],
      ),
    ),
  ]);

  // How the label is drawn -- rulers, grid, zoom -- shares a row under
  // the elements you can add to it.
  loadGridPreference();
  const rulerToggle = el('input', {
    type: 'checkbox',
    class: 'h-3.5 w-3.5 accent-ink-900',
    checked: editorGrid.rulers,
  });
  rulerToggle.addEventListener('change', () => {
    editorGrid.rulers = rulerToggle.checked;
    saveGridPreference();
    if (canvas) canvas.render();
  });
  const gridToggle = el('input', {
    type: 'checkbox',
    class: 'h-3.5 w-3.5 accent-ink-900',
    checked: editorGrid.on,
  });
  gridToggle.addEventListener('change', () => {
    editorGrid.on = gridToggle.checked;
    saveGridPreference();
    syncGridInput();
    if (canvas) canvas.render();
  });
  gridSizeInput = el('input', {
    class: 'field field-mono w-16',
    type: 'number',
    min: '0',
    title: 'Grid spacing',
  });
  gridSizeInput.addEventListener('change', () => {
    const dots = toDots(parseFloat(gridSizeInput.value), editorState.doc.unit);
    if (Number.isFinite(dots) && dots >= 1) {
      editorGrid.dots = Math.round(dots);
      saveGridPreference();
      if (canvas) canvas.render();
    }
    syncGridInput();
  });

  const zoomGroup = el('div', { class: 'ml-auto flex items-center gap-2' }, [
    el('label', { class: 'flex items-center gap-1.5 text-ink-600' }, [rulerToggle, 'Rulers']),
    el('label', { class: 'ml-2 flex items-center gap-1.5 text-ink-600' }, [gridToggle, 'Grid']),
    gridSizeInput,
    el('span', { class: 'text-[11px] text-ink-400' }),
    el('span', { class: 'ml-2 text-[11px] uppercase tracking-wide text-ink-500' }, ['Zoom']),
    zoomSelect,
  ]);
  viewBar = el('div', { class: 'toolbar' }, [zoomGroup]);

  editorHost = el('div', { class: EDITOR_HOST_CLASS.visual });
  inspectorHost = el('div');
  labelPanelHost = el('div');

  editorPreview = createPreview({ onPrint: () => printEditorLabel() });

  // Digits only, and never less than one: a keystroke that is not a
  // digit does not land, and an empty or zero box goes back to the count.
  editorCountInput = el('input', {
    class: 'field field-mono w-11 text-center',
    type: 'text',
    inputmode: 'numeric',
    maxlength: '3',
    autocomplete: 'off',
  });
  editorCountInput.addEventListener('input', () => {
    const digits = editorCountInput.value.replace(/\D+/g, '');
    if (digits !== editorCountInput.value) editorCountInput.value = digits;
  });
  editorCountInput.addEventListener('change', () => {
    const count = parseCopies(editorCountInput.value, editorState.doc.copies || 1);
    editorCountInput.value = String(count);
    if (count === editorState.doc.copies) return;
    editorState.doc.copies = count;
    markDirty();
  });
  editorCountInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') editorCountInput.blur();
  });

  // Editor, preview and properties sit side by side once there is room,
  // and stack in that order when there is not. Every column is min-w-0:
  // a grid item defaults to min-width:auto, so a wide child (the canvas,
  // a long file name) would otherwise push the whole page sideways.
  panel.append(
    el(
      'div',
      {
        class: 'grid gap-3 lg:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_21rem_21rem]',
      },
      [
        // self-start, or a grid item stretches to the tallest column and the
        // card keeps a band of white below the canvas whenever the label is
        // shorter than the rails beside it.
        el(
          'div',
          { class: 'card min-w-0 self-start overflow-hidden lg:col-span-2 xl:col-span-1' },
          [
            // Which label, and which view of it.
            el('div', { class: 'toolbar' }, [fileSelect, viewToggle]),
            // What to do with it: the file operations, then Print at the far end.
            el('div', { class: 'toolbar' }, [
              el('button', { class: 'btn-secondary btn-sm', onclick: () => newLabelDoc() }, [
                'New',
              ]),
              el(
                'button',
                { class: 'btn-secondary btn-sm', onclick: () => saveFile({ saveAs: false }) },
                ['Save'],
              ),
              el(
                'button',
                { class: 'btn-secondary btn-sm', onclick: () => saveFile({ saveAs: true }) },
                ['Save as…'],
              ),
              el('button', { class: 'btn-danger btn-sm', onclick: () => deleteCurrent() }, [
                'Delete',
              ]),
              el('label', { class: 'ml-auto flex items-center gap-1.5 text-ink-600' }, [
                'Count',
                editorCountInput,
              ]),
              el('button', { class: 'btn-primary btn-sm', onclick: () => printEditorLabel() }, [
                'Print',
              ]),
            ]),
            addBar,
            viewBar,
            editorHost,
          ],
        ),
        // Object properties sit immediately right of the designer, since
        // that is what you are looking at while you place things; the label
        // as a whole is set up once, so it stays in the far rail under the
        // preview. Two boxes, each saying what it governs.
        el('div', { class: 'card min-w-0 self-start overflow-hidden' }, [
          panelHeading('Object options', 'The selected element'),
          inspectorHost,
        ]),
        el('div', { class: 'min-w-0 space-y-3' }, [
          editorPreview.node,
          el('div', { class: 'card overflow-hidden' }, [
            panelHeading('Label options', 'Applies to the whole label'),
            labelPanelHost,
          ]),
        ]),
      ],
    ),
  );
  renderLabelPanel(labelPanelHost, { doc: editorState.doc, onChange: onDocChanged });
  rebuildEditorView();
  refreshFileList();
  refreshEditorPreview();
  drainPendingOpen();
}

/** Re-read the printer's file list whenever the tab comes back into view. */
export function onEditorShown() {
  refreshFileList();
  if (codeEditor) codeEditor.resize();
  if (canvas) canvas.render();
  drainPendingOpen();
}

/**
 * Open a stored label from another mode.
 *
 * The File System tab hands labels over this way. It may be called
 * before this mode has ever been mounted -- the tab switch that follows
 * is what mounts it -- so the request is parked until there is
 * something to open it into.
 */
export function openInEditor(file) {
  pendingOpen = file;
  if (editorHost) drainPendingOpen();
}

function drainPendingOpen() {
  const file = pendingOpen;
  if (!file) return;
  pendingOpen = null;
  refreshFileList();
  openFile(`${file.dev}:${file.oname}`);
}
