// ==UserScript==
// @name         B站关注动态聚合器 - 视频补课与增量归档
// @name:en      Bilibili Follow Feed Aggregator - Video Backfill & Incremental Archive
// @namespace    https://github.com/dnasdw
// @version      2.3.0
// @description  聚合全部关注UP主的视频动态（正式投稿+动态视频），按发布时间重建完整时间线。绕过B站关注动态页只能回看约75天历史的限制：支持从任意日期回溯补课（可扫到每个UP的第一条动态）、增量归档、断点续扫、新关注UP自动补全、多设备迁移
// @description:en  Aggregate video dynamics (uploads + dynamic videos) from all followed creators into one timeline. Bypasses bilibili's ~75-day follow-feed history limit: backfill from any date (down to each creator's very first post), incremental updates, resumable scans, auto-backfill for newly followed creators, JSON export/import for migration.
// @author       dnasdw
// @match        https://t.bilibili.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      api.bilibili.com
// @run-at       document-idle
// @noframes
// @homepageURL  https://github.com/dnasdw/bilibili-followup-aggregator
// @supportURL   https://github.com/dnasdw/bilibili-followup-aggregator/issues
// @license      MIT
// ==/UserScript==

/*
 * Data source: user space dynamics feed (per-UP), which covers BOTH regular
 * video uploads AND "dynamic videos" (videos published via the dynamic box,
 * which never appear in the upload list). Both share type DYNAMIC_TYPE_AV /
 * major.archive with a normal bvid playable at www.bilibili.com/video/{bvid}.
 *
 * Endpoints used (all cookie-based, no wbi signature required):
 *   GET /x/web-interface/nav                                   -> my mid / login state
 *   GET /x/relation/followings?vmid=&pn=&ps=50&order=desc      -> followings list
 *   GET /x/polymer/web-dynamic/v1/feed/space?host_mid=&offset= -> per-UP dynamics
 */

(function () {
    'use strict';

    // ============================ Config ============================

    const CONFIG = {
        storageKey: 'bfua_state_v1',
        reqDelayMinMs: 1200,         // random throttle between requests
        reqDelayMaxMs: 2400,
        retryBaseMs: 4000,           // transient-error backoff base
        riskBackoffBaseMs: 20000,    // -352/-403/-412 need a much longer window
        maxRetries: 4,
        requestTimeoutMs: 20000,
        maxPagesPerUp: 500,          // hard safety cap
        workerCount: 3,             // concurrent scan workers (global throttle still applies)
        listPageSize: 20,            // UI list page size (card layout)
    };

    const API = {
        nav: 'https://api.bilibili.com/x/web-interface/nav',
        followings: (mid, pn) => `https://api.bilibili.com/x/relation/followings?vmid=${mid}&pn=${pn}&ps=50&order=desc`,
        feedSpace: (mid, offset) => `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=${mid}&offset=${encodeURIComponent(offset)}&platform=web&features=itemOpusStyle`,
        collectedList: (mid, pn) => `https://api.bilibili.com/x/v3/fav/folder/collected/list?up_mid=${mid}&pn=${pn}&ps=20&platform=web`,
        seasonArchives: (mid, seasonId, pn) => `https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=${mid}&season_id=${seasonId}&page_num=${pn}&page_size=30&sort_reverse=false`,
        bangumiFollow: (mid, type, pn) => `https://api.bilibili.com/x/space/bangumi/follow/list?vmid=${mid}&type=${type}&pn=${pn}&ps=30`,
        pgcSeason: (seasonId) => `https://api.bilibili.com/pgc/view/web/season?season_id=${seasonId}`,
    };

    // ============================ Pure core (testable, no DOM / no GM) ============================

    const Core = {
        /** 'YYYY-MM-DD' -> unix seconds at 00:00 UTC+8 (user timezone is Asia/Shanghai). */
        dateStrToTs(str) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(String(str || ''))) return 0;
            return Math.floor(new Date(str + 'T00:00:00+08:00').getTime() / 1000);
        },

        fmtDate(ts) {
            const d = new Date(ts * 1000);
            const p = (n) => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
        },

        fmtDateTime(ts) {
            const d = new Date(ts * 1000);
            const p = (n) => String(n).padStart(2, '0');
            return `${Core.fmtDate(ts)} ${p(d.getHours())}:${p(d.getMinutes())}`;
        },

        /**
         * Parse one feed/space page. Collects only video dynamics (DYNAMIC_TYPE_AV
         * with a valid archive/bvid) published at or after `sinceTs`.
         * UP name/avatar go into a per-UP table (deduped), videos reference by upMid.
         * Pinned dynamics (module_tag.text === '置顶') are excluded from the
         * oldestTs calculation so an old pin cannot stop paging early.
         * Returns { videos, ups, oldestTs, hasMore, offset }.
         */
        parseFeedPage(json, sinceTs) {
            const data = (json && json.data) || {};
            const items = data.items || [];
            const videos = [];
            const ups = {};
            let oldestTs = Infinity;

            for (const item of items) {
                const mods = item.modules || {};
                const author = mods.module_author || {};
                const major = (mods.module_dynamic || {}).major;
                const ts = Number(author.pub_ts) || 0;
                const isPinned = (mods.module_tag && mods.module_tag.text === '置顶') || false;

                if (ts && !isPinned && ts < oldestTs) oldestTs = ts;

                if (item.type !== 'DYNAMIC_TYPE_AV') continue;
                const arc = major && major.archive;
                if (!arc || !arc.bvid || !ts) continue;
                if (ts < sinceTs) continue;

                const upMid = String(author.mid || '');
                if (upMid && !ups[upMid]) {
                    ups[upMid] = {
                        name: author.name || '',
                        face: String(author.face || '').replace(/^http:\/\//, 'https://'),
                    };
                }

                videos.push({
                    bvid: String(arc.bvid),
                    title: arc.title || '(无标题)',
                    pubTs: ts,
                    upMid,
                    duration: arc.duration_text || '',
                    badge: (arc.badge && arc.badge.text) || '',
                    cover: String(arc.cover || '').replace(/^http:\/\//, 'https://'),
                    url: 'https://www.bilibili.com/video/' + arc.bvid,
                    sources: ['follow'],
                });
            }

            return {
                videos,
                ups,
                oldestTs: oldestTs === Infinity ? 0 : oldestTs,
                hasMore: Boolean(data.has_more),
                offset: typeof data.offset === 'string' ? data.offset : '',
            };
        },

        /** Stop paging when: no more pages, no cursor, or page content went older than sinceTs. */
        shouldStopPaging(page, sinceTs) {
            if (!page.hasMore || !page.offset) return true;
            if (page.oldestTs > 0 && page.oldestTs < sinceTs) return true;
            return false;
        },

        /** Merge videos into an id-keyed map. New ids are added; existing entries
         *  get missing fields backfilled and sources unioned (a video can be both
         *  an upload dynamic from a followed UP and an episode of a subscribed season). */
        mergeVideos(map, videos) {
            let added = 0;
            for (const v of videos) {
                const ex = map[v.bvid];
                if (!ex) { map[v.bvid] = v; added++; }
                else {
                    if (!ex.cover && v.cover) ex.cover = v.cover;
                    if (!ex.badge && v.badge) ex.badge = v.badge;
                    for (const s of v.sources || []) {
                        if (ex.sources.indexOf(s) === -1) ex.sources.push(s);
                    }
                }
            }
            return added;
        },

        /** Merge per-UP info table; refreshes name/avatar on re-scan (UPs can rename). */
        mergeUps(ups, incoming) {
            for (const mid of Object.keys(incoming || {})) {
                const info = incoming[mid];
                const ex = ups[mid];
                if (!ex) ups[mid] = { mid, name: info.name || '', face: info.face || '' };
                else {
                    if (info.name) ex.name = info.name;
                    if (info.face) ex.face = info.face;
                }
            }
        },

        /** Migrate v1 state (face/upName duplicated per video) to v2 (per-UP table). */
        migrateV1ToV2(state) {
            const ups = {};
            for (const v of Object.values(state.videos || {})) {
                const ex = ups[v.upMid];
                if (!ex) ups[v.upMid] = { mid: v.upMid, name: v.upName || '', face: v.face || '' };
                else {
                    if (!ex.name && v.upName) ex.name = v.upName;
                    if (!ex.face && v.face) ex.face = v.face;
                }
                delete v.face;
                delete v.upName;
            }
            state.ups = ups;
            state.version = 2;
            return state;
        },

        /**
         * Per-UP lower bound for incremental scans:
         *  - UP with per-UP record (v1.5+) -> its own last-scan time
         *  - UP entry exists but no lastTs (legacy scans from older versions)
         *    -> global lastScanTs (it was scanned, just without per-UP record)
         *  - UP not in the ups table at all -> newly followed UP: backfill to
         *    globalFloorTs; 0 means "backfill to the UP's very first dynamic"
         */
        incSinceTs(upEntry, globalFloorTs, lastScanTs) {
            if (upEntry && upEntry.lastTs) return upEntry.lastTs;
            if (!upEntry) return globalFloorTs;
            return lastScanTs || globalFloorTs;
        },

                /**
         * Parse a pgc/view/web/season response into full episode records.
         * This is the unlimited-history source for the bangumi tab: every
         * followed season is fetched once per scan and ALL its episodes are
         * merged (id-deduped), so new follows are backfilled automatically.
         * Entries keep the "ep{epid}" pseudo id used by the legacy feed source.
         */
        parsePgcSeason(json) {
            const r = (json && json.result) || {};
            const episodes = r.episodes || [];
            const TYPE_NAMES = { 1: '番剧', 2: '电影', 3: '纪录片', 4: '国创', 5: '电视剧', 7: '综艺' };
            const typeName = TYPE_NAMES[Number(r.type)] || '剧集';
            const videos = [];

            for (const ep of episodes) {
                const epid = Number(ep.id) || 0;
                const ts = Number(ep.pub_time) || 0;
                if (!epid || !ts) continue;
                // build "show episode-title long-title", dropping consecutive duplicate parts
                const parts = [r.title, ep.title, ep.long_title].filter(Boolean);
                const title = parts.filter((p, i) => p !== parts[i - 1]).join(' ');
                videos.push({
                    bvid: 'ep' + epid,
                    title: title || '(剧集)',
                    pubTs: ts,
                    upMid: '',
                    duration: '',
                    badge: typeName,
                    cover: String(ep.cover || '').replace(/^http:\/\//, 'https://'),
                    url: String(ep.link || ep.share_url || '').replace(/^\/\//, 'https://')
                        || ('https://www.bilibili.com/bangumi/play/ep' + epid),
                    seasonId: String(r.season_id || ''),
                    seasonName: r.title || '',
                    sources: ['pgc'],
                });
            }

            return { videos, seasonId: String(r.season_id || ''), title: r.title || '' };
        },
/**
         * Parse one seasons_archives_list page (episodes of a subscribed collection).
         * Returns { videos, ups, meta, hasMore, pageNum } - meta carries season info.
         */
        parseSeasonPage(json, sinceTs) {
            const data = (json && json.data) || {};
            const archives = data.archives || [];
            const meta = data.meta || {};
            const seasonMid = String(meta.mid || '');
            const videos = [];

            for (const arc of archives) {
                const ts = Number(arc.pubdate) || Number(arc.ctime) || 0;
                if (!arc.bvid || !ts || ts < sinceTs) continue;
                videos.push({
                    bvid: String(arc.bvid),
                    title: arc.title || '(无标题)',
                    pubTs: ts,
                    upMid: seasonMid,
                    duration: Core.fmtDuration(Number(arc.duration) || 0),
                    badge: '合集',
                    cover: String(arc.pic || '').replace(/^http:\/\//, 'https://'),
                    url: 'https://www.bilibili.com/video/' + arc.bvid,
                    seasonId: String(meta.season_id || ''),
                    sources: ['season'],
                });
            }

            const page = data.page || {};
            const pageNum = Number(page.page_num) || 1;
            const total = Number(page.total) || 0;
            return {
                videos,
                meta: {
                    seasonId: String(meta.season_id || ''),
                    mid: seasonMid,
                    name: meta.name || '',
                    cover: String(meta.cover || '').replace(/^http:\/\//, 'https://'),
                    total,
                },
                hasMore: pageNum * 30 < total,
                pageNum,
            };
        },

        /** Parse collected/list page ("我追的合集/收藏夹").
         *  Entries mixing folders and seasons - both are returned as candidates;
         *  the scanner probes each with seasons_archives_list and skips non-seasons. */
        parseCollectedList(json) {
            const data = (json && json.data) || {};
            const list = data.list || [];
            return {
                total: Number(data.count) || list.length,
                list: list.map((it) => ({
                    id: String(it.season_id || it.id || ''),
                    title: it.title || '',
                    mid: String(it.mid || ''),
                    mediaCount: Number(it.media_count) || 0,
                })).filter((it) => it.id),
            };
        },

        /** Parse one page of the bangumi follow list (type=1 anime / type=2 drama). */
        parseBangumiFollowList(json) {
            const data = (json && json.data) || {};
            const list = (data.list || [])
                .map((it) => String(it.season_id || ''))
                .filter(Boolean);
            return {
                list,
                total: Number(data.total) || list.length,
                hasNext: Boolean(data.has_next),
            };
        },

        fmtDuration(seconds) {
            const s = Math.max(0, Math.floor(Number(seconds) || 0));
            const m = Math.floor(s / 60);
            const h = Math.floor(m / 60);
            const p = (n) => String(n).padStart(2, '0');
            return h > 0 ? `${h}:${p(m % 60)}:${p(s % 60)}` : `${m}:${p(s % 60)}`;
        },

        /** Tab filter: tabs are driven by the sources array of each entry. */
        filterByTab(list, tab) {
            if (tab === 'all') return list;
            return list.filter((v) => (v.sources || []).indexOf(tab) !== -1);
        },

        /**
         * Handle unfollowed UPs / unsubscribed seasons / unfollowed bangumi:
         * remove the matching source tag (the entry disappears from that tab);
         * delete the record entirely only when no source tag remains. The three
         * settings gate their respective tags. liveBangumi === null means the
         * list could not be fetched -> skip pgc pruning (never prune blindly).
         * PGC entries without seasonId (pre-2.1.0 data) are also kept.
         * Returns { removedVideos, untagged } for logging.
         */
        pruneSources(state, liveFollows, liveSeasons, liveBangumi, settings) {
            let removedVideos = 0;
            let untagged = 0;
            const unfollow = settings.delOnUnfollow !== false;
            const unsub = settings.delOnUnsubscribe !== false;
            const unbangumi = settings.delOnUnfollowBangumi !== false;

            if (unfollow) {
                for (const v of Object.values(state.videos)) {
                    const i = (v.sources || []).indexOf('follow');
                    if (i !== -1 && !liveFollows.has(v.upMid)) {
                        v.sources.splice(i, 1);
                        untagged++;
                        if (!v.sources.length) { delete state.videos[v.bvid]; removedVideos++; }
                    }
                }
                for (const mid of Object.keys(state.ups)) {
                    if (!liveFollows.has(mid)) state.ups[mid].lastTs = 0; // re-follow -> full backfill
                }
            }
            if (unsub) {
                for (const v of Object.values(state.videos)) {
                    if (!state.videos[v.bvid]) continue; // may have been deleted above
                    const i = (v.sources || []).indexOf('season');
                    if (i !== -1 && !liveSeasons.has(String(v.seasonId || ''))) {
                        v.sources.splice(i, 1);
                        untagged++;
                        if (!v.sources.length) { delete state.videos[v.bvid]; removedVideos++; }
                    }
                }
                for (const sid of Object.keys(state.seasons || {})) {
                    if (!liveSeasons.has(sid)) delete state.seasons[sid];
                }
            }
            if (unbangumi && liveBangumi) {
                for (const v of Object.values(state.videos)) {
                    if (!state.videos[v.bvid]) continue;
                    const i = (v.sources || []).indexOf('pgc');
                    if (i !== -1 && v.seasonId && !liveBangumi.has(v.seasonId)) {
                        v.sources.splice(i, 1);
                        untagged++;
                        if (!v.sources.length) { delete state.videos[v.bvid]; removedVideos++; }
                    }
                }
            }
            return { removedVideos, untagged };
        },

        /** Migrate v2 state (no sources/seasons/settings) to v3. */
        migrateV2ToV3(state) {
            for (const v of Object.values(state.videos || {})) {
                if (!Array.isArray(v.sources)) v.sources = ['follow'];
            }
            if (!state.seasons || typeof state.seasons !== 'object') state.seasons = {};
            if (!state.settings || typeof state.settings !== 'object') {
                state.settings = { defaultTab: 'all', delOnUnsubscribe: true, delOnUnfollow: true, delOnUnfollowBangumi: true };
            }
            state.version = 3;
            return state;
        },

        /**
         * Rebuild videos-map + ups-table from an exported video array
         * (strips the redundant upName/face rows back into the per-UP table).
         */
        buildFromVideoList(list) {
            const videos = {};
            const ups = {};
            for (const v of list || []) {
                if (!v || !v.bvid || !v.pubTs) continue;
                const { upName, face, ...rest } = v;
                if (!Array.isArray(rest.sources) || !rest.sources.length) rest.sources = ['follow']; // legacy export
                videos[v.bvid] = rest;
                if (v.upMid) {
                    const ex = ups[v.upMid];
                    if (!ex) ups[v.upMid] = { mid: v.upMid, name: upName || '', face: face || '' };
                    else {
                        if (!ex.name && upName) ex.name = upName;
                        if (!ex.face && face) ex.face = face;
                    }
                }
            }
            return { videos, ups };
        },

        /**
         * Merge an imported snapshot into local state (additive, never destructive):
         * videos by bvid, ups with lastTs=max (union of coverage), floors=min, lastScanTs=max.
         */
        mergeStateForImport(state, imported) {
            let added = 0;
            for (const v of Object.values(imported.videos || {})) {
                if (!state.videos[v.bvid]) { state.videos[v.bvid] = v; added++; }
                else {
                    const ex = state.videos[v.bvid];
                    if (!ex.cover && v.cover) ex.cover = v.cover;
                    if (!ex.badge && v.badge) ex.badge = v.badge;
                }
            }
            for (const mid of Object.keys(imported.ups || {})) {
                const info = imported.ups[mid];
                const ex = state.ups[mid];
                if (!ex) state.ups[mid] = { mid, name: info.name || '', face: info.face || '', lastTs: info.lastTs || 0 };
                else {
                    if (info.name) ex.name = info.name;
                    if (info.face) ex.face = info.face;
                    if (info.lastTs && (!ex.lastTs || info.lastTs > ex.lastTs)) ex.lastTs = info.lastTs;
                }
            }
            if (imported.globalFloorTs && (!state.globalFloorTs || imported.globalFloorTs < state.globalFloorTs)) {
                state.globalFloorTs = imported.globalFloorTs;
            }
            if (imported.lastScanTs && (!state.lastScanTs || imported.lastScanTs > state.lastScanTs)) {
                state.lastScanTs = imported.lastScanTs;
            }
            return added;
        },

        sortedList(map) {
            return Object.values(map).sort((a, b) => b.pubTs - a.pubTs);
        },

        /**
         * After new items are prepended by a scan, jump to the page that still
         * contains the anchor video (the first visible item before the scan),
         * so the user continues exactly where they left off.
         * Returns 1 when there is no/unknown anchor (fresh library, deleted video).
         */
        pageForAnchor(sortedList, anchorBvid, pageSize) {
            if (!anchorBvid) return 1;
            const idx = sortedList.findIndex((v) => v.bvid === anchorBvid);
            if (idx < 0) return 1;
            return Math.floor(idx / pageSize) + 1;
        },

        /** Parse followings page -> { list: [{mid, uname}], total } */
        parseFollowings(json) {
            const data = (json && json.data) || {};
            const list = (data.list || []).map((u) => ({ mid: String(u.mid), uname: u.uname || String(u.mid) }));
            return { list, total: Number(data.total) || list.length };
        },

        // ---- md5 (RFC 1321), self-contained for userscript + offline tests ----

        _utf8Bytes(str) {
            const bytes = [];
            for (let i = 0; i < str.length; i++) {
                const c = str.codePointAt(i);
                if (c > 0xffff) i++;
                if (c < 0x80) bytes.push(c);
                else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
                else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
                else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
            }
            return bytes;
        },

        md5(str) {
            const bytes = Core._utf8Bytes(str);
            const bitLenLo = (bytes.length * 8) >>> 0; // messages here are far below 2^32 bits
            bytes.push(0x80);
            while (bytes.length % 64 !== 56) bytes.push(0);
            bytes.push(bitLenLo & 0xff, (bitLenLo >>> 8) & 0xff, (bitLenLo >>> 16) & 0xff, (bitLenLo >>> 24) & 0xff, 0, 0, 0, 0);

            const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
                       5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
                       4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
                       6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
            const K = [];
            for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;

            let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

            for (let off = 0; off < bytes.length; off += 64) {
                const M = [];
                for (let i = 0; i < 16; i++) {
                    M[i] = (bytes[off + i * 4] | (bytes[off + i * 4 + 1] << 8) | (bytes[off + i * 4 + 2] << 16) | (bytes[off + i * 4 + 3] << 24)) >>> 0;
                }
                let A = a0, B = b0, C = c0, D = d0;
                for (let i = 0; i < 64; i++) {
                    let F, g;
                    if (i < 16)      { F = (B & C) | (~B & D); g = i; }
                    else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
                    else if (i < 48) { F = B ^ C ^ D;          g = (3 * i + 5) % 16; }
                    else             { F = C ^ (B | ~D);       g = (7 * i) % 16; }
                    F = (F + A + K[i] + M[g]) | 0;
                    A = D; D = C; C = B;
                    B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
                }
                a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
            }

            const hex = (n) => {
                let s = '';
                for (let i = 0; i < 4; i++) s += ((n >>> (8 * i)) & 0xff).toString(16).padStart(2, '0');
                return s;
            };
            return hex(a0) + hex(b0) + hex(c0) + hex(d0);
        },

        // ---- wbi signing (see bilibili-API-collect docs/misc/sign/wbi.md) ----

        wbiMixinKey(imgKey, subKey) {
            // official MIXIN_KEY_ENC_TAB, verified against the doc's test vector
            const TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,
                         33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,
                         61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,
                         36,20,34,44,52];
            const raw = imgKey + subKey;
            let out = '';
            for (let i = 0; i < TAB.length; i++) out += raw.charAt(TAB[i]);
            return out.slice(0, 32);
        },

        _wbiEncode(v) {
            // encodeURIComponent-compatible: unreserved chars stay, others -> %XX uppercase
            const SAFE = /[A-Za-z0-9\-_.!~*'()]/;
            let out = '';
            const bytes = Core._utf8Bytes(String(v));
            for (let i = 0; i < bytes.length; i++) {
                const ch = String.fromCharCode(bytes[i]);
                out += SAFE.test(ch) ? ch : '%' + bytes[i].toString(16).toUpperCase().padStart(2, '0');
            }
            return out;
        },

        /** params {k:v} -> sorted signed query with w_rid/wts appended. */
        wbiSignedQuery(params, mixinKey, wts) {
            const entries = Object.keys(params).map((k) => [k, String(params[k]).replace(/[!'()*]/g, '')]);
            entries.push(['wts', String(wts)]);
            entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
            const qs = entries.map(([k, v]) => Core._wbiEncode(k) + '=' + Core._wbiEncode(v)).join('&');
            return qs + '&w_rid=' + Core.md5(qs + mixinKey);
        },
    };

    // Expose for offline tests (node harness). Harmless in the browser.
    if (typeof window !== 'undefined') {
        window.__bfuaCore = Core;
    }

    // ============================ Storage ============================

    const Store = {
        load() {
            const fresh = () => ({
                version: 3,
                videos: {}, ups: {}, seasons: {},
                settings: { defaultTab: 'all', delOnUnsubscribe: true, delOnUnfollow: true, delOnUnfollowBangumi: true },
                lastScanTs: 0, globalFloorTs: 0, scan: null,
            });
            let raw = null;
            try { raw = GM_getValue(CONFIG.storageKey, null); } catch (e) { return fresh(); }
            if (!raw) return fresh();
            let state;
            try { state = JSON.parse(raw); } catch (e) { return fresh(); }
            if (!state || typeof state.videos !== 'object') return fresh();
            if (state.version === 1) {
                state = Core.migrateV1ToV2(state); // dedupe per-video face/upName into an ups table
            }
            if (state.version === 2) {
                state = Core.migrateV2ToV3(state); // add sources/seasons/settings
            }
            if (state.version !== 3) return fresh();
            try { GM_setValue(CONFIG.storageKey, JSON.stringify(state)); } catch (e) { /* persist next save */ }
            if (!state.ups || typeof state.ups !== 'object') state.ups = {};
            if (!state.seasons || typeof state.seasons !== 'object') state.seasons = {};
            if (!state.settings || typeof state.settings !== 'object') {
                state.settings = { defaultTab: 'all', delOnUnsubscribe: true, delOnUnfollow: true, delOnUnfollowBangumi: true };
            }
            if (typeof state.settings.delOnUnfollowBangumi !== 'boolean') state.settings.delOnUnfollowBangumi = true;
            if (typeof state.globalFloorTs !== 'number' || !state.globalFloorTs) {
                // 0 = "backfill new UPs to their very first dynamic" (scan-to-bottom)
                state.globalFloorTs = 0;
            }
            if (!state.scan || !Array.isArray(state.scan.queue)) state.scan = null;
            return state;
        },
        save(state) {
            GM_setValue(CONFIG.storageKey, JSON.stringify(state));
        },
        clear() {
            GM_deleteValue(CONFIG.storageKey);
        },
    };

    // ============================ Network layer ============================

    class ApiError extends Error {
        constructor(code, message) { super(`[${code}] ${message}`); this.code = code; }
    }
    class RetryableError extends ApiError {
        constructor(code, message) { super(code, message); this.retryable = true; }
    }

    let lastRequestAt = 0;

    // wbi key state: cached for the session, refreshed on -352 or when older than 1h
    const WbiState = { navJson: null, navAt: 0, keys: null };

    function endpointName(url) {
        return url.replace(/^https?:\/\/[^/]+/, '').split('?')[0] || url;
    }

    function parseQuery(url) {
        const idx = url.indexOf('?');
        const base = idx === -1 ? url : url.slice(0, idx);
        const params = {};
        if (idx !== -1) {
            for (const pair of url.slice(idx + 1).split('&')) {
                if (!pair) continue;
                const eq = pair.indexOf('=');
                if (eq === -1) params[pair] = '';
                else params[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
            }
        }
        return { base, params };
    }

    /** Fetch nav (unsigned endpoint), cache 1h; also refreshes wbi keys. */
    async function getNav(force) {
        if (!force && WbiState.navJson && Date.now() - WbiState.navAt < 3600e3) return WbiState.navJson;
        const json = await apiGet(API.nav, 'https://www.bilibili.com/', { sign: false });
        WbiState.navJson = json;
        WbiState.navAt = Date.now();
        const wbiImg = (json.data && json.data.wbi_img) || {};
        const imgKey = String(wbiImg.img_url || '').split('/').pop().split('.')[0];
        const subKey = String(wbiImg.sub_url || '').split('/').pop().split('.')[0];
        if (imgKey.length === 32 && subKey.length === 32) {
            WbiState.keys = { imgKey, subKey, mixinKey: Core.wbiMixinKey(imgKey, subKey) };
        }
        return json;
    }

    function signedUrl(url) {
        if (!WbiState.keys) return null;
        const { base, params } = parseQuery(url);
        return base + '?' + Core.wbiSignedQuery(params, WbiState.keys.mixinKey, Math.floor(Date.now() / 1000));
    }

    function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

    /**
     * Background-tab timer throttling fix: browsers throttle setTimeout in
     * background tabs down to ~once per minute, which paused scans when the
     * user switched tabs. A dedicated Web Worker's timers are NOT throttled,
     * so we race worker timing against a (throttled) setTimeout fallback.
     * Falls back silently to plain setTimeout when workers are blocked by CSP.
     */
    const Sleeper = {
        worker: null,
        token: 0,
        init() {
            try {
                const src = 'onmessage=function(e){setTimeout(function(){postMessage(e.data)},e.data.ms)}';
                this.worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
            } catch (e) { this.worker = null; }
        },
        sleep(ms) {
            return new Promise((resolve) => {
                const token = ++this.token;
                let done = false;
                const fin = () => {
                    if (done) return;
                    done = true;
                    if (this.worker) this.worker.onmessage = null;
                    clearTimeout(timer);
                    resolve();
                };
                // fallback timer fires a bit late on purpose (worker should win)
                const timer = setTimeout(fin, ms + 3000);
                if (this.worker) {
                    this.worker.onmessage = (e) => { if (e.data === token) fin(); };
                    this.worker.postMessage({ ms, data: token });
                }
            });
        },
    };

    /**
     * Slot-claiming throttle: safe under concurrency. Each caller atomically
     * claims the next free time slot, THEN sleeps until it. No matter how many
     * workers run in parallel, the global request pace stays one request per
     * reqDelayMin..Max ms - parallelism only overlaps network round-trips.
     */
    async function throttle() {
        const now = Date.now();
        const delay = CONFIG.reqDelayMinMs + Math.random() * (CONFIG.reqDelayMaxMs - CONFIG.reqDelayMinMs);
        const slotAt = Math.max(now, lastRequestAt + delay);
        lastRequestAt = slotAt; // claim the slot immediately (atomic on the JS thread)
        const wait = slotAt - now;
        if (wait > 0) await Sleeper.sleep(wait);
    }

    /**
     * Page-level fetch first: carries the real browser fingerprint (Origin,
     * sec-* headers, cookies) and looks exactly like the page's own requests.
     * GM_xmlhttpRequest is only a fallback (it is issued by the extension
     * process and lacks those headers, which trips bilibili's gaia risk
     * control with -352).
     */
    async function rawRequest(url, referer) {
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), CONFIG.requestTimeoutMs);
            try {
                const res = await fetch(url, { method: 'GET', credentials: 'include', signal: ctrl.signal });
                return { status: res.status, responseText: await res.text() };
            } finally {
                clearTimeout(timer);
            }
        } catch (e) {
            // network error, CORS rejection or abort -> fall through to GM
        }
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout: CONFIG.requestTimeoutMs,
                headers: referer ? { Referer: referer } : {},
                onload: (res) => resolve(res),
                onerror: () => reject(new RetryableError(-1, 'network error')),
                ontimeout: () => reject(new RetryableError(-2, 'timeout')),
            });
        });
    }

    /** GET a bilibili api endpoint (wbi-signed unless opts.sign===false). Retries on risk-control / transient errors with backoff. */
    async function apiGet(url, referer, opts) {
        opts = opts || {};
        const name = endpointName(url);
        let lastErr = null;
        for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
            if (ScanEngine.stopFlag) throw new ApiError(-100, '已停止');

            let target = url;
            if (opts.sign !== false) {
                if (!WbiState.keys) {
                    try { await getNav(false); } catch (e) {
                        if (e.code === -101 || e.code === -100) throw e;
                        lastErr = e; target = null;
                    }
                }
                if (WbiState.keys) target = signedUrl(url);
            }

            if (target) {
                await throttle();
                let res;
                try {
                    res = await rawRequest(target, referer);
                } catch (e) {
                    lastErr = e;
                }
                if (res) {
                    if (res.status !== 200) {
                        lastErr = new RetryableError(res.status, `HTTP ${res.status}`);
                    } else {
                        try {
                            const json = JSON.parse(res.responseText);
                            if (json.code === 0) return json;
                            if (json.code === -101) throw new ApiError(-101, '未登录或登录态失效，请刷新B站页面后重试');
                            if (json.code === -352 && opts.sign !== false) {
                                WbiState.keys = null; // force key refresh + re-sign on next attempt
                            }
                            lastErr = new RetryableError(json.code, json.message || '接口返回错误');
                        } catch (e) {
                            if (e instanceof ApiError && !e.retryable) throw e;
                            lastErr = e && e.retryable ? e : new RetryableError(-3, '响应解析失败');
                        }
                    }
                }
            }

            // risk-control codes need a much longer backoff window before retrying
            const isRisk = lastErr && (lastErr.code === -352 || lastErr.code === -403 || lastErr.code === -412);
            const backoff = isRisk
                ? CONFIG.riskBackoffBaseMs * Math.pow(2, attempt) + Math.random() * 2000
                : CONFIG.retryBaseMs * Math.pow(2, attempt) + Math.random() * 1000;
            UI.log(`${name} 请求失败(${lastErr ? lastErr.message : 'unknown'})，${isRisk ? '疑似风控，' : ''}${Math.round(backoff / 1000)}s 后重试 (${attempt + 1}/${CONFIG.maxRetries})`, 'warn');
            await Sleeper.sleep(backoff);
        }
        throw lastErr || new ApiError(-4, '请求失败');
    }

    // ============================ Scan engine ============================

    const ScanEngine = {
        stopFlag: false,
        running: false,

        async getFollowings(myMid) {
            const all = [];
            let pn = 1;
            for (;;) {
                const json = await apiGet(API.followings(myMid, pn), 'https://space.bilibili.com/');
                const page = Core.parseFollowings(json);
                all.push(...page.list);
                if (all.length >= page.total || page.list.length === 0 || pn >= 40) break;
                pn++;
            }
            return all;
        },

        /** Enumerate "我追的" entries, probing each to keep only ugc seasons (folders are skipped). */
        async getCollectedSeasons(myMid) {
            const seasons = [];
            let pn = 1;
            for (;;) {
                const json = await apiGet(API.collectedList(myMid, pn), 'https://space.bilibili.com/');
                const page = Core.parseCollectedList(json);
                for (const it of page.list) {
                    try {
                        const probe = await apiGet(API.seasonArchives(it.mid || myMid, it.id, 1), `https://space.bilibili.com/`);
                        const meta = (probe.data && probe.data.meta) || {};
                        if (String(meta.season_id) === it.id) {
                            seasons.push({ seasonId: it.id, title: meta.name || it.title, mid: String(meta.mid || it.mid || '') });
                        }
                    } catch (e) { /* entry is a fav folder or request failed - skip */ }
                }
                if (seasons.length >= page.total || !page.list.length || pn >= 20) break;
                pn++;
            }
            return seasons;
        },

        /** Mark a UP as scanned just now (its incremental floor for next time). */
        setLastScanTs(state, mid, ts) {
            if (!state.ups[mid]) state.ups[mid] = { mid, name: '', face: '' };
            state.ups[mid].lastTs = ts;
        },

        /** Scan a single UP until dynamics older than sinceTs. Throws on persistent failure. */
        async scanUp(up, sinceTs, state) {
            const t0 = Math.floor(Date.now() / 1000);
            let offset = '';
            let found = 0;
            for (let i = 0; i < CONFIG.maxPagesPerUp; i++) {
                const json = await apiGet(API.feedSpace(up.mid, offset), `https://space.bilibili.com/${up.mid}/dynamic`);
                const page = Core.parseFeedPage(json, sinceTs);
                found += Core.mergeVideos(state.videos, page.videos);
                Core.mergeUps(state.ups, page.ups);
                // inner progress: show which time point we have paged back to,
                // so a long scan through a prolific UP never looks stuck
                if (page.oldestTs > 0) {
                    UI.progressSub(`${up.name} · 第${i + 1}页 · 已扫到 ${Core.fmtDateTime(page.oldestTs)} · 累计+${found}`);
                }
                if (Core.shouldStopPaging(page, sinceTs)) {
                    this.setLastScanTs(state, up.mid, t0);
                    return found;
                }
                offset = page.offset;
            }
            this.setLastScanTs(state, up.mid, t0); // safety cap reached, coverage is still contiguous
            return found;
        },

        /** Scan one subscribed season: page through all episodes, filter by sinceTs. */
        async scanSeason(entry, sinceTs, state) {
            const t0 = Math.floor(Date.now() / 1000);
            let found = 0;
            let title = entry.name;
            for (let pn = 1; pn <= 100; pn++) {
                const json = await apiGet(API.seasonArchives(entry.mid, entry.seasonId, pn), 'https://space.bilibili.com/');
                const page = Core.parseSeasonPage(json, sinceTs);
                found += Core.mergeVideos(state.videos, page.videos);
                if (page.meta.seasonId) {
                    const s = state.seasons[page.meta.seasonId] = state.seasons[page.meta.seasonId]
                        || { seasonId: page.meta.seasonId, mid: page.meta.mid, title: page.meta.name, lastTs: 0 };
                    if (page.meta.name) { s.title = page.meta.name; if (!title) title = page.meta.name; }
                    if (page.meta.mid) Core.mergeUps(state.ups, { [page.meta.mid]: { name: '', face: page.meta.cover } });
                }
                UI.progressSub(`${title || entry.seasonId} · 第${pn}页 · 累计+${found}`);
                if (!page.hasMore) break;
            }
            if (state.seasons[entry.seasonId]) state.seasons[entry.seasonId].lastTs = t0;
            else state.seasons[entry.seasonId] = { seasonId: entry.seasonId, mid: entry.mid, title, lastTs: t0 };
            return found;
        },

        /** Enumerate the user's bangumi/drama follow list (type 1 + 2 merged).
         *  Returns { follows: [{seasonId, title}], liveSet } for queueing + cleanup,
         *  or null when the list could not be fetched (cleanup is then skipped). */
        async getBangumiFollows(myMid) {
            const follows = [];
            const liveSet = new Set();
            try {
                for (const type of [1, 2]) {
                    let pn = 1;
                    for (;;) {
                        const json = await apiGet(API.bangumiFollow(myMid, type, pn), `https://space.bilibili.com/${myMid}/bangumi`);
                        const page = Core.parseBangumiFollowList(json);
                        for (const it of page.list) {
                            if (!liveSet.has(it)) { liveSet.add(it); follows.push({ seasonId: it }); }
                        }
                        if (!page.hasNext || !page.list.length || pn >= 30) break;
                        pn++;
                    }
                }
                return { follows, liveSet };
            } catch (e) {
                UI.log(`追番追剧列表获取失败(${e.message})，本次跳过对应内容`, 'warn');
                return null;
            }
        },

        /** Fetch one followed season's full episode list (single request, no window limit). */
        async scanBangumi(entry, state) {
            const json = await apiGet(API.pgcSeason(entry.seasonId), 'https://space.bilibili.com/');
            const page = Core.parsePgcSeason(json);
            const found = Core.mergeVideos(state.videos, page.videos);
            UI.progressSub(`${page.title || entry.seasonId} · ${page.videos.length} 集 · +${found}`);
            return found;
        },

        /**
         * mode: 'full' (fresh sinceTs from UI date) | 'increment' (since lastScanTs)
         *       | 'resume' (continue stored scan)
         */
        async run(mode, dateStr) {
            if (this.running) { UI.log('已有扫描在进行中', 'warn'); return; }
            this.running = true;
            this.stopFlag = false;
            UI.setScanning(true);
            UI.captureAnchor(); // remember where the user was before data changes

            const state = Store.load();
            try {
                if (mode === 'resume' && !state.scan) {
                    UI.log('没有未完成的扫描', 'warn');
                    return;
                }

                let sinceTs;
                if (mode === 'resume') {
                    sinceTs = state.scan.sinceTs;
                } else if (mode === 'full') {
                    sinceTs = Core.dateStrToTs(dateStr);
                    if (!sinceTs) { UI.log('请先选择有效的起始日期', 'warn'); return; }
                } else {
                    // incremental: per-UP bound computed inside the loop (see Core.incSinceTs);
                    // store the fallback only, for reference/progress display
                    sinceTs = state.lastScanTs || 0;
                }

                if (mode !== 'resume') {
                    UI.log('正在获取账号信息与关注列表...');
                    const nav = await getNav(false);
                    if (!(nav.data && nav.data.isLogin)) throw new ApiError(-101, 'B站账号未登录');
                    const myMid = nav.data.mid;
                    const followings = await this.getFollowings(myMid);
                    UI.log('正在枚举"我追的"订阅合集...');
                    const collectedSeasons = await this.getCollectedSeasons(myMid);
                    UI.log('正在枚举追番追剧列表...');
                    const bangumi = await this.getBangumiFollows(myMid);
                    const bangumiFollows = bangumi ? bangumi.follows : [];
                    const liveBangumi = bangumi ? bangumi.liveSet : null;

                    if (mode === 'increment') {
                        // apply unfollow/unsubscribe/un-bangumi cleanup according to settings
                        const liveFollows = new Set(followings.map((u) => u.mid));
                        const liveSeasons = new Set(collectedSeasons.map((s) => s.seasonId));
                        const pr = Core.pruneSources(state, liveFollows, liveSeasons, liveBangumi, state.settings);
                        if (pr.removedVideos || pr.untagged) {
                            UI.log(`取关/退订清理：删除 ${pr.removedVideos} 条记录，${pr.untagged} 条移出对应分类`);
                        }
                    }

                    state.scan = {
                        sinceTs,
                        startedAt: Math.floor(Date.now() / 1000),
                        queue: [
                            ...followings.map((u) => ({ kind: 'up', mid: u.mid, name: u.uname })),
                            ...collectedSeasons.map((s) => ({ kind: 'season', seasonId: s.seasonId, mid: s.mid, name: s.title })),
                            ...bangumiFollows.map((b) => ({ kind: 'bangumi', seasonId: b.seasonId, name: `追番 ${b.seasonId}` })),
                        ],
                        done: 0,
                        errors: [],
                        mode,
                    };
                    Store.save(state);
                    if (mode === 'full') {
                        UI.log(`共 ${followings.length} 个关注 + ${collectedSeasons.length} 个订阅合集 + ${bangumiFollows.length} 部追番追剧，起始日期 ${Core.fmtDate(sinceTs)}`);
                    } else {
                        UI.log(`共 ${followings.length} 个关注 + ${collectedSeasons.length} 个订阅合集 + ${bangumiFollows.length} 部追番追剧，增量更新（新关注/新订阅将自动补全历史）`);
                    }
                }

                const scan = state.scan;
                const total = scan.queue.length;
                const workerBody = async () => {
                    for (;;) {
                        if (this.stopFlag) return;
                        const entry = scan.queue.shift();
                        if (!entry) return;
                        UI.progress(scan.done, total, entry.name || entry.mid);
                        try {
                            let found = 0;
                            if (entry.kind === 'season') {
                                const seasonSince = (scan.mode === 'increment')
                                    ? ((state.seasons[entry.seasonId] && state.seasons[entry.seasonId].lastTs) || state.globalFloorTs)
                                    : sinceTs;
                                found = await this.scanSeason(entry, seasonSince, state);
                            } else if (entry.kind === 'bangumi') {
                                found = await this.scanBangumi(entry, state);
                            } else {
                                const upSince = (scan.mode === 'increment')
                                    ? Core.incSinceTs(state.ups[entry.mid], state.globalFloorTs, state.lastScanTs)
                                    : sinceTs;
                                found = await this.scanUp(entry, upSince, state);
                            }
                            UI.log(`${entry.name || entry.mid}: +${found} 条`);
                        } catch (e) {
                            if (e.code === -100) { scan.queue.unshift(entry); return; } // stopped mid-entry: put it back
                            if (e.code === -101) throw e; // fatal: not logged in
                            scan.errors.push({ mid: entry.mid || entry.seasonId, uname: entry.name || '', msg: e.message });
                            UI.log(`${entry.name || entry.mid}: 失败 ${e.message}`, 'error');
                        }
                        scan.done++;
                        Store.save(state); // persist after every entry for resumability
                    }
                };
                const workers = [];
                for (let w = 0; w < CONFIG.workerCount; w++) workers.push(workerBody());
                await Promise.all(workers);
                if (this.stopFlag) { UI.log('扫描已暂停，可稍后"继续未完成的扫描"', 'warn'); Store.save(state); return; }

                // bangumi entries are scanned inside the queue above (kind='bangumi');
                // each followed season is fetched whole on every run, so nothing
                // extra to do here.

                state.lastScanTs = scan.startedAt;
                if (scan.mode === 'full') {
                    // deepest full-scan date becomes the backfill floor for newly followed UPs
                    state.globalFloorTs = state.globalFloorTs ? Math.min(state.globalFloorTs, sinceTs) : sinceTs;
                }
                const totalVids = Object.keys(state.videos).length;
                state.scan = null;
                Store.save(state);
                UI.log(`扫描完成：库中共 ${totalVids} 条视频，错误 ${scan.errors.length} 个`);
                UI.renderStats();
                UI.renderListAnchored();
            } catch (e) {
                UI.log(`扫描中断：${e.message}`, 'error');
                Store.save(state);
            } finally {
                this.running = false;
                this.stopFlag = false;
                UI.setScanning(false);
                UI.progress(null);
                UI.updateButtons();
            }
        },

        stop() {
            if (this.running) this.stopFlag = true;
        },
    };

    // ============================ UI ============================

    const UI = {
        els: {},

        injectStyles() {
            const style = document.createElement('style');
            style.textContent = `
#bfua-fab{position:fixed;right:20px;bottom:20px;z-index:999990;width:44px;height:44px;border-radius:50%;background:#fb7299;color:#fff;border:none;cursor:pointer;font-size:20px;box-shadow:0 2px 8px rgba(0,0,0,.3);line-height:1}
#bfua-panel{position:fixed;right:20px;bottom:74px;z-index:999991;width:680px;max-width:calc(100vw - 32px);max-height:85vh;overflow:auto;background:#fff;color:#18191c;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.2);font-size:13px;display:none;padding:14px}
#bfua-panel.open{display:block}
#bfua-panel *{box-sizing:border-box}
.bfua-row{margin-bottom:10px}
.bfua-btn{border:1px solid #e3e5e7;background:#fff;color:#18191c;border-radius:6px;padding:5px 12px;cursor:pointer;font-size:13px;margin-right:6px}
.bfua-btn:hover{background:#f1f2f3}
.bfua-btn.primary{background:#fb7299;border-color:#fb7299;color:#fff}
.bfua-btn.danger{color:#e0533d;border-color:#ffb4a8}
.bfua-btn:disabled{opacity:.5;cursor:not-allowed}
#bfua-progress-bar{height:6px;background:#f1f2f3;border-radius:3px;overflow:hidden;margin:6px 0}
#bfua-progress-fill{height:100%;width:0;background:#fb7299;transition:width .3s}
#bfua-log{background:#f6f7f8;border-radius:6px;padding:8px;height:110px;overflow-y:auto;font-size:12px;line-height:1.7;font-family:Consolas,monospace;white-space:pre-wrap;word-break:break-all}
.bfua-log-warn{color:#b88100}
.bfua-log-error{color:#e0533d}
#bfua-list{border-top:1px solid #e3e5e7;margin-top:6px;height:46vh;overflow-y:auto}
#bfua-tabs{display:flex;gap:4px;margin-top:10px;flex-wrap:nowrap;overflow-x:auto}
.bfua-tab{border:1px solid #e3e5e7;background:#fff;color:#61666d;border-radius:6px;padding:4px 12px;cursor:pointer;font-size:12.5px;flex:0 0 auto}
.bfua-tab:hover{background:#f6f7f8}
.bfua-tab.active{background:#fb7299;border-color:#fb7299;color:#fff}
#bfua-settings-overlay{position:fixed;inset:0;z-index:999995;background:rgba(0,0,0,.4);display:none;align-items:center;justify-content:center}
#bfua-settings-overlay.open{display:flex}
#bfua-settings-card{background:#fff;color:#18191c;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.3);width:380px;max-width:calc(100vw - 32px);padding:16px;font-size:13px}
#bfua-settings-card label{display:flex;align-items:center;gap:8px;margin:12px 0;cursor:pointer}
#bfua-settings-card select{border:1px solid #e3e5e7;border-radius:6px;padding:4px 6px;font-size:13px;background:#fff;color:#18191c}
.bfua-item{display:flex;gap:10px;padding:8px 4px;border-bottom:1px solid #f1f2f3;color:inherit;text-decoration:none;line-height:1.45}
.bfua-item:hover{background:#f6f7f8}
.bfua-cover{flex:0 0 152px;width:152px;height:95px;border-radius:6px;object-fit:cover;background:#e3e5e7}
.bfua-cover-empty{flex:0 0 152px;width:152px;height:95px;border-radius:6px;background:#e3e5e7;display:flex;align-items:center;justify-content:center;color:#9499a0;font-size:22px}
.bfua-meta{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;justify-content:center}
.bfua-line1{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.bfua-face{width:22px;height:22px;border-radius:50%;object-fit:cover;background:#e3e5e7}
.bfua-face-empty{width:22px;height:22px;border-radius:50%;background:#e3e5e7;flex:0 0 22px}
.bfua-up{color:#00aeec;font-size:13px}
.bfua-badge-dyn{color:#ff7f24;border:1px solid #ffb27a;border-radius:4px;padding:0 4px;font-size:11px}
.bfua-dur{color:#9499a0;font-size:12px;margin-left:auto;flex:0 0 auto}
.bfua-title{font-size:13.5px;margin:3px 0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.bfua-time{color:#9499a0;font-size:12px;font-family:Consolas,monospace}
#bfua-pager{display:flex;gap:5px;align-items:center;justify-content:center;padding:8px 0;flex-wrap:nowrap;overflow-x:auto}
#bfua-pager .bfua-btn{padding:4px 9px;font-size:12px;flex:0 0 auto}
#bfua-pager input{width:52px;border:1px solid #e3e5e7;border-radius:6px;padding:4px 4px;font-size:12px;text-align:center;background:#fff;color:#18191c;flex:0 0 auto}
#bfua-pager .bfua-page-info{color:#61666d;font-size:12px;white-space:nowrap;flex:0 0 auto}
.bfua-stats{color:#61666d;margin:6px 0}
@media (prefers-color-scheme:dark){
#bfua-panel{background:#1e2022;color:#e3e5e7}
.bfua-btn{background:#2f3134;border-color:#3f4145;color:#e3e5e7}
.bfua-btn:hover{background:#3a3c40}
#bfua-progress-bar{background:#2f3134}
#bfua-log{background:#17181a;color:#c9ccd0}
.bfua-item:hover{background:#26272a}
.bfua-item{border-bottom-color:#2f3134}
.bfua-item .up{color:#00aeec}
#bfua-pager input{background:#2f3134;border-color:#3f4145;color:#e3e5e7}
.bfua-cover,.bfua-cover-empty,.bfua-face,.bfua-face-empty{background:#3a3c40}
}
`;
            document.head.appendChild(style);
        },

        build() {
            this.injectStyles();

            const fab = document.createElement('button');
            fab.id = 'bfua-fab';
            fab.title = 'B站关注UP视频聚合器';
            fab.textContent = '📺';

            const panel = document.createElement('div');
            panel.id = 'bfua-panel';
            panel.innerHTML = `
<div class="bfua-row"><b>📺 关注UP视频聚合器</b>
  <button class="bfua-btn" id="bfua-close" style="float:right;padding:2px 8px">×</button>
</div>
<div class="bfua-row">
  <label>起始日期 <input type="date" id="bfua-since"></label>
  <button class="bfua-btn primary" id="bfua-full">全量补课</button>
  <button class="bfua-btn" id="bfua-inc">增量更新</button>
  <button class="bfua-btn" id="bfua-resume" hidden>继续未完成的扫描</button>
  <button class="bfua-btn danger" id="bfua-stop" hidden>停止</button>
</div>
<div class="bfua-row" id="bfua-progress-row" hidden>
  <div id="bfua-progress-text" style="color:#61666d"></div>
  <div id="bfua-progress-bar"><div id="bfua-progress-fill"></div></div>
</div>
<div class="bfua-row"><div id="bfua-log"></div></div>
<div class="bfua-stats" id="bfua-stats"></div>
<div class="bfua-row">
  <button class="bfua-btn" id="bfua-export">导出 JSON</button>
  <button class="bfua-btn" id="bfua-import">导入 JSON</button>
  <button class="bfua-btn" id="bfua-settings">⚙ 设置</button>
  <button class="bfua-btn danger" id="bfua-clear">清空数据</button>
  <input type="file" id="bfua-import-file" accept=".json,application/json" style="display:none">
</div>
<div id="bfua-tabs"></div>
<div id="bfua-list"></div>
<div id="bfua-pager"></div>
`;
            document.body.appendChild(fab);
            document.body.appendChild(panel);

            const overlay = document.createElement('div');
            overlay.id = 'bfua-settings-overlay';
            overlay.innerHTML = `
<div id="bfua-settings-card">
  <b>⚙ 设置</b>
  <button class="bfua-btn" id="bfua-settings-close" style="float:right;padding:2px 8px">×</button>
  <label>默认分类标签页
    <select id="bfua-set-default-tab">
      <option value="all">全部视频</option>
      <option value="follow">视频投稿</option>
      <option value="pgc">追番追剧</option>
      <option value="season">订阅合集</option>
    </select>
  </label>
  <label><input type="checkbox" id="bfua-set-del-unsub"> 取消订阅合集时移除对应记录</label>
  <label><input type="checkbox" id="bfua-set-del-unfollow"> 取消关注UP主时移除对应记录</label>
  <label><input type="checkbox" id="bfua-set-del-bangumi"> 取消追番追剧时移除对应记录</label>
  <div style="color:#9499a0;font-size:12px;line-height:1.6;margin:8px 0">说明：交叉来源的视频（既是UP动态又在订阅合集中）只会移出对应分类页，所有来源都移除后才删除本地记录。</div>
  <button class="bfua-btn primary" id="bfua-settings-save" style="width:100%">保存</button>
</div>
`;
            document.body.appendChild(overlay);

            this.els = {
                fab, panel,
                close: panel.querySelector('#bfua-close'),
                since: panel.querySelector('#bfua-since'),
                full: panel.querySelector('#bfua-full'),
                inc: panel.querySelector('#bfua-inc'),
                resume: panel.querySelector('#bfua-resume'),
                stop: panel.querySelector('#bfua-stop'),
                progressRow: panel.querySelector('#bfua-progress-row'),
                progressText: panel.querySelector('#bfua-progress-text'),
                progressFill: panel.querySelector('#bfua-progress-fill'),
                log: panel.querySelector('#bfua-log'),
                stats: panel.querySelector('#bfua-stats'),
                list: panel.querySelector('#bfua-list'),
                pager: panel.querySelector('#bfua-pager'),
                exportBtn: panel.querySelector('#bfua-export'),
                importBtn: panel.querySelector('#bfua-import'),
                importFile: panel.querySelector('#bfua-import-file'),
                clearBtn: panel.querySelector('#bfua-clear'),
                tabs: panel.querySelector('#bfua-tabs'),
                settingsBtn: panel.querySelector('#bfua-settings'),
                settingsOverlay: overlay,
                settingsClose: overlay.querySelector('#bfua-settings-close'),
                settingsSave: overlay.querySelector('#bfua-settings-save'),
                setDefaultTab: overlay.querySelector('#bfua-set-default-tab'),
                setDelUnsub: overlay.querySelector('#bfua-set-del-unsub'),
                setDelUnfollow: overlay.querySelector('#bfua-set-del-unfollow'),
                setDelBangumi: overlay.querySelector('#bfua-set-del-bangumi'),
            };

            fab.addEventListener('click', () => {
                const isOpen = panel.classList.toggle('open');
                if (isOpen) { this.renderTabs(); this.renderStats(); this.renderList(this.loadPage()); this.updateButtons(); }
            });
            // quick paging with arrow keys while the panel is open
            document.addEventListener('keydown', (e) => {
                if (!panel.classList.contains('open')) return;
                const tag = (document.activeElement && document.activeElement.tagName) || '';
                if (tag === 'INPUT' || tag === 'TEXTAREA') return;
                if (e.key === 'ArrowLeft') { e.preventDefault(); this.renderList(this.currentPage - 1); }
                else if (e.key === 'ArrowRight') { e.preventDefault(); this.renderList(this.currentPage + 1); }
            });
            this.els.close.addEventListener('click', () => panel.classList.remove('open'));
            this.els.full.addEventListener('click', () => ScanEngine.run('full', this.els.since.value));
            this.els.inc.addEventListener('click', () => {
                const state = Store.load();
                if (!Object.keys(state.videos).length && !confirm('当前没有基线数据，增量更新会把所有关注UP完整扫描一遍（等同全量）。仍要继续吗？')) return;
                ScanEngine.run('increment');
            });            this.els.resume.addEventListener('click', () => ScanEngine.run('resume'));
            this.els.stop.addEventListener('click', () => ScanEngine.stop());
            this.els.exportBtn.addEventListener('click', () => this.exportJson());
            this.els.settingsBtn.addEventListener('click', () => {
                const s = Store.load().settings;
                this.els.setDefaultTab.value = s.defaultTab || 'all';
                this.els.setDelUnsub.checked = s.delOnUnsubscribe !== false;
                this.els.setDelUnfollow.checked = s.delOnUnfollow !== false;
                this.els.setDelBangumi.checked = s.delOnUnfollowBangumi !== false;
                this.els.settingsOverlay.classList.add('open');
            });
            this.els.settingsClose.addEventListener('click', () => this.els.settingsOverlay.classList.remove('open'));
            this.els.settingsOverlay.addEventListener('click', (e) => {
                if (e.target === this.els.settingsOverlay) this.els.settingsOverlay.classList.remove('open');
            });
            this.els.settingsSave.addEventListener('click', () => {
                const state = Store.load();
                state.settings = {
                    defaultTab: this.els.setDefaultTab.value,
                    delOnUnsubscribe: this.els.setDelUnsub.checked,
                    delOnUnfollow: this.els.setDelUnfollow.checked,
                    delOnUnfollowBangumi: this.els.setDelBangumi.checked,
                };
                Store.save(state);
                this.els.settingsOverlay.classList.remove('open');
                this.log('设置已保存');
                this.renderTabs();
            });
            this.els.importBtn.addEventListener('click', () => {
                if (ScanEngine.running) { this.log('扫描进行中，请先停止再导入', 'warn'); return; }                this.els.importFile.value = '';
                this.els.importFile.click();
            });
            this.els.importFile.addEventListener('change', () => {
                const file = this.els.importFile.files && this.els.importFile.files[0];
                if (file) this.importJson(file);
            });
            this.els.clearBtn.addEventListener('click', () => {
                if (ScanEngine.running) { this.log('扫描进行中，请先停止', 'warn'); return; }
                if (!confirm('确定清空全部已聚合的视频数据？')) return;
                Store.clear();
                this.anchorBvid = null;
                for (const t of this.TABS) {
                    try { localStorage.removeItem('bfua_page_' + t.id); } catch (e) { /* ignore */ }
                }
                try { localStorage.removeItem('bfua_tab'); } catch (e) { /* ignore */ }
                this.currentTab = null;
                this.renderStats();
                this.renderList(1);
                this.log('数据已清空');
                this.updateButtons();
            });

            this.updateButtons();
        },

        updateButtons() {
            const state = Store.load();
            const hasPending = Boolean(state.scan);
            const scanning = ScanEngine.running;
            this.els.resume.hidden = !hasPending || scanning;
            this.els.stop.hidden = !scanning;
            this.els.full.disabled = scanning;
            this.els.inc.disabled = scanning;
        },

        setScanning(on) {
            this.els.progressRow.hidden = !on;
            this.updateButtons();
        },

        progress(done, total, label) {
            if (done === null) { this.els.progressFill.style.width = '0%'; this._pDone = null; return; }
            this._pDone = done;
            this._pTotal = total;
            this._pLabel = label || '';
            const pct = total ? Math.round((done / total) * 100) : 0;
            this.els.progressFill.style.width = pct + '%';
            this._renderProgressText();
        },

        /** update only the label line (e.g. per-UP inner progress), keep the bar */
        progressSub(label) {
            this._pLabel = label || '';
            if (this._pDone != null) this._renderProgressText();
        },

        _renderProgressText() {
            const pct = this._pTotal ? Math.round((this._pDone / this._pTotal) * 100) : 0;
            this.els.progressText.textContent = `${this._pDone}/${this._pTotal} (${pct}%) ${this._pLabel}`;
        },

        log(msg, type) {
            const div = document.createElement('div');
            if (type) div.className = 'bfua-log-' + type;
            const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
            div.textContent = `[${time}] ${msg}`;
            this.els.log.appendChild(div);
            this.els.log.scrollTop = this.els.log.scrollHeight;
            while (this.els.log.children.length > 200) this.els.log.removeChild(this.els.log.firstChild);
        },

        renderStats() {
            const state = Store.load();
            const n = Object.keys(state.videos).length;
            const nSeasons = Object.keys(state.seasons || {}).length;
            const parts = [`库中 ${n} 条`];
            if (nSeasons) parts.push(`${nSeasons} 个订阅合集`);
            if (state.lastScanTs) parts.push(`上次扫描 ${Core.fmtDateTime(state.lastScanTs)}`);
            if (state.scan) parts.push(`未完成：剩余 ${state.scan.queue.length} 项`);
            if (state.scan && state.scan.errors && state.scan.errors.length) parts.push(`错误 ${state.scan.errors.length} 个`);
            this.els.stats.textContent = parts.join(' · ');
            this.updateButtons();
        },

        currentPage: 1,
        anchorBvid: null, // in-memory only (never persisted): first visible item when a scan starts

        TABS: [
            { id: 'all', label: '全部视频' },
            { id: 'follow', label: '视频投稿' },
            { id: 'pgc', label: '追番追剧' },
            { id: 'season', label: '订阅合集' },
        ],

        currentTab: null,

        saveTab(tab) {
            try { localStorage.setItem('bfua_tab', tab); } catch (e) { /* ignore */ }
        },
        loadTab() {
            const state = Store.load();
            let tab = null;
            try { tab = localStorage.getItem('bfua_tab'); } catch (e) { /* ignore */ }
            if (!tab || this.TABS.every((t) => t.id !== tab)) tab = (state.settings && state.settings.defaultTab) || 'all';
            return tab;
        },

        renderTabs() {
            if (!this.currentTab) this.currentTab = this.loadTab();
            const tab = this.currentTab;
            this.els.tabs.innerHTML = '';
            for (const t of this.TABS) {
                const b = document.createElement('button');
                b.className = 'bfua-tab' + (t.id === tab ? ' active' : '');
                b.textContent = t.label;
                b.addEventListener('click', () => {
                    this.currentTab = t.id;
                    this.saveTab(t.id);
                    this.renderTabs();
                    this.renderList(1);
                });
                this.els.tabs.appendChild(b);
            }
        },

        /**
         * Capture the first visible item of the currently viewed page as the
         * resume anchor. Called at the start of EVERY scan run (full/increment/
         * resume), so the anchor always reflects where the user is right now.
         */
        captureAnchor() {
            this.anchorBvid = null;
            const state = Store.load();
            const list = Core.filterByTab(Core.sortedList(state.videos), this.currentTab || this.loadTab());
            if (!list.length) return;
            const pages = Math.ceil(list.length / CONFIG.listPageSize);
            const page = Math.min(this.loadPage() || 1, pages);
            const first = list[(page - 1) * CONFIG.listPageSize];
            if (first) this.anchorBvid = first.bvid;
        },

        /** Re-render the list positioned so the anchor video is still visible. */
        renderListAnchored() {
            const state = Store.load();
            const list = Core.filterByTab(Core.sortedList(state.videos), this.currentTab || this.loadTab());
            this.renderList(Core.pageForAnchor(list, this.anchorBvid, CONFIG.listPageSize));
        },

        /** persist current page (per-tab) in localStorage (separate from GM scan state to avoid write races) */
        savePage(page) {
            try { localStorage.setItem('bfua_page_' + (this.currentTab || 'all'), String(page)); } catch (e) { /* ignore */ }
        },
        loadPage() {
            const n = parseInt(localStorage.getItem('bfua_page_' + (this.currentTab || 'all')) || '1', 10);
            return Number.isFinite(n) && n >= 1 ? n : 1;
        },

        renderList(page) {
            const state = Store.load();
            const list = Core.filterByTab(Core.sortedList(state.videos), this.currentTab || this.loadTab());
            const pages = Math.max(1, Math.ceil(list.length / CONFIG.listPageSize));
            page = Math.min(Math.max(1, page), pages);
            this.currentPage = page;
            this.savePage(page);
            const slice = list.slice((page - 1) * CONFIG.listPageSize, page * CONFIG.listPageSize);
            this.els.list.scrollTop = 0; // reset scroll position on page change

            this.els.list.innerHTML = '';
            if (!slice.length) {
                this.els.list.innerHTML = '<div style="padding:24px;color:#9499a0;text-align:center">暂无数据，请先执行全量补课</div>';
            } else {
                for (const v of slice) {
                    const up = state.ups[v.upMid] || {};
                    const a = document.createElement('a');
                    a.className = 'bfua-item';
                    a.href = v.url;
                    a.target = '_blank';
                    a.rel = 'noopener';

                    // cover (16:10 thumbnail), placeholder when missing (pre-1.3.0 data)
                    if (v.cover) {
                        const img = document.createElement('img');
                        img.className = 'bfua-cover';
                        img.loading = 'lazy';
                        img.src = v.cover;
                        img.alt = '';
                        a.appendChild(img);
                    } else {
                        const ph = document.createElement('div');
                        ph.className = 'bfua-cover-empty';
                        ph.textContent = '🎬';
                        a.appendChild(ph);
                    }

                    const meta = document.createElement('div');
                    meta.className = 'bfua-meta';

                    const line1 = document.createElement('div');
                    line1.className = 'bfua-line1';
                    if (up.face) {
                        const face = document.createElement('img');
                        face.className = 'bfua-face';
                        face.loading = 'lazy';
                        face.src = up.face;
                        face.alt = '';
                        line1.appendChild(face);
                    } else {
                        const ph = document.createElement('div');
                        ph.className = 'bfua-face-empty';
                        line1.appendChild(ph);
                    }
                    const upNameEl = document.createElement('span'); upNameEl.className = 'bfua-up'; upNameEl.textContent = v.seasonName || up.name || v.upMid;
                    line1.appendChild(upNameEl);
                    // highlight non-upload videos only (uploads are the common case -> keep quiet)
                    if (v.badge && v.badge !== '投稿视频') {
                        const badge = document.createElement('span');
                        badge.className = 'bfua-badge-dyn';
                        badge.textContent = v.badge;
                        line1.appendChild(badge);
                    }
                    const dur = document.createElement('span'); dur.className = 'bfua-dur'; dur.textContent = v.duration;
                    line1.appendChild(dur);
                    meta.appendChild(line1);

                    const title = document.createElement('div');
                    title.className = 'bfua-title';
                    title.textContent = v.title;
                    meta.appendChild(title);

                    const time = document.createElement('div');
                    time.className = 'bfua-time';
                    time.textContent = Core.fmtDateTime(v.pubTs);
                    meta.appendChild(time);

                    a.appendChild(meta);
                    this.els.list.appendChild(a);
                }
            }

            this.els.pager.innerHTML = '';
            const mk = (text, target, disabled, title) => {
                const b = document.createElement('button');
                b.className = 'bfua-btn';
                b.textContent = text;
                b.disabled = disabled;
                if (title) b.title = title;
                b.addEventListener('click', () => this.renderList(target));
                return b;
            };
            const step = 10;
            const info = document.createElement('span');
            info.className = 'bfua-page-info';
            info.textContent = `${page} / ${pages}`;
            const jumpInput = document.createElement('input');
            jumpInput.type = 'number';
            jumpInput.min = '1';
            jumpInput.max = String(pages);
            jumpInput.value = String(page);
            jumpInput.title = '跳至指定页';
            const doJump = () => {
                const v = parseInt(jumpInput.value, 10);
                if (Number.isFinite(v)) this.renderList(v);
            };
            jumpInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doJump(); } });
            const jumpBtn = document.createElement('button');
            jumpBtn.className = 'bfua-btn';
            jumpBtn.textContent = '跳页';
            jumpBtn.addEventListener('click', doJump);
            this.els.pager.append(
                mk('首页', 1, page <= 1, '第一页'),
                mk('‹‹ 上10页', Math.max(1, page - step), page <= 1, `后退${step}页`),
                mk('‹ 上一页', page - 1, page <= 1, '上一页'),
                info,
                mk('下一页 ›', page + 1, page >= pages, '下一页'),
                mk('下10页 ››', Math.min(pages, page + step), page >= pages, `前进${step}页`),
                mk('尾页', pages, page >= pages, `最后一页 (共${pages}页)`),
                jumpInput,
                jumpBtn,
            );
        },

        async importJson(file) {
            let data;
            try {
                data = JSON.parse(await file.text());
            } catch (e) {
                this.log(`导入失败：文件不是有效的 JSON (${e.message})`, 'error');
                return;
            }
            if (!data || !Array.isArray(data.videos)) {
                this.log('导入失败：不是本脚本导出的文件（缺少 videos 数组）', 'error');
                return;
            }
            try {
                const state = Store.load();
                const before = Object.keys(state.videos).length;
                const built = Core.buildFromVideoList(data.videos);
                // authoritative per-UP table (with lastTs) comes from the new export
                // format; legacy exports only carry per-video upName/face
                const importedUps = ((data.format === 'bfua-export-v1' || data.format === 'bfua-export-v2') && data.ups && typeof data.ups === 'object')
                    ? data.ups
                    : built.ups;
                const added = Core.mergeStateForImport(state, {
                    videos: built.videos,
                    ups: importedUps,
                    globalFloorTs: Number(data.globalFloorTs) || 0,
                    lastScanTs: Number(data.lastScanTs) || 0,
                });
                // v2 export: settings + seasons snapshot (migrating preferences & season progress)
                if (data.format === 'bfua-export-v2') {
                    if (data.settings && typeof data.settings === 'object' && !Object.keys(state.settings).length) {
                        state.settings = data.settings;
                    }
                    for (const [sid, info] of Object.entries(data.seasons || {})) {
                        const ex = state.seasons[sid];
                        if (!ex) state.seasons[sid] = info;
                        else if (info.lastTs && (!ex.lastTs || info.lastTs > ex.lastTs)) ex.lastTs = info.lastTs;
                    }
                }
                Store.save(state);
                this.log(`导入完成：新增 ${added} 条，合计 ${Object.keys(state.videos).length} 条（导入前 ${before} 条）`);
                this.renderTabs();
                this.renderStats();
                this.renderList(this.loadPage());
                this.updateButtons();
            } catch (e) {
                this.log(`导入失败：${e.message}`, 'error');
            }
        },

        exportJson() {
            const state = Store.load();
            const list = Core.sortedList(state.videos).map((v) => {
                const up = state.ups[v.upMid] || {};
                return { ...v, upName: up.name || '', face: up.face || '' }; // self-contained export
            });
            if (!list.length) { this.log('没有数据可导出', 'warn'); return; }
            const payload = {
                format: 'bfua-export-v2',
                exportedAt: new Date().toISOString(),
                count: list.length,
                globalFloorTs: state.globalFloorTs || 0,
                lastScanTs: state.lastScanTs || 0,
                settings: state.settings,
                ups: state.ups,
                seasons: state.seasons || {},
                videos: list,
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `bilibili-followup-${Core.fmtDate(Math.floor(Date.now() / 1000)).replace(/-/g, '')}.json`;
            a.click();
            URL.revokeObjectURL(a.href);
            this.log(`已导出 ${list.length} 条`);
        },
    };

    // ============================ Init ============================

    function init() {
        if (document.getElementById('bfua-fab')) return;
        if (typeof GM_xmlhttpRequest === 'undefined') {
            console.error('[bfua] 需要 GM_xmlhttpRequest 权限，请使用 Tampermonkey 安装');
            return;
        }
        UI.build();
        Sleeper.init(); // worker-based timer keeps scans running in background tabs
        console.log('[bfua] 关注UP视频聚合器已加载');
    }

    if (typeof document === 'undefined') return; // offline/test environment

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
