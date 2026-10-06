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
assertEq(Core.mergeVideos(map, [page.videos[0]]).added, 1, 'first insert counts');
assertEq(Core.mergeVideos(map, [page.videos[0]]).added, 0, 'duplicate bvid not re-added');
assertEq(Object.keys(map).length, 1, 'map size stable');
// backfill: legacy entry (no cover) gets it from a newer scan
const legacy = { bvid: 'BVold1', title: 'old', pubTs: 1, cover: '' };
const newer = { bvid: 'BVold1', title: 'old', pubTs: 1, cover: 'https://x/cover.jpg' };
Core.mergeVideos(map, [legacy]);
assertEq(Core.mergeVideos(map, [newer]).added, 0, 'backfill does not count as new');
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

// ---- pageForAnchor (list position preserved across scans) ----
console.log('\n# pageForAnchor');
const anchorList = Array.from({ length: 45 }, (_, i) => ({ bvid: 'v' + (i + 1), pubTs: i + 1 })); // 45 items / 20 per page = 3 pages
assertEq(Core.pageForAnchor(anchorList, 'v1', 20), 1, 'first item -> page 1');
assertEq(Core.pageForAnchor(anchorList, 'v20', 20), 1, 'page boundary last item -> page 1');
assertEq(Core.pageForAnchor(anchorList, 'v21', 20), 2, 'page boundary first item -> page 2');
assertEq(Core.pageForAnchor(anchorList, 'v45', 20), 3, 'last item -> last page');
// simulate 10 new videos prepended before old v21 (old index 20 -> new index 30)
const grown = [...Array.from({ length: 10 }, (_, i) => ({ bvid: 'new' + i, pubTs: 100 + i })), ...anchorList];
assertEq(Core.pageForAnchor(grown, 'v21', 20), 2, 'anchor shifted by 10 new items still lands on its page');
assertEq(grown[(2 - 1) * 20].bvid, 'v11', 'sanity: new page 2 starts at old v11');
assertOk(grown.slice(20, 40).some((v) => v.bvid === 'v21'), 'new page 2 contains the anchor video');
assertEq(Core.pageForAnchor(anchorList, 'nonexist', 20), 1, 'unknown anchor -> fallback page 1');
assertEq(Core.pageForAnchor(anchorList, null, 20), 1, 'no anchor -> page 1');
assertEq(Core.pageForAnchor([], 'v1', 20), 1, 'empty list -> page 1');

// ---- v2: sources/seasons/pgc/tabs/prune ----
console.log('\n# v2.0 features');

// parsePgcSeason (unlimited-history source: pgc/view/web/season)
const seasonDetail = {
    result: {
        season_id: 26421, title: '这就是中国', type: 3, cover: 'http://i0.hdslb.com/x.jpg',
        episodes: [
            { id: 6497987, title: '第350集', long_title: '沙漠绿色奇迹', cover: 'http://i0.hdslb.com/ep350.jpg', pub_time: 1750000000, link: 'https://www.bilibili.com/bangumi/play/ep6497987' },
            { id: 6497000, title: '第350集', long_title: '', cover: 'http://i0.hdslb.com/ep349.jpg', pub_time: 1749000000, link: '//www.bilibili.com/bangumi/play/ep6497000' },
            { id: 0, title: 'broken', pub_time: 100, link: '' },
            { id: 111, title: 'noTs', pub_time: 0, link: '' },
        ],
    },
};
const sp = Core.parsePgcSeason(seasonDetail);
assertEq(sp.videos.length, 2, 'broken episodes skipped');
assertEq(sp.videos[0].bvid, 'ep6497987', 'pseudo id ep{epid} kept (legacy-compatible)');
assertEq(sp.videos[0].title, '这就是中国 第350集 沙漠绿色奇迹', 'title = show + ep + long_title');
assertEq(sp.videos[1].title, '这就是中国 第350集', 'empty long_title omitted');
assertEq(sp.videos[0].badge, '纪录片', 'type 3 -> 纪录片');
assertEq(sp.videos[0].seasonName, '这就是中国', 'seasonName for line-1 display');
assertEq(sp.videos[0].seasonId, '26421', 'seasonId recorded');
assertEq(sp.videos[0].cover, 'https://i0.hdslb.com/ep350.jpg', 'cover http->https');
assertEq(sp.videos[1].url, 'https://www.bilibili.com/bangumi/play/ep6497000', 'protocol-relative link fixed');
assertEq(sp.videos[0].sources, ['pgc'], 'pgc sources');
assertEq(sp.videos[0].upMid, '', 'no author for season-sourced entries');
// fallback url when link/share_url missing
const sp2 = Core.parsePgcSeason({ result: { season_id: 1, title: 'X', type: 5, episodes: [{ id: 9, title: '第1集', long_title: 'Y', pub_time: 5 }] } });
assertEq(sp2.videos[0].url, 'https://www.bilibili.com/bangumi/play/ep9', 'url fallback to ep page');
assertEq(sp2.videos[0].badge, '电视剧', 'type 5 -> 电视剧');

// parseSeasonPage
const seasonJson = {
    data: {
        archives: [
            { aid: 1, bvid: 'BVs1', title: '第一集', pic: 'http://i0.hdslb.com/bfs/archive/s1.jpg', duration: 3661, pubdate: 1730000001 },
            { aid: 2, bvid: 'BVs2', title: '第二集', pic: '', duration: 59, pubdate: 1730000002 },
            { aid: 3, bvid: '', title: 'broken', pubdate: 1730000003 },
        ],
        meta: { season_id: 12345, mid: 42, name: '某合集', cover: 'http://i0.hdslb.com/s.jpg', total: 35 },
        page: { page_num: 1, total: 35 },
    },
};
const seasonPage = Core.parseSeasonPage(seasonJson, 0);
assertEq(seasonPage.videos.length, 2, 'broken entry skipped');
assertEq(seasonPage.videos[0].sources, ['season'], 'season sources');
assertEq(seasonPage.videos[0].duration, '1:01:01', 'duration formatted h:mm:ss');
assertEq(seasonPage.videos[1].duration, '0:59', 'duration formatted m:ss');
assertEq(seasonPage.videos[0].seasonId, '12345', 'seasonId recorded');
assertEq(seasonPage.meta.name, '某合集', 'meta name');
assertEq(seasonPage.hasMore, true, 'paging by total count');
assertEq(Core.parseSeasonPage(seasonJson, 1730000002).videos.length, 1, 'sinceTs filters episodes');

// parseCollectedList
const colPage = Core.parseCollectedList({ data: { count: 2, list: [
    { id: 12345, title: '某合集', mid: 42, media_count: 35 },
    { fid: 999, title: '某收藏夹', mid: 7, media_count: 10 }, // no id? fid only -> kept via id fallback? fid not mapped, id undefined -> filtered
] } });
assertEq(colPage.list.length, 1, 'entries without usable id filtered');
assertEq(colPage.list[0].id, '12345', 'id stringified');

// mergeVideos: sources union
const mv = {};
Core.mergeVideos(mv, [{ bvid: 'BVx', title: 't', pubTs: 1, sources: ['follow'] }]);
const addedX = Core.mergeVideos(mv, [{ bvid: 'BVx', title: 't', pubTs: 1, sources: ['season'], seasonId: '55', seasonName: '合集X' }]).added;
assertEq(addedX, 0, 'cross-source merge is not a new record');
assertEq(mv.BVx.sources.slice().sort(), ['follow', 'season'], 'sources unioned');
assertEq(mv.BVx.seasonId, '55', 'seasonId backfilled on cross-source entry');
assertEq(mv.BVx.seasonName, '合集X', 'seasonName backfilled on cross-source entry');

// fmtDuration edge cases
assertEq(Core.fmtDuration(0), '0:00', 'zero duration');
assertEq(Core.fmtDuration(3599), '59:59', 'below one hour');

// migrateV2ToV3
const v2state = { version: 2, videos: { a: { bvid: 'a', pubTs: 1 } }, ups: {}, globalFloorTs: 100, lastScanTs: 200 };
const v3state = Core.migrateV2ToV3(v2state);
assertEq(v3state.version, 3, 'version 3');
assertEq(v3state.videos.a.sources, ['follow'], 'legacy video gains follow source');
assertEq(v3state.seasons, {}, 'empty seasons table');
assertEq(v3state.settings.defaultTab, 'all', 'settings defaults');
assertEq(v3state.settings.delOnUnsubscribe, true, 'delOnUnsubscribe default on');
assertEq(v3state.settings.delOnUnfollow, true, 'delOnUnfollow default on');

// filterByTab
const tabList = [
    { bvid: 'a', sources: ['follow'] },
    { bvid: 'b', sources: ['pgc'] },
    { bvid: 'c', sources: ['follow', 'season'] },
    { bvid: 'd', sources: ['season'] },
];
assertEq(Core.filterByTab(tabList, 'all').length, 4, 'all tab keeps everything');
assertEq(Core.filterByTab(tabList, 'follow').map((v) => v.bvid), ['a', 'c'], 'follow tab');
assertEq(Core.filterByTab(tabList, 'pgc').map((v) => v.bvid), ['b'], 'pgc tab');
assertEq(Core.filterByTab(tabList, 'season').map((v) => v.bvid), ['c', 'd'], 'season tab incl. cross-source');

// pruneSources
const pstate = {
    videos: {
        fo: { bvid: 'fo', upMid: '1', seasonId: '', sources: ['follow'] },          // followed only
        fs: { bvid: 'fs', upMid: '1', seasonId: '11', sources: ['follow', 'season'] }, // cross-source, season STILL subscribed
        fs2: { bvid: 'fs2', upMid: '1', seasonId: '22', sources: ['follow', 'season'] }, // cross-source, both dropped
        se: { bvid: 'se', upMid: '2', seasonId: '22', sources: ['season'] },        // season only, unsubscribed
        pg: { bvid: 'pg', upMid: '3', seasonId: '', sources: ['pgc'] },             // pgc - untouched
    },
    ups: { '1': { mid: '1', lastTs: 100 }, '2': { mid: '2', lastTs: 100 } },
    seasons: { '11': { seasonId: '11', lastTs: 1 }, '22': { seasonId: '22', lastTs: 1 }, '33': { seasonId: '33', lastTs: 1 } },
};
// live: only UP 2 and season 11 remain (liveSeasons=null must skip season pruning)
const pr1 = Core.pruneSources(pstate, new Set(['2']), new Set(['11']), null, { delOnUnfollow: true, delOnUnsubscribe: true, delOnUnfollowBangumi: true });
assertEq(pstate.videos.fo, undefined, 'follow-only video of unfollowed UP deleted');
assertEq(pstate.videos.fs.sources, ['season'], 'cross-source video survives via still-subscribed season (removed from follow tab only)');
assertEq(pstate.videos.fs2, undefined, 'cross-source video deleted after BOTH tags removed');
assertEq(pstate.videos.se, undefined, 'season-only video of unsubscribed season deleted');
assertEq(pstate.videos.pg.bvid, 'pg', 'pgc video never pruned');
assertEq(pstate.seasons['22'], undefined, 'unsubscribed season entry removed');
assertEq(pstate.seasons['11'].seasonId, '11', 'live season entry kept');
assertEq(pstate.ups['1'].lastTs, 0, 'unfollowed UP lastTs reset (re-follow triggers full backfill)');
assertEq(pstate.ups['2'].lastTs, 100, 'followed UP lastTs untouched');

const pstate2 = {
    videos: { fs: { bvid: 'fs', upMid: '1', seasonId: '11', sources: ['follow', 'season'] } },
    ups: { '1': { mid: '1', lastTs: 100 } },
    seasons: { '11': { seasonId: '11', lastTs: 1 } },
};
// null liveSeasons (collected enumeration failed) -> skip season pruning entirely
const pstateNull = { videos: { se: { bvid: 'se', upMid: '2', seasonId: '22', sources: ['season'] } }, ups: {}, seasons: { '22': { seasonId: '22', lastTs: 1 } } };
Core.pruneSources(pstateNull, new Set(['2']), null, null, { delOnUnfollow: true, delOnUnsubscribe: true, delOnUnfollowBangumi: true });
assertEq(pstateNull.videos.se.bvid, 'se', 'null liveSeasons -> no season pruning');
assertEq(pstateNull.seasons['22'].seasonId, '22', 'null liveSeasons -> seasons table untouched');

// season 11 unsubscribed + UP unfollowed, but delOnUnfollow disabled -> follow tag survives
const pr2 = Core.pruneSources(pstate2, new Set(), new Set(), null, { delOnUnfollow: false, delOnUnsubscribe: true, delOnUnfollowBangumi: true });
assertEq(pstate2.videos.fs.sources, ['follow'], 'season tag removed, follow tag kept (setting off)');
assertEq(pstate2.seasons['11'], undefined, 'season entry removed regardless');

// parseBangumiFollowList
const bfPage = Core.parseBangumiFollowList({ data: { total: 3, has_next: true, list: [
    { season_id: 111, title: '番A' }, { season_id: 222, title: '剧B' }, { title: 'broken' },
] } });
assertEq(bfPage.list, [{ seasonId: '111', title: '番A' }, { seasonId: '222', title: '剧B' }], 'season ids + titles, broken filtered');
assertEq(bfPage.total, 3, 'total passthrough');
assertEq(bfPage.hasNext, true, 'has_next passthrough');

// parsePgcSeason records seasonId (needed for un-bangumi cleanup)
assertEq(sp.videos[0].seasonId, '26421', 'pgc seasonId recorded');

// pruneSources: pgc dimension (new signature with liveBangumi)
const pstateB = {
    videos: {
        p1: { bvid: 'p1', upMid: '9', seasonId: '111', sources: ['pgc'] },        // still followed
        p2: { bvid: 'p2', upMid: '9', seasonId: '222', sources: ['pgc'] },        // un-followed -> delete
        p3: { bvid: 'p3', upMid: '9', seasonId: '', sources: ['pgc'] },           // legacy no seasonId -> keep
        p4: { bvid: 'p4', upMid: '9', seasonId: '222', sources: ['pgc', 'follow'] }, // cross-source: pgc tag removed, follow kept
    },
    ups: {}, seasons: {},
};
Core.pruneSources(pstateB, new Set(['9']), new Set(), new Set(['111']), { delOnUnfollow: true, delOnUnsubscribe: true, delOnUnfollowBangumi: true });
assertEq(pstateB.videos.p1.bvid, 'p1', 'followed bangumi kept');
assertEq(pstateB.videos.p2, undefined, 'unfollowed bangumi deleted');
assertEq(pstateB.videos.p3.bvid, 'p3', 'legacy pgc without seasonId never pruned');
assertEq(pstateB.videos.p4.sources, ['follow'], 'cross-source keeps follow tag');

// null liveBangumi (fetch failed) -> skip pgc pruning entirely
const pstateC = { videos: { p2: { bvid: 'p2', upMid: '9', seasonId: '222', sources: ['pgc'] } }, ups: {}, seasons: {} };
Core.pruneSources(pstateC, new Set(['9']), new Set(), null, { delOnUnfollow: true, delOnUnsubscribe: true, delOnUnfollowBangumi: true });
assertEq(pstateC.videos.p2.bvid, 'p2', 'null bangumi list -> no pgc pruning');

// setting off -> keep pgc tag
const pstateD = { videos: { p2: { bvid: 'p2', upMid: '9', seasonId: '222', sources: ['pgc'] } }, ups: {}, seasons: {} };
Core.pruneSources(pstateD, new Set(['9']), new Set(), new Set(['111']), { delOnUnfollow: true, delOnUnsubscribe: true, delOnUnfollowBangumi: false });
assertEq(pstateD.videos.p2.sources, ['pgc'], 'delOnUnfollowBangumi off -> pgc tag kept');

// ---- v2.7: joint-upload attribution (联合投稿主UP识别) ----
console.log('\n# v2.7 joint-upload attribution');

// mergeVideos: same bvid from a DIFFERENT uploader's feed -> conflict reported
const cmap = {};
let cm1 = Core.mergeVideos(cmap, [{ bvid: 'BVcoop', title: 't', pubTs: 1, upMid: 'A', sources: ['follow'] }]);
assertEq(cm1.added, 1, 'first sighting added');
assertEq(cm1.conflicts, [], 'no conflict on first sighting');
let cm2 = Core.mergeVideos(cmap, [{ bvid: 'BVcoop', title: 't', pubTs: 1, upMid: 'B', sources: ['follow'] }]);
assertEq(cm2.added, 0, 'second sighting not re-added');
assertEq(cm2.conflicts, [{ bvid: 'BVcoop', mids: ['A', 'B'] }], 'conflict reported with both mids');
assertEq(cmap.BVcoop.upMid, 'A', 'attribution unchanged until resolved');
// same-uploader re-merge never conflicts
assertEq(Core.mergeVideos(cmap, [{ bvid: 'BVcoop', title: 't', pubTs: 1, upMid: 'A', sources: ['season'] }]).conflicts, [], 'same-uploader re-merge no conflict');
// empty upMid (pgc lane) never conflicts
assertEq(Core.mergeVideos(cmap, [{ bvid: 'BVcoop', title: 't', pubTs: 1, upMid: '', sources: ['pgc'] }]).conflicts, [], 'empty upMid never conflicts');
// settled entries never re-conflict
cmap.BVcoop.ownerVerified = true;
assertEq(Core.mergeVideos(cmap, [{ bvid: 'BVcoop', title: 't', pubTs: 1, upMid: 'C', sources: ['follow'] }]).conflicts, [], 'ownerVerified entry never re-conflicts');
assertEq(cmap.BVcoop.upMid, 'A', 'ownerVerified entry attribution untouched by later merges');

// parseVideoView: owner = publishing account, staff roster with roles
// (structure per bilibili-API-collect docs/video/info.md real sample)
const viewJson = {
    code: 0,
    data: {
        bvid: 'BVcoop',
        owner: { mid: 66606350, name: '陈楒潼桶桶桶', face: 'http://i2.hdslb.com/bfs/face/x.jpg' },
        rights: { is_cooperation: 1 },
        staff: [
            { mid: 66606350, title: 'UP主', name: '陈楒潼桶桶桶', face: 'http://i2.hdslb.com/bfs/face/x.jpg', follower: 616428 },
            { mid: 53456, title: '曲绘', name: 'Warma', face: 'http://i2.hdslb.com/bfs/face/w.jpg', follower: 4818052 },
        ],
    },
};
const vi = Core.parseVideoView(viewJson);
assertEq(vi.bvid, 'BVcoop', 'bvid passthrough');
assertEq(vi.ownerMid, '66606350', 'owner mid stringified');
assertEq(vi.ownerName, '陈楒潼桶桶桶', 'owner name');
assertEq(vi.ownerFace, 'https://i2.hdslb.com/bfs/face/x.jpg', 'owner face http->https');
assertEq(vi.staff, [
    { mid: '66606350', name: '陈楒潼桶桶桶', title: 'UP主' },
    { mid: '53456', name: 'Warma', title: '曲绘' },
], 'staff roster slimmed to mid/name/title');
// non-cooperation video: view response has no staff array
assertEq(Core.parseVideoView({ data: { bvid: 'BV1', owner: { mid: 7, name: 'x' } } }).staff, [], 'no staff field -> empty roster');
assertEq(Core.parseVideoView(null).ownerMid, '', 'null json tolerated');

// applyCoopOwner: re-attribute to the true owner + record roster + mark verified
const astate = {
    videos: { BVcoop: { bvid: 'BVcoop', upMid: 'B', pubTs: 1, sources: ['follow'] } },
    ups: { B: { mid: 'B', name: '合作者B', face: '' } },
};
assertEq(Core.applyCoopOwner(astate, vi), true, 'applyCoopOwner reports update');
assertEq(astate.videos.BVcoop.upMid, '66606350', 'attribution moved to true owner');
assertEq(astate.videos.BVcoop.ownerVerified, true, 'ownerVerified flag set');
assertEq(astate.videos.BVcoop.staff.length, 2, 'staff roster stored on entry');
assertEq(astate.ups['66606350'], { mid: '66606350', name: '陈楒潼桶桶桶', face: 'https://i2.hdslb.com/bfs/face/x.jpg' }, 'owner added to ups table for display');
// idempotent re-apply
assertEq(Core.applyCoopOwner(astate, vi), true, 're-apply still true');
assertEq(astate.videos.BVcoop.upMid, '66606350', 'idempotent re-apply keeps owner');
// guards
assertEq(Core.applyCoopOwner(astate, { bvid: 'nope', ownerMid: '1' }), false, 'missing record -> false');
assertEq(Core.applyCoopOwner(astate, { bvid: 'BVcoop', ownerMid: '' }), false, 'empty ownerMid -> false');
// single-staff (owner only) response: attribution set, roster NOT stored
const sstate = { videos: { BVsolo: { bvid: 'BVsolo', upMid: 'B', pubTs: 1, sources: ['follow'] } }, ups: {} };
Core.applyCoopOwner(sstate, { bvid: 'BVsolo', ownerMid: '9', ownerName: 'z', ownerFace: '', staff: [] });
assertEq(sstate.videos.BVsolo.upMid, '9', 'solo entry re-attributed');
assertEq(sstate.videos.BVsolo.staff, undefined, 'solo entry stores no roster');

// hasLiveCooperator
assertEq(Core.hasLiveCooperator({ upMid: '1', staff: [{ mid: '1' }, { mid: '2' }] }, new Set(['2'])), true, 'live collaborator -> true');
assertEq(Core.hasLiveCooperator({ upMid: '1', staff: [{ mid: '1' }, { mid: '2' }] }, new Set(['3'])), false, 'nobody live -> false');
assertEq(Core.hasLiveCooperator({ upMid: '1' }, new Set(['1'])), false, 'no roster -> false');
assertEq(Core.hasLiveCooperator({ upMid: '1', staff: [{ mid: '1', name: 'owner' }] }, new Set(['1'])), false, 'owner is not a collaborator');

// pruneSources: joint upload kept alive by a still-followed collaborator
const pstateCoop = {
    videos: {
        c1: { bvid: 'c1', upMid: '10', sources: ['follow'], staff: [{ mid: '10', name: '主UP', title: 'UP主' }, { mid: '20', name: '合作者', title: '曲绘' }] },
        c2: { bvid: 'c2', upMid: '10', sources: ['follow'], staff: [{ mid: '10', name: '主UP', title: 'UP主' }, { mid: '30', name: '前合作者', title: '出演' }] },
    },
    ups: { '10': { mid: '10', lastTs: 5 } },
    seasons: {},
};
Core.pruneSources(pstateCoop, new Set(['20']), null, null, { delOnUnfollow: true, delOnUnsubscribe: true, delOnUnfollowBangumi: true });
assertEq(pstateCoop.videos.c1.sources, ['follow'], 'joint upload survives owner-unfollow via still-followed collaborator');
assertEq(pstateCoop.videos.c2, undefined, 'all staff unfollowed -> joint upload removed');

// ---- summary ----
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
