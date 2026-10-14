// Tests for the shared count format, browser sessions and the station's storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DayBins, wallParts, weekday, addDays } from '../js/core/countdata.js';
import { sessionDays } from '../js/sessions.js';
import { CountStore } from '../station/lib/store.mjs';
import { validateLines } from '../station/lib/server.mjs';
import { encodePng } from '../station/lib/png.mjs';

test('wall-clock parts in a time zone, including DST change', () => {
  // 2026-03-29 is the spring DST change in Vilnius (UTC+2 -> UTC+3 at 03:00 local)
  assert.deepEqual(
    { ...wallParts(new Date('2026-03-29T00:30:00Z'), 'Europe/Vilnius'), minute: 0, second: 0 },
    { date: '2026-03-29', hour: 2, minute: 0, second: 0 },
  );
  assert.equal(wallParts(new Date('2026-03-29T01:30:00Z'), 'Europe/Vilnius').hour, 4);
  assert.equal(wallParts(new Date('2026-10-13T21:30:00Z'), 'Europe/Vilnius').date, '2026-10-14');
  assert.equal(wallParts(new Date(Date.UTC(2026, 9, 14, 7, 5, 9)), null).hour, 7);
  assert.equal(weekday('2026-10-14'), 2); // Wednesday
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('day bins round-trip through JSON', () => {
  const d = new DayBins('2026-10-14');
  d.add(8, 'gate', 'in', 2, 3);
  d.add(8, 'gate', 'in', 2, 1);
  d.add(17, 'gate', 'out', 7);
  d.addCoverage(8, 1800);
  d.addCoverage(8, 3000); // capped at a full hour
  const j = JSON.parse(JSON.stringify(d));
  assert.deepEqual(j.rows, [
    [8, 'gate', 'in', 2, 4],
    [17, 'gate', 'out', 7, 1],
  ]);
  assert.deepEqual(j.coverage, [[8, 3600]]);
  const back = DayBins.fromJSON(j);
  assert.equal(back.total(), 5);
});

test('browser session becomes hourly bins, spans split across hours', () => {
  const s = {
    start: new Date(Date.UTC(2026, 9, 14, 16, 50, 0)).toISOString(), // 16:50 wall clock
    events: [
      [60, 'gate', 'in', 2], // 16:51
      [700, 'gate', 'out', 7], // 17:01:40
    ],
    spans: [[0, 1200]], // 16:50 -> 17:10
  };
  const days = sessionDays(s);
  const d = days.get('2026-10-14');
  assert.equal(d.total(), 2);
  assert.equal(Math.round(d.coverage[16]), 600);
  assert.equal(Math.round(d.coverage[17]), 600);
  assert.equal(sessionDays({ ...s, start: null }), null);
});

test('station store keeps counts, coverage and event CSV across restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-store-'));
  const st = new CountStore({ dir, timeZone: 'Europe/Vilnius', name: 'Test' });
  st.setClasses(['person', 'bicycle', 'car']);
  const t = new Date('2026-10-14T06:15:00Z'); // 09:15 in Vilnius
  st.addEvent({ time: t, lineId: 'gate', lineName: 'Gate, north', dir: 'in', cls: 2, trackId: 7 });
  st.addEvent({ time: t, lineId: 'gate', lineName: 'Gate, north', dir: 'out', cls: 2, trackId: 8 });
  st.addCoverage(new Date('2026-10-14T06:00:30Z'), 90); // crosses into the 08:00 hour
  st.flush({ online: true });
  const day = JSON.parse(readFileSync(join(dir, 'days', '2026-10-14.json'), 'utf8'));
  assert.deepEqual(day.rows, [
    [9, 'gate', 'in', 2, 1],
    [9, 'gate', 'out', 2, 1],
  ]);
  const cov = Object.fromEntries(day.coverage);
  assert.equal(cov[9], 31);
  assert.equal(cov[8], 59);
  const csv = readFileSync(join(dir, 'events', '2026-10-14.csv'), 'utf8');
  assert.match(csv, /2026-10-14 09:15:00,"Gate, north",in,7,car/);
  // restart: a new store continues from the files
  const st2 = new CountStore({ dir, timeZone: 'Europe/Vilnius', name: 'Test' });
  st2.addEvent({ time: t, lineId: 'gate', lineName: 'Gate, north', dir: 'in', cls: 2, trackId: 9 });
  const idx = st2.index({});
  assert.equal(idx.days[0].total, 3);
  assert.equal(idx.lines[0].name, 'Gate, north');
  assert.ok(existsSync(join(dir, 'index.json')));
});

test('line validation rejects bad input', () => {
  assert.throws(() => validateLines([{ a: { x: 2, y: 0 }, b: { x: 0, y: 0 } }]));
  assert.throws(() => validateLines('nope'));
  const ok = validateLines([{ id: 'a b', name: 'X', a: { x: 0.1, y: 0.2 }, b: { x: 0.3, y: 0.4 } }]);
  assert.equal(ok[0].id, 'a_b');
});

test('png encoder writes a valid header', () => {
  const png = encodePng(Buffer.alloc(4 * 3 * 3, 128), 4, 3);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 4);
  assert.equal(png.readUInt32BE(20), 3);
});

test('publisher replaces the data branch with one commit each time', async () => {
  const { createServer } = await import('node:http');
  const { GitHubPublisher } = await import('../station/lib/publish.mjs');
  const calls = [];
  let ref = null;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = body ? JSON.parse(body) : null;
      calls.push([req.method, req.url, j]);
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'GET' && req.url.endsWith('/git/ref/heads/data')) return ref ? send(200, { object: { sha: ref } }) : send(404, {});
      if (req.method === 'GET' && req.url.includes('/git/commits/')) return send(200, { tree: { sha: 'tree-old' } });
      if (req.method === 'POST' && req.url.endsWith('/git/trees')) return send(201, { sha: 'tree-new' });
      if (req.method === 'POST' && req.url.endsWith('/git/commits')) return send(201, { sha: `commit-${calls.length}` });
      if (req.url.endsWith('/git/refs') || req.url.endsWith('/git/refs/heads/data')) {
        ref = j.sha;
        return send(200, { ref: 'refs/heads/data' });
      }
      send(500, {});
    });
  });
  await new Promise((r) => server.listen(0, r));
  const pub = new GitHubPublisher({ repo: 'me/cc', branch: 'data', token: 't', apiBase: `http://127.0.0.1:${server.address().port}` });
  await pub.publish({ 'index.json': '{}', 'days/2026-10-14.json': '{"rows":[]}' });
  await pub.publish({ 'index.json': '{"v":2}' });
  server.close();
  const trees = calls.filter((c) => c[1].endsWith('/git/trees'));
  assert.equal(trees[0][2].base_tree, undefined);
  assert.deepEqual(trees[0][2].tree.map((t) => t.path), ['counts/index.json', 'counts/days/2026-10-14.json']);
  assert.equal(trees[1][2].base_tree, 'tree-old'); // keeps earlier day files
  const commits = calls.filter((c) => c[1].endsWith('/git/commits'));
  assert.ok(commits.every((c) => c[2].parents.length === 0)); // no history growth
  const patch = calls.find((c) => c[0] === 'PATCH');
  assert.equal(patch[2].force, true);
  assert.equal(pub.rawBase, 'https://raw.githubusercontent.com/me/cc/data/counts/');
});
