import { SourceProduct } from '@conveyor/shared';
import { arr, int, lowestPrice, minor, obj, optionValuesFor, pick, readAttributes, readProps, str } from './mapCommon.ts';
import { cleanImages, imagesFromHtml, stripHtml } from './cleanImages.ts';

/**
 * 1688 DataHub `item_detail` → SourceProduct (CNY). Titles and option names stay Chinese;
 * the listing step translates them. The single-unit price tier is the cost; the agent fee and
 * shipping estimate are added by pricing in phase 3. Written against fixtures/rapidapi/1688-item.json.
 */
export function map1688(body: unknown, source: { itemId: string; url: string }): SourceProduct {
  const result = obj(pick(body, 'result')) ?? obj(body) ?? {};
  const item = obj(result.item) ?? result;
  const sku = obj(item.sku) ?? {};
  const props = readProps(sku.props ?? pick(item, 'skuProps', 'attrs'));
  const descriptionHtml = str(pick(item, 'description.html', 'descriptionHtml', 'desc', 'detailHtml')) ?? '';
  const descriptionImages = cleanImages([...arr(pick(item, 'description.images', 'descImages')).map(str), ...imagesFromHtml(descriptionHtml)]);

  // Price tiers: [{ beginAmount|minQty|begin, price }] on the item or under sku.def.
  const tierSrc = arr(pick(item, 'priceRange', 'priceRanges', 'priceTiers', 'sku.def.priceRange', 'sku.priceRange', 'skuPriceRange', 'sku.def.priceList', 'priceList'));
  let priceTiers = tierSrc
    .map((t) => {
      if (Array.isArray(t) && t.length >= 2) {
        const minQty = int(t[0]);
        const priceMinor = minor(t[1]);
        return minQty && priceMinor != null ? { minQty, priceMinor } : null;
      }
      const o = obj(t);
      if (!o) return null;
      const minQty = int(pick(o, 'beginAmount', 'minQty', 'begin', 'startQuantity', 'quantity', 'min'));
      const priceMinor = minor(pick(o, 'price', 'unitPrice'));
      return minQty && priceMinor != null ? { minQty, priceMinor } : null;
    })
    .filter((t): t is { minQty: number; priceMinor: number } => !!t)
    .sort((a, b) => a.minQty - b.minQty);
  const moq = int(pick(item, 'moq', 'minOrder', 'minOrderQuantity', 'sku.def.moq', 'saleInfo.minOrderQuantity')) ?? priceTiers[0]?.minQty ?? null;

  const base = arr(sku.base ?? pick(item, 'skus', 'skuList'));
  const variants = base
    .map((b) => {
      const o = obj(b);
      if (!o) return null;
      const cost = minor(pick(o, 'promotionPrice', 'discountPrice', 'price', 'skuPrice', 'consignPrice')) ?? priceTiers[0]?.priceMinor ?? null;
      if (cost == null) return null;
      const stock = int(pick(o, 'quantity', 'stock', 'canBookCount', 'amountOnSale'));
      const skuId = str(pick(o, 'skuId', 'specId', 'id'));
      return { optionValues: optionValuesFor(props, pick(o, 'skuAttr', 'propMap', 'attr', 'specAttrs'), o.skuName), costMinor: cost, ...(stock != null ? { stock } : {}), ...(skuId ? { skuId } : {}) };
    })
    .filter((v): v is NonNullable<typeof v> => !!v);
  if (!variants.length) {
    const single = priceTiers[0]?.priceMinor ?? minor(lowestPrice(pick(item, 'price', 'sku.def.price', 'sku.def.promotionPrice', 'priceInfo.price', 'referencePrice')));
    if (single != null) variants.push({ optionValues: [], costMinor: single });
  }
  if (!priceTiers.length && variants.length) priceTiers = [{ minQty: moq ?? 1, priceMinor: Math.min(...variants.map((v) => v.costMinor)) }];

  return SourceProduct.parse({
    source: { platform: '1688', itemId: str(item.itemId) ?? str(item.offerId) ?? source.itemId, url: source.url },
    title: str(item.title) ?? str(item.subject) ?? '',
    descriptionText: stripHtml(descriptionHtml),
    descriptionImages,
    images: cleanImages([...arr(item.images).map(str), ...arr(pick(item, 'imageList', 'imgs', 'mainImages')).map(str), ...props.flatMap((p) => p.values.map((v) => v.image))]),
    options: props.map((p) => ({ name: p.name, values: p.values.map((v) => ({ label: v.label, ...(v.image ? { image: v.image } : {}) })) })),
    variants,
    currency: 'CNY',
    priceTiers,
    ...(moq ? { moq } : {}),
    attributes: readAttributes(pick(item, 'properties.list', 'properties', 'attributes', 'attrs')),
  });
}
