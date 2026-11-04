'use strict';
const app = require('../server/src/index');

module.exports = (req, res) => {
  // When Vercel rewrites /api/(.*) or /uploads/(.*) to /api, x-matched-path preserves the full path
  const orig = req.headers['x-matched-path'] || req.url;
  if (orig && orig !== '/api' && orig !== '/api/') {
    req.url = orig;
  }

  // Retain /uploads and /api paths for Express routing
  if (req.url && !req.url.startsWith('/api') && !req.url.startsWith('/uploads')) {
    req.url = '/api' + (req.url.startsWith('/') ? req.url : '/' + req.url);
  }

  return app(req, res);
};
