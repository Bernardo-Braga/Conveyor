import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { META_SIZE, type Aspect } from '@conveyor/shared';

/**
 * The only type the Meta upload accepts (CLAUDE.md hard rule 7). A Buffer becomes one
 * only by passing through `finishCreative`, which re-encodes pixels and nothing else.
 */
export type FinishedJpeg = Buffer & { readonly __brand: 'FinishedJpeg' };

export type DetectedFormat = 'png' | 'jpeg' | 'webp' | 'gif' | 'heif' | 'tiff' | 'unknown';

/** Reads the format from the bytes, never the name: engines return PNG behind other extensions. */
export function detectFormat(buf: Buffer): DetectedFormat {
  if (buf.length < 12) return 'unknown';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a') return 'gif';
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') return 'heif';
  if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) || (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)) return 'tiff';
  return 'unknown';
}

export interface Finished {
  jpeg: FinishedJpeg;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  sourceFormat: DetectedFormat;
  /** The input's own pixel size, before the crop. Null when sharp could not read it. */
  sourceWidth: number | null;
  sourceHeight: number | null;
}

/**
 * PLAN.md section 8: rotate, crop to the Meta frame with attention-based placement, flatten
 * onto white, encode JPEG at the given quality with 4:4:4 chroma. No `keepMetadata()`, so
 * EXIF, XMP, IPTC, ICC and C2PA are all gone. Verified again on the output before it is returned.
 */
export async function finishCreative(input: Buffer, aspect: Aspect, quality = 90): Promise<Finished> {
  const sourceFormat = detectFormat(input);
  if (sourceFormat === 'unknown') throw new Error('The engine output is not an image format sharp can read.');
  const [width, height] = META_SIZE[aspect];
  const source = await sharp(input, { failOn: 'error' }).metadata();
  const jpeg = await sharp(input, { failOn: 'error' })
    .rotate()
    .resize(width, height, { fit: 'cover', position: sharp.strategy.attention })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality, chromaSubsampling: '4:4:4', mozjpeg: false })
    .toBuffer();
  if (jpeg.readUInt32BE(0) >>> 8 !== 0xffd8ff) throw new Error('Finished file is not a JPEG');
  const m = await sharp(jpeg).metadata();
  if (m.width !== width || m.height !== height) throw new Error(`Wrong size: ${m.width}×${m.height}, wanted ${width}×${height}`);
  if (m.exif || m.xmp || m.iptc || m.icc) throw new Error('Metadata left in finished file');
  return { jpeg: jpeg as FinishedJpeg, width, height, bytes: jpeg.length, sha256: createHash('sha256').update(jpeg).digest('hex'), sourceFormat, sourceWidth: source.width ?? null, sourceHeight: source.height ?? null };
}
