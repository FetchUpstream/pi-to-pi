import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Register the Pi-to-Pi extension.
 *
 * The bootstrap deliberately does not allocate sockets, timers, watchers, or
 * processes while the extension factory is being evaluated. Session-scoped
 * resources belong in the lifecycle handlers reserved below.
 */
export default function registerPiToPi(pi: ExtensionAPI): void {
  pi.on('session_start', () => {
    // Future session-scoped resources will be created here.
  });

  pi.on('session_shutdown', () => {
    // Future session-scoped resources will be closed here.
  });
}
