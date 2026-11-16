import { createHash } from 'node:crypto';

/** 来源在读取过程中更换版本（If-Match 预检失败或 ETag 发生变化）。 */
export class SourceVersionError extends Error {
  constructor(message, { expected, actual, status } = {}) {
    super(message);
    this.name = 'SourceVersionError';
    this.expected = expected;
    this.actual = actual;
    this.status = status;
  }
}

/** 来源返回的字节无法解释（范围应答越界、截断等）。 */
export class SourceRangeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SourceRangeError';
  }
}

const DEFAULT_LIMIT = 16777216;

/**
 * 只支持带范围读取的远端文件：
 * - 首次请求固定携带 Range，据此判断远端是否真正支持字节范围；
 * - 拿到首个 ETag 后，后续请求一律携带 If-Match，版本中途变化即拒绝继续拼接；
 * - 逐次记录真实请求、状态、字节范围与摘要，作为“实际读了哪些字节”的证据。
 */
export class RangeClient {
  #url;
  #limit;
  #etag = null;
  #fileSize = null;
  #rangeSupported = null;
  #fullBuffer = null;
  #requests = [];

  constructor(url, { limit = DEFAULT_LIMIT } = {}) {
    this.#url = url;
    this.#limit = limit;
  }

  get etag() { return this.#etag; }
  get fileSize() { return this.#fileSize; }
  get rangeSupported() { return this.#rangeSupported; }
  get requests() { return this.#requests; }
  get fullFileBuffered() { return this.#fullBuffer !== null; }

  /**
   * 读取 [start, start+length) 字节。远端忽略 Range 时返回的是整文件，
   * 调用方仍按逻辑切片使用，并通过 rangeSupported=false 得知这一事实。
   */
  async getRange(start, length, purpose = 'data') {
    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(length) || length <= 0) {
      throw new SourceRangeError(`范围参数无效：start=${start}, length=${length}`);
    }
    if (this.#fullBuffer) {
      if (start >= this.#fullBuffer.length) throw new SourceRangeError('范围起点超出文件长度');
      const end = Math.min(start + length, this.#fullBuffer.length);
      return this.#fullBuffer.subarray(start, end);
    }
    const headers = { Range: `bytes=${start}-${start + length - 1}` };
    if (this.#etag) headers['If-Match'] = this.#etag;
    const response = await fetch(this.#url, { headers, signal: AbortSignal.timeout(5000), redirect: 'error' });

    if (response.status === 412) {
      const actual = response.headers.get('etag');
      throw new SourceVersionError('来源在读取过程中更换版本，已拒绝拼接', { expected: this.#etag, actual, status: 412 });
    }
    if (!response.ok) throw new SourceRangeError(`来源返回 ${response.status}`);

    const parts = [];
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > this.#limit) throw new SourceRangeError('来源超出收件限额');
      parts.push(chunk);
    }
    const bytes = Buffer.concat(parts);
    const etag = response.headers.get('etag');
    if (this.#etag && etag && etag !== this.#etag) {
      throw new SourceVersionError('来源 ETag 在读取过程中发生变化，已拒绝拼接', { expected: this.#etag, actual: etag, status: response.status });
    }
    if (!this.#etag) this.#etag = etag;

    const contentRange = response.headers.get('content-range');
    const evidence = {
      purpose,
      rangeHeader: headers.Range,
      ifMatch: headers['If-Match'] || null,
      status: response.status,
      contentRange,
      etag,
      transferredBytes: bytes.length,
      digest: createHash('sha256').update(bytes).digest('hex'),
    };

    if (response.status === 206 || contentRange) {
      this.#rangeSupported = true;
      const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(contentRange || '');
      if (!match) throw new SourceRangeError('来源 206 应答缺少可解释的 Content-Range');
      const first = Number(match[1]), last = Number(match[2]);
      if (first !== start || last + 1 !== start + bytes.length) {
        throw new SourceRangeError('来源返回的字节范围与请求不一致');
      }
      if (match[3] !== '*') {
        const total = Number(match[3]);
        if (this.#fileSize !== null && total !== this.#fileSize) {
          throw new SourceVersionError('来源声明的文件总长度在读取过程中发生变化，已拒绝拼接', { expected: this.#fileSize, actual: total, status: response.status });
        }
        this.#fileSize = total;
      }
      evidence.servedStart = first;
      evidence.servedEnd = last;
      this.#requests.push(evidence);
      return bytes;
    }

    // 200 且没有 Content-Range：远端不理会范围请求，整文件已在本次应答中返回。
    this.#rangeSupported = false;
    this.#fullBuffer = bytes;
    this.#fileSize = bytes.length;
    evidence.ignoredRange = true;
    evidence.servedStart = 0;
    evidence.servedEnd = bytes.length - 1;
    this.#requests.push(evidence);
    const end = Math.min(start + length, bytes.length);
    if (start >= bytes.length) throw new SourceRangeError('范围起点超出文件长度');
    return bytes.subarray(start, end);
  }
}
