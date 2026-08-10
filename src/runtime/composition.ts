import type { P2PConfig } from '../config.js';
import {
  AgentCardRegistry,
  type AgentCardMetadataPatch,
  type AgentCardRegistryOptions,
} from '../discovery/agent-card-registry.js';
import type { RuntimeIdentity } from '../identity.js';
import { PiAdapter, type PiMessageDelivery } from '../pi/adapter.js';
import type { ResolvedRoom } from '../room.js';
import { MessageRouter, type RouterOptions } from '../router/router.js';
import { createIpcEndpoint } from '../transport/endpoint.js';
import { LocalIpcTransport } from '../transport/local-ipc.js';
import type { LocalIpcOptions } from '../transport/local-ipc.js';
import { LocalIpcBridge, ProtocolWireCodec } from './wire-bridge.js';

export interface PiToPiRuntimeCompositionOptions {
  readonly identity: RuntimeIdentity;
  readonly room: ResolvedRoom;
  readonly config: P2PConfig;
  readonly displayName?: string;
  readonly generation: number;
  readonly registryOptions?: Omit<
    AgentCardRegistryOptions,
    'identity' | 'room' | 'displayName' | 'endpoint' | 'capabilities'
  >;
  readonly transportOptions?: LocalIpcOptions;
  readonly createTransport?: (options?: LocalIpcOptions) => LocalIpcTransport;
  readonly createEndpoint?: (runtimeId: string) => string;
}

/** One fully-owned production runtime. It is constructed inert and started explicitly. */
export class PiToPiRuntimeComposition {
  public readonly identity: RuntimeIdentity;
  public readonly room: ResolvedRoom;
  public readonly config: P2PConfig;
  public readonly generation: number;
  public readonly endpoint: string;
  public readonly transport: LocalIpcTransport;
  public readonly registry: AgentCardRegistry;
  public readonly codec: ProtocolWireCodec;
  public readonly bridge: LocalIpcBridge;
  public readonly router: MessageRouter;
  public readonly adapter: PiAdapter;
  private started = false;
  private shutdownPromise: Promise<void> | undefined;

  public constructor(options: PiToPiRuntimeCompositionOptions) {
    this.identity = options.identity;
    this.room = options.room;
    this.config = options.config;
    this.generation = options.generation;
    this.endpoint = (options.createEndpoint ?? ((runtimeId) => createIpcEndpoint({ runtimeId })))(
      this.identity.runtimeId,
    );
    this.transport = (
      options.createTransport ?? ((transportOptions) => new LocalIpcTransport(transportOptions))
    )(options.transportOptions);
    const maxPayloadBytes = options.transportOptions?.maxPayloadBytes ?? 1024 * 1024;
    this.codec = new ProtocolWireCodec(maxPayloadBytes);
    this.registry = new AgentCardRegistry({
      ...options.registryOptions,
      identity: this.identity,
      room: this.room,
      displayName: options.displayName ?? this.config.name,
      endpoint: {
        kind: process.platform === 'win32' ? 'named-pipe' : 'unix',
        address: this.endpoint,
        runtimeInstanceId: this.identity.runtimeId,
      },
      capabilities: {
        structuredReplies: true,
        cancellation: true,
        statusUpdates: true,
        maxMessageSize: maxPayloadBytes,
        supportedContentTypes: ['text/plain', 'application/json'],
      },
    });
    const routerRef: { current: MessageRouter | undefined } = { current: undefined };
    this.bridge = new LocalIpcBridge({
      transport: this.transport,
      peers: this.registry,
      codec: this.codec,
      router: () => routerRef.current,
    });
    this.router = new MessageRouter({
      identity: this.identity,
      roomId: this.room.roomId,
      delivery: this.bridge,
      limits: { maxEnvelopeBytes: maxPayloadBytes },
      taskExecutor: (context) => this.adapter.taskExecutor(context),
      onTaskStateChange: () => {
        const current = routerRef.current;
        const active = current !== undefined && current.taskStore.size > 0;
        void this.registry
          .updateMetadata({
            state: active ? 'busy' : 'idle',
            inboundQueueDepth: current?.taskStore.size ?? 0,
          })
          .catch(() => undefined);
      },
    } as RouterOptions);
    routerRef.current = this.router;
    this.adapter = new PiAdapter({ router: this.router, peers: this.registry });
  }

  /** Bind first, then publish the discoverable card. */
  public async start(): Promise<void> {
    if (this.started) return;
    await this.transport.bind(this.endpoint, (payload) => this.bridge.handle(payload));
    try {
      await this.router.start();
      await this.registry.start();
      this.started = true;
    } catch (error) {
      await this.shutdown();
      throw error;
    }
  }

  public bind(delivery: PiMessageDelivery): void {
    this.adapter.bind(delivery);
  }

  public async updateDisplayName(displayName: string): Promise<void> {
    await this.registry.updateMetadata({ displayName });
  }

  public async updatePresence(patch: AgentCardMetadataPatch): Promise<void> {
    await this.registry.updateMetadata(patch);
  }
  public shutdown(): Promise<void> {
    if (this.shutdownPromise === undefined) {
      this.shutdownPromise = (async () => {
        this.adapter.clear();
        await this.router.close();
        await this.registry.shutdown();
        await this.transport.close();
        this.started = false;
      })();
    }
    return this.shutdownPromise;
  }
}
