/*
  The web Notification API, inside the Mac shell, posted by macOS under the app's own name.

  Injected at documentStart into the page's own world by `Shell.swift`, which it must be: a
  content world of its own would define a `Notification` the page cannot see. Hence
  `globalThis` for every global, which is also what lets `notify.test.ts` supply one.

  A POLYFILL, NOT A BRIDGE CALL IN `apps/web`, for Kinora's reasons (`MAC-04`): the page needs
  no shell-shaped branch that is a no-op in every browser; the contract is the W3C API, so a
  stale bundle against a newer page still works; and the page's rules about WHEN to notify are
  not restated here. What this owns is only "did macOS take it".

  NOT HERE, so the gap is not mistaken for an oversight: `actions`, `badge`, `image`,
  `renotify`, `vibrate`, `dir`, `lang`, and `ServiceWorkerRegistration.showNotification`. An
  option accepted and then dropped reads, to the next person, as a feature that works.
*/
(function (global) {
  'use strict';

  // The same two names as `Notifier.channel` and `Notifier.namespace` in Notify.swift;
  // `bundle.test.ts` reads both files and compares them.
  var CHANNEL = 'shellNotify';
  var NAMESPACE = '__shellNotifier';
  var STATES = ['default', 'granted', 'denied'];

  var webkit = global.webkit;
  var handlers = webkit ? webkit.messageHandlers : null;
  var bridge = handlers ? handlers[CHANNEL] || null : null;

  // No channel means the handler did not register. Defining a Notification anyway would let
  // the page ask for a permission nobody can grant and swallow every notification.
  if (!bridge) return;

  /*
    The shell always wins. macOS 26's WKWebView defines a `Notification` that answers denied
    for ever; Kinora first deferred to it and the page said "notifications are turned off"
    about a decision nobody had made. What is displaced is reported, not assumed.
  */
  var displaced = typeof global.Notification !== 'undefined';
  var permission = 'default';
  var next = 1;
  var live = Object.create(null);
  var waiting = Object.create(null);

  function queue(fn) {
    // A microtask, so an event cannot reach a handler the page has not assigned yet: the
    // constructor returns before `n.onerror = …` runs.
    if (typeof global.Promise === 'function') global.Promise.resolve().then(fn);
    else global.setTimeout(fn, 0);
  }

  function text(value) {
    return typeof value === 'string' ? value : '';
  }

  function Notification(title, options) {
    if (!(this instanceof Notification)) {
      throw new TypeError("Failed to construct 'Notification': Please use the 'new' operator.");
    }
    var opts = options || {};
    var handle = next;
    next += 1;

    this.title = text(title);
    this.body = text(opts.body);
    this.tag = text(opts.tag);
    this.icon = text(opts.icon);
    this.silent = opts.silent === true;
    this.data = opts.data === undefined ? null : opts.data;
    this.onclick = null;
    this.onshow = null;
    this.onclose = null;
    this.onerror = null;
    Object.defineProperty(this, '_handle', { value: handle, enumerable: false });
    Object.defineProperty(this, '_listeners', { value: Object.create(null), enumerable: false });
    live[handle] = this;

    // No permission, no message: the spec's own behaviour, and `error` is how it says so.
    if (permission !== 'granted') {
      delete live[handle];
      fire(this, 'error');
      return;
    }
    bridge.postMessage({
      kind: 'show',
      handle: handle,
      title: this.title,
      body: this.body,
      tag: this.tag,
      silent: this.silent,
    });
  }

  Notification.prototype.close = function () {
    var handle = this._handle;
    // Already gone — closed twice, or clicked. A no-op, rather than a second removal that
    // could reach a newer notification wearing the same tag.
    if (!live[handle]) return;
    delete live[handle];
    bridge.postMessage({ kind: 'close', handle: handle, tag: this.tag });
    fire(this, 'close');
  };

  Notification.prototype.addEventListener = function (type, listener) {
    if (typeof listener !== 'function') return;
    var list = this._listeners[type] || (this._listeners[type] = []);
    if (list.indexOf(listener) < 0) list.push(listener);
  };

  Notification.prototype.removeEventListener = function (type, listener) {
    var list = this._listeners[type];
    if (!list) return;
    var at = list.indexOf(listener);
    if (at >= 0) list.splice(at, 1);
  };

  function fire(notification, type) {
    queue(function () {
      var event = typeof global.Event === 'function' ? new global.Event(type) : { type: type };
      var handler = notification['on' + type];
      if (typeof handler === 'function') handler.call(notification, event);
      var list = notification._listeners[type];
      if (!list) return;
      var walking = list.slice();
      for (var i = 0; i < walking.length; i += 1) walking[i].call(notification, event);
    });
  }

  Object.defineProperty(Notification, 'permission', {
    configurable: true,
    enumerable: true,
    get: function () {
      return permission;
    },
  });

  // Both shapes: the promise, and the callback older Safari had alone.
  Notification.requestPermission = function (callback) {
    var handle = next;
    next += 1;
    var settle = null;
    var promise =
      typeof global.Promise === 'function'
        ? new global.Promise(function (resolve) {
            settle = resolve;
          })
        : null;
    waiting[handle] = function (state) {
      if (typeof callback === 'function') callback(state);
      if (settle) settle(state);
    };
    bridge.postMessage({ kind: 'request', handle: handle });
    return promise;
  };

  Notification.maxActions = 0;

  // Displacing a global the engine owns can throw. Swallowing that would leave the page on
  // the engine's dead copy while this believed it owned the API; so it says so and stops.
  try {
    Object.defineProperty(global, 'Notification', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: Notification,
    });
  } catch {
    bridge.postMessage({ kind: 'notDefined' });
    return;
  }
  if (displaced) bridge.postMessage({ kind: 'displaced' });

  // Where the shell reaches back in. Every argument is an integer this file minted or one of
  // three words; nothing the page supplied comes back through a string the shell builds.
  Object.defineProperty(global, NAMESPACE, {
    configurable: true,
    enumerable: false,
    value: {
      permission: function (state) {
        if (STATES.indexOf(state) >= 0) permission = state;
      },
      resolve: function (handle, state) {
        if (STATES.indexOf(state) >= 0) permission = state;
        var settle = waiting[handle];
        delete waiting[handle];
        if (settle) settle(state);
      },
      // macOS took it, which is when `show` fires — not when it was posted.
      shown: function (handle) {
        var notification = live[handle];
        if (notification) fire(notification, 'show');
      },
      failed: function (handle) {
        var notification = live[handle];
        if (!notification) return;
        delete live[handle];
        fire(notification, 'error');
      },
      // Clicked: the handler runs and the object is then dead, so a close() from inside the
      // page's own click handler is the no-op the spec allows.
      clicked: function (handle) {
        var notification = live[handle];
        if (!notification) return;
        fire(notification, 'click');
        delete live[handle];
      },
    },
  });

  // `permission` is read synchronously and macOS answers asynchronously; asking at
  // documentStart makes the moment it says 'default' as short as it can be.
  bridge.postMessage({ kind: 'permission' });
})(globalThis);
