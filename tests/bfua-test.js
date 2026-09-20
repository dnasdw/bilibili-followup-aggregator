// Offline test harness for bilibili-followup-aggregator.user.js
// Loads the userscript in a vm sandbox (no DOM/GM -> init skipped) and
// exercises the pure Core functions with realistic feed/space payloads.

'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'bilibili-followup-aggregator.user.js');

let passed = 0;
let failed = 0;

function assertEq(actual, expected, label) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { passed++; console.log(`  ok - ${label}`); }
    else { failed++; console.error(`  FAIL - ${label}\n    expected: ${e}\n    actual:   ${a}`); }
}

function assertOk(cond, label) {
    if (cond) { passed++; console.log(`  ok - ${label}`); }
    else { failed++; console.error(`  FAIL - ${label}`); }
}

// ---- load userscript into sandbox ----
const src = fs.readFileSync(SCRIPT, 'utf8');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: path.basename(SCRIPT) });

const Core = sandbox.window.__bfuaCore;
assertOk(Core && typeof Core.parseFeedPage === 'function', 'Core exposed on window.__bfuaCore, init skipped without DOM');

// ---- date conversion ----
console.log('\n# date helpers');
assertEq(Core.dateStrToTs('2025-01-01'), 1735660800, '2025-01-01 00:00 +08 -> 1735660800');
assertEq(Core.dateStrToTs('bad'), 0, 'invalid date -> 0');
assertEq(Core.dateStrToTs(''), 0, 'empty date -> 0');
assertEq(Core.fmtDate(1735660800), '2025-01-01', 'fmtDate roundtrip');
assertEq(Core.fmtDateTime(1735660800 + 3661), `${Core.fmtDate(1735660800 + 3661)} 01:01`, 'fmtDateTime hh:mm');

// ---- parseFeedPage ----
console.log('\n# parseFeedPage');

const sinceTs = Core.dateStrToTs('2025-01-01');

function dyn(id, type, opts) {
    opts = opts || {};
    return {
        id_str: String(id),
        type,
        modules: {
            module_author: {
                mid: opts.upMid || 42, name: opts.upName || 'tester', pub_ts: opts.pubTs || 0,
                face: opts.face !== undefined ? opts.face : 'http://i2.hdslb.com/bfs/face/abc.jpg',
            },
            module_dynamic: { major: opts.major === null ? null : (opts.major || { archive: {
                aid: '1', bvid: opts.bvid || 'BV1test', title: opts.title || 'a video',
                duration_text: opts.dur || '10:00', badge: { text: opts.badge || '投稿视频' },
                cover: opts.cover !== undefined ? opts.cover : 'http://i2.hdslb.com/bfs/archive/xyz.jpg',
            } }) },
            ...(opts.pinned ? { module_tag: { text: '置顶' } } : {}),
        },
    };
}

const pageJson = {
    code: 0,
    data: {
        has_more: true,
        offset: '999888777',
        items: [
            // pinned old video dynamic (2024) -> excluded from videos AND from oldestTs
            dyn(1, 'DYNAMIC_TYPE_AV', { pinned: true, pubTs: Core.dateStrToTs('2024-06-01'), bvid: 'BVpin' }),
            // valid video dynamic in range
            dyn(2, 'DYNAMIC_TYPE_AV', { pubTs: Core.dateStrToTs('2025-03-14'), bvid: 'BVok1', title: 'ok1', upName: 'UPA' }),
            // draw dynamic -> skipped
            dyn(3, 'DYNAMIC_TYPE_DRAW', { pubTs: Core.dateStrToTs('2025-03-13'), major: { draw: { id: 1 } } }),
            // forward -> skipped
            dyn(4, 'DYNAMIC_TYPE_FORWARD', { pubTs: Core.dateStrToTs('2025-03-12') }),
            // AV without archive -> skipped
            dyn(5, 'DYNAMIC_TYPE_AV', { pubTs: Core.dateStrToTs('2025-03-11'), major: null }),
            // AV older than sinceTs -> skipped from videos, counted in oldestTs
            dyn(6, 'DYNAMIC_TYPE_AV', { pubTs: Core.dateStrToTs('2024-12-31'), bvid: 'BVold' }),
            // AV missing pub_ts -> skipped
            dyn(7, 'DYNAMIC_TYPE_AV', { pubTs: 0, bvid: 'BVnots' }),
        ],
    },
};

const page = Core.parseFeedPage(pageJson, sinceTs);
assertEq(page.videos.length, 1, 'only in-range AV items collected');
assertEq(page.videos[0].bvid, 'BVok1', 'collected bvid');
assertEq(page.videos[0].badge, '投稿视频', 'badge captured');
assertEq(page.videos[0].url, 'https://www.bilibili.com/video/BVok1', 'url built');
assertEq(page.videos[0].upMid, '42', 'upMid stringified');
assertEq(page.videos[0].face, undefined, 'face NOT stored per video (v2 structure)');
assertEq(page.videos[0].upName, undefined, 'upName NOT stored per video (v2 structure)');
assertEq(page.ups['42'], { name: 'UPA', face: 'https://i2.hdslb.com/bfs/face/abc.jpg' }, 'per-UP table entry (face http->https)');
assertEq(page.oldestTs, Core.dateStrToTs('2024-12-31'), 'oldestTs ignores pinned, includes non-pinned old item');
assertEq(page.hasMore, true, 'hasMore passthrough');
assertEq(page.offset, '999888777', 'offset passthrough');

// empty / broken payloads
assertEq(Core.parseFeedPage({}, sinceTs).videos, [], 'empty json tolerated');
assertEq(Core.parseFeedPage(null, sinceTs).videos, [], 'null json tolerated');
assertEq(Core.parseFeedPage({ data: { items: null } }, sinceTs).oldestTs, 0, 'null items -> oldestTs 0');
assertEq(Core.parseFeedPage({}, sinceTs).ups, {}, 'ups table present on empty page');

// pinned video that IS in range gets collected
const pinPage = Core.parseFeedPage({ data: { items: [
    dyn(1, 'DYNAMIC_TYPE_AV', { pinned: true, pubTs: Core.dateStrToTs('2025-02-01'), bvid: 'BVpinnew' }),
] } }, sinceTs);
assertEq(pinPage.videos.length, 1, 'pinned video in range still collected');

// ---- shouldStopPaging ----
console.log('\n# shouldStopPaging');
assertEq(Core.shouldStopPaging({ hasMore: false, offset: 'x', oldestTs: 0 }, sinceTs), true, 'no more -> stop');
assertEq(Core.shouldStopPaging({ hasMore: true, offset: '', oldestTs: 0 }, sinceTs), true, 'empty offset -> stop');
assertEq(Core.shouldStopPaging({ hasMore: true, offset: 'x', oldestTs: Core.dateStrToTs('2024-12-01') }, sinceTs), true, 'page went older than sinceTs -> stop');
assertEq(Core.shouldStopPaging({ hasMore: true, offset: 'x', oldestTs: Core.dateStrToTs('2025-06-01') }, sinceTs), false, 'still newer -> continue');
assertEq(Core.shouldStopPaging({ hasMore: true, offset: 'x', oldestTs: 0 }, sinceTs), false, 'oldestTs unknown -> continue (safety)');

// ---- mergeVideos ----
console.log('\n# mergeVideos');
const map = {};
assertEq(Core.mergeVideos(map, [page.videos[0]]), 1, 'first insert counts');
assertEq(Core.mergeVideos(map, [page.videos[0]]), 0, 'duplicate bvid not re-added');
assertEq(Object.keys(map).length, 1, 'map size stable');
// backfill: legacy entry (no cover) gets it from a newer scan
const legacy = { bvid: 'BVold1', title: 'old', pubTs: 1, cover: '' };
const newer = { bvid: 'BVold1', title: 'old', pubTs: 1, cover: 'https://x/cover.jpg' };
Core.mergeVideos(map, [legacy]);
assertEq(Core.mergeVideos(map, [newer]), 0, 'backfill does not count as new');
assertEq(map.BVold1.cover, 'https://x/cover.jpg', 'cover backfilled on legacy entry');

// ---- mergeUps ----
console.log('\n# mergeUps');
const ups = {};
Core.mergeUps(ups, { '1': { name: 'UP甲', face: 'https://x/1.jpg' } });
assertEq(ups['1'], { mid: '1', name: 'UP甲', face: 'https://x/1.jpg' }, 'new up entry created');
Core.mergeUps(ups, { '1': { name: 'UP甲改名', face: '' } });
assertEq(ups['1'].name, 'UP甲改名', 'rename refreshed on re-scan');
assertEq(ups['1'].face, 'https://x/1.jpg', 'empty face does not clobber existing');
// lastTs must survive mergeUps refreshes
ups['1'].lastTs = 1700000000;
Core.mergeUps(ups, { '1': { name: '又一次改名', face: 'https://x/new.jpg' } });
assertEq(ups['1'].lastTs, 1700000000, 'lastTs preserved by mergeUps');
assertEq(ups['1'].name, '又一次改名', 'name still refreshes');

// ---- incSinceTs (per-UP incremental bound) ----
console.log('\n# incSinceTs');
const GLOBAL_FLOOR = Core.dateStrToTs('2025-01-01');
const LAST_SCAN = Core.dateStrToTs('2026-09-19');
assertEq(Core.incSinceTs({ lastTs: 1700000000 }, GLOBAL_FLOOR, LAST_SCAN), 1700000000, 'v1.5+ UP -> own lastTs wins');
assertEq(Core.incSinceTs({ name: 'x' }, GLOBAL_FLOOR, LAST_SCAN), LAST_SCAN, 'legacy UP (entry, no lastTs) -> global lastScanTs');
assertEq(Core.incSinceTs({}, GLOBAL_FLOOR, LAST_SCAN), LAST_SCAN, 'empty entry object treated as legacy UP');
assertEq(Core.incSinceTs(undefined, GLOBAL_FLOOR, LAST_SCAN), GLOBAL_FLOOR, 'new UP (no entry) -> global backfill floor');
// floor 0 = scan-to-bottom: sinceTs 0 collects everything, paging stops only at has_more=false
assertEq(Core.incSinceTs(undefined, 0, LAST_SCAN), 0, 'new UP with floor 0 -> bound 0 (scan to very first dynamic)');
assertEq(Core.shouldStopPaging({ hasMore: true, offset: 'x', oldestTs: 1 }, 0), false, 'bound 0 keeps paging while has_more');
assertEq(Core.parseFeedPage({ data: { items: [dyn(9, 'DYNAMIC_TYPE_AV', { pubTs: 946684800, bvid: 'BVancient' })] } }, 0).videos.length, 1, 'bound 0 collects ancient dynamics');

// ---- migrateV1ToV2 ----
console.log('\n# migrateV1ToV2');
const v1 = {
    version: 1,
    videos: {
        a: { bvid: 'a', upMid: '1', upName: 'X', face: 'https://f/1.jpg', pubTs: 1 },
        b: { bvid: 'b', upMid: '1', upName: 'X', face: '', pubTs: 2 },
        c: { bvid: 'c', upMid: '2', upName: 'Y', face: 'https://f/2.jpg', pubTs: 3 },
    },
};
const v2 = Core.migrateV1ToV2(v1);
assertEq(v2.version, 2, 'version bumped');
assertEq(v2.ups['1'], { mid: '1', name: 'X', face: 'https://f/1.jpg' }, 'deduped up entry, face from first non-empty');
assertEq(v2.ups['2'].name, 'Y', 'second up entry');
assertEq(v2.videos.a.upName !== undefined || v2.videos.a.face !== undefined, false, 'videos slimmed (no upName/face)');

// ---- sortedList ----
console.log('\n# sortedList');
const list = Core.sortedList({
    a: { bvid: 'a', pubTs: 100 },
    b: { bvid: 'b', pubTs: 300 },
    c: { bvid: 'c', pubTs: 200 },
});
assertEq(list.map((v) => v.bvid), ['b', 'c', 'a'], 'sorted newest first');

// ---- parseFollowings ----
console.log('\n# parseFollowings');
const f = Core.parseFollowings({ data: { total: 2, list: [{ mid: 1, uname: 'a' }, { mid: 2, uname: 'b' }] } });
assertEq(f.total, 2, 'total');
assertEq(f.list[1].mid, '2', 'mid stringified');
assertEq(Core.parseFollowings({}).list, [], 'missing list tolerated');

// ---- md5 (RFC 1321 vectors) ----
console.log('\n# md5');
assertEq(Core.md5(''), 'd41d8cd98f00b204e9800998ecf8427e', "md5('')");
assertEq(Core.md5('abc'), '900150983cd24fb0d6963f7d28e17f72', "md5('abc')");
assertEq(Core.md5('The quick brown fox jumps over the lazy dog'), '9e107d9d372bb6826bd81d3542a419d6', 'md5(pangram)');
assertEq(Core.md5('中文测试'), require('crypto').createHash('md5').update('中文测试', 'utf8').digest('hex'), 'md5(utf8) matches node crypto');

// ---- wbi signing (official test vector from bilibili-API-collect wbi.md) ----
console.log('\n# wbi signing');
const IMG_KEY = '7cd084941338484aae1ad9425b84077c'; // NOTE: ends with 77c (easy to mis-copy from truncated search snippets)
const SUB_KEY = '4932caff0ff746eab6f01bf08b70ac45';
const mixinKey = Core.wbiMixinKey(IMG_KEY, SUB_KEY);
assertEq(mixinKey, 'ea1db124af3c7062474693fa704f4ff8', 'mixin key (official vector)');

const signed = Core.wbiSignedQuery({ foo: '114', bar: '514', zab: 1919810 }, mixinKey, 1702204169);
assertEq(signed, 'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4', 'full signed query (official vector)');

// encoding rules: uppercase %XX, %20 for space, CJK percent-encoded
assertEq(Core._wbiEncode('one one four'), 'one%20one%20four', 'space -> %20');
assertEq(Core._wbiEncode('五一四'), '%E4%BA%94%E4%B8%80%E5%9B%9B', 'CJK uppercase percent encoding');
// value chars !'()* filtered
const signedFiltered = Core.wbiSignedQuery({ k: "a!'()*b" }, mixinKey, 1702204169);
assertOk(signedFiltered.startsWith('k=ab&wts='), "chars !'()* stripped from values");

// ---- buildFromVideoList / mergeStateForImport (JSON import) ----
console.log('\n# import');
const expList = [
    { bvid: 'a', title: 'A', pubTs: 100, upMid: '1', upName: 'UP1', face: 'https://f/1.jpg', cover: 'https://c/a.jpg' },
    { bvid: 'b', title: 'B', pubTs: 200, upMid: '1', upName: 'UP1', face: 'https://f/1.jpg', cover: '' },
    { bvid: 'c', title: 'C', pubTs: 300, upMid: '2', upName: 'UP2', face: 'https://f/2.jpg', cover: 'https://c/c.jpg' },
    { bvid: '', title: 'broken', pubTs: 1 }, // skipped
];
const built = Core.buildFromVideoList(expList);
assertEq(Object.keys(built.videos).length, 3, 'invalid rows skipped');
assertEq(built.videos.a.upName !== undefined || built.videos.a.face !== undefined, false, 'redundant up fields stripped from videos');
assertEq(built.ups['1'], { mid: '1', name: 'UP1', face: 'https://f/1.jpg' }, 'ups table rebuilt, deduped');
assertEq(built.ups['2'].name, 'UP2', 'second up captured');

const local = { version: 2, videos: { b: { bvid: 'b', pubTs: 200, upMid: '1', cover: 'https://c/local.jpg' } }, ups: { '1': { mid: '1', name: '旧名', face: '', lastTs: 1000 } }, globalFloorTs: 0, lastScanTs: 1000 };
const added = Core.mergeStateForImport(local, {
    videos: built.videos,
    ups: { '1': { mid: '1', name: 'UP1', face: 'https://f/1.jpg', lastTs: 5000 }, '9': { mid: '9', name: '新UP', face: '', lastTs: 3000 } },
    globalFloorTs: Core.dateStrToTs('2025-01-01'),
    lastScanTs: 4000,
});
assertEq(added, 2, 'new bvids counted (a, c)');
assertEq(local.videos.b.cover, 'https://c/local.jpg', 'existing local cover not clobbered');
assertEq(local.ups['1'].name, 'UP1', 'up name refreshed from import');
assertEq(local.ups['1'].lastTs, 5000, 'lastTs merged as max');
assertEq(local.ups['9'].name, '新UP', 'new up entry created');
assertEq(local.globalFloorTs, Core.dateStrToTs('2025-01-01'), 'globalFloorTs merged as min (deeper)');
assertEq(local.lastScanTs, 4000, 'lastScanTs merged as max');

// ---- summary ----
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
