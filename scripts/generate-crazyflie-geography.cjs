const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const [admin1Path, worldPath] = process.argv.slice(2);
assert.ok(admin1Path && worldPath, 'Usage: node scripts\\generate-crazyflie-geography.cjs <admin1.geojson> <world.geojson>');
const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8')).features;
const subdivisions = read(admin1Path);
const countries = read(worldPath);
const polygons = geometry => geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
function distance(point, from, to) {
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const t = dx || dy ? Math.max(0, Math.min(1, ((point[0] - from[0]) * dx + (point[1] - from[1]) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(point[0] - from[0] - t * dx, point[1] - from[1] - t * dy);
}
function simplifyLine(points, tolerance) {
  if (points.length <= 2) return points;
  let max = tolerance, index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = distance(points[i], points[0], points.at(-1));
    if (d > max) { max = d; index = i; }
  }
  return index ? [...simplifyLine(points.slice(0, index + 1), tolerance).slice(0, -1), ...simplifyLine(points.slice(index), tolerance)]
    : [points[0], points.at(-1)];
}
function simplifyRing(ring, tolerance) {
  const points = ring.map(point => point.map(value => Math.round(value * 100000) / 100000));
  let farthest = 1;
  for (let i = 2; i < points.length - 1; i++) {
    if (Math.hypot(points[i][0] - points[0][0], points[i][1] - points[0][1])
      > Math.hypot(points[farthest][0] - points[0][0], points[farthest][1] - points[0][1])) farthest = i;
  }
  const reduced = [...simplifyLine(points.slice(0, farthest + 1), tolerance).slice(0, -1),
    ...simplifyLine(points.slice(farthest), tolerance)];
  return reduced.length >= 4 ? reduced : points;
}
function insideRing(ring, point) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x, y] = ring[i], [xx, yy] = ring[j];
    if ((y > point[1]) !== (yy > point[1]) && point[0] < (xx - x) * (point[1] - y) / (yy - y) + x) inside = !inside;
  }
  return inside;
}
const inside = (polys, point) => polys.some(rings => insideRing(rings[0], point) && !rings.slice(1).some(ring => insideRing(ring, point)));
function center(polys, preferred) {
  if (preferred.every(Number.isFinite) && inside(polys, preferred)) return preferred;
  let best, clearance = -1;
  for (const rings of polys) {
    const xs = rings[0].map(point => point[0]), ys = rings[0].map(point => point[1]);
    const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
    for (let row = 0; row < 20; row++) for (let col = 0; col < 20; col++) {
      const point = [left + (col + 0.5) / 20 * (right - left), top + (row + 0.5) / 20 * (bottom - top)];
      if (!inside([rings], point)) continue;
      let nearest = Infinity;
      for (const ring of rings) for (let i = 1; i < ring.length; i++) nearest = Math.min(nearest, distance(point, ring[i - 1], ring[i]));
      if (nearest > clearance) { clearance = nearest; best = point; }
    }
  }
  assert.ok(best, 'A map region has no interior target');
  return best.map(value => Math.round(value * 100000) / 100000);
}
function region(code, name, nameZh, geometry, preferred, tolerance) {
  assert.ok(code && name && nameZh && geometry.length);
  const simplified = geometry.map(rings => rings.map(ring => simplifyRing(ring, tolerance)));
  const target = center(simplified, preferred);
  assert.ok(inside(simplified, target), `${code}: target is outside its region`);
  return { code, name, nameZh, center: target, polygons: simplified };
}
const china = subdivisions.filter(feature => feature.properties.adm0_a3 === 'CHN' && feature.properties.iso_3166_2 !== 'CN-X01~')
  .map(feature => {
    const p = feature.properties;
    return region(p.iso_3166_2, p.name, p.name_zh, polygons(feature.geometry), [p.longitude, p.latitude], 0.015);
  });
for (const [admin, code, name, nameZh] of [
  ['TWN', 'CN-TW', 'Taiwan Province', '台湾省'], ['HKG', 'CN-HK', 'Hong Kong', '香港特别行政区'],
  ['MAC', 'CN-MO', 'Macao', '澳门特别行政区'],
]) {
  const feature = countries.find(feature => feature.properties.ADM0_A3 === admin);
  assert.ok(feature, admin);
  china.push(region(code, name, nameZh, polygons(feature.geometry), [feature.properties.LABEL_X, feature.properties.LABEL_Y], 0.001));
}
for (const feature of subdivisions.filter(feature => feature.properties.iso_3166_2 === 'CN-X01~')) {
  china.find(region => region.code === 'CN-HI').polygons.push(...polygons(feature.geometry).map(rings => rings.map(ring => simplifyRing(ring, 0.001))));
}
assert.equal(china.length, 34);
assert.equal(new Set(china.map(region => region.code)).size, 34);
const world = countries.filter(feature => !['TWN', 'HKG', 'MAC'].includes(feature.properties.ADM0_A3)).map(feature => {
  const p = feature.properties;
  const geometry = polygons(feature.geometry);
  if (p.ADM0_A3 === 'CHN') {
    for (const part of countries.filter(feature => ['TWN', 'HKG', 'MAC'].includes(feature.properties.ADM0_A3))) geometry.push(...polygons(part.geometry));
  }
  const iso2 = p.ADM0_A3 === p.ISO_A3_EH && /^[A-Z]{2}$/.test(p.ISO_A2_EH) ? p.ISO_A2_EH : '';
  return { ...region(p.ADM0_A3, p.NAME_LONG, p.NAME_ZH || p.NAME_LONG, geometry, [p.LABEL_X, p.LABEL_Y], 0.035), iso2 };
});
assert.ok(world.length > 230);
assert.equal(new Set(world.map(region => region.code)).size, world.length);
const source = {
  name: 'Natural Earth', license: 'Public domain', licenseUrl: 'https://www.naturalearthdata.com/about/terms-of-use/',
  files: [
    { url: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson',
      sha256: createHash('sha256').update(fs.readFileSync(admin1Path)).digest('hex') },
    { url: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson',
      sha256: createHash('sha256').update(fs.readFileSync(worldPath)).digest('hex') },
  ],
};
const output = path.join(__dirname, '..', 'src', 'app', 'services', 'data', 'crazyflie-geography.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify({ source, china, world })}\n`);
console.log(`Generated ${china.length} provinces and ${world.length} countries/regions (${fs.statSync(output).size} bytes)`);
