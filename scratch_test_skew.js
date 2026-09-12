const crypto = require('crypto');

const pubKeyB64 = "MIIBCgKCAQEA0IBY5iI6qQxeWE/UZZ2cqGKlM8QcVemfP96Gl95Tzf8gq4dIj1YQXiwFjrEhoPlBqI0MekkoT8D6XUlOkVWqjaDN2s4yAiRLh5w9NKZFUkWNxW9uY1iqT8d3T5KZduq++Va7qrxEyUI1/J8ghT45G522tPusdXvk9YulPk9asVtCz9xzHX1aSKQ7w++rX4Qw5VOSbTf9j3QzhSFy1uPvANqb6umgzRqCXNW5dBuXMMahhqIKE6bIKOvhgOGb5+fS0KnugRfU7ibG2URZ8lhEpfx+Z4t1xjgCV2OI0sS2Y2lwtE5C+ad825iY817uCa8XubgnfSU+ykbMw9MT4eeLkQIDAQAB";
const pemKey = `-----BEGIN RSA PUBLIC KEY-----\n${pubKeyB64.match(/.{1,64}/g).join('\n')}\n-----END RSA PUBLIC KEY-----`;

function getXSign() {
  const ts = Date.now().toString();
  const buffer = Buffer.from(ts);
  const encrypted = crypto.publicEncrypt({ key: pemKey, padding: crypto.constants.RSA_PKCS1_PADDING }, buffer);
  return encrypted.toString('base64');
}

async function callEp(ep, payload) {
  const url = `https://api.greeks.live/api/v1/deribit/datalab/${ep}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sign': getXSign(),
      'User-Agent': 'Mozilla/5.0'
    },
    body: JSON.stringify(payload)
  });
  return await resp.json();
}

async function main() {
  console.log("=== Testing skew endpoints ===");

  // 1. skew_chart
  const sc = await callEp('skew_chart', { currency: 'BTC', gap: '1d' });
  console.log('skew_chart:', sc.code, 'len:', sc.data?.length);
  if (sc.data?.length) {
    console.log('skew_chart latest item:', sc.data[sc.data.length - 1]);
  }

  // 2. iv_skew_month
  const ism = await callEp('iv_skew_month', { currency: 'BTC' });
  console.log('\niv_skew_month:', ism.code, 'keys:', ism.data ? Object.keys(ism.data) : null);
  if (ism.data) {
    console.log('sample iv_skew_month:', JSON.stringify(ism.data).slice(0, 300));
  }

  // 3. skew_matrix
  const sm = await callEp('skew_matrix', { currency: 'BTC' });
  console.log('\nskew_matrix:', sm.code, 'keys:', sm.data ? Object.keys(sm.data) : null);
  if (sm.data) {
    console.log('sample skew_matrix:', JSON.stringify(sm.data).slice(0, 300));
  }

  // 4. smile curve / strike_iv / floating/strike_iv
  const f_iv = await fetch('https://api.greeks.live/api/v1/deribit/floating/strike_iv', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sign': getXSign(), 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ currency: 'BTC' })
  }).then(r => r.json()).catch(e => e.message);
  console.log('\nfloating/strike_iv:', f_iv.code, 'data keys:', f_iv.data ? Object.keys(f_iv.data) : null);
  if (f_iv.data) {
    console.log('sample floating/strike_iv:', JSON.stringify(f_iv.data).slice(0, 300));
  }
}

main();
