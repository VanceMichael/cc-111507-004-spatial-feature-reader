function parseJson(bytes) { try { return JSON.parse(bytes.toString()); } catch { return null; } }
export function inspect(bytes) { return { format: 'FlatGeobuf', magic: bytes.subarray(0,8).toString('hex'), headerLength: bytes.length >= 12 ? bytes.readUInt32LE(8) : null }; }
