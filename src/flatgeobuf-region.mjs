import * as flatbuffers from 'flatbuffers';
import { Feature } from 'flatgeobuf/lib/mjs/flat-geobuf/feature.js';
import { fromByteBuffer } from 'flatgeobuf/lib/mjs/header-meta.js';
import { fromFeature } from 'flatgeobuf/lib/mjs/geojson/feature.js';
import { magicbytes, SIZE_PREFIX_LEN } from 'flatgeobuf/lib/mjs/constants.js';
import { calcTreeSize, streamSearch } from 'flatgeobuf/lib/mjs/packedrtree.js';
import { RangeClient, SourceVersionError, SourceRangeError } from './range-client.mjs';
import { geometryIntersectsRegion, hitBasis } from './geometry-filter.mjs';

const HEADER_PREFIX_OFFSET = magicbytes.length; // 8：4 字节头长度前缀起点
const HEADER_DATA_OFFSET = HEADER_PREFIX_OFFSET + SIZE_PREFIX_LEN; // 12：FlatBuffers header 起点

export function validateRegion(region) {
  if (!Array.isArray(region) || region.length !== 4
    || region.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
    return 'region 必须是四个有限数字组成的闭合矩形 [minX,minY,maxX,maxY]';
  }
  const [minX, minY, maxX, maxY] = region;
  if (minX > maxX || minY > maxY) return 'region 的最小值不得大于最大值';
  return null;
}

function decodeFeature(bytes, header) {
  const bb = new flatbuffers.ByteBuffer(new Uint8Array(bytes));
  bb.setPosition(SIZE_PREFIX_LEN);
  const feature = Feature.getRootAsFeature(bb);
  return fromFeature(null, feature, header);
}

/** 读取一个长度前缀要素：先读 4 字节长度，再读要素体，组合成 size-prefixed 缓冲。 */
async function readLengthPrefixedFeature(client, featureOffset) {
  const prefix = await client.getRange(featureOffset, SIZE_PREFIX_LEN, 'feature-length');
  if (prefix.length < SIZE_PREFIX_LEN) throw new SourceRangeError('要素长度前缀被截断');
  const bodyLength = prefix.readUInt32LE(0);
  if (bodyLength === 0) throw new SourceRangeError('要素体长度为零，无法解释该记录');
  const body = await client.getRange(featureOffset + SIZE_PREFIX_LEN, bodyLength, 'feature-data');
  if (body.length < bodyLength) throw new SourceRangeError('要素体被截断');
  const framed = Buffer.allocUnsafe(SIZE_PREFIX_LEN + bodyLength);
  prefix.copy(framed, 0);
  body.copy(framed, SIZE_PREFIX_LEN);
  return { framed, bodyLength };
}

function summarizeRequests(client) {
  return client.requests.map(item => ({ ...item }));
}

/**
 * 按区域采集 FlatGeobuf 子集。
 * 返回 state/records/issues/coverage/evidence，不直接落盘，由 receiver 决定持久化。
 */
export async function collectRegion({ url, region, store, limit }) {
  const client = new RangeClient(url, { limit });
  const issues = [];
  const records = [];
  const blobs = [];
  const seenBlobs = new Set();

  const persistBlob = async (bytes, role) => {
    const blob = await store.blob(bytes);
    if (!seenBlobs.has(blob.digest)) {
      seenBlobs.add(blob.digest);
      blobs.push({ ...blob, role });
    }
    return blob;
  };

  const reject = (code, message, extra = {}) => ({
    state: 'rejected', records, issues: [...issues, { code, message, ...extra }],
    coverage: buildCoverage(), evidence: buildEvidence(),
  });
  const buildCoverage = () => ({
    structured: true,
    region,
    strategy: coverageStrategy,
    indexPruned: headerInfo?.indexNodeSize > 0,
    indexNodeSize: headerInfo?.indexNodeSize ?? null,
    rangeSupported: client.rangeSupported,
    fullFileBuffered: client.fullFileBuffered,
    featuresTotal: headerInfo?.featuresCount ?? null,
    candidatesExamined: examined,
    matched: records.length,
    requestCount: client.requests.length,
    transferredBytes: client.requests.reduce((sum, item) => sum + item.transferredBytes, 0),
    distinctBytesPersisted: blobs.reduce((sum, item) => sum + item.bytes, 0),
    fileSize: client.fileSize,
  });

  const buildEvidence = () => ({
    sourceUrl: url,
    etag: client.etag,
    requests: summarizeRequests(client),
    blobs,
  });

  let headerInfo = null;
  let coverageStrategy = null;
  let examined = 0;

  try {
    // 1. magic + 头长度（12 字节），同时确定远端是否真正支持 Range。
    const lead = await client.getRange(0, HEADER_DATA_OFFSET, 'magic-and-header-length');
    await persistBlob(lead, 'lead');
    if (!magicbytes.every((byte, index) => lead[index] === byte)) {
      return reject('not-flatgeobuf', '文件魔数与 FlatGeobuf 3.x 不符，无法解释');
    }
    const headerLength = lead.readUInt32LE(HEADER_PREFIX_OFFSET);
    if (headerLength < 8 || headerLength > 0xa00000) {
      return reject('invalid-header', `header 长度 ${headerLength} 超出可解释范围`);
    }

    // 2. FlatBuffers header。
    const headerBytes = await client.getRange(HEADER_DATA_OFFSET, headerLength, 'header');
    if (headerBytes.length < headerLength) throw new SourceRangeError('header 被截断');
    await persistBlob(headerBytes, 'header');
    const bb = new flatbuffers.ByteBuffer(new Uint8Array(headerBytes));
    headerInfo = fromByteBuffer(bb);
    const { featuresCount, indexNodeSize } = headerInfo;

    const indexLength = indexNodeSize > 0 ? calcTreeSize(featuresCount, indexNodeSize) : 0;
    const indexStart = HEADER_DATA_OFFSET + headerLength;
    const featuresStart = indexStart + indexLength;

    if (indexNodeSize === 0) {
      // 3a. 无索引：明确登记完整扫描方式——读取整个要素区并逐条几何判断。
      coverageStrategy = 'full-scan:no-spatial-index';
      const full = await client.getRange(featuresStart, client.fileSize - featuresStart, 'full-feature-section');
      if (full.length !== client.fileSize - featuresStart) {
        throw new SourceRangeError('完整扫描取得的要素区长度与文件大小不一致');
      }
      await persistBlob(full, 'feature-section-full-scan');
      issues.push({
        code: 'full-scan',
        message: 'header 的 indexNodeSize=0，文件无空间索引，采用要素区完整扫描后逐条几何判断',
      });
      let cursor = 0;
      let seq = 0;
      while (cursor < full.length) {
        if (cursor + SIZE_PREFIX_LEN > full.length) throw new SourceRangeError('要素流尾部存在残缺长度前缀');
        const bodyLength = full.readUInt32LE(cursor);
        const end = cursor + SIZE_PREFIX_LEN + bodyLength;
        if (end > full.length) throw new SourceRangeError('要素流尾部存在残缺要素体');
        const framed = full.subarray(cursor, end);
        await evaluateFeature(framed, seq, featuresStart + cursor, framed.length);
        cursor = end;
        seq += 1;
      }
      if (seq !== featuresCount) {
        issues.push({ code: 'feature-count-mismatch', message: `header 声明 ${featuresCount} 条要素，完整扫描实际解析 ${seq} 条`, expected: featuresCount, actual: seq });
      }
    } else {
      // 3b. 有索引：沿 packed Hilbert R-tree 裁剪候选，再对候选做真实几何判断。
      coverageStrategy = client.rangeSupported === false
        ? 'rtree-candidates+geometry-filter:range-ignored-full-buffer'
        : 'rtree-candidates+geometry-filter';
      const indexBytes = await client.getRange(indexStart, indexLength, 'spatial-index');
      if (indexBytes.length < indexLength) throw new SourceRangeError('空间索引被截断');
      await persistBlob(indexBytes, 'spatial-index');

      const readIndexNode = async (offset, length) => {
        const slice = indexBytes.subarray(offset, offset + length);
        if (slice.length < length) throw new SourceRangeError('索引节点读取越界');
        // Buffer 可能来自共享池，subarray 的底层 ArrayBuffer 并非零偏移；
        // 复制到全新的零基 ArrayBuffer，DataView 才能按 streamSearch 的相对偏移读取。
        return new Uint8Array(slice).buffer;
      };

      const candidates = [];
      for await (const item of streamSearch(featuresCount, indexNodeSize, {
        minX: region[0], minY: region[1], maxX: region[2], maxY: region[3],
      }, readIndexNode)) {
        const [featureByteOffset, featureIndex, nextOffset] = item;
        candidates.push({ featureByteOffset: Number(featureByteOffset), featureIndex, nextOffset: nextOffset === null ? null : Number(nextOffset) });
      }
      issues.push({
        code: 'index-candidates',
        message: `空间索引裁剪出 ${candidates.length}/${featuresCount} 条候选记录，包围盒相交不等于命中`,
        candidates: candidates.length, total: featuresCount,
      });

      for (const candidate of candidates) {
        const featureOffset = featuresStart + candidate.featureByteOffset;
        const { framed } = await readLengthPrefixedFeature(client, featureOffset);
        await evaluateFeature(framed, candidate.featureIndex, featureOffset, framed.length);
      }
    }

    if (client.rangeSupported === false) {
      issues.push({
        code: 'range-ignored',
        message: '远端不理会 Range 请求，首次范围读取即返回 200 整文件；已退化为整文件字节上的完整扫描，不能视为按范围领取',
      });
    }

    const state = issues.some(issue => ['range-ignored', 'feature-count-mismatch', 'unsupported-geometry'].includes(issue.code))
      ? 'partial' : 'complete';
    return { state, records, issues, coverage: buildCoverage(), evidence: buildEvidence() };
  } catch (error) {
    if (error instanceof SourceVersionError) {
      return reject('source-version-changed', error.message, { expected: error.expected, actual: error.actual });
    }
    return reject('source-unreadable', error.message);
  }

  async function evaluateFeature(framed, featureIndex, absoluteOffset, byteLength) {
    examined += 1;
    let geoFeature;
    try {
      geoFeature = decodeFeature(framed, headerInfo);
    } catch (error) {
      issues.push({ code: 'feature-decode-failed', message: `第 ${featureIndex} 条要素无法解析：${error.message}`, featureIndex, offset: absoluteOffset });
      return;
    }
    const properties = geoFeature.properties || {};
    const intersects = geometryIntersectsRegion(geoFeature.geometry, region);
    if (intersects === null) {
      issues.push({ code: 'unsupported-geometry', message: `要素 ${properties.id ?? featureIndex} 的几何类型 ${geoFeature.geometry?.type} 不在承诺范围内，已保留原文但不计入结果`, featureIndex, sourceOffset: absoluteOffset });
      return;
    }
    if (!intersects) return;
    const stableId = properties.id ?? `feature-${featureIndex}`;
    records.push({
      id: stableId,
      properties,
      geometry: geoFeature.geometry,
      hit: hitBasis(geoFeature.geometry, region),
      locator: { sourceIndex: featureIndex, offset: absoluteOffset, bytes: byteLength },
    });
  }
}
