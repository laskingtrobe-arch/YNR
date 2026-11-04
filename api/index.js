'use strict';
const app = require('../server/src/index');

module.exports = (req, res) => {
  // When Vercel rewrites /api/(.*) to /api, x-matched-path preserves the full path
  const orig = req.headers['x-matched-path'] || req.url;
  if (orig && orig !== '/api' && orig !== '/api/') {
    req.url = orig;
  }

  if (req.url && !req.url.startsWith('/api')) {
    req.url = '/api' + (req.url.startsWith('/') ? req.url : '/' + req.url);
  }

  return app(req, res);
};
