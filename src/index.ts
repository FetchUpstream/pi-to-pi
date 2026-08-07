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

export {
  MessageRouter,
  Router,
  createRouter,
  type RouterOptions,
  type RouterRequestInput,
} from './router/router.js';
export { RuntimePersistence, createRuntimePersistence } from './pi/persistence.js';
export { PiLifecycleBridge, createPiLifecycle, createPiRuntime } from './pi/lifecycle.js';
export { PiTools, createPiTools, registerPiTools } from './pi/tools.js';
export * from './protocol/messages.js';
export * from './protocol/errors.js';
export * from './protocol/task-state.js';
export * from './protocol/validation.js';
