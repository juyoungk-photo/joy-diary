/* FocusPlayerKit 0.1.0 (e630f2f) — copied by tools/sync-player.sh; edit it in FocusPlayerKit, not here. */
/*
 *  focus-player.js — FocusPlayerKit
 *
 *  The YouTube IFrame Player API wrapper shared by every focus player:
 *
 *    - SolaPraise (iOS): player.html, served over loopback HTTP or handed to
 *      loadSimulatedRequest, with this file inlined. Events go to Swift
 *      through window.webkit.messageHandlers.focusTubePlayer.
 *    - Web pages (the family hub): load this file and focus-player.css, and
 *      listen for `focusplayer` CustomEvents, or pass `post`.
 *
 *  One copy, so a fix lands everywhere. Keep it plain ES5: it runs in old
 *  iPads' Safari as well as in WKWebView.
 *
 *  Events posted (the shapes SolaPraise's PlayerCoordinator reads):
 *    { event: 'diag',  version, origin, href, referrer, hasYT }
 *    { event: 'ready', duration }
 *    { event: 'state', state, duration [, stopped: true] }
 *    { event: 'time',  t, duration }                      every tickMs
 *    { event: 'error', code, kind }
 *
 *  Why `rel=0` is not enough: since 2018 it only *restricts* the end-screen
 *  suggestions to the same channel; it never disabled them. Stopping the
 *  instant ENDED arrives is the only reliable way to keep the grid away.
 *  `endPolicy: 'stop'` does that here. A native host that decides for itself
 *  (SolaPraise carries on to the next song in Picture-in-Picture instead)
 *  uses 'none', which is the default whenever the native bridge is present.
 */
(function (global) {
  'use strict';

  var VERSION = '0.1.0';
  var API_SRC = 'https://www.youtube.com/iframe_api';
  var MESSAGE_NAME = 'focusTubePlayer';
  var EVENT_NAME = 'focusplayer';

  var STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

  /// YouTube IFrame API error codes, by what the host should do about them.
  /// 152 is undocumented but behaves like 101/150: embedded playback is
  /// restricted outside youtube.com, so the useful answer is "open in YouTube".
  function classifyError(code) {
    switch (code) {
      case 2: return 'invalidId';
      case 5: return 'html5';
      case 100: return 'removed';
      case 101: case 150: case 152: return 'embedBlocked';
      default: return 'unknown';
    }
  }

  function nativeHandler() {
    try {
      var handlers = global.webkit && global.webkit.messageHandlers;
      return (handlers && handlers[MESSAGE_NAME]) || null;
    } catch (e) { return null; }
  }

  /// To Swift when a native host is listening, otherwise to the page.
  function bridge(payload) {
    var handler = nativeHandler();
    if (handler) {
      try { handler.postMessage(payload); } catch (e) {}
      return;
    }
    try { global.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: payload })); } catch (e) {}
  }

  // MARK: - API loading

  var apiQueue = [];
  var apiHooked = false;

  function apiIsReady() {
    var YT = global.YT;
    // iframe_api defines YT first with loaded:0; the widget script sets
    // loaded:1 and Player once it can actually build one.
    return !!(YT && YT.Player && YT.loaded !== 0);
  }

  function whenAPIReady(fn) {
    if (apiIsReady()) { fn(); return; }
    apiQueue.push(fn);
    if (apiHooked) return;
    apiHooked = true;

    var previous = global.onYouTubeIframeAPIReady;
    global.onYouTubeIframeAPIReady = function () {
      if (typeof previous === 'function') { try { previous(); } catch (e) {} }
      var queued = apiQueue;
      apiQueue = [];
      for (var i = 0; i < queued.length; i++) {
        try { queued[i](); } catch (e) {}
      }
    };

    // A page may already carry the script tag so the download starts early.
    if (!document.querySelector('script[src="' + API_SRC + '"]')) {
      var tag = document.createElement('script');
      tag.src = API_SRC;
      document.head.appendChild(tag);
    }
  }

  /// Starts fetching the API without building a player. A web page calls this
  /// early so that a tap later can build the player inside its own gesture —
  /// iOS Safari only lets sound start from one.
  function preload() { whenAPIReady(function () {}); }

  // MARK: - Player

  /**
   *  create(target, opts) → controller
   *
   *  target: element or element id; the API replaces it with an iframe.
   *  opts:
   *    videoId, autoplay
   *    endPolicy  'stop' | 'none'   default: 'none' under a native host, else 'stop'
   *    fit        'window' | 'host' default 'window' (the page is the player);
   *                                 'host' follows the parent element's size
   *    post       function(payload) default: bridge (webkit, else CustomEvent)
   *    playerVars extra/overriding IFrame API playerVars
   *    tickMs     interval of 'time' events, default 1000
   *    onPlayer   function(YT.Player) once it exists
   */
  function create(target, opts) {
    opts = opts || {};
    var el = typeof target === 'string' ? document.getElementById(target) : target;
    var post = opts.post || bridge;
    var endPolicy = opts.endPolicy || (nativeHandler() ? 'none' : 'stop');
    var fit = opts.fit || 'window';
    var tickMs = opts.tickMs || 1000;
    var host = el && el.parentNode;

    var player = null;
    var ticker = null;
    var destroyed = false;
    var observer = null;

    post({
      event: 'diag',
      version: VERSION,
      origin: String(location.origin),
      href: String(location.href),
      referrer: String(document.referrer),
      hasYT: (typeof global.YT !== 'undefined')
    });

    function safeDuration() {
      try { return player && player.getDuration ? player.getDuration() : 0; }
      catch (e) { return 0; }
    }

    function safeTime() {
      try { return player && player.getCurrentTime ? player.getCurrentTime() : 0; }
      catch (e) { return 0; }
    }

    // The view is resized constantly — docking, restoring, rotating, every
    // frame of a drag — and the API does not follow on its own.
    function fitPlayer() {
      try {
        if (!player || !player.setSize) return;
        if (fit === 'host' && host) {
          player.setSize(host.clientWidth, host.clientHeight);
        } else {
          player.setSize(global.innerWidth, global.innerHeight);
        }
      } catch (e) {}
    }
    global.addEventListener('resize', fitPlayer);
    if (fit === 'host' && host && typeof global.ResizeObserver === 'function') {
      observer = new global.ResizeObserver(fitPlayer);
      observer.observe(host);
    }

    function startTicker() {
      if (ticker) { clearInterval(ticker); }
      ticker = setInterval(function () {
        if (player && player.getCurrentTime) {
          post({ event: 'time', t: safeTime(), duration: safeDuration() });
        }
      }, tickMs);
    }

    var vars = {
      playsinline: 1, controls: 1, modestbranding: 1, rel: 0,
      iv_load_policy: 3, fs: 1, enablejsapi: 1,
      autoplay: opts.autoplay ? 1 : 0
    };
    // The embed checks origin against the frame's real one. A file:// page
    // has none worth sending.
    if (/^https?:/.test(String(location.origin))) { vars.origin = String(location.origin); }
    if (opts.playerVars) {
      for (var key in opts.playerVars) {
        if (Object.prototype.hasOwnProperty.call(opts.playerVars, key)) { vars[key] = opts.playerVars[key]; }
      }
    }

    whenAPIReady(function () {
      if (destroyed) return;
      player = new global.YT.Player(el, {
        // Asked for explicitly as well, so the iframe is born the right size
        // rather than corrected by CSS a frame later.
        width: '100%',
        height: '100%',
        videoId: opts.videoId || '',
        playerVars: vars,
        events: {
          onReady: function () {
            post({ event: 'ready', duration: safeDuration() });
            startTicker();
            fitPlayer();
          },
          onStateChange: function (e) {
            var stopped = false;
            if (e.data === STATE.ENDED && endPolicy === 'stop') {
              // Before anything else, so the suggestion grid never paints.
              try { player.stopVideo(); stopped = true; } catch (err) {}
            }
            var payload = { event: 'state', state: e.data, duration: safeDuration() };
            if (stopped) { payload.stopped = true; }
            post(payload);
          },
          onError: function (e) {
            post({ event: 'error', code: e.data, kind: classifyError(e.data) });
          }
        }
      });
      if (typeof opts.onPlayer === 'function') { opts.onPlayer(player); }
    });

    function call(name, args) {
      try {
        if (player && typeof player[name] === 'function') {
          player[name].apply(player, args || []);
          return true;
        }
      } catch (e) {}
      return false;
    }

    return {
      get player() { return player; },
      get endPolicy() { return endPolicy; },
      set endPolicy(value) { endPolicy = value; },
      /// Swaps the video on the live player; false if there is none yet.
      load: function (videoId) { return call('loadVideoById', [videoId]); },
      cue: function (videoId) { return call('cueVideoById', [videoId]); },
      play: function () { return call('playVideo'); },
      pause: function () { return call('pauseVideo'); },
      stop: function () { return call('stopVideo'); },
      seek: function (seconds) { return call('seekTo', [seconds, true]); },
      /// Skips by `seconds` (negative for back), clamped to the video.
      /// Returns where it landed.
      skip: function (seconds) {
        var duration = safeDuration();
        var target = Math.max(safeTime() + seconds, 0);
        if (duration > 0) { target = Math.min(target, Math.max(duration - 1, 0)); }
        call('seekTo', [target, true]);
        return target;
      },
      replay: function () { return call('seekTo', [0, true]) && call('playVideo'); },
      destroy: function () {
        destroyed = true;
        if (ticker) { clearInterval(ticker); ticker = null; }
        global.removeEventListener('resize', fitPlayer);
        if (observer) { observer.disconnect(); observer = null; }
        call('destroy');
        player = null;
      }
    };
  }

  global.FocusPlayer = {
    version: VERSION,
    STATE: STATE,
    MESSAGE_NAME: MESSAGE_NAME,
    EVENT_NAME: EVENT_NAME,
    classifyError: classifyError,
    bridge: bridge,
    preload: preload,
    whenAPIReady: whenAPIReady,
    create: create
  };
})(window);
