import { EventEmitter } from "node:events"

/** Single process-wide event bus. SSE subscribers attach to this. */
export const bus = new EventEmitter()
bus.setMaxListeners(50)

export function emit(type, payload = {}) {
  bus.emit("event", { type, at: Date.now(), ...payload })
}
