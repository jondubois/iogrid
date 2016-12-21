var rbush = require('rbush');
var SAT = require('sat');

var STALE_TIMEOUT = 1000;

var options;

module.exports.run = function (opts, cellData, done) {
  var self = this;
  options = opts;

  var players = cellData.player || {};

  removeStalePlayers(players);
  findPlayerOverlaps(players);
  applyPlayerOps(players, options);

  done(cellData);
};

function applyPlayerOps(players) {
  var playerIds = Object.keys(players);
  playerIds.forEach(function (playerId) {
    var player = players[playerId];
    var playerOp = player.op;
    var moved = false;

    if (playerOp) {
      var movementVector = {x: 0, y: 0};

      if (playerOp.u) {
        movementVector.y = -options.playerMoveSpeed;
      }
      if (playerOp.d) {
        movementVector.y = options.playerMoveSpeed;
      }
      if (playerOp.r) {
        movementVector.x = options.playerMoveSpeed;
      }
      if (playerOp.l) {
        movementVector.x = -options.playerMoveSpeed;
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
    } else if (rightX > options.worldWidth) {
      player.x = options.worldWidth - halfWidth;
    }
    if (topY < 0) {
      player.y = halfHeight;
    } else if (bottomY > options.worldHeight) {
      player.y = options.worldHeight - halfHeight;
    }

    if (player.overlaps) {
      player.overlaps.forEach(function (otherPlayer) {
        resolveCollision(player, otherPlayer);
      });
      delete player.overlaps;
    }
    delete player.op;
  });
}

function removeStalePlayers(players) {
  var playerIds = Object.keys(players);
  playerIds.forEach(function (playerId) {
    var player = players[playerId];
    if (Date.now() - player.processed > STALE_TIMEOUT) {
      delete players[playerId];
    } else {
      player.processed = Date.now();
    }
  });
}

function findPlayerOverlaps(players) {
  var playerIds = Object.keys(players);
  var playerTree = new rbush();
  var hitAreaList = [];

  playerIds.forEach(function (playerId) {
    var player = players[playerId];
    player.hitArea = generateHitArea(player);
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

function generateHitArea(player) {
  var playerRadius = Math.round(player.width / 2);
  return {
    player: player,
    minX: player.x - playerRadius,
    minY: player.y - playerRadius,
    maxX: player.x + playerRadius,
    maxY: player.y + playerRadius
  };
}

function resolveCollision(player, otherPlayer) {
  var currentUser = new SAT.Circle(new SAT.Vector(player.x, player.y), Math.round(player.width / 2));
  var otherUser = new SAT.Circle(new SAT.Vector(otherPlayer.x, otherPlayer.y), Math.round(otherPlayer.width / 2));
  var response = new SAT.Response();
  var collided = SAT.testCircleCircle(currentUser, otherUser, response);

  if (collided) {
    var olv = response.overlapV;
    player.x -= olv.x;
    player.y -= olv.y;
    // TODO: Remove
    // otherPlayer.x += olv.x;
    // otherPlayer.y += olv.y;
  }
}
