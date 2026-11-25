import https from "node:https";
import tls from "node:tls";
import { isIP } from "node:net";
import { X509Certificate } from "node:crypto";
import { digest } from "./state.mjs";
// Complete pin verification before the HTTP stack receives a socket (including
// for an otherwise untrusted self-signed leaf). No credentials go to probes.
export function pinnedAgent(pin) {
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (opts, done) => {
    const socket = tls.connect({
      ...opts,
      servername: isIP(opts.host) ? undefined : opts.host,
      rejectUnauthorized: false,
    });
    const fail = (e) => {
      socket.destroy();
      done(e);
    };
    socket.once("error", fail);
    const timeout = setTimeout(
      () => socket.destroy(Error("TLS handshake timeout")),
      2500,
    );
    socket.once("close", () => clearTimeout(timeout));
    socket.once("secureConnect", () => {
      clearTimeout(timeout);
      socket.removeListener("error", fail);
      try {
        const cert = new X509Certificate(socket.getPeerCertificate().raw);
        if (
          digest(cert.publicKey.export({ type: "spki", format: "der" })) !==
            pin ||
          Date.parse(cert.validFrom) > Date.now() ||
          Date.parse(cert.validTo) <= Date.now()
        )
          throw Error("TLS pin or validity mismatch");
      } catch (e) {
        fail(e);
        return;
      }
      done(null, socket);
    });
  };
  return agent;
}
export async function probePeer(peer) {
  const statuses = await Promise.all(
    peer.hosts.map(
      (host) =>
        new Promise((resolve) => {
          const agent = pinnedAgent(peer.fingerprint);
          const request = https.get(
            `https://${host}/mobile/v1/hello`,
            { agent, signal: AbortSignal.timeout(3000) },
            async (r) => {
              try {
                let data = "";
                for await (const buf of r) {
                  data += buf;
                  if (data.length > 8192) throw Error();
                }
                const h = JSON.parse(data);
                resolve(
                  r.statusCode === 200 &&
                    h.protocol === 1 &&
                    h.backend === "t3code" &&
                    h.host?.id === peer.id &&
                    h.host?.role === peer.role &&
                    h.fingerprint === peer.fingerprint,
                );
              } catch {
                resolve(false);
              } finally {
                agent.destroy();
              }
            },
          );
          request.on("error", () => {
            agent.destroy();
            resolve(false);
          });
        }),
    ),
  );
  return statuses.some(Boolean);
}
