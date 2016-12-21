if (typeof module == 'undefined') {
  module = {
    exports: window
  };
}

var ChannelGrid = function (options) {
  this.worldWidth = options.worldWidth;
  this.worldHeight = options.worldHeight;
  this.rows = options.rows;
  this.cols = options.cols;

  this.cellWidth = this.worldWidth / this.cols;
  this.cellHeight = this.worldHeight / this.rows;

  this.exchange = options.exchange;
};

ChannelGrid.prototype._generateEmptyGrid = function (rows, cols) {
  var grid = [];
  for (var r = 0; r < rows; r++) {
    grid[r] = [];
    for (var c = 0; c < cols; c++) {
      grid[r][c] = [];
    }
  }
  return grid;
};

ChannelGrid.prototype._convertCellIndexToCoordinates = function (index) {
  return {
    r: Math.floor(index / this.cols),
    c: index % this.cols
  }
};

ChannelGrid.prototype._getCellCoordinates = function (object) {
  return {
    r: Math.floor(object.y / this.cellHeight),
    c: Math.floor(object.x / this.cellWidth)
  }
};

ChannelGrid.prototype._getGridChannelName = function (channelName, col, row) {
  return 'cell(' + col + ',' + row + ')' + channelName;
};

ChannelGrid.prototype.publish = function (channelName, objects) {
  var self = this;

  var grid = this._generateEmptyGrid(this.rows, this.cols);

  objects.forEach(function (obj) {
    var cell = self._getCellCoordinates(obj);
    if (grid[cell.r] && grid[cell.r][cell.c]) {
      grid[cell.r][cell.c].push(obj);
    }
  });

  for (var r = 0; r < this.rows; r++) {
    for (var c = 0; c < this.cols; c++) {
      if (grid[r] && grid[r][c]) {
        var states = grid[r][c];
        if (states.length) {
          self.exchange.publish(self._getGridChannelName(channelName, c, r), states);
        }
      }
    }
  }
};

ChannelGrid.prototype.watchCell = function (channelName, col, row, watcher) {
  var gridChannelName = this._getGridChannelName(channelName, col, row);
  this.exchange.subscribe(gridChannelName).watch(watcher);
};

ChannelGrid.prototype.watchCellAtIndex = function (channelName, cellIndex, watcher) {
  var coords = this._convertCellIndexToCoordinates(cellIndex);
  this.watchCell(channelName, coords.c, coords.r, watcher);
};

ChannelGrid.prototype.unwatchCell = function (channelName, col, row, watcher) {
  var gridChannelName = this._getGridChannelName(channelName, col, row);
  var channel = this.exchange.channel(gridChannelName);
  channel.unwatch(watcher);
  channel.unsubscribe();
  channel.destroy();
};

module.exports.ChannelGrid = ChannelGrid;
