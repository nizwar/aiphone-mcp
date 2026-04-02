
import sharp from 'sharp';

/**
 * Resizes and compresses a raw image buffer.
 *
 * @param {Buffer} inputBuffer  - Raw image bytes (PNG from screencap)
 * @param {object} opts
 * @param {number} [opts.maxWidth=1080]     - Maximum output width in pixels
 * @param {number} [opts.maxHeight=1920]    - Maximum output height in pixels
 * @param {string} [opts.format='webp']     - Output format: 'webp' | 'jpeg' | 'png'
 * @param {number} [opts.quality=75]        - Compression quality 1–100 (ignored for png)
 * @returns {Promise<{ buffer: Buffer, format: string, width: number, height: number, originalBytes: number }>}
 */
export async function processScreenshot(inputBuffer, opts = {}) {
  const maxWidth = Math.max(1, Math.min(4096, Math.floor(opts.maxWidth ?? 1080)));
  const maxHeight = Math.max(1, Math.min(4096, Math.floor(opts.maxHeight ?? 1920)));
  const quality = Math.max(1, Math.min(100, Math.floor(opts.quality ?? 75)));
  const format = validateFormat(opts.format ?? 'webp');

  const originalBytes = inputBuffer.length;

  let pipeline = sharp(inputBuffer, { failOn: 'none' }).rotate();


  pipeline = pipeline.resize(maxWidth, maxHeight, {
    fit: 'inside',
    withoutEnlargement: true,
  });

  switch (format) {
    case 'webp':
      pipeline = pipeline.webp({ quality, effort: 4 });
      break;
    case 'jpeg':
    case 'jpg':
      pipeline = pipeline.jpeg({ quality, mozjpeg: true });
      break;
    case 'png':

      pipeline = pipeline.png({ compressionLevel: Math.round((100 - quality) / 11) });
      break;
  }

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });

  return {
    buffer: data,
    format: info.format,
    width: info.width,
    height: info.height,
    originalBytes,
  };
}

export function mimeType(format) {
  switch (format) {
    case 'jpeg':
    case 'jpg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'webp': return 'image/webp';
    default: return 'image/webp';
  }
}

function validateFormat(f) {
  const lower = String(f).toLowerCase();
  if (['webp', 'jpeg', 'jpg', 'png'].includes(lower)) return lower;
  throw new Error(`Unsupported image format "${f}". Use webp | jpeg | png.`);
}
