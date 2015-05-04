var React = require('react');
var debug = require('debug');

var bootstrapDebug = debug('Example');
var dehydratedState = window.App; // Sent from the server

window.React = React; // For chrome dev tool support
debug.enable('*');

module.exports = function(app) {
  bootstrapDebug('rehydrating app');
  app.rehydrate(dehydratedState, function (err, context) {
      if (err) {
          throw err;
      }
      window.context = context;
      var mountNode = document.getElementById('app');

      bootstrapDebug('React Rendering');
      var Component = app.getComponent();
      React.render(Component({context:context.getComponentContext()}), mountNode, function () {
          bootstrapDebug('React Rendered');
      });
  });
}
