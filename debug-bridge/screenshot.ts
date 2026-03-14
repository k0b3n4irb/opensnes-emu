/**
 * Screenshot capture and PNG encoding.
 *
 * Converts the emulator's RGBA framebuffer to PNG for MCP responses.
 * Uses a minimal PNG encoder (no external deps for core functionality).
 */

import { DebugEmulator } from './emulator.js';
import { deflateSync } from 'node:zlib';

export class ScreenCapture {
    constructor(private emulator: DebugEmulator) {}

    /**
     * Capture the current frame as a PNG buffer.
     * @param scale Scale factor (1 = native 256×224, 2 = 512×448)
     */
    captureFrame(scale: number = 1): Buffer {
        const fb = this.emulator.getFrameBufferRGBA();
        if (!fb) {
            throw new Error('No frame rendered yet — call runFrames() first');
        }

        if (scale === 1) {
            return encodePNG(fb.data, fb.width, fb.height);
        }

        // Scale up using nearest-neighbor
        const scaledWidth = fb.width * scale;
        const scaledHeight = fb.height * scale;
        const scaled = new Uint8Array(scaledWidth * scaledHeight * 4);

        for (let y = 0; y < scaledHeight; y++) {
            const srcY = Math.floor(y / scale);
            for (let x = 0; x < scaledWidth; x++) {
                const srcX = Math.floor(x / scale);
                const srcIdx = (srcY * fb.width + srcX) * 4;
                const dstIdx = (y * scaledWidth + x) * 4;
                scaled[dstIdx + 0] = fb.data[srcIdx + 0];
                scaled[dstIdx + 1] = fb.data[srcIdx + 1];
                scaled[dstIdx + 2] = fb.data[srcIdx + 2];
                scaled[dstIdx + 3] = fb.data[srcIdx + 3];
            }
        }

        return encodePNG(scaled, scaledWidth, scaledHeight);
    }

    /**
     * Capture the current frame as raw RGBA pixels.
     */
    captureFrameRaw(): { data: Uint8Array; width: number; height: number } | null {
        return this.emulator.getFrameBufferRGBA();
    }

    /**
     * Capture a frame and return it as a base64-encoded PNG string.
     */
    captureFrameBase64(scale: number = 1): string {
        return this.captureFrame(scale).toString('base64');
    }
}

// ── Minimal PNG Encoder ──────────────────────────────────────────
// No external dependencies. Produces valid PNG from RGBA pixel data.

function encodePNG(rgba: Uint8Array, width: number, height: number): Buffer {
    // PNG signature
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

    // IHDR chunk
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // color type: RGBA
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace
    const ihdrChunk = makeChunk('IHDR', ihdr);

    // IDAT chunk — filtered scanlines compressed with zlib
    const rawSize = height * (1 + width * 4); // filter byte + RGBA per row
    const rawData = Buffer.alloc(rawSize);
    let offset = 0;
    for (let y = 0; y < height; y++) {
        rawData[offset++] = 0; // filter: None
        const rowStart = y * width * 4;
        for (let x = 0; x < width * 4; x++) {
            rawData[offset++] = rgba[rowStart + x];
        }
    }
    const compressed = deflateSync(rawData, { level: 6 });
    const idatChunk = makeChunk('IDAT', compressed);

    // IEND chunk
    const iendChunk = makeChunk('IEND', Buffer.alloc(0));

    return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function makeChunk(type: string, data: Buffer): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);

    const typeBytes = Buffer.from(type, 'ascii');
    const crcData = Buffer.concat([typeBytes, data]);
    const crc = crc32(crcData);

    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc >>> 0, 0);

    return Buffer.concat([length, typeBytes, data, crcBuf]);
}

// CRC32 lookup table
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
        if (c & 1) {
            c = 0xEDB88320 ^ (c >>> 1);
        } else {
            c = c >>> 1;
        }
    }
    crcTable[n] = c;
}

function crc32(data: Buffer): number {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
        crc = crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    }
    return crc ^ 0xFFFFFFFF;
}
