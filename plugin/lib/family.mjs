import { readState } from "./state.mjs";
import { endpoint } from "./pair-link.mjs";
const idOK = (v) => typeof v === "string" && /^[\w.-]{1,96}$/.test(v);
const pinOK = (v) => typeof v === "string" && /^[\w-]{43}$/.test(v);
export function familyRoute(dir) {
  const r = readState(dir, "family-route.json");
  if (!r) return null;
  const p = r.peer;
  if (
    !idOK(r.familyId) ||
    !["local", "cloud"].includes(r.role) ||
    !p ||
    !idOK(p.id) ||
    p.role !== (r.role === "local" ? "cloud" : "local") ||
    !pinOK(p.fingerprint) ||
    !Array.isArray(p.hosts) ||
    !p.hosts.length ||
    p.hosts.length > 8 ||
    typeof p.name !== "string"
  )
    throw Error("Invalid Family route");
  return {
    familyId: r.familyId,
    role: r.role,
    peer: {
      id: p.id,
      name: p.name.slice(0, 96),
      displayName: String(p.displayName ?? p.name).slice(0, 96),
      role: p.role,
      fingerprint: p.fingerprint,
      hosts: p.hosts.map(endpoint),
    },
  };
}
// Trusted admin provisions token hashes out of band. Routing alone never grants access.
export function familyGrants(dir) {
  const data = readState(dir, "family-grants.json");
  if (!data) return [];
  const route = familyRoute(dir);
  if (
    !route ||
    data.familyId !== route.familyId ||
    !Array.isArray(data.devices)
  )
    return [];
  return data.devices.filter(
    (d) =>
      idOK(d?.id) &&
      pinOK(d.tokenHash) &&
      typeof d.name === "string" &&
      Number.isSafeInteger(d.expiresAt) &&
      d.expiresAt > Date.now(),
  );
}
