// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Normalize an uploaded image to something the display renderer (resvg) reliably decodes.
 *
 * The display's SVG renderer picks its image decoder from the data-URI's MIME label, and
 * browsers set that label from the file *extension* — so a JPEG saved as "logo.png" arrives
 * labelled image/png, and resvg then fails to decode the mismatched bytes and draws nothing.
 * resvg also can't decode WebP at all.
 *
 * So: SVGs pass through untouched (vector, stays crisp); every raster image is drawn onto a
 * canvas and re-exported as a clean 8-bit PNG (optionally downscaled to `maxDim`). That
 * guarantees the bytes match the label and are in a format resvg supports — whatever the
 * original format or (mis)naming.
 */
export function readImageForUpload(file: File, maxDim = 1600): Promise<string> {
  const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    if (isSvg) {
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(file);
      return;
    }
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const longest = Math.max(img.naturalWidth, img.naturalHeight) || 1;
        const scale = Math.min(1, maxDim / longest);
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('Could not process that image.'));
        ctx.drawImage(img, 0, 0, w, h);
        try {
          resolve(canvas.toDataURL('image/png'));
        } catch {
          reject(new Error('Could not process that image.'));
        }
      };
      img.onerror = () => reject(new Error('That image couldn’t be read — please try a PNG or JPG.'));
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}
