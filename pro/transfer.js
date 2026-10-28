// Streamed transfers to the pedal over C304: a capture into the library (13 → 14), a Cortex Cloud IR into the
// library (15 → 16), a capture audition (150 → 151) and the audition stop (148 → 149). One at a time.
//
// Decoded from a PacketLogger trace of the official phone app sending two
// captures to a Nano Cortex (docs/INVESTIGATION.md §6; the recording itself is
// not published). The app sends one protobuf message of type 13:
//
//   { 1: 6, 3: { 1: <.cns bytes> }, 4: CaptureRecord }
//   CaptureRecord { 1: hash, 2: name, 3: cloudUUID, 4: { 1: authorId, 2: authorName },
//                   5: description, 6: deviceType, 7: tags[], 8: gainType,
//                   10: instrumentType, 12: version }
//
// Big messages are streamed: body + u32 type, cut into 500-byte writes with a
// 2-byte header [len & 0xFF, flags], flags = 0x40 first | 0x80 last | bit 0 =
// bit 8 of len. (A single-chunk message is the familiar `len C0 … type` frame.)
// The last write is padded to 500 bytes like the official app does.
// The pedal answers with type 14: { 1: 6, 3: status, 4: { 1: userIndex, 2: name, 3: hash } }.
// The IR download, the audition and the stop are in docs/INVESTIGATION.md §6a and §12 (from #14).
//
// Loaded after core.js (needs writeC304, frameType, parseProtoFields, onC305) and capture-text.js,
// and before ui.js.
(() => {
  'use strict';

  const MSG_UPLOAD_CAPTURE = 13;
  const MSG_UPLOAD_CAPTURE_REPLY = 14;
  const MSG_DOWNLOAD_IR = 15;
  const MSG_DOWNLOAD_IR_REPLY = 16;
  // Capture auditioning is separate from the normal library upload. These
  // message numbers and shapes were decoded from the official iOS app trace.
  const MSG_PREVIEW_STOP = 148;
  const MSG_PREVIEW_STOP_REPLY = 149;
  const MSG_PREVIEW_CAPTURE = 150;
  const MSG_PREVIEW_CAPTURE_REPLY = 151;
  const WRITE_SIZE = 500;           // bytes per BLE write, as the official app
  const CHUNK = WRITE_SIZE - 2;     // data bytes per write

  const enc = new TextEncoder();
  const varint = (n) => { const o = []; n = Math.max(0, Math.floor(Number(n) || 0)); while (n > 0x7f) { o.push((n % 128) | 0x80); n = Math.floor(n / 128); } o.push(n); return o; };
  const tag = (num, wire) => varint(num * 8 + wire);
  const str = (num, s) => { if (s === undefined || s === null) return []; const b = enc.encode(String(s)); return [...tag(num, 2), ...varint(b.length), ...b]; };
  const bytes = (num, b) => [...tag(num, 2), ...varint(b.length), ...b];
  const int = (num, v) => (v === undefined || v === null || v === '' ? [] : [...tag(num, 0), ...varint(v)]);

  function captureRecord(m) {
    return [
      ...str(1, m.hash), ...str(2, m.name), ...str(3, m.cloudUUID),
      ...bytes(4, [...str(1, m.authorId), ...str(2, m.authorName)]),
      ...str(5, NanoText.storedDescription(m.description)),   // never "null"; a Cloud ID is kept (pro/capture-text.js)
      ...str(6, m.deviceType || 'default'),
      ...(m.tags || []).flatMap(t => str(7, t)),
      ...int(8, m.gainType),
      ...str(10, m.instrumentType || 'instrument_not_set'),
      ...str(12, String(m.version || '1')),
    ];
  }

  function uploadMessage(cns, meta) {
    return [...int(1, 6), ...bytes(3, bytes(1, Array.from(cns))), ...bytes(4, captureRecord(meta))];
  }

  function irDownloadMessage(wav, meta) {
    // type 15 from the iOS Cloud app: {1:6, 3:{1:WAV,2:MD5}, 4:product UUID, 5:filename}
    const content = [...bytes(1, Array.from(wav)), ...str(2, md5Hex(wav))];
    return [...int(1, 6), ...bytes(3, content), ...str(4, meta.productId), ...str(5, meta.filename)];
  }

  // The preview trace includes an MD5 of the .cns bytes. Web Crypto does not
  // expose MD5, so keep this small dependency-free implementation local to the
  // transfer protocol. It is only used to reproduce the official message.
  function md5Hex(input) {
    const data = Array.from(input, x => Number(x) & 0xff);
    const bitLength = data.length * 8;
    data.push(0x80);
    while (data.length % 64 !== 56) data.push(0);
    for (let i = 0; i < 8; i++) data.push(Math.floor(bitLength / Math.pow(2, 8 * i)) & 0xff);

    const shifts = [
      7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    const k = Array.from({ length: 64 }, (_x, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);
    const rotate = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;

    for (let offset = 0; offset < data.length; offset += 64) {
      const m = [];
      for (let i = 0; i < 16; i++) {
        const p = offset + i * 4;
        m.push((data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | (data[p + 3] << 24)) >>> 0);
      }
      let a = a0; let b = b0; let c = c0; let d = d0;
      for (let i = 0; i < 64; i++) {
        let f; let g;
        if (i < 16) { f = (b & c) | (~b & d); g = i; }
        else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
        else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
        else { f = c ^ (b | ~d); g = (7 * i) % 16; }
        const next = (a + f + k[i] + m[g]) >>> 0;
        a = d; d = c; c = b; b = (b + rotate(next, shifts[i])) >>> 0;
      }
      a0 = (a0 + a) >>> 0;
      b0 = (b0 + b) >>> 0;
      c0 = (c0 + c) >>> 0;
      d0 = (d0 + d) >>> 0;
    }

    const little = value => [0, 8, 16, 24].map(shift => ((value >>> shift) & 0xff).toString(16).padStart(2, '0')).join('');
    return little(a0) + little(b0) + little(c0) + little(d0);
  }

  function previewMessage(cns, meta) {
    // type 150 body observed in the trace:
    //   { 5: { 1: { 1: <cns>, 2: <md5> }, 2: CaptureRecord }, 7: 2, 8: 1 }
    const content = [...bytes(1, Array.from(cns)), ...str(2, md5Hex(cns))];
    const previewObject = [...bytes(1, content), ...bytes(2, captureRecord(meta))];
    return [...bytes(5, previewObject), ...int(7, 2), ...int(8, 1)];
  }

  // body (array of bytes) + message type → list of Uint8Array writes.
  function chunks(body, type, pad = true) {
    const all = [...body, type & 0xff, (type >> 8) & 0xff, (type >> 16) & 0xff, (type >>> 24) & 0xff];
    const out = [];
    for (let i = 0; i < all.length; i += CHUNK) {
      const part = all.slice(i, i + CHUNK);
      const last = i + CHUNK >= all.length;
      const flags = (i === 0 ? 0x40 : 0) | (last ? 0x80 : 0) | ((part.length >> 8) & 1);
      const frame = [part.length & 0xff, flags, ...part];
      if (pad && out.length > 0 && last) while (frame.length < WRITE_SIZE) frame.push(0);
      out.push(Uint8Array.from(frame));
    }
    return out;
  }

  // Reassembles streamed writes/notifications: feed each packet, get the full
  // message (body + type) back when the last one arrives, else null.
  function makeReassembler() {
    let buf = null;
    return (packet) => {
      if (packet.length < 2) return null;
      const flags = packet[1];
      const len = packet[0] | ((flags & 1) << 8);
      if (flags & 0x40) buf = [];
      if (!buf) return null;
      buf.push(...packet.slice(2, 2 + len));
      if (flags & 0x80) { const done = Uint8Array.from(buf); buf = null; return done; }
      return null;
    };
  }

  function parseUploadReply(data) {
    const f = parseProtoFields(data.slice(2, data.length - 4));
    const first = (fields, n) => fields[n] && fields[n][0];
    const text = (fields, n) => { const x = first(fields, n); return x && x.wire === 2 ? new TextDecoder().decode(Uint8Array.from(x.raw)) : ''; };
    const status = first(f, 3) ? first(f, 3).value : 0;
    const rec = first(f, 4) && first(f, 4).wire === 2 ? parseProtoFields(first(f, 4).raw) : {};
    return {
      ok: status === 1,
      index: first(rec, 1) ? first(rec, 1).value : 0,
      name: text(rec, 2), hash: text(rec, 3),
      message: text(f, 5) || text(rec, 4) || '',
    };
  }

  // ------------------------------------------------------------------ one transfer at a time
  // The streamed messages (13 capture to the library, 15 IR to the library, 150 capture audition) go out as a run of
  // writes that only make sense together, and each waits for its own reply. One at a time; the others are refused.
  let streamBusy = '';
  async function exclusive(label, fn) {
    if (streamBusy) throw new Error('Another transfer to the pedal is still running (' + streamBusy + '). Try again when it has finished.');
    streamBusy = label;
    try { return await fn(); } finally { streamBusy = ''; }
  }

  // Replies a transfer waits for, by message type, caught before the core's dispatch sees them. Every wait ends:
  // with the reply, a timeout or a cancel; and a wait nobody awaits any more never becomes an unhandled rejection.
  const waiters = new Map();
  function awaitReply(type, parse, what, timeoutMs = 20000) {
    if (waiters.has(type)) throw new Error('Still waiting for the pedal to answer ' + what + '.');
    let settle;
    const promise = new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => settle(new Error('The pedal did not answer ' + what + ' within ' + (timeoutMs / 1000) + ' s')), timeoutMs);
      settle = (err, data) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (waiters.get(type) === settle) waiters.delete(type);
        if (err) { reject(err instanceof Error ? err : new Error(String(err))); return; }
        try { resolve(parse(data)); } catch (e) { reject(e); }
      };
      waiters.set(type, settle);
    });
    promise.catch(() => {});
    return { promise, cancel: (err) => settle(err) };
  }

  const coreOnC305 = window.onC305;
  window.onC305 = function (event) {
    const v = event && event.target && event.target.value;
    const data = v && v.buffer ? new Uint8Array(v.buffer, v.byteOffset || 0, typeof v.byteLength === 'number' ? v.byteLength : v.buffer.byteLength) : null;
    const type = data ? frameType(data) : null;
    const settle = type !== null && waiters.get(type);
    if (settle) {
      log('RX ' + (REPLY_LABEL[type] || 'reply ' + type) + ': ' + hex(data));
      settle(null, data);
      return;
    }
    return coreOnC305.call(this, event);
  };

  // Writes the parts in order; on a failed write the reply wait is cancelled (and awaited) before the error is thrown.
  async function stream(label, parts, reply, onProgress) {
    for (let i = 0; i < parts.length; i++) {
      const ok = await writeC304(label + ' ' + (i + 1) + '/' + parts.length, parts[i]);
      if (!ok) {
        const err = new Error('Bluetooth write failed at part ' + (i + 1) + ' of ' + parts.length);
        reply.cancel(err);
        await reply.promise.catch(() => {});
        throw err;
      }
      if (onProgress) onProgress(i + 1, parts.length);
    }
    return reply.promise;
  }

  const first = (fields, n) => fields[n] && fields[n][0];
  const text = (fields, n) => { const x = first(fields, n); return x && x.wire === 2 ? new TextDecoder().decode(Uint8Array.from(x.raw)) : ''; };
  function replyFields(data) {
    const f = parseProtoFields(Array.from(data.slice(2, data.length - 4)));
    const rec = first(f, 4) && first(f, 4).wire === 2 ? parseProtoFields(first(f, 4).raw) : {};
    return { f, rec, status: first(f, 3) ? first(f, 3).value : 0 };
  }

  function parseUploadReply(data) {
    const { f, rec, status } = replyFields(data);
    return {
      ok: status === 1,
      index: first(rec, 1) ? first(rec, 1).value : 0,
      name: text(rec, 2), hash: text(rec, 3),
      message: text(f, 5) || text(rec, 4) || '',
    };
  }

  // Sends one capture. cns: Uint8Array; meta: see captureRecord. Resolves with
  // the parsed reply; rejects on a failed write, no reply, or another transfer running.
  function uploadCapture({ cns, meta }, onProgress) {
    return exclusive('capture upload', async () => {
      if (!state.connected) throw new Error('Not connected');
      const parts = chunks(uploadMessage(cns, meta), MSG_UPLOAD_CAPTURE);
      const reply = awaitReply(MSG_UPLOAD_CAPTURE_REPLY, parseUploadReply, 'the capture upload');
      const r = await stream('Capture upload "' + meta.name + '"', parts, reply, onProgress);
      log('Capture upload ' + (r.ok ? 'accepted' : 'REFUSED') + ': "' + r.name + '" user index ' + r.index + (r.message ? ' (' + r.message + ')' : ''));
      return r;
    });
  }

  function parseIRDownloadReply(data) {
    const { f, rec, status } = replyFields(data);
    return {
      ok: status === 1,
      status,
      index: first(rec, 1) ? first(rec, 1).value : 0,
      name: text(rec, 2),
      message: text(f, 5) || text(rec, 4) || '',
    };
  }

  // A Cloud IR (raw WAV) into the pedal's IR library: type 15 → 16.
  function downloadImpulseResponse({ wav, meta }, onProgress) {
    return exclusive('IR download', async () => {
      if (!state.connected) throw new Error('Not connected');
      if (!wav || !meta || !meta.productId || !meta.filename || !/\.wav$/i.test(meta.filename)) throw new Error('The Cloud IR download is incomplete.');
      const parts = chunks(irDownloadMessage(wav, meta), MSG_DOWNLOAD_IR);
      const reply = awaitReply(MSG_DOWNLOAD_IR_REPLY, parseIRDownloadReply, 'the IR download');
      const result = await stream('Cloud IR download "' + meta.name + '"', parts, reply, onProgress);
      log('Cloud IR download ' + (result.ok ? 'accepted' : 'REFUSED') + ': "' + (result.name || meta.name) + '" user IR index ' + result.index + (result.message ? ' (' + result.message + ')' : ''));
      return result;
    });
  }

  function parsePreviewReply(data) {
    const { f, rec, status } = replyFields(data);
    return {
      ok: status === 1,
      status,
      kind: first(f, 1) ? first(f, 1).value : 0,
      transaction: first(f, 2) ? first(f, 2).value : null,
      name: text(rec, 2),
      hash: text(rec, 3),
      message: text(f, 5),
    };
  }

  // Capture audition (Cortex Cloud "Play"): type 150 → 151. Nothing is stored on the pedal.
  function previewCapture({ cns, meta }, onProgress) {
    return exclusive('capture preview', async () => {
      if (!state.connected) throw new Error('Not connected');
      const parts = chunks(previewMessage(cns, meta), MSG_PREVIEW_CAPTURE);
      const reply = awaitReply(MSG_PREVIEW_CAPTURE_REPLY, parsePreviewReply, 'the capture preview');
      const result = await stream('Capture preview "' + meta.name + '"', parts, reply, onProgress);
      log('Capture preview ' + (result.ok ? 'accepted' : 'REFUSED') + ': "' + (result.name || meta.name) + '"');
      return result;
    });
  }

  // Ends a capture preview or an IR audition: type 148 { 2: transaction, 3 (capture) or 4 (IR): 0 } → 149
  // { 1: 1, 2: same transaction, 3: 1 }. ok only when the pedal echoes this transaction with status 1.
  function stopAuditionFrame(kind, transaction) {
    return buildFrame([0x10, ...varint(transaction), kind === 'ir' ? 0x20 : 0x18, 0x00], MSG_PREVIEW_STOP);
  }
  async function stopAudition(kind) {
    if (!state.connected) throw new Error('Not connected');
    const transaction = Date.now();
    const what = kind === 'ir' ? 'IR preview' : 'capture preview';
    const reply = awaitReply(MSG_PREVIEW_STOP_REPLY, parsePreviewReply, 'the ' + what + ' stop', 10000);
    const sent = await writeC304('Stop ' + what, stopAuditionFrame(kind, transaction));
    if (!sent) {
      const err = new Error('Bluetooth write failed while stopping the ' + what);
      reply.cancel(err);
      await reply.promise.catch(() => {});
      throw err;
    }
    const result = await reply.promise;
    result.ok = result.status === 1 && result.transaction === transaction;
    result.sentTransaction = transaction;
    log((kind === 'ir' ? 'IR' : 'Capture') + ' preview stop ' + (result.ok ? 'confirmed' : 'NOT confirmed (status ' + result.status + ', transaction ' + result.transaction + ')') + ' (' + transaction + ')');
    return result;
  }
  const stopPreview = () => stopAudition('capture');

  const REPLY_LABEL = { [MSG_UPLOAD_CAPTURE_REPLY]: 'capture upload reply', [MSG_DOWNLOAD_IR_REPLY]: 'IR download reply',
    [MSG_PREVIEW_CAPTURE_REPLY]: 'capture preview reply', [MSG_PREVIEW_STOP_REPLY]: 'preview stop reply' };

  window.NanoTransfer = {
    MSG_UPLOAD_CAPTURE, MSG_UPLOAD_CAPTURE_REPLY, MSG_DOWNLOAD_IR, MSG_DOWNLOAD_IR_REPLY, MSG_PREVIEW_STOP, MSG_PREVIEW_STOP_REPLY,
    MSG_PREVIEW_CAPTURE, MSG_PREVIEW_CAPTURE_REPLY, WRITE_SIZE, uploadMessage, previewMessage,
    captureRecord, chunks, makeReassembler, md5Hex, irDownloadMessage, parseUploadReply, parseIRDownloadReply, parsePreviewReply,
    uploadCapture, downloadImpulseResponse, previewCapture, stopPreview, stopAudition, stopAuditionFrame,
    get busy() { return streamBusy; },
  };
})();
