const crypto = require('crypto');

const PUB_KEY_B64 = "MIIBCgKCAQEA0IBY5iI6qQxeWE/UZZ2cqGKlM8QcVemfP96Gl95Tzf8gq4dIj1YQXiwFjrEhoPlBqI0MekkoT8D6XUlOkVWqjaDN2s4yAiRLh5w9NKZFUkWNxW9uY1iqT8d3T5KZduq++Va7qrxEyUI1/J8ghT45G522tPusdXvk9YulPk9asVtCz9xzHX1aSKQ7w++rX4Qw5VOSbTf9j3QzhSFy1uPvANqb6umgzRqCXNW5dBuXMMahhqIKE6bIKOvhgOGb5+fS0KnugRfU7ibG2URZ8lhEpfx+Z4t1xjgCV2OI0sS2Y2lwtE5C+ad825iY817uCa8XubgnfSU+ykbMw9MT4eeLkQIDAQAB";
const PEM_KEY = `-----BEGIN RSA PUBLIC KEY-----\n${PUB_KEY_B64.match(/.{1,64}/g).join('\n')}\n-----END RSA PUBLIC KEY-----`;

/**
 * Generates the RSA encrypted X-Sign header value required by Greeks.live DataLab endpoints.
 */
function getXSign(timestampMs) {
  const ts = (timestampMs || Date.now()).toString();
  const buffer = Buffer.from(ts);
  const encrypted = crypto.publicEncrypt(
    {
      key: PEM_KEY,
      padding: crypto.constants.RSA_PKCS1_PADDING
    },
    buffer
  );
  return encrypted.toString('base64');
}

module.exports = {
  getXSign
};
