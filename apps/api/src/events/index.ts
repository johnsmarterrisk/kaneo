import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { deferIfInCardTransaction } from "../operon-card-claims/after-commit";

const EVENTS = new EventEmitter();
EVENTS.setMaxListeners(100);
export const eventContext = new AsyncLocalStorage<{ initiatorId: string }>();

export type EventPayload<T = unknown> = {
  type: string;
  data: T;
  timestamp: string;
};

export async function shutdownEventBus(): Promise<void> {
  EVENTS.removeAllListeners();
}

export async function publishEvent(
  eventType: string,
  data: unknown,
): Promise<void> {
  let enhancedData = null;
  if (typeof data === "object" && data !== null) {
    const store = eventContext.getStore();
    enhancedData = { ...data, initiatorId: store?.initiatorId };
  }

  const payload: EventPayload = {
    type: eventType,
    data: enhancedData || data,
    timestamp: new Date().toISOString(),
  };

  // Operon fork (docs/fork-discipline.md row 19): inside an agent's guarded card transaction the
  // event waits for the commit, so a rolled-back change announces nothing.
  if (deferIfInCardTransaction(() => EVENTS.emit(eventType, payload))) return;

  try {
    EVENTS.emit(eventType, payload);
  } catch (error) {
    console.error("Failed to publish event:", error);
    throw error;
  }
}

export async function subscribeToEvent<T>(
  eventType: string,
  handler: (data: T) => Promise<void>,
): Promise<void> {
  try {
    EVENTS.on(eventType, async (payload: EventPayload<T>) => {
      try {
        await handler(payload.data);
      } catch (error) {
        console.error(`Error processing event ${eventType}:`, error);
      }
    });
  } catch (error) {
    console.error("Failed to subscribe to event:", error);
    throw error;
  }
}

process.on("SIGTERM", () => {
  shutdownEventBus().catch(console.error);
});
