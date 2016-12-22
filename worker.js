var fs = require('fs');
var express = require('express');
var serveStatic = require('serve-static');
var path = require('path');
var morgan = require('morgan');
var healthChecker = require('sc-framework-health-check');
var CoinManager = require('./coin-manager').CoinManager;
var BotManager = require('./bot-manager').BotManager;
var uuid = require('uuid');
var ChannelGrid = require('./public/channel-grid').ChannelGrid;
var SAT = require('sat');
var rbush = require('rbush');
var cellController = require('./cell');

var WORLD_WIDTH = 2000;
var WORLD_HEIGHT = 2000;
var WORLD_CELL_WIDTH = 500;
var WORLD_CELL_HEIGHT = 500;
var WORLD_COLS = Math.ceil(WORLD_WIDTH / WORLD_CELL_WIDTH);
var WORLD_ROWS = Math.ceil(WORLD_HEIGHT / WORLD_CELL_HEIGHT);
var WORLD_CELLS = WORLD_COLS * WORLD_ROWS;

var PLAYER_UPDATE_INTERVAL = 20;
var PLAYER_MOVE_SPEED = 7;
var PLAYER_DIAMETER = 70;


var COIN_UPDATE_INTERVAL = 1000;
var COIN_TAKEN_INTERVAL = 20;
var COIN_DROP_INTERVAL = 1000;
var COIN_MAX_COUNT = 10;
var COIN_PLAYER_NO_DROP_RADIUS = 100;

var BOT_COUNT = 1;
var BOT_MOVE_SPEED = 3;

var game = {
  users: {}
};

// TODO: Need to fix the problem if two users collide on the edge of two cells in the grid
// with each player in their own cell.

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

  // TODO: Prevent user from subscribing to internal channels
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
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
    maxCoinCount: COIN_MAX_COUNT,
    playerNoDropRadius: COIN_PLAYER_NO_DROP_RADIUS,
    users: game.users
  });

  var botManager = new BotManager({
    serverWorkerId: serverWorkerId,
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
    botMoveSpeed: BOT_MOVE_SPEED,
    users: game.users
  });

  // This allows us to break up our channels into a grid of cells which we can
  // watch and publish to individually.
  var channelGrid = new ChannelGrid({
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
    rows: WORLD_ROWS,
    cols: WORLD_COLS,
    exchange: scServer.exchange
  });

  scServer.exchange.subscribe('internal/worker-data/' + serverWorkerId)
  .watch(function (data) {
    var playerIds = Object.keys(data.player);
    playerIds.forEach(function (id) {
      var targetPlayerState = game.users[id];
      if (targetPlayerState) {
        var freshOp = targetPlayerState.op;
        var sourcePlayerState = data.player[id];
        for (var i in targetPlayerState) {
          if (targetPlayerState.hasOwnProperty(i)) {
            delete targetPlayerState[i];
          }
        }
        for (var j in sourcePlayerState) {
          if (sourcePlayerState.hasOwnProperty(j)) {
            targetPlayerState[j] = sourcePlayerState[j];
          }
        }
        if (freshOp) {
          targetPlayerState.op = freshOp;
        } else {
          delete targetPlayerState.op;
        }
      }
    });
  });

  if (WORLD_CELLS % worker.options.workers != 0) {
    var errorMessage = 'The number of cells in your world (determined by WORLD_WIDTH, WORLD_HEIGHT, WORLD_CELL_WIDTH, WORLD_CELL_HEIGHT)' +
      ' should share a common factor with the number of workers or else the workload might get duplicated for some cells.';
    console.error(errorMessage);
  }

  var cellsPerWorker = WORLD_CELLS / worker.options.workers;
  var workerCellIndexes = {};
  var cellControllerOptions = {
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
    playerMoveSpeed: PLAYER_MOVE_SPEED
  };
  var cellData = {};

  for (var h = 0; h < cellsPerWorker; h++) {
    var cellIndex = worker.id + h * worker.options.workers;
    // Track cell indexes handled by our current worker.
    workerCellIndexes[cellIndex] = true;
    channelGrid.watchCellAtIndex('internal/cell-data-processing', cellIndex, gridCellDataHandler);
  }

  function dispatchProcessedData(processedCellData) {
    var workerData = {};
    var wokerIdList = [];
    var typeList = Object.keys(processedCellData);

    typeList.forEach(function (type) {
      var stateList = processedCellData[type];
      var ids = Object.keys(stateList);

      ids.forEach(function (id) {
        var state = stateList[id];
        var swid = state.swid;

        if (!cellData[type]) {
          cellData[type] = {};
        }
        cellData[type][id] = state;

        if (!workerData[swid]) {
          workerData[swid] = {};
          wokerIdList.push(swid);
        }
        if (!workerData[swid][type]) {
          workerData[swid][type] = {};
        }

        workerData[swid][type][id] = state;

        if (state.op) {
          delete state.op;
        }

        var cellIndex = channelGrid.getCellIndex(state);

        // After doing the processing, if the state object is no longer
        // in this cell, then we should delete it from our cellData map.
        if (!workerCellIndexes[cellIndex]) {
          delete processedCellData[type][id];
        }
      });
    });

    wokerIdList.forEach(function (swid) {
      scServer.exchange.publish('internal/worker-data/' + swid, workerData[swid]);
    });
  };

  var lastProcessing = Date.now();

  function gridCellDataHandler(stateList) {
    stateList.forEach(function (state) {
      if (!cellData[state.type]) {
        cellData[state.type] = {};
      }

      // TODO: CELLL
      // The reason why we don't just copy the state from the upstream worker
      // every time is because otherwise upstream changes may occasionally conflict
      // with changes made by our cell controller.
      // We copy the 'op' property which can carry single-use operations/actions and
      // the 'data' property which can carry any long-term custom data.
      if (!cellData[state.type][state.id]) {
        cellData[state.type][state.id] = state;
      }
      var cachedState = cellData[state.type][state.id];
      cachedState.op = state.op;
      cachedState.data = state.data;
    });

    cellController.run(cellControllerOptions, cellData, dispatchProcessedData);
  }
  // TODO
  // setInterval(function () {
  //   cellController.run(cellControllerOptions, cellData, dispatchProcessedData);
  // }, CELL_UPDATE_INTERVAL);

  // Check if the user hit a coin.
  // Because the user and the coin may potentially be hosted on different
  // workers/servers, we add an additional step by publishing to a secondary internal channel.
  // The first step involves checking that the user exists on this worker. The second step is used to
  // verify that the coin exists (potentially on a different worker) and cross checks that the user did in
  // fact hit the coin. This two-step check is necessary because we cannot trust position data from the client.
  scServer.exchange.subscribe('external/coin-hit-check/' + serverWorkerId)
  .watch(function (data) {
    var curUser = game.users[data.userId];
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
    var curUser = game.users[data.userId];
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

  function flushPlayerData() {
    var playerStates = [];
    for (var i in game.users) {
      if (game.users.hasOwnProperty(i)) {
        playerStates.push(game.users[i]);
      }
    }

    channelGrid.publish('cell-data', playerStates);

    // Publish to internal channel for processing (e.g. Collision
    // detection and resolution, scoring, etc...)
    channelGrid.publish('internal/cell-data-processing', playerStates);

    playerStates.forEach(function (player) {
      delete player.op;
    });
  }

  function flushCoinData() {
    var coinStates = [];
    for (var j in coinManager.coins) {
      if (coinManager.coins.hasOwnProperty(j)) {
        coinStates.push(coinManager.coins[j]);
      }
    }
    channelGrid.publish('coin-states', coinStates);
  }

  function flushCoinsTakenData() {
    if (removedCoins.length) {
      channelGrid.publish('coins-taken', removedCoins);
      removedCoins = [];
    }
  }

  function updatePlayers() {
    botManager.moveBotsRandomly();
    flushPlayerData();
  }

  setInterval(updatePlayers, PLAYER_UPDATE_INTERVAL);
  setInterval(flushCoinData, COIN_UPDATE_INTERVAL);
  setInterval(flushCoinsTakenData, COIN_TAKEN_INTERVAL);

  var dropCoin = function () {
    // Drop a coin with value 1 and a radius of 12
    coinManager.addCoin(1, 12);
  };

  setInterval(dropCoin, COIN_DROP_INTERVAL);

  for (var b = 0; b < BOT_COUNT; b++) {
    botManager.addBot(); // TODO
  }

  /*
    In here we handle our incoming realtime connections and listen for events.
  */
  scServer.on('connection', function (socket) {
    console.log('USER SWID:', serverWorkerId);
    socket.on('getWorldInfo', function (data, respond) {
      // The first argument to respond can optionally be an Error object.
      respond(null, {
        width: WORLD_WIDTH,
        height: WORLD_HEIGHT,
        cols: WORLD_COLS,
        rows: WORLD_ROWS,
        cellWidth: WORLD_CELL_WIDTH,
        cellHeight: WORLD_CELL_HEIGHT,
        serverWorkerId: serverWorkerId,
        environment: environment
      });
    });

    socket.on('join', function (playerOptions, respond) {
      var startingPos = getRandomPosition(PLAYER_DIAMETER, PLAYER_DIAMETER);
      socket.player = {
        id: uuid.v4(),
        type: 'player',
        swid: serverWorkerId,
        name: playerOptions.name,
        color: playerOptions.color,
        x: startingPos.x,
        y: startingPos.y,
        score: 0,
        width: PLAYER_DIAMETER,
        height: PLAYER_DIAMETER,
        processed: Date.now()
      };

      game.users[socket.player.id] = socket.player;

      respond(null, socket.player);
    });

    function setPlayerAction(player, op) {
      player.op = op;
    }

    socket.on('action', function (playerOp) {
      if (socket.player) {
        setPlayerAction(socket.player, playerOp);
      }
    });

    socket.on('disconnect', function () {
      if (socket.player) {
        var userId = socket.player.id;
        delete game.users[userId];
        delete game.users[userId];
      }
    });
  });
};
