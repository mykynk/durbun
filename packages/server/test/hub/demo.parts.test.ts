import { crc32 as zlibCrc32, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { Canvas, crc32, encodePng, PNG_SIGNATURE, petThumbnailPng, screenshotPng } from '../../src/demo/png';
import { Rng, Walk } from '../../src/demo/rng';
import { Scheduler } from '../../src/demo/scheduler';

describe('demo PNG encoder', () => {
  it('computes standard CRC-32', () => {
    const data = Buffer.from('IHDR and some bytes 🐾');
    expect(crc32(data)).toBe(zlibCrc32(data));
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('writes a valid RGBA PNG (signature, IHDR, IDAT, IEND, chunk CRCs)', () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128]);
    const png = encodePng(2, 2, rgba);
    expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    let offset = 8;
    const chunks: { type: string; data: Buffer }[] = [];
    while (offset < png.length) {
      const len = png.readUInt32BE(offset);
      const type = png.toString('ascii', offset + 4, offset + 8);
      const data = png.subarray(offset + 8, offset + 8 + len);
      expect(png.readUInt32BE(offset + 8 + len)).toBe(zlibCrc32(png.subarray(offset + 4, offset + 8 + len)));
      chunks.push({ type, data });
      offset += 12 + len;
    }
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    const ihdr = chunks[0]!.data;
    expect([ihdr.readUInt32BE(0), ihdr.readUInt32BE(4), ihdr[8], ihdr[9]]).toEqual([2, 2, 8, 6]);
    const raw = inflateSync(chunks[1]!.data);
    expect(raw.length).toBe((2 * 4 + 1) * 2);
    expect([...raw.subarray(1, 5)]).toEqual([255, 0, 0, 255]);
    expect([...raw.subarray(10, 14)]).toEqual([0, 0, 255, 255]);
  });

  it('draws shapes and produces small thumbnails and screenshots', () => {
    const c = new Canvas(10, 10, [0, 0, 0, 255]);
    c.fillRect(2, 2, 3, 3, [255, 255, 255, 255]);
    expect(c.data[(3 * 10 + 3) * 4]).toBe(255);
    expect(c.data[(8 * 10 + 8) * 4]).toBe(0);
    const thumb = petThumbnailPng(42);
    expect(thumb.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(thumb.length).toBeLessThan(8000);
    const shot = screenshotPng({ width: 402, height: 874, platform: 'ios', dark: true, seed: 1 });
    expect(shot.readUInt32BE(16)).toBe(402);
    expect(shot.readUInt32BE(20)).toBe(874);
  });
});

describe('demo randomness and scheduling', () => {
  it('is deterministic for a seed', () => {
    const a = new Rng(7);
    const b = new Rng(7);
    const seqA = Array.from({ length: 5 }, () => a.int(0, 1000));
    const seqB = Array.from({ length: 5 }, () => b.int(0, 1000));
    expect(seqA).toEqual(seqB);
    expect(new Rng(7).fork(1).next()).toBe(new Rng(7).fork(1).next());
    expect(new Rng(7).fork(1).next()).not.toBe(new Rng(7).fork(2).next());
    const r = new Rng(3);
    for (let i = 0; i < 200; i++) {
      const n = r.int(2, 5);
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(5);
    }
    expect(r.uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const w = new Walk(50, 50, 0.5, 5, 0, 60);
    for (let i = 0; i < 100; i++) expect(w.step(r)).toBeLessThanOrEqual(60);
  });

  it('runs due tasks in time order with exact virtual timestamps and stops cleanly', () => {
    const errors: unknown[] = [];
    const s = new Scheduler(1_000_000, (e) => errors.push(e));
    s.start();
    const seen: string[] = [];
    let base = 0;
    s.after(0, () => {
      base = s.now(); // inside a task, now() is the planned (virtual) time
      s.after(30, () => seen.push(`b@${s.now() - base}`));
      s.after(10, () => seen.push(`a@${s.now() - base}`));
      s.after(10, () => {
        throw new Error('task failure is contained');
      });
      s.after(50, () => {
        seen.push(`c@${s.now() - base}`);
        s.after(5, () => seen.push(`d@${s.now() - base}`)); // chained from virtual time
      });
    });
    s.runDue(Date.now() + 500);
    expect(seen).toEqual(['a@10', 'b@30', 'c@50', 'd@55']);
    expect(errors).toHaveLength(1);
    s.after(10, () => seen.push('never'));
    s.stop();
    expect(s.pending).toBe(0);
    s.after(1, () => seen.push('ignored while stopped'));
    expect(s.pending).toBe(0);
  });

  it('never lags more than a second behind the wall clock (no catch-up floods after a stall)', () => {
    const s = new Scheduler(1_000_000, () => {});
    s.start();
    const base = Date.now();
    let runs = 0;
    s.repeat(
      () => 100,
      () => runs++,
    );
    s.runDue(base + 60_000); // the process was suspended for a minute
    expect(runs).toBeLessThanOrEqual(12);
    s.stop();
  });
});
