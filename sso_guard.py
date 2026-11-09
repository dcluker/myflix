"""Cloudflare Access (Zero Trust) SSO verification — pure stdlib, no PyJWT.

Cloudflare authenticates the user at the edge (e.g. Google SSO) and forwards a
SIGNED RS256 JWT in the `Cf-Access-Jwt-Assertion` header (also mirrored in a
`CF_Authorization` cookie). We VERIFY that JWT cryptographically before trusting
it — this app binds 0.0.0.0 and is reachable directly on the LAN, bypassing
Cloudflare, so an *unvalidated* `Cf-Access-*` header could be forged by anyone on
the network. A cryptographically-verified JWT cannot be (they'd need
Cloudflare's private key), and the `aud` check binds it to THIS specific app.

Verifies: RS256 signature against the team JWKS, audience == this app's AUD tag,
issuer == the team domain, and not expired. Fail-CLOSED: any problem => None.

Ported from the homelab TransferDeck verifier (same proven code path).

Usage (Flask):
    import sso_guard
    if sso_guard.access_ok(request.headers, request.cookies, TEAM_DOMAIN, ACCESS_AUD):
        ...  # authenticated via Cloudflare Access SSO — no ?k= token needed
"""
import base64
import hashlib
import json
import time
import urllib.request

ACCESS_HEADER = "Cf-Access-Jwt-Assertion"
ACCESS_COOKIE = "CF_Authorization"
_SHA256_ASN1 = bytes.fromhex("3031300d060960864801650304020105000420")
_JWKS = {}  # team_domain -> {"exp": float, "keys": {kid: jwk}}


def _b64u(s):
    if isinstance(s, str):
        s = s.encode()
    return base64.urlsafe_b64decode(s + b"=" * (-len(s) % 4))


def _jwks(team_domain, force=False):
    cache = _JWKS.setdefault(team_domain, {"exp": 0.0, "keys": {}})
    if force or time.time() > cache["exp"]:
        try:
            url = "https://%s/cdn-cgi/access/certs" % team_domain
            with urllib.request.urlopen(url, timeout=8) as r:
                data = json.load(r)
            cache["keys"] = {k["kid"]: k for k in data.get("keys", [])}
            cache["exp"] = time.time() + 3600
        except Exception:
            pass
    return cache["keys"]


def _rsa_verify(n, e, msg, sig):
    k = (n.bit_length() + 7) // 8
    if len(sig) != k:
        return False
    em = pow(int.from_bytes(sig, "big"), e, n).to_bytes(k, "big")
    t = _SHA256_ASN1 + hashlib.sha256(msg).digest()
    expected = b"\x00\x01" + b"\xff" * (k - len(t) - 3) + b"\x00" + t
    return em == expected


def _token_from(headers, cookies):
    tok = headers.get(ACCESS_HEADER) if headers else None
    if not tok and cookies:
        tok = cookies.get(ACCESS_COOKIE)
    return (tok or "").strip()


def verified_email(headers, cookies, team_domain, aud):
    """Verified email (lowercased) from a valid CF Access JWT for THIS app, else
    None. Fail-closed: any verification problem returns None."""
    token = _token_from(headers, cookies)
    if not token or not team_domain or not aud:
        return None
    try:
        h_b64, p_b64, s_b64 = token.split(".")
        header = json.loads(_b64u(h_b64))
        if header.get("alg") != "RS256":
            return None
        kid = header.get("kid")
        jwk = _jwks(team_domain).get(kid) or _jwks(team_domain, force=True).get(kid)
        if not jwk:
            return None
        n = int.from_bytes(_b64u(jwk["n"]), "big")
        e = int.from_bytes(_b64u(jwk["e"]), "big")
        if not _rsa_verify(n, e, (h_b64 + "." + p_b64).encode(), _b64u(s_b64)):
            return None
        payload = json.loads(_b64u(p_b64))
        if float(payload.get("exp", 0)) < time.time():
            return None
        auds = payload.get("aud")
        auds = auds if isinstance(auds, list) else [auds]
        if aud not in auds or payload.get("iss") != "https://%s" % team_domain:
            return None
    except Exception:
        return None
    email = (payload.get("email") or payload.get("identity") or "").strip().lower()
    return email or None


def verified_claims(headers, cookies, team_domain, aud):
    """Verified JWT payload (dict) from a valid CF Access JWT for THIS app, else None.
    Same fail-closed checks as verified_email (RS256 signature, aud, iss, exp), but
    returns every claim so callers can also recognise service-token (non-email)
    identities via `common_name`."""
    token = _token_from(headers, cookies)
    if not token or not team_domain or not aud:
        return None
    try:
        h_b64, p_b64, s_b64 = token.split(".")
        header = json.loads(_b64u(h_b64))
        if header.get("alg") != "RS256":
            return None
        kid = header.get("kid")
        jwk = _jwks(team_domain).get(kid) or _jwks(team_domain, force=True).get(kid)
        if not jwk:
            return None
        n = int.from_bytes(_b64u(jwk["n"]), "big")
        e = int.from_bytes(_b64u(jwk["e"]), "big")
        if not _rsa_verify(n, e, (h_b64 + "." + p_b64).encode(), _b64u(s_b64)):
            return None
        payload = json.loads(_b64u(p_b64))
        if not isinstance(payload, dict):
            return None
        if float(payload.get("exp", 0)) < time.time():
            return None
        auds = payload.get("aud")
        auds = auds if isinstance(auds, list) else [auds]
        if aud not in auds or payload.get("iss") != "https://%s" % team_domain:
            return None
    except Exception:
        return None
    return payload


def access_ok(headers, cookies, team_domain, aud):
    """True if the request carries a valid Cloudflare Access JWT for this app."""
    return verified_email(headers, cookies, team_domain, aud) is not None
