const axios = require('axios');

function normalizeAmountToFils(amount) {
  const raw = String(amount ?? '').trim();
  if (!raw) return null;
  const normalized = raw.replace(',', '.').replace(/[^\d.]/g, '');
  const num = Number(normalized);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.round(num * 100);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    const body = req.body || {};

    const amount =
      body.amount ??
      body.AMOUNT ??
      body.sum ??
      body.SUM;

    const orderid =
      body.orderid ??
      body.order_id ??
      body.ORDERID ??
      body.orderId ??
      body.invoiceId ??
      body.InvoiceId;

    const callbackUrl =
      body.callback_url ??
      body.CALLBACK_URL ??
      body.callbackUrl ??
      body.notification_url ??
      body.NOTIFICATION_URL;

    const amountInFils = normalizeAmountToFils(amount);
    if (!amountInFils) {
      return res.status(400).send('Missing or invalid amount');
    }

    if (!orderid) {
      return res.status(400).send('Missing orderid');
    }

    const ziinaToken = process.env.ZIINA_API_TOKEN || process.env.ZIINA_API_KEY;
    if (!ziinaToken) {
      return res.status(500).send('Configuration Error: Missing Ziina Token');
    }

    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = `${protocol}://${host}`;

    const response = await axios.post(
      'https://api-v2.ziina.com/api/payment_intent',
      {
        amount: amountInFils,
        currency_code: 'AED',
        success_url: 'https://sention.ae/ordersuccess',
        cancel_url: `${baseUrl}/orderfailed`,
        metadata: {
          tilda_order_id: String(orderid),
          tilda_amount: String(amount),
          tilda_callback_url: callbackUrl ? String(callbackUrl) : null,
          tilda_payload: body
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ziinaToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data && response.data.redirect_url) {
      return res.redirect(303, response.data.redirect_url);
    }

    return res.status(500).send('Failed to initiate payment: No redirect URL');
  } catch (error) {
    const details = error.response?.data?.message || error.response?.data || error.message;
    return res.status(500).send(`Internal Server Error: ${details}`);
  }
};
