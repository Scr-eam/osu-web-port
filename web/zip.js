// Minimal zip reader for .osz archives (stored and deflate entries).
// Returns a Map from lowercase entry name to { name, read(): Promise<ArrayBuffer> }.

export async function readZip(buffer) {
  const dv = new DataView(buffer);
  const u = new Uint8Array(buffer);
  // End of central directory record (signature 0x06054b50), searched from the end.
  let e = u.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("Not a zip file.");
  const count = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  const entries = new Map();
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("Corrupt zip directory.");
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = decoder.decode(u.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    const read = async () => {
      const lh = localOffset;
      const start = lh + 30 + dv.getUint16(lh + 26, true) + dv.getUint16(lh + 28, true);
      const data = u.subarray(start, start + compSize);
      if (method === 0) return data.slice().buffer;
      if (method !== 8) throw new Error(`Unsupported zip method ${method}.`);
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Response(stream).arrayBuffer();
    };
    entries.set(name.toLowerCase(), { name, read });
  }
  return entries;
}
