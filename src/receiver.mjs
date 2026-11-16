import { receiveBytes } from './http-client.mjs';
import { inspect } from './source-metadata.mjs';
import { collectRegion, validateRegion } from './flatgeobuf-region.mjs';

export async function collect({ input, descriptor, sourceBase, store }) {
  if (input.mode === 'raw') return collectRaw({ descriptor, sourceBase, store });
  if (input.mode === 'structured') return collectStructured({ input, descriptor, sourceBase, store });
  return { httpStatus: 400, error: '接收方式无效' };
}

async function collectRaw({ descriptor, sourceBase, store }) {
  const source = await receiveBytes(`${sourceBase}/files/${encodeURIComponent(descriptor.entry)}`);
  const blob = await store.blob(source.bytes);
  const receipt = await store.save({ state: 'received', mode: 'raw', product: descriptor.product,
    source: descriptor.entry, sourceVersion: source.etag, metadata: inspect(source.bytes), blobs: [blob],
    records: [], issues: [], coverage: { structured: false, downloadedBytes: source.bytes.length } });
  return { receipt };
}

async function collectStructured({ input, descriptor, sourceBase, store }) {
  const regionError = validateRegion(input.region);
  if (regionError) return { httpStatus: 400, error: regionError };
  const url = `${sourceBase}/files/${encodeURIComponent(descriptor.entry)}`;
  const outcome = await collectRegion({ url, region: input.region, store });
  const receipt = await store.save({
    mode: 'structured',
    state: outcome.state,
    product: descriptor.product,
    source: descriptor.entry,
    sourceVersion: outcome.evidence.etag,
    region: input.region,
    records: outcome.records,
    issues: outcome.issues,
    coverage: outcome.coverage,
    evidence: {
      sourceUrl: outcome.evidence.sourceUrl,
      etag: outcome.evidence.etag,
      requests: outcome.evidence.requests,
      blobs: outcome.evidence.blobs,
    },
  });
  return { receipt, httpStatus: 201 };
}
