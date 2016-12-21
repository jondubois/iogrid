var uuid = require('uuid');
var SAT = require('sat');

var BOT_DEFAULT_RADIUS = 40;
var BOT_DEFAULT_SPEED = 3;

var BotManager = function (options) {
  this.serverWorkerId = options.serverWorkerId;
  this.worldWidth = options.worldWidth;
  this.worldHeight = options.worldHeight;

  this.users = options.users;
  this.bots = {};
  this.botCount = 0;

  this.botMoves = [
    {u: 1},
    {d: 1},
    {r: 1},
    {l: 1}
  ];
};

BotManager.prototype.generateRandomPosition = function (botRadius) {
  var botDiameter = botRadius * 2;
  var position = {
    x: Math.round(Math.random() * (this.worldWidth - botDiameter) + botRadius),
    y: Math.round(Math.random() * (this.worldHeight - botDiameter) + botRadius)
  };
  return position;
};

BotManager.prototype.isBotOnEdge = function (bot) {
  var radius = Math.round(bot.width / 2)
  return bot.x <= radius || bot.x >= this.worldWidth - radius ||
    bot.y <= radius || bot.y >= this.worldHeight - radius;
};

BotManager.prototype.addBot = function (options) {
  if (!options) {
    options = {};
  }
  var radius = options.radius || BOT_DEFAULT_RADIUS;
  var diameter = radius * 2;
  var botId = uuid.v4();

  var bot = {
    id: botId,
    type: 'bot',
    swid: this.serverWorkerId,
    name: options.name || 'bot-' + Math.round(Math.random() * 10000),
    color: options.color || 1000,
    score: options.score || 0,
    speed: options.speed || BOT_DEFAULT_SPEED,
    width: diameter,
    height: diameter,
    ops: {}
  };
  if (options.x && options.y) {
    bot.x = options.x;
    bot.y = options.y;
  } else {
    var position = this.generateRandomPosition(radius);
    if (options.x) {
      bot.x = options.x;
    } else {
      bot.x = position.x;
    }
    if (options.y) {
      bot.y = options.y;
    } else {
      bot.y = position.y;
    }
  }
  this.bots[botId] = bot;
  this.users[botId] = bot;
  this.botCount++;
};

BotManager.prototype.moveBotsRandomly = function (callback) {
  var self = this;
  Object.keys(this.bots).forEach(function (botId) {
    var bot = self.bots[botId];
    if (Math.random() * 1000 > 990 || self.isBotOnEdge(bot)) {
      var randIndex = Math.floor(Math.random() * 4)
      bot.ops = self.botMoves[randIndex];
    }
    callback(bot);
  });
};

BotManager.prototype.removeBot = function (botId) {
  if (this.bots[botId]) {
    delete this.bots[botId];
    delete this.users[botId];
    this.botCount--;
  }
};

module.exports.BotManager = BotManager;
