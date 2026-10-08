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
 * imageprep.js -- turn a picture the user picked into something the
 * printer can store.
 *
 * A thermal printer prints one colour, so whatever comes in has to end
 * up as one bit per pixel. That conversion happens here, in the browser,
 * because the upload channel is a urlencoded form field: the payload has
 * to be printable ASCII, and ~DY's hex form (b=A) of a .GRF is exactly
 * that. Sending a PNG through the same route stores nothing.
 */

/** GRF rows are padded to whole bytes. */
export function bytesPerRow(width) {
  return Math.ceil(width / 8);
}

/** Decode a File into an ImageBitmap-ish source we can draw. */
export function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file is not an image the browser can read'));
    };
    img.src = url;
  });
}

/**
 * Draw the image at the requested dot size and return its greyscale
 * samples, 0 (black) to 255 (white). Transparency is composited onto
 * white, since unprinted media is white.
 */
export function toGrayscale(img, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  const { data } = ctx.getImageData(0, 0, width, height);
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    // Rec. 601 luma, which matches how the eye weights the channels.
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return gray;
}

/**
 * Reduce greyscale to one bit.
 *
 * Plain thresholding is right for line art and logos, which are already
 * two-tone and would only be muddied by dithering. Floyd-Steinberg is
 * right for photographs, where it trades spatial detail for apparent
 * greys. Neither is a good default for the other, so the caller picks.
 */
export function toBilevel(gray, width, height, { dither = true, threshold = 128 } = {}) {
  const bits = new Uint8Array(width * height);
  const buffer = dither ? Float32Array.from(gray) : gray;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const old = buffer[i];
      const black = old < threshold;
      bits[i] = black ? 1 : 0;

      if (!dither) continue;
      // Push the rounding error onto the neighbours not yet visited.
      const error = old - (black ? 0 : 255);
      if (x + 1 < width) buffer[i + 1] += (error * 7) / 16;
      if (y + 1 < height) {
        if (x > 0) buffer[i + width - 1] += (error * 3) / 16;
        buffer[i + width] += (error * 5) / 16;
        if (x + 1 < width) buffer[i + width + 1] += (error * 1) / 16;
      }
    }
  }
  return bits;
}

/** Pack one-bit samples into GRF rows. A set bit is a printed dot. */
export function packGrf(bits, width, height) {
  const stride = bytesPerRow(width);
  const bytes = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!bits[y * width + x]) continue;
      bytes[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return bytes;
}

/** Uppercase hex, which is what ~DY's ASCII form expects. */
export function toHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).toUpperCase().padStart(2, '0');
  return out;
}

/**
 * Full conversion. Returns everything uploadGraphic needs, plus a data
 * URL of the result so the user can see what they are about to send.
 */
export function prepareGraphic(img, width, height, options) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));

  const gray = toGrayscale(img, w, h);
  const bits = toBilevel(gray, w, h, options);
  const bytes = packGrf(bits, w, h);

  return {
    width: w,
    height: h,
    bytesPerRow: bytesPerRow(w),
    totalBytes: bytes.length,
    hex: toHex(bytes),
    preview: previewUrl(bits, w, h),
  };
}

/** Render the one-bit result to a canvas so it can be shown as-is. */
function previewUrl(bits, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(width, height);
  for (let i = 0; i < bits.length; i++) {
    const v = bits[i] ? 0 : 255;
    image.data[i * 4] = v;
    image.data[i * 4 + 1] = v;
    image.data[i * 4 + 2] = v;
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

/**
 * A legal object name from a filename: upper case, no extension, and
 * short enough for the printer's directory.
 */
export function objectNameFrom(filename) {
  const stem = String(filename).replace(/\.[^.]*$/, '');
  const clean = stem
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .replace(/^_+/, '');
  return (clean || 'IMAGE').slice(0, 16);
}
