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

export function readMarker(transcript, marker) {
  return transcript.split(/\r?\n/).some((line) => line === marker);
}

export function validateTool(name, args) {
  return (
    name === "paseo_pi_marker" &&
    args !== null &&
    typeof args === "object" &&
    !Array.isArray(args) &&
    Object.keys(args).length === 0
  );
}

export function admitUpgrade(headers, origins) {
  return origins.some(
    (origin) => headers.origin === origin && headers.host === new URL(origin).host,
  );
}
