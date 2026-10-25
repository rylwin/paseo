import { timingSafeEqual } from "node:crypto";

export function authenticate(candidate, token) {
  return (
    typeof candidate === "string" &&
    /^[a-f0-9]{64}$/.test(candidate) &&
    candidate.length === token.length &&
    timingSafeEqual(Buffer.from(candidate), Buffer.from(token))
  );
}

export function authenticateStart(message, token) {
  return message?.type === "start" && authenticate(message.token, token);
}

export function validateTool(name, args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return false;
  if (name === "paseo_pi_status") return Object.keys(args).length === 0;
  return (
    name === "paseo_pi_request" &&
    Object.keys(args).length === 1 &&
    typeof args.instruction === "string" &&
    args.instruction.trim().length > 0 &&
    args.instruction.length <= 8000 &&
    !args.instruction.includes("\u0000")
  );
}

export function admitUpgrade(headers, origins) {
  return origins.some(
    (origin) => headers.origin === origin && headers.host === new URL(origin).host,
  );
}
