/**
 * Image link cleaning. String work only: no request is made.
 * - add `https:` to scheme-less links
 * - strip size suffixes (`_350x350xz.jpg`, `_50x50.jpg_`) and WebP suffixes (`.jpg_.webp`, `.png_.avif`)
 * - remove duplicates, keep order
 */
export function cleanImageUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (s.startsWith('//')) s = `https:${s}`;
  else if (/^http:\/\//i.test(s)) s = s.replace(/^http:/i, 'https:');
  else if (!/^https:\/\//i.test(s)) return null;
  // ".jpg_.webp", ".jpg_.avif", ".png_.webp", ".jpg_" → ".jpg"
  s = s.replace(/(\.(?:jpe?g|png|gif))_(?:\.(?:webp|avif))?$/i, '$1');
  s = s.replace(/(\.(?:jpe?g|png|gif))\.(?:webp|avif)$/i, '$1');
  // "S1.jpg_350x350xz.jpg", "S1.jpg_960x960q75.jpg", "O1.jpg_220x220.jpg", "O1.jpg.220x220.jpg", "S1_50x50.jpg"
  const sized = s.match(/^(.*?)[._]\d{2,4}x\d{2,4}(?:[a-z]{0,2}\d{0,3})?(\.(?:jpe?g|png|gif))$/i);
  if (sized) s = /\.(?:jpe?g|png|gif)$/i.test(sized[1]!) ? sized[1]! : `${sized[1]}${sized[2]}`;
  s = s.replace(/_(\.(?:jpe?g|png|gif))$/i, '$1');
  s = s.replace(/\?.*$/, '');
  return s;
}

export function cleanImages(urls: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const u of urls) {
    if (!u) continue;
    const c = cleanImageUrl(u);
    if (c && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

/** Small supplier versions for UI thumbnails, loaded directly in the browser. */
/** AliExpress and 1688 CDNs append the size after the full file name: `S1.jpg_220x220.jpg`. */
export function thumbnailUrl(clean: string, size = 220): string {
  const ext = clean.match(/\.(?:jpe?g|png|gif)$/i)?.[0] ?? '.jpg';
  return `${clean}_${size}x${size}${ext}`;
}

/** HTML to plain text for `descriptionText`. */
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

export function imagesFromHtml(html: string): string[] {
  return cleanImages([...html.matchAll(/<img[^>]+(?:src|data-src)=["']([^"']+)["']/gi)].map((m) => m[1]));
}
