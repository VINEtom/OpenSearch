// EMR stores the head scan site as LocationSite:Head; search also accepts its display label.
export function normalizeLocalizationSite(value: string): string {
  const site = value.normalize('NFKC').trim();
  return site.toLowerCase() === 'head' ? '头部' : site;
}
