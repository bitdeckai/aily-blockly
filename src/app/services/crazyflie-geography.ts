import data from './data/crazyflie-geography.json';

export type GeographyMapId = 'china' | 'world';
export interface GeographyRegion {
  readonly code: string;
  readonly name: string;
  readonly nameZh: string;
  readonly iso2?: string;
  readonly center: readonly number[];
  readonly polygons: readonly (readonly (readonly (readonly number[])[])[])[];
}

export const GEOGRAPHY_MAPS: Readonly<Record<GeographyMapId, readonly GeographyRegion[]>> = {
  china: data.china, world: data.world,
};
const displayNames = new Map<string, Intl.DisplayNames>();

export function geographyPosition(map: GeographyMapId, longitude: number, latitude: number): { x: number; z: number } {
  return map === 'china' ? { x: (longitude - 105) * 0.65, z: -(latitude - 35) * 0.65 }
    : { x: longitude * 0.2, z: -latitude * 0.2 };
}

export function geographyRegionName(region: GeographyRegion, locale: string): string {
  const language = locale.replace('_', '-');
  if (language.toLowerCase().startsWith('zh')) return region.nameZh;
  if (region.iso2) {
    let names = displayNames.get(language);
    if (!names) {
      names = new Intl.DisplayNames([language], { type: 'region' });
      displayNames.set(language, names);
    }
    return names.of(region.iso2) ?? region.name;
  }
  return region.name;
}
