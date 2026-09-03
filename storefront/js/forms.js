/* ==========================================================================
   Contact and newsletter forms

   Both of these used to display a success message and then throw the data
   away. They now post to the API and report what actually happened.
   ========================================================================== */

function formNotice(host, msg, ok) {
  let el = host.querySelector('.notice');
  if (!el) {
    el = document.createElement('div');
    el.className = 'notice';
    host.appendChild(el);
  }
  el.className = 'notice ' + (ok ? 'ok' : 'err');
  el.textContent = msg;
  el.style.display = 'block';
}

async function handleSignup(e) {
  e.preventDefault();

  const form = document.getElementById('signupForm');
  const btn = form.querySelector('button');
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';

  try {
    const r = await api('POST', '/newsletter', {
      email: document.getElementById('signupEmail').value.trim(),
    });
    form.style.display = 'none';
    const okEl = document.getElementById('signupSuccess');
    okEl.textContent = r.message || 'Check your email to confirm.';
    okEl.style.display = 'block';
  } catch (ex) {
    formNotice(form.parentElement, ex.message, false);
    btn.disabled = false;
    btn.textContent = was;
  }
  return false;
}

async function handleContact(e) {
  e.preventDefault();

  const form = document.getElementById('contactForm');
  const btn = form.querySelector('button[type="submit"]');
  const was = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = 'Sending…';

  try {
    await api('POST', '/contact', {
      name: document.getElementById('cName').value.trim(),
      email: document.getElementById('cEmail').value.trim(),
      subject: document.getElementById('cSubject').value.trim(),
      message: document.getElementById('cMessage').value.trim(),
    });
    form.querySelectorAll('.field, button[type="submit"]').forEach((el) => { el.style.display = 'none'; });
    document.getElementById('contactSuccess').style.display = 'block';
  } catch (ex) {
    formNotice(form, ex.message, false);
    btn.disabled = false;
    btn.innerHTML = was;
  }
  return false;
}
