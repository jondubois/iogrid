var fs = require('fs');
var express = require('express');
var serveStatic = require('serve-static');
var path = require('path');
var morgan = require('morgan');
var healthChecker = require('sc-framework-health-check');
var StateManager = require('./state-manager').StateManager;
// var CoinManager = require('./coin-manager').CoinManager;
var BotManager = require('./bot-manager').BotManager;
var uuid = require('uuid');
var ChannelGrid = require('./public/channel-grid').ChannelGrid;
var SAT = require('sat');
var rbush = require('rbush');
var cellController = require('./cell');

var WORLD_WIDTH = 4000;
var WORLD_HEIGHT = 4000;

// Dividing the world into vertical or horizontal strips (instead of cells)
// is more efficient.
var WORLD_CELL_WIDTH = 500;
var WORLD_CELL_HEIGHT = 4000;
var WORLD_COLS = Math.ceil(WORLD_WIDTH / WORLD_CELL_WIDTH);
var WORLD_ROWS = Math.ceil(WORLD_HEIGHT / WORLD_CELL_HEIGHT);
var WORLD_CELLS = WORLD_COLS * WORLD_ROWS;

/*
  This allows players from two different cells on the grid to
  interact with one another.
  It represents the maximum distance that they can be from one another if they
  are in different cells. A smaller distance is more efficient.
*/
var WORLD_CELL_OVERLAP_DISTANCE = 110;
var WORLD_UPDATE_INTERVAL = 40;

var PLAYER_MOVE_SPEED = 10;
var PLAYER_DIAMETER = 100;
var PLAYER_MASS = 5;

var BOT_COUNT = 4;
var BOT_MOVE_SPEED = 5;
var BOT_MASS = 10;
var BOT_DIAMETER = 100;

var COIN_UPDATE_INTERVAL = 1000;
var COIN_DROP_INTERVAL = 1000;
var COIN_MAX_COUNT = 10;
var COIN_PLAYER_NO_DROP_RADIUS = 100;

var game = {
  states: {}
};

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

  scServer.addMiddleware(scServer.MIDDLEWARE_SUBSCRIBE, function (req, next) {
    if (req.channel.indexOf('internal/') == 0) {
      var err = new Error('Clients are not allowed to subscribe to the ' + req.channel + ' channel.');
      err.name = 'ForbiddenSubscribeError';
      next(err);
    } else {
      next();
    }
  });

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

  // var coinManager = new CoinManager({
  //   serverWorkerId: serverWorkerId,
  //   worldWidth: WORLD_WIDTH,
  //   worldHeight: WORLD_HEIGHT,
  //   maxCoinCount: COIN_MAX_COUNT,
  //   playerNoDropRadius: COIN_PLAYER_NO_DROP_RADIUS,
  //   players: game.players
  // });

  var stateManager = new StateManager({
    states: game.states
  });

  var botManager = new BotManager({
    serverWorkerId: serverWorkerId,
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
    botDiameter: BOT_DIAMETER,
    botMoveSpeed: BOT_MOVE_SPEED,
    botMass: BOT_MASS,
    states: game.states
  });

  // This allows us to break up our channels into a grid of cells which we can
  // watch and publish to individually.
  var channelGrid = new ChannelGrid({
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
    cellOverlapDistance: WORLD_CELL_OVERLAP_DISTANCE,
    rows: WORLD_ROWS,
    cols: WORLD_COLS,
    exchange: scServer.exchange
  });

  scServer.exchange.subscribe('internal/cell-processing-outbound/' + serverWorkerId)
  .watch(function (data) {
    var playerIds = Object.keys(data.player);
    playerIds.forEach(function (id) {
      var targetPlayerState = game.states[id];
      if (targetPlayerState) {
        var sourcePlayerState = data.player[id];
        // The cell controller can overwrite every property except for the op
        // and data properties.
        var freshOp = targetPlayerState.op;
        var freshDelete = targetPlayerState.delete;
        var freshData = targetPlayerState.data;

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
        if (freshDelete) {
          targetPlayerState.delete = freshDelete;
        } else {
          delete targetPlayerState.delete;
        }
        if (freshData) {
          targetPlayerState.data = freshData;
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
  var cellControllerOptions = {
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
    worldUpdateInterval: WORLD_UPDATE_INTERVAL,
    playerMoveSpeed: PLAYER_MOVE_SPEED
  };
  cellController.init(cellControllerOptions);
  var cellData = {};

  for (var h = 0; h < cellsPerWorker; h++) {
    var cellIndex = worker.id + h * worker.options.workers;
    // Track cell indexes handled by our current worker.
    cellData[cellIndex] = {};
    channelGrid.watchCellAtIndex('internal/cell-processing-inbound', cellIndex, gridCellDataHandler.bind(null, cellIndex));
  }

  function prepareWorkerDataTree(cellIndex, workerData, state) {
    var id = state.id;
    var swid = state.swid;
    var type = state.type;

    if (state.op) {
      delete state.op;
    }
    if (state.isFresh) {
      delete state.isFresh;
    }

    if (swid) {
      if (!workerData[swid]) {
        workerData[swid] = {};
      }
      if (!workerData[swid][type]) {
        workerData[swid][type] = {};
      }

      var targetCellIndex = channelGrid.getCellIndex(state);

      // This data will be sent out to the upstream worker.
      if (targetCellIndex == cellIndex || state.clid == cellIndex) {
        workerData[swid][type][id] = state;
      }

      // If the state object is no longer in this cell, we should delete
      // it from our cellData map.
      if (targetCellIndex != cellIndex || state.clid != cellIndex) {
      // if (targetCellIndex != cellIndex) {
        delete cellData[cellIndex][type][id];
      }
      // We need to set this in case there is a disagreement over which cell should
      // handle a state.
      state.clid = targetCellIndex;
    }
  }

  function dispatchProcessedData(cellIndex, processedSubTree) {
    var workerData = {};
    var currentCellData = processedSubTree || cellData[cellIndex];
    var typeList = Object.keys(currentCellData);

    typeList.forEach(function (type) {
      var stateList = currentCellData[type];
      var ids = Object.keys(stateList);

      ids.forEach(function (id) {
        var state = stateList[id];
        prepareWorkerDataTree(cellIndex, workerData, state);
      });
    });
    // TODO: DO NOT SEND IF SUBTREE IS EMPTY
    // console.log(55, processedSubTree)

    // This after we've processed the data in our cell controller, we will send it back
    // to the appropriate workers (based on swid) which will then redistribute it to players.
    var workerIdList = Object.keys(workerData);
    workerIdList.forEach(function (swid) {
      scServer.exchange.publish('internal/cell-processing-outbound/' + swid, workerData[swid]);
    });
  };

  // Here we handle and prepare data for a single cell within our game grid to be
  // processed by our cell controller.
  function gridCellDataHandler(cellIndex, stateList) {
    var cachedStateList = [];
    var currentCellData = cellData[cellIndex];
    stateList.forEach(function (state) {
      if (!currentCellData[state.type]) {
        currentCellData[state.type] = {};
      }
      /*
        The reason why we don't always copy the state from the upstream worker
        every time is because, by doing so, upstream changes may occasionally conflict
        with changes made by our cell controller.
        So we only cache the state data the first time we see it in this cell;
        after this, any further state changes should be made by the cell controller.
        The only two properties which we allow the upstream worker to change are the 'op'
        and 'data' properties. The 'op' property can can carry single-use operations/actions
        to be interpreted by the cell controller.
        The 'data' property can carry any long-term custom data.
      */
      if (!currentCellData[state.type][state.id]) {
        currentCellData[state.type][state.id] = state;
      }
      var cachedState = currentCellData[state.type][state.id];
      if (state.op) {
        cachedState.op = state.op;
      }
      if (state.delete) {
        cachedState.delete = state.delete;
      }
      if (state.data) {
        cachedState.data = state.data;
      }
      cachedState.isFresh = true;
      cachedState.processed = Date.now();
      cachedStateList.push(cachedState);
    });

    cellController.run(currentCellData, dispatchProcessedData.bind(null, cellIndex));
  }

  setInterval(function () {
    var statesList = [];
    var cellDataIndexes = Object.keys(cellData);
    cellDataIndexes.forEach(function (cellIndex) {
      var currentCellData = cellData[cellIndex];
      var typeList = Object.keys(currentCellData);

      typeList.forEach(function (type) {
        var ids = Object.keys(currentCellData[type]);
        ids.forEach(function (id) {
          var state = currentCellData[type][id];
          var targetCellIndex = channelGrid.getCellIndex(state);
          if (targetCellIndex == cellIndex || state.clid == cellIndex) {
            statesList.push(state);
          }
        });
      });
    });

    // External channel which clients can subscribe to.
    // It will publish to multiple channels based on each state's
    // (x, y) coordinates.
    channelGrid.publish('cell-data', statesList);
  }, WORLD_UPDATE_INTERVAL);


  // This is the main input loop which feeds states into various cells
  // based on their (x, y) coordinates.
  function processInputStates() {
    var stateList = [];
    var stateIds = Object.keys(game.states);

    stateIds.forEach(function (id) {
      var state = game.states[id];
      stateList.push(state);
    });

    // Publish to internal channel for processing (e.g. Collision
    // detection and resolution, scoring, etc...)
    // These states will be processed by various cell controllers depending
    // on each state's (x, y) coordinates within the world grid.
    channelGrid.publish('internal/cell-processing-inbound', stateList);

    stateList.forEach(function (state) {
      if (state.op) {
        delete state.op;
      }
      if (state.delete) {
        delete game.states[state.id];
      }
    });
  }

  // function flushCoinData() {
  //   var coinStates = [];
  //   for (var j in coinManager.coins) {
  //     if (coinManager.coins.hasOwnProperty(j)) {
  //       coinStates.push(coinManager.coins[j]);
  //     }
  //   }
  //   channelGrid.publish('coin-states', coinStates);
  // }

  // function flushCoinsTakenData() {
  //   if (removedCoins.length) {
  //     channelGrid.publish('coins-taken', removedCoins);
  //     removedCoins = [];
  //   }
  // }

  function updateWorldState() {
    // botManager.moveBotsRandomly();
    processInputStates();
  }

  setInterval(updateWorldState, WORLD_UPDATE_INTERVAL);

  // var dropCoin = function () {
  //   // Drop a coin with value 1 and a radius of 12
  //   coinManager.addCoin(1, 12);
  // };

  // setInterval(dropCoin, COIN_DROP_INTERVAL);

  var botsPerWorker = Math.round(BOT_COUNT / worker.options.workers);
  for (var b = 0; b < botsPerWorker; b++) {
    // botManager.addBot();
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
        cellOverlapDistance: WORLD_CELL_OVERLAP_DISTANCE,
        serverWorkerId: serverWorkerId,
        environment: environment
      });
    });

    socket.on('join', function (playerOptions, respond) {
      var startingPos = getRandomPosition(PLAYER_DIAMETER, PLAYER_DIAMETER);
      var player = {
        id: uuid.v4(),
        type: 'player',
        swid: serverWorkerId,
        name: playerOptions.name,
        color: playerOptions.color,
        x: startingPos.x,
        y: startingPos.y,
        width: PLAYER_DIAMETER,
        height: PLAYER_DIAMETER,
        mass: PLAYER_MASS,
        score: 0,
        data: {
          score: 0
        },
        processed: Date.now()
      };

      socket.player = stateManager.create(player);

      respond(null, player);
    });

    socket.on('action', function (playerOp) {
      if (socket.player) {
        stateManager.update(socket.player, playerOp);
      }
    });

    socket.on('disconnect', function () {
      if (socket.player) {
        stateManager.delete(socket.player);
      }
    });
  });
};
