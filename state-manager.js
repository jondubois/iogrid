var StateManager = function (options) {
  this.channelGrid = options.channelGrid;
  this.stateRefs = options.stateRefs;
};

StateManager.prototype.create = function (state) {
  var stateCellIndex = this.channelGrid.getCellIndex(state);
  var stateRef = {
    id: state.id,
    swid: state.swid,
    clid: stateCellIndex, // Cell index
    type: state.type,
    create: state
  };
  this.stateRefs[state.id] = stateRef;
  return stateRef;
};

StateManager.prototype.update = function (state, operation) {
  this.stateRefs[state.id].op = operation;
};

StateManager.prototype.delete = function (state) {
  this.stateRefs[state.id].delete = 1;
};

module.exports.StateManager = StateManager;
