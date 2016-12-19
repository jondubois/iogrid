var fs = require('fs');
var express = require('express');
var serveStatic = require('serve-static');
var path = require('path');
var express = require('express');
var morgan = require('morgan');
var healthChecker = require('sc-framework-health-check');
var CoinManager = require('./coin-manager').CoinManager;

var WORLD_WIDTH = 2000;
var WORLD_HEIGHT = 2000;

var PLAYER_UPDATE_INTERVAL = 20;
var PLAYER_MOVE_SPEED = 7;
var PLAYER_WIDTH = 70;
var PLAYER_HEIGHT = 70;

var COIN_UPDATE_INTERVAL = 1000;
var COIN_TAKEN_INTERVAL = 20;
var COIN_DROP_INTERVAL = 1000;
var COIN_MAX_COUNT = 200;
var COIN_PLAYER_NO_DROP_RADIUS = 100;

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
  var serverWorkerId = worker.options.instanceId + ':' + worker.id;

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

  scServer.addMiddleware(scServer.MIDDLEWARE_PUBLISH_IN, function (req, next) {
    // Only allow clients to publish to channels whose names start with 'external/'
    if (req.channel.indexOf('external/') == 0) {
      next();
    } else {
      var err = new Error('Clients are not allowed to publish to the ' + req.channel + ' channel.');
      err.name = 'ForbiddenPublishError';
      next(err);
    }
  });

  var coinManager = new CoinManager({
    serverWorkerId: serverWorkerId,
    maxCoinCount: COIN_MAX_COUNT,
    playerNoDropRadius: COIN_PLAYER_NO_DROP_RADIUS,
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
    users: users
  });

  // Check if the user hit a coin.
  // Because the user and the coin may potentially be hosted on different
  // workers/servers, we add an additional step by publishing to a secondary internal channel.
  // The first step involves checking that the user exists on this worker. The second step is used to
  // verify that the coin exists (potentially on a different worker) and cross checks that the user did in
  // fact hit the coin. This two-step check is necessary because we cannot trust position data from the client.
  scServer.exchange.subscribe('external/coin-hit-check/' + serverWorkerId)
  .watch(function (data) {
    var curUser = users[data.username];
    if (curUser && data.coins && data.coins.length) {
      data.coins.forEach(function (coinData) {
        scServer.exchange.publish('internal/coin-hit-check/' + coinData.swid, {
          coinId: coinData.id,
          user: curUser,
          swid: serverWorkerId
        });
      });
    }
  });

  scServer.exchange.subscribe('internal/player-increase-score/' + serverWorkerId)
  .watch(function (data) {
    var curUser = users[data.username];
    if (curUser) {
      curUser.score += data.value;
    }
  });

  var removedCoinIds = [];

  scServer.exchange.subscribe('internal/coin-hit-check/' + serverWorkerId)
  .watch(function (data) {
    var coinId = data.coinId;
    var userState = data.user;
    var swid = data.swid;
    if (coinManager.doesUserTouchCoin(coinId, userState)) {
      var coin = coinManager.coins[coinId];
      coinManager.removeCoin(coinId);
      removedCoinIds.push(coinId);
      scServer.exchange.publish('internal/player-increase-score/' + swid, {
        username: userState.name,
        value: coin.v
      });
    }
  });

  var flushPlayerData = function () {
    var playerStates = [];
    for (var i in users) {
      if (users.hasOwnProperty(i)) {
        playerStates.push(users[i]);
      }
    }
    scServer.exchange.publish('player-states', playerStates);
  };

  var flushCoinData = function () {
    var coinPositions = [];
    for (var j in coinManager.coins) {
      if (coinManager.coins.hasOwnProperty(j)) {
        coinPositions.push(coinManager.coins[j]);
      }
    }
    scServer.exchange.publish('coin-states', coinPositions);
  };

  var flushCoinsTakenData = function () {
    if (removedCoinIds.length) {
      scServer.exchange.publish('coins-taken', removedCoinIds);
      removedCoinIds = [];
    }
  };

  setInterval(flushPlayerData, PLAYER_UPDATE_INTERVAL);
  setInterval(flushCoinData, COIN_UPDATE_INTERVAL);
  setInterval(flushCoinsTakenData, COIN_TAKEN_INTERVAL);

  var dropCoin = function () {
    // Drop a coin with value 1 and a radius of 12
    coinManager.addCoin(1, 12);
  };

  setInterval(dropCoin, COIN_DROP_INTERVAL);

  function updatePlayerState(player, playerOp) {
    var wasStateUpdated = false;

    if (playerOp.u) {
      player.y -= PLAYER_MOVE_SPEED;
      wasStateUpdated = true;
    }
    if (playerOp.d) {
      player.y += PLAYER_MOVE_SPEED;
      wasStateUpdated = true;
    }
    if (playerOp.r) {
      player.x += PLAYER_MOVE_SPEED;
      wasStateUpdated = true;
    }
    if (playerOp.l) {
      player.x -= PLAYER_MOVE_SPEED;
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
        height: WORLD_HEIGHT,
        serverWorkerId: serverWorkerId
      });
    });

    socket.on('join', function (playerOptions) {
      var startingPos = getRandomPosition(PLAYER_WIDTH, PLAYER_HEIGHT);
      socket.player = {
        name: playerOptions.name,
        color: playerOptions.color,
        x: startingPos.x,
        y: startingPos.y,
        score: 0,
        width: PLAYER_WIDTH,
        height: PLAYER_HEIGHT
      };

      users[playerOptions.name] = socket.player;
    });

    socket.on('action', function (playerOp) {
      if (socket.player) {
        var wasStateUpdated = updatePlayerState(socket.player, playerOp);
      }
    });

    socket.on('disconnect', function () {
      if (socket.player) {
        var username = socket.player.name;
        scServer.exchange.publish('player-leave', {
          name: username
        });
        delete users[username];
      }
    });
  });
};
