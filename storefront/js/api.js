/* ==========================================================================
   API client
   One place that knows how to talk to the server and how to fail politely.
   ========================================================================== */

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(API_BASE + path, opts);
  } catch (e) {
    throw new Error("Can't reach the shop right now. Check your connection and try again.");
  }

  let json = null;
  try { json = await res.json(); } catch (e) { /* server returned a non-JSON page */ }

  if (!res.ok) {
    const err = new Error((json && json.error) || 'Something went wrong. Please try again.');
    err.code = json && json.code;   // e.g. held_by_other, already_sold
    throw err;
  }
  return json;
}
