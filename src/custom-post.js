/*
 * Custom JavaScript additions for Easy YouTube Video Downloader
 * This file is appended to the libav.js build via --post-js
 *
 * Contains:
 * - FetchWithRetry: Robust fetch with exponential backoff
 * - abortSignalAny: Polyfill for AbortSignal.any()
 * - Overrides for jsfetch_open_js and jsfetch_close_js
 */

// Store original EM_JS functions before overriding
var _original_jsfetch_open_js = typeof jsfetch_open_js !== 'undefined' ? jsfetch_open_js : null;
var _original_jsfetch_close_js = typeof jsfetch_close_js !== 'undefined' ? jsfetch_close_js : null;

/**
 * Fetch with automatic retry and exponential backoff.
 * @param {string} url - The URL to fetch
 * @param {object} options - Fetch options
 * @param {number} retries - Number of retries (default: 3)
 * @param {number} backoff - Initial backoff in ms (default: 1000)
 */
var FetchWithRetry = async function (url, options, retries, backoff) {
    if (retries === undefined) retries = 3;
    if (backoff === undefined) backoff = 1000;
    try {
        var response = await fetch(url, options);
        if (response.ok) return response;
        if (retries > 0 && (response.status >= 500 || response.status === 429)) {
            await new Promise(function (r) { setTimeout(r, backoff); });
            return FetchWithRetry(url, options, retries - 1, backoff * 2);
        }
        throw new Error("HTTP " + response.status + " " + response.statusText);
    } catch (err) {
        if (retries > 0) {
            await new Promise(function (r) { setTimeout(r, backoff); });
            return FetchWithRetry(url, options, retries - 1, backoff * 2);
        }
        throw err;
    }
};

/**
 * Polyfill for AbortSignal.any() - combines multiple abort signals.
 * @param {AbortSignal[]} signals - Array of AbortSignal objects
 * @returns {AbortSignal} - A combined abort signal
 */
var abortSignalAny = function (signals) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
        return AbortSignal.any(signals);
    }
    var controller = new AbortController();
    var onAbort = function () { controller.abort(); };
    for (var i = 0; i < signals.length; i++) {
        var signal = signals[i];
        if (signal.aborted) {
            controller.abort(signal.reason);
            return controller.signal;
        }
        signal.addEventListener("abort", onAbort, { once: true });
    }
    return controller.signal;
};

/**
 * Override the jsfetch_open_js function to add retry logic and abort control.
 * This replaces the EM_JS generated version with our enhanced implementation.
 */
jsfetch_open_js = function (url) {
    return Asyncify.handleAsync(async function () {
        try {
            url = UTF8ToString(url);
            var fetchUrl = url;
            if (fetchUrl.slice(0, 8) === "jsfetch:") fetchUrl = fetchUrl.slice(8);

            var controller = new AbortController();
            var signal = controller.signal;

            // Combine with external abort controller if provided
            if (Module.abortController && Module.abortController.signal) {
                signal = abortSignalAny([signal, Module.abortController.signal]);
            }

            var response = await FetchWithRetry(fetchUrl, { signal: signal });

            if (!Module.libavjsJSFetch)
                Module.libavjsJSFetch = { ctr: 1, fetches: {} };
            var jsf = Module.libavjsJSFetch;
            var idx = jsf.ctr++;
            var reader = response.body.getReader();
            var jsfo = jsf.fetches[idx] = {
                url: url,
                response: response,
                reader: reader,
                controller: controller,
                next: reader.read().then(function (res) {
                    jsfo.buf = res;
                }).catch(function (rej) {
                    jsfo.rej = rej;
                }),
                buf: null,
                rej: null
            };
            return idx;
        } catch (ex) {
            Module.fsThrownError = ex;
            console.error(ex);
            return -11; /* ECANCELED */
        }
    });
};

/**
 * Override jsfetch_close_js to also abort the controller.
 */
jsfetch_close_js = function (idx) {
    var jsfo = Module.libavjsJSFetch && Module.libavjsJSFetch.fetches[idx];
    if (jsfo) {
        try { jsfo.reader.cancel(); } catch (ex) { }
        try { if (jsfo.controller) jsfo.controller.abort(); } catch (ex) { }
        delete Module.libavjsJSFetch.fetches[idx];
    }
};
