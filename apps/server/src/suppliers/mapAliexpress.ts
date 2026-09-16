import { SourceProduct } from '@conveyor/shared';
import { arr, int, minor, num, obj, optionValuesFor, pick, readAttributes, readProps, str } from './mapCommon.ts';
import { cleanImages, imagesFromHtml, stripHtml } from './cleanImages.ts';

/**
 * AliExpress DataHub `item_detail` → SourceProduct. Written against
 * fixtures/rapidapi/aliexpress-item.json; the fixture test pins the real fields.
 */
export function mapAliexpress(body: unknown, source: { itemId: string; url: string }): SourceProduct {
  const result = obj(pick(body, 'result')) ?? obj(body) ?? {};
  const item = obj(result.item) ?? result;
  const sku = obj(item.sku) ?? {};
  const props = readProps(sku.props ?? pick(item, 'skuProps', 'properties.sku'));
  const descriptionHtml = str(pick(item, 'description.html', 'descriptionHtml', 'desc')) ?? '';
  const descriptionImages = cleanImages([...arr(pick(item, 'description.images')).map(str), ...imagesFromHtml(descriptionHtml)]);

  const base = arr(sku.base ?? pick(item, 'skus', 'skuList'));
  const variants = base
    .map((b) => {
      const o = obj(b);
      if (!o) return null;
      const cost = minor(pick(o, 'promotionPrice', 'salePrice', 'discountPrice', 'price', 'skuPrice'));
      if (cost == null) return null;
      const stock = int(pick(o, 'quantity', 'stock', 'availQuantity'));
      const skuId = str(pick(o, 'skuId', 'id'));
      return { optionValues: optionValuesFor(props, pick(o, 'skuAttr', 'propMap', 'attr'), o.skuName), costMinor: cost, ...(stock != null ? { stock } : {}), ...(skuId ? { skuId } : {}) };
    })
    .filter((v): v is NonNullable<typeof v> => !!v);
  if (!variants.length) {
    const cost = minor(pick(sku, 'def.promotionPrice', 'def.price') ?? pick(item, 'price', 'salePrice'));
    if (cost != null) variants.push({ optionValues: [], costMinor: cost });
  }

  const currency = (str(pick(result, 'settings.currency', 'currency')) ?? 'USD').toUpperCase() === 'CNY' ? 'CNY' : 'USD';
  const options = props.map((p) => ({ name: p.name, values: p.values.map((v) => ({ label: v.label, ...(v.image ? { image: v.image } : {}) })) }));
  const optionImages = props.flatMap((p) => p.values.map((v) => v.image));

  return SourceProduct.parse({
    source: { platform: 'aliexpress', itemId: str(item.itemId) ?? source.itemId, url: source.url },
    title: str(item.title) ?? str(item.subject) ?? '',
    descriptionText: stripHtml(descriptionHtml),
    descriptionImages,
    images: cleanImages([...arr(item.images).map(str), ...arr(pick(item, 'imageList', 'imgs')).map(str), ...optionImages]),
    options,
    variants,
    currency,
    ...(num(item.moq) ? { moq: int(item.moq) } : {}),
    attributes: readAttributes(pick(item, 'properties.list', 'properties', 'attributes')),
  });
}
