var uuid = require('uuid');
var SAT = require('sat');

var BOT_DEFAULT_DIAMETER = 80;
var BOT_DEFAULT_SPEED = 1;
var BOT_DEFAULT_MASS = 10;
var BOT_CHANGE_DIRECTION_PROBABILITY = 0.01;

var BotManager = function (options) {
  this.serverWorkerId = options.serverWorkerId;
  this.worldWidth = options.worldWidth;
  this.worldHeight = options.worldHeight;
  this.botDiameter = options.botDiameter || BOT_DEFAULT_DIAMETER;
  this.botMoveSpeed = options.botMoveSpeed || BOT_DEFAULT_SPEED;
  this.botMass = options.botMass || BOT_DEFAULT_MASS;

  this.stateManager = options.stateManager;
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
  var diameter = this.botDiameter;
  var radius = Math.round(diameter / 2);
  var botId = uuid.v4();

  var bot = {
    id: botId,
    type: 'player',
    subtype: 'bot',
    swid: this.serverWorkerId,
    name: options.name || 'bot-' + Math.round(Math.random() * 10000),
    color: options.color || 1000,
    score: options.score || 0,
    speed: options.speed || this.botMoveSpeed,
    mass: options.mass || this.botMass,
    width: diameter,
    height: diameter,
    op: {},
    processed: Date.now()
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
  this.states[botId] = bot;
  this.stateManager.create(bot);
  this.botCount++;
};

BotManager.prototype.moveBotsRandomly = function () {
  var self = this;
  Object.keys(this.bots).forEach(function (botId) {
    var bot = self.bots[botId];
    if (Math.random() <= BOT_CHANGE_DIRECTION_PROBABILITY || self.isBotOnEdge(bot)) {
      var randIndex = Math.floor(Math.random() * 4)
      // The op property will be picked up in our cell controller (cell.js)
      // and the bot will be moved as if it were a regular player.
      bot.data = {
        repeatOp: self.botMoves[randIndex]
      };
    }
    if (bot.data && bot.data.repeatOp) {
      bot.op = bot.data.repeatOp;
    }
  });
};

BotManager.prototype.removeBot = function (botId) {
  if (this.bots[botId]) {
    delete this.bots[botId];
    delete this.states[botId];
    this.botCount--;
  }
};

module.exports.BotManager = BotManager;
