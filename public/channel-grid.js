if (typeof module == 'undefined') {
  module = {
    exports: window
  };
}

var DEFAULT_LINE_OF_SIGHT = 1000;

var ChannelGrid = function (options) {
  this.worldWidth = options.worldWidth;
  this.worldHeight = options.worldHeight;
  this.cellOverlapDistance = options.cellOverlapDistance;
  this.rows = options.rows;
  this.cols = options.cols;

  this.cellWidth = this.worldWidth / this.cols;
  this.cellHeight = this.worldHeight / this.rows;

  this.exchange = options.exchange;
  this.watchingCells = {};
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

ChannelGrid.prototype.convertCellIndexToCoordinates = function (index) {
  return {
    r: Math.floor(index / this.cols),
    c: index % this.cols
  }
};

ChannelGrid.prototype.convertCoordinatesToCellIndex = function (coords) {
  return coords.r * this.cols + coords.c;
};

ChannelGrid.prototype.getCellIndex = function (object) {
  var coords = this.getCellCoordinates(object);
  return this.convertCoordinatesToCellIndex(coords);
};

ChannelGrid.prototype.getCellCoordinates = function (object) {
  return {
    r: Math.floor(object.y / this.cellHeight),
    c: Math.floor(object.x / this.cellWidth)
  }
};

ChannelGrid.prototype.getCellBounds = function (cellIndex) {
  var gridCoords = this.convertCellIndexToCoordinates(cellIndex);
  var x = gridCoords.c * this.cellWidth;
  var y = gridCoords.r * this.cellHeight;
  return {
    minX: x,
    minY: y,
    maxX: x + this.cellWidth,
    maxY: y + this.cellHeight
  };
};

ChannelGrid.prototype.getAllCellCoordinates = function (object, options) {
  if (!options) {
    options = {};
  }
  var overlapDist = this.cellOverlapDistance;
  var exclusions = {};
  if (options.excludeCellIndexes) {
    options.excludeCellIndexes.forEach(function (cellIndex) {
      exclusions[cellIndex] = true;
    });
  }

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
    minC: Math.max(minCell.c, 0),
    minR: Math.max(minCell.r, 0),
    maxC: Math.min(maxCell.c, this.cols - 1),
    maxR: Math.min(maxCell.r, this.rows - 1)
  };

  var affectedCells = [];

  for (var r = gridArea.minR; r <= gridArea.maxR; r++) {
    for (var c = gridArea.minC; c <= gridArea.maxC; c++) {
      var coords = {
        r: r,
        c: c
      };
      var cellIndex = this.convertCoordinatesToCellIndex(coords);
      if (!exclusions[cellIndex]) {
        affectedCells.push(coords);
      }
    }
  }
  return affectedCells;
};

ChannelGrid.prototype.getAllCellIndexes = function (object) {
  var self = this;
  var cellIndexes = [];
  var coordsList = this.getAllCellCoordinates(object);

  coordsList.forEach(function (coords) {
    cellIndexes.push(coords.r * self.cols + coords.c);
  });
  return cellIndexes;
};

ChannelGrid.prototype._getGridChannelName = function (channelName, col, row) {
  return '(' + col + ',' + row + ')' + channelName;
};


ChannelGrid.prototype._flushPublishGrid = function (channelName, grid) {
  for (var r = 0; r < this.rows; r++) {
    for (var c = 0; c < this.cols; c++) {
      if (grid[r] && grid[r][c]) {
        var states = grid[r][c];
        if (states.length) {
          this.exchange.publish(this._getGridChannelName(channelName, c, r), states);
        }
      }
    }
  }
};


ChannelGrid.prototype.publish = function (channelName, objects, options) {
  var self = this;
  if (!options) {
    options = {};
  }

  var grid = this._generateEmptyGrid(this.rows, this.cols);

  objects.forEach(function (obj) {
    var affectedCells;
    if (options.cellIndexesFactory) {
      var affectedCells = [];
      var cellIndexes = options.cellIndexesFactory(obj);
      cellIndexes.forEach(function (index) {
        affectedCells.push(self.convertCellIndexToCoordinates(index));
      });
    } else if (options.includeNearbyCells) {
      affectedCells = self.getAllCellCoordinates(obj);
    } else {
      affectedCells = [self.getCellCoordinates(obj)];
    }
    affectedCells.forEach(function (cell) {
      if (grid[cell.r] && grid[cell.r][cell.c]) {
        grid[cell.r][cell.c].push(obj);
      }
    });
  });

  this._flushPublishGrid(channelName, grid);
};

ChannelGrid.prototype.publishToCells = function (channelName, objects, cellIndexes) {
  var self = this;

  var grid = this._generateEmptyGrid(this.rows, this.cols);

  var targetCells = [];
  cellIndexes.forEach(function (index) {
    targetCells.push(self.convertCellIndexToCoordinates(index));
  });

  objects.forEach(function (obj) {
    targetCells.forEach(function (cell) {
      if (grid[cell.r] && grid[cell.r][cell.c]) {
        grid[cell.r][cell.c].push(obj);
      }
    });
  });

  this._flushPublishGrid(channelName, grid);
};

ChannelGrid.prototype.watchCell = function (channelName, col, row, watcher) {
  var gridChannelName = this._getGridChannelName(channelName, col, row);
  this.exchange.subscribe(gridChannelName).watch(watcher);
};

ChannelGrid.prototype.watchCellAtIndex = function (channelName, cellIndex, watcher) {
  var coords = this.convertCellIndexToCoordinates(cellIndex);
  this.watchCell(channelName, coords.c, coords.r, watcher);
};

ChannelGrid.prototype.unwatchCell = function (channelName, col, row, watcher) {
  var gridChannelName = this._getGridChannelName(channelName, col, row);
  var channel = this.exchange.channel(gridChannelName);
  channel.unwatch(watcher);
  channel.unsubscribe();
  channel.destroy();
};

ChannelGrid.prototype.updateCellWatchers = function (state, channelName, options, handler) {
  if (!this.watchingCells[channelName]) {
    this.watchingCells[channelName] = {};
  }
  var lineOfSight = options.lineOfSight || DEFAULT_LINE_OF_SIGHT;
  var watchMap = this.watchingCells[channelName];
  var sightArea = {
    minX: state.x - lineOfSight,
    minY: state.y - lineOfSight,
    maxX: state.x + lineOfSight,
    maxY: state.y + lineOfSight
  };
  var minCol = Math.max(Math.floor(sightArea.minX / this.cellWidth), 0);
  var maxCol = Math.min(Math.floor(sightArea.maxX / this.cellWidth), this.cols - 1);
  var minRow = Math.max(Math.floor(sightArea.minY / this.cellHeight), 0);
  var maxRow = Math.min(Math.floor(sightArea.maxY / this.cellHeight), this.rows - 1);

  var matchedCells = {};

  for (var r = minRow; r <= maxRow; r++) {
    for (var c = minCol; c <= maxCol; c++) {
      var colRowKey = c + ',' + r;
      matchedCells[colRowKey] = {col: c, row: r};
      if (!watchMap[colRowKey]) {
        watchMap[colRowKey] = {col: c, row: r};
        this.watchCell(channelName, c, r, handler);
      }
    }
  }

  for (var i in watchMap) {
    if (watchMap.hasOwnProperty(i)) {
      if (!matchedCells[i]) {
        var coords = watchMap[i];
        this.unwatchCell(channelName, coords.col, coords.row, handler);
        delete watchMap[i];
      }
    }
  }
};

module.exports.ChannelGrid = ChannelGrid;
