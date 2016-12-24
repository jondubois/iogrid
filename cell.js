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
};

/*
  The main run loop for our cell controller.
*/
CellController.prototype.run = function (cellData, done) {
  var players = cellData.player || {};
  var processedSubtree = {
    player: {},
    coin: {}
  };

  this.dropCoins(processedSubtree);
  this.removeStalePlayers(players, processedSubtree);
  this.findPlayerOverlaps(players, processedSubtree);
  this.applyPlayerOps(players, processedSubtree);

  done(processedSubtree);
};

var lastCoinDrop = 0;

CellController.prototype.dropCoins = function (processedSubtree) {
  var now = Date.now();

  if (now - lastCoinDrop >= this.coinManager.coinDropInterval &&
    this.coinManager.coinCount < this.coinManager.coinMaxCount) {

    lastCoinDrop = now;
    // Add a coin with a score value of 1 and radius of 12 pixels.
    var coin = this.coinManager.addCoin(1, 12);
    processedSubtree.coin[coin.id] = coin;
  }
}

CellController.prototype.applyPlayerOps = function (players, processedSubtree) {
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
      if (player.data) {
        if (player.data.score) {
          player.score = player.data.score;
        }
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

        processedSubtree.player[player.id] = player;
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

    if (player.overlaps) {
      player.overlaps.forEach(function (otherPlayer) {
        self.resolveCollision(player, otherPlayer, processedSubtree);
      });
      delete player.overlaps;
    }
  });
}

CellController.prototype.removeStalePlayers = function (players) {
  var playerIds = Object.keys(players);
  playerIds.forEach(function (playerId) {
    var player = players[playerId];
    if (player.delete || Date.now() - player.processed > STALE_TIMEOUT) {
      delete players[playerId];
    }
  });
}

CellController.prototype.findPlayerOverlaps = function (players) {
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
      if (!player.overlaps) {
        player.overlaps = [];
      }
      player.overlaps.push(hit.player);
    });
  });

  playerIds.forEach(function (playerId) {
    delete players[playerId].hitArea;
  });
}

CellController.prototype.generateHitArea = function (player) {
  var playerRadius = Math.round(player.width / 2);
  return {
    player: player,
    minX: player.x - playerRadius,
    minY: player.y - playerRadius,
    maxX: player.x + playerRadius,
    maxY: player.y + playerRadius
  };
}

CellController.prototype.resolveCollision = function (player, otherPlayer, processedSubtree) {
  var currentUser = new SAT.Circle(new SAT.Vector(player.x, player.y), Math.round(player.width / 2));
  var otherUser = new SAT.Circle(new SAT.Vector(otherPlayer.x, otherPlayer.y), Math.round(otherPlayer.width / 2));
  var response = new SAT.Response();
  var collided = SAT.testCircleCircle(currentUser, otherUser, response);

  if (collided) {
    var olv = response.overlapV;

    var totalMass = player.mass + otherPlayer.mass;
    var playerBuff = player.mass / totalMass;
    var otherPlayerBuff = otherPlayer.mass / totalMass;

    player.x -= olv.x * otherPlayerBuff;
    player.y -= olv.y * otherPlayerBuff;
    otherPlayer.x += olv.x * playerBuff;
    otherPlayer.y += olv.y * playerBuff;

    processedSubtree.player[player.id] = player;
    processedSubtree.player[otherPlayer.id] = otherPlayer;
  }
}

module.exports = CellController;
