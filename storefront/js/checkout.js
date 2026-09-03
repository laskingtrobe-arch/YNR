/* ==========================================================================
   Checkout
   Collects the customer's details, then places the order with the API BEFORE
   handing off to Paystack or WhatsApp. That ordering is the point: the order
   exists as a record even if the customer never finishes paying.
   ========================================================================== */

function renderCheckout() {
  const sum = document.getElementById('coSummary');
  sum.innerHTML = bag.map((i) => `
    <div class="sum-line">
      <span>${escapeHtml(i.name)}${i.size ? ' · ' + escapeHtml(i.size) : ''}</span>
      <span>${kobo(i.priceKobo)}</span>
    </div>`).join('');

  const zoneSel = document.getElementById('coZone');
  zoneSel.innerHTML = '<option value="">Choose your area…</option>' +
    ZONES.map((z) =>
      `<option value="${escapeAttr(z.code)}">${escapeHtml(z.label)} — ${escapeHtml(z.feeLabel)}</option>`
    ).join('');

  updateCheckoutTotals();
}

function selectedZone() {
  const code = document.getElementById('coZone').value;
  return ZONES.find((z) => z.code === code) || null;
}

function updateCheckoutTotals() {
  const z = selectedZone();
  const sub = bagSubtotal();
  const fee = z && !z.quoted ? z.feeKobo : 0;

  const sum = document.getElementById('coSummary');
  const existing = sum.querySelector('.sum-line.delivery');
  if (existing) existing.remove();

  const line = document.createElement('div');
  line.className = 'sum-line delivery';
  line.innerHTML = `<span>Delivery</span><span>${
    !z ? '—' : (z.quoted ? 'Confirmed on WhatsApp' : kobo(z.feeKobo))
  }</span>`;
  sum.appendChild(line);

  document.getElementById('coTotal').textContent = kobo(sub + fee);
  document.getElementById('zoneHint').textContent = z ? z.note : '';

  /* Paying by card needs a final total. Zones we quote by hand do not have
     one yet, so that path is closed off here rather than failing later at
     the payment step. */
  const payBtn = document.getElementById('payCardBtn');
  const blocked = !z || z.quoted;
  payBtn.disabled = blocked;
  payBtn.style.opacity = blocked ? '.45' : '1';
  payBtn.style.cursor = blocked ? 'not-allowed' : 'pointer';
  payBtn.title = blocked
    ? 'Delivery to this area is quoted by us on WhatsApp, so the total is not final yet.'
    : '';
}

function collectCheckout() {
  const v = (id) => (document.getElementById(id).value || '').trim();
  return {
    name: v('coName'), email: v('coEmail'), phone: v('coPhone'),
    zone: v('coZone'), addressLine: v('coAddress'),
    city: v('coCity'), state: v('coState'), notes: v('coNotes'),
    website: document.querySelector('#checkoutForm [name="website"]').value, // honeypot
    items: bag.map((i) => ({ slug: i.slug, size: i.size })),
  };
}

function validateCheckout(d) {
  if (!d.name) return 'Please enter your name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email)) return 'Please enter a valid email address.';
  if (d.phone.replace(/\D/g, '').length < 7) return 'Please enter a phone number we can reach you on.';
  if (!d.zone) return 'Please choose your delivery area.';
  if (!bag.length) return 'Your bag is empty.';
  return null;
}

function checkoutError(msg) {
  const el = document.getElementById('checkoutError');
  if (!msg) { el.style.display = 'none'; return; }
  el.textContent = msg;
  el.style.display = 'block';
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function placeOrder(channel) {
  checkoutError(null);

  const d = collectCheckout();
  const problem = validateCheckout(d);
  if (problem) return checkoutError(problem);

  const btn = document.getElementById(channel === 'paystack' ? 'payCardBtn' : 'payWaBtn');
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = 'Placing your order…';

  try {
    const created = await api('POST', '/orders', { ...d, channel });
    const order = created.order;

    if (channel === 'paystack') {
      const pay = await api('POST', '/payments/init', { reference: order.reference });
      bag = []; saveBag(); renderCart();
      window.location.href = pay.authorizationUrl;   // hand off to Paystack
      return;
    }

    bag = []; saveBag(); renderCart();
    showOrderPlaced(order, created.whatsappUrl);
  } catch (e) {
    /* Losing a one-of-one mid-checkout is the interesting failure here, so
       say so plainly instead of showing a generic error. */
    checkoutError(
      (e.code === 'held_by_other' || e.code === 'already_sold')
        ? e.message + ' Refresh the shop to see what is still available.'
        : e.message
    );
    btn.disabled = false;
    btn.innerHTML = label;
  }
}

function showOrderPlaced(order, waUrl) {
  document.getElementById('ordRef').textContent = order.reference;
  document.getElementById('ordMsg').textContent =
    'Keep this reference. We have emailed it to you, and we will confirm everything on WhatsApp before anything ships.';

  document.getElementById('ordItems').innerHTML =
    order.items.map((i) => `
      <div class="sum-line">
        <span>${escapeHtml(i.name)}${i.size ? ' · ' + escapeHtml(i.size) : ''}</span>
        <span>${escapeHtml(i.priceLabel)}</span>
      </div>`).join('') +
    `<div class="sum-line"><span>Delivery</span><span>${escapeHtml(order.delivery.feeLabel)}</span></div>
     <div class="sum-total" style="font-size:20px;"><span>Total</span><span>${escapeHtml(order.totalLabel)}</span></div>`;

  document.getElementById('ordWa').href = waUrl || `https://wa.me/${WA_NUMBER}`;
  showView('order');
  window.scrollTo({ top: 0 });
}
