'use strict';

// Starts the real Express app on an OS-assigned port (port 0) so tests hit
// it over a real HTTP connection, per this repo's test convention.
function startApp(appModulePath = '../../server') {
  process.env.VISION_PROVIDER = process.env.VISION_PROVIDER || 'fake';
  // eslint-disable-next-line global-require
  const { app, perIpLimiter } = require(appModulePath);
  const server = app.listen(0);
  const { port } = server.address();
  return {
    app,
    perIpLimiter,
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

module.exports = { startApp };
