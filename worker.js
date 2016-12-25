var fs = require('fs');
var express = require('express');
var serveStatic = require('serve-static');
var path = require('path');
var morgan = require('morgan');
var healthChecker = require('sc-framework-health-check');
var StateManager = require('./state-manager').StateManager;
var BotManager = require('./bot-manager').BotManager;
var uuid = require('uuid');
var ChannelGrid = require('./public/channel-grid').ChannelGrid;
var SAT = require('sat');
var rbush = require('rbush');
var scCodecMinBin = require('sc-codec-min-bin');
var CellController = require('./cell');

// Having a large world is more efficient. You can divide it up into cells
// to split up the workload between multiple CPU cores.
var WORLD_WIDTH = 2000;
var WORLD_HEIGHT = 1000;

// Dividing the world into vertical or horizontal strips (instead of cells)
// is more efficient. Using few large cells is much more efficient than using
// many small ones. Try to use as few as possible - Once cell per worker/CPU core is ideal.
var WORLD_CELL_WIDTH = 500;
var WORLD_CELL_HEIGHT = 1000;
var WORLD_COLS = Math.ceil(WORLD_WIDTH / WORLD_CELL_WIDTH);
var WORLD_ROWS = Math.ceil(WORLD_HEIGHT / WORLD_CELL_HEIGHT);
var WORLD_CELLS = WORLD_COLS * WORLD_ROWS;

/*
  This allows players from two different cells on the grid to
  interact with one another.
  It represents the maximum distance that they can be from one another if they
  are in different cells. A smaller distance is more efficient.
*/
var WORLD_CELL_OVERLAP_DISTANCE = 150;
var WORLD_UPDATE_INTERVAL = 40

var PLAYER_MOVE_SPEED = 10;
var PLAYER_DIAMETER = 120;
var PLAYER_MASS = 20;

// Note that the number of bots needs to be either 0 or a multiple of the number of
// worker processes or else it will get rounded up/down.
var BOT_COUNT = 200;
var BOT_MOVE_SPEED = 10;
var BOT_MASS = 10;
var BOT_DIAMETER = 100;
var BOT_CHANGE_DIRECTION_PROBABILITY = 0.01;

var COIN_UPDATE_INTERVAL = 1000;
var COIN_DROP_INTERVAL = 1000;
var COIN_RADIUS = 12;
var COIN_MAX_COUNT = 100;
var COIN_PLAYER_NO_DROP_RADIUS = 100;

var CHANNEL_INBOUND_CELL_PROCESSING = 'internal/cell-processing-inbound';
var CHANNEL_CELL_TRANSITION = 'internal/cell-transition';

var game = {
  stateRefs: {}
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

  // We use a codec for SC to compress messages between clients and the server
  // to a lightweight binary format to reduce bandwidth consumption.
  worker.scServer.setCodecEngine(scCodecMinBin);

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

  var stateManager = new StateManager({
    stateRefs: game.stateRefs,
    channelGrid: channelGrid
  });

  var botManager = new BotManager({
    serverWorkerId: serverWorkerId,
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
    botDiameter: BOT_DIAMETER,
    botMoveSpeed: BOT_MOVE_SPEED,
    botMass: BOT_MASS,
    botChangeDirectionProbability: BOT_CHANGE_DIRECTION_PROBABILITY,
    stateManager: stateManager
  });

  if (WORLD_CELLS % worker.options.workers != 0) {
    var errorMessage = 'The number of cells in your world (determined by WORLD_WIDTH, WORLD_HEIGHT, WORLD_CELL_WIDTH, WORLD_CELL_HEIGHT)' +
      ' should share a common factor with the number of workers or else the workload might get duplicated for some cells.';
    console.error(errorMessage);
  }

  var cellsPerWorker = WORLD_CELLS / worker.options.workers;
  var cellData = {};
  var pendingCellDataUpdates = {};
  var cellControllers = {};

  for (var h = 0; h < cellsPerWorker; h++) {
    var cellIndex = worker.id + h * worker.options.workers;
    // Track cell indexes handled by our current worker.
    cellData[cellIndex] = {};
    cellControllers[cellIndex] = new CellController({
      cellIndex: cellIndex,
      cellData: cellData[cellIndex],
      cellBounds: channelGrid.getCellBounds(cellIndex),
      coinPlayerNoDropRadius: COIN_PLAYER_NO_DROP_RADIUS,
      coinMaxCount: Math.round(COIN_MAX_COUNT / WORLD_CELLS),
      coinDropInterval: COIN_DROP_INTERVAL * WORLD_CELLS,
      coinRadius: COIN_RADIUS,
      worldWidth: WORLD_WIDTH,
      worldHeight: WORLD_HEIGHT,
      worldUpdateInterval: WORLD_UPDATE_INTERVAL,
      playerMoveSpeed: PLAYER_MOVE_SPEED
    });
    pendingCellDataUpdates[cellIndex] = {};
    channelGrid.watchCellAtIndex(CHANNEL_INBOUND_CELL_PROCESSING, cellIndex, gridCellDataHandler.bind(null, cellIndex));
    channelGrid.watchCellAtIndex(CHANNEL_CELL_TRANSITION, cellIndex, gridCellTransitionHandler.bind(null, cellIndex));
  }

  function forEachStateInDataTree(dataTree, callback) {
    var typeList = Object.keys(dataTree);

    typeList.forEach(function (type) {
      var stateList = dataTree[type];
      var ids = Object.keys(stateList);

      ids.forEach(function (id) {
        callback(stateList[id]);
      });
    });
  }

  function dispatchProcessedData(cellIndex) {
    var currentCellData = cellData[cellIndex];
    var workerStateRefList = {};
    var statesForNearbyCells = {};

    forEachStateInDataTree(currentCellData, function (state) {
      var id = state.id;
      var swid = state.swid;
      var type = state.type;

      if (state.op) {
        delete state.op;
      }
      if (state.isFresh) {
        delete state.isFresh;
      }

      var stateOwnerCellIndex = channelGrid.getCellIndex(state);
      var nearbyCellIndexes = channelGrid.getAllCellIndexes(state);

      if (stateOwnerCellIndex == cellIndex) {
        nearbyCellIndexes.forEach(function (nearbyCellIndex) {
          if (nearbyCellIndex != cellIndex) {
            if (!statesForNearbyCells[nearbyCellIndex]) {
              statesForNearbyCells[nearbyCellIndex] = [];
            }
            statesForNearbyCells[nearbyCellIndex].push(state);
          }
        });
      }
      var hasChangedOwnerCells = (state.clid != stateOwnerCellIndex);
      state.clid = stateOwnerCellIndex;
      if (hasChangedOwnerCells && swid) {
        if (!workerStateRefList[swid]) {
          workerStateRefList[swid] = [];
        }
        var stateRef = {
          id: state.id,
          swid: state.swid,
          clid: state.clid,
          type: state.type
        };
        if (state.delete) {
          stateRef.delete = state.delete;
        }
        workerStateRefList[swid].push(stateRef);
      }

      var currentCellIsNearby = false;
      nearbyCellIndexes.forEach(function (nearbyCellIndex) {
        if (nearbyCellIndex == cellIndex) {
          currentCellIsNearby = true;
        }
      });

      if (!currentCellIsNearby) {
        delete currentCellData[type][id];
      }
      if (state.delete) {
        delete state.delete;
      }
    });

    var workerCellTransferIds = Object.keys(workerStateRefList);
    workerCellTransferIds.forEach(function (swid) {
      scServer.exchange.publish('internal/input-cell-transition/' + swid, workerStateRefList[swid]);
    });

    // Pass states off to adjacent cells as they move across grid cells.
    var allNearbyCellIndexes = Object.keys(statesForNearbyCells);
    allNearbyCellIndexes.forEach(function (nearbyCellIndex) {
      channelGrid.publishToCells(CHANNEL_CELL_TRANSITION, statesForNearbyCells[nearbyCellIndex], [nearbyCellIndex]);
    });
  }

  function gridCellTransitionHandler(cellIndex, stateList) {
    var pendingCellData = pendingCellDataUpdates[cellIndex];
    var currentCellData = cellData[cellIndex];
    stateList.forEach(function (state) {
      var type = state.type;
      if (!pendingCellData[type]) {
        pendingCellData[type] = {};
      }
      pendingCellData[type][state.id] = state;
    });
  }

  // Here we handle and prepare data for a single cell within our game grid to be
  // processed by our cell controller.
  function gridCellDataHandler(cellIndex, stateList) {
    var currentCellData = cellData[cellIndex];
    var pendingCellData = pendingCellDataUpdates[cellIndex];

    Object.keys(pendingCellData).forEach(function (type) {
      if (!currentCellData[type]) {
        currentCellData[type] = {};
      }
      Object.keys(pendingCellData[type]).forEach(function (id) {
        currentCellData[type][id] = pendingCellData[type][id];
      });
    });

    stateList.forEach(function (state) {
      var id = state.id;
      var type = state.type;

      if (!currentCellData[type]) {
        currentCellData[type] = {};
      }

      if (!currentCellData[type][id]) {
        if (state.create) {
          // If is a stateRef
          currentCellData[type][id] = state.create;
        } else if (state.x != null && state.y != null) {
          // If we have x and y properties, then we know that
          // this is a full state.
          currentCellData[type][id] = state;
        }
      }
      var cachedState = currentCellData[type][id];
      if (cachedState) {
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
      }
    });

    cellControllers[cellIndex].run(currentCellData, dispatchProcessedData.bind(null, cellIndex));
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
          if (targetCellIndex == cellIndex) {
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


  scServer.exchange.subscribe('internal/input-cell-transition/' + serverWorkerId)
  .watch(function (stateList) {
    stateList.forEach(function (state) {
      game.stateRefs[state.id] = state;
    });
  });

  // This is the main input loop which feeds states into various cells
  // based on their (x, y) coordinates.
  function processInputStates() {
    var stateList = [];
    var stateIds = Object.keys(game.stateRefs);

    stateIds.forEach(function (id) {
      var state = game.stateRefs[id];
      stateList.push(state);
    });

    // Publish to internal channel for processing (e.g. Collision
    // detection and resolution, scoring, etc...)
    // These states will be processed by various cell controllers depending
    // on each state's cell index (clid) within the world grid.
    channelGrid.publish(CHANNEL_INBOUND_CELL_PROCESSING, stateList, {useClid: true});

    stateList.forEach(function (state) {
      if (state.op) {
        delete state.op;
      }
      if (state.delete) {
        delete game.stateRefs[state.id];
      }
    });
  }

  setInterval(processInputStates, WORLD_UPDATE_INTERVAL);

  var botsPerWorker = Math.round(BOT_COUNT / worker.options.workers);
  for (var b = 0; b < botsPerWorker; b++) {
    botManager.addBot();
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
