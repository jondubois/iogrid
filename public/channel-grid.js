if (typeof module == 'undefined') {
  module = {
    exports: window
  };
}

var ChannelGrid = function (options) {
  this.worldWidth = options.worldWidth;
  this.worldHeight = options.worldHeight;
  this.cellOverlapDistance = options.cellOverlapDistance;
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

ChannelGrid.prototype.getCellIndex = function (object) {
  var coords = this.getCellCoordinates(object);
  return coords.r * this.cols + coords.c;
};

ChannelGrid.prototype.getCellCoordinates = function (object) {
  return {
    r: Math.floor(object.y / this.cellHeight),
    c: Math.floor(object.x / this.cellWidth)
  }
};

ChannelGrid.prototype.getAllCellCoordinates = function (object) {
  var overlapDist = this.cellOverlapDistance;

  var objectArea = {
    minX: object.x - overlapDist,
    minY: object.y - overlapDist,
    maxX: object.x + overlapDist,
    maxY: object.y + overlapDist
  };
  var minCell = this.getCellCoordinates({
    x: objectArea.minX,
    y: objectArea.minY
  });
  var maxCell = this.getCellCoordinates({
    x: objectArea.maxX,
    y: objectArea.maxY
  });
  var gridArea = {
    minC: minCell.c,
    minR: minCell.r,
    maxC: maxCell.c,
    maxR: maxCell.r
  };

  var affectedCells = [];

  for (var r = gridArea.minR; r <= gridArea.maxR; r++) {
    for (var c = gridArea.minC; c <= gridArea.maxC; c++) {
      affectedCells.push({
        r: r,
        c: c
      });
    }
  }
  return affectedCells;
};

ChannelGrid.prototype._getGridChannelName = function (channelName, col, row) {
  return 'cell(' + col + ',' + row + ')' + channelName;
};

ChannelGrid.prototype.publish = function (channelName, objects) {
  var self = this;

  var grid = this._generateEmptyGrid(this.rows, this.cols);

  objects.forEach(function (obj) {
    var affectedCells = self.getAllCellCoordinates(obj);
    affectedCells.forEach(function (cell) {
      if (grid[cell.r] && grid[cell.r][cell.c]) {
        grid[cell.r][cell.c].push(obj);
      }
    });
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
