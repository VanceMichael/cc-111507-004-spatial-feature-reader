import test from 'node:test';
import assert from 'node:assert/strict';
import { geometryIntersectsRegion } from '../src/geometry-filter.mjs';

const region = [0, 0, 10, 10];

test('点：区域内、边界接触与区域外区分清楚', () => {
  assert.equal(geometryIntersectsRegion({ type: 'Point', coordinates: [5, 5] }, region), true);
  assert.equal(geometryIntersectsRegion({ type: 'Point', coordinates: [0, 10] }, region), true);
  assert.equal(geometryIntersectsRegion({ type: 'Point', coordinates: [10, 0] }, region), true);
  assert.equal(geometryIntersectsRegion({ type: 'Point', coordinates: [-0.0001, 5] }, region), false);
  assert.equal(geometryIntersectsRegion({ type: 'Point', coordinates: [11, 5] }, region), false);
});

test('线：包围盒相交但几何不相交时不得混入', () => {
  // 线段 x+y=9（从(1,8)到(8,1)），区域 [0,0,2,2] 内最大和为 4，几何完全不进入
  const line = { type: 'LineString', coordinates: [[1, 8], [8, 1]] };
  assert.equal(geometryIntersectsRegion(line, [0, 0, 2, 2]), false);
  // 同一条线与 [0,0,10,10] 相交（端点在边界上）
  assert.equal(geometryIntersectsRegion(line, region), true);
  // 穿过区域内部
  assert.equal(geometryIntersectsRegion({ type: 'LineString', coordinates: [[-5, 5], [15, 5]] }, region), true);
  // 仅在角点接触也算相交
  assert.equal(geometryIntersectsRegion({ type: 'LineString', coordinates: [[-1, -1], [0, 0]] }, region), true);
});

test('面：矩形角落入面实体、顶点入区与边界擦边均可命中', () => {
  const polygon = { type: 'Polygon', coordinates: [[[5, -5], [15, -5], [15, 5], [5, 5], [5, -5]]] };
  assert.equal(geometryIntersectsRegion(polygon, region), true);
  const touching = { type: 'Polygon', coordinates: [[[10, 2], [12, 2], [12, 4], [10, 4], [10, 2]]] };
  assert.equal(geometryIntersectsRegion(touching, region), true);
  const outside = { type: 'Polygon', coordinates: [[[20, 20], [22, 20], [22, 22], [20, 22], [20, 20]]] };
  assert.equal(geometryIntersectsRegion(outside, region), false);
});

test('面：几何完全位于洞内不算相交，洞边界接触同样不算', () => {
  // 外环覆盖整个区域，中心挖洞 [4,4]-[6,6]
  const withHole = {
    type: 'Polygon',
    coordinates: [
      [[-1, -1], [11, -1], [11, 11], [-1, 11], [-1, -1]],
      [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
    ],
  };
  // 洞中心：区域四角仍在实体上，整体仍相交
  assert.equal(geometryIntersectsRegion(withHole, region), true);
  // 区域恰好等于洞：矩形四角都在洞内，洞边界接触不算
  assert.equal(geometryIntersectsRegion(withHole, [4, 4, 6, 6]), false);
  // 区域只覆盖洞内部一小块
  assert.equal(geometryIntersectsRegion(withHole, [4.5, 4.5, 5.5, 5.5]), false);
  // 区域跨越洞边界，部分落在实体上
  assert.equal(geometryIntersectsRegion(withHole, [5, 5, 7, 7]), true);
});

test('MultiPoint 与 MultiLineString 的逐元素判断', () => {
  const mp = { type: 'MultiPoint', coordinates: [[20, 20], [5, 5]] };
  assert.equal(geometryIntersectsRegion(mp, region), true);
  assert.equal(geometryIntersectsRegion({ type: 'MultiPoint', coordinates: [[20, 20]] }, region), false);
  const ml = { type: 'MultiLineString', coordinates: [[[20, 20], [21, 21]], [[-5, 5], [15, 5]]] };
  assert.equal(geometryIntersectsRegion(ml, region), true);
});

test('MultiPolygon：任一成员实体相交即可，洞成员不产生假命中', () => {
  const hit = {
    type: 'MultiPolygon',
    coordinates: [
      [[[20, 20], [22, 20], [22, 22], [20, 22], [20, 20]]],
      [[[-1, -1], [11, -1], [11, 11], [-1, 11], [-1, -1]]],
    ],
  };
  assert.equal(geometryIntersectsRegion(hit, region), true);
  const onlyHole = {
    type: 'MultiPolygon',
    coordinates: [
      [
        [[-1, -1], [11, -1], [11, 11], [-1, 11], [-1, -1]],
        [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
      ],
    ],
  };
  assert.equal(geometryIntersectsRegion(onlyHole, [4.2, 4.2, 5.8, 5.8]), false);
});

test('退化矩形（线/点状区域）按闭合边界处理', () => {
  const lineRegion = [5, 5, 5, 5];
  assert.equal(geometryIntersectsRegion({ type: 'Point', coordinates: [5, 5] }, lineRegion), true);
  assert.equal(geometryIntersectsRegion({ type: 'Point', coordinates: [5, 5.0001] }, lineRegion), false);
  const hLine = { type: 'LineString', coordinates: [[0, 5], [10, 5]] };
  assert.equal(geometryIntersectsRegion(hLine, [0, 5, 10, 5]), true);
});

test('承诺范围外的几何类型返回 null 而非静默判定', () => {
  assert.equal(geometryIntersectsRegion({ type: 'GeometryCollection', geometries: [] }, region), null);
  assert.equal(geometryIntersectsRegion(null, region), null);
});
