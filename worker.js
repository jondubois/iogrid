var fs = require('fs');
var express = require('express');
var serveStatic = require('serve-static');
var path = require('path');
var express = require('express');
var morgan = require('morgan');
var healthChecker = require('sc-framework-health-check');

module.exports.run = function (worker) {
  console.log('   >> Worker PID:', process.pid);
  var environment = worker.options.environment;

  var app = express();

  var httpServer = worker.httpServer;
  var scServer = worker.scServer;

  if (environment == 'dev') {
    // Log every HTTP request. See https://github.com/expressjs/morgan for other
    // available formats.
    app.use(morgan('dev'));
  }
  app.use(serveStatic(path.resolve(__dirname, 'public')));

  // Add GET /health-check express route
  healthChecker.attach(worker, app);

  httpServer.on('request', app);

  var positionFlushTimeout = null;
  var playerPositionsBuffer = [];
  var flushPlayerPositions = function () {
    scServer.exchange.publish('player-positions', playerPositionsBuffer);
    playerPositionsBuffer = [];
    positionFlushTimeout = null;
  };

  /*
    In here we handle our incoming realtime connections and listen for events.
  */
  scServer.on('connection', function (socket) {
    socket.on('join', function (playerData) {
      // Create an auth token to track this player
      socket.setAuthToken({
        name: playerData.name,
        color: playerData.color
      });
      scServer.exchange.publish('player-join', {
        name: playerData.name,
        color: playerData.color,
        x: playerData.x,
        y: playerData.y
      });
    });
    socket.on('move', function (playerData) {
      var playerToken = socket.getAuthToken();

      if (playerToken) {
        // We will batch together multiple position changes within a 20 millisecond timeframe
        // and send them all off in a single publish action for performance reasons.
        // It's cheaper to publish 1 long 100 KB message than 100 short 1 KB messages.
        playerPositionsBuffer.push({
          name: playerToken.name,
          color: playerToken.color,
          x: playerData.x,
          y: playerData.y
        });
        if (!positionFlushTimeout) {
          positionFlushTimeout = setTimeout(flushPlayerPositions, 20);
        }
      }
    });
    socket.on('disconnect', function () {
      var playerToken = socket.getAuthToken();

      if (playerToken) {
        scServer.exchange.publish('player-leave', {
          name: playerToken.name
        });
      }
    });
  });
};
