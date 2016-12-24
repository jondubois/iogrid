var StateManager = function (options) {
  this.states = options.states;
};

StateManager.prototype.create = function (state) {
  this.states[state.id] = state;
  return state;
};

StateManager.prototype.update = function (state, operation) {
  this.states[state.id].op = operation;
};

StateManager.prototype.delete = function (state) {
  this.states[state.id].delete = 1;
};

module.exports.StateManager = StateManager;
