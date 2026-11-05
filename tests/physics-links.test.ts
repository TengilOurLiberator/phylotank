/** Grabs and jaw locks solved inside the substep loop (02 §2.4.4, REVIEW R6). */
import { describe, expect, it } from 'vitest';
import { KIND, ORGAN } from '../src/core/index.js';
import { drainFlags, linkState, LINK, physics, workFor } from '../src/physics/index.js';
import { chain, fish, kinetic, makePhenotype, makeWorld, nextTick, spawn } from '../src/physics/testkit.js';

describe('physics: links', () => {
  it('a claw grabs struggling prey, holds it without energy from nothing, and lets go', () => {
    const tw = makeWorld();
    const predBody = chain(3, 0.02, () => 0.005);
    predBody[0]!.organs = ORGAN.CLAW;
    const pred = spawn(tw, physics.loadBody, makePhenotype(predBody), 10, 5, 0);
    const prey = spawn(tw, physics.loadBody, makePhenotype(fish(6, 0.06)), 10.012, 5.0, Math.PI / 2);
    const w = tw.world; const sg = w.seg.c; const c = w.cr.c;
    sg.cmd2[c.segStart[pred]!] = 1;
    physics.step(w, tw.ctx); nextTick(tw);
    expect(linkState(w).links.length).toBe(1);
    expect(linkState(w).links[0]!.type).toBe(LINK.GRAB);
    let work = 0; let maxE = 0; let maxGap = 0;
    const E0 = kinetic(w, pred) + kinetic(w, prey);
    for (let k = 0; k < 90; k++) {
      for (let j = 1; j < 6; j++) sg.cmd[c.segStart[prey]! + j] = 0.4 * Math.sin(k * 0.6 - 0.9 * j);
      physics.step(w, tw.ctx); nextTick(tw);
      for (let j = 0; j < 6; j++) work += sg.work[c.segStart[prey]! + j]!;
      maxE = Math.max(maxE, kinetic(w, pred) + kinetic(w, prey));
      const l = linkState(w).links[0];
      if (l) {
        const ca = Math.cos(sg.angle[l.a]!); const sa = Math.sin(sg.angle[l.a]!);
        const cb = Math.cos(sg.angle[l.b]!); const sb = Math.sin(sg.angle[l.b]!);
        const gx = sg.posX[l.a]! + l.ax * ca - l.ay * sa - sg.posX[l.b]! - (l.bx * cb - l.by * sb);
        const gy = sg.posY[l.a]! + l.ax * sa + l.ay * ca - sg.posY[l.b]! - (l.bx * sb + l.by * cb);
        maxGap = Math.max(maxGap, Math.hypot(gx, gy));
      }
    }
    expect(linkState(w).links.length).toBe(1);
    expect(c.nSub[pred]).toBe(8);
    // contacts of the neighbouring segments push at tick rate (capped at 0.5 BL/s), the link pulls
    // back inside every substep: the end-of-tick stretch stays under 10% of a segment
    expect(maxGap).toBeLessThan(0.1 * 0.02);
    expect(maxE).toBeLessThan(E0 + work);
    expect(drainFlags(w)).toEqual([]);
    void workFor;
    sg.cmd2[c.segStart[pred]!] = 0;
    physics.step(w, tw.ctx); nextTick(tw);
    expect(linkState(w).links.length).toBe(0);
  });

  it('a successful bite locks the jaws until the bite drive drops', () => {
    const tw = makeWorld();
    const predBody = [
      { parent: -1, attachU: 0, restAngle: 0, length: 0.01, radius: 0.004, kind: KIND.MOUTH },
      { parent: 0, attachU: -0.5, restAngle: Math.PI, length: 0.02, radius: 0.004 },
    ];
    const a = spawn(tw, physics.loadBody, makePhenotype(predBody), 10, 5, 0);
    spawn(tw, physics.loadBody, makePhenotype(chain(2, 0.02, () => 0.004)), 10.012, 5, Math.PI / 2);
    const w = tw.world; const sg = w.seg.c;
    sg.cmd2[w.cr.c.segStart[a]!] = 1;
    physics.step(w, tw.ctx); nextTick(tw);
    expect(linkState(w).links.map((l) => l.type)).toEqual([LINK.JAW]);
    for (let k = 0; k < 10; k++) { physics.step(w, tw.ctx); nextTick(tw); }
    expect(linkState(w).links.length).toBe(1);
    sg.cmd2[w.cr.c.segStart[a]!] = 0.1;
    physics.step(w, tw.ctx); nextTick(tw);
    expect(linkState(w).links.length).toBe(0);
  });
});
