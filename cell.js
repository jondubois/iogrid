/*
  Note that the main run() loop will be executed once per frame as specified by WORLD_UPDATE_INTERVAL in worker.js.
  Behind the scenes, the engine just keeps on building up a cellData tree of all different
  state objects that are present within our current grid cell.
  The tree is a simple JSON object and needs to be in the format:

    {
      player: {
        // ...
      },
      someType: {
        someId: {
          // All properties listed here are required.
          // You can add additional ones.
          id: theValueOfSomeId,
          type: theValueOfSomeType,
          x: someXCoordinateWithinOurCurrentCell,
          y: someYCoordinateWithinOurCurrentCell,
        },
        anotherId: {
          // ...
        }
      }
    }

  You can add new type structures, new properties and new items to the cellData
  as you like. So long as you follow the structure above, the items should show
  up on the front end in the relevant cell in our world (see the handleCellData function in index.html).
  See how CoinManager was implemented for details of how to add items within the cell.

  Note that states which are close to our current cell (based on WORLD_CELL_OVERLAP_DISTANCE)
  but not exactly inside it will still be visible within this cell (they will have an additional
  'external' property set to true).

  External states should not be modified unless they are grouped together with an internal state.
  See the groupWith() function near the bottom of this file for details.
*/

var rbush = require('rbush');
var SAT = require('sat');
var CoinManager = require('./coin-manager').CoinManager;

// This controller will be instantiated once for each
// cell in our world grid.

var CellController = function (options) {
  this.options = options;
  this.cellIndex = options.cellIndex;
  this.coinManager = new CoinManager({
    cellData: options.cellData,
    cellBounds: options.cellBounds,
    playerNoDropRadius: options.coinPlayerNoDropRadius,
    coinMaxCount: options.coinMaxCount,
    coinDropInterval: options.coinDropInterval,
    coinRadius: options.coinRadius
  });
  this.lastCoinDrop = 0;
  this.botMoves = [
    {u: 1},
    {d: 1},
    {r: 1},
    {l: 1}
  ];
  this.playerCompareFn = function (a, b) {
    if (a.id < b.id) {
      return -1;
    }
    if (a.id > b.id) {
      return 1;
    }
    return 0;
  };
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
    // Add a coin with a score value of 1 and radius of 12 pixels.
    var coin = this.coinManager.addCoin(1, 12);
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
    // See groupWith() method near the bottom of this file foe details.
    if (player.subtype == 'bot' && !player.external) {
      var radius = Math.round(player.width / 2);
      var isBotOnEdge = player.x <= radius || player.x >= self.options.worldWidth - radius ||
        player.y <= radius || player.y >= self.options.worldHeight - radius;

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

CellController.prototype.applyPlayerOps = function (playerIds, players, coins) {
  var self = this;

  playerIds.forEach(function (playerId) {
    var player = players[playerId];

    var playerOp = player.op;
    var moveSpeed;
    if (player.subtype == 'bot') {
      moveSpeed = player.speed;
    } else {
      moveSpeed = self.options.playerMoveSpeed;
    }

    if (playerOp) {
      var movementVector = {x: 0, y: 0};

      if (playerOp.u) {
        movementVector.y = -moveSpeed;
      }
      if (playerOp.d) {
        movementVector.y = moveSpeed;
      }
      if (playerOp.r) {
        movementVector.x = moveSpeed;
      }
      if (playerOp.l) {
        movementVector.x = -moveSpeed;
      }

      player.x += movementVector.x;
      player.y += movementVector.y;
    }

    var halfWidth = Math.round(player.width / 2);
    var halfHeight = Math.round(player.height / 2);

    var leftX = player.x - halfWidth;
    var rightX = player.x + halfWidth;
    var topY = player.y - halfHeight;
    var bottomY = player.y + halfHeight;

    if (leftX < 0) {
      player.x = halfWidth;
    } else if (rightX > self.options.worldWidth) {
      player.x = self.options.worldWidth - halfWidth;
    }
    if (topY < 0) {
      player.y = halfHeight;
    } else if (bottomY > self.options.worldHeight) {
      player.y = self.options.worldHeight - halfHeight;
    }

    if (player.playerOverlaps) {
      player.playerOverlaps.forEach(function (otherPlayer) {
        self.resolvePlayerCollision(player, otherPlayer);
      });
      delete player.playerOverlaps;
    }

    if (player.coinOverlaps) {
      player.coinOverlaps.forEach(function (coin) {
        if (self.testCircleCollision(player, coin).collided) {
          player.score += coin.v;
          // This will tell the engine to delete the coin
          // and will notify clients.
          coin.delete = 1;
        }
      });
      delete player.coinOverlaps;
    }
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
  var targetRadius = target.r || Math.round(target.width / 2);
  return {
    target: target,
    minX: target.x - targetRadius,
    minY: target.y - targetRadius,
    maxX: target.x + targetRadius,
    maxY: target.y + targetRadius
  };
};

CellController.prototype.testCircleCollision = function (a, b) {
  var radiusA = a.r || Math.round(a.width / 2);
  var radiusB = b.r || Math.round(b.width / 2);

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
      another state, we should group them together using the groupWith() method.
      Otherwise we will may get flicker when the two states interact across
      a cell boundary.
      In this case, if we don't use groupWith(), there will be flickering when you
      try to push another player across to a different cell.
    */
    player.groupWith(otherPlayer);
  }
};

module.exports = CellController;
