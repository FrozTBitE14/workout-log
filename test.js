// Tests for the workout-log logic. Run: node test.js
// The logic is extracted from index.html (between LOGIC START/END) so tests cover the exact code the app runs.
// All data here is made up; no personal CSVs are read.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const m = /\/\* LOGIC START \*\/([\s\S]*?)\/\* LOGIC END \*\//.exec(html);
if (!m) { console.error('LOGIC markers not found in index.html'); process.exit(1); }
const ctx = vm.createContext({});
vm.runInContext(m[1], ctx);
const WL = ctx.WL;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}
const near = (a, b, eps = 0.05, msg) => assert.ok(Math.abs(a - b) <= eps, msg || `${a} ≉ ${b}`);
// Values created inside the vm context have a different Array prototype; compare as plain JSON.
const eq = (a, b) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b);
const set = (w, r, extra = {}) => ({ w, r, warmup: false, done: true, ...extra });
const sets = (n, w, r) => Array.from({ length: n }, () => set(w, r));
const kindOfDefault = name => WL.detectKind(name);

// ---------- Formulas & rounding ----------
console.log('\nFormulas');
test('Epley e1RM', () => {
  near(WL.epley(100, 10), 133.33);
  assert.equal(WL.epley(200, 1), 200);
  assert.equal(WL.epley(0, 5), 0);
  assert.equal(WL.epley(100, 0), 0);
});
test('%1RM for reps', () => {
  near(WL.pctFor(8), 0.789, 0.001);
  assert.equal(WL.pctFor(1), 1);
});
test('round to load step', () => {
  assert.equal(WL.roundToStep(124.7, 5), 125);
  assert.equal(WL.roundToStep(122.5, 5), 125);
  assert.equal(WL.roundToStep(122.4, 5), 120);
  assert.equal(WL.roundToStep(123.7, 2.5), 122.5);
  assert.equal(WL.roundToStep(41.3, 10), 40);
  assert.equal(WL.roundToStep(0.1 * 3 * 100, 2.5), 30);
});
test('%1RM target + explanation ("1RM 150 × 79% for 8 reps")', () => {
  const t = WL.targetFor('weighted', 150, 8, 5);
  assert.equal(t.weight, 120);                // 150 × 78.9% rounds to 120
  const cfg = { sets: 3, lo: 8, hi: 10, step: 5 };
  const p = WL.newCycle('weighted', 150, cfg);
  assert.deepEqual([p.weight, p.reps], [120, 8]);
  const why = WL.explainProg('weighted', 150, cfg, p);
  assert.match(why, /1RM 150 × 79% for 8 reps → 120 lb \(locked\)/);
});

// ---------- Double progression ----------
console.log('\nDouble progression');
const cfg = { sets: 3, lo: 8, hi: 10, step: 5 };
test('weight stays locked while reps climb; live e1RM reported', () => {
  let prog = WL.newCycle('weighted', 150, cfg), R = 150;
  let r = WL.evaluateSession('weighted', cfg, prog, R, sets(3, 120, 8));
  assert.equal(r.action, 'reps-up');
  assert.deepEqual([r.prog.weight, r.prog.reps, r.oneRM], [120, 9, 150]);
  assert.ok(r.e1rm > 150, 'live e1RM computed even though weight is locked');
  r = WL.evaluateSession('weighted', cfg, r.prog, R, sets(3, 120, 9));
  assert.deepEqual([r.action, r.prog.weight, r.prog.reps, r.oneRM], ['reps-up', 120, 10, 150]);
});
test('top of range on all sets → new cycle, 1RM capped +5%, weight from bottom of range', () => {
  const r = WL.evaluateSession('weighted', cfg, WL.freshProg(120, 10), 150, sets(3, 120, 10));
  assert.equal(r.action, 'cycle-up');
  near(r.oneRM, 157.5);                  // e1RM 160 capped at 150 × 1.05
  assert.deepEqual([r.prog.weight, r.prog.reps, r.prog.stalls], [125, 8, 0]);
});
test('cycle end: 1RM never lowered, minimum +1 load step', () => {
  // Weak e1RM (133) relative to 1RM 200: 1RM must not fall; new weight comes from 200 at 8 reps.
  const r = WL.evaluateSession('weighted', cfg, WL.freshProg(100, 10), 200, sets(3, 100, 10));
  assert.equal(r.oneRM, 200);
  assert.equal(r.prog.weight, 160);
  // Cap result rounds to the same weight → still +1 step.
  const r2 = WL.evaluateSession('weighted', cfg, WL.freshProg(150, 10), 150, sets(3, 150, 10));
  near(r2.oneRM, 157.5);
  assert.equal(r2.prog.weight, 155);
});
test('missed reps → hold weight and rep target', () => {
  const r = WL.evaluateSession('weighted', cfg, WL.freshProg(120, 9), 150, [set(120, 9), set(120, 9), set(120, 7)]);
  assert.equal(r.action, 'hold');
  assert.deepEqual([r.prog.weight, r.prog.reps, r.oneRM], [120, 9, 150]);
});
test('warm-ups and lighter sets do not count', () => {
  const s = [set(60, 20, { warmup: true }), set(120, 8), set(120, 8), set(115, 8)];
  const r = WL.evaluateSession('weighted', cfg, WL.freshProg(120, 8), 150, s);
  assert.equal(r.action, 'hold');      // only 2 of 3 sets at the locked weight
  assert.equal(r.total, 16);
});
test('no working sets → no evaluation', () => {
  assert.equal(WL.evaluateSession('weighted', cfg, WL.freshProg(120, 8), 150, [set(60, 10, { warmup: true })]), null);
});

console.log('\nStall rule');
test('stall = total reps at same weight not improving; 3 in a row → deload 10%', () => {
  let prog = WL.freshProg(125, 8), R = 157.5;
  const run = reps => { const r = WL.evaluateSession('weighted', cfg, prog, R, reps.map(x => set(125, x))); prog = r.prog; R = r.oneRM; return r; };
  assert.equal(run([8, 8, 6]).action, 'hold');           // 22, nothing to compare
  let r = run([8, 7, 7]); assert.deepEqual([r.action, prog.stalls], ['stall', 1]);  // 22 = 22
  r = run([8, 7, 6]); assert.deepEqual([r.action, prog.stalls], ['stall', 2]);      // 21 < 22
  r = run([8, 8, 7]); assert.deepEqual([r.action, prog.stalls], ['hold', 0]);       // 23 > 21 resets
  run([8, 8, 7]); run([8, 8, 7]);
  assert.equal(prog.stalls, 2);
  r = run([8, 8, 7]);
  assert.equal(r.action, 'deload');
  near(r.oneRM, 141.8);                                   // 157.5 × 0.9
  assert.deepEqual([prog.weight, prog.reps, prog.stalls], [110, 8, 0]);  // restart at bottom of range
});
test('weight change resets stall comparison', () => {
  const prog = { ...WL.freshProg(135, 8), lastTotal: 30, lastWeight: 130, stalls: 2 };
  const r = WL.evaluateSession('weighted', cfg, prog, 170, [set(135, 8), set(135, 7), set(135, 6)]);
  assert.equal(r.action, 'hold');
  assert.equal(r.prog.stalls, 0);
});

// ---------- Assisted & bodyweight ----------
console.log('\nAssisted / bodyweight');
const bw = 172;
test('assisted target = bodyweight − %1RM load, rounded to step', () => {
  // effective 1RM 120 × 78.9% = 94.7 → assist 172 − 94.7 = 77.3 → 75
  assert.equal(WL.targetFor('assisted', 120, 8, 5, bw).weight, 75);
  assert.equal(WL.newCycle('assisted', 120, cfg, bw).weight, 75);
  near(WL.loadOf('assisted', 75, bw), 97, 1e-9);
});
test('assisted: more assistance than locked does not count; less does', () => {
  const prog = WL.freshProg(75, 8);
  assert.equal(WL.evaluateSession('assisted', cfg, prog, 120, sets(3, 80, 8), bw).action, 'hold');
  assert.equal(WL.evaluateSession('assisted', cfg, prog, 120, sets(3, 70, 8), bw).action, 'reps-up');
});
test('assisted cycle-up lowers assistance by at least one step', () => {
  const r = WL.evaluateSession('assisted', cfg, WL.freshProg(75, 10), 120, sets(3, 75, 10), bw);
  assert.equal(r.action, 'cycle-up');
  near(r.oneRM, 126);                    // e1 129.3 capped at 120 × 1.05
  assert.equal(r.prog.weight, 70);       // %1RM gives 75 (no change) → forced one step down
});
test('assisted deload adds assistance', () => {
  const prog = { ...WL.freshProg(70, 8), lastTotal: 20, lastWeight: 70, stalls: 2 };
  const r = WL.evaluateSession('assisted', cfg, prog, 126, [set(70, 8), set(70, 6), set(70, 6)], bw);
  assert.equal(r.action, 'deload');
  near(r.oneRM, 113.4);
  assert.equal(r.prog.weight, 80);
});
test('assisted without bodyweight falls back to step changes', () => {
  const up = WL.evaluateSession('assisted', cfg, WL.freshProg(45, 10), null, sets(3, 45, 10), null);
  assert.deepEqual([up.action, up.prog.weight], ['cycle-up', 40]);
  const dl = WL.evaluateSession('assisted', cfg, { ...WL.freshProg(40, 8), lastTotal: 24, lastWeight: 40, stalls: 2 }, null, sets(3, 40, 7), null);
  assert.deepEqual([dl.action, dl.prog.weight], ['deload', 45]);
});
test('bodyweight progression adds reps (no range cap), PR = most reps', () => {
  const p = WL.newCycle('bodyweight', null, cfg);
  assert.deepEqual([p.weight, p.reps], [0, 8]);
  const r = WL.evaluateSession('bodyweight', cfg, WL.freshProg(0, 10), null, sets(3, 0, 10));
  assert.deepEqual([r.action, r.prog.reps], ['reps-up', 11]);
  const pr = WL.sessionPRs('bodyweight', { reps: 12 }, [set(0, 12), set(0, 14)]);
  eq([...pr.labels.values()], [['reps']]);
});
test('equipment detection', () => {
  assert.equal(WL.detectEquipment('Bench Press (Barbell)'), 'barbell');
  assert.equal(WL.detectEquipment('Cable Straight Bar Wrist Curls on Cable'), 'cable');
  assert.equal(WL.detectEquipment('T Bar Row'), 'barbell');
  assert.equal(WL.detectEquipment('Shoulder Press (Machine Plates)'), 'machine');
  assert.equal(WL.detectEquipment('Lateral Raise (Dumbbell)'), 'dumbbell');
});

// ---------- PRs ----------
console.log('\nPRs');
test('weighted PRs vs prior sessions; only best set marked; warm-ups ignored', () => {
  const { labels, rec } = WL.sessionPRs('weighted', { weight: 135, e1rm: 170 },
    [set(225, 1, { warmup: true }), set(140, 5), set(130, 12)]);
  const got = [...labels.entries()].map(([s, l]) => `${s.w}x${s.r}:${l.join('+')}`);
  assert.deepEqual(got, ['140x5:weight', '130x12:e1rm']); // 130×12 = 182 > 140×5 = 163.3
  assert.equal(rec.weight, 140);
});
test('first session sets a baseline, not PRs', () => {
  const r = WL.sessionPRs('weighted', {}, [set(100, 5)]);
  assert.equal(r.labels.size, 0);
  assert.equal(r.rec.weight, 100);
});
test('assisted PRs: lower assistance and higher effective e1RM win', () => {
  const r = WL.sessionPRs('assisted', { assist: 40, e1rm: 120 }, [set(35, 6), set(45, 8)], bw);
  const got = [...r.labels.entries()].map(([s, l]) => `${s.w}:${l.join('+')}`);
  assert.deepEqual(got, ['35:assist+e1rm']); // (172 − 35) × 1.2 = 164.4
  const none = WL.sessionPRs('assisted', { assist: 40, e1rm: 200 }, [set(50, 8)], bw);
  assert.equal(none.labels.size, 0);
});

// ---------- CSV import ----------
console.log('\nHevy CSV import');
const HEAD = '"title","start_time","end_time","description","exercise_title","superset_id","exercise_notes","set_index","set_type","weight_lbs","reps","distance_km","duration_seconds","rpe"';
const row = (title, start, ex, idx, type, w, r, extra = {}) =>
  `"${title}","${start}","${start}","${extra.desc ?? ''}","${ex}",,"${extra.notes ?? ''}",${idx},"${type}",${w ?? ''},${r ?? ''},,${extra.dur ?? ''},${extra.rpe ?? ''}`;
const T1 = '14 Mar 2024, 18:20';
const CSV1 = [HEAD,
  row('Push A', T1, 'Bench Press (Barbell)', 0, 'warmup', 45, 10),
  row('Push A', T1, 'Bench Press (Barbell)', 1, 'normal', 135, 8, { rpe: 8 }),
  row('Push A', T1, 'Bench Press (Barbell)', 2, 'normal', 135, 7, { notes: 'felt ""heavy"", ok' }),
  row('Push A', T1, 'Chest Dip (Assisted)', 0, 'normal', 40, 8),
  row('Push A', T1, 'Bench Press (Barbell)', 0, 'normal', 95, 12), // second block of bench
  row('Push A', T1, 'Treadmill', 0, 'normal', '', '', { dur: 600 }),
  row('Legs, Core', '2 Jan 2024, 07:05', 'Hanging Leg Raise', 0, 'normal', '', 12),
].join('\r\n') + '\r\n';
test('parseHevyDate', () => {
  assert.equal(WL.parseHevyDate(T1), '2024-03-14T18:20');
  assert.equal(WL.parseHevyDate('2 Jan 2024, 07:05'), '2024-01-02T07:05');
  assert.equal(WL.parseHevyDate('garbage'), null);
});
test('CSV parser handles quotes, escaped quotes, commas, CRLF, blank fields', () => {
  const rows = WL.parseCSV(CSV1);
  assert.equal(rows.length, 7);
  assert.equal(rows[2].exercise_notes, 'felt "heavy", ok');
  assert.equal(rows[6].title, 'Legs, Core');
  assert.equal(rows[5].weight_lbs, '');
});
test('import groups workouts, flags warm-ups, keeps repeated exercise blocks distinct', () => {
  const ws = WL.parseHevyWorkoutsCSV(CSV1);
  assert.equal(ws.length, 2);
  assert.equal(ws[0].title, 'Legs, Core');             // sorted by date
  const push = ws[1];
  assert.equal(push.id, '2024-03-14T18:20|Push A');
  eq(push.exercises.map(e => `${e.name}#${e.occ}`),
    ['Bench Press (Barbell)#0', 'Chest Dip (Assisted)#0', 'Bench Press (Barbell)#1', 'Treadmill#0']);
  assert.equal(push.exercises[0].sets[0].warmup, true);
  assert.equal(push.exercises[0].sets[1].rpe, 8);
  const ids = push.exercises.flatMap(e => e.sets.map(s => s.id));
  assert.equal(new Set(ids).size, ids.length, 'set ids unique');
});
test('kind detection: assisted, bodyweight, cardio, weighted', () => {
  const ws = WL.parseHevyWorkoutsCSV(CSV1);
  const setsOf = n => ws.flatMap(w => w.exercises.filter(e => e.name === n).flatMap(e => e.sets));
  assert.equal(WL.detectKind('Chest Dip (Assisted)', setsOf('Chest Dip (Assisted)')), 'assisted');
  assert.equal(WL.detectKind('Hanging Leg Raise', setsOf('Hanging Leg Raise')), 'bodyweight');
  assert.equal(WL.detectKind('Treadmill', setsOf('Treadmill')), 'cardio');
  assert.equal(WL.detectKind('Bench Press (Barbell)', setsOf('Bench Press (Barbell)')), 'weighted');
});
test('merge without duplicates; re-import adds nothing; new sets merge in', () => {
  const ws = WL.parseHevyWorkoutsCSV(CSV1);
  const a = WL.mergeWorkouts([], ws);
  assert.deepEqual([a.added, a.workouts.length], [2, 2]);
  const b = WL.mergeWorkouts(a.workouts, WL.parseHevyWorkoutsCSV(CSV1));
  assert.deepEqual([b.added, b.addedSets, b.workouts.length], [0, 0, 2]);
  const extra = CSV1 + row('Push A', T1, 'Chest Dip (Assisted)', 1, 'normal', 40, 7) + '\n';
  const c = WL.mergeWorkouts(b.workouts, WL.parseHevyWorkoutsCSV(extra));
  assert.deepEqual([c.added, c.addedSets], [0, 1]);
  assert.equal(c.workouts[1].exercises[1].sets.length, 2);
});
test('Hevy API workouts get the same ids as CSV rows (cross-source dedupe, kg → lb)', () => {
  const api = {
    title: 'Push A', start_time: new Date(2024, 2, 14, 18, 20).toISOString(),
    exercises: [{ title: 'Bench Press (Barbell)', sets: [{ index: 0, type: 'warmup', weight_kg: 20.41166, reps: 10 }, { index: 1, type: 'normal', weight_kg: 61.23497, reps: 8 }] }],
  };
  const w = WL.fromHevyApi(api);
  assert.equal(w.id, '2024-03-14T18:20|Push A');
  near(w.exercises[0].sets[1].w, 135, 0.01);
  const merged = WL.mergeWorkouts(WL.parseHevyWorkoutsCSV(CSV1), [w]);
  assert.deepEqual([merged.added, merged.addedSets], [0, 0]);
});
test('measurements + bodyweight lookup', () => {
  const bws = WL.parseMeasurements('"date","weight_lbs","fat_percent"\n"5 May 2023, 00:00",180,\n"9 Sep 2024, 00:00",173.5,\n"1 Jan 2024, 00:00",176,\n');
  eq(bws.map(b => b.date), ['2023-05-05', '2024-01-01', '2024-09-09']);
  assert.equal(WL.bwAt(bws, '2023-01-01T10:00'), 180);   // before first → earliest
  assert.equal(WL.bwAt(bws, '2024-05-01T10:00'), 176);
  assert.equal(WL.bwAt(bws, '2024-12-01T10:00'), 173.5);
  assert.equal(WL.bwAt([], '2024-12-01', 172), 172);
});

// ---------- Starting 1RMs ----------
console.log('\nStarting 1RMs');
function wk(date, name, ss, title = 'T') {
  return { id: `${date}|${title}|${name}`, date, title, exercises: [{ name, occ: 0, sets: ss }] };
}
test('recent 12-week best preferred, × 0.85, reps > 12 and warm-ups excluded', () => {
  const ws = [
    wk('2023-06-01T10:00', 'Bench Press (Barbell)', [set(185, 5)]),                       // all-time 215.8
    wk('2023-12-10T10:00', 'Bench Press (Barbell)', [set(165, 5), set(100, 20), set(250, 1, { warmup: true })]), // 192.5 recent
    wk('2024-02-20T09:30', 'Bench Press (Barbell)', [set(155, 8)]),                       // 196.3 recent best
  ];
  const r = WL.startingOneRMs(ws, kindOfDefault, [], {})['Bench Press (Barbell)'];
  near(r.allTime, 215.8); near(r.recent, 196.3);
  assert.equal(r.source, 'recent');
  assert.equal(r.flagged, false);
  near(r.start, 196.3 * 0.85, 0.06);
  assert.equal(r.cutoff, '2023-11-28T09:30');
});
test('outlier flag when all-time > 1.4 × recent (e.g. 100 vs 40)', () => {
  const ws = [
    wk('2023-03-01T10:00', 'Lateral Raise (Dumbbell)', [set(100, 1)]),
    wk('2024-02-20T10:00', 'Lateral Raise (Dumbbell)', [set(40, 1)]),
  ];
  const r = WL.startingOneRMs(ws, kindOfDefault, [], {})['Lateral Raise (Dumbbell)'];
  assert.deepEqual([r.allTime, r.recent, r.flagged], [100, 40, true]);
  near(r.start, 34);
  const ok = WL.startingOneRMs([ws[0], wk('2024-02-20T10:00', 'Lateral Raise (Dumbbell)', [set(75, 1)])], kindOfDefault, [], {});
  assert.equal(ok['Lateral Raise (Dumbbell)'].flagged, false); // 100 < 1.4 × 75
});
test('falls back to all-time when no recent data', () => {
  const ws = [
    wk('2023-01-01T10:00', 'Squat (Barbell)', [set(225, 5)]),
    wk('2024-02-20T10:00', 'Bench Press (Barbell)', [set(135, 5)]),
  ];
  const r = WL.startingOneRMs(ws, kindOfDefault, [], {})['Squat (Barbell)'];
  assert.equal(r.source, 'all-time');
  assert.equal(r.recent, null);
  near(r.start, 262.5 * 0.85);
});
test('assisted starting 1RM uses bodyweight at the time minus assistance', () => {
  const bws = [{ date: '2024-01-01', w: 160 }];
  const ws = [wk('2024-02-20T10:00', 'Pull Up (Assisted)', [set(50, 10)])];
  const r = WL.startingOneRMs(ws, kindOfDefault, bws, {})['Pull Up (Assisted)'];
  near(r.base, 146.7);                     // (160 − 50) × 1.333
});

// ---------- Program draft ----------
console.log('\nStarter program');
test('draft picks most-used titles, frequent exercises, typical sets and reps', () => {
  const ws = [];
  for (let i = 0; i < 4; i++) {
    ws.push({ id: `p${i}`, date: `2024-01-0${i + 1}T10:00`, title: 'Push', exercises: [
      { name: 'Bench Press (Barbell)', sets: [set(45, 10, { warmup: true }), ...sets(3, 135, 8)] },
      { name: 'Lateral Raise (Dumbbell)', sets: sets(3, 20, 12) },
      ...(i === 0 ? [{ name: 'Rare Thing', sets: sets(2, 10, 10) }] : []),
    ] });
  }
  ws.push({ id: 'l0', date: '2024-01-10T10:00', title: 'Legs', exercises: [{ name: 'Squat (Barbell)', sets: sets(4, 185, 5) }] });
  ws.push({ id: 'x0', date: '2024-01-11T10:00', title: 'Cardio', exercises: [{ name: 'Treadmill', sets: [{ dur: 600, done: true }] }] });
  const prog = WL.draftProgram(ws, n => n === 'Treadmill' ? 'cardio' : 'weighted', { days: 2 });
  eq(prog.days.map(d => d.name), ['Push', 'Legs']);              // Cardio-only day skipped
  const push = prog.days[0].items;
  eq(push.map(i => i.name), ['Bench Press (Barbell)', 'Lateral Raise (Dumbbell)']); // Rare Thing < 40%
  assert.deepEqual([push[0].sets, push[0].lo, push[0].hi, push[0].rest, push[0].step], [3, 8, 10, 150, 5]);
  assert.deepEqual([push[1].lo, push[1].hi, push[1].rest], [12, 14, 90]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
