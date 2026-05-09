'use strict';

const { WebUiServer } = require('./server/http');

async function startWebUi(opts = {}) {
  const server = new WebUiServer(opts);
  const info = await server.start();
  return { server, ...info };
}

module.exports = {
  startWebUi,
  WebUiServer,
};
