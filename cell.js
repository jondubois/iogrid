/*
  Note that the main run() loop will be executed once per frame as specified by WORLD_UPDATE_INTERVAL in worker.js.
  Behind the scenes, the engine just keeps on building up a cellData tree of all different
  state objects that are present within our current grid cell.
  The tree is a simple JSON object and needs to be in the format:

    {
      // player is a state type.
      player: {
        // ...
      },
      // You can add other custom state types.
      someType: {
        // Use the id as the key (in the place of someId).
        // It is recommended that you use a random uuid as the state id. See https://www.npmjs.com/package/uuid
        someId: {
          // All properties listed here are required.
          // You can add additional ones.
          id: someId,
          type: someType,
          x: someXCoordinate,
          y: someYCoordinate,
        },
        anotherId: {
          // ...
        }
      }
    }

  You can add new type subtrees, new states and new properties to the cellData
  as you like. So long as you follow the structure above, the items will show
  up on the front end in the relevant cell in our world (see the handleCellData function in index.html).

  Adding new items to the cell is easy.
  For example, to add a new coin to the cell, you just need to add a state object to the coin subtree (E.g):
  cellData.coin[coin.id] = coin;

  See how coinManager.addCoin is used below (and how it's implemented) for more details.

  Note that states which are close to our current cell (based on WORLD_CELL_OVERLAP_DISTANCE)
  but not exactly inside it will still be visible within this cell (they will have an additional
  'external' property set to true).

  External states should not be modified because they belong to a different cell and the change will be ignored.
*/

var _ = require('lodash');
var rbush = require('rbush');
var SAT = require('sat');
var config = require('./config');
var BotManager = require('./bot-manager').BotManager;
var CoinManager = require('./coin-manager').CoinManager;

// This controller will be instantiated once for each
// cell in our world grid.

var CellController = function (options, util) {
  var self = this;

  this.options = options;
  this.cellIndex = options.cellIndex;
  this.util = util;

  // You can use the exchange object to publish data to global channels which you
  // can watch on the front end (in index.html).
  // The API for the exchange object is here: http://socketcluster.io/#!/docs/api-exchange
  // To receive channel data on the front end, you can read about the subscribe and watch
  // functions here: http://socketcluster.io/#!/docs/basic-usage
  this.exchange = options.worker.exchange;

  this.worldColCount = Math.ceil(config.WORLD_WIDTH / config.WORLD_CELL_WIDTH);
  this.worldRowCount = Math.ceil(config.WORLD_HEIGHT / config.WORLD_CELL_HEIGHT);
  this.worldCellCount = this.worldColCount * this.worldRowCount;
  this.workerCount = options.worker.options.workers;

  this.coinMaxCount = Math.round(config.COIN_MAX_COUNT / this.worldCellCount);
  this.coinDropInterval = config.COIN_DROP_INTERVAL * this.worldCellCount;
  this.botCount = Math.round(config.BOT_COUNT / this.worldCellCount);

  var cellData = options.cellData;

  this.botManager = new BotManager({
    worldWidth: config.WORLD_WIDTH,
    worldHeight: config.WORLD_HEIGHT,
    botDefaultDiameter: config.BOT_DEFAULT_DIAMETER,
    botMoveSpeed: config.BOT_MOVE_SPEED,
    botMass: config.BOT_MASS,
    botChangeDirectionProbability: config.BOT_CHANGE_DIRECTION_PROBABILITY
  });

  if (!cellData.player) {
    cellData.player = {};
  }

  for (var b = 0; b < this.botCount; b++) {
    var bot = this.botManager.addBot();
    cellData.player[bot.id] = bot;
  }

  this.botMoves = [
    {u: 1},
    {d: 1},
    {r: 1},
    {l: 1}
  ];

  this.coinManager = new CoinManager({
    cellData: options.cellData,
    cellBounds: options.cellBounds,
    playerNoDropRadius: config.COIN_PLAYER_NO_DROP_RADIUS,
    coinMaxCount: this.coinMaxCount,
    coinDropInterval: this.coinDropInterval
  });

  this.lastCoinDrop = 0;

  config.COIN_TYPES.sort(function (a, b) {
    if (a.probability < b.probability) {
      return -1;
    }
    if (a.probability > b.probability) {
      return 1;
    }
    return 0;
  });

  this.coinTypes = [];
  var probRangeStart = 0;
  config.COIN_TYPES.forEach(function (coinType) {
    var coinTypeClone = _.cloneDeep(coinType);
    coinTypeClone.prob = probRangeStart;
    self.coinTypes.push(coinTypeClone);
    probRangeStart += coinType.probability;
  });

  this.playerCompareFn = function (a, b) {
    if (a.id < b.id) {
      return -1;
    }
    if (a.id > b.id) {
      return 1;
    }
    return 0;
  };

  this.diagonalSpeedFactor = Math.sqrt(1 / 2);
};

/*
  The main run loop for our cell controller.
*/
CellController.prototype.run = function (cellData) {
  if (!cellData.player) {
    cellData.player = {};
  }
  if (!cellData.coin) {
    cellData.coin = {};
  }
  var players = cellData.player;
  var coins = cellData.coin;

  // Sorting is important to achieve consistency across cells.
  var playerIds = Object.keys(players).sort(this.playerCompareFn);

  this.findPlayerOverlaps(playerIds, players, coins);
  this.dropCoins(coins);
  this.generateBotOps(playerIds, players);
  this.applyPlayerOps(playerIds, players, coins);
};

CellController.prototype.dropCoins = function (coins) {
  var now = Date.now();

  if (now - this.lastCoinDrop >= this.coinManager.coinDropInterval &&
    this.coinManager.coinCount < this.coinManager.coinMaxCount) {

    this.lastCoinDrop = now;

    var rand = Math.random();
    var chosenCoinType;

    var numTypes = this.coinTypes.length;
    for (var i = numTypes - 1; i >= 0; i--) {
      var curCoinType = this.coinTypes[i];
      if (rand >= curCoinType.prob) {
        chosenCoinType = curCoinType;
        break;
      }
    }

    if (!chosenCoinType) {
      throw new Error('There is something wrong with the coin probability distribution. ' +
        'Check that probabilities add up to 1 in COIN_TYPES config option.');
    }

    var coin = this.coinManager.addCoin(chosenCoinType.value, chosenCoinType.type, chosenCoinType.radius);
    if (coin) {
      coins[coin.id] = coin;
    }
  }
};

CellController.prototype.generateBotOps = function (playerIds, players, coins) {
  var self = this;

  playerIds.forEach(function (playerId) {
    var player = players[playerId];
    // States which are external are managed by a different cell, therefore changes made to these
    // states are not saved unless they are grouped with one or more internal states from the current cell.
    // See util.groupStates() method near the bottom of this file for details.
    if (player.subtype == 'bot' && !player.external) {
      var radius = Math.round(player.diam / 2);
      var isBotOnEdge = player.x <= radius || player.x >= config.WORLD_WIDTH - radius ||
        player.y <= radius || player.y >= config.WORLD_HEIGHT - radius;

      if (Math.random() <= player.changeDirProb || isBotOnEdge) {
        var randIndex = Math.floor(Math.random() * self.botMoves.length);
        player.repeatOp = self.botMoves[randIndex];
      }
      if (player.repeatOp) {
        player.op = player.repeatOp;
      }
    }
  });
};

CellController.prototype.keepPlayerOnGrid = function (player) {
  var radius = Math.round(player.diam / 2);

  var leftX = player.x - radius;
  var rightX = player.x + radius;
  var topY = player.y - radius;
  var bottomY = player.y + radius;

  if (leftX < 0) {
    player.x = radius;
  } else if (rightX > config.WORLD_WIDTH) {
    player.x = config.WORLD_WIDTH - radius;
  }
  if (topY < 0) {
    player.y = radius;
  } else if (bottomY > config.WORLD_HEIGHT) {
    player.y = config.WORLD_HEIGHT - radius;
  }
};

CellController.prototype.applyPlayerOps = function (playerIds, players, coins) {
  var self = this;

  playerIds.forEach(function (playerId) {
    var player = players[playerId];

    var playerOp = player.op;
    var moveSpeed;
    if (player.subtype == 'bot') {
      moveSpeed = player.speed;
    } else {
      moveSpeed = config.PLAYER_DEFAULT_MOVE_SPEED;
    }

    if (playerOp) {
      var movementVector = {x: 0, y: 0};
      var movedHorizontally = false;
      var movedVertically = false;

      if (playerOp.u) {
        movementVector.y = -moveSpeed;
        player.direction = 'up';
        movedVertically = true;
      }
      if (playerOp.d) {
        movementVector.y = moveSpeed;
        player.direction = 'down';
        movedVertically = true;
      }
      if (playerOp.r) {
        movementVector.x = moveSpeed;
        player.direction = 'right';
        movedHorizontally = true;
      }
      if (playerOp.l) {
        movementVector.x = -moveSpeed;
        player.direction = 'left';
        movedHorizontally = true;
      }

      if (movedHorizontally && movedVertically) {
        movementVector.x *= self.diagonalSpeedFactor;
        movementVector.y *= self.diagonalSpeedFactor;
      }

      player.x += movementVector.x;
      player.y += movementVector.y;
    }

    if (player.playerOverlaps) {
      player.playerOverlaps.forEach(function (otherPlayer) {
        self.resolvePlayerCollision(player, otherPlayer);
        self.keepPlayerOnGrid(otherPlayer);
      });
      delete player.playerOverlaps;
    }

    if (player.coinOverlaps) {
      player.coinOverlaps.forEach(function (coin) {
        if (self.testCircleCollision(player, coin).collided) {
          player.score += coin.v;
          self.coinManager.removeCoin(coin.id);
        }
      });
      delete player.coinOverlaps;
    }

    self.keepPlayerOnGrid(player);
  });
};

CellController.prototype.findPlayerOverlaps = function (playerIds, players, coins) {
  var self = this;

  var playerTree = new rbush();
  var hitAreaList = [];

  playerIds.forEach(function (playerId) {
    var player = players[playerId];
    player.hitArea = self.generateHitArea(player);
    hitAreaList.push(player.hitArea);
  });

  playerTree.load(hitAreaList);

  playerIds.forEach(function (playerId) {
    var player = players[playerId];
    playerTree.remove(player.hitArea);
    var hitList = playerTree.search(player.hitArea);
    playerTree.insert(player.hitArea);

    hitList.forEach(function (hit) {
      if (!player.playerOverlaps) {
        player.playerOverlaps = [];
      }
      player.playerOverlaps.push(hit.target);
    });
  });

  var coinIds = Object.keys(coins);
  coinIds.forEach(function (coinId) {
    var coin = coins[coinId];
    var coinHitArea = self.generateHitArea(coin);
    var hitList = playerTree.search(coinHitArea);

    if (hitList.length) {
      // If multiple players hit the coin, give it to a random one.
      var randomIndex = Math.floor(Math.random() * hitList.length);
      var coinWinner = hitList[randomIndex].target;

      if (!coinWinner.coinOverlaps) {
        coinWinner.coinOverlaps = [];
      }
      coinWinner.coinOverlaps.push(coin);
    }
  });

  playerIds.forEach(function (playerId) {
    delete players[playerId].hitArea;
  });
};

CellController.prototype.generateHitArea = function (target) {
  var targetRadius = target.r || Math.round(target.diam / 2);
  return {
    target: target,
    minX: target.x - targetRadius,
    minY: target.y - targetRadius,
    maxX: target.x + targetRadius,
    maxY: target.y + targetRadius
  };
};

CellController.prototype.testCircleCollision = function (a, b) {
  var radiusA = a.r || Math.round(a.diam / 2);
  var radiusB = b.r || Math.round(b.diam / 2);

  var circleA = new SAT.Circle(new SAT.Vector(a.x, a.y), radiusA);
  var circleB = new SAT.Circle(new SAT.Vector(b.x, b.y), radiusB);

  var response = new SAT.Response();
  var collided = SAT.testCircleCircle(circleA, circleB, response);

  return {
    collided: collided,
    overlapV: response.overlapV
  };
};

CellController.prototype.resolvePlayerCollision = function (player, otherPlayer) {
  var result = this.testCircleCollision(player, otherPlayer);

  if (result.collided) {
    var olv = result.overlapV;

    var totalMass = player.mass + otherPlayer.mass;
    var playerBuff = player.mass / totalMass;
    var otherPlayerBuff = otherPlayer.mass / totalMass;

    player.x -= olv.x * otherPlayerBuff;
    player.y -= olv.y * otherPlayerBuff;
    otherPlayer.x += olv.x * playerBuff;
    otherPlayer.y += olv.y * playerBuff;

    /*
      Whenever we have one state affecting the (x, y) coordinates of
      another state, we should group them together using the util.groupStates() function.
      Otherwise we will may get flicker when the two states interact across
      a cell boundary.
      In this case, if we don't use groupStates(), there will be flickering when you
      try to push another player across to a different cell.
    */
    this.util.groupStates([player, otherPlayer]);
  }
};

module.exports = CellController;
