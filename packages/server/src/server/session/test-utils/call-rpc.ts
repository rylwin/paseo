import type { CallRpc } from "../conversation-call-provider.js";

export class MemoryCallRpc implements CallRpc {
  requests: Array<{ method: string; params: unknown }> = [];
  notifyHandler: (method: string, params: unknown) => void = () => {};
  tool: (params: unknown, id: number) => unknown = () => {};
  disposed = 0;
  sendSdp = true;
  failMethod: string | null = null;
  setNotificationHandler(handler: typeof this.notifyHandler) {
    this.notifyHandler = handler;
  }
  setUnexpectedTerminationHandler(_handler: (error: Error) => void) {}
  setRequestHandler(_method: string, handler: typeof this.tool) {
    this.tool = handler;
  }
  notify() {}
  async dispose() {
    this.disposed++;
  }
  async request(method: string, params?: unknown) {
    this.requests.push({ method, params });
    if (method === this.failMethod) throw new Error("Private provider diagnostic");
    if (method === "model/list") return { data: [{ model: "control-default", isDefault: true }] };
    if (method === "thread/start") return { thread: { id: "voice-thread" } };
    if (method === "thread/realtime/start" && this.sendSdp)
      this.notifyHandler("thread/realtime/sdp", { threadId: "voice-thread", sdp: "answer" });
    return {};
  }
}
