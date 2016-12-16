var fs = require('fs');
var express = require('express');
var serveStatic = require('serve-static');
var path = require('path');
var express = require('express');
var morgan = require('morgan');
var healthChecker = require('sc-framework-health-check');

var WORLD_WIDTH = 2000;
var WORLD_HEIGHT = 2000;
var moveSpeed = 15;
var playerWidth = 40;
var playerHeight = 40;

var users = {};

function getRandomPosition(spriteWidth, spriteHeight) {
  var halfSpriteWidth = spriteWidth / 2;
  var halfSpriteHeight = spriteHeight / 2;
  var widthRandomness = WORLD_WIDTH - spriteWidth;
  var heightRandomness = WORLD_HEIGHT - spriteHeight;
  return {
    x: Math.round(halfSpriteWidth + widthRandomness * Math.random()),
    y: Math.round(halfSpriteHeight + heightRandomness * Math.random())
  };
}

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
    if (playerPositionsBuffer.length) {
      scServer.exchange.publish('player-positions', playerPositionsBuffer);
      playerPositionsBuffer = [];
    }
    positionFlushTimeout = null;
  };

  function updatePlayerState(player, playerOp) {
    var wasStateUpdated = false;

    if (playerOp.u) {
      player.y -= moveSpeed;
      wasStateUpdated = true;
    }
    if (playerOp.d) {
      player.y += moveSpeed;
      wasStateUpdated = true;
    }
    if (playerOp.r) {
      player.x += moveSpeed;
      wasStateUpdated = true;
    }
    if (playerOp.l) {
      player.x -= moveSpeed;
      wasStateUpdated = true;
    }

    var halfWidth = Math.round(player.width / 2);
    var halfHeight = Math.round(player.height / 2);

    var leftX = player.x - halfWidth;
    var rightX = player.x + halfWidth;
    var topY = player.y - halfHeight;
    var bottomY = player.y + halfHeight;

    if (leftX < 0) {
      player.x = halfWidth;
    } else if (rightX > WORLD_WIDTH) {
      player.x = WORLD_WIDTH - halfWidth;
    }
    if (topY < 0) {
      player.y = halfHeight;
    } else if (bottomY > WORLD_HEIGHT) {
      player.y = WORLD_HEIGHT - halfHeight;
    }
    return wasStateUpdated;
  }

  var getUserPresenceChannelName = function (username) {
    return 'user/' + username + '/presence-notification';
  };

  /*
    In here we handle our incoming realtime connections and listen for events.
  */
  scServer.on('connection', function (socket) {

    socket.on('getWorldInfo', function (data, respond) {
      // The first argument to respond can optionally be an Error object.
      respond(null, {
        width: WORLD_WIDTH,
        height: WORLD_HEIGHT
      });
    });

    socket.on('ack-player-join', function (data) {
      var playerData = users[data.existingPlayer];
      if (playerData) {
        worker.exchange.publish(getUserPresenceChannelName(data.newPlayer), {
          name: playerData.name,
          color: playerData.color,
          x: playerData.x,
          y: playerData.y
        });
      }
    });

    socket.on('join', function (playerOptions, respond) {
      var startingPos = getRandomPosition(playerWidth, playerHeight);
      socket.player = {
        name: playerOptions.name,
        color: playerOptions.color,
        x: startingPos.x,
        y: startingPos.y,
        width: playerWidth,
        height: playerHeight
      };

      users[playerOptions.name] = socket.player;

      scServer.exchange.publish('player-join', socket.player);
    });
    socket.on('action', function (playerOp) {
      if (socket.player) {
        var wasStateUpdated = updatePlayerState(socket.player, playerOp);
        // We will batch together multiple position changes within a 20 millisecond timeframe
        // and send them all off in a single publish action for performance reasons.
        // It's cheaper to publish 1 long 100 KB message than 100 short 1 KB messages.
        if (wasStateUpdated) {
          playerPositionsBuffer.push({
            name: socket.player.name,
            color: socket.player.color,
            x: socket.player.x,
            y: socket.player.y
          });
        }
        if (!positionFlushTimeout) {
          positionFlushTimeout = setTimeout(flushPlayerPositions, 20);
        }
      }
    });
    socket.on('disconnect', function () {
      if (socket.player) {
        var userName = socket.player.name;
        scServer.exchange.publish('player-leave', {
          name: userName
        });
        delete users[userName];
      }
    });
  });
};
