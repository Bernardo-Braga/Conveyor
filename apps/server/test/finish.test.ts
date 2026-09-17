import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { ASPECTS, META_SIZE } from '@conveyor/shared';
import { ALLOWED_GROUPS, exiftoolAvailable, exiftoolClean, exiftoolGroups } from '../src/images/exiftool.ts';
import { detectFormat, finishCreative } from '../src/images/finish.ts';
import { finishedFileName } from '../src/images/store.ts';
import { FIXTURES } from './helpers.ts';

const ORIGINALS = ['codex-mug.png', 'codex-mug-webp-named.webp'].map((f) => path.join(FIXTURES, 'images', f));
const haveExiftool = await exiftoolAvailable();

describe('detectFormat', () => {
  it('reads the bytes, not the name', () => {
    expect(detectFormat(fs.readFileSync(ORIGINALS[0]!))).toBe('png');
    expect(detectFormat(fs.readFileSync(ORIGINALS[1]!))).toBe('png');
    expect(detectFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('jpeg');
    expect(detectFormat(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))).toBe('webp');
    expect(detectFormat(Buffer.from('hello world!'))).toBe('unknown');
  });
});

describe('finishCreative', () => {
  it('the raw engine PNG carries C2PA metadata that must not survive', async () => {
    if (!haveExiftool) return;
    const groups = await exiftoolGroups(ORIGINALS[0]!);
    expect(groups.some((g) => !ALLOWED_GROUPS.has(g))).toBe(true); // PNG, JUMBF, CBOR…
  });

  for (const original of ORIGINALS) {
    for (const aspect of ASPECTS) {
      it(`${path.basename(original)} → ${aspect}: exact size, JPEG, 4:4:4, no metadata${haveExiftool ? ', exiftool clean' : ''}`, async () => {
        const input = fs.readFileSync(original);
        const out = await finishCreative(input, aspect, 90);
        const [w, h] = META_SIZE[aspect];
        expect([out.width, out.height]).toEqual([w, h]);
        expect(out.jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
        expect(out.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(out.bytes).toBe(out.jpeg.length);
        expect(out.sourceFormat).toBe('png');

        const meta = await sharp(out.jpeg).metadata();
        expect(meta.format).toBe('jpeg');
        expect(meta.chromaSubsampling).toBe('4:4:4');
        expect(meta.exif ?? meta.xmp ?? meta.iptc ?? meta.icc).toBeUndefined();

        if (haveExiftool) {
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conveyor-finish-'));
          const file = path.join(dir, finishedFileName('linen-blazer', aspect, 1));
          fs.writeFileSync(file, out.jpeg);
          const check = await exiftoolClean(file);
          expect(check.ok, JSON.stringify(check)).toBe(true);
          for (const g of check.groups) expect(ALLOWED_GROUPS.has(g), `group ${g}`).toBe(true);
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }

  it('rejects bytes that are not an image', async () => {
    await expect(finishCreative(Buffer.from('not an image at all'), '1:1')).rejects.toThrow(/not an image/);
  });

  it('names finished files {handle}_{4x5}_{NN}.jpg', () => {
    expect(finishedFileName('Linen Blazer!', '4:5', 3)).toBe('linen-blazer_4x5_03.jpg');
    expect(finishedFileName('soft-sole-slip-on-loafers-for-men', '9:16', 12)).toBe('soft-sole-slip-on-loafers-for-men_9x16_12.jpg');
  });
});
