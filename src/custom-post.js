/*
 * Custom JavaScript additions for Easy YouTube Video Downloader
 * This file is appended to the libav.js build via --post-js
 *
 * Contains:
 * - FetchWithRetry: Robust fetch with exponential backoff
 * - abortSignalAny: Polyfill for AbortSignal.any()
 * - Overrides for jsfetch_open_js, jsfetch_read_js, jsfetch_seek_js,
 *   jsfetch_close_js — add 10 MB bounded-range chunking so googlevideo
 *   requests don't get throttled (~40 KB/s on unbounded GETs).
 */

// YouTube throttles unbounded googlevideo responses to ~40 KB/s. Native
// players (dash.js, shaka, yt-dlp, VDH) work around this by issuing
// bounded-range requests that each deliver a small window of bytes.
// 10 MiB per request matches what dash.js and VDH use.
var JSFETCH_CHUNK_SIZE = 10 * 1048576;

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
 * Internal helper: issue a bounded `Range: bytes=start-end` fetch and return
 * the response. Used by open/seek/read auto-chunking to keep each request
 * within YouTube's ~10 MiB "native-player" window so googlevideo doesn't
 * throttle the connection.
 */
async function _jsfetchRangedFetch(url, start, end, abortController) {
    var signal = abortController.signal;
    if (Module.abortController && Module.abortController.signal) {
        signal = abortSignalAny([signal, Module.abortController.signal]);
    }
    var headers = { 'Range': 'bytes=' + start + '-' + end };
    return await FetchWithRetry(url, { signal: signal, headers: headers });
}

/**
 * Internal helper: parse a "bytes START-END/TOTAL" Content-Range into the
 * TOTAL component. Returns 0 when absent or malformed.
 */
function _jsfetchParseTotal(resp) {
    var cr = resp.headers.get('Content-Range');
    if (cr) {
        var m = cr.match(/bytes \d+-\d+\/(\d+)/);
        if (m) return parseInt(m[1], 10);
    }
    return 0;
}

/**
 * Override `jsfetch_open_js` — open a chunked fetch. Must honour the
 * `start_offset` parameter and populate `jsfo.filesize` from the response
 * Content-Range header so the C side can call avio_size()/SEEK_END on the
 * URL. Populates chunk-bookkeeping fields consumed by `jsfetch_read_js`.
 */
jsfetch_open_js = function (url, start_offset) {
    return Asyncify.handleAsync(async function () {
        try {
            url = UTF8ToString(url);
            var fetchUrl = url;
            if (fetchUrl.slice(0, 8) === "jsfetch:") fetchUrl = fetchUrl.slice(8);

            var startOff = (start_offset > 0) ? start_offset : 0;
            var chunkEnd = startOff + JSFETCH_CHUNK_SIZE - 1;

            var controller = new AbortController();
            var response = await _jsfetchRangedFetch(fetchUrl, startOff, chunkEnd, controller);

            if (!Module.libavjsJSFetch)
                Module.libavjsJSFetch = { ctr: 1, fetches: {} };
            var jsf = Module.libavjsJSFetch;
            var idx = jsf.ctr++;
            var reader = response.body.getReader();
            var jsfo = jsf.fetches[idx] = {
                url: fetchUrl,
                response: response,
                reader: reader,
                controller: controller,
                buf: null,
                rej: null,
                filesize: _jsfetchParseTotal(response),
                offset: startOff,   // absolute byte offset of the next unread byte
                chunkEnd: chunkEnd  // end offset of the currently-open range (inclusive)
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
 * Override `jsfetch_read_js` — read up to `size` bytes into the wasm heap.
 * Auto-advances to the next bounded range whenever the current reader hits
 * done before EOF. Without this chunking, YouTube throttles googlevideo
 * responses to ~40 KB/s regardless of client bandwidth.
 */
jsfetch_read_js = function (idx, toBuf, size) {
    var jsfo = Module.libavjsJSFetch && Module.libavjsJSFetch.fetches[idx];
    if (!jsfo) return -11;
    return Asyncify.handleAsync(async function () {
        try {
            // Drain any buffered leftover from the previous read() tick first.
            if (jsfo.buf && jsfo.buf.value && jsfo.buf.value.length > 0) {
                var leftover = jsfo.buf.value;
                var llen = Math.min(size, leftover.length);
                Module.HEAPU8.set(leftover.subarray(0, llen), toBuf);
                jsfo.buf.value = leftover.subarray(llen);
                if (jsfo.buf.value.length === 0) jsfo.buf = null;
                jsfo.offset += llen;
                return llen;
            }
            // Pull from the current reader; on done, re-fetch the next window.
            while (true) {
                var res = await jsfo.reader.read();
                if (!res.done) {
                    var chunk = res.value;
                    var len = Math.min(size, chunk.length);
                    Module.HEAPU8.set(chunk.subarray(0, len), toBuf);
                    if (chunk.length > len) {
                        jsfo.buf = { value: chunk.subarray(len) };
                    } else {
                        jsfo.buf = null;
                    }
                    jsfo.offset += len;
                    return len;
                }
                // Reader exhausted. If the file has more bytes to serve, open
                // the next bounded range and loop.
                if (jsfo.filesize > 0 && jsfo.offset < jsfo.filesize) {
                    try { jsfo.controller.abort(); } catch (e) { }
                    var nextStart = jsfo.offset;
                    var nextEnd = Math.min(nextStart + JSFETCH_CHUNK_SIZE - 1, jsfo.filesize - 1);
                    jsfo.controller = new AbortController();
                    jsfo.response = await _jsfetchRangedFetch(jsfo.url, nextStart, nextEnd, jsfo.controller);
                    jsfo.reader = jsfo.response.body.getReader();
                    jsfo.chunkEnd = nextEnd;
                    continue;
                }
                return -0x20464f45; /* AVERROR_EOF */
            }
        } catch (e) {
            console.error("jsfetch_read_js error", e);
            Module.fsThrownError = e;
            return -11;
        }
    });
};

/**
 * Override `jsfetch_seek_js` — keep the chunk bookkeeping consistent when the
 * C side seeks to a new position. Cancels the current reader, opens a fresh
 * bounded range starting at `start_offset`, and threads filesize / offset /
 * chunkEnd into the new jsfo so subsequent `jsfetch_read_js` calls continue
 * chunking from the new position.
 */
jsfetch_seek_js = function (old_idx, url, start_offset) {
    return Asyncify.handleAsync(async function () {
        try {
            url = UTF8ToString(url);
            var fetchUrl = url;
            if (fetchUrl.slice(0, 8) === "jsfetch:") fetchUrl = fetchUrl.slice(8);

            var startOff = (start_offset > 0) ? start_offset : 0;
            var chunkEnd = startOff + JSFETCH_CHUNK_SIZE - 1;

            var controller = new AbortController();
            var response = await _jsfetchRangedFetch(fetchUrl, startOff, chunkEnd, controller);

            if (!Module.libavjsJSFetch)
                Module.libavjsJSFetch = { ctr: 1, fetches: {} };
            var jsf = Module.libavjsJSFetch;
            // Drop the previous fetch. Carry forward its filesize so a URL
            // that was already probed doesn't need its total re-read.
            var carriedFilesize = 0;
            if (old_idx > 0 && jsf.fetches[old_idx]) {
                var prev = jsf.fetches[old_idx];
                carriedFilesize = prev.filesize || 0;
                try { prev.buf = null; prev.reader.cancel(); } catch (e) { }
                try { if (prev.controller) prev.controller.abort(); } catch (e) { }
                delete jsf.fetches[old_idx];
            }
            var idx = jsf.ctr++;
            var reader = response.body.getReader();
            jsf.fetches[idx] = {
                url: fetchUrl,
                response: response,
                reader: reader,
                controller: controller,
                buf: null,
                rej: null,
                filesize: _jsfetchParseTotal(response) || carriedFilesize,
                offset: startOff,
                chunkEnd: chunkEnd
            };
            return idx;
        } catch (ex) {
            Module.fsThrownError = ex;
            console.error(ex);
            return -11;
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
