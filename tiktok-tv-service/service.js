'use strict';

var Service = require('webos-service');
var proxy = require('./server');

var service = new Service('com.giadinh.tiktoktv.service');

service.register('start', function (message) {
  proxy.whenReady(function () {
    message.respond({
      returnValue: true,
      port: proxy.PORT,
      status: 'TikTok TV native proxy service running'
    });
  });
});

service.register('ping', function (message) {
  proxy.whenReady(function () {
    message.respond({
      returnValue: true,
      port: proxy.PORT,
      alive: true
    });
  });
});
