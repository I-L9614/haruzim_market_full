async function charge({ amount, token, customer }) {
  if (process.env.PAYMENT_MODE !== 'cal') {
    throw new Error('Online payments are disabled. Contact the store to arrange payment.');
  }

  if (!process.env.CAL_API_URL || !process.env.CAL_TERMINAL_ID || !process.env.CAL_API_KEY) {
    throw new Error('Cal payment configuration is incomplete');
  }

  const response = await fetch(`${process.env.CAL_API_URL}/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.CAL_API_KEY}`
    },
    body: JSON.stringify({
      terminalId: process.env.CAL_TERMINAL_ID,
      amount,
      paymentToken: token,
      customer
    })
  });

  if (!response.ok) throw new Error('Cal payment failed');
  const result = await response.json();
  return { status: 'paid', transactionId: result.transactionId, provider: 'cal' };
}

module.exports = { charge };
