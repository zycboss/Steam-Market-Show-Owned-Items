// ==UserScript==
// @name         Steam Market Show Owned Items
// @name:zh-CN   Steam市场显示已拥有物品
// @namespace    https://steamcommunity.com/
// @version      1.0.1
// @description       Automatically checks your Steam inventory and shows owned item counts (red [xN]) while browsing the Community Market.
// @description:zh-CN 在Steam市场页面，已拥有的物品将在名称前显示库存中的数量。
// @author       WorkBuddy
// @match        https://steamcommunity.com/market
// @match        https://steamcommunity.com/market/*
// @icon         https://steamcommunity.com/favicon.ico
// @grant        none
// @run-at       document-end
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    // ==================== Configuration ====================
    var CFG = {
        REQUEST_DELAY: 600,
        CACHE_DURATION: 30 * 60 * 1000,
        INVENTORY_COUNT: 2000,
        FALLBACK_COUNT: 1000,
        CONTEXT_ID: '2',
        LABEL_COLOR: '#d32f2f',
        RETRY_MAX: 2,
        RETRY_DELAY: 800,
    };
    /** Per-game inventory context overrides (Steam default context=2, some games differ) */
    var APP_CONTEXT = {
        '753': '6',    // Steam items (cards/gems/backgrounds/emoticons) inventory context=6
    };

    // ==================== Logging ====================
    var LP = '[SteamOwned]';
    function L()  { console.log.apply(console, [LP].concat([].slice.call(arguments))); }
    function W()  { console.warn.apply(console, [LP].concat([].slice.call(arguments))); }
    function E()  { console.error.apply(console, [LP].concat([].slice.call(arguments))); }

    // ==================== Global State ====================
    var steamID = null;
    var cache = {};          // { "appid_contextid": { ts, data: Map<market_hash_name, count> } }
    var pending = {};        // { "appid_contextid": Promise }
    var queue = [];
    var processing = false;
    var seen = new WeakSet();
    var observer = null;

    // ==================== Persistent Cache ====================
    /** localStorage key prefix — one entry per Steam ID */
    var STORAGE_PREFIX = 'steam_owned_cache_';
    /** sessionStorage key — survives page refresh, auto-cleared on browser close */
    var SESSION_KEY = 'steam_owned_sess';
    /** Debounce timer for localStorage writes */
    var saveTimer = null;

    /**
     * Detect fresh browser session via sessionStorage.
     * sessionStorage is cleared when the browser process closes,
     * so absence means the browser was restarted → cache is stale, clear it.
     * Unlike cookies, sessionStorage never interferes with HTTP redirects.
     */
    function isFreshSession() {
        try { return sessionStorage.getItem(SESSION_KEY) === null; }
        catch(e) { return true; }
    }

    /** Mark session as active (survives refresh, cleared on browser close) */
    function markSession() {
        try { sessionStorage.setItem(SESSION_KEY, '1'); } catch(e) {}
    }

    /** Load persisted cache from localStorage for the given Steam ID */
    function loadPersistedCache(sid) {
        try {
            var raw = localStorage.getItem(STORAGE_PREFIX + sid);
            if (!raw) return {};
            var obj = JSON.parse(raw);
            var restored = {};
            for (var key in obj) {
                if (obj[key] && Array.isArray(obj[key].data)) {
                    restored[key] = { ts: obj[key].ts, data: new Map(obj[key].data) };
                }
            }
            L('Loaded persisted cache: ' + Object.keys(restored).length + ' entries');
            return restored;
        } catch(e) {
            L('Failed to load persisted cache: ' + e.message);
            return {};
        }
    }

    /** Save current cache to localStorage (debounced 200ms to avoid excessive writes) */
    function savePersistedCache(sid) {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(function() {
            try {
                var obj = {};
                for (var key in cache) {
                    if (cache[key] && cache[key].data instanceof Map) {
                        obj[key] = {
                            ts: cache[key].ts,
                            data: Array.from(cache[key].data.entries())
                        };
                    }
                }
                localStorage.setItem(STORAGE_PREFIX + sid, JSON.stringify(obj));
            } catch(e) {
                L('Failed to persist cache: ' + e.message);
            }
            saveTimer = null;
        }, 200);
    }

    /** Clear persisted cache for the given Steam ID */
    function clearPersistedCache(sid) {
        try { localStorage.removeItem(STORAGE_PREFIX + sid); } catch(e) {}
    }

    /** Write to in-memory cache and trigger persisted save */
    function writeCache(key, data, sid) {
        cache[key] = { ts: Date.now(), data: data };
        if (sid) savePersistedCache(sid);
    }

    /** Load persisted cache or clear stale cache on fresh browser session */
    function loadCacheForSession(sid) {
        if (isFreshSession()) {
            L('Fresh browser session, clearing stale cache');
            clearPersistedCache(sid);
            markSession();
        } else {
            cache = loadPersistedCache(sid);
            L('Same browser session, restored cache from storage');
        }
    }

    // ==================== Get Steam ID ====================
    function getSteamID() {
        if (steamID) return steamID;
        try {
            if (typeof g_steamID !== 'undefined' && g_steamID) {
                steamID = String(g_steamID);
                L('Got Steam ID:', steamID);
                return steamID;
            }
        } catch(e) {}
        try {
            var scripts = document.querySelectorAll('script');
            for (var i = 0; i < scripts.length; i++) {
                var m = (scripts[i].textContent || '').match(/g_steamID\s*=\s*["'](\d+)["']/);
                if (m) { steamID = m[1]; L('Got Steam ID (script):', steamID); return steamID; }
            }
        } catch(e) {}
        try {
            var link = document.querySelector('a[href*="/profiles/"]');
            if (link) {
                var pm = link.href.match(/\/profiles\/(\d+)/);
                if (pm) { steamID = pm[1]; L('Got Steam ID (link):', steamID); return steamID; }
            }
        } catch(e) {}
        W('Unable to get Steam ID, possibly not logged in');
        return null;
    }

    // ==================== URL Parser ====================
    function parseListingURL(href) {
        var m = href.match(/\/market\/listings\/(\d+)\/(.+?)(?:\?.*)?$/);
        if (!m) return null;
        try {
            return { appid: m[1], hashName: decodeURIComponent(m[2]) };
        } catch(e) {
            return { appid: m[1], hashName: m[2] };
        }
    }

    // ==================== Inventory API ====================
    function sleep(ms) {
        return new Promise(function(resolve) { setTimeout(resolve, ms); });
    }

    function doFetch(url) {
        return fetch(url, { credentials: 'include' }).then(function(r) {
            if (r.status === 429) throw new Error('RateLimited');
            if (r.status === 400) throw new Error('BadRequest');
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        });
    }

    /**
     * Parse inventory response data into Map<market_hash_name, count>
     * Supports two formats:
     *   New: data.assets[] + data.descriptions[]   (array)
     *   Old: data.rgInventory{} + data.rgDescriptions{} (object, keyed by assetid)
     */
    function parseInventoryData(data, appid) {
        var owned = new Map();

        // Try new format first (assets / descriptions arrays)
        if (Array.isArray(data.assets) && data.assets.length > 0 && Array.isArray(data.descriptions)) {
            var descMap = {};
            data.descriptions.forEach(function(d) {
                var dk = d.classid + '_' + (d.instanceid || '0');
                descMap[dk] = d;
            });

            data.assets.forEach(function(item) {
                var dk = item.classid + '_' + (item.instanceid || '0');
                var d = descMap[dk];
                if (d) {
                    var matchName = d.market_hash_name || d.name || d.market_name;
                    if (matchName) {
                        var amt = parseInt(item.amount, 10) || 1;
                        owned.set(matchName, (owned.get(matchName) || 0) + amt);
                    }
                }
            });
        }

        // Fallback to old format (rgInventory / rgDescriptions objects)
        var rgInv = data.rgInventory;
        var rgDesc = data.rgDescriptions;
        if (owned.size === 0 && rgInv && rgDesc) {
            var invKeys = Object.keys(rgInv);

            invKeys.forEach(function(id) {
                var item = rgInv[id];
                var dk = item.classid + '_' + item.instanceid;
                var d = rgDesc[dk];
                if (d) {
                    var matchName = d.market_hash_name || d.name || d.market_name;
                    if (matchName) {
                        var amt = parseInt(item.amount, 10) || 1;
                        owned.set(matchName, (owned.get(matchName) || 0) + amt);
                    }
                }
            });
        }

        return owned;
    }

    /**
     * Build inventory API URL
     */
    function buildUrl(sid, appid, contextId, count, urlFormat, startAssetid) {
        var base;
        if (urlFormat === 'json') {
            base = 'https://steamcommunity.com/profiles/' + sid + '/inventory/json/' +
                appid + '/' + contextId + '/';
        } else {
            base = 'https://steamcommunity.com/inventory/' + sid + '/' + appid + '/' + contextId;
        }
        var params = '?l=english&count=' + count;
        if (startAssetid) params += '&start_assetid=' + startAssetid;
        return base + params;
    }

    /**
     * Single-page inventory request
     */
    function fetchOnePage(url, retry) {
        if (retry === undefined) retry = 0;
        return doFetch(url).catch(function(err) {
            var msg = err.message || String(err);
            if (msg === 'RateLimited') {
                W('Rate limited, waiting ' + (CFG.RETRY_DELAY * (retry + 1)) + 'ms');
            } else if (msg === 'BadRequest') {
                W('Bad request (400)');
            } else if (msg.indexOf('HTTP 5') === 0) {
                // HTTP 5xx server error, retry is pointless (console.log, no stack trace pollution)
                L('Server error (' + msg + '), skipping retry');
                throw err;
            } else {
                W('Request failed (#' + (retry + 1) + '): ' + msg);
            }
            if (retry < CFG.RETRY_MAX) {
                return sleep(CFG.RETRY_DELAY * (retry + 1)).then(function() {
                    return fetchOnePage(url, retry + 1);
                });
            }
            throw err;
        });
    }

    /**
     * Fetch inventory via API (with pagination)
     * @param {string} appid  Game App ID
     * @param {string} contextId  Context ID
     * @param {number} count  Max items per page
     * @param {number} retry  Current retry count
     * @param {string} urlFormat  Optional: 'default' | 'json'
     */
    function fetchInventory(appid, contextId, count, retry, urlFormat) {
        if (retry === undefined) retry = 0;
        if (!urlFormat) urlFormat = 'default';
        var key = appid + '_' + contextId + '_' + urlFormat;
        var sid = getSteamID();
        if (!sid) return Promise.resolve(null);

        // Cache hit
        var entry = cache[key];
        if (entry && (Date.now() - entry.ts) < CFG.CACHE_DURATION) {
            return Promise.resolve(entry.data);
        }

        // Request in progress (deduplicate concurrent requests)
        if (pending[key]) return pending[key];

        var promise = (function() {
            var firstUrl = buildUrl(sid, appid, contextId, count, urlFormat, null);
            L('Fetching inventory [' + urlFormat + ']: appid=' + appid + ', context=' + contextId + ', count=' + count);

            return fetchOnePage(firstUrl, retry).then(function(data) {
                if (!data || !data.success) {
                    L('Inventory empty/inaccessible [' + urlFormat + ']: appid=' + appid +
                      ', success=' + (data ? data.success : 'null'));
                    var empty = new Map();
                    writeCache(key, empty, sid);
                    return empty;
                }

                // Parse first page
                var owned = parseInventoryData(data, appid);
                var totalItems = data.total_inventory_count || 0;
                var fetchedSoFar = (data.assets ? data.assets.length : (data.rgInventory ? Object.keys(data.rgInventory).length : 0));

                // Check if pagination is needed
                if (!data.more_items || !data.last_assetid || fetchedSoFar >= totalItems) {
                    writeCache(key, owned, sid);
                    return owned;
                }

                // Need pagination — recursively fetch remaining pages
                L('[Pagination] fetched ' + fetchedSoFar + '/' + totalItems +
                  ' items, continuing with last_assetid=' + data.last_assetid);

                function fetchNextPage(lastAssetid, accumulated) {
                    var nextUrl = buildUrl(sid, appid, contextId, count, urlFormat, lastAssetid);

                    return sleep(CFG.REQUEST_DELAY).then(function() {
                        L('[Pagination] requesting next page: start_assetid=' + lastAssetid);
                        return fetchOnePage(nextUrl, 0);
                    }).then(function(pageData) {
                        if (!pageData || !pageData.success) {
                            L('[Pagination] next page failed, returning data fetched so far');
                            return accumulated;
                        }

                        var pageOwned = parseInventoryData(pageData, appid);
                        // Merge into accumulated data
                        pageOwned.forEach(function(amt, name) {
                            accumulated.set(name, (accumulated.get(name) || 0) + amt);
                        });

                        var pageCount = (pageData.assets ? pageData.assets.length :
                            (pageData.rgInventory ? Object.keys(pageData.rgInventory).length : 0));
                        L('[Pagination] this page: ' + pageCount + ' items, cumulative unique items=' + accumulated.size);

                        if (pageData.more_items && pageData.last_assetid) {
                            return fetchNextPage(pageData.last_assetid, accumulated);
                        }
                        return accumulated;
                    }).catch(function() {
                        L('[Pagination] error fetching next page, returning data fetched so far');
                        return accumulated;
                    });
                }

                return fetchNextPage(data.last_assetid, owned).then(function(allOwned) {
                    L('[Pagination] complete: appid=' + appid + ', unique items=' + allOwned.size);
                    writeCache(key, allOwned, sid);
                    return allOwned;
                });

            }).catch(function(err) {
                var msg = err.message || String(err);

                // BadRequest(400) — count may be too large, retry with fallback
                if (msg === 'BadRequest') {
                    if (count > CFG.FALLBACK_COUNT) {
                        W('count=' + count + ' rejected, falling back to count=' + CFG.FALLBACK_COUNT);
                        return fetchInventory(appid, contextId, CFG.FALLBACK_COUNT, retry, urlFormat);
                    }
                    W('Inventory inaccessible (400) [' + urlFormat + ']: appid=' + appid);
                    var empty400 = new Map();
                    writeCache(key, empty400, sid);
                    return empty400;
                }

                // HTTP 5xx — server-side error; return null to trigger fallback cascade
                // (json format + context 1), cached so repeated items don't re-fetch
                if (msg.indexOf('HTTP 5') === 0) {
                    L('Server error [' + urlFormat + ']: appid=' + appid + ', ' + msg);
                    writeCache(key, null, sid);
                    return null;
                }

                E('Final failure [' + urlFormat + ']: appid=' + appid + ', ' + msg);
                return null;
            }).finally(function() {
                delete pending[key];
            });
        })();

        pending[key] = promise;
        return promise;
    }

    // ==================== Request Queue ====================
    function enqueue(task) {
        return new Promise(function(resolve, reject) {
            queue.push({ t: task, r: resolve, j: reject });
            drain();
        });
    }

    function drain() {
        if (processing || queue.length === 0) return;
        processing = true;

        function next() {
            if (queue.length === 0) { processing = false; return; }
            var item = queue.shift();
            item.t().then(item.r, item.j).then(function() {
                if (queue.length > 0) {
                    sleep(CFG.REQUEST_DELAY).then(next);
                } else {
                    processing = false;
                    // More may have been added
                    if (queue.length > 0) drain();
                }
            });
        }
        next();
    }

    // ==================== Inventory Lookup Entry ====================
    /**
     * Games where context 1 returns HTTP 500 (skip context 1 fallback)
     * 570 = Dota 2
     * NOTE: DST (322330) is NOT skipped; its context 1 may work even though context 2 HTTP 500s
     */
    var SKIP_CONTEXT_1 = { '570': true };
    /** Track attempted json format fallbacks (avoid triggering per-item) */
    var jsonFallbackDone = {};

    function getOwnedCount(appid, hashName, contextId) {
        if (!contextId) contextId = APP_CONTEXT[appid] || CFG.CONTEXT_ID;

        function tryContext(cid, urlFmt) {
            if (!urlFmt) urlFmt = 'default';
            var key = appid + '_' + cid + '_' + urlFmt;
            var owned = cache[key] && cache[key].data;
            if (owned) {
                if (owned instanceof Map) return Promise.resolve(owned.get(hashName) || 0);
                return Promise.resolve(-1); // null = previous failure
            }
            return enqueue(function() {
                return fetchInventory(appid, cid, CFG.INVENTORY_COUNT, 0, urlFmt);
            }).then(function(owned) {
                if (!owned) return -1;
                return owned.get(hashName) || 0;
            });
        }

        // Main flow: app-specific context default (with pagination)
        return tryContext(contextId, 'default').then(function(count) {
            if (count > 0) return count;

            var fallbackKey = appid + '_' + contextId;

            // Try json legacy format when default failed, then try context 1
            // Both are tried regardless of count value (0 or -1)
            function tryFallbacks() {
                if (count < 0 && !jsonFallbackDone[fallbackKey]) {
                    jsonFallbackDone[fallbackKey] = true;
                    L('[Fallback] default format failed, trying json legacy format: appid=' + appid);
                    return tryContext(contextId, 'json').then(function(c2) {
                        if (c2 > 0) return c2;
                        return tryCtx1();
                    });
                }
                return tryCtx1();
            }

            function tryCtx1() {
                if (contextId === '2' && !SKIP_CONTEXT_1[appid]) {
                    return tryContext('1', 'default').then(function(c) {
                        return c > 0 ? c : 0;
                    });
                }
                return 0;
            }

            return tryFallbacks();
        });
    }

    // ==================== UI Badge ====================
    function createBadge(count) {
        var s = document.createElement('span');
        s.className = 'steam-owned-badge';
        s.textContent = '[' + count + ']';
        s.title = 'You own ' + count + ' of this item in your inventory';
        s.style.cssText =
            'color:' + CFG.LABEL_COLOR + ';' +
            'font-weight:bold;font-size:inherit;margin-right:4px;padding:0;' +
            'display:inline;line-height:inherit;white-space:nowrap;cursor:help;';
        return s;
    }

    // ==================== Process Item Rows ====================
    function processRow(row) {
        if (seen.has(row)) return;
        seen.add(row);
        if (row.querySelector('.steam-owned-badge')) return;

        var info = parseListingURL(row.href);
        if (!info) return;

        var nameBlock = row.querySelector('.market_listing_item_name_block');
        if (!nameBlock) return;
        var nameSpan = nameBlock.querySelector('.market_listing_item_name');
        if (!nameSpan) return;

        getOwnedCount(info.appid, info.hashName).then(function(count) {
            if (count > 0) {
                nameBlock.insertBefore(createBadge(count), nameSpan);
            }
        }).catch(function(err) {
            W('Process failed: ' + info.hashName, err);
        });
    }

    function processAllRows() {
        var rows = document.querySelectorAll('a.market_listing_row_link');
        L('Found ' + rows.length + ' market items, checking inventory...');
        rows.forEach(function(r) { processRow(r); });
    }

    // ==================== Item Detail Page ====================
    function processSinglePage() {
        var m = location.pathname.match(/^\/market\/listings\/(\d+)\/(.+)$/);
        if (!m) return;

        var appid = m[1];
        var hashName = decodeURIComponent(m[2]);

        var nav = document.querySelector('#largeiteminfo .market_listing_nav .market_listing_item_name');
        if (!nav || nav.querySelector('.steam-owned-badge')) return;

        getOwnedCount(appid, hashName).then(function(count) {
            if (count > 0) {
                nav.parentNode.insertBefore(createBadge(count), nav);
            }
        }).catch(function(err) {
            W('Detail page process failed: ' + hashName, err);
        });
    }

    // ==================== DOM Observer ====================
    function setupObserver() {
        if (observer) observer.disconnect();

        var target = document.getElementById('searchResults') || document.body;

        observer = new MutationObserver(function(mutations) {
            var rows = [];
            mutations.forEach(function(mut) {
                if (mut.type !== 'childList') return;
                mut.addedNodes.forEach(function(node) {
                    if (node.nodeType !== 1) return;
                    if (node.classList && node.classList.contains('market_listing_row_link')) {
                        rows.push(node);
                    }
                    if (node.querySelectorAll) {
                        var nested = node.querySelectorAll('a.market_listing_row_link');
                        nested.forEach(function(r) { rows.push(r); });
                    }
                });
            });
            if (rows.length > 0) {
                L('Detected ' + rows.length + ' new items');
                rows.forEach(function(r) { processRow(r); });
            }
        });

        observer.observe(target, { childList: true, subtree: true });
        L('DOM observer started: ' + (target.id || 'body'));
    }

    // ==================== Page Type ====================
    function pageType() {
        var p = location.pathname;
        if (/^\/market\/listings\/\d+\/.+/.test(p)) return 'single';
        if (/^\/market\/?$/.test(p) || /^\/market\/search/.test(p)) return 'browse';
        return 'other';
    }

    // ==================== Delayed & Stabilized Startup ====================
    /**
     * During browser session restore, Steam's auth cookies may be stale,
     * triggering a redirect chain (market → login → market → ...).
     * We MUST NOT execute anything during this redirect window.
     *
     * Strategy: poll the URL every 250ms. Only when it has been stable
     * for 800ms AND 2 seconds have passed since DOM ready do we start.
     * This ensures Steam's auth redirects have fully settled.
     */
    var STABLE_DELAY = 800;   // URL must be stable for this long
    var START_DELAY = 2000;   // Minimum time before starting
    var CHECK_INTERVAL = 250;  // URL stability check interval
    var lastCheck = location.href;
    var stableSince = 0;
    var domReady = false;
    var started = false;

    function isOnMarket() {
        return /^\/market(?:\/|$)/.test(location.pathname);
    }

    function init() {
        if (started) return;
        started = true;

        L('========================================');
        L('Steam Market Show Owned Items v1.0.1');
        L('========================================');

        var sid = getSteamID();
        if (!sid) {
            // Delayed retry
            var tries = 0;
            var retry = function() {
                if (tries >= 10) {
                    W('No Steam login detected, script will not run');
                    return;
                }
                tries++;
                sid = getSteamID();
                if (sid) {
                    loadCacheForSession(sid);
                    L('Current user: ' + sid);
                    start();
                } else {
                    setTimeout(retry, 500);
                }
            };
            setTimeout(retry, 500);
            return;
        }
        loadCacheForSession(sid);
        L('Current user: ' + sid);
        start();
    }

    var lastURL;

    function start() {
        setupObserver();
        var pt = pageType();
        L('Page type: ' + pt);
        if (pt === 'browse') setTimeout(processAllRows, 400);
        else if (pt === 'single') processSinglePage();

        // Start URL navigation watch (only after stable init)
        lastURL = location.href;
        setInterval(function() {
            var cur = location.href;
            if (cur !== lastURL) {
                lastURL = cur;
                setTimeout(function() {
                    setupObserver();
                    if (pageType() === 'browse') processAllRows();
                    else if (pageType() === 'single') processSinglePage();
                }, 300);
            }
        }, 800);
    }

    function tryStart() {
        if (!domReady) return;

        var now = Date.now();
        var curURL = location.href;

        if (curURL !== lastCheck) {
            lastCheck = curURL;
            stableSince = now;
            return;
        }

        if (now - stableSince < STABLE_DELAY) return;

        // URL is stable, but is it actually a market page?
        if (!isOnMarket()) {
            // We're on a non-market page (e.g. stuck on login). Keep polling.
            return;
        }

        // All clear — stop polling and start
        clearInterval(stableTimer);
        init();
    }

    var stableTimer;

    /** Called on DOM ready — mark domReady and begin stability polling */
    function onDOMReady() {
        domReady = true;
        stableSince = Date.now();
        lastCheck = location.href;

        // Start polling for URL stability
        stableTimer = setInterval(tryStart, CHECK_INTERVAL);

        // Also set a one-shot: after START_DELAY, if we somehow haven't started
        // and the URL is on a market page, force start (belt & suspenders)
        setTimeout(function() {
            if (domReady && isOnMarket()) {
                clearInterval(stableTimer);
                init();
            }
        }, START_DELAY);
    }

    if (document.readyState === 'interactive' || document.readyState === 'complete') {
        onDOMReady();
    } else {
        document.addEventListener('DOMContentLoaded', onDOMReady);
    }

})();
