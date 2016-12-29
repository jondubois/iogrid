var fs = require('fs');
var _ = require('lodash');
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
var WORLD_HEIGHT = 2000;

// Dividing the world into vertical or horizontal strips (instead of cells)
// is more efficient.
var WORLD_CELL_WIDTH = 500;
var WORLD_CELL_HEIGHT = 2000;
var WORLD_COLS = Math.ceil(WORLD_WIDTH / WORLD_CELL_WIDTH);
var WORLD_ROWS = Math.ceil(WORLD_HEIGHT / WORLD_CELL_HEIGHT);
var WORLD_CELLS = WORLD_COLS * WORLD_ROWS;

/*
  This allows players/states from two different cells on the grid to
  interact with one another.
  States from different cells will show un in your cell controller but will have a
  special 'external' property set to true.
  This represents the maximum distance that two states can be from one another if they
  are in different cells and need to interact with one another.
  A smaller value is more efficient. Since this overlap area requires coordination
  between multiple cells.
*/
var WORLD_CELL_OVERLAP_DISTANCE = 150;
var WORLD_UPDATE_INTERVAL = 20;

// Delete states which have gone stale (not being updated anymore).
var WORLD_STALE_TIMEOUT = 1000;

// Coins don't move, so we will only refresh them
// once per second.
var SPECIAL_UPDATE_INTERVALS = {
  1000: ['coin']
};

var PLAYER_MOVE_SPEED = 10;
var PLAYER_DIAMETER = 100;
var PLAYER_MASS = 20;

// Note that the number of bots needs to be either 0 or a multiple of the number of
// worker processes or else it will get rounded up/down.
var BOT_COUNT = 20;
var BOT_MOVE_SPEED = 10;
var BOT_MASS = 10;
var BOT_COLOR = 1000;
var BOT_DIAMETER = 100;
var BOT_CHANGE_DIRECTION_PROBABILITY = 0.01;

var COIN_UPDATE_INTERVAL = 1000;
var COIN_DROP_INTERVAL = 500;
var COIN_RADIUS = 12;
var COIN_MAX_COUNT = 200;
var COIN_PLAYER_NO_DROP_RADIUS = 80;

var privateProps = {
  ccid: true,
  tcid: true,
  mass: true,
  speed: true,
  changeDirProb: true,
  repeatOp: true,
  swid: true,
  processed: true,
  groupWith: true,
  ungroupFrom: true,
  groupMates: true,
  external: true
};

function genericStateTransformer(state) {
  var clone = {};
  Object.keys(state).forEach(function (key) {
    if (!privateProps[key]) {
      clone[key] = state[key];
    }
  });
  return clone;
};

var OUTBOUND_STATE_TRANSFORMERS = {
  coin: genericStateTransformer,
  player: genericStateTransformer
};

var CHANNEL_INBOUND_CELL_PROCESSING = 'internal/cell-processing-inbound';
var CHANNEL_CELL_TRANSITION = 'internal/cell-transition';
var CHANNEL_CELL_TRANSITION_ACK = 'internal/cell-transition-ack';

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
  // We should probably make our own codec (on top of scCodecMinBin) to compress
  // world-specific entities. For example, instead of emitting the JSON:
  // {id: '...', width: 200, height: 200, color: 1000}
  // We could compress it down to something like: {id: '...', w: 200, h: 200, c: 1000}
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
  // It handles most of the data distribution automatically so that it reaches
  // the intended cells.
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
    botColor: BOT_COLOR,
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
  var cellPendingDeletes = {};
  var cellExternalStates = {};

  var cellControllers = {};
  var updateIntervals = {};
  var cellSpecialIntervalTypes = {};

  for (var h = 0; h < cellsPerWorker; h++) {
    var cellIndex = worker.id + h * worker.options.workers;
    cellData[cellIndex] = {};
    cellPendingDeletes[cellIndex] = {};
    cellExternalStates[cellIndex] = {};

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

    channelGrid.watchCellAtIndex(CHANNEL_INBOUND_CELL_PROCESSING, cellIndex, gridCellDataHandler.bind(null, cellIndex));
    channelGrid.watchCellAtIndex(CHANNEL_CELL_TRANSITION, cellIndex, gridCellTransitionHandler.bind(null, cellIndex));
    channelGrid.watchCellAtIndex(CHANNEL_CELL_TRANSITION_ACK, cellIndex, gridCellTransitionAckHandler.bind(null, cellIndex));
  }

  function applyOutboundStateTransformer(state) {
    var type = state.type;
    if (OUTBOUND_STATE_TRANSFORMERS[type]) {
      return OUTBOUND_STATE_TRANSFORMERS[type](state);
    }
    return state;
  }

  function setUpdateIntervals(intervalMap) {
    Object.keys(intervalMap).forEach(function (interval) {
      var intervalNumber = parseInt(interval);

      intervalMap[interval].forEach(function (type) {
        cellSpecialIntervalTypes[type] = true;
      });

      updateIntervals[interval] = setInterval(function () {
        var transformedStateList = [];

        Object.keys(cellData).forEach(function (cellIndex) {
          var currentCellData = cellData[cellIndex];

          intervalMap[interval].forEach(function (type) {
            Object.keys(currentCellData[type] || {}).forEach(function (id) {
              transformedStateList.push(
                applyOutboundStateTransformer(currentCellData[type][id])
              );
            });
          });
        });
        // External channel which clients can subscribe to.
        // It will publish to multiple channels based on each state's
        // (x, y) coordinates.
        if (transformedStateList.length) {
          channelGrid.publish('cell-data', transformedStateList);
        }
      }, intervalNumber);
    });
  }

  setUpdateIntervals(SPECIAL_UPDATE_INTERVALS);

  function getSimplifiedState(state) {
    return {
      type: state.type,
      x: Math.round(state.x),
      y: Math.round(state.y)
    };
  }

  function getGroupLeader(group) {
    group.members.sort(function (a, b) {
      if (a.id > b.id) {
        return 1;
      }
      if (a.id < b.id) {
        return -1;
      }
      return 0;
    });
    return group.members[0];
  }

  function getStateGroups() {
    var groupMap = {};
    Object.keys(cellData).forEach(function (cellIndex) {
      if (!groupMap[cellIndex]) {
        groupMap[cellIndex] = {};
      }
      var currentCellData = cellData[cellIndex];
      var currentGroupMap = groupMap[cellIndex];
      Object.keys(currentCellData).forEach(function (type) {
        var cellDataStates = currentCellData[type] || {};
        Object.keys(cellDataStates).forEach(function (id) {
          var state = cellDataStates[id];
          if (state.groupMates) {
            var groupStateMap = {};
            Object.keys(state.groupMates).forEach(function (stateId) {
              groupStateMap[stateId] = state.groupMates[stateId];
            });
            groupStateMap[state.id] = getSimplifiedState(state);

            var groupStateIdList = Object.keys(groupStateMap).sort();
            var groupId = groupStateIdList.join(',');

            var group = {
              id: groupId,
              members: [],
              size: 0,
              x: 0,
              y: 0,
            };
            var allGroupMembersAreAvailableToThisCell = true;
            var expectedMemberCount = groupStateIdList.length;

            var cellIndexLookup = {};

            for (var i = 0; i < expectedMemberCount; i++) {
              var memberId = groupStateIdList[i];
              var memberPartialState = groupStateMap[memberId];
              var memberState = currentCellData[memberPartialState.type][memberId];
              if (memberState) {
                var memberStateClone = _.cloneDeep(memberState);
                memberStateClone.x = memberPartialState.x;
                memberStateClone.y = memberPartialState.y;
                group.members.push(memberStateClone);
                group.size++;
                group.x += memberStateClone.x;
                group.y += memberStateClone.y;
                if (!cellIndexLookup[memberState.tcid]) {
                  cellIndexLookup[memberState.tcid] = 1;
                }
              } else {
                allGroupMembersAreAvailableToThisCell = false;
                break;
              }
            }
            var existingGroup = currentGroupMap[groupId];
            if (allGroupMembersAreAvailableToThisCell && !existingGroup) {

              group.x = Math.round(group.x / group.size);
              group.y = Math.round(group.y / group.size);
              var leader = getGroupLeader(group);
              group.tcid = leader.tcid;
              currentGroupMap[groupId] = group;
            }
          }
        });
      });
    });
    return groupMap;
  }

  function prepareStatesForProcessing(cellIndex) {
    var currentCellData = cellData[cellIndex];
    var currentCellExternalStates = cellExternalStates[cellIndex];

    Object.keys(currentCellData).forEach(function (type) {
      var cellDataStates = currentCellData[type] || {};
      Object.keys(cellDataStates).forEach(function (id) {
        var state = cellDataStates[id];
        var type = state.type;
        var id = state.id;
        state.groupWith = function (partnerState) {
          if (!state.groupMates) {
            state.groupMates = {};
          }
          var stateClone = getSimplifiedState(state);
          var partnerClone = getSimplifiedState(partnerState);

          state.groupMates[partnerState.id] = partnerClone;
          if (!partnerState.groupMates) {
            partnerState.groupMates = {};
          }
          partnerState.groupMates[id] = stateClone;
        };
        state.ungroupFrom = function (partnerState) {
          delete state.groupMates[partnerState.id];
          if (partnerState.groupMates) {
            delete partnerState.groupMates[id];
          }
        };
        if (state.external) {
          if (!currentCellExternalStates[type]) {
            currentCellExternalStates[type] = {};
          }
          currentCellExternalStates[type][id] = _.cloneDeep(state);
        }
      });
    });
  }

  // We should never modify states which belong to other cells or
  // else it will result in conflicts and lost states. This function
  // restores them to their pre-processed condition.
  function restoreExternalStatesAfterProcessing(cellIndex) {
    var currentCellData = cellData[cellIndex];
    var currentCellExternalStates = cellExternalStates[cellIndex];

    Object.keys(currentCellData).forEach(function (type) {
      var cellDataStates = currentCellData[type] || {};
      Object.keys(cellDataStates).forEach(function (id) {
        if (currentCellExternalStates[type] && currentCellExternalStates[type][id]) {
          cellDataStates[id] = currentCellExternalStates[type][id];
          delete currentCellExternalStates[type][id];
        }
      });
    });
  }

  // Remove decorator functions which were added to the states temporarily
  // for use within the cell controller.
  function cleanupStatesAfterProcessing(cellIndex) {
    var currentCellData = cellData[cellIndex];

    Object.keys(currentCellData).forEach(function (type) {
      var cellDataStates = currentCellData[type] || {};
      Object.keys(cellDataStates).forEach(function (id) {
        var state = cellDataStates[id];
        delete state.groupWith;
        delete state.ungroupFrom;
        delete state.groupMates;
        if (state.op) {
          delete state.op;
        }
      });
    });
  }

  // Main world update loop.
  setInterval(function () {
    var cellIndexList = Object.keys(cellData);
    var transformedStateList = [];

    cellIndexList.forEach(function (cellIndex) {
      prepareStatesForProcessing(cellIndex);
      cellControllers[cellIndex].run(cellData[cellIndex]);
      restoreExternalStatesAfterProcessing(cellIndex);
      dispatchProcessedData(cellIndex);
    });

    var groupMap = getStateGroups();

    cellIndexList.forEach(function (cellIndex) {
      var currentCellData = cellData[cellIndex];
      Object.keys(currentCellData).forEach(function (type) {
        if (!cellSpecialIntervalTypes[type]) {
          var cellDataStates = currentCellData[type] || {};
          Object.keys(cellDataStates).forEach(function (id) {
            var state = cellDataStates[id];
            if (!state.groupMates && !state.external &&
              (!cellPendingDeletes[cellIndex][type] || !cellPendingDeletes[cellIndex][type][id])) {

              transformedStateList.push(
                applyOutboundStateTransformer(state)
              );
            }
          });
        }
      });
    });

    // Deletions are processed as part of WORLD_UPDATE_INTERVAL even if
    // that type has its own special interval.
    Object.keys(cellPendingDeletes).forEach(function (cellIndex) {
      var currentCellDeletes = cellPendingDeletes[cellIndex];
      Object.keys(currentCellDeletes).forEach(function (type) {
        var cellDeleteStates = currentCellDeletes[type] || {};
        Object.keys(cellDeleteStates).forEach(function (id) {
          // These states should already have a delete property which
          // can be used on the client-side to delete items from the view.
          transformedStateList.push(
            applyOutboundStateTransformer(cellDeleteStates[id])
          );
          delete cellDeleteStates[id];
        });
      });
    });

    Object.keys(groupMap).forEach(function (cellIndex) {
      var currentGroupMap = groupMap[cellIndex];
      Object.keys(currentGroupMap).forEach(function (groupId) {
        var group = currentGroupMap[groupId];
        var memberList = group.members;
        if (group.tcid == cellIndex) {
          memberList.forEach(function (member) {
            transformedStateList.push(
              applyOutboundStateTransformer(member)
            );
          });
        }
      });
    });

    cellIndexList.forEach(function (cellIndex) {
      cleanupStatesAfterProcessing(cellIndex);
    });

    // External channel which clients can subscribe to.
    // It will publish to multiple channels based on each state's
    // (x, y) coordinates.
    if (transformedStateList.length) {
      channelGrid.publish('cell-data', transformedStateList);
    }

  }, WORLD_UPDATE_INTERVAL);

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

  function updateStateExternalTag(state, cellIndex) {
    if (state.ccid != cellIndex || state.tcid != cellIndex) {
      state.external = true;
    } else {
      delete state.external;
    }
  }

  // Share states with adjacent cells when those states get near
  // other cells' boundaries and prepare for transition to other cells.
  function dispatchProcessedData(cellIndex) {
    var currentCellData = cellData[cellIndex];
    var workerStateRefList = {};
    var statesForNearbyCells = {};

    forEachStateInDataTree(currentCellData, function (state) {
      var id = state.id;
      var swid = state.swid;
      var type = state.type;

      // The target cell id
      state.tcid = channelGrid.getCellIndex(state);
      updateStateExternalTag(state, cellIndex);

      if (state.ccid == cellIndex) {
        var nearbyCellIndexes = channelGrid.getAllCellIndexes(state);
        nearbyCellIndexes.forEach(function (nearbyCellIndex) {
          if (nearbyCellIndex != state.ccid && nearbyCellIndex != state.tcid) {
            if (!statesForNearbyCells[nearbyCellIndex]) {
              statesForNearbyCells[nearbyCellIndex] = [];
            }
            statesForNearbyCells[nearbyCellIndex].push(state);
          }
        });
      }

      if (state.ccid != state.tcid) {
        if (!statesForNearbyCells[state.tcid]) {
          statesForNearbyCells[state.tcid] = [];
        }
        statesForNearbyCells[state.tcid].push(state);
        if (swid) {
          if (!workerStateRefList[swid]) {
            workerStateRefList[swid] = [];
          }
          var stateRef = {
            id: state.id,
            swid: state.swid,
            tcid: state.tcid,
            type: state.type
          };

          if (state.delete) {
            stateRef.delete = state.delete;
          }
          workerStateRefList[swid].push(stateRef);
        }
      }

      if (state.delete) {
        if (!cellPendingDeletes[cellIndex][type]) {
          cellPendingDeletes[cellIndex][type] = {};
        }
        cellPendingDeletes[cellIndex][type][id] = state;
        delete currentCellData[type][id];
      } else if (state.external && Date.now() - state.processed > WORLD_STALE_TIMEOUT) {
        delete currentCellData[type][id];
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

  function gridCellTransitionAckHandler(cellIndex, stateList) {
    var currentCellData = cellData[cellIndex];
    stateList.forEach(function (state) {
      var type = state.type;
      var id = state.id;

      if (currentCellData[type] && currentCellData[type][id]) {
        state.processed = Date.now();
        updateStateExternalTag(state, cellIndex);
        currentCellData[type][id] = state;
      }
    });
  }

  // Receive states which are in other cells and *may* transition to this cell later.
  // We don't manage these states, we just keep a copy so that they are visible
  // inside our cellController (cell.js) - This allows states to interact across
  // cell partitions (which may be hosted on a different process/CPU core).
  function gridCellTransitionHandler(cellIndex, stateList) {
    var currentCellData = cellData[cellIndex];
    var transitionAckMap = {};
    var newlyAcceptedStates = [];

    stateList.forEach(function (state) {
      var type = state.type;
      var id = state.id;
      state.processed = Date.now();

      if (!currentCellData[type]) {
        currentCellData[type] = {};
      }
      var existingState = currentCellData[type][id];

      if (state.tcid == cellIndex) {
        // Previous cell id.
        state.pcid = state.ccid;
        // This is a full transition to our current cell.
        state.ccid = cellIndex;
        currentCellData[type][id] = state;
        newlyAcceptedStates.push(state);
      } else {
        // This is just external state for us to track but not
        // a complete transition, the state will still be managed by
        // a different cell.
        if (!existingState || existingState.external) {
          currentCellData[type][id] = state;
        }
      }
      updateStateExternalTag(state, cellIndex);
    });

    newlyAcceptedStates.forEach(function (state) {
      var pcid = state.pcid;
      if (!transitionAckMap[pcid]) {
        transitionAckMap[pcid] = [];
      }
      delete state.pcid;
      transitionAckMap[pcid].push(state);
    });
    Object.keys(transitionAckMap).forEach(function (ackCellIndex) {
      channelGrid.publishToCells(CHANNEL_CELL_TRANSITION_ACK, transitionAckMap[ackCellIndex], [ackCellIndex]);
    });
  }

  // Here we handle and prepare data for a single cell within our game grid to be
  // processed by our cell controller.
  function gridCellDataHandler(cellIndex, stateList) {
    var currentCellData = cellData[cellIndex];

    stateList.forEach(function (stateRef) {
      var id = stateRef.id;
      var type = stateRef.type;

      if (!currentCellData[type]) {
        currentCellData[type] = {};
      }

      if (!currentCellData[type][id]) {
        if (stateRef.create) {
          // If is a stateRef
          var state = stateRef.create;
          state.ccid = cellIndex;
          currentCellData[type][id] = state;
        } else if (stateRef.x != null && stateRef.y != null) {
          // If we have x and y properties, then we know that
          // this is a full state.
          currentCellData[type][id] = stateRef;
        }
      }
      var cachedState = currentCellData[type][id];
      if (cachedState) {
        if (stateRef.op) {
          cachedState.op = stateRef.op;
        }
        if (stateRef.delete) {
          cachedState.delete = stateRef.delete;
        }
        if (stateRef.data) {
          cachedState.data = stateRef.data;
        }
        cachedState.tcid = channelGrid.getCellIndex(cachedState);
        updateStateExternalTag(cachedState, cellIndex);
        cachedState.processed = Date.now();
      }
    });
  }

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

    // Publish to internal channels for processing (e.g. Collision
    // detection and resolution, scoring, etc...)
    // These states will be processed by a cell controllers depending
    // on each state's target cell index (tcid) within the world grid.
    var gridPublishOptions = {
      cellIndexesFactory: function (state) {
        return [state.tcid];
      }
    };
    channelGrid.publish(CHANNEL_INBOUND_CELL_PROCESSING, stateList, gridPublishOptions);

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
        score: 0
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
