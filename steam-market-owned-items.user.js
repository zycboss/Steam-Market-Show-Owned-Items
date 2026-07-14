// ==UserScript==
// @name         Steam Market Show Owned Items
// @name:zh-CN   Steam市场显示已拥有物品
// @namespace    https://steamcommunity.com/
// @version      1.0.0
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
        REQUEST_DELAY: 1500,
        CACHE_DURATION: 10 * 60 * 1000,
        INVENTORY_COUNT: 2000,
        FALLBACK_COUNT: 1000,
        CONTEXT_ID: '2',
        LABEL_COLOR: '#d32f2f',
        RETRY_MAX: 2,
        RETRY_DELAY: 2000,
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

        // Diagnostic: log top-level response fields
        var topKeys = Object.keys(data).filter(function(k) {
            return k !== 'descriptions' && k !== 'assets' && k !== 'rgInventory' && k !== 'rgDescriptions';
        });
        L('Response top-level fields: ' + topKeys.join(', '));
        if (data.total_inventory_count !== undefined) {
            L('total_inventory_count=' + data.total_inventory_count + ', success=' + data.success +
              ', more_items=' + (data.more_items || 0) + ', last_assetid=' + (data.last_assetid || 'none'));
        }

        // Try new format first (assets / descriptions arrays)
        if (Array.isArray(data.assets) && data.assets.length > 0 && Array.isArray(data.descriptions)) {
            L('Detected assets/descriptions array format, assets=' + data.assets.length +
              ', descriptions=' + data.descriptions.length);

            // Build classid_instanceid -> description index
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
            L('Trying rgInventory/rgDescriptions object format, invKeys=' + invKeys.length +
              ', descKeys=' + Object.keys(rgDesc).length);

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

        // Diagnostic: log first 5 inventory item name samples
        var samples = [];
        var sc = 0;
        if (owned.size > 0) {
            owned.forEach(function(_, name) {
                if (sc >= 5) return;
                samples.push('"' + name + '"');
                sc++;
            });
        }
        L('Inventory parsing done: appid=' + appid + ', unique items=' + owned.size +
          ', total count=' + (data.total_inventory_count || 'N/A') +
          ', samples: ' + samples.join(', '));

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
                    cache[key] = { ts: Date.now(), data: empty };
                    return empty;
                }

                // Parse first page
                var owned = parseInventoryData(data, appid);
                var totalItems = data.total_inventory_count || 0;
                var fetchedSoFar = (data.assets ? data.assets.length : (data.rgInventory ? Object.keys(data.rgInventory).length : 0));

                // Check if pagination is needed
                if (!data.more_items || !data.last_assetid || fetchedSoFar >= totalItems) {
                    cache[key] = { ts: Date.now(), data: owned };
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
                    cache[key] = { ts: Date.now(), data: allOwned };
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
                    cache[key] = { ts: Date.now(), data: empty400 };
                    return empty400;
                }

                // HTTP 5xx — server-side error, cache as empty Map to avoid retries
                // Note: do NOT return null, or getOwnedCount will trigger json fallback
                if (msg.indexOf('HTTP 5') === 0) {
                    L('Server error [' + urlFormat + ']: appid=' + appid + ', ' + msg);
                    var empty500 = new Map();
                    cache[key] = { ts: Date.now(), data: empty500 };
                    return empty500;
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
     * 570 = Dota 2, 322330 = Don't Starve Together (DST)
     */
    var SKIP_CONTEXT_1 = { '570': true, '322330': true };
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

            // default format completely failed (API down, not just "not found"), try json legacy format
            // Only try once per appid+context
            var fallbackKey = appid + '_' + contextId;
            if (count < 0 && !jsonFallbackDone[fallbackKey]) {
                jsonFallbackDone[fallbackKey] = true;
                L('[Fallback] default format failed, trying json legacy format: appid=' + appid);
                return tryContext(contextId, 'json').then(function(c2) {
                    return c2 > 0 ? c2 : 0;
                });
            }

            // context 1 fallback (only for non-Dota 2 games, and context 2 returned data successfully)
            if (contextId === '2' && !SKIP_CONTEXT_1[appid] && count >= 0) {
                return tryContext('1', 'default').then(function(c) {
                    return c > 0 ? c : 0;
                });
            }

            return 0;
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

        // Diagnostic: collect involved appids and market hash name samples
        var appids = {};
        var samples = [];
        rows.forEach(function(r) {
            var info = parseListingURL(r.href);
            if (info) {
                appids[info.appid] = true;
                if (samples.length < 5) {
                    samples.push(info.appid + ':"' + info.hashName + '"');
                }
            }
            processRow(r);
        });
        L('AppIDs: ' + Object.keys(appids).join(',') + ' | Samples: ' + samples.join('; '));
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

    // ==================== URL Navigation Watch ====================
    var lastURL = location.href;
    setInterval(function() {
        var cur = location.href;
        if (cur !== lastURL) {
            lastURL = cur;
            setTimeout(function() {
                setupObserver();
                if (pageType() === 'browse') processAllRows();
                else if (pageType() === 'single') processSinglePage();
            }, 500);
        }
    }, 1000);

    // ==================== Startup ====================
    function init() {
        L('========================================');
        L('Steam Market Show Owned Items v1.0.0');
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
                    L('Current user: ' + sid);
                    start();
                } else {
                    setTimeout(retry, 500);
                }
            };
            setTimeout(retry, 500);
            return;
        }
        L('Current user: ' + sid);
        start();
    }

    function start() {
        setupObserver();
        var pt = pageType();
        L('Page type: ' + pt);
        if (pt === 'browse') setTimeout(processAllRows, 800);
        else if (pt === 'single') processSinglePage();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
