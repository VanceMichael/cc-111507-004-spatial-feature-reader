/**
 * 要素几何与闭合矩形区域 [minX,minY,maxX,maxY] 的真实相交判断。
 * 约定（见 docs/来源格式.md）：平面米制坐标、无曲线；边界接触算相交；洞内不算。
 * 仅包围盒相交不会通过这里的判断，必须几何本身真正进入区域。
 */

const pointInClosedRect = (x, y, r) => x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY;

function onSegment(px, py, ax, ay, bx, by) {
  const cross = (px - ax) * (by - ay) - (py - ay) * (bx - ax);
  if (cross !== 0) return false;
  return Math.min(ax, bx) <= px && px <= Math.max(ax, bx)
    && Math.min(ay, by) <= py && py <= Math.max(ay, by);
}

/** 线段与闭合矩形是否相交，含端点接触与边界擦边。 */
function segmentIntersectsRect(ax, ay, bx, by, r) {
  if (pointInClosedRect(ax, ay, r) || pointInClosedRect(bx, by, r)) return true;
  const edges = [
    [r.minX, r.minY, r.maxX, r.minY],
    [r.maxX, r.minY, r.maxX, r.maxY],
    [r.maxX, r.maxY, r.minX, r.maxY],
    [r.minX, r.maxY, r.minX, r.minY],
  ];
  for (const [cx, cy, dx, dy] of edges) {
    if (segmentsCross(ax, ay, bx, by, cx, cy, dx, dy)) return true;
  }
  return false;
}

function segmentsCross(ax, ay, bx, by, cx, cy, dx, dy) {
  if (onSegment(ax, ay, cx, cy, dx, dy) || onSegment(bx, by, cx, cy, dx, dy)
    || onSegment(cx, cy, ax, ay, bx, by) || onSegment(dx, dy, ax, ay, bx, by)) {
    return true;
  }
  const orient = (px, py, qx, qy, sx, sy) => (qx - px) * (sy - py) - (qy - py) * (sx - px);
  const d1 = orient(cx, cy, dx, dy, ax, ay);
  const d2 = orient(cx, cy, dx, dy, bx, by);
  const d3 = orient(ax, ay, bx, by, cx, cy);
  const d4 = orient(ax, ay, bx, by, dx, dy);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
    && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** 点是否在环上或环内（环按闭合线串处理，首尾点相同）。 */
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (onSegment(x, y, xi, yi, xj, yj)) return true;
    const intersect = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/** 点是否落在多边形的实体内：外环之内且不在任何洞内；与洞边界接触也不算实体内部。 */
function pointInPolygonSolid(x, y, polygon) {
  const [outer, ...holes] = polygon;
  if (!pointInRing(x, y, outer)) return false;
  for (const hole of holes) {
    if (pointInRing(x, y, hole)) return false;
  }
  return true;
}

function lineIntersectsRect(line, r) {
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1];
    const [bx, by] = line[i];
    if (segmentIntersectsRect(ax, ay, bx, by, r)) return true;
  }
  return false;
}

/**
 * 多边形与闭合矩形相交：
 * 矩形任一角落在多边形实体（洞外）内、多边形任一顶点在矩形内（洞顶点不计）、
 * 或任一边与矩形边界相交。洞边界与矩形的接触不构成命中。
 */
function polygonIntersectsRect(polygon, r) {
  const corners = [
    [r.minX, r.minY], [r.maxX, r.minY], [r.maxX, r.maxY], [r.minX, r.maxY],
  ];
  if (corners.some(([x, y]) => pointInPolygonSolid(x, y, polygon))) return true;
  for (let ringIndex = 0; ringIndex < polygon.length; ringIndex++) {
    const ring = polygon[ringIndex];
    for (let i = 0; i < ring.length; i++) {
      const [x, y] = ring[i];
      if (ringIndex === 0 && pointInClosedRect(x, y, r)) return true;
    }
    // 洞环不参与边相交：洞内不算，洞边界接触同样不算。
    if (ringIndex === 0 && lineIntersectsRect(ring, r)) return true;
  }
  return false;
}

/**
 * 判断 GeoJSON 几何是否与闭合矩形真正相交。
 * 返回 null 表示遇到承诺范围外的几何类型，调用方应登记为不支持而非静默丢弃。
 */
export function geometryIntersectsRegion(geometry, region) {
  if (!geometry || typeof geometry !== 'object') return null;
  const r = { minX: region[0], minY: region[1], maxX: region[2], maxY: region[3] };
  switch (geometry.type) {
    case 'Point': {
      const [x, y] = geometry.coordinates;
      return pointInClosedRect(x, y, r);
    }
    case 'MultiPoint':
      return geometry.coordinates.some(([x, y]) => pointInClosedRect(x, y, r));
    case 'LineString':
      return lineIntersectsRect(geometry.coordinates, r);
    case 'MultiLineString':
      return geometry.coordinates.some(line => lineIntersectsRect(line, r));
    case 'Polygon':
      return polygonIntersectsRect(geometry.coordinates, r);
    case 'MultiPolygon':
      return geometry.coordinates.some(polygon => polygonIntersectsRect(polygon, r));
    default:
      return null;
  }
}

/** 给出可读的命中几何依据，便于运维核对边界与洞内情况。 */
export function hitBasis(geometry, region) {
  const r = { minX: region[0], minY: region[1], maxX: region[2], maxY: region[3] };
  const touches = (x, y) => pointInClosedRect(x, y, r)
    && (x === r.minX || x === r.maxX || y === r.minY || y === r.maxY);
  const basis = { geometryType: geometry?.type ?? null, relation: null, boundaryContact: false };
  const walk = (coords) => {
    if (!Array.isArray(coords) || coords.length === 0) return;
    if (typeof coords[0] === 'number') {
      if (coords.length >= 2 && touches(coords[0], coords[1])) basis.boundaryContact = true;
      return;
    }
    for (const item of coords) walk(item);
  };
  walk(geometry?.coordinates);
  switch (geometry?.type) {
    case 'Point':
    case 'MultiPoint':
      basis.relation = '点落在区域内（含边界接触）';
      break;
    case 'LineString':
    case 'MultiLineString':
      basis.relation = basis.boundaryContact ? '线与区域相交，含边界接触' : '线段穿过区域内部';
      break;
    case 'Polygon':
    case 'MultiPolygon':
      basis.relation = basis.boundaryContact ? '面与区域相交，含边界接触' : '面实体覆盖区域内部（洞内除外）';
      break;
    default:
      basis.relation = '未知几何关系';
  }
  return basis;
}
