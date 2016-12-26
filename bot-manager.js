var uuid = require('uuid');
var SAT = require('sat');

var BOT_DEFAULT_DIAMETER = 80;
var BOT_DEFAULT_SPEED = 1;
var BOT_DEFAULT_MASS = 10;
var BOT_DEFAULT_CHANGE_DIRECTION_PROBABILITY = 0.01;
var BOT_DEFAULT_COLOR = 1000;

var BotManager = function (options) {
  this.serverWorkerId = options.serverWorkerId;
  this.worldWidth = options.worldWidth;
  this.worldHeight = options.worldHeight;
  this.botDiameter = options.botDiameter || BOT_DEFAULT_DIAMETER;
  this.botMoveSpeed = options.botMoveSpeed || BOT_DEFAULT_SPEED;
  this.botMass = options.botMass || BOT_DEFAULT_MASS;
  this.botColor = options.botColor || BOT_DEFAULT_COLOR;
  this.botChangeDirectionProbability = options.botChangeDirectionProbability || BOT_DEFAULT_CHANGE_DIRECTION_PROBABILITY;

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

BotManager.prototype.addBot = function (options) {
  if (!options) {
    options = {};
  }
  var diameter = this.botDiameter;
  var radius = Math.round(diameter / 2);
  var botId = uuid.v4();

  var botData = {
    id: botId,
    type: 'player',
    subtype: 'bot',
    swid: this.serverWorkerId,
    name: options.name || 'bot-' + Math.round(Math.random() * 10000),
    color: options.color || this.botColor,
    score: options.score || 0,
    speed: options.speed || this.botMoveSpeed,
    mass: options.mass || this.botMass,
    width: diameter,
    height: diameter,
    changeDirProb: this.botChangeDirectionProbability,
    op: {},
    processed: Date.now()
  };
  if (options.x && options.y) {
    botData.x = options.x;
    botData.y = options.y;
  } else {
    var position = this.generateRandomPosition(radius);
    if (options.x) {
      botData.x = options.x;
    } else {
      botData.x = position.x;
    }
    if (options.y) {
      botData.y = options.y;
    } else {
      botData.y = position.y;
    }
  }
  var bot = this.stateManager.create(botData);
  this.bots[botId] = bot;

  this.botCount++;
};

BotManager.prototype.removeBot = function (botId) {
  if (this.bots[botId]) {
    this.stateManager.delete(this.bots[botId]);
    delete this.bots[botId];
    this.botCount--;
  }
};

module.exports.BotManager = BotManager;
