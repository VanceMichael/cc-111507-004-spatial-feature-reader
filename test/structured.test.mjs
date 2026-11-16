import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/server.mjs';

const REGION = [0, 0, 2, 2];

async function start(scenario) {
  const dataDir = await mkdtemp(join(tmpdir(), `structured-${scenario}-`));
  const service = await createService({ dataDir, scenario });
  return { dataDir, service };
}

async function structuredIntake(service, body = { mode: 'structured', region: REGION }) {
  const response = await fetch(`${service.baseUrl}/v1/intakes`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, receipt: await response.json() };
}

test('结构化收件：索引裁剪后做真实几何判断，边界相交保留、仅包围盒相交排除', async () => {
  const { dataDir, service } = await start('standard');
  try {
    const { status, receipt } = await structuredIntake(service);
    assert.equal(status, 201);
    assert.equal(receipt.state, 'complete');
    assert.deepEqual(receipt.records.map(record => record.id).sort(), ['f1', 'f3']);
    // f2 的包围盒与区域相交但几何（x+y=9 的斜线）不进入区域，不得混入
    assert.ok(!receipt.records.some(record => record.id === 'f2'));
    // f3 位于区域边界 (2,0)，边界接触必须保留并标明
    const boundary = receipt.records.find(record => record.id === 'f3');
    assert.equal(boundary.hit.boundaryContact, true);
    assert.equal(boundary.locator.sourceIndex, 2);
    assert.equal(boundary.locator.offset > 0, true);
    // 身份取自属性 id，不使用候选节点下标
    assert.equal(new Set(receipt.records.map(record => record.id)).size, receipt.records.length);
    // 覆盖说明：走了空间索引裁剪
    assert.equal(receipt.coverage.indexPruned, true);
    assert.equal(receipt.coverage.strategy, 'rtree-candidates+geometry-filter');
    assert.equal(receipt.coverage.featuresTotal, 3);
    assert.equal(receipt.coverage.matched, 2);
    assert.equal(receipt.coverage.rangeSupported, true);
    assert.equal(receipt.coverage.fullFileBuffered, false);
    assert.ok(receipt.issues.some(issue => issue.code === 'index-candidates'));
    // 真实读取字节可追溯：全部为 206 范围应答，且没有整文件回退
    assert.ok(receipt.evidence.requests.length >= 4);
    assert.ok(receipt.evidence.requests.every(item => item.status === 206));
    assert.ok(receipt.evidence.requests.every(item => item.digest && item.rangeHeader.startsWith('bytes=')));
    // 首个请求确定版本，之后每次读取都携带 If-Match 锁定版本
    assert.equal(receipt.evidence.requests[0].ifMatch, null);
    assert.ok(receipt.evidence.requests.slice(1).every(item => item.ifMatch === '"source-v1"'));
    assert.equal(receipt.evidence.etag, '"source-v1"');
    // 持久化后重新查询得到相同记录与覆盖说明
    const saved = await (await fetch(`${service.baseUrl}/v1/receipts/${receipt.id}`)).json();
    assert.deepEqual(saved.records, receipt.records);
    assert.deepEqual(saved.coverage, receipt.coverage);
    assert.deepEqual(saved.evidence.requests, receipt.evidence.requests);
    // 网关侧也留有真实范围访问记录
    assert.ok(service.gateway.trace.some(item => item.range && item.ifMatch));
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('无索引文件：明确登记要素区完整扫描方式，结果与索引路径一致', async () => {
  const { dataDir, service } = await start('unindexed');
  try {
    const { status, receipt } = await structuredIntake(service);
    assert.equal(status, 201);
    assert.equal(receipt.state, 'complete');
    assert.deepEqual(receipt.records.map(record => record.id).sort(), ['f1', 'f3']);
    assert.equal(receipt.coverage.indexPruned, false);
    assert.equal(receipt.coverage.indexNodeSize, 0);
    assert.equal(receipt.coverage.strategy, 'full-scan:no-spatial-index');
    assert.equal(receipt.coverage.rangeSupported, true);
    const issue = receipt.issues.find(item => item.code === 'full-scan');
    assert.ok(issue && /完整扫描/.test(issue.message));
    // 完整扫描读取的要素区覆盖整个文件尾部
    const full = receipt.evidence.requests.find(item => item.purpose === 'full-feature-section');
    assert.equal(full.status, 206);
    const fixtureBytes = (await readFile(new URL('../fixtures/unindexed.fgb', import.meta.url))).length;
    assert.equal(receipt.coverage.fileSize, fixtureBytes);
    assert.match(full.rangeHeader, /^bytes=112-/);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('远端不理会 Range：不伪装成按范围领取，形成带说明的 partial 收件', async () => {
  const { dataDir, service } = await start('ignored-range');
  try {
    const { status, receipt } = await structuredIntake(service);
    assert.equal(status, 201);
    assert.equal(receipt.state, 'partial');
    assert.deepEqual(receipt.records.map(record => record.id).sort(), ['f1', 'f3']);
    const issue = receipt.issues.find(item => item.code === 'range-ignored');
    assert.ok(issue);
    assert.equal(receipt.coverage.rangeSupported, false);
    assert.equal(receipt.coverage.fullFileBuffered, true);
    assert.match(receipt.coverage.strategy, /range-ignored-full-buffer/);
    // 首次请求带了 Range，但拿到的是 200 整文件
    const first = receipt.evidence.requests[0];
    assert.equal(first.status, 200);
    assert.match(first.rangeHeader, /^bytes=/);
    assert.equal(first.ignoredRange, true);
    assert.equal(first.transferredBytes, receipt.coverage.fileSize);
    // 不能写 complete
    assert.notEqual(receipt.state, 'complete');
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('来源中途换版：If-Match 触发 412 时拒绝拼接，形成 rejected 收件且不留正常数据', async () => {
  const { dataDir, service } = await start('changed');
  try {
    const { status, receipt } = await structuredIntake(service);
    assert.equal(status, 201);
    assert.equal(receipt.state, 'rejected');
    assert.deepEqual(receipt.records, []);
    const issue = receipt.issues.find(item => item.code === 'source-version-changed');
    assert.ok(issue);
    assert.equal(issue.expected, '"source-v1"');
    assert.equal(issue.actual, '"source-v2"');
    // 已读取的字节证据仍保留，可解释读到哪里被拒绝
    assert.ok(receipt.evidence.requests.length >= 1);
    assert.ok(receipt.evidence.blobs.length >= 1);
    // 拒绝结果同样可查询，不会被当作正常收件
    const saved = await (await fetch(`${service.baseUrl}/v1/receipts/${receipt.id}`)).json();
    assert.equal(saved.state, 'rejected');
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('结构化参数错误返回 400，不产生收件', async () => {
  const { dataDir, service } = await start('standard');
  try {
    for (const body of [
      { mode: 'structured', region: [0, 0, 2] },
      { mode: 'structured', region: [2, 0, 0, 2] },
      { mode: 'structured', region: ['a', 0, 1, 1] },
      { mode: 'structured' },
    ]) {
      const response = await fetch(`${service.baseUrl}/v1/intakes`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
    }
    const list = await (await fetch(`${service.baseUrl}/v1/receipts`)).json();
    assert.equal(list.length, 0);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
