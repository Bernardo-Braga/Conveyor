import { describe, expect, it } from 'vitest';
import { cleanImageUrl, cleanImages, imagesFromHtml, stripHtml, thumbnailUrl } from '../src/suppliers/cleanImages.ts';

describe('cleanImageUrl', () => {
  it('adds https to scheme-less links', () => {
    expect(cleanImageUrl('//ae-pic-a1.aliexpress-media.com/kf/S1.jpg')).toBe('https://ae-pic-a1.aliexpress-media.com/kf/S1.jpg');
    expect(cleanImageUrl('http://cbu01.alicdn.com/img/ibank/x.jpg')).toBe('https://cbu01.alicdn.com/img/ibank/x.jpg');
  });
  it('strips size and WebP suffixes', () => {
    expect(cleanImageUrl('https://ae01.alicdn.com/kf/S1.jpg_350x350xz.jpg')).toBe('https://ae01.alicdn.com/kf/S1.jpg');
    expect(cleanImageUrl('https://ae01.alicdn.com/kf/S1.jpg_960x960q75.jpg_.webp')).toBe('https://ae01.alicdn.com/kf/S1.jpg');
    expect(cleanImageUrl('https://ae01.alicdn.com/kf/S1.jpg_.webp')).toBe('https://ae01.alicdn.com/kf/S1.jpg');
    expect(cleanImageUrl('https://ae01.alicdn.com/kf/S1.png_50x50.png_.avif')).toBe('https://ae01.alicdn.com/kf/S1.png');
    expect(cleanImageUrl('https://cbu01.alicdn.com/img/ibank/O1CN01.jpg_220x220.jpg')).toBe('https://cbu01.alicdn.com/img/ibank/O1CN01.jpg');
    expect(cleanImageUrl('https://cbu01.alicdn.com/img/ibank/O1CN01.jpg.220x220.jpg')).toBe('https://cbu01.alicdn.com/img/ibank/O1CN01.jpg');
    expect(cleanImageUrl('https://ae01.alicdn.com/kf/S1.jpg?x=1')).toBe('https://ae01.alicdn.com/kf/S1.jpg');
  });
  it('rejects junk', () => {
    expect(cleanImageUrl('')).toBeNull();
    expect(cleanImageUrl('data:image/png;base64,AAAA')).toBeNull();
  });
});

describe('cleanImages', () => {
  it('de-duplicates after cleaning and keeps order', () => {
    expect(cleanImages(['//a.com/1.jpg_350x350.jpg', 'https://a.com/1.jpg', null, 'https://a.com/2.jpg_.webp', 'https://a.com/1.jpg_.webp'])).toEqual(['https://a.com/1.jpg', 'https://a.com/2.jpg']);
  });
  it('makes small thumbnails for the browser', () => {
    expect(thumbnailUrl('https://a.com/1.jpg')).toBe('https://a.com/1.jpg_220x220.jpg');
  });
});

describe('stripHtml and imagesFromHtml', () => {
  it('turns description HTML into text and image links', () => {
    const html = `<div><p>Hello&nbsp;<b>world</b></p><img src="//a.com/d1.jpg_.webp"><img data-src="https://a.com/d1.jpg"><br>Line 2<script>x()</script></div>`;
    expect(stripHtml(html)).toBe('Hello world\nLine 2');
    expect(imagesFromHtml(html)).toEqual(['https://a.com/d1.jpg']);
  });
});
