/**
 * Vendored from the knowledge-crawler engine's retrieval layer (identical
 * semantics; golden tests kept in sync). PR0 promotes this kernel to
 * a shared politeness package and remove the duplication.
 */

/**
 * SSRF address policy (architecture §4.5).
 *
 * Only unicast (public) addresses may be fetched. Loopback is additionally
 * allowed ONLY in explicit fixture/dev mode (`allowLoopback`), which is how
 * the local prototype runs against fixture-web on localhost — private,
 * link-local, and reserved ranges stay blocked even then.
 *
 * Mirrors the event-scraper hardened-fetcher policy; the gateway pins the
 * connection to pre-checked addresses (no DNS-rebinding window).
 */

import ipaddr from "ipaddr.js";

export interface AddressPolicyOptions {
  /** Allow 127.0.0.0/8 and ::1 — fixture-web / local prototype only. */
  allowLoopback?: boolean;
}

export function isAllowedAddress(
  address: string,
  options: AddressPolicyOptions = {},
): boolean {
  let parsed;

  try {
    parsed = ipaddr.parse(address);
  } catch {
    return false;
  }

  const range = parsed.range();

  if (range === "unicast") return true;

  return options.allowLoopback === true && range === "loopback";
}

/** True when every resolved address passes the policy. */
export function allAddressesAllowed(
  addresses: readonly string[],
  options: AddressPolicyOptions = {},
): boolean {
  return (
    addresses.length > 0 && addresses.every((a) => isAllowedAddress(a, options))
  );
}
