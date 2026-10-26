import { EventEmitter } from "node:events";

/** In-process fan-out when call rows change (admin SSE + future hooks). */
class CallBus extends EventEmitter {
  changed() {
    this.emit("changed");
  }
}

export const callBus = new CallBus();
