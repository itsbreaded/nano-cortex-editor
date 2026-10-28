// Cortex Cloud IR downloads (from #14): what a WAV must look like before it is handed to the editor and streamed to
// the pedal (type 15, docs/INVESTIGATION.md §6a). Pure functions; test/ux-test.js checks them without a network.
// The traced Cloud IR was a 4 KB mono 48 kHz float WAV; anything far off that is refused with a clear reason.

const MAX_IR_BYTES = 1024 * 1024;   // decoded WAV

// The download's base64 payload → the WAV bytes, refusing anything over MAX_IR_BYTES before decoding it.
function decodeIRPayload(payload) {
  if (typeof payload !== 'string' || !payload) throw new Error('The Cloud response has no IR payload.');
  if (payload.length > Math.ceil(MAX_IR_BYTES / 3) * 4 + 4) throw new Error('The IR is larger than 1 MB; the pedal takes short IR WAV files.');
  const wav = Buffer.from(payload, 'base64');
  if (wav.length > MAX_IR_BYTES) throw new Error('The IR is larger than 1 MB; the pedal takes short IR WAV files.');
  return wav;
}

// Reads the RIFF chunks: a `fmt ` chunk with PCM (16/24/32-bit) or float (32/64-bit) audio, 1–2 channels and a
// sample rate of 8–192 kHz, and a non-empty `data` chunk. Returns the format; throws with the reason otherwise.
function checkWav(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf || []);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('The Cloud IR payload is not a WAV file.');
  }
  let fmt = null, dataBytes = 0;
  for (let off = 12; off + 8 <= buf.length;) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (body + size > buf.length) throw new Error('The WAV file is cut short (its "' + id.trim() + '" chunk runs past the end).');
    if (id === 'fmt ') {
      if (size < 16) throw new Error('The WAV format chunk is too short.');
      fmt = {
        format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the sub-format GUID.
      if (fmt.format === 0xFFFE && size >= 40) fmt.format = buf.readUInt16LE(body + 24);
    } else if (id === 'data') {
      dataBytes = size;
    }
    off = body + size + (size & 1);
  }
  if (!fmt) throw new Error('The WAV file has no format chunk.');
  const pcm = fmt.format === 1, float = fmt.format === 3;
  if (!pcm && !float) throw new Error('The IR is not PCM or floating-point audio (WAV format ' + fmt.format + '), so the pedal can’t use it.');
  if (pcm ? ![16, 24, 32].includes(fmt.bits) : ![32, 64].includes(fmt.bits)) throw new Error('The IR uses ' + fmt.bits + '-bit ' + (pcm ? 'PCM' : 'float') + ' samples, which the pedal can’t read.');
  if (fmt.channels < 1 || fmt.channels > 2) throw new Error('The IR has ' + fmt.channels + ' channels; the pedal takes mono or stereo IRs.');
  if (fmt.sampleRate < 8000 || fmt.sampleRate > 192000) throw new Error('The IR’s sample rate (' + fmt.sampleRate + ' Hz) is outside 8–192 kHz.');
  if (!dataBytes) throw new Error('The WAV file has no audio data.');
  return { ...fmt, dataBytes };
}

module.exports = { MAX_IR_BYTES, decodeIRPayload, checkWav };
