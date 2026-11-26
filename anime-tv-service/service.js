'use strict';

var Service = require('webos-service');
var service = new Service('com.giadinh.anime47tv.service');

// Boot the local Anime47 proxy on 127.0.0.1:5010
var proxy = require('./tv-proxy');

var subscriptions = {};
var heartbeatTimer = null;

function ensureHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(function () {
    var tokens = Object.keys(subscriptions);
    if (!tokens.length) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      return;
    }
    for (var i = 0; i < tokens.length; i++) {
      try {
        subscriptions[tokens[i]].respond({
          returnValue: true,
          status: 'running',
          port: 5010
        });
      } catch (e) {}
    }
  }, 15000);
}

service.register('start', function (message) {
  if (message && message.isSubscription) {
    subscriptions[message.uniqueToken] = message;
    ensureHeartbeat();
  }
  proxy.whenReady(function () {
    try {
      message.respond({
        returnValue: true,
        status: 'ready',
        port: 5010
      });
    } catch (e) {}
  });
}, function (message) {
  if (message && message.uniqueToken) {
    delete subscriptions[message.uniqueToken];
  }
});

service.register('ping', function (message) {
  proxy.whenReady(function () {
    try {
      message.respond({
        returnValue: true,
        status: 'ok',
        port: 5010
      });
    } catch (e) {}
  });
});
