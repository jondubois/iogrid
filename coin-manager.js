var uuid = require('uuid');
var SAT = require('sat');

var MAX_TRIALS = 100;

var COIN_DEFAULT_RADIUS = 10;
var COIN_DEFAULT_VALUE = 1;


var CoinManager = function (options) {
  this.serverWorkerId = options.serverWorkerId;
  this.playerNoDropRadius = options.playerNoDropRadius;
  this.maxCoinCount = options.maxCoinCount;
  this.worldWidth = options.worldWidth;
  this.worldHeight = options.worldHeight;

  this.users = options.users;
  this.coins = {};
  this.coinCount = 0;
};

CoinManager.prototype.generateRandomAvailablePosition = function (coinRadius) {
  var coinDiameter = coinRadius * 2;
  var circles = [];

  for (var i in this.users) {
    var curUser = this.users[i];
    circles.push(new SAT.Circle(new SAT.Vector(curUser.x, curUser.y), this.playerNoDropRadius));
  }

  var position = null;

  for (var j = 0; j < MAX_TRIALS; j++) {
    var tempPosition = {
      x: Math.round(Math.random() * (this.worldWidth - coinDiameter) + coinRadius),
      y: Math.round(Math.random() * (this.worldHeight - coinDiameter) + coinRadius)
    }
    var tempPoint = new SAT.Vector(tempPosition.x, tempPosition.y);

    var validPosition = true;
    for (var k = 0; k < circles.length; k++) {
      if (SAT.pointInCircle(tempPoint, circles[k])) {
        validPosition = false;
        break;
      }
    }
    if (validPosition) {
      position = tempPosition;
      break;
    }
  }
  return position;
};

CoinManager.prototype.addCoin = function (value, radius) {
  if (this.coinCount < this.maxCoinCount) {
    radius = radius || COIN_DEFAULT_RADIUS;
    var coinId = uuid.v4();
    var validPosition = this.generateRandomAvailablePosition(radius);
    var coin = {
      id: coinId,
      swid: this.serverWorkerId,
      v: value || COIN_DEFAULT_VALUE,
      r: radius,
      x: validPosition.x,
      y: validPosition.y
    };
    this.coins[coinId] = coin;
    this.coinCount++;
  }
};

CoinManager.prototype.removeCoin = function (coinId) {
  if (this.coins[coinId]) {
    delete this.coins[coinId];
    this.coinCount--;
  }
};

CoinManager.prototype.doesUserTouchCoin = function (coinId, userState) {
  var coin = this.coins[coinId];
  if (!coin) {
    return false;
  }
  var userCircle = new SAT.Circle(new SAT.Vector(userState.x, userState.y), Math.ceil(userState.width / 2));
  var coinCircle = new SAT.Circle(new SAT.Vector(coin.x, coin.y), coin.r);
  return SAT.testCircleCircle(userCircle, coinCircle);
};

module.exports.CoinManager = CoinManager;
