/*
 * Monochrome Unicorn -- a web app for Zebra thermal printers.
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
 * unpack.js -- the packed page's first script.
 *
 * The styles, the settings catalogue, htmx and the app arrive gzipped,
 * in base64, in <script id="packed"> (tools/build.mjs packPayload): about
 * a third of their size, and page weight is what the printer's web server
 * is slow at. This unpacks them with the browser's own DecompressionStream
 * and puts each where the unpacked page has it. Plain ES5, inlined as it
 * is, and only in the packed build (build.mjs --packed); the default,
 * unpacked page has no need of it.
 */

(function () {
  var root = document.documentElement;
  if (!window.DecompressionStream) {
    root.classList.remove('unpacking');
    throw new Error(
      'This browser cannot unpack the console (it has no DecompressionStream). ' +
        'Open it in a current Chrome, Edge, Firefox or Safari.',
    );
  }
  var packed = document.getElementById('packed');
  var binary = atob(packed.textContent.replace(/\s+/g, ''));
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  var text = new Response(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
  ).text();
  // htmx starts on DOMContentLoaded, or at once if the page has finished
  // loading; run between the two, it would wait for an event already gone.
  var loaded = new Promise(function (resolve) {
    if (document.readyState === 'complete') resolve();
    else window.addEventListener('load', resolve, { once: true });
  });
  Promise.all([text, loaded]).then(function (results) {
    var parts = JSON.parse(results[0]);
    var style = document.createElement('style');
    style.textContent = parts.css;
    document.head.appendChild(style);
    var schema = document.createElement('script');
    schema.type = 'application/json';
    schema.id = 'sgd-schema';
    schema.textContent = parts.schema;
    document.body.appendChild(schema);
    [parts.htmx, parts.app].forEach(function (code) {
      var script = document.createElement('script');
      script.textContent = code;
      document.body.appendChild(script);
    });
    packed.remove();
    root.classList.remove('unpacking');
  });
})();
