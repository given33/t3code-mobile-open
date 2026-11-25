import { LinkServer } from "./lib/link-server.mjs";
import { panel } from "./lib/panel.mjs";
export async function apply(ctx, config) {
  const service = new LinkServer(ctx, config);
  if (service.cfg.enabled) await service.start();
  const unregister = ctx.registerHttpHandler(panel(service));
  service.relay.start();
  let done;
  const dispose = () =>
    (done ??= (async () => {
      unregister();
      await service.queue;
      await service.stop();
      await service.relay.shutdown();
    })());
  ctx.onShutdown(dispose);
  return dispose;
}
