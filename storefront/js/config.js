/* ==========================================================================
   Configuration
   Loaded first. Everything else depends on these values.
   ========================================================================== */

/* Where the API lives. Set window.YNR_API before this script to override.
   On a deployed site the API is served from the same origin, so /api is right. */
const API_BASE =
  window.YNR_API ||
  (location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? 'http://localhost:4000/api'
    : '/api');

/* Used for direct enquiries. Order confirmations use the link the API
   generates, which carries the order reference. */
const WA_NUMBER = '2349026947815';

/* How long the bag survives in the browser, and under what key. */
const BAG_KEY = 'ynr_bag_v1';
