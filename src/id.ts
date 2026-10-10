/*
 * The extension's identity, fixed once and for all.
 *
 * Chrome derives an unpacked extension's id from its public key: the SHA-256 of
 * the DER-encoded public key, first sixteen bytes, each hex digit mapped from
 * `0`-`f` onto `a`-`p`. `static/manifest.json` carries the public half of a
 * key pair generated once with `openssl`; the private half was discarded and
 * is not needed to load the folder unpacked.
 */
export const EXTENSION_ID = 'ablgicbcijbiepickbchjfengdobmabg';
