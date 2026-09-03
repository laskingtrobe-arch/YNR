/* ==========================================================================
   Small shared helpers: escaping, money, image URLs.
   ========================================================================== */

/* Product names and descriptions are set by the shop owner through the admin
   panel, so they are escaped before ever touching innerHTML. */
const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

const escapeAttr = escapeHtml;

/* The API stores money as an integer number of kobo. Naira is display only. */
const kobo = (k) => '₦' + Math.round(k / 100).toLocaleString('en-NG');
const NGN = (n) => '₦' + Number(n).toLocaleString('en-NG');

/* Product photos are served by the API, so relative paths need its origin. */
function imgUrl(u) {
  if (!u) return '';
  if (/^https?:\/\//.test(u)) return u;
  return API_BASE.replace(/\/api$/, '') + u;
}
