/** Count UTF-8 bytes without allocating an encoded copy or requiring browser APIs. */
export async function utf8ByteLength(text, pause) {
  let bytes = 0, nextPause = 0;
  for (let i = 0; i < text.length; i++) {
    if (pause && i >= nextPause) { await pause(); nextPause = i + 8192; }
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4; i++;
    } else bytes += 3;
  }
  return bytes;
}
