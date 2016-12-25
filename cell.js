/*
  Note that the main run() loop will be executed every time a new set of state data needs to be processed
  by our cell controller.
  Because this system is distributed, you cannot know the frequency and ordering of data updates.
  The run() function will be executed based on system demand.
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
*/

var rbush = require('rbush');
var SAT = require('sat');
var CoinManager = require('./coin-manager').CoinManager;

var STALE_TIMEOUT = 1000;

// This controller will be instantiated once for each
// cell in our world grid.

var CellController = function (options) {
  this.options = options;
  this.coinManager = new CoinManager({
    cellData: options.cellData,
    cellBounds: options.cellBounds,
    playerNoDropRadius: options.coinPlayerNoDropRadius,
    coinMaxCount: options.coinMaxCount,
    coinDropInterval: options.coinDropInterval,
    coinRadius: options.coinRadius
  });
  this.lastCoinDrop = 0;
  this.lastBotMove = 0;
  this.botMoves = [
    {u: 1},
    {d: 1},
    {r: 1},
    {l: 1}
  ];
};

/*
  The main run loop for our cell controller.
*/
CellController.prototype.run = function (cellData, done) {
  if (!cellData.player) {
    cellData.player = {};
  }
  if (!cellData.coin) {
    cellData.coin = {};
  }
  var players = cellData.player;
  var coins = cellData.coin;

  this.removeStalePlayers(players);
  this.findPlayerOverlaps(players, coins);
  this.dropCoins(coins);
  this.generateBotOps(players);
  this.applyPlayerOps(players, coins);

  done();
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

CellController.prototype.generateBotOps = function (players, coins) {
  var self = this;
  var now = Date.now();

  if (now - self.lastBotMove >= self.options.worldUpdateInterval) {
    self.lastBotMove = now;
    Object.keys(players).forEach(function (playerId) {
      var player = players[playerId];
      if (player.subtype == 'bot') {
        var radius = Math.round(player.width / 2)
        var isBotOnEdge = player.x <= radius || player.x >= self.options.worldWidth - radius ||
          player.y <= radius || player.y >= self.options.worldHeight - radius;

        if (Math.random() <= player.changeDirProb || isBotOnEdge) {
          var randIndex = Math.floor(Math.random() * 4);
          player.repeatOp = self.botMoves[randIndex];
        }
        if (player.repeatOp) {
          player.op = player.repeatOp;
        }
      }
    });
  }
};

CellController.prototype.applyPlayerOps = function (players, coins) {
  var self = this;

  var playerIds = Object.keys(players);
  playerIds.forEach(function (playerId) {
    var player = players[playerId];

    // The isFresh property tells us whether or not this
    // state was updated in this iteration of the cell controller.
    // If it hasn't been updated in this iteration, then we don't need
    // to process it again.
    if (player.isFresh) {
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
          delete coins[coin.id];
        }
      });
      delete player.coinOverlaps;
    }
  });
};

CellController.prototype.removeStalePlayers = function (players) {
  var playerIds = Object.keys(players);
  playerIds.forEach(function (playerId) {
    var player = players[playerId];
    if (player.delete || Date.now() - player.processed > STALE_TIMEOUT) {
      delete players[playerId];
    }
  });
};

CellController.prototype.findPlayerOverlaps = function (players, coins) {
  var self = this;

  var playerIds = Object.keys(players);
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
  }
};

module.exports = CellController;
