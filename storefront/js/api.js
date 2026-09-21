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

  /* A non-JSON response means we reached something that is not the API: on a
     deployed site that is usually the host's own 404 page, because the API
     has not been pointed at yet. Shoppers get a plain message; whoever is
     deploying gets a specific one in the console. */
  if (!json && !res.ok) {
    console.error(
      `[YnR] ${method} ${API_BASE + path} returned ${res.status} and no JSON. ` +
      `The API does not appear to be running at ${API_BASE}. ` +
      `Set window.YNR_API in index.html to the address of the back end.`
    );
  }

  if (!res.ok) {
    const err = new Error((json && json.error) || "The shop is unavailable right now. Please try again shortly.");
    err.code = (json && json.code) || 'unreachable';   // e.g. held_by_other, already_sold
    throw err;
  }
  return json;
}

/* First-party analytics: page views, product views, WhatsApp click-through.
   Fire-and-forget on purpose — a tracking call must never delay or break
   whatever the visitor actually came here to do, so failures are swallowed
   rather than surfaced. */
function track(type, extra) {
  api('POST', '/events', { type, path: location.pathname, ...extra }).catch(() => {});
}
