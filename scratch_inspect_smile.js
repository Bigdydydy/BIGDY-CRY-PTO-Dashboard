const crypto = require('crypto');

const pubKeyB64 = "MIIBCgKCAQEA0IBY5iI6qQxeWE/UZZ2cqGKlM8QcVemfP96Gl95Tzf8gq4dIj1YQXiwFjrEhoPlBqI0MekkoT8D6XUlOkVWqjaDN2s4yAiRLh5w9NKZFUkWNxW9uY1iqT8d3T5KZduq++Va7qrxEyUI1/J8ghT45G522tPusdXvk9YulPk9asVtCz9xzHX1aSKQ7w++rX4Qw5VOSbTf9j3QzhSFy1uPvANqb6umgzRqCXNW5dBuXMMahhqIKE6bIKOvhgOGb5+fS0KnugRfU7ibG2URZ8lhEpfx+Z4t1xjgCV2OI0sS2Y2lwtE5C+ad825iY817uCa8XubgnfSU+ykbMw9MT4eeLkQIDAQAB";
const pemKey = `-----BEGIN RSA PUBLIC KEY-----\n${pubKeyB64.match(/.{1,64}/g).join('\n')}\n-----END RSA PUBLIC KEY-----`;

function getXSign() {
  const ts = Date.now().toString();
  const buffer = Buffer.from(ts);
  return crypto.publicEncrypt({ key: pemKey, padding: crypto.constants.RSA_PKCS1_PADDING }, buffer).toString('base64');
}

async function run() {
  const resp = await fetch('https://api.greeks.live/api/v1/deribit/datalab/iv_skew_month', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sign': getXSign(), 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ currency: 'BTC' })
  });
  const res = await resp.json();
  const m1 = res.data.month1;
  const m3 = res.data.month3;
  console.log("month1 underlying:", m1.underlying_index, "price:", m1.underlying_price, "strikes count:", m1.iv_list?.length);
  // Sort by strike
  const list = [...(m1.iv_list || [])].sort((a, b) => a.strike - b.strike);
  console.log("First 3 strikes:", list.slice(0, 3));
  console.log("Middle strike (ATM):", list[Math.floor(list.length / 2)]);
  console.log("Last 3 strikes:", list.slice(-3));
}
run();
