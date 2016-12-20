var fs = require('fs');
var express = require('express');
var serveStatic = require('serve-static');
var path = require('path');
var morgan = require('morgan');
var healthChecker = require('sc-framework-health-check');
var CoinManager = require('./coin-manager').CoinManager;
var uuid = require('uuid');
var ChannelGrid = require('./public/channel-grid').ChannelGrid;
var rbush = require('rbush');

var WORLD_WIDTH = 4000;
var WORLD_HEIGHT = 4000;
var WORLD_CELL_WIDTH = 1000;
var WORLD_CELL_HEIGHT = 1000;
var WORLD_COLS = Math.ceil(WORLD_WIDTH / WORLD_CELL_WIDTH);
var WORLD_ROWS = Math.ceil(WORLD_HEIGHT / WORLD_CELL_HEIGHT);
var WORLD_CELLS = WORLD_COLS * WORLD_ROWS;

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

  if (WORLD_CELLS % worker.options.workers != 0) {
    var errorMessage = 'The number of cells in your world (determined by WORLD_WIDTH, WORLD_HEIGHT, WORLD_CELL_WIDTH, WORLD_CELL_HEIGHT)' +
      ' need to share a common factor with the number of workers or else the workload will not be evenly distributed across them.';
    throw new Error(errorMessage);
  }

  // This allows us to break up our channels into a grid of cells which we can
  // watch and publish to individually.
  var channelGrid = new ChannelGrid({
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
    rows: WORLD_ROWS,
    cols: WORLD_COLS,
    exchange: scServer.exchange
  });

  // Check if the user hit a coin.
  // Because the user and the coin may potentially be hosted on different
  // workers/servers, we add an additional step by publishing to a secondary internal channel.
  // The first step involves checking that the user exists on this worker. The second step is used to
  // verify that the coin exists (potentially on a different worker) and cross checks that the user did in
  // fact hit the coin. This two-step check is necessary because we cannot trust position data from the client.
  scServer.exchange.subscribe('external/coin-hit-check/' + serverWorkerId)
  .watch(function (data) {
    var curUser = users[data.userId];
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
    var curUser = users[data.userId];
    if (curUser) {
      curUser.score += data.value;
    }
  });

  var removedCoins = [];

  scServer.exchange.subscribe('internal/coin-hit-check/' + serverWorkerId)
  .watch(function (data) {
    var coinId = data.coinId;
    var userState = data.user;
    var swid = data.swid;
    if (coinManager.doesUserTouchCoin(coinId, userState)) {
      var coin = coinManager.coins[coinId];
      removedCoins.push(coin);
      coinManager.removeCoin(coinId);
      scServer.exchange.publish('internal/player-increase-score/' + swid, {
        userId: userState.id,
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
    channelGrid.publish('player-states', playerStates);
  };

  var flushCoinData = function () {
    var coinStates = [];
    for (var j in coinManager.coins) {
      if (coinManager.coins.hasOwnProperty(j)) {
        coinStates.push(coinManager.coins[j]);
      }
    }
    channelGrid.publish('coin-states', coinStates);
  };

  var flushCoinsTakenData = function () {
    if (removedCoins.length) {
      channelGrid.publish('coins-taken', removedCoins);
      removedCoins = [];
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

  /*
    In here we handle our incoming realtime connections and listen for events.
  */
  scServer.on('connection', function (socket) {
    socket.on('getWorldInfo', function (data, respond) {
      // The first argument to respond can optionally be an Error object.
      respond(null, {
        width: WORLD_WIDTH,
        height: WORLD_HEIGHT,
        cols: WORLD_COLS,
        rows: WORLD_ROWS,
        cellWidth: WORLD_CELL_WIDTH,
        cellHeight: WORLD_CELL_HEIGHT,
        serverWorkerId: serverWorkerId
      });
    });

    socket.on('join', function (playerOptions, respond) {
      var startingPos = getRandomPosition(PLAYER_WIDTH, PLAYER_HEIGHT);
      socket.player = {
        id: uuid.v4(),
        swid: serverWorkerId,
        name: playerOptions.name,
        color: playerOptions.color,
        x: startingPos.x,
        y: startingPos.y,
        score: 0,
        width: PLAYER_WIDTH,
        height: PLAYER_HEIGHT
      };

      users[socket.player.id] = socket.player;

      respond(null, socket.player);
    });

    socket.on('action', function (playerOp) {
      if (socket.player) {
        var wasStateUpdated = updatePlayerState(socket.player, playerOp);
      }
    });

    socket.on('disconnect', function () {
      if (socket.player) {
        var userId = socket.player.id;
        delete users[userId];
      }
    });
  });
};
